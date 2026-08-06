"""Password hashing, JWT + server-side session auth."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt
from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import settings
from app.models.entities import AuthSession, User

ROLES = frozenset({"admin", "operator", "viewer"})
ALGORITHM = "HS256"


def _secret() -> str:
    if settings.jwt_secret:
        return settings.jwt_secret
    # Dev fallback — regenerate each process unless set; prefer env in prod.
    if not getattr(_secret, "_cached", None):
        _secret._cached = secrets.token_urlsafe(32)  # type: ignore[attr-defined]
    return _secret._cached  # type: ignore[attr-defined]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def issue_token(user: User, session_id: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(hours=max(1, settings.jwt_expire_hours))
    payload = {
        "user_id": user.id,
        "username": user.username,
        "role": user.role,
        "session_id": session_id,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _secret(), algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, _secret(), algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="invalid token") from exc


def create_session(session: Session, user: User) -> tuple[AuthSession, str]:
    now = datetime.now(timezone.utc)
    row = AuthSession(
        user_id=user.id,
        expires_at=now + timedelta(hours=max(1, settings.jwt_expire_hours)),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    token = issue_token(user, row.id)
    return row, token


def revoke_session(session: Session, session_id: str) -> None:
    row = session.get(AuthSession, session_id)
    if not row:
        return
    row.revoked_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()


def resolve_user_from_token(session: Session, token: str) -> tuple[User, AuthSession]:
    claims = decode_token(token)
    sid = claims.get("session_id")
    uid = claims.get("user_id")
    if not sid or not uid:
        raise HTTPException(status_code=401, detail="invalid token claims")
    auth_sess = session.get(AuthSession, sid)
    if not auth_sess or auth_sess.user_id != uid:
        raise HTTPException(status_code=401, detail="session not found")
    if auth_sess.revoked_at is not None:
        raise HTTPException(status_code=401, detail="session revoked")
    exp = auth_sess.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="session expired")
    user = session.get(User, uid)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="user inactive")
    return user, auth_sess


def bootstrap_admin(session: Session) -> User | None:
    """Create bootstrap admin if no users exist."""
    existing = session.exec(select(User).limit(1)).first()
    if existing:
        return None
    username = (settings.bootstrap_admin_user or "admin").strip() or "admin"
    password = settings.bootstrap_admin_password or "admin123"
    user = User(
        username=username,
        password_hash=hash_password(password),
        role="admin",
        # Force change in production by setting env after first login UI lands
        must_change_password=False,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def backfill_owners(session: Session) -> None:
    """Assign orphan runs/pipelines to the first admin."""
    admin = session.exec(select(User).where(User.role == "admin")).first()
    if not admin:
        return
    from app.models.entities import Pipeline, Run

    for run in session.exec(select(Run).where(Run.owner_user_id == None)).all():  # noqa: E711
        run.owner_user_id = admin.id
        session.add(run)
    for pipe in session.exec(select(Pipeline).where(Pipeline.owner_user_id == None)).all():  # noqa: E711
        pipe.owner_user_id = admin.id
        session.add(pipe)
    session.commit()
