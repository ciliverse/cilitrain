import time
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
                name="lab-135",
                kubeconfig_content="apiVersion: v1\nkind: Config\nclusters: []\n",
            )
        )
        session.commit()
    return TestClient(app)


def _token(client: TestClient) -> str:
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
    assert r.status_code == 200
    return r.json()["access_token"]


def test_probe_reachable_when_apiserver_answers(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    token = _token(client)
    fake = MagicMock()
    fake.probe.return_value = {"reachable": True, "message": "v1.35.0"}
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.get("/api/clusters/c1/probe", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is True
    assert body["cluster_id"] == "c1"
    assert body["name"] == "lab-135"
    assert body["message"] == "v1.35.0"


def test_probe_unreachable_when_apiserver_down(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    token = _token(client)
    fake = MagicMock()
    fake.probe.return_value = {"reachable": False, "message": "timed out"}
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.get("/api/clusters/c1/probe", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["reachable"] is False
    assert "timed out" in r.json()["message"]


def test_probe_missing_cluster_is_404(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    token = _token(client)
    r = client.get("/api/clusters/nope/probe", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 404


_DUMMY_KUBECONFIG = """
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://127.0.0.1:1
  name: t
contexts:
- context:
    cluster: t
    user: t
  name: t
current-context: t
users:
- name: t
  user:
    token: x
"""


def test_direct_probe_returns_before_hung_apiserver():
    from app.models.entities import Cluster
    from app.services.cluster.direct import DirectKube

    kube = DirectKube(
        Cluster(id="x", name="x", kubeconfig_content=_DUMMY_KUBECONFIG),
    )

    def hang(*_a, **_k):
        time.sleep(20)

    with patch("app.services.cluster.direct.client.VersionApi") as version_api:
        version_api.return_value.get_code.side_effect = hang
        started = time.monotonic()
        result = kube.probe(timeout=0.3)
        elapsed = time.monotonic() - started
    assert result["reachable"] is False
    assert "timed out" in result["message"]
    assert elapsed < 2.0

