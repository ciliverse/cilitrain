from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.models.entities import Cluster, Run, User
from app.services.auth import hash_password
from app.services.sync import sync_run


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
        id="r-slow",
        cluster_id="c1",
        name="nanogpt-cpu",
        namespace="default",
        template="nanogpt-cpu",
        image="python:3.12-slim",
        command='["python"]',
        args="[]",
        status="running",
        job_name="cilitrain-rslow",
    )
    fields.update(extra)
    with Session(engine) as session:
        run = Run(**fields)
        session.add(run)
        session.commit()
        session.refresh(run)
        return run


def test_get_run_returns_db_row_when_cluster_unreachable(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    token = _token(client)
    _add_run(engine)

    fake = MagicMock()
    fake.get_job.side_effect = HTTPException(status_code=504, detail="get job timed out")
    fake.pod_snapshot.side_effect = HTTPException(status_code=504, detail="list pods timed out")
    fake.list_events.return_value = []

    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.get("/api/runs/r-slow", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "r-slow"
    assert body["name"] == "nanogpt-cpu"
    assert body["status"] == "running"


def test_sync_run_skips_exec_harvest_on_detail_path(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        run = Run(
            id="r-h",
            cluster_id="c1",
            name="x",
            namespace="default",
            template="custom",
            image="python:3.12-slim",
            command="[]",
            status="running",
            job_name="job-h",
        )
        session.add(run)
        session.commit()
        session.refresh(run)

        job = MagicMock()
        job.status.succeeded = 0
        job.status.failed = 0
        job.status.active = 1
        job.status.conditions = []
        kube = MagicMock()
        kube.get_job.return_value = job
        kube.pod_snapshot.return_value = {
            "pod_name": "pod-h",
            "pod_phase": "Running",
            "status_reason": "Running",
            "status_message": None,
        }

        called = {"n": 0}

        def boom(*_a, **_k):
            called["n"] += 1
            raise AssertionError("harvest should be skipped")

        monkeypatch.setattr("app.services.sync.has_done_marker", boom)
        monkeypatch.setattr("app.services.sync.collect_from_pod", boom)

        out, snap = sync_run(session, run, kube, harvest=False)
        assert called["n"] == 0
        assert snap["pod_name"] == "pod-h"
        assert out.status == "running"
        kube.pod_logs.assert_not_called()
