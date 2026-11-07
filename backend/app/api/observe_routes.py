"""Observability: node CPU/GPU plus training and inference metrics."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.api.deps import CurrentUser, get_current_user
from app.db import get_session
from app.models.entities import Cluster
from app.services.access import visible_cluster_ids
from app.services.cluster.direct import DirectKube
from app.services.observe import collect_observe

router = APIRouter(prefix="/api")


@router.get("/observe")
def observe(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    cluster_id: str = "",
    session: Session = Depends(get_session),
) -> dict:
    allowed = visible_cluster_ids(session, cu.user)
    chosen: Cluster | None = None
    if cluster_id:
        chosen = session.get(Cluster, cluster_id)
        if not chosen or (allowed is not None and chosen.id not in allowed):
            raise HTTPException(status_code=404, detail="cluster not found")
    else:
        rows = session.exec(select(Cluster)).all()
        visible = [c for c in rows if allowed is None or c.id in allowed]
        visible.sort(key=lambda c: c.created_at, reverse=True)
        chosen = next((c for c in visible if not getattr(c, "simulated", False)), None) or (
            visible[0] if visible else None
        )
    if not chosen:
        return {
            "cluster_id": "",
            "cluster_name": "",
            "clusters": [],
            "cluster_error": None,
            "sources": {"metrics_server": False, "prometheus": False, "gpu_util": False},
            "totals": {
                "cpu_alloc": 0,
                "cpu_used": None,
                "mem_alloc_mi": 0,
                "mem_used_mi": None,
                "gpu_alloc": 0,
                "gpu_util": None,
                "gpu_count": 0,
            },
            "nodes": [],
            "training": [],
            "inference": [],
        }
    kube = None
    if not getattr(chosen, "simulated", False):
        try:
            kube = DirectKube(chosen)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
            payload = collect_observe(session, cu.user, chosen, None)
            payload["cluster_error"] = detail
            return payload
    return collect_observe(session, cu.user, chosen, kube)
