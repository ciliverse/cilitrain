"""Batch inference: per-template input spec, model delivery into the pod, prediction readback."""

from __future__ import annotations

import base64
import csv
import io
import json
import shlex
import threading
import time
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.config import settings
from app.services.artifacts import list_local_artifacts, read_local_artifact
from app.services.job_builder import MODEL_MOUNT_PATH

READY_MARKER = ".cilitrain-model-ready"
WAIT_SECONDS = 300
WAIT_EXIT_CODE = 70
CHUNK_BYTES = 256 * 1024
INPUT_MAX_BYTES = 32 * 1024
TEXT_MAX_LEN = 2000
PREDICTION_FILE = "prediction.json"
BATCH_INPUT_FILE = "inputs.jsonl"
BATCH_OUTPUT_FILE = "predictions.csv"
BATCH_MAX_BYTES = 256 * 1024
BATCH_MAX_EXTRA_COLUMNS = 8
BATCH_DEFAULT_MAX_ROWS = 100

_TEMPLATES = Path(__file__).resolve().parents[1] / "templates" / "builtin.json"


@lru_cache(maxsize=1)
def _infer_specs() -> dict[str, dict[str, Any]]:
    rows = json.loads(_TEMPLATES.read_text(encoding="utf-8"))
    return {r["id"]: r["infer"] for r in rows if isinstance(r.get("infer"), dict)}


def infer_spec(template: str) -> dict[str, Any] | None:
    return _infer_specs().get(template)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _coerce(field: dict[str, Any], value: Any) -> Any:
    key, kind = field["key"], field.get("type", "text")
    if kind == "text":
        if not isinstance(value, str):
            raise _bad(f"{key}: expected text")
        if len(value) > int(field.get("max_len", TEXT_MAX_LEN)):
            raise _bad(f"{key}: longer than {field.get('max_len', TEXT_MAX_LEN)} characters")
        return value
    if isinstance(value, bool):
        raise _bad(f"{key}: expected a number")
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise _bad(f"{key}: expected a number") from None
    if kind == "int":
        if not num.is_integer():
            raise _bad(f"{key}: expected an integer")
        num = int(num)
    lo, hi = field.get("min"), field.get("max")
    if lo is not None and num < lo:
        raise _bad(f"{key}: must be >= {lo}")
    if hi is not None and num > hi:
        raise _bad(f"{key}: must be <= {hi}")
    return num


def validate_infer_input(spec: dict[str, Any], raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(raw or {})
    fields = spec.get("fields") or []
    known = {f["key"] for f in fields}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise _bad(f"unknown input field: {', '.join(unknown)}")
    out: dict[str, Any] = {}
    for field in fields:
        key = field["key"]
        if key in raw and raw[key] is not None and raw[key] != "":
            out[key] = _coerce(field, raw[key])
        elif "default" in field:
            out[key] = field["default"]
        else:
            raise _bad(f"{key}: required")
    if len(json.dumps(out).encode("utf-8")) > INPUT_MAX_BYTES:
        raise _bad("input exceeds 32KiB")
    return out


def parse_batch_csv(spec: dict[str, Any], text: str) -> list[dict[str, Any]]:
    """Validate a CSV against the template's input fields.

    Returns rows of {"input": typed model input, "extra": other columns echoed into the results}.
    Columns the model does not read (an id, a label to check against) are kept, not rejected.
    """
    if len(text.encode("utf-8")) > BATCH_MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"csv exceeds {BATCH_MAX_BYTES // 1024}KiB")
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    header = [(h or "").strip() for h in reader.fieldnames or []]
    if not any(header):
        raise _bad("csv: missing header row")
    if len(set(header)) != len(header) or "" in header:
        raise _bad("csv: header has empty or duplicate column names")
    reader.fieldnames = header
    fields = spec.get("fields") or []
    known = [f["key"] for f in fields]
    missing = [f["key"] for f in fields if "default" not in f and f["key"] not in header]
    if not set(known) & set(header) or missing:
        raise _bad(f"csv: header needs columns {', '.join(missing or known)}")
    extras = [h for h in header if h not in known]
    if len(extras) > BATCH_MAX_EXTRA_COLUMNS:
        raise _bad(f"csv: at most {BATCH_MAX_EXTRA_COLUMNS} columns besides the model inputs")
    max_rows = int(spec.get("batch_max_rows", BATCH_DEFAULT_MAX_ROWS))
    rows: list[dict[str, Any]] = []
    for raw in reader:
        line = reader.line_num
        if None in raw:
            raise _bad(f"row {line}: more cells than header columns")
        if not any((v or "").strip() for v in raw.values()):
            continue
        if len(rows) >= max_rows:
            raise _bad(f"csv: more than {max_rows} rows")
        try:
            inp = validate_infer_input(spec, {k: raw[k] for k in known if k in raw})
        except HTTPException as exc:
            raise _bad(f"row {line}: {exc.detail}") from None
        rows.append({"input": inp, "extra": {k: (raw.get(k) or "")[:200] for k in extras}})
    if not rows:
        raise _bad("csv: no data rows")
    return rows


def batch_jsonl(rows: list[dict[str, Any]]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def _batch_path(run_id: str) -> Path:
    path = settings.data_dir / "inference"
    path.mkdir(parents=True, exist_ok=True)
    return path / f"{run_id}.inputs.jsonl"


def save_batch_inputs(run_id: str, rows: list[dict[str, Any]]) -> None:
    _batch_path(run_id).write_text(batch_jsonl(rows), encoding="utf-8")


def load_batch_inputs(run_id: str) -> list[dict[str, Any]]:
    path = _batch_path(run_id)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def wait_for_model(command: list[str], args: list[str]) -> tuple[list[str], list[str]]:
    """Hold the user command until the API has finished copying the model into /model."""
    marker = f"{MODEL_MOUNT_PATH}/{READY_MARKER}"
    inner = shlex.join([str(x) for x in [*command, *args]] or ["true"])
    script = (
        f"i=0; while [ ! -f {marker} ]; do "
        f"i=$((i+1)); if [ $i -gt {WAIT_SECONDS} ]; then "
        f"echo '[cilitrain] model delivery timed out'; exit {WAIT_EXIT_CODE}; fi; "
        "sleep 1; done; "
        "echo '[cilitrain] model ready'; "
        f"exec {inner}"
    )
    return ["/bin/sh", "-c"], [script]


Sink = Callable[[str, bytes], None]


def deliver_files(sink: Sink, files: list[tuple[str, Path]]) -> None:
    """Stream files as base64 chunks. Each sink call runs `script` in the pod with `data` on stdin."""
    for rel, path in files:
        dest = shlex.quote(f"{MODEL_MOUNT_PATH}/{rel}")
        parent = shlex.quote(str(Path(f"{MODEL_MOUNT_PATH}/{rel}").parent))
        first = True
        with path.open("rb") as fh:
            while True:
                raw = fh.read(CHUNK_BYTES)
                if not raw and not first:
                    break
                data = base64.b64encode(raw)
                prefix = f"mkdir -p {parent} && : > {dest} && " if first else ""
                sink(f"{prefix}head -c {len(data)} | base64 -d >> {dest}", data)
                first = False
                if len(raw) < CHUNK_BYTES:
                    break
    sink(f"touch {shlex.quote(f'{MODEL_MOUNT_PATH}/{READY_MARKER}')}", b"")


def _kube_sink(kube: Any, namespace: str, pod_name: str) -> Sink:
    from kubernetes.stream import stream

    def sink(script: str, data: bytes) -> None:
        resp = stream(
            kube.core.connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            container="trainer",
            command=["/bin/sh", "-c", script],
            stdin=bool(data),
            stdout=True,
            stderr=True,
            tty=False,
            _preload_content=False,
        )
        try:
            if data:
                resp.write_stdin(data.decode("ascii"))
            deadline = time.time() + 120
            err = ""
            while resp.is_open() and time.time() < deadline:
                resp.update(timeout=1)
                err += resp.read_stderr() or ""
            if err.strip():
                raise RuntimeError(err.strip()[:300])
        finally:
            resp.close()

    return sink


def _state_path(run_id: str) -> Path:
    path = settings.data_dir / "inference"
    path.mkdir(parents=True, exist_ok=True)
    return path / f"{run_id}.json"


def delivery_state(run_id: str) -> dict[str, Any]:
    path = _state_path(run_id)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _set_state(run_id: str, **fields: Any) -> None:
    _state_path(run_id).write_text(
        json.dumps({**delivery_state(run_id), **fields, "updated_at": time.time()}),
        encoding="utf-8",
    )


_inflight: set[str] = set()
_inflight_lock = threading.Lock()


def ensure_delivered(run: Any, kube: Any, snap: dict[str, Any], model_dir: Path) -> str | None:
    """Copy files from `model_dir` into the pod's /model once. Returns an error message on failure."""
    state = delivery_state(run.id)
    if state.get("delivered") or state.get("error"):
        return None
    if (snap.get("pod_phase") or "").lower() != "running" or not snap.get("pod_name"):
        return None
    with _inflight_lock:
        if run.id in _inflight:
            return None
        _inflight.add(run.id)
    try:
        files = sorted(
            (p.relative_to(model_dir).as_posix(), p) for p in model_dir.rglob("*") if p.is_file()
        )
        if not files:
            raise RuntimeError("model files missing on the platform")
        deliver_files(_kube_sink(kube, run.namespace, snap["pod_name"]), files)
        _set_state(run.id, delivered=True, files=len(files))
        return None
    except Exception as exc:  # noqa: BLE001
        msg = f"model delivery failed: {str(exc)[:240]}"
        _set_state(run.id, error=msg)
        return msg
    finally:
        with _inflight_lock:
            _inflight.discard(run.id)


def read_prediction(run_id: str) -> dict[str, Any] | None:
    for item in list_local_artifacts(run_id):
        if item["path"] == PREDICTION_FILE:
            try:
                data = json.loads(read_local_artifact(run_id, PREDICTION_FILE).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
            return data if isinstance(data, dict) else {"value": data}
    return None
