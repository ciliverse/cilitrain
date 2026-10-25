from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, get_current_user, require_admin
from app.api.schemas import (
    CiliKubeLinks,
    CleanupOut,
    ClusterCreate,
    ClusterOut,
    ClusterProbeOut,
    LogsOut,
    PipelineCreate,
    PipelineOut,
    PriorityUpdate,
    RunCreate,
    RunOut,
    SchedulerItem,
    SchedulerNamespace,
    SchedulerOut,
    SettingsOut,
    SweepCreate,
    SweepOut,
    SettingsUpdate,
    TemplateOut,
)
from app.config import settings
from sqlalchemy.orm import object_session

from app.db import get_session
from app.models.entities import AppSettings, Cluster, ClusterGrant, InferenceService, ModelVersion, Pipeline, Run
from app.services.inference import infer_spec, load_batch_inputs, read_prediction
from app.services.models import model_label
from app.services.artifacts import get_harvest_status, list_local_artifacts, read_local_artifact
from app.services.cilikube import build_cilikube_links, primary_cilikube_url
from app.services.cluster.direct import DirectKube, KUBE_READ_TIMEOUT
from app.services.gpu_probe import assert_cluster_has_gpu, count_allocatable_gpu
from app.services.job_builder import (
    SCRIPT_MOUNT_PATH,
    Guardrails,
    build_job,
    build_script_configmap,
    dumps_command,
    job_name_for,
    loads_command,
    script_configmap_name,
    validate_resources,
)
from app.services.metrics import build_metrics_view, compare_metrics, trend_from_view
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
from app.services.run_logs import absorb_logs, load_run_logs
from app.services.showcase import (
    advance_all,
    advance_simulated,
    count_active,
    is_showcase,
    public_info,
    refuse,
    resource_monitor,
    simulated_events,
    simulated_snapshot,
)
from app.services.access import (
    can_access_pipeline,
    can_access_run,
    can_create_run,
    can_mutate_run,
    has_grant,
    is_admin,
    visible_cluster_ids,
)
from app.services.sync import sync_run
from app.services.training import (
    check_resumable,
    expand_sweep,
    loads_json,
    param_env,
    resume_env,
    resume_files_for,
    stage_resume,
    sweep_label,
    validate_env,
    validate_mount_path,
    validate_params,
)
from app.services.inference import wait_for_model
from app.models.entities import new_id
from app.services.queue import (
    ACTIVE,
    QUEUE_SCHEDULED,
    QUEUED,
    check_room,
    check_start_at,
    check_user_quota,
    drop_launch,
    expire_stale,
    has_launch,
    load_launch,
    queue_position,
    queued_runs,
    save_launch,
    user_quota,
    user_usage,
    wait_reason,
)

_TERMINAL = frozenset({"succeeded", "failed", "timeout", "cancelled"})


def _aware_ts(dt: datetime) -> float:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()

router = APIRouter(prefix="/api")


_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"
# Extra deps a template needs before its script can run. Kept out of the image
# so the demos work on a plain python:3.12-slim.
_BOOTSTRAP: dict[str, list[str]] = {
    "torch-cpu": [
        "echo '[cilitrain] installing numpy + torch (cpu)...'",
        "pip install -q numpy",
        "pip install -q torch --index-url https://download.pytorch.org/whl/cpu",
    ],
    "sklearn": [
        "echo '[cilitrain] installing scikit-learn...'",
        "pip install -q scikit-learn==1.6.1",
    ],
}


def _builtin_rows() -> list[dict]:
    root = Path(__file__).resolve().parents[1] / "templates"
    return json.loads((root / "builtin.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=32)
def template_files(template_id: str) -> dict[str, str]:
    """Script bodies for a template, mounted into the Pod as a ConfigMap."""
    for raw in _builtin_rows():
        script = raw.get("script")
        if raw.get("id") == template_id and script:
            path = _EXAMPLES / script
            return {Path(script).name: path.read_text(encoding="utf-8")}
    return {}


SCRIPT_MAX_BYTES = 256 * 1024


def resolve_run_files(template_id: str, script: str | None) -> dict[str, str]:
    """Posted editor body wins; otherwise the built-in template file."""
    if script is not None and script.strip():
        body = script if script.endswith("\n") else script + "\n"
        if len(body.encode("utf-8")) > SCRIPT_MAX_BYTES:
            raise HTTPException(status_code=400, detail="script exceeds 256KiB")
        return {"train.py": body}
    return dict(template_files(template_id))


def _templates() -> list[dict]:
    out: list[dict] = []
    for raw in _builtin_rows():
        t = dict(raw)
        script = t.pop("script", None)
        bootstrap = t.pop("script_bootstrap", None)
        if script:
            path = _EXAMPLES / script
            name = Path(script).name
            t["script"] = path.read_text(encoding="utf-8")
            target = f"{SCRIPT_MOUNT_PATH}/{name}"
            steps = list(_BOOTSTRAP.get(bootstrap or "", []))
            if steps:
                t["command"] = ["bash", "-lc"]
                t["args"] = [
                    "set -euo pipefail; "
                    + "; ".join(steps)
                    + f"; echo '[cilitrain] running {name}...'; "
                    + f"python -u {target}"
                ]
            else:
                t["command"] = ["python", "-u", target]
                t["args"] = []
        t["resumable"] = bool(t.pop("resume_files", None))
        t.pop("infer", None)
        out.append(t)
    return out


def _settings_out(row: AppSettings) -> SettingsOut:
    return SettingsOut(
        cilikube_base_url=row.cilikube_base_url,
        cilikube_configured=bool(row.cilikube_base_url),
        max_gpu=settings.max_gpu,
        max_cpu=settings.max_cpu,
        max_memory_gi=settings.max_memory_gi,
        default_concurrency=settings.default_concurrency,
        max_queued=settings.max_queued,
        user_max_active=settings.user_max_active,
        user_max_cpu=settings.user_max_cpu,
        user_max_memory_gi=settings.user_max_memory_gi,
        user_max_gpu=settings.user_max_gpu,
        queue_timeout_seconds=settings.queue_timeout_seconds,
        prometheus_url=settings.prometheus_url or None,
    )


def _cluster_out(c: Cluster, *, admin: bool = False) -> ClusterOut:
    return ClusterOut(
        id=c.id,
        name=c.name,
        context=c.context,
        # Platform-held credentials: path only for admin
        kubeconfig_path=c.kubeconfig_path if admin else None,
        has_kubeconfig_content=bool(c.kubeconfig_content) if admin else False,
        cilikube_base_url=c.cilikube_base_url,
        simulated=bool(getattr(c, "simulated", False)),
        created_at=c.created_at,
    )


def _duration_seconds(run: Run) -> int | None:
    if run.status == QUEUED:
        return None
    start = run.started_at or run.created_at
    if start is None:
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    end = run.finished_at or datetime.now(timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return max(0, int((end - start).total_seconds()))


def _model_label(run: Run) -> str | None:
    s = object_session(run)
    if not run.model_id or s is None:
        return None
    m = s.get(ModelVersion, run.model_id)
    return model_label(m) if m else None


def _run_name(run: Run, run_id: str | None) -> str | None:
    s = object_session(run)
    if not run_id or s is None:
        return None
    src = s.get(Run, run_id)
    return src.name if src else None


def _queue_position(run: Run) -> int | None:
    s = object_session(run)
    return queue_position(s, run) if s is not None and run.status == QUEUED else None


def _registered_models(run: Run) -> list[dict[str, str]]:
    s = object_session(run)
    if s is None:
        return []
    rows = s.exec(select(ModelVersion).where(ModelVersion.source_run_id == run.id)).all()
    return [{"id": m.id, "label": model_label(m)} for m in rows]


def _run_out(
    run: Run,
    cilikube_base: str | None = None,
    events: list[str] | None = None,
    snap: dict | None = None,
    *,
    with_script: bool = False,
) -> RunOut:
    base = cilikube_base
    snap = snap or {}
    pod_name = snap.get("pod_name")
    if getattr(run, "simulated", False):
        links = build_cilikube_links(base, namespace=run.namespace)
    else:
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
        script=(
            (
                getattr(run, "script", None)
                or next(iter(template_files(run.template).values()), None)
            )
            if with_script
            else None
        ),
        simulated=bool(getattr(run, "simulated", False)),
        showcase_seed=bool(getattr(run, "showcase_seed", False)),
        kind=getattr(run, "kind", None) or "train",
        model_id=run.model_id,
        model_label=_model_label(run),
        infer_input=json.loads(run.infer_input) if run.infer_input else None,
        batch_rows=run.batch_rows,
        prediction=read_prediction(run.id) if run.kind == "infer" else None,
        registrable=(run.kind or "train") == "train" and infer_spec(run.template) is not None,
        registered_models=_registered_models(run) if with_script else [],
        params=loads_json(run.params, {}),
        env=loads_json(run.env_json, {}),
        pvc_mount_path=run.pvc_mount_path or "/data",
        resume_from=run.resume_from,
        resume_from_name=_run_name(run, run.resume_from),
        resumable=(run.kind or "train") == "train" and bool(resume_files_for(run.template)),
        sweep_id=run.sweep_id,
        queue_position=_queue_position(run),
        queue_reason=run.queue_reason if run.status == QUEUED else None,
        priority=int(run.priority or 0),
        not_before=run.not_before if run.status == QUEUED else None,
        started_at=run.started_at,
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


@router.get("/showcase")
def showcase_info() -> dict:
    """Public. Accounts are empty unless CILITRAIN_SHOWCASE=1."""
    return public_info()


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


def _probe_cluster(c: Cluster) -> ClusterProbeOut:
    if getattr(c, "simulated", False) or is_showcase():
        return ClusterProbeOut(
            cluster_id=c.id,
            name=c.name,
            reachable=True,
            message="simulated",
            gpu_allocatable=0,
        )
    kube = DirectKube(c)
    try:
        result = kube.probe()
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return ClusterProbeOut(cluster_id=c.id, name=c.name, reachable=False, message=detail)
    gpu = None
    if result.get("reachable"):
        try:
            nodes = kube.list_node_allocatable()
            if isinstance(nodes, list):
                gpu = count_allocatable_gpu(nodes)
        except Exception:  # noqa: BLE001 — reachability already answered
            gpu = None
    return ClusterProbeOut(
        cluster_id=c.id,
        name=c.name,
        reachable=bool(result.get("reachable")),
        message=result.get("message"),
        gpu_allocatable=gpu,
    )


@router.get("/clusters/{cluster_id}/probe", response_model=ClusterProbeOut)
def probe_cluster(
    cluster_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ClusterProbeOut:
    c = session.get(Cluster, cluster_id)
    if not c:
        raise HTTPException(status_code=404, detail="cluster not found")
    allowed = visible_cluster_ids(session, cu.user)
    if allowed is not None and c.id not in allowed:
        raise HTTPException(status_code=404, detail="cluster not found")
    return _probe_cluster(c)


@router.post("/clusters", response_model=ClusterOut)
def create_cluster(
    body: ClusterCreate,
    cu: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> ClusterOut:
    _ = cu
    refuse("showcase mode does not accept a kubeconfig")
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
    if getattr(c, "simulated", False) or is_showcase():
        refuse("showcase cluster cannot be deleted")
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
    return _settings_out(row)


@router.get("/scheduler", response_model=SchedulerOut)
def get_scheduler(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> SchedulerOut:
    """Queue limits, this user's usage against the quota, load per visible namespace, and the
    queued and running work the caller may see."""
    from app.models.entities import User

    dispatch_queue(session)
    advance_all(session)
    owner = _owner_for(session, cu)
    counts: dict[tuple[str, str], dict[str, int]] = {}
    busy = session.exec(select(Run).where(Run.status.in_((*ACTIVE, QUEUED)))).all()  # type: ignore[attr-defined]
    for r in busy:
        slot = counts.setdefault((r.cluster_id, r.namespace), {"active": 0, "queued": 0})
        slot["queued" if r.status == QUEUED else "active"] += 1
    if not is_admin(cu.user):
        for g in session.exec(select(ClusterGrant).where(ClusterGrant.user_id == cu.user.id)).all():
            counts.setdefault((g.cluster_id, g.namespace), {"active": 0, "queued": 0})
    names = {c.id: c.name for c in session.exec(select(Cluster)).all()}
    rows = [
        SchedulerNamespace(cluster_id=cid, cluster_name=names[cid], namespace=ns, **n)
        for (cid, ns), n in sorted(counts.items(), key=lambda kv: (names.get(kv[0][0], ""), kv[0][1]))
        if cid in names and (is_admin(cu.user) or has_grant(session, cu.user.id, cid, ns))
    ]
    users = {u.id: u.username for u in session.exec(select(User)).all()}
    visible = [r for r in busy if can_access_run(session, cu.user, r)]

    def item(r: Run) -> SchedulerItem:
        return SchedulerItem(
            id=r.id,
            kind=r.kind or "train",
            name=r.name,
            owner=users.get(r.owner_user_id or ""),
            mine=r.owner_user_id == owner,
            cluster_name=names.get(r.cluster_id, r.cluster_id),
            namespace=r.namespace,
            status=r.status,
            priority=int(r.priority or 0),
            queue_reason=r.queue_reason if r.status == QUEUED else None,
            queue_position=queue_position(session, r),
            not_before=r.not_before if r.status == QUEUED else None,
            cpu=r.cpu,
            memory=r.memory,
            gpu_count=int(r.gpu_count or 0),
            created_at=r.created_at,
            started_at=r.started_at,
        )

    queue = [item(r) for r in queued_runs(session) if r in visible]
    queue.sort(key=lambda i: i.queue_reason == QUEUE_SCHEDULED)  # stable: dispatch order, scheduled last
    active = [item(r) for r in visible if r.status != QUEUED]
    active += [
        SchedulerItem(
            id=s.id,
            kind="service",
            name=s.name,
            owner=users.get(s.owner_user_id or ""),
            mine=s.owner_user_id == owner,
            cluster_name=names.get(s.cluster_id, s.cluster_id),
            namespace=s.namespace,
            status="running" if s.status == "running" else "pending",
            cpu=f"{s.cpu} ×{s.replicas}" if s.replicas > 1 else s.cpu,
            memory=f"{s.memory} ×{s.replicas}" if s.replicas > 1 else s.memory,
            created_at=s.created_at,
            started_at=s.started_at,
        )
        for s in session.exec(
            select(InferenceService).where(InferenceService.status.in_(("starting", "running")))  # type: ignore[attr-defined]
        ).all()
        if is_admin(cu.user) or s.owner_user_id == owner or has_grant(session, cu.user.id, s.cluster_id, s.namespace)
    ]
    active.sort(key=lambda i: i.started_at or i.created_at)
    my_queued = sum(1 for r in busy if r.status == QUEUED and r.owner_user_id == owner)
    return SchedulerOut(
        concurrency=settings.default_concurrency,
        max_queued=settings.max_queued,
        queue_timeout_seconds=settings.queue_timeout_seconds,
        quota=user_quota(),
        usage=user_usage(session, owner),
        my_queued=my_queued,
        namespaces=rows,
        queue=queue,
        active=active,
    )


def _queued_run(session: Session, cu: CurrentUser, run_id: str) -> Run:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_mutate_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
    if run.status != QUEUED:
        raise HTTPException(status_code=409, detail="run is no longer queued")
    return run


@router.put("/runs/{run_id}/priority", response_model=RunOut)
def set_run_priority(
    run_id: str,
    body: PriorityUpdate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    """Reorder a queued run. Raising it to high is admin-only; anyone may lower their own."""
    run = _queued_run(session, cu, run_id)
    check_priority(cu, body.priority)
    run.priority = body.priority
    run.updated_at = datetime.now(timezone.utc)
    session.add(run)
    session.commit()
    dispatch_queue(session)
    session.refresh(run)
    return _run_out(run)


@router.post("/runs/{run_id}/start-now", response_model=RunOut)
def start_run_now(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    """Drop a scheduled start time; the run then waits like any other queued run."""
    run = _queued_run(session, cu, run_id)
    run.not_before = None
    run.updated_at = datetime.now(timezone.utc)
    session.add(run)
    session.commit()
    dispatch_queue(session)
    session.refresh(run)
    return _run_out(run)


@router.put("/settings", response_model=SettingsOut)
def put_settings(
    body: SettingsUpdate,
    cu: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> SettingsOut:
    _ = cu
    refuse("showcase settings are fixed")
    row = session.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1)
    row.cilikube_base_url = body.cilikube_base_url
    session.add(row)
    session.commit()
    session.refresh(row)
    return _settings_out(row)


@router.get("/runs", response_model=list[RunOut])
def list_runs(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[RunOut]:
    dispatch_queue(session)
    rows = session.exec(select(Run).order_by(Run.created_at.desc())).all()
    out: list[RunOut] = []
    for run in rows:
        if not can_access_run(session, cu.user, run):
            continue
        cluster = session.get(Cluster, run.cluster_id)
        snap: dict = {}
        if getattr(run, "simulated", False):
            run = advance_simulated(session, run)
            snap = simulated_snapshot(run)
        elif cluster:
            try:
                kube = DirectKube(cluster)
                run, snap = sync_run(session, run, kube, harvest=False)
            except HTTPException:
                pass
        base = _resolve_cilikube(session, cluster) if cluster else None
        out.append(_run_out(run, base, snap=snap))
    return out


def _guardrails() -> Guardrails:
    return Guardrails(
        max_cpu=settings.max_cpu,
        max_memory_gi=settings.max_memory_gi,
        max_gpu=settings.max_gpu,
        default_timeout_seconds=settings.default_timeout_seconds,
    )


def _owner_for(session: Session, cu: CurrentUser) -> str:
    if cu.user.id != "dev-admin":
        return cu.user.id
    from app.models.entities import User

    admin = session.exec(select(User).where(User.role == "admin")).first()
    return admin.id if admin else "dev-admin"


def check_priority(cu: CurrentUser, priority: int) -> None:
    if priority > 0 and not is_admin(cu.user):
        raise HTTPException(status_code=403, detail="high priority is reserved for admins")


def _admit(
    session: Session, cu: CurrentUser, body: RunCreate, *, count: int = 1
) -> tuple[Cluster, DirectKube | None, Guardrails]:
    """Grant, guardrail and concurrency checks shared by single runs and sweeps."""
    cluster = session.get(Cluster, body.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")
    if not can_create_run(session, cu.user, body.cluster_id, body.namespace):
        raise HTTPException(status_code=403, detail="no grant for this cluster/namespace")
    guardrails = _guardrails()
    gpu_count = int(body.gpu_count or 0)
    validate_resources(body.cpu, body.memory, body.timeout_seconds, guardrails, gpu_count=gpu_count)
    check_user_quota(body.cpu, body.memory, gpu_count)
    check_priority(cu, body.priority)
    check_start_at(body.start_at)
    simulated = bool(getattr(cluster, "simulated", False)) or is_showcase()
    kube = None if simulated else DirectKube(cluster)
    if not simulated and gpu_count > 0:
        assert_cluster_has_gpu(kube, skip=settings.gpu_probe_skip)
    check_room(session, body.namespace, count, active_in(session, body.namespace, kube))
    return cluster, kube, guardrails


def _launch(
    session: Session,
    cu: CurrentUser,
    body: RunCreate,
    cluster: Cluster,
    kube: DirectKube | None,
    guardrails: Guardrails,
    *,
    params: dict | None = None,
    name: str | None = None,
    sweep_id: str | None = None,
) -> RunOut:
    params = validate_params(body.template, body.params if params is None else params)
    env = validate_env(body.env)
    mount_path = validate_mount_path(body.pvc_mount_path) if body.pvc_name else body.pvc_mount_path
    checkpoint = None
    if body.resume_from:
        src = session.get(Run, body.resume_from)
        if not src:
            raise HTTPException(status_code=404, detail="run to resume from not found")
        if not can_access_run(session, cu.user, src):
            raise HTTPException(status_code=403, detail="forbidden")
        if src.template != body.template:
            raise HTTPException(status_code=400, detail="resume must use the source run's template")
        checkpoint = check_resumable(src)

    run = Run(
        cluster_id=body.cluster_id,
        owner_user_id=_owner_for(session, cu),
        name=(name or body.name)[:120],
        namespace=body.namespace,
        template=body.template,
        image=body.image,
        command=dumps_command(body.command),
        args=dumps_command(body.args),
        cpu=body.cpu,
        memory=body.memory,
        gpu_count=int(body.gpu_count or 0),
        timeout_seconds=body.timeout_seconds,
        pvc_name=body.pvc_name,
        pvc_mount_path=mount_path,
        output_path=body.output_path,
        status=QUEUED,
        params=json.dumps(params) if params else None,
        env_json=json.dumps(env) if env else None,
        resume_from=body.resume_from,
        sweep_id=sweep_id,
        priority=body.priority,
        not_before=check_start_at(body.start_at),
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    files = resolve_run_files(run.template, body.script)
    command = list(body.command or [])
    args = list(body.args or [])
    if files and not command:
        command = ["python", "-u", f"{SCRIPT_MOUNT_PATH}/train.py"]
        args = []
    run.script = files.get("train.py")
    extra_env = {**env, **param_env(params)}
    if checkpoint is not None:
        stage_resume(run.id, checkpoint)
        command, args = wait_for_model(command, args)
        extra_env.update(resume_env(body.resume_from))
    return submit_run(
        session,
        run,
        cluster,
        kube,
        files=files,
        command=command,
        args=args,
        guardrails=guardrails,
        model_mount=checkpoint is not None,
        extra_env=extra_env,
    )


@router.post("/runs", response_model=RunOut)
def create_run(
    body: RunCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    cluster, kube, guardrails = _admit(session, cu, body)
    return _launch(session, cu, body, cluster, kube, guardrails)


@router.post("/sweeps", response_model=SweepOut)
def create_sweep(
    body: SweepCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> SweepOut:
    """Grid search: one training run per parameter combination, grouped by sweep_id."""
    base = body.run
    if base.resume_from:
        raise HTTPException(status_code=400, detail="a sweep cannot resume from a checkpoint")
    combos = expand_sweep(base.template, base.params, body.grid)
    cluster, kube, guardrails = _admit(session, cu, base, count=len(combos))
    sweep_id = new_id()[:8]
    keys = sorted(body.grid)
    runs = [
        _launch(
            session,
            cu,
            base,
            cluster,
            kube,
            guardrails,
            params=p,
            name=f"{base.name}-{sweep_label(p, keys)}",
            sweep_id=sweep_id,
        )
        for p in combos
    ]
    return SweepOut(sweep_id=sweep_id, runs=runs)


def active_in(session: Session, namespace: str, kube: DirectKube | None) -> int:
    return count_active(session, namespace) if kube is None else kube.count_active_jobs(namespace)


def submit_run(
    session: Session,
    run: Run,
    cluster: Cluster,
    kube: DirectKube | None,
    *,
    files: dict[str, str],
    command: list[str],
    args: list[str],
    guardrails: Guardrails,
    model_mount: bool = False,
    extra_env: dict[str, str] | None = None,
) -> RunOut:
    """Build the Job for a saved Run row; start it now or leave it queued for a free slot."""
    gpu_count = int(run.gpu_count or 0)
    run.command = dumps_command(command)
    run.args = dumps_command(args)
    job = build_job(
        run_id=run.id,
        name=run.name,
        namespace=run.namespace,
        template=run.template,
        image=run.image,
        command=command,
        args=args,
        cpu=run.cpu,
        memory=run.memory,
        timeout_seconds=run.timeout_seconds,
        gpu_count=gpu_count,
        pvc_name=run.pvc_name,
        pvc_mount_path=run.pvc_mount_path,
        output_path=run.output_path,
        hold_seconds=settings.hold_seconds,
        guardrails=guardrails,
        files=files,
        model_mount=model_mount,
        extra_env=extra_env,
    )
    run.job_yaml = yaml.safe_dump(job, sort_keys=False)
    run.simulated = kube is None
    reason = wait_reason(session, run, active_in(session, run.namespace, kube))
    if reason:
        save_launch(run.id, files)
        run.status = QUEUED
        run.queue_reason = reason
        run.updated_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()
        session.refresh(run)
        return _run_out(run, _resolve_cilikube(session, cluster))
    return _start_job(session, run, cluster, kube, job, files)


def _start_job(
    session: Session,
    run: Run,
    cluster: Cluster,
    kube: DirectKube | None,
    job: dict,
    files: dict[str, str],
) -> RunOut:
    now = datetime.now(timezone.utc)
    run.job_name = job_name_for(run.id)
    run.started_at = now
    run.status = "pending"
    run.queue_reason = None
    run.updated_at = now
    if kube is None:
        session.add(run)
        session.commit()
        session.refresh(run)
        run = advance_simulated(session, run)
        return _run_out(run, _resolve_cilikube(session, cluster), snap=simulated_snapshot(run))

    try:
        if files:
            kube.apply_configmap(
                build_script_configmap(
                    run_id=run.id,
                    namespace=run.namespace,
                    template=run.template,
                    files=files,
                )
            )
        created = kube.create_job(job)
        if files:
            kube.own_configmap(
                run.namespace, script_configmap_name(run.id), created
            )
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


_dispatch_lock = threading.Lock()


def dispatch_queue(session: Session) -> int:
    """Start queued runs in FIFO order wherever a slot has opened. Returns how many started."""
    if not _dispatch_lock.acquire(blocking=False):
        return 0
    try:
        expire_stale(session)
        rows = queued_runs(session)
        if not rows:
            return 0
        if any(r.simulated for r in rows):
            advance_all(session)
        kubes: dict[str, DirectKube] = {}
        started = 0
        for run in rows:
            if not run.job_yaml or not has_launch(run.id):
                continue
            cluster = session.get(Cluster, run.cluster_id)
            if not cluster:
                run.status = "failed"
                run.error_message = "cluster was removed while the run was queued"
                session.add(run)
                session.commit()
                drop_launch(run.id)
                continue
            kube = None if run.simulated else kubes.setdefault(cluster.id, DirectKube(cluster))
            try:
                reason = wait_reason(session, run, active_in(session, run.namespace, kube))
                if reason:
                    if run.queue_reason != reason:
                        run.queue_reason = reason
                        session.add(run)
                        session.commit()
                    continue
                _start_job(session, run, cluster, kube, yaml.safe_load(run.job_yaml), load_launch(run.id)["files"])
            except HTTPException:
                pass
            drop_launch(run.id)
            started += 1
        return started
    finally:
        _dispatch_lock.release()


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
    if run.status == QUEUED:
        dispatch_queue(session)
        session.refresh(run)
    cluster = session.get(Cluster, run.cluster_id)
    events: list[str] = []
    snap: dict = {}
    if getattr(run, "simulated", False):
        run = advance_simulated(session, run)
        snap = simulated_snapshot(run)
        events = simulated_events(run)
    elif cluster:
        try:
            kube = DirectKube(cluster)
            run, snap = sync_run(session, run, kube, harvest=False)
            if run.job_name:
                events = kube.list_events(run.namespace, run.job_name)
                if snap.get("pod_name"):
                    events = events + kube.list_events(run.namespace, snap["pod_name"])
        except HTTPException:
            pass
    base = _resolve_cilikube(session, cluster) if cluster else None
    return _run_out(run, base, events, snap=snap, with_script=True)


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
    if src.status in ("queued", "pending", "running"):
        raise HTTPException(status_code=409, detail="cannot rerun an active job; stop it first")
    if src.kind == "infer":
        from app.api.model_routes import start_inference

        model = session.get(ModelVersion, src.model_id) if src.model_id else None
        if not model:
            raise HTTPException(status_code=409, detail="model for this inference run no longer exists")
        batch = load_batch_inputs(src.id) if src.batch_rows else None
        if src.batch_rows and not batch:
            raise HTTPException(status_code=409, detail="the CSV of this batch run is no longer stored")
        return start_inference(
            session,
            cu,
            model,
            json.loads(src.infer_input or "{}"),
            batch=batch,
            cluster_id=src.cluster_id,
            namespace=src.namespace,
        )
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
        script=getattr(src, "script", None),
        params=loads_json(src.params, {}),
        env=loads_json(src.env_json, {}),
        resume_from=src.resume_from,
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
    if run.status == QUEUED:
        run.status = "cancelled"
        run.error_message = "cancelled while queued"
        run.finished_at = datetime.now(timezone.utc)
        run.updated_at = run.finished_at
        session.add(run)
        session.commit()
        session.refresh(run)
        drop_launch(run.id)
        return _run_out(run)
    cluster = session.get(Cluster, run.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")

    if getattr(run, "simulated", False):
        run.status = "cancelled"
        run.error_message = run.error_message or "cancelled by user"
        run.finished_at = datetime.now(timezone.utc)
        run.updated_at = datetime.now(timezone.utc)
        session.add(run)
        session.commit()
        session.refresh(run)
        dispatch_queue(session)
        return _run_out(run, _resolve_cilikube(session, cluster), snap=simulated_snapshot(run))

    kube = DirectKube(cluster)
    if run.job_name:
        # Prefer hard stop: delete Job (cascade pods). Suspend alone can leave orphan state.
        kube.delete_job(run.namespace, run.job_name)
        kube.delete_configmap(run.namespace, script_configmap_name(run.id))

    run.status = "cancelled"
    run.error_message = run.error_message or "cancelled by user"
    run.finished_at = datetime.now(timezone.utc)
    run.updated_at = datetime.now(timezone.utc)
    session.add(run)
    session.commit()
    session.refresh(run)
    snap = kube.pod_snapshot(run.namespace, run.id)
    dispatch_queue(session)
    return _run_out(run, _resolve_cilikube(session, cluster), snap=snap)


@router.post("/runs/{run_id}/cleanup", response_model=CleanupOut)
def cleanup_run(
    run_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> CleanupOut:
    """Delete a leftover Job for a failed/timeout run. Does not change the record."""
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_mutate_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
    if run.status not in ("failed", "timeout"):
        raise HTTPException(
            status_code=409,
            detail="cleanup is only for failed or timeout runs; stop a live run instead",
        )
    if getattr(run, "simulated", False) or not run.job_name:
        return CleanupOut(status="ok", cleaned=False)
    cluster = session.get(Cluster, run.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="cluster not found")
    kube = DirectKube(cluster)
    kube.delete_job(run.namespace, run.job_name)
    kube.delete_configmap(run.namespace, script_configmap_name(run.id))
    return CleanupOut(status="ok", cleaned=True)


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
    if run.status in ("queued", "pending", "running"):
        raise HTTPException(
            status_code=409,
            detail="stop the run first (cancel), then delete the record",
        )
    if getattr(run, "showcase_seed", False):
        raise HTTPException(status_code=403, detail="showcase seed runs cannot be deleted")
    cluster = session.get(Cluster, run.cluster_id)
    if cluster and run.job_name and not getattr(run, "simulated", False):
        try:
            kube = DirectKube(cluster)
            kube.delete_job(run.namespace, run.job_name)
            kube.delete_configmap(run.namespace, script_configmap_name(run.id))
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
    if getattr(run, "simulated", False):
        run = advance_simulated(session, run)
        stored, stored_pod = load_run_logs(run_id)
        return LogsOut(pod_name=stored_pod or simulated_snapshot(run).get("pod_name"), logs=stored)
    cluster = session.get(Cluster, run.cluster_id)
    stored, stored_pod = load_run_logs(run_id)
    if not cluster:
        if stored.strip():
            return LogsOut(pod_name=stored_pod, logs=stored)
        raise HTTPException(status_code=404, detail="cluster not found")
    kube = DirectKube(cluster)
    try:
        pods = kube.list_job_pods(run.namespace, run.id)
    except HTTPException as exc:
        if stored.strip():
            return LogsOut(pod_name=stored_pod, logs=stored)
        return LogsOut(pod_name=None, logs=f"(集群不可达: {exc.detail})")
    if not pods:
        if stored.strip():
            return LogsOut(pod_name=stored_pod, logs=stored)
        return LogsOut(pod_name=None, logs="(尚无 Pod，任务可能仍在调度)")
    pods = sorted(pods, key=lambda p: p.metadata.creation_timestamp or 0)
    chunks: list[str] = []
    names: list[str] = []
    for pod in pods:
        name = pod.metadata.name
        names.append(name)
        text = kube.pod_logs(run.namespace, name)
        if text.count("\n") < 8:
            prev = kube.pod_logs(run.namespace, name, previous=True)
            if prev.strip() and not prev.startswith("(logs not ready") and not prev.startswith("(logs timed out"):
                text = prev.rstrip() + "\n----- previous container ended -----\n" + text
        if len(pods) > 1:
            chunks.append(f"===== {name} =====\n{text.rstrip()}\n")
        else:
            chunks.append(text)
    incoming = "".join(chunks)
    if not incoming.strip():
        snap = kube.pod_snapshot(run.namespace, run.id)
        reason = snap.get("status_reason") or snap.get("pod_phase") or "unknown"
        incoming = (
            f"(暂无日志输出 · Pod={names[-1]} · phase={snap.get('pod_phase')} · "
            f"reason={reason})\n"
            "提示：镜像拉取或 pip 安装阶段可能长时间无 stdout；新任务模板已加入进度 echo。"
        )
    merged = absorb_logs(run_id, incoming, names[-1])
    return LogsOut(pod_name=names[-1], logs=merged)


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
    cluster = session.get(Cluster, run.cluster_id)
    if cluster and run.status == "succeeded" and not getattr(run, "simulated", False):
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
        nodes = mapi.list_cluster_custom_object(
            "metrics.k8s.io", "v1beta1", "nodes", _request_timeout=KUBE_READ_TIMEOUT
        )
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
            _request_timeout=KUBE_READ_TIMEOUT,
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
            _request_timeout=KUBE_READ_TIMEOUT,
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


@router.get("/run-trends")
def run_trends(
    ids: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict:
    """Loss sparklines for the runs list. Reads stored logs and metrics.json only; never calls the cluster."""
    out: dict[str, dict] = {}
    for rid in [x.strip() for x in ids.split(",") if x.strip()][:60]:
        run = session.get(Run, rid)
        if not run or not can_access_run(session, cu.user, run):
            continue
        logs, _ = load_run_logs(rid)
        trend = trend_from_view(build_metrics_view(rid, logs=logs or ""))
        if trend:
            out[rid] = trend
    return {"trends": out}


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
    if getattr(run, "simulated", False):
        run = advance_simulated(session, run)
        logs, _ = load_run_logs(run_id)
        view = build_metrics_view(run_id, logs=logs)
        view["run_id"] = run_id
        view["status"] = run.status
        view["name"] = run.name
        view["resource"] = resource_monitor(run)
        return view
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
                mapi.list_cluster_custom_object(
                    "metrics.k8s.io",
                    "v1beta1",
                    "nodes",
                    _request_timeout=KUBE_READ_TIMEOUT,
                )
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
    if not monitor.get("series"):
        persisted = resource_series_for(run_id)
        if persisted:
            monitor["available"] = True
            monitor["pending"] = False
            monitor["series"] = persisted
            monitor["series_source"] = monitor.get("series_source") or "metrics-server"
            if terminal:
                save_frozen_resource(
                    run_id,
                    series=persisted,
                    source="metrics-server",
                    pod_name=monitor.get("pod_name"),
                )
                monitor["frozen"] = True
                monitor["message"] = "resource_history_frozen"
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
    """Compare up to 12 runs (a full sweep): ?ids=id1,id2"""
    run_ids = [x.strip() for x in ids.split(",") if x.strip()][:12]
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
        if getattr(run, "simulated", False):
            run = advance_simulated(session, run)
            logs, _ = load_run_logs(rid)
        elif cluster:
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
                "params": loads_json(run.params, {}),
                "sweep_id": run.sweep_id,
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
    if getattr(run, "simulated", False):
        run = advance_simulated(session, run)
    elif cluster:
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
    refuse("showcase mode does not create pipelines")
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
