"""Sync run status from Kubernetes Job/Pod."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session

from app.models.entities import Run
from app.services.artifacts import collect_from_pod, list_local_artifacts, metrics_path
from app.services.cluster.direct import DirectKube
from app.services.metrics import parse_log_metrics, save_metrics


def derive_status(job: Any, snap: dict[str, Any]) -> tuple[str, str | None]:
    """Return (status, error_message)."""
    st = job.status if job is not None else None
    if st:
        if (st.succeeded or 0) >= 1:
            return "succeeded", None
        if (st.failed or 0) >= 1:
            # activeDeadlineSeconds often surfaces as DeadlineExceeded
            cond_reasons = []
            for c in st.conditions or []:
                if c.type == "Failed":
                    cond_reasons.append(c.reason or c.message or "Failed")
            reason = ", ".join(cond_reasons) or "job failed"
            status = "timeout" if "DeadlineExceeded" in reason else "failed"
            return status, reason

    phase = (snap.get("pod_phase") or "").lower()
    reason = snap.get("status_reason") or ""
    if reason in {"ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "CreateContainerConfigError"}:
        return "failed", snap.get("status_message") or reason
    if phase == "pending" or reason in {"ContainerCreating", "PodInitializing", "WaitingForPod"}:
        return "pending", None
    if phase == "succeeded":
        return "succeeded", None
    if phase == "failed":
        return "failed", snap.get("status_message") or reason or "pod failed"
    if phase == "running" or (st and (st.active or 0) >= 1):
        return "running", None
    if st and (st.active or 0) >= 1:
        return "running", None
    return "pending", None


TERMINAL = frozenset({"succeeded", "failed", "timeout", "cancelled"})


def sync_run(session: Session, run: Run, kube: DirectKube) -> tuple[Run, dict[str, Any]]:
    snap: dict[str, Any] = {
        "pod_name": None,
        "pod_phase": None,
        "status_reason": None,
        "status_message": None,
    }
    if not run.job_name:
        return run, snap

    # User-cancelled runs stay cancelled even if Job is already gone.
    if run.status == "cancelled":
        try:
            snap = kube.pod_snapshot(run.namespace, run.id)
        except Exception:  # noqa: BLE001
            pass
        return run, snap

    job = kube.get_job(run.namespace, run.job_name)
    if job is None:
        if run.status not in TERMINAL:
            run.status = "failed"
            run.error_message = run.error_message or "job not found in cluster"
            run.updated_at = datetime.now(timezone.utc)
            session.add(run)
            session.commit()
            session.refresh(run)
        return run, snap

    snap = kube.pod_snapshot(run.namespace, run.id)
    new_status, err = derive_status(job, snap)

    changed = False
    if new_status != run.status:
        run.status = new_status
        changed = True
    if err and err != run.error_message:
        run.error_message = err
        changed = True
    if changed:
        run.updated_at = datetime.now(timezone.utc)
        if new_status in ("succeeded", "failed", "timeout"):
            run.finished_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()
        session.refresh(run)

    # Harvest while Running (Completed pods cannot exec). Templates sleep briefly after write.
    if run.status in ("running", "succeeded") and snap.get("pod_name"):
        phase = (snap.get("pod_phase") or "").lower()
        can_exec = phase == "running" or run.status == "running"
        if can_exec:
            try:
                collect_from_pod(
                    kube,
                    run_id=run.id,
                    namespace=run.namespace,
                    pod_name=snap["pod_name"],
                    output_path=run.output_path or "/output",
                )
            except Exception:  # noqa: BLE001
                pass

        # Always refresh metrics from logs + any collected metrics.json
        try:
            mp = metrics_path(run.id)
            art = None
            for item in list_local_artifacts(run.id):
                if item["path"].endswith("metrics.json"):
                    from app.services.artifacts import read_local_artifact

                    art = json.loads(
                        read_local_artifact(run.id, item["path"]).read_text(encoding="utf-8")
                    )
                    break
            if art:
                save_metrics(run.id, art if isinstance(art, dict) else {"value": art})
            logs = ""
            try:
                logs = kube.pod_logs(run.namespace, snap["pod_name"], tail=300)
            except Exception:  # noqa: BLE001
                pass
            series = parse_log_metrics(logs)
            if series and (not mp.exists() or run.status == "running"):
                last = series[-1]
                save_metrics(
                    run.id,
                    {
                        **{k: v for k, v in last.items() if k != "epoch"},
                        "history": series,
                    },
                )
        except Exception:  # noqa: BLE001
            pass

    return run, snap
