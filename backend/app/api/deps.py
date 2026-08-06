"""FastAPI dependencies for auth."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session

from app.config import settings
from app.db import get_session
from app.models.entities import User
from app.services.auth import resolve_user_from_token


class CurrentUser:
    def __init__(self, user: User, session_id: str | None = None) -> None:
        self.user = user
        self.session_id = session_id


def _bearer(request: Request) -> str | None:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def get_current_user(
    request: Request,
    session: Session = Depends(get_session),
) -> CurrentUser:
    if settings.auth_disabled:
        # Dev bypass: synthetic admin (not persisted)
        u = User(
            id="dev-admin",
            username="dev",
            password_hash="!",
            role="admin",
            is_active=True,
        )
        return CurrentUser(u, session_id=None)

    token = _bearer(request)
    if not token:
        raise HTTPException(status_code=401, detail="authentication required")
    user, auth_sess = resolve_user_from_token(session, token)
    if user.must_change_password:
        path = request.url.path
        allowed = {
            "/api/auth/me",
            "/api/auth/logout",
            "/api/auth/change-password",
            "/api/auth/status",
        }
        if path not in allowed:
            raise HTTPException(status_code=403, detail="password change required")
    return CurrentUser(user, session_id=auth_sess.id)


def require_admin(cu: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
    if cu.user.role != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return cu
