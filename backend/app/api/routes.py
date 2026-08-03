from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.api.schemas import (
    ClusterCreate,
    ClusterOut,
    LogsOut,
    RunCreate,
    RunOut,
    SettingsOut,
    SettingsUpdate,
    TemplateOut,
)
from app.config import settings
from app.db import get_session
from app.models.entities import AppSettings, Cluster, Run
from app.services.cilikube import job_deep_link
from app.services.cluster.direct import DirectKube
from app.services.job_builder import Guardrails, build_job, dumps_command, job_name_for, loads_command
from app.services.sync import sync_run

router = APIRouter(prefix="/api")


def _templates() -> list[dict]:
    path = Path(__file__).resolve().parents[1] / "templates" / "builtin.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _cluster_out(c: Cluster) -> ClusterOut:
    return ClusterOut(
        id=c.id,
        name=c.name,
        context=c.context,
        kubeconfig_path=c.kubeconfig_path,
        has_kubeconfig_content=bool(c.kubeconfig_content),
        cilikube_base_url=c.cilikube_base_url,
        created_at=c.created_at,
    )


def _duration_seconds(run: Run) -> int | None:
    start = run.created_at
    if start is None:
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    end = run.finished_at or datetime.now(timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return max(0, int((end - start).total_seconds()))


def _run_out(
    run: Run,
    cilikube_base: str | None = None,
    events: list[str] | None = None,
    snap: dict | None = None,
) -> RunOut:
    base = cilikube_base
    snap = snap or {}
    return RunOut(
        id=run.id,
        cluster_id=run.cluster_id,
        name=run.name,
        namespace=run.namespace,
        template=run.template,
        image=run.image,
        command=loads_command(run.command),
        args=loads_command(run.args),
        cpu=run.cpu,
        memory=run.memory,
        timeout_seconds=run.timeout_seconds,
        pvc_name=run.pvc_name,
        status=run.status,
        job_name=run.job_name,
        pod_name=snap.get("pod_name"),
        pod_phase=snap.get("pod_phase"),
        status_reason=snap.get("status_reason"),
        status_message=snap.get("status_message"),
        duration_seconds=_duration_seconds(run),
        error_message=run.error_message,
        job_yaml=run.job_yaml,
        created_at=run.created_at,
        updated_at=run.updated_at,
        finished_at=run.finished_at,
        cilikube_url=job_deep_link(base, run.namespace, run.job_name or "") if run.job_name else None,
        events=events or [],
    )


def _resolve_cilikube(session: Session, cluster: Cluster) -> str | None:
    if cluster.cilikube_base_url:
        return cluster.cilikube_base_url
    row = session.get(AppSettings, 1)
    return row.cilikube_base_url if row else None


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "cilitrain"}


@router.get("/templates", response_model=list[TemplateOut])
def list_templates() -> list[TemplateOut]:
    return [TemplateOut(**t) for t in _templates()]


@router.get("/clusters", response_model=list[ClusterOut])
def list_clusters(session: Session = Depends(get_session)) -> list[ClusterOut]:
    rows = session.exec(select(Cluster).order_by(Cluster.created_at.desc())).all()
    return [_cluster_out(c) for c in rows]


@router.post("/clusters", response_model=ClusterOut)
def create_cluster(body: ClusterCreate, session: Session = Depends(get_session)) -> ClusterOut:
    if not body.kubeconfig_path and not body.kubeconfig_content:
        raise HTTPException(status_code=400, detail="kubeconfig_path or kubeconfig_content required")
    c = Cluster(
        name=body.name,
        kubeconfig_path=body.kubeconfig_path,
        kubeconfig_content=body.kubeconfig_content,
        context=body.context,
        cilikube_base_url=body.cilikube_base_url,
    )
    # validate load
    DirectKube(c)
    session.add(c)
    session.commit()
    session.refresh(c)
    return _cluster_out(c)


@router.delete("/clusters/{cluster_id}")
def delete_cluster(cluster_id: str, session: Session = Depends(get_session)) -> dict[str, str]:
    c = session.get(Cluster, cluster_id)
    if not c:
        raise HTTPException(status_code=404, detail="cluster not found")
    session.delete(c)
    session.commit()
    return {"status": "deleted"}


@router.get("/settings", response_model=SettingsOut)
def get_settings(session: Session = Depends(get_session)) -> SettingsOut:
    row = session.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1)
        session.add(row)
        session.commit()
        session.refresh(row)
    return SettingsOut(cilikube_base_url=row.cilikube_base_url)


@router.put("/settings", response_model=SettingsOut)
def put_settings(body: SettingsUpdate, session: Session = Depends(get_session)) -> SettingsOut:
    row = session.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1)
    row.cilikube_base_url = body.cilikube_base_url
    session.add(row)
    session.commit()
    session.refresh(row)
    return SettingsOut(cilikube_base_url=row.cilikube_base_url)


@router.get("/runs", response_model=list[RunOut])
def list_runs(session: Session = Depends(get_session)) -> list[RunOut]:
    rows = session.exec(select(Run).order_by(Run.created_at.desc())).all()
    out: list[RunOut] = []
    for run in rows:
        cluster = session.get(Cluster, run.cluster_id)
        snap: dict = {}
        if cluster:
            try:
                kube = DirectKube(cluster)
                run, snap = sync_run(session, run, kube)
            except HTTPException:
                pass
        base = _resolve_cilikube(session, cluster) if cluster else None
        out.append(_run_out(run, base, snap=snap))
    return out


@router.post("/runs", response_model=RunOut)
def create_run(body: RunCreate, session: Session = Depends(get_session)) -> RunOut:
    cluster = session.get(Cluster, body.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")

    guardrails = Guardrails(
        max_cpu=settings.max_cpu,
        max_memory_gi=settings.max_memory_gi,
        default_timeout_seconds=settings.default_timeout_seconds,
    )
    run = Run(
        cluster_id=body.cluster_id,
        name=body.name,
        namespace=body.namespace,
        template=body.template,
        image=body.image,
        command=dumps_command(body.command),
        args=dumps_command(body.args),
        cpu=body.cpu,
        memory=body.memory,
        timeout_seconds=body.timeout_seconds,
        pvc_name=body.pvc_name,
        pvc_mount_path=body.pvc_mount_path,
        output_path=body.output_path,
        status="pending",
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    job = build_job(
        run_id=run.id,
        name=run.name,
        namespace=run.namespace,
        template=run.template,
        image=run.image,
        command=body.command,
        args=body.args,
        cpu=run.cpu,
        memory=run.memory,
        timeout_seconds=run.timeout_seconds,
        pvc_name=run.pvc_name,
        pvc_mount_path=run.pvc_mount_path,
        output_path=run.output_path,
        guardrails=guardrails,
    )
    run.job_name = job_name_for(run.id)
    run.job_yaml = yaml.safe_dump(job, sort_keys=False)

    kube = DirectKube(cluster)
    active = kube.count_active_jobs(run.namespace)
    if active >= settings.default_concurrency:
        run.status = "failed"
        run.error_message = f"concurrency limit ({settings.default_concurrency}) reached in namespace"
        run.updated_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()
        session.refresh(run)
        raise HTTPException(status_code=429, detail=run.error_message)

    try:
        kube.create_job(job)
        run.status = "pending"
        run.updated_at = datetime.now(timezone.utc)
    except HTTPException as exc:
        run.status = "failed"
        run.error_message = str(exc.detail)
        run.updated_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()
        raise

    session.add(run)
    session.commit()
    session.refresh(run)
    run, snap = sync_run(session, run, kube)
    return _run_out(run, _resolve_cilikube(session, cluster), snap=snap)


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(run_id: str, session: Session = Depends(get_session)) -> RunOut:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    cluster = session.get(Cluster, run.cluster_id)
    events: list[str] = []
    snap: dict = {}
    if cluster:
        try:
            kube = DirectKube(cluster)
            run, snap = sync_run(session, run, kube)
            if run.job_name:
                events = kube.list_events(run.namespace, run.job_name)
                if snap.get("pod_name"):
                    events = events + kube.list_events(run.namespace, snap["pod_name"])
        except HTTPException:
            pass
    base = _resolve_cilikube(session, cluster) if cluster else None
    return _run_out(run, base, events, snap=snap)


@router.post("/runs/{run_id}/rerun", response_model=RunOut)
def rerun_run(run_id: str, session: Session = Depends(get_session)) -> RunOut:
    """Clone a finished/failed/cancelled run and submit a new Job (Kubeflow-style retry)."""
    src = session.get(Run, run_id)
    if not src:
        raise HTTPException(status_code=404, detail="run not found")
    if src.status in ("pending", "running"):
        raise HTTPException(status_code=409, detail="cannot rerun an active job; stop it first")
    body = RunCreate(
        cluster_id=src.cluster_id,
        name=f"{src.name}-rerun",
        namespace=src.namespace,
        template=src.template,
        image=src.image,
        command=loads_command(src.command),
        args=loads_command(src.args),
        cpu=src.cpu,
        memory=src.memory,
        timeout_seconds=src.timeout_seconds,
        pvc_name=src.pvc_name,
        pvc_mount_path=src.pvc_mount_path,
        output_path=src.output_path,
    )
    return create_run(body, session)


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
def cancel_run(run_id: str, session: Session = Depends(get_session)) -> RunOut:
    """Stop a pending/running training Job (delete Job + pods), mark cancelled.

    Aligns with Kubeflow training-client delete_job / console Stop actions.
    """
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if run.status in ("succeeded", "failed", "timeout", "cancelled"):
        raise HTTPException(
            status_code=409,
            detail=f"run already terminal ({run.status}); use delete to remove the record",
        )
    cluster = session.get(Cluster, run.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")

    kube = DirectKube(cluster)
    if run.job_name:
        # Prefer hard stop: delete Job (cascade pods). Suspend alone can leave orphan state.
        kube.delete_job(run.namespace, run.job_name)

    run.status = "cancelled"
    run.error_message = run.error_message or "cancelled by user"
    run.finished_at = datetime.now(timezone.utc)
    run.updated_at = datetime.now(timezone.utc)
    session.add(run)
    session.commit()
    session.refresh(run)
    snap = kube.pod_snapshot(run.namespace, run.id)
    return _run_out(run, _resolve_cilikube(session, cluster), snap=snap)


@router.delete("/runs/{run_id}")
def delete_run(run_id: str, session: Session = Depends(get_session)) -> dict[str, str]:
    """Remove run metadata; also delete leftover Job if still present (best effort)."""
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if run.status in ("pending", "running"):
        raise HTTPException(
            status_code=409,
            detail="stop the run first (cancel), then delete the record",
        )
    cluster = session.get(Cluster, run.cluster_id)
    if cluster and run.job_name:
        try:
            DirectKube(cluster).delete_job(run.namespace, run.job_name)
        except HTTPException:
            pass
    session.delete(run)
    session.commit()
    return {"status": "deleted"}


@router.get("/runs/{run_id}/logs", response_model=LogsOut)
def get_logs(run_id: str, session: Session = Depends(get_session)) -> LogsOut:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    cluster = session.get(Cluster, run.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")
    kube = DirectKube(cluster)
    snap = kube.pod_snapshot(run.namespace, run.id)
    name = snap.get("pod_name")
    if not name:
        return LogsOut(pod_name=None, logs="(尚无 Pod，任务可能仍在调度)")
    text = kube.pod_logs(run.namespace, name)
    if not text.strip():
        reason = snap.get("status_reason") or snap.get("pod_phase") or "unknown"
        text = (
            f"(暂无日志输出 · Pod={name} · phase={snap.get('pod_phase')} · "
            f"reason={reason})\n"
            "提示：镜像拉取或 pip 安装阶段可能长时间无 stdout；新任务模板已加入进度 echo。"
        )
    return LogsOut(pod_name=name, logs=text)
