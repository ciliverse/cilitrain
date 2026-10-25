from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
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
    monkeypatch.setattr(settings, "default_concurrency", 3)
    monkeypatch.setattr(settings, "gpu_probe_skip", True)
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


def _body():
    return {
        "cluster_id": "c1",
        "name": "blocked",
        "namespace": "default",
        "template": "custom",
        "image": "busybox",
        "command": ["true"],
        "args": [],
        "cpu": "100m",
        "memory": "128Mi",
        "timeout_seconds": 60,
        "gpu_count": 0,
    }


def test_full_namespace_queues_run_then_dispatches(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = {"Authorization": f"Bearer {_token(client)}"}
    fake = MagicMock()
    fake.count_active_jobs.return_value = 3
    fake.get_job.return_value = None
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.post("/api/runs", json=_body(), headers=h)
        assert r.status_code == 200, r.text
        run = r.json()
        assert run["status"] == "queued"
        assert run["queue_position"] == 1
        assert run["job_name"] is None
        fake.create_job.assert_not_called()

        fake.count_active_jobs.return_value = 2
        fake.create_job.return_value = MagicMock()
        client.get("/api/runs", headers=h)
    fake.create_job.assert_called_once()
    with Session(engine) as session:
        row = session.get(Run, run["id"])
        assert row.status != "queued"
        assert row.started_at is not None


def test_queue_full_rejects_without_persisting(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(settings, "max_queued", 0)
    token = _token(client)
    fake = MagicMock()
    fake.count_active_jobs.return_value = 3
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.post("/api/runs", json=_body(), headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 429
    assert "queue is full" in r.json()["detail"]
    fake.create_job.assert_not_called()
    with Session(engine) as session:
        assert session.exec(select(Run)).all() == []


def test_cancel_queued_run(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    h = {"Authorization": f"Bearer {_token(client)}"}
    fake = MagicMock()
    fake.count_active_jobs.return_value = 3
    with patch("app.api.routes.DirectKube", return_value=fake):
        run = client.post("/api/runs", json=_body(), headers=h).json()
        r = client.post(f"/api/runs/{run['id']}/cancel", headers=h)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    fake.delete_job.assert_not_called()


def test_user_limit_queues(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(settings, "user_max_active", 1)
    h = {"Authorization": f"Bearer {_token(client)}"}
    fake = MagicMock()
    fake.count_active_jobs.return_value = 0
    fake.create_job.return_value = MagicMock()
    fake.get_job.return_value = MagicMock(status=MagicMock(succeeded=0, failed=0, active=1, conditions=[]))
    fake.pod_snapshot.return_value = {"pod_name": None, "pod_phase": "Running"}
    with patch("app.api.routes.DirectKube", return_value=fake):
        first = client.post("/api/runs", json=_body(), headers=h).json()
        second = client.post("/api/runs", json=_body(), headers=h).json()
    assert first["status"] in ("pending", "running")
    assert second["status"] == "queued"
    assert second["queue_reason"] == "user_active"


def _running_kube():
    fake = MagicMock()
    fake.count_active_jobs.return_value = 0
    fake.create_job.return_value = MagicMock()
    fake.get_job.return_value = MagicMock(status=MagicMock(succeeded=0, failed=0, active=1, conditions=[]))
    fake.pod_snapshot.return_value = {"pod_name": None, "pod_phase": "Running"}
    return fake


def test_user_cpu_quota_queues_and_rejects_oversized(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(settings, "user_max_cpu", 1.0)
    monkeypatch.setattr(settings, "user_max_memory_gi", 4.0)
    h = {"Authorization": f"Bearer {_token(client)}"}
    with patch("app.api.routes.DirectKube", return_value=_running_kube()):
        big = client.post("/api/runs", json={**_body(), "cpu": "2"}, headers=h)
        assert big.status_code == 400 and "per-user quota (1 cores)" in big.json()["detail"]
        mem = client.post("/api/runs", json={**_body(), "memory": "8Gi"}, headers=h)
        assert mem.status_code == 400 and "4 Gi" in mem.json()["detail"]

        first = client.post("/api/runs", json={**_body(), "cpu": "600m"}, headers=h).json()
        second = client.post("/api/runs", json={**_body(), "cpu": "600m"}, headers=h).json()
        small = client.post("/api/runs", json={**_body(), "cpu": "300m"}, headers=h).json()
        sched = client.get("/api/scheduler", headers=h).json()
    assert first["status"] in ("pending", "running")
    assert second["status"] == "queued" and second["queue_reason"] == "user_quota"
    assert small["status"] in ("pending", "running")
    assert sched["quota"]["cpu"] == 1.0
    assert sched["usage"]["cpu"] == 0.9 and sched["usage"]["active"] == 2
    assert sched["my_queued"] == 1
    ns = sched["namespaces"][0]
    assert (ns["cluster_name"], ns["namespace"], ns["active"], ns["queued"]) == ("lab", "default", 2, 1)


def test_namespace_wait_reason(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    h = {"Authorization": f"Bearer {_token(client)}"}
    fake = MagicMock()
    fake.count_active_jobs.return_value = 3
    with patch("app.api.routes.DirectKube", return_value=fake):
        run = client.post("/api/runs", json=_body(), headers=h).json()
    assert run["queue_reason"] == "namespace"


def test_priority_reorders_queue_and_dispatch(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = {"Authorization": f"Bearer {_token(client)}"}
    fake = MagicMock()
    fake.count_active_jobs.return_value = 3
    fake.get_job.return_value = None
    with patch("app.api.routes.DirectKube", return_value=fake):
        low = client.post("/api/runs", json={**_body(), "name": "low", "priority": -1}, headers=h).json()
        client.post("/api/runs", json={**_body(), "name": "normal"}, headers=h)
        client.post("/api/runs", json={**_body(), "name": "high", "priority": 1}, headers=h)
        sched = client.get("/api/scheduler", headers=h).json()
        assert [(q["name"], q["queue_position"]) for q in sched["queue"]] == [("high", 1), ("normal", 2), ("low", 3)]

        r = client.put(f"/api/runs/{low['id']}/priority", json={"priority": 1}, headers=h)
        assert r.status_code == 200 and r.json()["priority"] == 1
        sched = client.get("/api/scheduler", headers=h).json()
        assert [q["name"] for q in sched["queue"]] == ["low", "high", "normal"]
        assert [q["queue_position"] for q in sched["queue"]] == [1, 2, 3]

        fake.count_active_jobs.side_effect = lambda _ns: 2 + fake.create_job.call_count
        fake.create_job.return_value = MagicMock()
        client.get("/api/runs", headers=h)
    with Session(engine) as session:
        started = [r.name for r in session.exec(select(Run)).all() if r.status != "queued"]
    assert started == ["low"]


def test_scheduled_start_waits_then_start_now(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    client, _ = _client(tmp_path, monkeypatch)
    h = {"Authorization": f"Bearer {_token(client)}"}
    later = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    too_late = (datetime.now(timezone.utc) + timedelta(days=8)).isoformat()
    with patch("app.api.routes.DirectKube", return_value=_running_kube()):
        bad = client.post("/api/runs", json={**_body(), "start_at": too_late}, headers=h)
        assert bad.status_code == 400 and "7 days" in bad.json()["detail"]
        run = client.post("/api/runs", json={**_body(), "start_at": later}, headers=h).json()
        assert run["status"] == "queued" and run["queue_reason"] == "scheduled"
        assert run["not_before"] and run["queue_position"] is None
        r = client.post(f"/api/runs/{run['id']}/start-now", headers=h)
    assert r.status_code == 200
    assert r.json()["status"] in ("pending", "running")


def test_high_priority_is_admin_only(tmp_path, monkeypatch):
    from app.models.entities import ClusterGrant

    client, engine = _client(tmp_path, monkeypatch)
    with Session(engine) as session:
        op = User(username="op", password_hash=hash_password("op123456"), role="operator")
        session.add(op)
        session.commit()
        session.add(ClusterGrant(user_id=op.id, cluster_id="c1", namespace="default"))
        session.commit()
    tok = client.post("/api/auth/login", json={"username": "op", "password": "op123456"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    fake = MagicMock()
    fake.count_active_jobs.return_value = 3
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.post("/api/runs", json={**_body(), "priority": 1}, headers=h)
        assert r.status_code == 403
        run = client.post("/api/runs", json=_body(), headers=h).json()
        assert client.put(f"/api/runs/{run['id']}/priority", json={"priority": 1}, headers=h).status_code == 403
        r = client.put(f"/api/runs/{run['id']}/priority", json={"priority": -1}, headers=h)
    assert r.status_code == 200 and r.json()["priority"] == -1


def test_settings_exposes_guardrails(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    token = _token(client)
    r = client.get("/api/settings", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["max_gpu"] == settings.max_gpu
    assert body["max_cpu"] == settings.max_cpu
    assert body["max_memory_gi"] == settings.max_memory_gi
    assert body["default_concurrency"] == 3
    assert "prometheus_url" in body
