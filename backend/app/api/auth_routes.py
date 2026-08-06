"""Auth + user/grant management routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.api.deps import CurrentUser, get_current_user, require_admin
from app.config import settings
from app.db import get_session
from app.models.entities import AuthSession, Cluster, ClusterGrant, User
from app.services.auth import (
    ROLES,
    create_session,
    hash_password,
    revoke_session,
    verify_password,
)
from app.api.schemas import UtcDateTime

router = APIRouter(prefix="/api")


class LoginIn(BaseModel):
    username: str
    password: str


class LoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    id: str
    username: str
    role: str
    is_active: bool
    must_change_password: bool
    created_at: UtcDateTime


class UserCreate(BaseModel):
    username: str
    password: str = Field(min_length=6)
    role: str = "operator"


class UserUpdate(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6)


class GrantIn(BaseModel):
    cluster_id: str
    namespace: str = "default"


class GrantOut(BaseModel):
    id: str
    user_id: str
    cluster_id: str
    namespace: str
    created_at: UtcDateTime


class AuthStatusOut(BaseModel):
    auth_disabled: bool
    auth_required: bool
    has_users: bool


def _user_out(u: User) -> UserOut:
    return UserOut(
        id=u.id,
        username=u.username,
        role=u.role,
        is_active=u.is_active,
        must_change_password=u.must_change_password,
        created_at=u.created_at,
    )


@router.get("/auth/status", response_model=AuthStatusOut)
def auth_status(session: Session = Depends(get_session)) -> AuthStatusOut:
    has = session.exec(select(User).limit(1)).first() is not None
    return AuthStatusOut(
        auth_disabled=settings.auth_disabled,
        auth_required=not settings.auth_disabled,
        has_users=has,
    )


@router.post("/auth/login", response_model=LoginOut)
def login(body: LoginIn, session: Session = Depends(get_session)) -> LoginOut:
    if settings.auth_disabled:
        raise HTTPException(status_code=400, detail="auth disabled")
    user = session.exec(select(User).where(User.username == body.username.strip())).first()
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid username or password")
    _, token = create_session(session, user)
    return LoginOut(access_token=token, user=_user_out(user))


@router.post("/auth/logout")
def logout(
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> dict[str, str]:
    if cu.session_id:
        revoke_session(session, cu.session_id)
    return {"status": "ok"}


@router.get("/auth/me", response_model=UserOut)
def me(cu: Annotated[CurrentUser, Depends(get_current_user)]) -> UserOut:
    return _user_out(cu.user)


@router.post("/auth/change-password", response_model=UserOut)
def change_password(
    body: ChangePasswordIn,
    cu: Annotated[CurrentUser, Depends(get_current_user)],
    session: Session = Depends(get_session),
) -> UserOut:
    if settings.auth_disabled:
        raise HTTPException(status_code=400, detail="auth disabled")
    user = session.get(User, cu.user.id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="current password incorrect")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    user.updated_at = datetime.now(timezone.utc)
    session.add(user)
    session.commit()
    session.refresh(user)
    for s in session.exec(select(AuthSession).where(AuthSession.user_id == user.id)).all():
        if s.id != cu.session_id and s.revoked_at is None:
            revoke_session(session, s.id)
    return _user_out(user)


@router.get("/users", response_model=list[UserOut])
def list_users(
    _: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> list[UserOut]:
    rows = session.exec(select(User).order_by(User.created_at.desc())).all()
    return [_user_out(u) for u in rows]


@router.post("/users", response_model=UserOut)
def create_user(
    body: UserCreate,
    _: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> UserOut:
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(ROLES)}")
    if session.exec(select(User).where(User.username == body.username.strip())).first():
        raise HTTPException(status_code=409, detail="username taken")
    user = User(
        username=body.username.strip(),
        password_hash=hash_password(body.password),
        role=body.role,
        must_change_password=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return _user_out(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    body: UserUpdate,
    _: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> UserOut:
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if body.role is not None:
        if body.role not in ROLES:
            raise HTTPException(status_code=400, detail=f"role must be one of {sorted(ROLES)}")
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.password:
        user.password_hash = hash_password(body.password)
        user.must_change_password = True
    user.updated_at = datetime.now(timezone.utc)
    session.add(user)
    session.commit()
    session.refresh(user)
    return _user_out(user)


@router.get("/users/{user_id}/grants", response_model=list[GrantOut])
def list_grants(
    user_id: str,
    _: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> list[GrantOut]:
    rows = session.exec(select(ClusterGrant).where(ClusterGrant.user_id == user_id)).all()
    return [
        GrantOut(
            id=r.id,
            user_id=r.user_id,
            cluster_id=r.cluster_id,
            namespace=r.namespace,
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.post("/users/{user_id}/grants", response_model=GrantOut)
def add_grant(
    user_id: str,
    body: GrantIn,
    _: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> GrantOut:
    if not session.get(User, user_id):
        raise HTTPException(status_code=404, detail="user not found")
    if not session.get(Cluster, body.cluster_id):
        raise HTTPException(status_code=404, detail="cluster not found")
    exists = session.exec(
        select(ClusterGrant).where(
            ClusterGrant.user_id == user_id,
            ClusterGrant.cluster_id == body.cluster_id,
            ClusterGrant.namespace == body.namespace,
        )
    ).first()
    if exists:
        raise HTTPException(status_code=409, detail="grant already exists")
    g = ClusterGrant(user_id=user_id, cluster_id=body.cluster_id, namespace=body.namespace)
    session.add(g)
    session.commit()
    session.refresh(g)
    return GrantOut(
        id=g.id,
        user_id=g.user_id,
        cluster_id=g.cluster_id,
        namespace=g.namespace,
        created_at=g.created_at,
    )


@router.delete("/users/{user_id}/grants/{grant_id}")
def delete_grant(
    user_id: str,
    grant_id: str,
    _: Annotated[CurrentUser, Depends(require_admin)],
    session: Session = Depends(get_session),
) -> dict[str, str]:
    g = session.get(ClusterGrant, grant_id)
    if not g or g.user_id != user_id:
        raise HTTPException(status_code=404, detail="grant not found")
    session.delete(g)
    session.commit()
    return {"status": "deleted"}
