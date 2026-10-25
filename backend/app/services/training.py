"""Training options: template hyperparameters, user env vars, resume checkpoints, sweeps."""

from __future__ import annotations

import itertools
import json
import re
import shutil
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.config import settings
from app.services.artifacts import read_local_artifact
from app.services.inference import validate_infer_input
from app.services.job_builder import MODEL_MOUNT_PATH

ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
RESERVED_ENV_PREFIX = "CILITRAIN_"
RESERVED_ENV = frozenset({"PYTHONUNBUFFERED", "PATH", "HOME"})
ENV_MAX_ENTRIES = 32
ENV_VALUE_MAX = 4096
SWEEP_MAX_RUNS = 12
SWEEP_MAX_VALUES = 8
RESUMABLE_STATUSES = frozenset({"succeeded", "failed", "timeout", "cancelled"})

_TEMPLATES = Path(__file__).resolve().parents[1] / "templates" / "builtin.json"


@lru_cache(maxsize=1)
def _rows() -> dict[str, dict[str, Any]]:
    return {r["id"]: r for r in json.loads(_TEMPLATES.read_text(encoding="utf-8"))}


def param_spec(template: str) -> list[dict[str, Any]]:
    return list((_rows().get(template) or {}).get("params") or [])


def resume_files_for(template: str) -> list[str]:
    return list((_rows().get(template) or {}).get("resume_files") or [])


def validate_params(template: str, raw: dict[str, Any] | None) -> dict[str, Any]:
    """Fill defaults and range-check. Templates without a param spec take no params."""
    spec = param_spec(template)
    if not spec:
        if raw:
            raise HTTPException(status_code=400, detail=f"template {template} takes no parameters")
        return {}
    return validate_infer_input({"fields": spec}, raw)


def param_env(params: dict[str, Any]) -> dict[str, str]:
    if not params:
        return {}
    env = {f"{RESERVED_ENV_PREFIX}{k.upper()}": str(v) for k, v in params.items()}
    env[f"{RESERVED_ENV_PREFIX}PARAMS"] = json.dumps(params, sort_keys=True)
    return env


def validate_env(raw: dict[str, Any] | None) -> dict[str, str]:
    env = dict(raw or {})
    if len(env) > ENV_MAX_ENTRIES:
        raise HTTPException(status_code=400, detail=f"at most {ENV_MAX_ENTRIES} environment variables")
    out: dict[str, str] = {}
    for key, value in env.items():
        if not ENV_KEY_RE.match(str(key)):
            raise HTTPException(status_code=400, detail=f"env {key}: invalid name")
        if key.upper().startswith(RESERVED_ENV_PREFIX) or key.upper() in RESERVED_ENV:
            raise HTTPException(status_code=400, detail=f"env {key}: reserved by the platform")
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            raise HTTPException(status_code=400, detail=f"env {key}: value must be text")
        text = str(value)
        if len(text) > ENV_VALUE_MAX:
            raise HTTPException(status_code=400, detail=f"env {key}: longer than {ENV_VALUE_MAX} characters")
        out[str(key)] = text
    return out


MOUNT_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,200}$")
_RESERVED_MOUNTS = ("/workspace", MODEL_MOUNT_PATH, "/proc", "/sys", "/dev", "/etc", "/bin", "/usr")


def validate_mount_path(path: str) -> str:
    path = (path or "").rstrip("/") or "/"
    if not MOUNT_PATH_RE.match(path) or ".." in path.split("/"):
        raise HTTPException(status_code=400, detail="dataset mount path must be an absolute path")
    for reserved in _RESERVED_MOUNTS:
        if path == reserved or path.startswith(reserved + "/"):
            raise HTTPException(status_code=400, detail=f"dataset mount path {path} is reserved")
    return path


def expand_sweep(template: str, base: dict[str, Any] | None, grid: dict[str, list[Any]]) -> list[dict[str, Any]]:
    """Cartesian product of the grid over the base params; every combination is validated."""
    spec = param_spec(template)
    if not spec:
        raise HTTPException(status_code=400, detail=f"template {template} has no parameters to sweep")
    known = {f["key"] for f in spec}
    if not grid:
        raise HTTPException(status_code=400, detail="sweep grid is empty")
    unknown = sorted(set(grid) - known)
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown sweep parameter: {', '.join(unknown)}")
    keys = sorted(grid)
    for key in keys:
        values = grid[key]
        if not isinstance(values, list) or not values:
            raise HTTPException(status_code=400, detail=f"{key}: give at least one value")
        if len(values) > SWEEP_MAX_VALUES:
            raise HTTPException(status_code=400, detail=f"{key}: at most {SWEEP_MAX_VALUES} values")
    total = 1
    for key in keys:
        total *= len(grid[key])
    if total > SWEEP_MAX_RUNS:
        raise HTTPException(status_code=400, detail=f"sweep expands to {total} runs; limit is {SWEEP_MAX_RUNS}")
    base = dict(base or {})
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for combo in itertools.product(*(grid[k] for k in keys)):
        params = validate_params(template, {**base, **dict(zip(keys, combo))})
        sig = json.dumps(params, sort_keys=True)
        if sig in seen:
            continue
        seen.add(sig)
        out.append(params)
    return out


def sweep_label(params: dict[str, Any], keys: list[str]) -> str:
    def fmt(v: Any) -> str:
        return f"{v:g}" if isinstance(v, float) else str(v)

    return "-".join(f"{k}{fmt(params[k])}" for k in keys if k in params)


def resume_dir(run_id: str) -> Path:
    return settings.data_dir / "resume" / run_id


def resume_env(src_run_id: str) -> dict[str, str]:
    return {
        f"{RESERVED_ENV_PREFIX}RESUME_DIR": MODEL_MOUNT_PATH,
        f"{RESERVED_ENV_PREFIX}RESUME_FROM": src_run_id,
    }


def check_resumable(src: Any) -> list[tuple[str, Path]]:
    """Return the checkpoint files of a finished training run, or raise why it cannot resume."""
    if (getattr(src, "kind", None) or "train") != "train":
        raise HTTPException(status_code=400, detail="only training runs can be resumed")
    names = resume_files_for(src.template)
    if not names:
        raise HTTPException(status_code=400, detail=f"template {src.template} does not support resume")
    if src.status not in RESUMABLE_STATUSES:
        raise HTTPException(status_code=409, detail="source run is still active")
    found: list[tuple[str, Path]] = []
    for rel in names:
        try:
            found.append((rel, read_local_artifact(src.id, rel)))
        except FileNotFoundError:
            raise HTTPException(status_code=409, detail=f"source run has no {rel} to resume from") from None
    total = sum(p.stat().st_size for _, p in found)
    if total > settings.max_model_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"checkpoint exceeds {settings.max_model_mb} MB")
    return found


def stage_resume(run_id: str, files: list[tuple[str, Path]]) -> Path:
    """Snapshot checkpoint files so deleting the source run does not break delivery."""
    dest = resume_dir(run_id)
    dest.mkdir(parents=True, exist_ok=True)
    for rel, src in files:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
    return dest


def loads_json(raw: str | None, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback
