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
    fake.list_node_allocatable.return_value = [
        {"status": {"allocatable": {"nvidia.com/gpu": "2"}}},
    ]
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.get("/api/clusters/c1/probe", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is True
    assert body["cluster_id"] == "c1"
    assert body["name"] == "lab-135"
    assert body["message"] == "v1.35.0"
    assert body["gpu_allocatable"] == 2


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


def test_update_cluster_renames(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    token = _token(client)
    headers = {"Authorization": f"Bearer {token}"}
    r = client.patch("/api/clusters/c1", json={"name": "lab-renamed"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["name"] == "lab-renamed"
    listed = client.get("/api/clusters", headers=headers)
    assert listed.json()[0]["name"] == "lab-renamed"
    blank = client.patch("/api/clusters/c1", json={"name": "  "}, headers=headers)
    assert blank.status_code == 400


def test_workloads_returns_platform_jobs(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    token = _token(client)
    fake = MagicMock()
    fake.list_training_workloads.return_value = {
        "items": [
            {
                "name": "nanogpt-cpu-4821",
                "display_name": "nanoGPT",
                "namespace": "train",
                "run_id": "run-1",
                "status": "running",
                "created_at": None,
            }
        ],
        "nodes": [{"name": "node-a", "ready": True, "cpu": "8", "memory": "16Gi", "gpu": 0}],
    }
    with patch("app.api.routes.DirectKube", return_value=fake):
        r = client.get(
            "/api/clusters/c1/workloads",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["cluster_id"] == "c1"
    assert body["items"][0]["name"] == "nanogpt-cpu-4821"
    assert body["items"][0]["namespace"] == "train"
    assert body["items"][0]["status"] == "running"
    assert body["nodes"][0]["name"] == "node-a"
    fake.list_training_workloads.assert_called_once()


def test_training_job_status():
    from app.services.cluster.direct import training_job_status

    assert training_job_status(1, 0, 0) == "running"
    assert training_job_status(0, 1, 0) == "succeeded"
    assert training_job_status(0, 0, 1) == "failed"
    assert training_job_status(0, 0, 0) == "pending"


def test_job_workload_includes_reason_and_pod():
    from datetime import datetime, timezone
    from types import SimpleNamespace as NS

    from app.services.cluster.direct import index_pods, job_workload, pods_for

    now = datetime(2026, 11, 6, tzinfo=timezone.utc)
    container = NS(
        image="example/train:1",
        resources=NS(requests={"cpu": "1", "memory": "2Gi"}),
    )
    job = NS(
        metadata=NS(
            name="nanogpt-cpu-9755",
            namespace="default",
            creation_timestamp=now,
            labels={"cilitrain.io/run": "rid", "cilitrain.io/template": "nanogpt-cpu"},
            annotations={
                "cilitrain.io/display-name": "nano",
                "cilitrain.io/scheduler": "default-scheduler",
            },
        ),
        spec=NS(template=NS(spec=NS(containers=[container]))),
        status=NS(
            active=0,
            succeeded=0,
            failed=1,
            start_time=now,
            completion_time=now,
            conditions=[
                NS(
                    type="Failed",
                    status="True",
                    reason="DeadlineExceeded",
                    message="Job was active longer than specified deadline",
                )
            ],
        ),
    )
    row = job_workload(job)
    assert row["status"] == "failed"
    assert row["cpu"] == "1"
    assert row["memory"] == "2Gi"
    assert row["message"].startswith("DeadlineExceeded")
    pod = NS(
        metadata=NS(
            name="nanogpt-cpu-9755-abc",
            namespace="default",
            labels={"job-name": "nanogpt-cpu-9755"},
        ),
        spec=NS(node_name="node-a"),
        status=NS(
            phase="Failed",
            start_time=now,
            container_statuses=[
                NS(restart_count=2, state=NS(waiting=None, terminated=NS(reason="Error"), running=None))
            ],
        ),
    )
    grouped = index_pods([pod])
    attached = pods_for(grouped, row["namespace"], row["name"], row["run_id"], None)
    assert attached[0]["node"] == "node-a"
    assert attached[0]["restarts"] == 2
    assert attached[0]["reason"] == "Error"


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

