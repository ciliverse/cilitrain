"""FIFO run queue: runs wait as `queued` until their namespace (and owner) has a free slot."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, func, select

from app.config import settings
from app.models.entities import InferenceService, Run
from app.services.job_builder import parse_cpu_cores, parse_memory_gi

QUEUED = "queued"
ACTIVE = ("pending", "running")


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _launch_path(run_id: str) -> Path:
    path = settings.data_dir / "queue"
    path.mkdir(parents=True, exist_ok=True)
    return path / f"{run_id}.json"


def save_launch(run_id: str, files: dict[str, str]) -> None:
    _launch_path(run_id).write_text(json.dumps({"files": files}), encoding="utf-8")


def load_launch(run_id: str) -> dict[str, Any]:
    path = _launch_path(run_id)
    if not path.exists():
        return {"files": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def has_launch(run_id: str) -> bool:
    return _launch_path(run_id).exists()


def drop_launch(run_id: str) -> None:
    _launch_path(run_id).unlink(missing_ok=True)


def queued_count(session: Session, namespace: str) -> int:
    return int(
        session.exec(
            select(func.count()).select_from(Run).where(Run.status == QUEUED, Run.namespace == namespace)
        ).one()
        or 0
    )


def user_active(session: Session, owner_user_id: str | None) -> int:
    if not owner_user_id:
        return 0
    return int(
        session.exec(
            select(func.count())
            .select_from(Run)
            .where(Run.owner_user_id == owner_user_id, Run.status.in_(ACTIVE))  # type: ignore[attr-defined]
        ).one()
        or 0
    )


def user_usage(session: Session, owner_user_id: str | None) -> dict[str, float]:
    """CPU cores, memory Gi and GPUs requested by one user's active runs and online services.

    `active` counts runs only: services are long-lived and limited by the resource quota instead.
    """
    from app.services.serving import ACTIVE_STATES, service_usage

    out = {"active": 0, "cpu": 0.0, "memory_gi": 0.0, "gpu": 0}
    if not owner_user_id:
        return out
    rows = session.exec(
        select(Run).where(Run.owner_user_id == owner_user_id, Run.status.in_(ACTIVE))  # type: ignore[attr-defined]
    ).all()
    for r in rows:
        out["active"] += 1
        out["cpu"] += _cores(r.cpu)
        out["memory_gi"] += _gi(r.memory)
        out["gpu"] += int(r.gpu_count or 0)
    services = session.exec(
        select(InferenceService).where(
            InferenceService.owner_user_id == owner_user_id,
            InferenceService.status.in_(ACTIVE_STATES),  # type: ignore[attr-defined]
        )
    ).all()
    for s in services:
        use = service_usage(s)
        out["cpu"] += use["cpu"]
        out["memory_gi"] += use["memory_gi"]
    out["cpu"] = round(out["cpu"], 3)
    out["memory_gi"] = round(out["memory_gi"], 3)
    return out


def _cores(cpu: str | None) -> float:
    try:
        return parse_cpu_cores(cpu or "0")
    except (ValueError, HTTPException):
        return 0.0


def _gi(memory: str | None) -> float:
    try:
        return parse_memory_gi(memory or "0")
    except (ValueError, HTTPException):
        return 0.0


def user_quota() -> dict[str, float]:
    """Per-user caps on active runs and their summed requests; 0 means no cap."""
    return {
        "active": settings.user_max_active,
        "cpu": settings.user_max_cpu,
        "memory_gi": settings.user_max_memory_gi,
        "gpu": settings.user_max_gpu,
    }


def check_user_quota(cpu: str, memory: str, gpu_count: int = 0) -> None:
    """A run that alone exceeds a user's quota would wait forever, so refuse it up front."""
    q = user_quota()
    for key, need, unit in (
        ("cpu", _cores(cpu), " cores"),
        ("memory_gi", _gi(memory), " Gi"),
        ("gpu", int(gpu_count or 0), " GPU"),
    ):
        if q[key] and need > q[key] + 1e-9:
            raise HTTPException(status_code=400, detail=f"exceeds the per-user quota ({q[key]:g}{unit})")


def check_service_fits(session: Session, owner_user_id: str | None, cpu: float, memory_gi: float) -> None:
    """Services do not queue: starting one must fit in what is left of the owner's quota now."""
    q = user_quota()
    used = user_usage(session, owner_user_id)
    for key, need, unit in (("cpu", cpu, " cores"), ("memory_gi", memory_gi, " Gi")):
        if q[key] and used[key] + need > q[key] + 1e-9:
            raise HTTPException(
                status_code=409,
                detail=f"not enough room in the per-user quota ({q[key]:g}{unit}); stop something first",
            )


def check_room(session: Session, namespace: str, count: int, active: int) -> None:
    """Reject only when the runs would neither start now nor fit in the queue."""
    overflow = max(0, active + count - settings.default_concurrency)
    if overflow and queued_count(session, namespace) + overflow > settings.max_queued:
        raise HTTPException(
            status_code=429,
            detail=f"queue is full ({settings.max_queued} waiting runs in namespace)",
        )


QUEUE_NAMESPACE = "namespace"
QUEUE_USER_ACTIVE = "user_active"
QUEUE_USER_QUOTA = "user_quota"
QUEUE_SCHEDULED = "scheduled"
SCHEDULE_MAX_AHEAD = timedelta(days=7)


def scheduled_later(run: Run, now: datetime | None = None) -> bool:
    return bool(run.not_before) and _aware(run.not_before) > (now or datetime.now(timezone.utc))


def check_start_at(start_at: datetime | None, now: datetime | None = None) -> datetime | None:
    """A scheduled start must be in the future and within a week; past times mean 'now'."""
    if start_at is None:
        return None
    now = now or datetime.now(timezone.utc)
    at = _aware(start_at).astimezone(timezone.utc)
    if at <= now:
        return None
    if at - now > SCHEDULE_MAX_AHEAD:
        raise HTTPException(status_code=400, detail="start_at must be within 7 days")
    return at


def wait_reason(session: Session, run: Run, active: int) -> str | None:
    """Why `run` cannot start now, or None when it can."""
    if scheduled_later(run):
        return QUEUE_SCHEDULED
    if active >= settings.default_concurrency:
        return QUEUE_NAMESPACE
    q = user_quota()
    if not (q["active"] or q["cpu"] or q["memory_gi"] or q["gpu"]):
        return None
    used = user_usage(session, run.owner_user_id)
    if q["active"] and used["active"] >= q["active"]:
        return QUEUE_USER_ACTIVE
    need = {"cpu": _cores(run.cpu), "memory_gi": _gi(run.memory), "gpu": int(run.gpu_count or 0)}
    for key, amount in need.items():
        if q[key] and used[key] + amount > q[key] + 1e-9:
            return QUEUE_USER_QUOTA
    return None


def has_slot(session: Session, run: Run, active: int) -> bool:
    return wait_reason(session, run, active) is None


def queue_position(session: Session, run: Run) -> int | None:
    """1-based place among runs competing for the same namespace; scheduled runs have none yet."""
    if run.status != QUEUED or scheduled_later(run):
        return None
    now = datetime.now(timezone.utc)
    prio = int(run.priority or 0)
    rivals = session.exec(
        select(Run).where(Run.status == QUEUED, Run.namespace == run.namespace, Run.id != run.id)
    ).all()
    ahead = sum(
        1
        for r in rivals
        if not scheduled_later(r, now)
        and (int(r.priority or 0), -_aware(r.created_at).timestamp()) > (prio, -_aware(run.created_at).timestamp())
    )
    return ahead + 1


def queued_runs(session: Session) -> list[Run]:
    """Dispatch order: priority first, then FIFO."""
    return list(
        session.exec(
            select(Run).where(Run.status == QUEUED).order_by(Run.priority.desc(), Run.created_at)  # type: ignore[union-attr]
        ).all()
    )


def queued_since(run: Run) -> datetime:
    """The queue timeout counts from when a run became eligible, not from a future scheduled start."""
    created = _aware(run.created_at)
    return max(created, _aware(run.not_before)) if run.not_before else created


def expire_stale(session: Session, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    limit = timedelta(seconds=settings.queue_timeout_seconds)
    n = 0
    for run in queued_runs(session):
        if now - queued_since(run) > limit:
            run.status = "cancelled"
            run.error_message = f"waited in queue longer than {settings.queue_timeout_seconds}s"
            run.finished_at = now
            run.updated_at = now
            session.add(run)
            drop_launch(run.id)
            n += 1
    if n:
        session.commit()
    return n
