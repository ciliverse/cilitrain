"""Online inference services: lifecycle, API keys, quota, and the manifests sent to the cluster."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.models.entities import Cluster, InferenceService, User
from app.services.auth import hash_password
from app.services.serving import build_deployment, build_service, resource_name, serve_command, serve_files
from app.services.showcase import ADMIN_PASS, GUEST_PASS, prepare_showcase

IRIS = {"sepal_length": 5.0, "sepal_width": 3.4, "petal_length": 1.5, "petal_width": 0.2}


def _client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", False)
    monkeypatch.setattr(settings, "jwt_secret", "test-secret")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "showcase", True)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as session:
        prepare_showcase(session)
    return TestClient(app), engine


def _login(client, user, pw):
    tok = client.post("/api/auth/login", json={"username": user, "password": pw}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def _warm(engine, service_id):
    with Session(engine) as s:
        svc = s.get(InferenceService, service_id)
        svc.started_at = datetime.now(timezone.utc) - timedelta(seconds=30)
        s.add(svc)
        s.commit()


def _iris(client, h):
    return next(m for m in client.get("/api/models", headers=h).json() if m["name"] == "iris-logreg")


def test_service_lifecycle_and_api_key(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    iris = _iris(client, h)

    r = client.post("/api/services", json={"model_id": iris["id"], "name": "iris-api"}, headers=h)
    assert r.status_code == 200, r.text
    created = r.json()
    key, svc = created["api_key"], created["service"]
    assert key.startswith("ctk_") and svc["api_key_prefix"] == key[:10]
    assert svc["status"] == "starting" and svc["endpoint_path"] == f"/api/serve/{svc['id']}/predict"

    early = client.post(f"/api/services/{svc['id']}/predict", json={"input": IRIS}, headers=h)
    assert early.status_code == 409

    _warm(engine, svc["id"])
    assert client.get(f"/api/services/{svc['id']}", headers=h).json()["status"] == "running"

    ui = client.post(f"/api/services/{svc['id']}/predict", json={"input": IRIS}, headers=h)
    assert ui.status_code == 200, ui.text
    assert ui.json()["output"]["label"] == "setosa"

    path = svc["endpoint_path"]
    assert client.post(path, json={"input": IRIS}).status_code == 401
    assert client.post(path, json={"input": IRIS}, headers={"Authorization": "Bearer ctk_wrong"}).status_code == 401
    many = client.post(
        path, json={"inputs": [IRIS, {**IRIS, "petal_length": 5.6, "petal_width": 2.2}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert many.status_code == 200, many.text
    assert [o["label"] for o in many.json()["outputs"]] == ["setosa", "virginica"]
    bad = client.post(path, json={"input": {"petal_width": 99}}, headers={"X-API-Key": key})
    assert bad.status_code == 400

    rotated = client.post(f"/api/services/{svc['id']}/rotate-key", headers=h).json()
    assert client.post(path, json={"input": IRIS}, headers={"Authorization": f"Bearer {key}"}).status_code == 401
    assert client.post(path, json={"input": IRIS}, headers={"Authorization": f"Bearer {rotated['api_key']}"}).status_code == 200

    detail = client.get(f"/api/services/{svc['id']}", headers=h).json()
    assert detail["requests"] == 3 and detail["errors"] == 0
    assert detail["avg_latency_ms"] is not None
    assert len(detail["recent"]) == 3 and detail["recent"][0]["ok"] is True
    assert "POST /predict" in client.get(f"/api/services/{svc['id']}/logs", headers=h).json()["logs"]

    scaled = client.put(f"/api/services/{svc['id']}/replicas", json={"replicas": 2}, headers=h)
    assert scaled.status_code == 200 and scaled.json()["replicas"] == 2
    sched = client.get("/api/scheduler", headers=h).json()
    assert any(i["kind"] == "service" and i["id"] == svc["id"] for i in sched["active"])

    assert client.delete(f"/api/services/{svc['id']}", headers=h).status_code == 409
    stopped = client.post(f"/api/services/{svc['id']}/stop", headers=h).json()
    assert stopped["status"] == "stopped"
    assert client.post(path, json={"input": IRIS}, headers={"Authorization": f"Bearer {rotated['api_key']}"}).status_code == 409
    assert client.post(f"/api/services/{svc['id']}/start", headers=h).json()["status"] == "starting"
    client.post(f"/api/services/{svc['id']}/stop", headers=h)
    assert client.delete(f"/api/services/{svc['id']}", headers=h).status_code == 200
    app.dependency_overrides.clear()


def test_showcase_seeds_a_running_service(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    guest = _login(client, "guest", GUEST_PASS)
    rows = client.get("/api/services", headers=guest).json()
    seed = next(s for s in rows if s["id"] == "seed-service-iris")
    assert seed["status"] == "running" and seed["model_label"] == "iris-logreg:1"
    out = client.post(f"/api/services/{seed['id']}/predict", json={"input": IRIS}, headers=guest)
    assert out.status_code == 200, out.text
    assert client.post(f"/api/services/{seed['id']}/stop", headers=guest).status_code == 403
    app.dependency_overrides.clear()


def test_viewer_cannot_deploy_and_quota_blocks(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    admin = _login(client, "admin", ADMIN_PASS)
    iris = _iris(client, admin)
    guest = _login(client, "guest", GUEST_PASS)
    assert client.post("/api/services", json={"model_id": iris["id"]}, headers=guest).status_code == 403

    monkeypatch.setattr(settings, "user_max_cpu", 2.0)
    first = client.post("/api/services", json={"model_id": iris["id"], "name": "iris-a", "replicas": 2}, headers=admin)
    assert first.status_code == 200, first.text
    second = client.post("/api/services", json={"model_id": iris["id"], "name": "iris-b"}, headers=admin)
    assert second.status_code == 409 and "per-user quota" in second.json()["detail"]
    sched = client.get("/api/scheduler", headers=admin).json()
    assert sched["usage"]["cpu"] >= 1.0
    app.dependency_overrides.clear()


def test_real_cluster_applies_manifests_and_proxies(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "auth_disabled", False)
    monkeypatch.setattr(settings, "jwt_secret", "test-secret")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "showcase", False)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    from app.models.entities import ModelVersion

    with Session(engine) as s:
        s.add(User(username="admin", password_hash=hash_password("admin123"), role="admin"))
        s.add(Cluster(id="c1", name="lab", kubeconfig_content="apiVersion: v1\nkind: Config\nclusters: []\n"))
        s.add(ModelVersion(id="m1", name="iris", version=1, template="sklearn-cpu"))
        s.commit()
    client = TestClient(app)
    tok = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    fake = MagicMock()
    fake.get_deployment.return_value = MagicMock(status=MagicMock(ready_replicas=1))
    fake.list_pods.return_value = []
    fake.proxy_post.return_value = {"output": {"type": "classification", "label": "setosa", "probabilities": {"setosa": 1.0}}}
    with patch("app.api.service_routes.DirectKube", return_value=fake):
        r = client.post("/api/services", json={"model_id": "m1", "cluster_id": "c1", "namespace": "ml"}, headers=h)
        assert r.status_code == 200, r.text
        sid = r.json()["service"]["id"]
        dep = fake.apply_deployment.call_args[0][0]
        assert dep["metadata"]["namespace"] == "ml" and dep["spec"]["replicas"] == 1
        assert fake.apply_service.called and fake.apply_configmap.called
        out = client.post(f"/api/services/{sid}/predict", json={"input": IRIS}, headers=h)
        assert out.status_code == 200, out.text
        ns, name, port, path, payload, _ = fake.proxy_post.call_args[0]
        assert (ns, name, port, path) == ("ml", resource_name(sid), 8080, "predict")
        assert payload == {"input": IRIS}
        client.post(f"/api/services/{sid}/stop", headers=h)
        fake.delete_serving.assert_called_once_with("ml", resource_name(sid))
    app.dependency_overrides.clear()


def test_manifests():
    svc = InferenceService(
        id="abcd-1234-efgh", name="iris-api", model_id="m1", cluster_id="c1", namespace="ml",
        template="sklearn-cpu", image="python:3.12-slim", cpu="500m", memory="512Mi", replicas=2,
    )
    files = serve_files("sklearn-cpu")
    assert set(files) == {"infer.py", "serve.py"}
    cmd = serve_command("sklearn-cpu", ["pip install -q scikit-learn"])
    assert cmd[:2] == ["bash", "-lc"] and "CILITRAIN_INFER_MODULE=infer" in cmd[2] and "pip install" in cmd[2]
    dep = build_deployment(svc, cmd, {})
    c = dep["spec"]["template"]["spec"]["containers"][0]
    assert dep["spec"]["replicas"] == 2
    assert c["readinessProbe"]["httpGet"] == {"path": "/healthz", "port": 8080}
    assert {m["mountPath"] for m in c["volumeMounts"]} == {"/workspace", "/model"}
    assert dep["spec"]["selector"]["matchLabels"] == {"cilitrain.io/service": svc.id}
    service = build_service(svc)
    assert service["spec"]["selector"] == {"cilitrain.io/service": svc.id}
    assert service["metadata"]["name"] == resource_name(svc.id) == dep["metadata"]["name"]
