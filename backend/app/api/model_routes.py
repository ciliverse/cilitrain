"""Model registry and batch inference endpoints."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.api.deps import CurrentUser, get_current_user
from app.api.routes import (
    _BOOTSTRAP,
    _EXAMPLES,
    _builtin_rows,
    _resolve_cilikube,
    _run_out,
    active_in,
    submit_run,
)
from app.api.schemas import InferBatchCreate, InferCreate, ModelOut, ModelRegister, RunOut
from app.config import settings
from app.db import get_session
from app.models.entities import Cluster, ModelVersion, Run, User
from app.services.access import can_access_run, can_create_run, can_mutate_run
from app.services.cluster.direct import DirectKube
from app.services.inference import (
    BATCH_INPUT_FILE,
    batch_jsonl,
    infer_spec,
    parse_batch_csv,
    save_batch_inputs,
    validate_infer_input,
    wait_for_model,
)
from app.services.job_builder import SCRIPT_MOUNT_PATH, Guardrails, validate_resources
from app.services.models import can_access_model, model_dir, model_label, model_out, register_model
from app.services.queue import QUEUED, check_room, check_user_quota
from app.services.showcase import advance_simulated, is_showcase, simulated_snapshot

router = APIRouter(prefix="/api")


def _owner_id(session: Session, cu: CurrentUser) -> str:
    if cu.user.id != "dev-admin":
        return cu.user.id
    admin = session.exec(select(User).where(User.role == "admin")).first()
    return admin.id if admin else "dev-admin"


def _get_model(session: Session, cu: CurrentUser, model_id: str) -> ModelVersion:
    m = session.get(ModelVersion, model_id)
    if not m:
        raise HTTPException(status_code=404, detail="model not found")
    if not can_access_model(session, cu.user, m):
        raise HTTPException(status_code=403, detail="forbidden")
    return m


@router.get("/models", response_model=list[ModelOut])
def list_models(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[ModelOut]:
    rows = session.exec(select(ModelVersion).order_by(ModelVersion.created_at.desc())).all()
    return [ModelOut(**model_out(session, m)) for m in rows if can_access_model(session, cu.user, m)]


@router.get("/models/{model_id}", response_model=ModelOut)
def get_model(
    model_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ModelOut:
    return ModelOut(**model_out(session, _get_model(session, cu, model_id)))


@router.get("/models/{model_id}/runs", response_model=list[RunOut])
def list_model_runs(
    model_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> list[RunOut]:
    m = _get_model(session, cu, model_id)
    rows = session.exec(
        select(Run).where(Run.model_id == m.id).order_by(Run.created_at.desc())
    ).all()
    out: list[RunOut] = []
    for run in rows:
        if not can_access_run(session, cu.user, run):
            continue
        snap: dict = {}
        if run.simulated:
            run = advance_simulated(session, run)
            snap = simulated_snapshot(run)
        out.append(_run_out(run, snap=snap))
    return out


@router.post("/runs/{run_id}/register-model", response_model=ModelOut)
def register_run_model(
    run_id: str,
    body: ModelRegister,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> ModelOut:
    run = session.get(Run, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    if not can_mutate_run(session, cu.user, run):
        raise HTTPException(status_code=403, detail="forbidden")
    m = register_model(session, run, body.name, _owner_id(session, cu))
    return ModelOut(**model_out(session, m))


def _template_row(template: str) -> dict:
    for row in _builtin_rows():
        if row.get("id") == template:
            return row
    raise HTTPException(status_code=400, detail=f"unknown template {template}")


def start_inference(
    session: Session,
    cu: CurrentUser,
    m: ModelVersion,
    raw_input: dict | None,
    *,
    batch: list[dict] | None = None,
    cluster_id: str | None = None,
    namespace: str | None = None,
) -> RunOut:
    """One inference Job. `batch` (rows from parse_batch_csv) replaces the single `raw_input`."""
    spec = infer_spec(m.template)
    if not spec:
        raise HTTPException(status_code=400, detail=f"template {m.template} has no inference support")
    inp = None if batch else validate_infer_input(spec, raw_input)

    src = session.get(Run, m.source_run_id) if m.source_run_id else None
    cluster_id = cluster_id or (src.cluster_id if src else None)
    namespace = namespace or (src.namespace if src else "default")
    cluster = session.get(Cluster, cluster_id) if cluster_id else None
    if not cluster:
        raise HTTPException(status_code=400, detail="source run's cluster is gone; pick a cluster")
    if not can_create_run(session, cu.user, cluster.id, namespace):
        raise HTTPException(status_code=403, detail="no grant for this cluster/namespace")

    guardrails = Guardrails(
        max_cpu=settings.max_cpu,
        max_memory_gi=settings.max_memory_gi,
        max_gpu=settings.max_gpu,
        default_timeout_seconds=settings.default_timeout_seconds,
    )
    cpu, memory = str(spec.get("cpu", "500m")), str(spec.get("memory", "1Gi"))
    timeout = int(spec.get("timeout_seconds", 900))
    validate_resources(cpu, memory, timeout, guardrails, gpu_count=0)
    check_user_quota(cpu, memory)

    simulated = bool(cluster.simulated) or is_showcase()
    kube = None if simulated else DirectKube(cluster)
    check_room(session, namespace, 1, active_in(session, namespace, kube))

    script_name = Path(spec["script"]).name
    files = {script_name: (_EXAMPLES / spec["script"]).read_text(encoding="utf-8")}
    env = {"CILITRAIN_RUN_KIND": "infer", "CILITRAIN_MODEL_LABEL": model_label(m)}
    if batch:
        files[BATCH_INPUT_FILE] = batch_jsonl(batch)
        env["CILITRAIN_INFER_BATCH"] = f"{SCRIPT_MOUNT_PATH}/{BATCH_INPUT_FILE}"
    else:
        env["CILITRAIN_INFER_INPUT"] = json.dumps(inp)
    _, (wait,) = wait_for_model(["python", "-u", f"{SCRIPT_MOUNT_PATH}/{script_name}"], [])
    steps = list(_BOOTSTRAP.get(spec.get("bootstrap") or "", []))
    script = "set -euo pipefail; " + "".join(f"{s}; " for s in steps) + wait

    run = Run(
        cluster_id=cluster.id,
        owner_user_id=_owner_id(session, cu),
        name=f"infer-{m.name}-v{m.version}" + ("-batch" if batch else ""),
        namespace=namespace,
        template=m.template,
        image=_template_row(m.template).get("image", "python:3.12-slim"),
        command="[]",
        cpu=cpu,
        memory=memory,
        timeout_seconds=timeout,
        status=QUEUED,
        kind="infer",
        model_id=m.id,
        infer_input=json.dumps(inp) if inp is not None else None,
        batch_rows=len(batch) if batch else None,
        script=files[script_name],
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    if batch:
        save_batch_inputs(run.id, batch)
    return submit_run(
        session,
        run,
        cluster,
        kube,
        files=files,
        command=["bash", "-lc"],
        args=[script],
        guardrails=guardrails,
        model_mount=True,
        extra_env=env,
    )


@router.post("/models/{model_id}/infer", response_model=RunOut)
def infer(
    model_id: str,
    body: InferCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    m = _get_model(session, cu, model_id)
    return start_inference(session, cu, m, body.input)


@router.post("/models/{model_id}/infer-batch", response_model=RunOut)
def infer_batch(
    model_id: str,
    body: InferBatchCreate,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> RunOut:
    m = _get_model(session, cu, model_id)
    spec = infer_spec(m.template)
    if not spec:
        raise HTTPException(status_code=400, detail=f"template {m.template} has no inference support")
    return start_inference(session, cu, m, None, batch=parse_batch_csv(spec, body.csv))


@router.get("/models/{model_id}/download")
def download_model(
    model_id: str,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> FileResponse:
    """A single-file model downloads as itself; several files come as one zip."""
    m = _get_model(session, cu, model_id)
    root = model_dir(m.id)
    files = sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []
    if not files:
        raise HTTPException(status_code=404, detail="model files missing on the platform")
    stem = f"{m.name}-v{m.version}"
    if len(files) == 1:
        return FileResponse(files[0], filename=f"{stem}-{files[0].name}")
    bundle = root.parent / f"{m.id}.zip"
    if not bundle.exists():
        tmp = bundle.with_suffix(".zip.part")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in files:
                zf.write(p, p.relative_to(root).as_posix())
        tmp.replace(bundle)
    return FileResponse(bundle, filename=f"{stem}.zip")
