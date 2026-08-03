"""Advance simple sequential pipelines when step runs complete."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session

from app.models.entities import Pipeline, Run


def loads_steps(raw: str) -> list[dict[str, Any]]:
    data = json.loads(raw or "[]")
    return data if isinstance(data, list) else []


def loads_ids(raw: str) -> list[str]:
    data = json.loads(raw or "[]")
    return [str(x) for x in data] if isinstance(data, list) else []


def dumps(data: Any) -> str:
    return json.dumps(data)


def pipeline_out(p: Pipeline) -> dict[str, Any]:
    return {
        "id": p.id,
        "name": p.name,
        "cluster_id": p.cluster_id,
        "namespace": p.namespace,
        "status": p.status,
        "current_step": p.current_step,
        "steps": loads_steps(p.steps_json),
        "run_ids": loads_ids(p.run_ids_json),
        "error_message": p.error_message,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "finished_at": p.finished_at,
    }


def mark(session: Session, p: Pipeline, **fields: Any) -> Pipeline:
    for k, v in fields.items():
        setattr(p, k, v)
    p.updated_at = datetime.now(timezone.utc)
    session.add(p)
    session.commit()
    session.refresh(p)
    return p
