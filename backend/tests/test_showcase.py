"""Public exhibit: fail closed, seeded history, simulated submit."""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.services.showcase import ADMIN_PASS, GUEST_PASS, advance_simulated, prepare_showcase


def _client(tmp_path, monkeypatch, *, showcase: bool):
    monkeypatch.setattr(settings, "auth_disabled", False)
    monkeypatch.setattr(settings, "jwt_secret", "test-secret")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "showcase", showcase)
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
    if showcase:
        with Session(engine) as session:
            prepare_showcase(session)
    return TestClient(app), engine


def test_showcase_fail_closed(tmp_path, monkeypatch):
    client, _engine = _client(tmp_path, monkeypatch, showcase=False)
    body = client.get("/api/showcase").json()
    assert body["showcase"] is False
    assert body["accounts"] == []
    app.dependency_overrides.clear()


def test_showcase_seed_submit_and_protect(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch, showcase=True)
    info = client.get("/api/showcase").json()
    assert info["showcase"] is True
    assert info["accounts"][0]["username"] == "admin"
    assert info["accounts"][0]["password"] == ADMIN_PASS

    denied = client.post(
        "/api/clusters",
        json={"name": "real", "kubeconfig_content": "apiVersion: v1\nkind: Config\n"},
    )
    assert denied.status_code == 401

    login = client.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PASS})
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    blocked = client.post(
        "/api/clusters",
        json={"name": "real", "kubeconfig_content": "apiVersion: v1\nkind: Config\n"},
        headers=headers,
    )
    assert blocked.status_code == 403

    runs = client.get("/api/runs", headers=headers)
    assert runs.status_code == 200
    names = {row["name"] for row in runs.json()}
    assert {"nanogpt-cpu", "sklearn-cpu", "monitor-demo", "gpu-smoke"} <= names
    seed = next(row for row in runs.json() if row["name"] == "nanogpt-cpu")
    assert seed["showcase_seed"] is True
    assert seed["status"] == "succeeded"
    gone = client.delete(f"/api/runs/{seed['id']}", headers=headers)
    assert gone.status_code == 403

    guest = client.post("/api/auth/login", json={"username": "guest", "password": GUEST_PASS})
    assert guest.status_code == 200
    guest_headers = {"Authorization": f"Bearer {guest.json()['access_token']}"}
    guest_runs = client.get("/api/runs", headers=guest_headers)
    assert guest_runs.status_code == 200
    assert len(guest_runs.json()) >= 4
    guest_create = client.post(
        "/api/runs",
        json={
            "cluster_id": "showcase-demo",
            "name": "guest-try",
            "namespace": "default",
            "template": "custom",
            "image": "python:3.12-slim",
            "command": ["python", "-c", "print(1)"],
            "cpu": "100m",
            "memory": "128Mi",
            "timeout_seconds": 600,
        },
        headers=guest_headers,
    )
    assert guest_create.status_code == 403

    created = client.post(
        "/api/runs",
        json={
            "cluster_id": "showcase-demo",
            "name": "visitor-demo",
            "namespace": "default",
            "template": "custom",
            "image": "python:3.12-slim",
            "command": ["python", "-c", "print(1)"],
            "cpu": "100m",
            "memory": "128Mi",
            "timeout_seconds": 600,
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["simulated"] is True
    assert body["status"] in {"pending", "running"}
    run_id = body["id"]

    with Session(engine) as session:
        from app.models.entities import Run

        row = session.get(Run, run_id)
        assert row is not None
        row.created_at = row.started_at = datetime.now(timezone.utc) - timedelta(seconds=60)
        session.add(row)
        session.commit()
        advance_simulated(session, row)

    detail = client.get(f"/api/runs/{run_id}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["status"] == "succeeded"
    logs = client.get(f"/api/runs/{run_id}/logs", headers=headers)
    assert "loss" in logs.json()["logs"]
    metrics = client.get(f"/api/runs/{run_id}/metrics", headers=headers)
    assert metrics.status_code == 200
    assert metrics.json()["resource"]["series"]

    probe = client.get("/api/clusters/showcase-demo/probe", headers=headers)
    assert probe.status_code == 200
    assert probe.json()["reachable"] is True

    with Session(engine) as session:
        from app.models.entities import Run

        before = session.get(Run, run_id)
        assert before is not None
        prepare_showcase(session)
        assert session.get(Run, run_id) is None
        assert session.get(Run, "seed-nanogpt") is not None

    app.dependency_overrides.clear()


def test_showcase_links_cilikube_exhibit(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "showcase_cilikube_url", "https://console.example.com")
    client, _engine = _client(tmp_path, monkeypatch, showcase=True)
    login = client.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PASS})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    settings_body = client.get("/api/settings", headers=headers).json()
    assert settings_body["cilikube_base_url"] == "https://console.example.com"
    put_blocked = client.put(
        "/api/settings",
        json={"cilikube_base_url": "https://evil.example.com"},
        headers=headers,
    )
    assert put_blocked.status_code == 403
    nano = client.get("/api/runs/seed-nanogpt", headers=headers).json()
    assert nano["job_yaml"] and "batch/v1" in nano["job_yaml"]
    assert nano["script"] and "MiniGPT" in nano["script"]
    nano_m = client.get("/api/runs/seed-nanogpt/metrics", headers=headers).json()
    assert nano_m["summary"].get("params") == 815429
    assert any(a["path"] == "sample.txt" for a in nano_m["artifacts"])
    sk_m = client.get("/api/runs/seed-sklearn/metrics", headers=headers).json()
    assert sk_m["summary"].get("acc") == 0.9737
    runs = client.get("/api/runs", headers=headers).json()
    links = runs[0]["cilikube_links"]
    assert links["console"] == "https://console.example.com/overview"
    assert links["job"] is None
    app.dependency_overrides.clear()


def test_showcase_curve_matches_summary(tmp_path, monkeypatch):
    client, _engine = _client(tmp_path, monkeypatch, showcase=True)
    login = client.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PASS})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    m = client.get("/api/runs/seed-nanogpt/metrics", headers=headers).json()
    series = m["series"]
    assert series[-1]["epoch"] == 8
    assert series[-1]["loss"] == m["summary"]["loss"]
    assert series[-1]["val_loss"] == m["summary"]["val_loss"]
    assert max(p["x"] for p in series) == 8
    trends = client.get(
        "/api/run-trends?ids=seed-nanogpt,seed-sklearn,missing", headers=headers
    ).json()["trends"]
    assert set(trends) == {"seed-nanogpt", "seed-sklearn"}
    assert trends["seed-nanogpt"]["key"] == "loss"
    assert trends["seed-nanogpt"]["last"] == m["summary"]["loss"]
    assert len(trends["seed-nanogpt"]["points"]) <= 32
    app.dependency_overrides.clear()
