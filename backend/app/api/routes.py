from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, get_current_user, require_admin
from app.api.schemas import (
    CiliKubeLinks,
    ClusterCreate,
    ClusterOut,
    LogsOut,
    PipelineCreate,
    PipelineOut,
    RunCreate,
    RunOut,
    SettingsOut,
    SettingsUpdate,
    TemplateOut,
)
from app.config import settings
from app.db import get_session
from app.models.entities import AppSettings, Cluster, Pipeline, Run
from app.services.artifacts import get_harvest_status, list_local_artifacts, read_local_artifact
from app.services.cilikube import build_cilikube_links, primary_cilikube_url
from app.services.cluster.direct import DirectKube
from app.services.gpu_probe import assert_cluster_has_gpu
from app.services.job_builder import (
    Guardrails,
    build_job,
    dumps_command,
    job_name_for,
    loads_command,
    validate_resources,
)
from app.services.metrics import build_metrics_view, compare_metrics
from app.services.pipeline import (
    PIPELINE_MOUNT,
    PIPELINE_OUTPUT,
    dumps,
    loads_ids,
    loads_steps,
    mark,
    pipeline_out,
    pvc_name_for,
)
from app.services.prom import (
    load_frozen_resource,
    pod_resource_series,
    prometheus_ready,
    save_frozen_resource,
)
from app.services.resource_buffer import push_sample, series_for as resource_series_for
from app.services.access import (
    can_access_pipeline,
    can_access_run,
    can_create_run,
    can_mutate_run,
    visible_cluster_ids,
)
from app.services.sync import sync_run

_TERMINAL = frozenset({"succeeded", "failed", "timeout", "cancelled"})


def _aware_ts(dt: datetime) -> float:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()

router = APIRouter(prefix="/api")


def _templates() -> list[dict]:
    path = Path(__file__).resolve().parents[1] / "templates" / "builtin.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _cluster_out(c: Cluster, *, admin: bool = False) -> ClusterOut:
    return ClusterOut(
        id=c.id,
        name=c.name,
        context=c.context,
        # Platform-held credentials: path only for admin
        kubeconfig_path=c.kubeconfig_path if admin else None,
        has_kubeconfig_content=bool(c.kubeconfig_content) if admin else False,
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
    pod_name = snap.get("pod_name")
    links = build_cilikube_links(
        base,
        namespace=run.namespace,
        job_name=run.job_name,
        pod_name=pod_name,
        pvc_name=run.pvc_name,
    )
    return RunOut(
        id=run.id,
        cluster_id=run.cluster_id,
        owner_user_id=run.owner_user_id,
        name=run.name,
        namespace=run.namespace,
        template=run.template,
        image=run.image,
        command=loads_command(run.command),
        args=loads_command(run.args),
        cpu=run.cpu,
        memory=run.memory,
        gpu_count=int(getattr(run, "gpu_count", 0) or 0),
        timeout_seconds=run.timeout_seconds,
        pvc_name=run.pvc_name,
        status=run.status,
        job_name=run.job_name,
        pod_name=pod_name,
        pod_phase=snap.get("pod_phase"),
        status_reason=snap.get("status_reason"),
        status_message=snap.get("status_message"),
        duration_seconds=_duration_seconds(run),
        error_message=run.error_message,
        job_yaml=run.job_yaml,
        created_at=run.created_at,
        updated_at=run.updated_at,
        finished_at=run.finished_at,
        cilikube_url=primary_cilikube_url(links),
        cilikube_links=CiliKubeLinks(**links),
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
def list_templates(cu: Annotated[CurrentUser, Depends(get_current_user)]) -> list[TemplateOut]:
    _ = cu
    return [TemplateOut(**t) for t in _templates()]


@router.get("/clusters", response_model=list[ClusterOut])
def list_clusters(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[ClusterOut]:
    rows = session.exec(select(Cluster).order_by(Cluster.created_at.desc())).all()
    allowed = visible_cluster_ids(session, cu.user)
    admin = cu.user.role == "admin"
    out = []
    for c in rows:
        if allowed is not None and c.id not in allowed:
            continue
        out.append(_cluster_out(c, admin=admin))
    return out


@router.post("/clusters", response_model=ClusterOut)
def create_cluster(
    body: ClusterCreate,
    cu: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> ClusterOut:
    _ = cu
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
    return _cluster_out(c, admin=True)


@router.delete("/clusters/{cluster_id}")
def delete_cluster(
    cluster_id: str,
    cu: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> dict[str, str]:
    _ = cu
    c = session.get(Cluster, cluster_id)
    if not c:
        raise HTTPException(status_code=404, detail="cluster not found")
    session.delete(c)
    session.commit()
    return {"status": "deleted"}


@router.get("/settings", response_model=SettingsOut)
def get_settings(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> SettingsOut:
    _ = cu
    row = session.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1)
        session.add(row)
        session.commit()
        session.refresh(row)
    return SettingsOut(
        cilikube_base_url=row.cilikube_base_url,
        cilikube_configured=bool(row.cilikube_base_url),
        max_gpu=settings.max_gpu,
    )


@router.put("/settings", response_model=SettingsOut)
def put_settings(
    body: SettingsUpdate,
    cu: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> SettingsOut:
    _ = cu
    row = session.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1)
    row.cilikube_base_url = body.cilikube_base_url
    session.add(row)
    session.commit()
    session.refresh(row)
    return SettingsOut(
        cilikube_base_url=row.cilikube_base_url,
        cilikube_configured=bool(row.cilikube_base_url),
        max_gpu=settings.max_gpu,
    )


@router.get("/runs", response_model=list[RunOut])
def list_runs(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[RunOut]:
    rows = session.exec(select(Run).order_by(Run.created_at.desc())).all()
    out: list[RunOut] = []
    for run in rows:
        if not can_access_run(session, cu.user, run):
            continue
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
def create_run(
    body: RunCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    cluster = session.get(Cluster, body.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")
    if not can_create_run(session, cu.user, body.cluster_id, body.namespace):
        raise HTTPException(status_code=403, detail="no grant for this cluster/namespace")

    guardrails = Guardrails(
        max_cpu=settings.max_cpu,
        max_memory_gi=settings.max_memory_gi,
        max_gpu=settings.max_gpu,
        default_timeout_seconds=settings.default_timeout_seconds,
    )
    gpu_count = int(body.gpu_count or 0)
    validate_resources(
        body.cpu,
        body.memory,
        body.timeout_seconds,
        guardrails,
        gpu_count=gpu_count,
    )
    kube = DirectKube(cluster)
    if gpu_count > 0:
        assert_cluster_has_gpu(kube, skip=settings.gpu_probe_skip)

    owner_id = None if cu.user.id == "dev-admin" else cu.user.id
    # When auth disabled, stamp first real admin if present
    if owner_id is None:
        from app.models.entities import User
        from sqlmodel import select as sel

        admin = session.exec(sel(User).where(User.role == "admin")).first()
        owner_id = admin.id if admin else "dev-admin"
    run = Run(
        cluster_id=body.cluster_id,
        owner_user_id=owner_id,
        name=body.name,
        namespace=body.namespace,
        template=body.template,
        image=body.image,
        command=dumps_command(body.command),
        args=dumps_command(body.args),
        cpu=body.cpu,
        memory=body.memory,
        gpu_count=gpu_count,
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
        gpu_count=gpu_count,
        pvc_name=run.pvc_name,
        pvc_mount_path=run.pvc_mount_path,
        output_path=run.output_path,
        hold_seconds=settings.hold_seconds,
        guardrails=guardrails,
    )
    run.job_name = job_name_for(run.id)
    run.job_yaml = yaml.safe_dump(job, sort_keys=False)
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
def get_run(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_access_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
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
def rerun_run(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    """Clone a finished/failed/cancelled run and submit a new Job (Kubeflow-style retry)."""
    src = session.get(Run, run_id)
    if not src:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_mutate_run(session, cu.user, src):
        raise HTTPException(status_code=403, detail="forbidden")
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
        gpu_count=int(getattr(src, "gpu_count", 0) or 0),
        timeout_seconds=src.timeout_seconds,
        pvc_name=src.pvc_name,
        pvc_mount_path=src.pvc_mount_path,
        output_path=src.output_path,
    )
    return create_run(body, cu, session)


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
def cancel_run(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    """Stop a pending/running training Job (delete Job + pods), mark cancelled.

    Aligns with Kubeflow training-client delete_job / console Stop actions.
    """
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_mutate_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
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
def delete_run(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Remove run metadata; also delete leftover Job if still present (best effort)."""
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_mutate_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
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
def get_logs(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> LogsOut:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_access_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
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


@router.get("/runs/{run_id}/artifacts")
def get_artifacts(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_access_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
    # try harvest if succeeded
    cluster = session.get(Cluster, run.cluster_id)
    if cluster and run.status == "succeeded":
        try:
            kube = DirectKube(cluster)
            run, _ = sync_run(session, run, kube)
        except HTTPException:
            pass
    return {
        "run_id": run_id,
        "items": list_local_artifacts(run_id),
        "harvest": get_harvest_status(run_id),
    }


@router.get("/runs/{run_id}/artifacts/file")
def get_artifact_file(
    run_id: str,
    path: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
):
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_access_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
    try:
        fp = read_local_artifact(run_id, path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="artifact not found") from exc
    return FileResponse(fp, filename=fp.name)


def _node_resource_summary(mapi) -> list[dict]:
    try:
        nodes = mapi.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
    except Exception:  # noqa: BLE001
        return []
    out = []
    for item in (nodes.get("items") or [])[:8]:
        name = (item.get("metadata") or {}).get("name")
        usage = item.get("usage") or {}
        cpu_cores = _parse_cpu_cores(usage.get("cpu"))
        mem_mi = _parse_mem_mi(usage.get("memory"))
        out.append(
            {
                "name": name,
                "cpu": f"{cpu_cores * 1000:.0f}m" if cpu_cores is not None else usage.get("cpu"),
                "memory": f"{mem_mi:.0f}Mi" if mem_mi is not None else usage.get("memory"),
            }
        )
    return out


def _fetch_pod_metrics(mapi, namespace: str, pod_name: str) -> dict | None:
    try:
        return mapi.get_namespaced_custom_object(
            "metrics.k8s.io",
            "v1beta1",
            namespace,
            "pods",
            pod_name,
        )
    except Exception:  # noqa: BLE001
        pass
    # Fallback: list namespace pod metrics and match by name (same scrape window)
    try:
        listed = mapi.list_namespaced_custom_object(
            "metrics.k8s.io",
            "v1beta1",
            namespace,
            "pods",
        )
        for item in listed.get("items") or []:
            if (item.get("metadata") or {}).get("name") == pod_name:
                return item
    except Exception:  # noqa: BLE001
        return None
    return None


def _sum_container_usage(pod_m: dict) -> tuple[float | None, float | None]:
    cpu_total = 0.0
    mem_total = 0.0
    saw_cpu = False
    saw_mem = False
    for c in pod_m.get("containers") or []:
        usage = c.get("usage") or {}
        cpu = _parse_cpu_cores(usage.get("cpu"))
        mem = _parse_mem_mi(usage.get("memory"))
        if cpu is not None:
            cpu_total += cpu
            saw_cpu = True
        if mem is not None:
            mem_total += mem
            saw_mem = True
    return (cpu_total if saw_cpu else None, mem_total if saw_mem else None)


def _parse_cpu_cores(raw: str | None) -> float | None:
    if not raw:
        return None
    s = str(raw)
    try:
        if s.endswith("n"):
            return int(s[:-1]) / 1_000_000_000
        if s.endswith("u"):
            return int(s[:-1]) / 1_000_000
        if s.endswith("m"):
            return int(s[:-1]) / 1000
        return float(s)
    except ValueError:
        return None


def _parse_mem_mi(raw: str | None) -> float | None:
    if not raw:
        return None
    s = str(raw)
    try:
        if s.endswith("Ki"):
            return int(s[:-2]) / 1024
        if s.endswith("Mi"):
            return float(s[:-2])
        if s.endswith("Gi"):
            return float(s[:-2]) * 1024
        if s.endswith("Ti"):
            return float(s[:-2]) * 1024 * 1024
        return int(s) / (1024 * 1024)
    except ValueError:
        return None


@router.get("/runs/{run_id}/metrics")
def get_metrics(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_access_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
    logs = ""
    cluster = session.get(Cluster, run.cluster_id)
    terminal = run.status in _TERMINAL
    monitor: dict = {
        "available": False,
        "message": "metrics-server not installed; showing training metrics only",
    }

    # Finished runs: prefer frozen historical series (stops chart drift / node flicker)
    frozen = load_frozen_resource(run_id) if terminal else None
    if frozen:
        series = frozen["series"]
        # Older freezes may lack wall-clock ts; reconstruct from run start + relative t
        if series and run.created_at is not None and not any(
            isinstance(p, dict) and p.get("ts") for p in series
        ):
            origin = _aware_ts(run.created_at)
            series = [
                {**p, "ts": origin + float(p.get("t") or 0)} if isinstance(p, dict) else p
                for p in series
            ]
        monitor = {
            "available": True,
            "pending": False,
            "cpu": None,
            "memory": None,
            "pod_name": frozen.get("pod_name"),
            "series": series,
            "series_source": frozen.get("series_source") or "prometheus",
            "prometheus": frozen.get("series_source") == "prometheus",
            "frozen": True,
            "message": "resource_history_frozen",
        }

    if cluster:
        try:
            kube = DirectKube(cluster)
            from kubernetes.client import CustomObjectsApi

            mapi = CustomObjectsApi(kube._api_client)
            server_ok = False
            try:
                mapi.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
                server_ok = True
            except Exception:  # noqa: BLE001
                server_ok = False

            run, snap = sync_run(session, run, kube)
            terminal = run.status in _TERMINAL
            pod_name = snap.get("pod_name") or (frozen or {}).get("pod_name")

            if pod_name:
                try:
                    logs = kube.pod_logs(run.namespace, pod_name, tail=400)
                except Exception:  # noqa: BLE001
                    logs = ""

            if frozen:
                # Still refresh logs/artifacts via build_metrics_view; skip live resource polls
                pass
            elif pod_name:
                if server_ok and not terminal:
                    pod_m = _fetch_pod_metrics(mapi, run.namespace, pod_name)
                    if pod_m:
                        cpu_cores, mem_mi = _sum_container_usage(pod_m)
                        push_sample(run_id, cpu_cores=cpu_cores, memory_mi=mem_mi)
                        monitor = {
                            "available": True,
                            "pending": False,
                            "cpu": f"{cpu_cores * 1000:.0f}m" if cpu_cores is not None else None,
                            "memory": f"{mem_mi:.0f}Mi" if mem_mi is not None else None,
                            "cpu_cores": cpu_cores,
                            "memory_mi": mem_mi,
                            "pod_name": pod_name,
                            "message": None,
                        }
                    else:
                        phase = (snap.get("pod_phase") or "").lower()
                        waiting = phase == "running" or run.status == "running"
                        monitor = {
                            "available": True,
                            "pending": waiting,
                            "cpu": None,
                            "memory": None,
                            "pod_name": pod_name,
                            # Only show cluster nodes while waiting for first pod scrape
                            "nodes": _node_resource_summary(mapi) if waiting else [],
                            "message": (
                                "waiting_for_pod_scrape"
                                if waiting
                                else "pod_finished_no_live_metrics"
                            ),
                        }
                elif server_ok and terminal:
                    monitor = {
                        "available": True,
                        "pending": False,
                        "cpu": None,
                        "memory": None,
                        "pod_name": pod_name,
                        "message": "pod_finished_no_live_metrics",
                    }
                else:
                    monitor = {
                        "available": False,
                        "pod_name": pod_name,
                        "message": "metrics-server not installed; showing training metrics only",
                    }

                start_ts = _aware_ts(run.created_at)
                end_ts = None
                if run.finished_at:
                    end_ts = _aware_ts(run.finished_at)
                elif terminal:
                    end_ts = _aware_ts(run.updated_at)

                prom = pod_resource_series(
                    run.namespace,
                    pod_name,
                    start_ts=start_ts if terminal else None,
                    end_ts=end_ts,
                    t0=start_ts,
                )
                if prom.get("series"):
                    monitor["series"] = prom["series"]
                    monitor["series_source"] = "prometheus"
                    monitor["prometheus"] = True
                    if terminal:
                        save_frozen_resource(
                            run_id,
                            series=prom["series"],
                            source="prometheus",
                            pod_name=pod_name,
                        )
                        monitor["frozen"] = True
                        monitor["message"] = "resource_history_frozen"
                else:
                    buf = resource_series_for(run_id)
                    if buf:
                        monitor["series"] = buf
                        monitor["series_source"] = "metrics-server"
                        if terminal:
                            save_frozen_resource(
                                run_id,
                                series=buf,
                                source="metrics-server",
                                pod_name=pod_name,
                            )
                            monitor["frozen"] = True
                            monitor["message"] = "resource_history_frozen"
                    monitor["prometheus"] = prometheus_ready()
            elif server_ok and not terminal:
                monitor = {
                    "available": True,
                    "nodes": _node_resource_summary(mapi),
                    "message": "metrics-server ready; no live pod yet",
                    "prometheus": prometheus_ready(),
                }
        except HTTPException:
            pass
    view = build_metrics_view(run_id, logs=logs)
    view["run_id"] = run_id
    view["status"] = run.status
    view["name"] = run.name
    view["resource"] = monitor
    return view


@router.get("/compare/runs")
def compare_runs(
    ids: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict:
    """Compare up to 4 runs: ?ids=id1,id2"""
    run_ids = [x.strip() for x in ids.split(",") if x.strip()][:4]
    if len(run_ids) < 2:
        raise HTTPException(status_code=400, detail="provide at least 2 run ids")
    views: list[tuple[str, dict]] = []
    runs_meta = []
    for rid in run_ids:
        run = session.get(Run, rid)
        if not run:
            raise HTTPException(status_code=404, detail=f"run not found: {rid}")
        if not can_access_run(session, cu.user, run):
            raise HTTPException(status_code=403, detail=f"forbidden: {rid}")
        logs = ""
        cluster = session.get(Cluster, run.cluster_id)
        if cluster:
            try:
                kube = DirectKube(cluster)
                run, snap = sync_run(session, run, kube)
                if snap.get("pod_name"):
                    logs = kube.pod_logs(run.namespace, snap["pod_name"], tail=400)
            except HTTPException:
                pass
        view = build_metrics_view(rid, logs=logs)
        views.append((rid, view))
        runs_meta.append(
            {
                "id": run.id,
                "name": run.name,
                "status": run.status,
                "template": run.template,
                "duration_seconds": _duration_seconds(run),
                "image": run.image,
                "cpu": run.cpu,
                "memory": run.memory,
            }
        )
    return {"runs": runs_meta, "comparison": compare_metrics(views), "metrics": {rid: v for rid, v in views}}


def _submit_step(
    session: Session, pipeline: Pipeline, step: dict, step_idx: int, cu: CurrentUser
) -> RunOut:
    body = RunCreate(
        cluster_id=pipeline.cluster_id,
        name=f"{pipeline.name}-s{step_idx + 1}-{step.get('name', 'step')}"[:63],
        namespace=pipeline.namespace,
        template=step.get("template") or "custom",
        image=step["image"],
        command=step.get("command") or [],
        args=step.get("args") or [],
        cpu=step.get("cpu") or "500m",
        memory=step.get("memory") or "512Mi",
        gpu_count=int(step.get("gpu_count") or 0),
        timeout_seconds=int(step.get("timeout_seconds") or 1800),
        pvc_name=pipeline.pvc_name,
        pvc_mount_path=PIPELINE_MOUNT,
        output_path=PIPELINE_OUTPUT,
    )
    return create_run(body, cu, session)


def _advance_pipeline(session: Session, pipeline: Pipeline, cu: CurrentUser) -> Pipeline:
    if pipeline.status in ("succeeded", "failed", "cancelled"):
        return pipeline
    steps = loads_steps(pipeline.steps_json)
    run_ids = loads_ids(pipeline.run_ids_json)
    if not steps:
        return mark(session, pipeline, status="failed", error_message="empty steps")

    if not run_ids:
        out = _submit_step(session, pipeline, steps[0], 0, cu)
        run_ids = [out.id]
        return mark(
            session,
            pipeline,
            status="running",
            current_step=0,
            run_ids_json=dumps(run_ids),
        )

    current_id = run_ids[-1]
    run = session.get(Run, current_id)
    if not run:
        return mark(session, pipeline, status="failed", error_message="missing step run")
    cluster = session.get(Cluster, run.cluster_id)
    if cluster:
        try:
            kube = DirectKube(cluster)
            run, _ = sync_run(session, run, kube)
        except HTTPException as exc:
            return mark(session, pipeline, status="failed", error_message=str(exc.detail))

    if run.status in ("pending", "running"):
        return mark(session, pipeline, status="running", current_step=len(run_ids) - 1)

    if run.status in ("failed", "timeout", "cancelled"):
        return mark(
            session,
            pipeline,
            status="failed",
            error_message=run.error_message or f"step failed: {run.status}",
            finished_at=datetime.now(timezone.utc),
        )

    if run.status == "succeeded":
        next_idx = len(run_ids)
        if next_idx >= len(steps):
            return mark(
                session,
                pipeline,
                status="succeeded",
                current_step=next_idx - 1,
                finished_at=datetime.now(timezone.utc),
            )
        out = _submit_step(session, pipeline, steps[next_idx], next_idx, cu)
        run_ids.append(out.id)
        return mark(
            session,
            pipeline,
            status="running",
            current_step=next_idx,
            run_ids_json=dumps(run_ids),
        )
    return pipeline


@router.get("/pipelines", response_model=list[PipelineOut])
def list_pipelines(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[PipelineOut]:
    rows = session.exec(select(Pipeline).order_by(Pipeline.created_at.desc())).all()
    out = []
    for p in rows:
        if not can_access_pipeline(session, cu.user, p):
            continue
        p = _advance_pipeline(session, p, cu)
        out.append(PipelineOut(**pipeline_out(p)))
    return out


@router.post("/pipelines", response_model=PipelineOut)
def create_pipeline(
    body: PipelineCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> PipelineOut:
    cluster = session.get(Cluster, body.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")
    if not can_create_run(session, cu.user, body.cluster_id, body.namespace):
        raise HTTPException(status_code=403, detail="no grant for this cluster/namespace")
    steps = [s.model_dump() for s in body.steps]
    owner_id = None if cu.user.id == "dev-admin" else cu.user.id
    if owner_id is None:
        from app.models.entities import User
        from sqlmodel import select as sel

        admin = session.exec(sel(User).where(User.role == "admin")).first()
        owner_id = admin.id if admin else "dev-admin"
    p = Pipeline(
        name=body.name,
        cluster_id=body.cluster_id,
        owner_user_id=owner_id,
        namespace=body.namespace,
        status="pending",
        current_step=0,
        steps_json=dumps(steps),
        run_ids_json="[]",
    )
    session.add(p)
    session.commit()
    session.refresh(p)

    # B1: provision shared PVC before first step
    pvc = pvc_name_for(p.id)
    try:
        kube = DirectKube(cluster)
        kube.create_pvc(
            body.namespace,
            pvc,
            size="1Gi",
            labels={
                "cilitrain.io/managed-by": "cilitrain",
                "cilitrain.io/pipeline": p.id,
            },
        )
    except HTTPException as exc:
        p = mark(
            session,
            p,
            status="failed",
            error_message=f"shared PVC create failed: {exc.detail}",
            finished_at=datetime.now(timezone.utc),
        )
        return PipelineOut(**pipeline_out(p))

    p = mark(session, p, pvc_name=pvc)
    p = _advance_pipeline(session, p, cu)
    return PipelineOut(**pipeline_out(p))


@router.get("/pipelines/{pipeline_id}", response_model=PipelineOut)
def get_pipeline(
    pipeline_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> PipelineOut:
    p = session.get(Pipeline, pipeline_id)
    if not p:
        raise HTTPException(status_code=404, detail="pipeline not found")
    if not can_access_pipeline(session, cu.user, p):
        raise HTTPException(status_code=403, detail="forbidden")
    p = _advance_pipeline(session, p, cu)
    return PipelineOut(**pipeline_out(p))


@router.post("/pipelines/{pipeline_id}/cancel", response_model=PipelineOut)
def cancel_pipeline(
    pipeline_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> PipelineOut:
    p = session.get(Pipeline, pipeline_id)
    if not p:
        raise HTTPException(status_code=404, detail="pipeline not found")
    if not can_access_pipeline(session, cu.user, p) or cu.user.role == "viewer":
        raise HTTPException(status_code=403, detail="forbidden")
    if p.status in ("succeeded", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail="pipeline already terminal")
    ids = loads_ids(p.run_ids_json)
    if ids:
        try:
            cancel_run(ids[-1], cu, session)
        except HTTPException:
            pass
    p = mark(
        session,
        p,
        status="cancelled",
        error_message="cancelled by user",
        finished_at=datetime.now(timezone.utc),
    )
    return PipelineOut(**pipeline_out(p))
