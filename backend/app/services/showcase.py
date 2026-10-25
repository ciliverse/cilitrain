"""Public exhibit: seeded runs plus simulated submits. No kubeconfig, no Kubernetes API."""

from __future__ import annotations

import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import settings
from sqlalchemy.orm import object_session

from app.models.entities import AppSettings, Cluster, ClusterGrant, InferenceService, ModelVersion, Run, User
from app.services.artifacts import (
    HARVEST_DONE,
    artifacts_dir,
    set_harvest_status,
)
from app.services.auth import hash_password
from app.services.job_builder import (
    SCRIPT_MOUNT_PATH,
    Guardrails,
    build_job,
    dumps_command,
    job_name_for,
)
from app.services.metrics import load_metrics_json, save_metrics
from app.services.models import model_dir
from app.services.prom import save_frozen_resource
from app.services.resource_buffer import replace_series
from app.services.run_logs import save_run_logs
from app.services.inference import load_batch_inputs
from app.services.showcase_infer import infer_log_lines, simulate_batch, simulate_prediction

import json
import math

import yaml

from app.services.training import loads_json

DEMO_CLUSTER_ID = "showcase-demo"
DEMO_CLUSTER_NAME = "demo"

ADMIN_USER = "admin"
ADMIN_PASS = settings.showcase_admin_password
GUEST_USER = "guest"
GUEST_PASS = settings.showcase_guest_password

_TERMINAL = frozenset({"succeeded", "failed", "timeout", "cancelled"})
_PENDING_S = 3.0
_VISITOR_DONE_S = 45.0
_MONITOR_DONE_S = 6 * 3600.0
_MONITOR_ANCHOR_S = 90.0
_INFER_DONE_S = 6.0

_SEED_IDS = ("seed-nanogpt", "seed-sklearn", "seed-monitor", "seed-gpu-smoke")


def is_showcase() -> bool:
    if settings.showcase:
        return True
    raw = os.environ.get("CILITRAIN_SHOWCASE", "").strip()
    return raw == "1" or raw.lower() == "true"


def public_info() -> dict:
    if not is_showcase():
        return {"showcase": False, "accounts": []}
    return {
        "showcase": True,
        "message": "Simulated training exhibit. Jobs are not submitted to a cluster.",
        "cluster": DEMO_CLUSTER_NAME,
        "accounts": [
            {"username": ADMIN_USER, "password": ADMIN_PASS, "role": "admin"},
            {"username": GUEST_USER, "password": GUEST_PASS, "role": "viewer"},
        ],
    }


def refuse(detail: str) -> None:
    if is_showcase():
        raise HTTPException(status_code=403, detail=detail)


def pod_name_for(run: Run) -> str:
    return f"sim-{run.id[:8]}"


def simulated_snapshot(run: Run) -> dict:
    phase = {
        "pending": "Pending",
        "running": "Running",
        "succeeded": "Succeeded",
        "failed": "Failed",
        "cancelled": "Failed",
        "timeout": "Failed",
    }.get(run.status, "Unknown")
    return {
        "pod_name": pod_name_for(run) if run.status != "pending" else None,
        "pod_phase": phase,
        "status_reason": "Simulated" if run.simulated else None,
        "status_message": "simulated — no cluster",
    }


def simulated_events(run: Run) -> list[str]:
    if run.status == "pending":
        return ["Simulated: waiting to start"]
    events = ["Simulated: pod scheduled", "Simulated: container started"]
    if run.status == "succeeded":
        events.append("Simulated: training finished")
    elif run.status == "failed":
        events.append("Simulated: training failed")
    elif run.status == "cancelled":
        events.append("Simulated: cancelled")
    return events


def count_active(session: Session, namespace: str) -> int:
    rows = session.exec(
        select(Run).where(Run.namespace == namespace, Run.simulated == True)  # noqa: E712
    ).all()
    return sum(1 for row in rows if row.status in ("pending", "running"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _elapsed(run: Run, now: datetime) -> float:
    start = run.started_at or run.created_at
    if start is None:
        return 0.0
    return max(0.0, (now - _aware(start)).total_seconds())


def _done_after(run: Run) -> float:
    if run.kind == "infer":
        return _INFER_DONE_S
    if run.showcase_seed and run.template == "monitor-demo":
        return _MONITOR_DONE_S
    return _VISITOR_DONE_S


def _model_label_for(run: Run) -> str:
    session = object_session(run)
    m = session.get(ModelVersion, run.model_id) if session and run.model_id else None
    return f"{m.name}:{m.version}" if m else "model"


def _scripted_log(run: Run, elapsed: float) -> str:
    if run.kind == "infer":
        if elapsed < _PENDING_S:
            return "[cilitrain] waiting to start\n"
        done = elapsed >= _done_after(run)
        return "\n".join(infer_log_lines(run.template, _model_label_for(run), done, run.batch_rows)) + "\n"
    lines = [f"[cilitrain] simulated training for {run.name} (no cluster)"]
    if elapsed < _PENDING_S:
        lines.append("[cilitrain] waiting to start")
        return "\n".join(lines) + "\n"
    lines.append("[cilitrain] pod scheduled")
    epochs, offset, decay = _curve(run)
    if run.resume_from:
        lines.append(f"[cilitrain] resumed from checkpoint at epoch {offset}")
    total = epochs * _STEPS_PER_EPOCH
    if run.showcase_seed and run.template == "monitor-demo":
        step_s = 15.0
    else:
        step_s = (_VISITOR_DONE_S - _PENDING_S) / total
    steps = min(total, max(1, int((elapsed - _PENDING_S) / step_s)))
    lines.extend(_progress_lines(run.template, steps, epochs=epochs, offset=offset, decay=decay))
    if elapsed >= _done_after(run):
        lines.append("[cilitrain] finished")
    return "\n".join(lines) + "\n"


_STEPS_PER_EPOCH = 4


def _epochs_for(template: str) -> int:
    return 8 if template == "nanogpt-cpu" else 7


def _decay(template: str, params: dict) -> float:
    """Per-epoch loss decay. nanoGPT learns fastest near lr=1e-3 and slows the further lr is from it;
    larger batches take fewer steps per epoch, so they converge a little slower per epoch."""
    if template == "nanogpt-cpu":
        lr = float(params.get("learning_rate") or 3e-4)
        batch = max(1, int(params.get("batch_size") or 16))
        miss = abs(math.log10(lr / 1e-3)) - abs(math.log10(0.3))
        return round(max(0.7, min(0.97, 0.78 + 0.08 * miss + 0.012 * math.log2(batch / 16))), 4)
    return 0.82


def _curve(run: Run) -> tuple[int, int, float]:
    """(epochs this run trains, epochs already trained before a resume, loss decay)."""
    params = loads_json(run.params, {})
    epochs = int(params.get("epochs") or _epochs_for(run.template))
    offset = 0
    if run.resume_from:
        offset = int((load_metrics_json(run.resume_from) or {}).get("epochs") or 0)
    return epochs, offset, _decay(run.template, params)


def _loss_at(template: str, x: float, decay: float | None = None) -> float:
    """Training loss after x epochs; the epoch-end values are what metrics.json history records."""
    if template == "nanogpt-cpu":
        return round(3.2 * ((decay or 0.78) ** x), 4)
    return round(2.8 * ((decay or 0.82) ** x), 4)


def _progress_lines(
    template: str,
    steps: int,
    *,
    epochs: int | None = None,
    offset: int = 0,
    decay: float | None = None,
) -> list[str]:
    epochs = epochs or _epochs_for(template)
    out = []
    for i in range(1, steps + 1):
        ep = (i - 1) // _STEPS_PER_EPOCH + 1 + offset
        st = (i - 1) % _STEPS_PER_EPOCH + 1
        loss = _loss_at(template, offset + i / _STEPS_PER_EPOCH, decay)
        out.append(
            f"[cilitrain] epoch {ep}/{offset + epochs} step {st}/{_STEPS_PER_EPOCH} loss {loss}"
        )
    return out


def _sklearn_accuracy(params: dict) -> float:
    """Strong regularisation (small C) or very few iterations costs accuracy."""
    c = float(params.get("c") or 1.0)
    acc = 0.9737 - 0.2 * max(0.0, math.log10(0.3 / c))
    if int(params.get("max_iter") or 200) < 50:
        acc -= 0.05
    acc += (0.25 - float(params.get("test_size") or 0.25)) * 0.04
    return round(max(0.6, min(0.99, acc)), 4)


def _samples(elapsed: float, now: datetime) -> list[dict]:
    if elapsed < _PENDING_S:
        return []
    span = elapsed - _PENDING_S
    n = min(40, max(1, int(span / 5) or 1))
    start = now.timestamp() - elapsed + _PENDING_S
    step = span / n if n else 1
    out = []
    for i in range(n):
        ts = start + i * step
        cpu = round(0.12 + 0.28 * ((i % 7) / 6), 3)
        out.append(
            {
                "ts": ts,
                "cpu_cores": cpu,
                "cpu_m": round(cpu * 1000, 1),
                "memory_mi": round(160 + i * 4.5, 1),
            }
        )
    return out


def advance_simulated(session: Session, run: Run, now: datetime | None = None) -> Run:
    """Move a simulated run along its script. Terminal rows are left as stored."""
    if not run.simulated or run.status in _TERMINAL or run.status == "queued":
        return run
    now = now or _now()
    elapsed = _elapsed(run, now)
    if elapsed < _PENDING_S:
        status = "pending"
    elif elapsed < _done_after(run):
        status = "running"
    else:
        status = "succeeded"
    run.status = status
    run.updated_at = now
    if status == "succeeded":
        run.finished_at = now
    elif run.finished_at is not None and status in ("pending", "running"):
        run.finished_at = None
    save_run_logs(run.id, _scripted_log(run, elapsed), pod_name_for(run))
    if status == "succeeded":
        _write_simulated_outputs(run)
    samples = _samples(elapsed, now)
    if samples:
        replace_series(run.id, samples)
        if status == "succeeded":
            save_frozen_resource(
                run.id,
                series=samples,
                source="showcase",
                pod_name=pod_name_for(run),
            )
    session.add(run)
    session.commit()
    session.refresh(run)
    return run


def advance_all(session: Session, now: datetime | None = None) -> None:
    now = now or _now()
    rows = session.exec(select(Run).where(Run.simulated == True)).all()  # noqa: E712
    for run in rows:
        advance_simulated(session, run, now)


def resource_monitor(run: Run) -> dict:
    from app.services.prom import load_frozen_resource
    from app.services.resource_buffer import series_for

    pod = pod_name_for(run)
    if run.status in _TERMINAL:
        frozen = load_frozen_resource(run.id)
        if frozen:
            return {
                "available": True,
                "pending": False,
                "pod_name": frozen.get("pod_name") or pod,
                "series": frozen["series"],
                "series_source": frozen.get("series_source") or "showcase",
                "prometheus": False,
                "frozen": True,
                "message": "resource_history_frozen",
            }
    series = series_for(run.id)
    last = series[-1] if series else None
    cpu_m = last.get("cpu_m") if isinstance(last, dict) else None
    mem_mi = last.get("memory_mi") if isinstance(last, dict) else None
    live = run.status == "running" and last is not None
    return {
        "available": bool(series),
        "pending": not series and run.status in ("pending", "running"),
        "cpu": f"{round(float(cpu_m))}m" if live and cpu_m is not None else None,
        "memory": f"{round(float(mem_mi))}Mi" if live and mem_mi is not None else None,
        "cpu_cores": last.get("cpu_cores") if live and isinstance(last, dict) else None,
        "memory_mi": mem_mi if live else None,
        "pod_name": pod if run.status != "pending" else None,
        "series": series,
        "series_source": "showcase",
        "prometheus": False,
        "frozen": False,
        "message": None if series else "waiting_for_pod_scrape",
    }


def _upsert_user(session: Session, username: str, password: str, role: str) -> User:
    user = session.exec(select(User).where(User.username == username)).first()
    if user is None:
        user = User(username=username, password_hash=hash_password(password), role=role)
    else:
        user.password_hash = hash_password(password)
        user.role = role
        user.is_active = True
        user.must_change_password = False
        user.updated_at = _now()
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _grant(session: Session, user: User, cluster_id: str) -> None:
    existing = session.exec(
        select(ClusterGrant).where(
            ClusterGrant.user_id == user.id,
            ClusterGrant.cluster_id == cluster_id,
            ClusterGrant.namespace == "default",
        )
    ).first()
    if existing:
        return
    session.add(ClusterGrant(user_id=user.id, cluster_id=cluster_id, namespace="default"))
    session.commit()


def _drop_metrics(run_id: str) -> None:
    path = settings.data_dir / "metrics" / run_id
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    mfile = settings.data_dir / "metrics" / f"{run_id}.json"
    if mfile.exists():
        mfile.unlink(missing_ok=True)
    art = settings.data_dir / "artifacts" / run_id
    if art.exists():
        shutil.rmtree(art, ignore_errors=True)


def _write_artifact_files(
    run_id: str,
    files: dict[str, str],
    metrics_payload: dict | None = None,
    *,
    extra: list[tuple[str, int]] | None = None,
) -> None:
    """`extra` lists files already written into the artifact dir, as (path, size)."""
    dest = artifacts_dir(run_id)
    items = [{"path": rel, "size": size} for rel, size in (extra or [])]
    for name, content in files.items():
        fp = dest / name
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content, encoding="utf-8")
        items.append({"path": name, "size": fp.stat().st_size})
    if metrics_payload is not None:
        mtxt = json.dumps(metrics_payload, indent=2) + "\n"
        mfp = dest / "metrics.json"
        mfp.write_text(mtxt, encoding="utf-8")
        items.append({"path": "metrics.json", "size": mfp.stat().st_size})
        save_metrics(run_id, metrics_payload)
    if items:
        (dest / ".index.json").write_text(json.dumps(items, indent=2), encoding="utf-8")
    set_harvest_status(run_id, HARVEST_DONE)


# Padded to roughly the size the real scripts produce (815k fp32 params + AdamW state; a tiny joblib).
_STUB_MODELS = {
    "nanogpt-cpu": ("model.pt", b"simulated nanogpt checkpoint (showcase stub)\n", 9_806_123),
    "sklearn-cpu": ("model.joblib", b"simulated LogisticRegression (showcase stub)\n", 1_412),
}


def _write_stub_model(dest_dir: Path, template: str) -> tuple[str, int]:
    rel, head, size = _STUB_MODELS[template]
    target = dest_dir / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(head + b"\0" * (size - len(head)))
    return rel, size


def _write_simulated_outputs(run: Run) -> None:
    tmpl = run.template
    if run.kind == "infer" and run.batch_rows:
        table, summary = simulate_batch(tmpl, load_batch_inputs(run.id))
        _write_artifact_files(
            run.id,
            {"predictions.csv": table, "prediction.json": json.dumps(summary, indent=2, ensure_ascii=False) + "\n"},
        )
        return
    if run.kind == "infer":
        inp = json.loads(run.infer_input or "{}")
        pred = simulate_prediction(tmpl, inp)
        _write_artifact_files(run.id, {"prediction.json": json.dumps(pred, indent=2) + "\n"})
        return
    stub = [_write_stub_model(artifacts_dir(run.id), tmpl)] if tmpl in _STUB_MODELS else []
    epochs, offset, decay = _curve(run)
    params = loads_json(run.params, {})
    if tmpl == "nanogpt-cpu":
        history = [
            {
                "epoch": ep,
                "loss": _loss_at(tmpl, ep, decay),
                "val_loss": round(3.35 * ((decay + 0.02) ** ep), 4),
            }
            for ep in range(offset + 1, offset + epochs + 1)
        ]
        payload = {
            "params": 815429,
            "vocab": 65,
            "epochs": offset + epochs,
            "loss": history[-1]["loss"],
            "val_loss": history[-1]["val_loss"],
            "history": history,
            "arch": "nanogpt-char",
        }
        if offset:
            payload["resumed_at_epoch"] = offset
        if params:
            payload["hyperparams"] = params
        sample = (
            "To be, or not to be, that is the question:\n"
            "Whether 'tis nobler in the mind to suffer\n"
            "The slings and arrows of outrageous fortune,\n"
            "Or to take arms against a sea of troubles.\n"
        )
        _write_artifact_files(run.id, {"sample.txt": sample}, payload, extra=stub)
    elif tmpl == "sklearn-cpu":
        acc = _sklearn_accuracy(params)
        loss = round(1 - acc, 4)
        history = [
            {"epoch": 0, "loss": 1.0, "acc": 0.0},
            {"epoch": 1, "loss": loss, "acc": acc},
        ]
        payload = {
            "acc": acc,
            "loss": loss,
            "epochs": 2,
            "model": "LogisticRegression",
            "dataset": "iris",
            "history": history,
        }
        if params:
            payload["hyperparams"] = params
        _write_artifact_files(run.id, {"score.txt": f"{acc}\n"}, payload, extra=stub)
    else:
        history = [
            {
                "epoch": ep,
                "loss": _loss_at(tmpl, ep, decay),
                "acc": round(min(0.98, 1.0 - min(0.95, 0.85 * (0.78 ** ep))), 4),
            }
            for ep in range(offset + 1, offset + epochs + 1)
        ]
        payload = {
            "epochs": offset + epochs,
            "loss": history[-1]["loss"],
            "acc": history[-1]["acc"],
            "history": history,
        }
        _write_artifact_files(
            run.id,
            {"summary.txt": f"final loss={payload['loss']:.4f} acc={payload['acc']:.4f}\n"},
            payload,
        )


def _write_static(run: Run, log: str, samples: list[dict]) -> None:
    save_run_logs(run.id, log, pod_name_for(run))
    if samples:
        replace_series(run.id, samples)
        save_frozen_resource(run.id, series=samples, source="showcase", pod_name=pod_name_for(run))
    if run.status == "succeeded":
        _write_simulated_outputs(run)


def _seed_job_yaml(
    *,
    run_id: str,
    name: str,
    template: str,
    image: str,
    command: list[str],
    args: list[str],
    cpu: str,
    memory: str,
    gpu_count: int,
    timeout_seconds: int,
) -> str:
    job = build_job(
        run_id=run_id,
        name=name,
        namespace="default",
        template=template,
        image=image,
        command=command,
        args=args,
        cpu=cpu,
        memory=memory,
        timeout_seconds=timeout_seconds,
        gpu_count=gpu_count,
        hold_seconds=settings.hold_seconds,
        guardrails=Guardrails(
            max_cpu=settings.max_cpu,
            max_memory_gi=settings.max_memory_gi,
            max_gpu=settings.max_gpu,
            default_timeout_seconds=max(settings.default_timeout_seconds, timeout_seconds),
        ),
        files={"train.py": "# mounted via ConfigMap\n"} if template != "gpu-smoke" else None,
    )
    return yaml.safe_dump(job, sort_keys=False)


def _seed_run(
    session: Session,
    *,
    run_id: str,
    owner_id: str,
    name: str,
    template: str,
    image: str,
    cpu: str,
    memory: str,
    gpu_count: int,
    status: str,
    created_at: datetime,
    finished_at: datetime | None,
    error_message: str | None,
    log: str,
    samples: list[dict],
) -> None:
    cmd = ["python", "-u", f"{SCRIPT_MOUNT_PATH}/train.py"] if template != "gpu-smoke" else ["nvidia-smi"]
    timeout_sec = 7200 if template == "monitor-demo" else 3600
    yaml_str = _seed_job_yaml(
        run_id=run_id,
        name=name,
        template=template,
        image=image,
        command=cmd,
        args=[],
        cpu=cpu,
        memory=memory,
        gpu_count=gpu_count,
        timeout_seconds=timeout_sec,
    )
    run = session.get(Run, run_id)
    if run is None:
        run = Run(
            id=run_id,
            cluster_id=DEMO_CLUSTER_ID,
            owner_user_id=owner_id,
            name=name,
            namespace="default",
            template=template,
            image=image,
            command=dumps_command(cmd),
            args="[]",
            cpu=cpu,
            memory=memory,
            gpu_count=gpu_count,
            timeout_seconds=timeout_sec,
            status=status,
            job_name=job_name_for(run_id),
            job_yaml=yaml_str,
            simulated=True,
            showcase_seed=True,
            error_message=error_message,
            created_at=created_at,
            updated_at=finished_at or created_at,
            finished_at=finished_at,
        )
        session.add(run)
        session.commit()
        _write_static(run, log, samples)
        return
    run.simulated = True
    run.showcase_seed = True
    run.cluster_id = DEMO_CLUSTER_ID
    run.command = dumps_command(cmd)
    run.job_yaml = yaml_str
    session.add(run)
    session.commit()
    _write_static(run, log, samples)


def _loss_log(name: str, template: str, done: bool) -> str:
    lines = [f"[cilitrain] simulated training for {name} (no cluster)", "[cilitrain] pod scheduled"]
    lines.extend(_progress_lines(template, _epochs_for(template) * _STEPS_PER_EPOCH))
    if done:
        lines.append("[cilitrain] finished")
    return "\n".join(lines) + "\n"


def _sklearn_log() -> str:
    return (
        "[cilitrain] simulated training for sklearn-cpu (no cluster)\n"
        "[cilitrain] pod scheduled\n"
        "[cilitrain] loading iris...\n"
        "metrics epoch=0 loss=1.0 acc=0.0\n"
        "metrics epoch=1 loss=0.0263 acc=0.9737\n"
        "score 0.9737\n"
        "[cilitrain] finished\n"
    )


def _past_samples(start: datetime, minutes: int) -> list[dict]:
    n = 24
    out = []
    for i in range(n):
        ts = (start + timedelta(seconds=i * (minutes * 60 / n))).timestamp()
        cpu = round(0.2 + 0.15 * ((i % 5) / 4), 3)
        out.append(
            {
                "ts": ts,
                "cpu_cores": cpu,
                "cpu_m": round(cpu * 1000, 1),
                "memory_mi": round(400 + i * 12, 1),
            }
        )
    return out


def prepare_showcase(session: Session) -> None:
    """Reset the exhibit. No-op unless showcase mode is on."""
    if not is_showcase():
        return
    admin = _upsert_user(session, ADMIN_USER, ADMIN_PASS, "admin")
    guest = _upsert_user(session, GUEST_USER, GUEST_PASS, "viewer")

    visitors = session.exec(select(Run).where(Run.showcase_seed == False)).all()  # noqa: E712
    for run in visitors:
        _drop_metrics(run.id)
        session.delete(run)
    for cluster in session.exec(select(Cluster)).all():
        if cluster.id != DEMO_CLUSTER_ID:
            session.delete(cluster)
    session.commit()

    cluster = session.get(Cluster, DEMO_CLUSTER_ID)
    if cluster is None:
        cluster = Cluster(
            id=DEMO_CLUSTER_ID,
            name=DEMO_CLUSTER_NAME,
            simulated=True,
            context="showcase",
        )
        session.add(cluster)
    else:
        cluster.name = DEMO_CLUSTER_NAME
        cluster.simulated = True
        cluster.kubeconfig_content = None
        cluster.kubeconfig_path = None
        cluster.context = "showcase"
        session.add(cluster)
    session.commit()
    _grant(session, guest, DEMO_CLUSTER_ID)

    now = _now()
    nano_start = now - timedelta(hours=3)
    sk_start = now - timedelta(hours=6)
    _seed_run(
        session,
        run_id="seed-nanogpt",
        owner_id=admin.id,
        name="nanogpt-cpu",
        template="nanogpt-cpu",
        image="python:3.12-slim",
        cpu="4",
        memory="8Gi",
        gpu_count=0,
        status="succeeded",
        created_at=nano_start,
        finished_at=nano_start + timedelta(minutes=40),
        error_message=None,
        log=_loss_log("nanogpt-cpu", "nanogpt-cpu", True),
        samples=_past_samples(nano_start, 40),
    )
    _seed_run(
        session,
        run_id="seed-sklearn",
        owner_id=admin.id,
        name="sklearn-cpu",
        template="sklearn-cpu",
        image="python:3.12-slim",
        cpu="1",
        memory="1Gi",
        gpu_count=0,
        status="succeeded",
        created_at=sk_start,
        finished_at=sk_start + timedelta(minutes=12),
        error_message=None,
        log=_sklearn_log(),
        samples=_past_samples(sk_start, 12),
    )
    fail_start = now - timedelta(hours=1)
    _seed_run(
        session,
        run_id="seed-gpu-smoke",
        owner_id=admin.id,
        name="gpu-smoke",
        template="gpu-smoke",
        image="nvidia/cuda:12.4.1-base-ubuntu22.04",
        cpu="500m",
        memory="1Gi",
        gpu_count=1,
        status="failed",
        created_at=fail_start,
        finished_at=fail_start + timedelta(minutes=2),
        error_message="ImagePullBackOff (simulated — this exhibit has no GPU node)",
        log=(
            "[cilitrain] simulated GPU smoke\n"
            "[cilitrain] pulling nvidia/cuda:12.4.1-base-ubuntu22.04\n"
            "Error: ImagePullBackOff (simulated — this exhibit has no GPU node)\n"
        ),
        samples=_past_samples(fail_start, 2)[:4],
    )
    monitor_cmd = ["python", "-u", f"{SCRIPT_MOUNT_PATH}/train.py"]
    monitor_yaml = _seed_job_yaml(
        run_id="seed-monitor",
        name="monitor-demo",
        template="monitor-demo",
        image="python:3.12-slim",
        command=monitor_cmd,
        args=[],
        cpu="200m",
        memory="256Mi",
        gpu_count=0,
        timeout_seconds=int(_MONITOR_DONE_S),
    )
    monitor = session.get(Run, "seed-monitor")
    anchor = now - timedelta(seconds=_MONITOR_ANCHOR_S)
    if monitor is None:
        monitor = Run(
            id="seed-monitor",
            cluster_id=DEMO_CLUSTER_ID,
            owner_user_id=admin.id,
            name="monitor-demo",
            namespace="default",
            template="monitor-demo",
            image="python:3.12-slim",
            command=dumps_command(monitor_cmd),
            args="[]",
            cpu="200m",
            memory="256Mi",
            gpu_count=0,
            timeout_seconds=int(_MONITOR_DONE_S),
            status="running",
            job_name=job_name_for("seed-monitor"),
            job_yaml=monitor_yaml,
            simulated=True,
            showcase_seed=True,
            created_at=anchor,
            updated_at=now,
        )
        session.add(monitor)
        session.commit()
    else:
        monitor.created_at = anchor
        monitor.status = "running"
        monitor.finished_at = None
        monitor.command = dumps_command(monitor_cmd)
        monitor.job_yaml = monitor_yaml
        monitor.simulated = True
        monitor.showcase_seed = True
        monitor.updated_at = now
        session.add(monitor)
        session.commit()
    advance_simulated(session, monitor, now)
    _seed_models(session, admin, now)
    _seed_service(session, admin, now)
    _pin_cilikube_url(session)


def _seed_service(session: Session, admin: User, now: datetime) -> None:
    from collections import deque

    from app.services.serving import _recent, forget, new_api_key

    for svc in session.exec(select(InferenceService)).all():
        if svc.id != "seed-service-iris":
            forget(svc.id)
            session.delete(svc)
    session.commit()
    _, key_hash, key_prefix = new_api_key()
    svc = session.get(InferenceService, "seed-service-iris") or InferenceService(
        id="seed-service-iris", name="iris-api", model_id="seed-model-iris", cluster_id=DEMO_CLUSTER_ID
    )
    svc.owner_user_id = admin.id
    svc.cluster_id = DEMO_CLUSTER_ID
    svc.namespace = "default"
    svc.template = "sklearn-cpu"
    svc.image = "python:3.12-slim"
    svc.cpu, svc.memory, svc.replicas = "500m", "512Mi", 1
    svc.status = "running"
    svc.simulated = True
    svc.showcase_seed = True
    svc.error_message = None
    svc.api_key_hash, svc.api_key_prefix = key_hash, key_prefix
    svc.requests, svc.errors, svc.total_ms = 1284, 3, 1284 * 11
    svc.last_request_at = now - timedelta(minutes=2)
    svc.created_at = svc.started_at = now - timedelta(hours=4)
    svc.stopped_at = None
    svc.updated_at = now
    forget(svc.id)
    session.add(svc)
    session.commit()
    ring = _recent.setdefault(svc.id, deque(maxlen=20))
    for i, (label, p, rows, ms) in enumerate(_SEED_TRAFFIC):
        at = now - timedelta(minutes=2 + 7 * (len(_SEED_TRAFFIC) - 1 - i))
        ring.append(
            {
                "at": at.isoformat().replace("+00:00", "Z"),
                "ok": label is not None,
                "latency_ms": ms,
                "rows": rows,
                "summary": f"{label} {p:.2f}" if label else "",
            }
        )


_SEED_TRAFFIC = (
    ("setosa", 0.98, 1, 9.4),
    ("virginica", 0.91, 8, 16.2),
    (None, 0.0, 1, 3.1),
    ("versicolor", 0.87, 1, 10.8),
    ("virginica", 0.94, 1, 11.5),
)


_SEED_MODELS = (
    # model id, name, source run, template, example inference run, hours ago, input
    (
        "seed-model-nanogpt",
        "nanogpt-hamlet",
        "seed-nanogpt",
        "nanogpt-cpu",
        "seed-infer-nanogpt",
        2,
        {"prompt": "To be, or not", "max_new_tokens": 200, "temperature": 0.8},
    ),
    (
        "seed-model-iris",
        "iris-logreg",
        "seed-sklearn",
        "sklearn-cpu",
        "seed-infer-iris",
        5,
        {"sepal_length": 6.4, "sepal_width": 3.1, "petal_length": 5.5, "petal_width": 1.8},
    ),
)


def _seed_models(session: Session, admin: User, now: datetime) -> None:
    keep = {row[0] for row in _SEED_MODELS}
    for m in session.exec(select(ModelVersion)).all():
        if m.id not in keep:
            shutil.rmtree(model_dir(m.id), ignore_errors=True)
            session.delete(m)
    session.commit()

    for model_id, name, run_id, template, infer_id, hours, inp in _SEED_MODELS:
        rel, size = _write_stub_model(model_dir(model_id), template)
        src = session.get(Run, run_id)
        m = session.get(ModelVersion, model_id) or ModelVersion(id=model_id, name=name, template=template)
        m.name, m.version, m.template = name, 1, template
        m.source_run_id = run_id
        m.owner_user_id = admin.id
        m.files_json = json.dumps([{"path": rel, "size": size}])
        m.size_bytes = size
        metrics = load_metrics_json(run_id) or {}
        m.metrics_json = json.dumps(
            {k: v for k, v in metrics.items() if isinstance(v, (int, float, str)) and not isinstance(v, bool)}
        )
        m.showcase_seed = True
        if src and src.finished_at:
            m.created_at = src.finished_at + timedelta(minutes=3)
        session.add(m)
        session.commit()

        start = now - timedelta(hours=hours)
        run = session.get(Run, infer_id) or Run(
            id=infer_id,
            cluster_id=DEMO_CLUSTER_ID,
            name=f"infer-{name}",
            template=template,
            image="python:3.12-slim",
            command="[]",
        )
        run.owner_user_id = admin.id
        run.cluster_id = DEMO_CLUSTER_ID
        run.kind = "infer"
        run.model_id = model_id
        run.infer_input = json.dumps(inp)
        run.cpu, run.memory = ("1", "2Gi") if template == "nanogpt-cpu" else ("500m", "512Mi")
        run.timeout_seconds = 900
        run.command = dumps_command(["python", "-u", f"{SCRIPT_MOUNT_PATH}/infer.py"])
        run.status = "succeeded"
        run.simulated = True
        run.showcase_seed = True
        run.job_name = job_name_for(infer_id)
        run.created_at = start
        run.finished_at = start + timedelta(seconds=40)
        run.updated_at = run.finished_at
        session.add(run)
        session.commit()
        session.refresh(run)
        log = "\n".join(infer_log_lines(template, f"{name}:1", True)) + "\n"
        _write_static(run, log, _past_samples(start, 1)[:6])


def _pin_cilikube_url(session: Session) -> None:
    """Point the exhibit at a CiliKube demo when the host configured one."""
    url = (settings.showcase_cilikube_url or "").strip().rstrip("/")
    if not url:
        return
    row = session.get(AppSettings, 1)
    if row is None:
        row = AppSettings(id=1)
    row.cilikube_base_url = url
    session.add(row)
    session.commit()
