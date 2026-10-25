"""Model registry: versioned copies of a succeeded run's model files."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, func, select

from app.config import settings
from app.models.entities import ModelVersion, Run, User
from app.services.access import can_access_run, is_admin
from app.services.artifacts import read_local_artifact
from app.services.inference import infer_spec
from app.services.metrics import load_metrics_json
from app.services.training import loads_json

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


def model_dir(model_id: str) -> Path:
    return settings.data_dir / "models" / model_id


def model_label(m: ModelVersion) -> str:
    return f"{m.name}:{m.version}"


def _scalar_metrics(raw: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in (raw or {}).items():
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float, str)) and len(out) < 8:
            out[k] = v
    return out


def run_model_files(run: Run) -> list[tuple[str, Path]]:
    spec = infer_spec(run.template)
    if not spec:
        raise HTTPException(status_code=400, detail=f"template {run.template} has no inference support")
    found: list[tuple[str, Path]] = []
    for rel in spec.get("model_files") or []:
        try:
            found.append((rel, read_local_artifact(run.id, rel)))
        except FileNotFoundError:
            raise HTTPException(
                status_code=409,
                detail=f"run produced no {rel}; only runs that save a model can be registered",
            ) from None
    return found


def register_model(session: Session, run: Run, name: str, owner_user_id: str | None) -> ModelVersion:
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail="name: 2-41 chars, lowercase letters, digits and dashes, starting with a letter or digit",
        )
    if getattr(run, "kind", "train") != "train":
        raise HTTPException(status_code=400, detail="only training runs can be registered")
    if run.status != "succeeded":
        raise HTTPException(status_code=409, detail="run has not succeeded")
    files = run_model_files(run)
    total = sum(p.stat().st_size for _, p in files)
    if total > settings.max_model_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"model exceeds {settings.max_model_mb} MB")

    last = session.exec(select(func.max(ModelVersion.version)).where(ModelVersion.name == name)).one()
    m = ModelVersion(
        name=name,
        version=int(last or 0) + 1,
        source_run_id=run.id,
        template=run.template,
        owner_user_id=owner_user_id,
        files_json=json.dumps([{"path": rel, "size": p.stat().st_size} for rel, p in files]),
        size_bytes=total,
        metrics_json=json.dumps(_scalar_metrics(load_metrics_json(run.id))),
    )
    dest = model_dir(m.id)
    dest.mkdir(parents=True, exist_ok=True)
    try:
        for rel, src in files:
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, target)
        session.add(m)
        session.commit()
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    session.refresh(m)
    return m


def can_access_model(session: Session, user: User, m: ModelVersion) -> bool:
    if is_admin(user) or m.showcase_seed or m.owner_user_id == user.id:
        return True
    src = session.get(Run, m.source_run_id) if m.source_run_id else None
    return bool(src and can_access_run(session, user, src))


def model_out(session: Session, m: ModelVersion) -> dict[str, Any]:
    src = session.get(Run, m.source_run_id) if m.source_run_id else None
    infer_count = session.exec(
        select(func.count()).select_from(Run).where(Run.model_id == m.id)
    ).one()
    return {
        "id": m.id,
        "name": m.name,
        "version": m.version,
        "label": model_label(m),
        "template": m.template,
        "source_run_id": m.source_run_id,
        "source_run_name": src.name if src else None,
        "source_params": loads_json(src.params, {}) if src else {},
        "owner_user_id": m.owner_user_id,
        "files": json.loads(m.files_json or "[]"),
        "size_bytes": m.size_bytes,
        "metrics": json.loads(m.metrics_json or "{}"),
        "infer": infer_spec(m.template),
        "infer_count": int(infer_count or 0),
        "showcase_seed": m.showcase_seed,
        "created_at": m.created_at,
    }
