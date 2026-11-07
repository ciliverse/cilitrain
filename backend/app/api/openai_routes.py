"""Public OpenAI-compatible routes. The API key selects the service."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session

from app.api.deps import CurrentUser, get_current_user
from app.api.service_routes import _get, _is_provider, _kube
from app.db import get_session
from app.services.openai_gateway import complete
from app.services.serving import find_service_by_key

router = APIRouter()


def _bearer(request: Request) -> str:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("X-API-Key") or "").strip()


def _service_for_key(session: Session, request: Request):
    svc = find_service_by_key(session, _bearer(request))
    if svc is None:
        raise HTTPException(status_code=401, detail="invalid API key")
    if svc.status not in ("running", "starting"):
        raise HTTPException(status_code=409, detail=f"service is {svc.status}")
    return svc


@router.get("/v1/models")
@router.get("/api/v1/models")
def openai_models(request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    svc = _service_for_key(session, request)
    return {"object": "list", "data": [{"id": svc.name, "object": "model", "owned_by": "cilitrain"}]}


@router.post("/v1/chat/completions")
@router.post("/api/v1/chat/completions")
async def openai_chat(request: Request, session: Session = Depends(get_session)) -> Any:
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    svc = _service_for_key(session, request)
    return await complete(session, svc, body, None if _is_provider(svc) else _kube(session, svc))


@router.post("/api/services/{service_id}/chat")
async def chat_as_user(
    service_id: str,
    request: Request,
    cu: CurrentUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Any:
    """Try a chat completion from the console, with the signed-in session."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object required")
    svc = _get(session, cu, service_id)
    return await complete(session, svc, body, None if _is_provider(svc) else _kube(session, svc))
