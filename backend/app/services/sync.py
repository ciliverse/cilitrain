"""Sync run status from Kubernetes Job/Pod."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session

from app.models.entities import Run
from app.services.cluster.direct import DirectKube


def sync_run(session: Session, run: Run, kube: DirectKube) -> Run:
    if not run.job_name:
        return run
    job = kube.get_job(run.namespace, run.job_name)
    if job is None:
        if run.status not in ("failed", "succeeded"):
            run.status = "failed"
            run.error_message = run.error_message or "job not found in cluster"
            run.updated_at = datetime.now(timezone.utc)
            session.add(run)
            session.commit()
            session.refresh(run)
        return run

    st = job.status
    new_status = run.status
    if st:
        if (st.succeeded or 0) >= 1:
            new_status = "succeeded"
        elif (st.failed or 0) >= 1:
            new_status = "failed"
            run.error_message = run.error_message or "job failed"
        elif (st.active or 0) >= 1:
            new_status = "running"
        else:
            # pending / unknown
            pods = kube.list_job_pods(run.namespace, run.id)
            if any(p.status and p.status.phase == "Pending" for p in pods):
                new_status = "pending"
            elif pods:
                new_status = "running"

    if new_status != run.status:
        run.status = new_status
        run.updated_at = datetime.now(timezone.utc)
        if new_status in ("succeeded", "failed", "timeout"):
            run.finished_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()
        session.refresh(run)
    return run
