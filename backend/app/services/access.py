"""Authorization helpers: roles + cluster/namespace grants."""

from __future__ import annotations

from sqlmodel import Session, select

from app.models.entities import ClusterGrant, Pipeline, Run, User


def is_admin(user: User) -> bool:
    return user.role == "admin"


def has_grant(session: Session, user_id: str, cluster_id: str, namespace: str) -> bool:
    row = session.exec(
        select(ClusterGrant).where(
            ClusterGrant.user_id == user_id,
            ClusterGrant.cluster_id == cluster_id,
            ClusterGrant.namespace == namespace,
        )
    ).first()
    return row is not None


def can_create_run(session: Session, user: User, cluster_id: str, namespace: str) -> bool:
    if is_admin(user):
        return True
    if user.role == "viewer":
        return False
    return has_grant(session, user.id, cluster_id, namespace)


def can_access_run(session: Session, user: User, run: Run) -> bool:
    if is_admin(user):
        return True
    if run.owner_user_id == user.id:
        return True
    return has_grant(session, user.id, run.cluster_id, run.namespace)


def can_mutate_run(session: Session, user: User, run: Run) -> bool:
    if user.role == "viewer":
        return False
    return can_access_run(session, user, run)


def can_access_pipeline(session: Session, user: User, pipe: Pipeline) -> bool:
    if is_admin(user):
        return True
    if pipe.owner_user_id == user.id:
        return True
    return has_grant(session, user.id, pipe.cluster_id, pipe.namespace)


def visible_cluster_ids(session: Session, user: User) -> set[str] | None:
    """None means all clusters (admin)."""
    if is_admin(user):
        return None
    rows = session.exec(select(ClusterGrant).where(ClusterGrant.user_id == user.id)).all()
    return {r.cluster_id for r in rows}
