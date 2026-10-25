"""Online inference services: a Deployment running examples/serve.py behind a ClusterIP Service.

The platform copies the registered model into each pod's /model (same delivery as inference
Jobs), proxies requests through the apiserver, and checks inputs against the template's spec.
"""

from __future__ import annotations

import hashlib
import logging
import random
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session

from app.models.entities import InferenceService
from app.services.inference import deliver_files, infer_spec, validate_infer_input, wait_for_model, _kube_sink
from app.services.job_builder import (
    LABEL_MANAGED,
    LABEL_TEMPLATE,
    MODEL_MOUNT_PATH,
    SCRIPT_MOUNT_PATH,
    parse_cpu_cores,
    parse_memory_gi,
)
from app.services.models import model_dir
from app.services.showcase_infer import simulate_prediction

log = logging.getLogger("cilitrain.serving")

LABEL_SERVICE = "cilitrain.io/service"
SERVE_PORT = 8080
SERVE_SCRIPT = "serve.py"
MAX_REPLICAS = 3
MAX_BATCH = 32
PREDICT_TIMEOUT = 60.0
SIMULATED_STARTUP_SECONDS = 4
KEY_PREFIX = "ctk_"
ACTIVE_STATES = ("starting", "running")

_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


def resource_name(service_id: str) -> str:
    return f"cilitrain-svc-{service_id.replace('-', '')[:10]}"


def endpoint_path(service_id: str) -> str:
    return f"/api/serve/{service_id}/predict"


# —— API keys: stored as a hash; the plain key is shown once ——


def new_api_key() -> tuple[str, str, str]:
    """(plain key, sha256 hex, display prefix)."""
    key = KEY_PREFIX + secrets.token_urlsafe(24)
    return key, hash_key(key), key[: len(KEY_PREFIX) + 6]


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def key_matches(svc: InferenceService, key: str) -> bool:
    return bool(svc.api_key_hash) and secrets.compare_digest(svc.api_key_hash, hash_key(key))


# —— Manifests ——


def serve_files(template: str) -> dict[str, str]:
    spec = infer_spec(template)
    if not spec:
        raise HTTPException(status_code=400, detail=f"template {template} has no inference support")
    script = Path(spec["script"])
    return {
        script.name: (_EXAMPLES / script).read_text(encoding="utf-8"),
        SERVE_SCRIPT: (_EXAMPLES / SERVE_SCRIPT).read_text(encoding="utf-8"),
    }


def serve_command(template: str, bootstrap: list[str]) -> list[str]:
    spec = infer_spec(template) or {}
    module = Path(spec.get("script", "infer.py")).stem
    serve = ["env", f"CILITRAIN_INFER_MODULE={module}", "python", "-u", f"{SCRIPT_MOUNT_PATH}/{SERVE_SCRIPT}"]
    _, (wait,) = wait_for_model(serve, [])
    return ["bash", "-lc", "set -euo pipefail; " + "".join(f"{s}; " for s in bootstrap) + wait]


def _labels(svc: InferenceService) -> dict[str, str]:
    return {
        LABEL_MANAGED: "cilitrain",
        LABEL_SERVICE: svc.id,
        LABEL_TEMPLATE: svc.template,
        "app.kubernetes.io/name": "cilitrain-serve",
        "app.kubernetes.io/instance": resource_name(svc.id),
    }


def build_configmap(svc: InferenceService, files: dict[str, str]) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": f"{resource_name(svc.id)}-scripts", "namespace": svc.namespace, "labels": _labels(svc)},
        "data": files,
    }


def build_deployment(svc: InferenceService, command: list[str], env: dict[str, str]) -> dict[str, Any]:
    name = resource_name(svc.id)
    labels = _labels(svc)
    container = {
        "name": "trainer",
        "image": svc.image,
        "imagePullPolicy": "IfNotPresent",
        "command": command[:2],
        "args": command[2:],
        "ports": [{"name": "http", "containerPort": SERVE_PORT}],
        "env": [
            {"name": "CILITRAIN_SERVICE_ID", "value": svc.id},
            {"name": "CILITRAIN_MODEL_DIR", "value": MODEL_MOUNT_PATH},
            {"name": "CILITRAIN_SERVE_PORT", "value": str(SERVE_PORT)},
            {"name": "PYTHONUNBUFFERED", "value": "1"},
            *[{"name": k, "value": v} for k, v in env.items()],
        ],
        "resources": {
            "requests": {"cpu": svc.cpu, "memory": svc.memory},
            "limits": {"cpu": svc.cpu, "memory": svc.memory},
        },
        "readinessProbe": {
            "httpGet": {"path": "/healthz", "port": SERVE_PORT},
            "periodSeconds": 5,
            "failureThreshold": 3,
        },
        "volumeMounts": [
            {"name": "scripts", "mountPath": SCRIPT_MOUNT_PATH, "readOnly": True},
            {"name": "model", "mountPath": MODEL_MOUNT_PATH},
        ],
    }
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": svc.namespace,
            "labels": labels,
            "annotations": {"cilitrain.io/display-name": svc.name},
        },
        "spec": {
            "replicas": svc.replicas,
            "selector": {"matchLabels": {LABEL_SERVICE: svc.id}},
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "containers": [container],
                    "volumes": [
                        {"name": "scripts", "configMap": {"name": f"{name}-scripts"}},
                        {"name": "model", "emptyDir": {}},
                    ],
                },
            },
        },
    }


def build_service(svc: InferenceService) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": resource_name(svc.id), "namespace": svc.namespace, "labels": _labels(svc)},
        "spec": {
            "type": "ClusterIP",
            "selector": {LABEL_SERVICE: svc.id},
            "ports": [{"name": "http", "port": SERVE_PORT, "targetPort": SERVE_PORT}],
        },
    }


# —— Resource accounting (per-user quota) ——


def service_usage(svc: InferenceService) -> dict[str, float]:
    if svc.status not in ACTIVE_STATES:
        return {"cpu": 0.0, "memory_gi": 0.0}
    n = max(1, int(svc.replicas or 1))
    try:
        return {"cpu": parse_cpu_cores(svc.cpu) * n, "memory_gi": parse_memory_gi(svc.memory) * n}
    except (ValueError, HTTPException):
        return {"cpu": 0.0, "memory_gi": 0.0}


# —— Status sync and model delivery ——

_delivered: dict[str, set[str]] = {}
_inflight: set[str] = set()
_lock = threading.Lock()


def _deliver_async(kube: Any, svc_id: str, namespace: str, pod: str, root: Path) -> None:
    with _lock:
        if pod in _inflight or pod in _delivered.get(svc_id, set()):
            return
        _inflight.add(pod)

    def work() -> None:
        try:
            files = sorted((p.relative_to(root).as_posix(), p) for p in root.rglob("*") if p.is_file())
            if not files:
                raise RuntimeError("model files missing on the platform")
            deliver_files(_kube_sink(kube, namespace, pod), files)
            with _lock:
                _delivered.setdefault(svc_id, set()).add(pod)
        except Exception:  # noqa: BLE001
            log.exception("model delivery to %s failed", pod)
        finally:
            with _lock:
                _inflight.discard(pod)

    threading.Thread(target=work, name=f"deliver-{pod}", daemon=True).start()


def _pod_message(pod: Any) -> str | None:
    for cs in (pod.status.container_statuses or []) if pod.status else []:
        waiting = cs.state.waiting if cs.state else None
        if waiting and waiting.reason not in (None, "ContainerCreating"):
            return f"{waiting.reason}: {waiting.message or ''}".strip(": ")
    return None


def sync_service(session: Session, svc: InferenceService, kube: Any | None) -> tuple[int, str | None]:
    """Refresh status from the cluster and push the model into new pods. Returns (ready, message)."""
    if svc.status not in ACTIVE_STATES:
        return 0, None
    if kube is None:
        started = svc.started_at.replace(tzinfo=timezone.utc) if svc.started_at and svc.started_at.tzinfo is None else svc.started_at
        warm = started is not None and (datetime.now(timezone.utc) - started).total_seconds() >= SIMULATED_STARTUP_SECONDS
        if warm and svc.status == "starting":
            _set_status(session, svc, "running")
        return (svc.replicas if warm else 0), None
    name = resource_name(svc.id)
    dep = kube.get_deployment(svc.namespace, name)
    if dep is None:
        _set_status(session, svc, "failed", "deployment is gone from the cluster")
        return 0, None
    ready = int((dep.status.ready_replicas if dep.status else 0) or 0)
    message = None
    root = model_dir(svc.model_id)
    for pod in kube.list_pods(svc.namespace, f"{LABEL_SERVICE}={svc.id}"):
        if pod.metadata.deletion_timestamp:
            continue
        message = message or _pod_message(pod)
        if pod.status and pod.status.phase == "Running":
            _deliver_async(kube, svc.id, svc.namespace, pod.metadata.name, root)
    if ready > 0 and svc.status != "running":
        _set_status(session, svc, "running")
    elif ready == 0 and svc.status == "running":
        _set_status(session, svc, "starting")
    return ready, message


def _set_status(session: Session, svc: InferenceService, status: str, error: str | None = None) -> None:
    svc.status = status
    svc.error_message = error
    svc.updated_at = datetime.now(timezone.utc)
    session.add(svc)
    session.commit()
    session.refresh(svc)


def forget(svc_id: str) -> None:
    with _lock:
        _delivered.pop(svc_id, None)
    _recent.pop(svc_id, None)


# —— Prediction ——

_recent: dict[str, deque] = {}


def recent_requests(svc_id: str) -> list[dict[str, Any]]:
    return list(reversed(_recent.get(svc_id, ())))


def _summary(out: dict[str, Any] | None) -> str:
    if not out:
        return ""
    if out.get("type") == "classification":
        label = out.get("label")
        p = (out.get("probabilities") or {}).get(label)
        return f"{label} {p:.2f}" if isinstance(p, (int, float)) else str(label)
    if out.get("type") == "text":
        return str(out.get("text", ""))[-60:].replace("\n", " ")
    return str(out)[:60]


def validate_request(template: str, body: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    """Typed inputs and whether the caller sent a list."""
    spec = infer_spec(template) or {}
    if body.get("inputs") is not None:
        rows = body["inputs"]
        if not isinstance(rows, list) or not rows:
            raise HTTPException(status_code=400, detail="inputs must be a non-empty list")
        if len(rows) > MAX_BATCH:
            raise HTTPException(status_code=400, detail=f"at most {MAX_BATCH} inputs per request")
        out = []
        for i, raw in enumerate(rows):
            try:
                out.append(validate_infer_input(spec, raw if isinstance(raw, dict) else None))
            except HTTPException as exc:
                raise HTTPException(status_code=400, detail=f"inputs[{i}]: {exc.detail}") from None
        return out, True
    raw = body.get("input")
    return [validate_infer_input(spec, raw if isinstance(raw, dict) else None)], False


def predict(session: Session, svc: InferenceService, kube: Any | None, body: dict[str, Any]) -> dict[str, Any]:
    if svc.status != "running":
        raise HTTPException(status_code=409, detail=f"service is {svc.status}, not running")
    rows, many = validate_request(svc.template, body)
    t0 = time.perf_counter()
    ok = False
    out: dict[str, Any] = {}
    try:
        if kube is None:
            outputs = [simulate_prediction(svc.template, r) for r in rows]
            out = {"outputs": outputs} if many else {"output": outputs[0]}
        else:
            payload = {"inputs": rows} if many else {"input": rows[0]}
            out = kube.proxy_post(svc.namespace, resource_name(svc.id), SERVE_PORT, "predict", payload, PREDICT_TIMEOUT)
        ok = True
    finally:
        ms = (time.perf_counter() - t0) * 1000
        if kube is None:
            ms += random.uniform(6, 14) + 0.8 * len(rows)
        _record(session, svc, ok, ms, rows, out)
    return {**out, "latency_ms": round(ms, 1)}


def _record(session: Session, svc: InferenceService, ok: bool, ms: float, rows: list, out: dict) -> None:
    now = datetime.now(timezone.utc)
    svc.requests += 1
    svc.errors += 0 if ok else 1
    svc.total_ms += int(round(ms))
    svc.last_request_at = now
    session.add(svc)
    session.commit()
    first = out.get("output") or (out.get("outputs") or [None])[0]
    ring = _recent.setdefault(svc.id, deque(maxlen=20))
    ring.append(
        {
            "at": now.isoformat().replace("+00:00", "Z"),
            "ok": ok,
            "latency_ms": round(ms, 1),
            "rows": len(rows),
            "summary": _summary(first) if ok else "",
        }
    )
