from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.models.entities import Cluster, Run, User
from app.services.auth import hash_password


def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", False)
    monkeypatch.setattr(settings, "jwt_secret", "test-secret")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as session:
        session.add(User(username="admin", password_hash=hash_password("admin123"), role="admin"))
        session.add(
            Cluster(
                id="c1",
                name="lab",
                kubeconfig_content="apiVersion: v1\nkind: Config\nclusters: []\n",
            )
        )
        session.commit()
    return TestClient(app), engine


def _token(client: TestClient) -> str:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
    assert r.status_code == 200
    return r.json()["access_token"]


def _add_run(engine, **extra) -> Run:
    fields = dict(
        id="r-fail",
        cluster_id="c1",
        name="sklearn-cpu",
        namespace="default",
        template="custom",
        image="python:3.12-slim",
        command='["python"]',
        args="[]",
        status="failed",
        job_name="cilitrain-rfail",
        error_message="ErrImagePull",
    )
    fields.update(extra)
    with Session(engine) as session:
        run = Run(**fields)
        session.add(run)
        session.commit()
        session.refresh(run)
        return run


def test_cleanup_failed_run_deletes_job_keeps_record(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    token = _token(client)
    _add_run(engine)
    fake = MagicMock()
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.post(
            "/api/runs/r-fail/cleanup",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["cleaned"] is True
    fake.delete_job.assert_called_once_with("default", "cilitrain-rfail")
    with Session(engine) as session:
        run = session.get(Run, "r-fail")
        assert run is not None
        assert run.status == "failed"
        assert run.error_message == "ErrImagePull"


def test_cleanup_timeout_run_ok(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    token = _token(client)
    _add_run(engine, id="r-to", status="timeout", job_name="cilitrain-rto", error_message="DeadlineExceeded")
    fake = MagicMock()
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.post(
            "/api/runs/r-to/cleanup",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    assert r.json()["cleaned"] is True


def test_cleanup_running_run_is_409(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    token = _token(client)
    _add_run(engine, id="r-run", status="running", job_name="cilitrain-rrun", error_message=None)
    r = client.post(
        "/api/runs/r-run/cleanup",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 409


def test_cancel_failed_run_is_still_409(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    token = _token(client)
    _add_run(engine)
    r = client.post(
        "/api/runs/r-fail/cancel",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 409


def test_cleanup_without_job_name_is_ok_not_cleaned(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    token = _token(client)
    _add_run(engine, job_name=None)
    r = client.post(
        "/api/runs/r-fail/cleanup",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert r.json()["cleaned"] is False
