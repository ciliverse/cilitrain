"""Online inference services: deploy a registered model behind an HTTP endpoint."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from app.api.deps import CurrentUser, get_current_user
from app.api.model_routes import _get_model, _owner_id, _template_row
from app.api.routes import _BOOTSTRAP
from app.api.schemas import (
    LogsOut,
    ServiceCreate,
    ServiceKeyOut,
    ServiceOut,
    ServicePredict,
    ServicePredictOut,
    ServiceScale,
)
from app.config import settings
from app.db import get_session
from app.models.entities import Cluster, InferenceService, ModelVersion, Run
from app.services.access import can_create_run, has_grant, is_admin
from app.services.cluster.direct import DirectKube
from app.services.inference import infer_spec
from app.services.job_builder import Guardrails, parse_cpu_cores, parse_memory_gi, validate_resources
from app.services.models import NAME_RE, model_label
from app.services.queue import check_service_fits, check_user_quota
from app.services.serving import (
    ACTIVE_STATES,
    LABEL_SERVICE,
    MAX_REPLICAS,
    build_configmap,
    build_deployment,
    build_service,
    endpoint_path,
    forget,
    key_matches,
    new_api_key,
    predict,
    recent_requests,
    resource_name,
    serve_command,
    serve_files,
    sync_service,
)
from app.services.showcase import is_showcase

router = APIRouter(prefix="/api")

MAX_ACTIVE_PER_USER = 5


def can_access_service(session: Session, cu: CurrentUser, svc: InferenceService) -> bool:
    if is_admin(cu.user) or svc.owner_user_id == _owner_id(session, cu):
        return True
    return has_grant(session, cu.user.id, svc.cluster_id, svc.namespace)


def can_mutate_service(session: Session, cu: CurrentUser, svc: InferenceService) -> bool:
    return cu.user.role != "viewer" and can_access_service(session, cu, svc)


def _kube(session: Session, svc: InferenceService) -> DirectKube | None:
    if svc.simulated:
        return None
    cluster = session.get(Cluster, svc.cluster_id)
    if not cluster:
        raise HTTPException(status_code=409, detail="the service's cluster was removed")
    return DirectKube(cluster)


def sync_active_services(session: Session) -> None:
    """Background tick: refresh status and deliver the model to pods nobody is looking at."""
    rows = session.exec(
        select(InferenceService).where(InferenceService.status.in_(ACTIVE_STATES))  # type: ignore[attr-defined]
    ).all()
    for svc in rows:
        try:
            sync_service(session, svc, _kube(session, svc))
        except HTTPException:
            continue


def _service_out(session: Session, svc: InferenceService, *, sync: bool = True) -> ServiceOut:
    ready, message = 0, None
    if sync:
        try:
            ready, message = sync_service(session, svc, _kube(session, svc))
        except HTTPException as exc:
            message = str(exc.detail)
    m = session.get(ModelVersion, svc.model_id)
    cluster = session.get(Cluster, svc.cluster_id)
    return ServiceOut(
        id=svc.id,
        name=svc.name,
        model_id=svc.model_id,
        model_label=model_label(m) if m else None,
        template=svc.template,
        cluster_id=svc.cluster_id,
        cluster_name=cluster.name if cluster else None,
        namespace=svc.namespace,
        owner_user_id=svc.owner_user_id,
        image=svc.image,
        cpu=svc.cpu,
        memory=svc.memory,
        replicas=svc.replicas,
        ready_replicas=ready,
        status=svc.status,
        status_message=message,
        simulated=svc.simulated,
        error_message=svc.error_message,
        api_key_prefix=svc.api_key_prefix,
        endpoint_path=endpoint_path(svc.id),
        requests=svc.requests,
        errors=svc.errors,
        avg_latency_ms=round(svc.total_ms / svc.requests, 1) if svc.requests else None,
        last_request_at=svc.last_request_at,
        infer=infer_spec(svc.template),
        recent=recent_requests(svc.id),
        created_at=svc.created_at,
        started_at=svc.started_at,
        stopped_at=svc.stopped_at,
    )


def _get(session: Session, cu: CurrentUser, service_id: str, *, mutate: bool = False) -> InferenceService:
    svc = session.get(InferenceService, service_id)
    if not svc:
        raise HTTPException(status_code=404, detail="service not found")
    allowed = can_mutate_service(session, cu, svc) if mutate else can_access_service(session, cu, svc)
    if not allowed:
        raise HTTPException(status_code=403, detail="forbidden")
    return svc


def _guard_resources(session: Session, svc: InferenceService, replicas: int, *, already_counted: int = 0) -> None:
    """Each replica must pass the guardrails; the extra replicas must fit in the owner's quota."""
    validate_resources(
        svc.cpu,
        svc.memory,
        1,
        Guardrails(
            max_cpu=settings.max_cpu,
            max_memory_gi=settings.max_memory_gi,
            max_gpu=settings.max_gpu,
            default_timeout_seconds=settings.default_timeout_seconds,
        ),
    )
    extra = replicas - already_counted
    cpu, mem = parse_cpu_cores(svc.cpu) * replicas, parse_memory_gi(svc.memory) * replicas
    check_user_quota(f"{cpu:g}", f"{mem:g}Gi")
    if extra > 0:
        check_service_fits(
            session, svc.owner_user_id, parse_cpu_cores(svc.cpu) * extra, parse_memory_gi(svc.memory) * extra
        )


def _deploy(session: Session, svc: InferenceService) -> None:
    now = datetime.now(timezone.utc)
    svc.status = "starting"
    svc.error_message = None
    svc.started_at = now
    svc.stopped_at = None
    svc.updated_at = now
    kube = _kube(session, svc)
    if kube is not None:
        spec = infer_spec(svc.template) or {}
        steps = list(_BOOTSTRAP.get(spec.get("bootstrap") or "", []))
        try:
            kube.apply_configmap(build_configmap(svc, serve_files(svc.template)))
            kube.apply_service(build_service(svc))
            kube.apply_deployment(build_deployment(svc, serve_command(svc.template, steps), {}))
        except HTTPException as exc:
            svc.status = "failed"
            svc.error_message = str(exc.detail)
            session.add(svc)
            session.commit()
            raise
    session.add(svc)
    session.commit()
    session.refresh(svc)


@router.get("/services", response_model=list[ServiceOut])
def list_services(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[ServiceOut]:
    rows = session.exec(select(InferenceService).order_by(InferenceService.created_at.desc())).all()
    return [_service_out(session, s) for s in rows if can_access_service(session, cu, s)]


@router.post("/services", response_model=ServiceKeyOut)
def create_service(
    body: ServiceCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ServiceKeyOut:
    m = _get_model(session, cu, body.model_id)
    spec = infer_spec(m.template)
    if not spec:
        raise HTTPException(status_code=400, detail=f"template {m.template} has no inference support")
    src = session.get(Run, m.source_run_id) if m.source_run_id else None
    cluster_id = body.cluster_id or (src.cluster_id if src else None)
    namespace = body.namespace or (src.namespace if src else "default")
    cluster = session.get(Cluster, cluster_id) if cluster_id else None
    if not cluster:
        raise HTTPException(status_code=400, detail="source run's cluster is gone; pick a cluster")
    if not can_create_run(session, cu.user, cluster.id, namespace):
        raise HTTPException(status_code=403, detail="no grant for this cluster/namespace")
    owner = _owner_id(session, cu)
    active = session.exec(
        select(InferenceService).where(
            InferenceService.owner_user_id == owner,
            InferenceService.status.in_(ACTIVE_STATES),  # type: ignore[attr-defined]
        )
    ).all()
    if len(active) >= MAX_ACTIVE_PER_USER:
        raise HTTPException(status_code=409, detail=f"at most {MAX_ACTIVE_PER_USER} running services per user")
    name = (body.name or f"{m.name}-v{m.version}").strip().lower()
    if not NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="name: lowercase letters, digits and dashes, 2-41 characters")

    key, digest, prefix = new_api_key()
    svc = InferenceService(
        name=name,
        model_id=m.id,
        cluster_id=cluster.id,
        owner_user_id=owner,
        namespace=namespace,
        template=m.template,
        image=_template_row(m.template).get("image", "python:3.12-slim"),
        cpu=str(spec.get("cpu", "500m")),
        memory=str(spec.get("memory", "512Mi")),
        replicas=body.replicas,
        simulated=bool(cluster.simulated) or is_showcase(),
        api_key_hash=digest,
        api_key_prefix=prefix,
    )
    _guard_resources(session, svc, body.replicas)
    session.add(svc)
    session.commit()
    session.refresh(svc)
    _deploy(session, svc)
    return ServiceKeyOut(service=_service_out(session, svc, sync=False), api_key=key)


@router.get("/services/{service_id}", response_model=ServiceOut)
def get_service(
    service_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ServiceOut:
    return _service_out(session, _get(session, cu, service_id))


@router.post("/services/{service_id}/stop", response_model=ServiceOut)
def stop_service(
    service_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ServiceOut:
    """Delete the Deployment and Service; the record, key and stats stay so it can start again."""
    svc = _get(session, cu, service_id, mutate=True)
    if svc.status in ("stopped",):
        return _service_out(session, svc, sync=False)
    kube = _kube(session, svc)
    if kube is not None:
        kube.delete_serving(svc.namespace, resource_name(svc.id))
    forget(svc.id)
    now = datetime.now(timezone.utc)
    svc.status = "stopped"
    svc.stopped_at = now
    svc.updated_at = now
    session.add(svc)
    session.commit()
    session.refresh(svc)
    return _service_out(session, svc, sync=False)


@router.post("/services/{service_id}/start", response_model=ServiceOut)
def start_service(
    service_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ServiceOut:
    svc = _get(session, cu, service_id, mutate=True)
    if svc.status in ACTIVE_STATES:
        raise HTTPException(status_code=409, detail=f"service is already {svc.status}")
    if not session.get(ModelVersion, svc.model_id):
        raise HTTPException(status_code=409, detail="the model of this service no longer exists")
    _guard_resources(session, svc, svc.replicas)
    _deploy(session, svc)
    return _service_out(session, svc, sync=False)


@router.put("/services/{service_id}/replicas", response_model=ServiceOut)
def scale_service(
    service_id: str,
    body: ServiceScale,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ServiceOut:
    svc = _get(session, cu, service_id, mutate=True)
    if body.replicas > MAX_REPLICAS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_REPLICAS} replicas")
    if svc.status in ACTIVE_STATES:
        _guard_resources(session, svc, body.replicas, already_counted=svc.replicas)
        kube = _kube(session, svc)
        if kube is not None:
            kube.scale_deployment(svc.namespace, resource_name(svc.id), body.replicas)
    svc.replicas = body.replicas
    svc.updated_at = datetime.now(timezone.utc)
    session.add(svc)
    session.commit()
    session.refresh(svc)
    return _service_out(session, svc)


@router.post("/services/{service_id}/rotate-key", response_model=ServiceKeyOut)
def rotate_service_key(
    service_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ServiceKeyOut:
    """Issue a new API key; the old one stops working immediately."""
    svc = _get(session, cu, service_id, mutate=True)
    key, digest, prefix = new_api_key()
    svc.api_key_hash, svc.api_key_prefix = digest, prefix
    svc.updated_at = datetime.now(timezone.utc)
    session.add(svc)
    session.commit()
    session.refresh(svc)
    return ServiceKeyOut(service=_service_out(session, svc, sync=False), api_key=key)


@router.delete("/services/{service_id}")
def delete_service(
    service_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict[str, str]:
    svc = _get(session, cu, service_id, mutate=True)
    if svc.status in ACTIVE_STATES:
        raise HTTPException(status_code=409, detail="stop the service before deleting it")
    forget(svc.id)
    session.delete(svc)
    session.commit()
    return {"status": "deleted"}


@router.get("/services/{service_id}/logs", response_model=LogsOut)
def service_logs(
    service_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> LogsOut:
    svc = _get(session, cu, service_id)
    if svc.status not in ACTIVE_STATES:
        return LogsOut(pod_name=None, logs="")
    kube = _kube(session, svc)
    if kube is None:
        return LogsOut(pod_name=f"sim-{svc.id[:8]}", logs=_simulated_logs(svc))
    pods = kube.list_pods(svc.namespace, f"{LABEL_SERVICE}={svc.id}")
    if not pods:
        return LogsOut(pod_name=None, logs="")
    pod = sorted(pods, key=lambda p: p.metadata.creation_timestamp or 0)[-1]
    return LogsOut(pod_name=pod.metadata.name, logs=kube.pod_logs(svc.namespace, pod.metadata.name, tail=400))


def _simulated_logs(svc: InferenceService) -> str:
    model = "model.joblib" if svc.template == "sklearn-cpu" else "model.pt"
    lines = [
        "[cilitrain] simulated inference service (no cluster)",
        "[cilitrain] model ready",
        f"[cilitrain] model loaded in 0.4s ({model}); serving on :8080",
    ]
    for r in reversed(recent_requests(svc.id)):
        status = "200" if r["ok"] else "500"
        lines.append(f'[http] "POST /predict HTTP/1.1" {status} - {r["latency_ms"]}ms')
    return "\n".join(lines) + "\n"


@router.post("/services/{service_id}/predict", response_model=ServicePredictOut)
def predict_as_user(
    service_id: str,
    body: ServicePredict,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Try the service from the UI with the signed-in session instead of the API key."""
    svc = _get(session, cu, service_id)
    sync_service(session, svc, _kube(session, svc))
    return predict(session, svc, _kube(session, svc), body.model_dump(exclude_none=True))


@router.post("/serve/{service_id}/predict", response_model=ServicePredictOut)
def predict_with_key(
    service_id: str,
    body: ServicePredict,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Public endpoint for callers outside the platform: `Authorization: Bearer <service API key>`."""
    auth = request.headers.get("Authorization") or ""
    key = auth[7:].strip() if auth.lower().startswith("bearer ") else request.headers.get("X-API-Key", "")
    svc = session.get(InferenceService, service_id)
    if not svc or not key or not key_matches(svc, key):
        raise HTTPException(status_code=401, detail="invalid service API key")
    kube = _kube(session, svc)
    sync_service(session, svc, kube)
    return predict(session, svc, kube, body.model_dump(exclude_none=True))
