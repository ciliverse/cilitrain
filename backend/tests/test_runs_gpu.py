from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.models.entities import Cluster, User
from app.services.auth import hash_password


def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", False)
    monkeypatch.setattr(settings, "jwt_secret", "test-secret")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "max_gpu", 2)
    monkeypatch.setattr(settings, "gpu_probe_skip", False)
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
        session.add(
            User(username="admin", password_hash=hash_password("admin123"), role="admin")
        )
        session.add(
            Cluster(
                id="c1",
                name="kind",
                kubeconfig_content="apiVersion: v1\nkind: Config\nclusters: []\n",
            )
        )
        session.commit()
    return TestClient(app), engine


def _token(client: TestClient) -> str:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
    assert r.status_code == 200
    return r.json()["access_token"]


def _run_body(**extra):
    body = {
        "cluster_id": "c1",
        "name": "gpu-test",
        "namespace": "default",
        "template": "custom",
        "image": "busybox",
        "command": ["sh"],
        "args": ["-c", "echo ok"],
        "cpu": "100m",
        "memory": "128Mi",
        "timeout_seconds": 60,
        "gpu_count": 0,
    }
    body.update(extra)
    return body


def test_create_run_gpu_rejected_without_cluster_gpu(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    token = _token(client)
    fake = MagicMock()
    fake.list_node_allocatable.return_value = [{"status": {"allocatable": {"cpu": "4"}}}]
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.post(
            "/api/runs",
            json=_run_body(gpu_count=1),
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 400
    assert "nvidia.com/gpu" in r.json()["detail"]
    fake.create_job.assert_not_called()
    app.dependency_overrides.clear()


def test_create_run_gpu_ok_when_cluster_has_gpu(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    token = _token(client)
    fake = MagicMock()
    fake.list_node_allocatable.return_value = [
        {"status": {"allocatable": {"nvidia.com/gpu": "1"}}}
    ]
    fake.count_active_jobs.return_value = 0
    fake.create_job.return_value = None

    with (
        patch("app.api.routes.DirectKube", return_value=fake),
        patch("app.api.routes.sync_run", side_effect=lambda session, run, kube: (run, {})),
    ):
        r = client.post(
            "/api/runs",
            json=_run_body(gpu_count=1),
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["gpu_count"] == 1
    assert "nvidia.com/gpu" in (data.get("job_yaml") or "")
    fake.create_job.assert_called_once()
    job = fake.create_job.call_args[0][0]
    res = job["spec"]["template"]["spec"]["containers"][0]["resources"]
    assert res["limits"]["nvidia.com/gpu"] == "1"
    app.dependency_overrides.clear()


def test_create_run_cpu_skips_gpu_probe(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    token = _token(client)
    fake = MagicMock()
    fake.count_active_jobs.return_value = 0
    fake.create_job.return_value = None
    with (
        patch("app.api.routes.DirectKube", return_value=fake),
        patch("app.api.routes.sync_run", side_effect=lambda session, run, kube: (run, {})),
    ):
        r = client.post(
            "/api/runs",
            json=_run_body(gpu_count=0),
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200, r.text
    fake.list_node_allocatable.assert_not_called()
    app.dependency_overrides.clear()
