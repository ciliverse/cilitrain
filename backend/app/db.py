from collections.abc import Generator

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine

from app.config import settings

engine = create_engine(
    settings.resolved_db_url(),
    connect_args={"check_same_thread": False},
)


def _ensure_column(conn, table: str, column: str, decl: str) -> None:
    try:
        cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})")).fetchall()}
    except Exception:  # noqa: BLE001
        return
    if not cols or column in cols:
        return
    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {decl}"))
    conn.commit()


def init_db() -> None:
    from app.models import entities as _entities  # noqa: F401

    SQLModel.metadata.create_all(engine)
    with engine.connect() as conn:
        _ensure_column(conn, "pipeline", "pvc_name", "VARCHAR")
        _ensure_column(conn, "pipeline", "owner_user_id", "VARCHAR")
        _ensure_column(conn, "run", "owner_user_id", "VARCHAR")
        _ensure_column(conn, "run", "gpu_count", "INTEGER DEFAULT 0")
        _ensure_column(conn, "cluster", "owner_user_id", "VARCHAR")


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session
