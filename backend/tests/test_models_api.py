"""Model registry + batch inference through the showcase simulator."""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.models.entities import Run
from app.services.showcase import ADMIN_PASS, GUEST_PASS, advance_simulated, prepare_showcase


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


def _finish(engine, run_id):
    with Session(engine) as s:
        run = s.get(Run, run_id)
        advance_simulated(s, run, datetime.now(timezone.utc) + timedelta(seconds=60))


def test_seeded_models_and_infer(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    models = client.get("/api/models", headers=h).json()
    labels = {m["label"] for m in models}
    assert {"nanogpt-hamlet:1", "iris-logreg:1"} <= labels
    iris = next(m for m in models if m["name"] == "iris-logreg")
    assert iris["infer"]["output"] == "classification"
    assert iris["infer_count"] == 1

    bad = client.post(f"/api/models/{iris['id']}/infer", json={"input": {"petal_width": 99}}, headers=h)
    assert bad.status_code == 400

    r = client.post(
        f"/api/models/{iris['id']}/infer",
        json={"input": {"sepal_length": 5.0, "sepal_width": 3.4, "petal_length": 1.5, "petal_width": 0.2}},
        headers=h,
    )
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["kind"] == "infer"
    assert run["model_label"] == "iris-logreg:1"
    assert "/model" in run["job_yaml"]
    _finish(engine, run["id"])
    done = client.get(f"/api/runs/{run['id']}", headers=h).json()
    assert done["status"] == "succeeded"
    assert done["prediction"]["label"] == "setosa"
    assert abs(sum(done["prediction"]["probabilities"].values()) - 1) < 0.01

    history = client.get(f"/api/models/{iris['id']}/runs", headers=h).json()
    assert run["id"] in {x["id"] for x in history}

    again = client.post(f"/api/runs/{run['id']}/rerun", headers=h)
    assert again.status_code == 200, again.text
    assert again.json()["kind"] == "infer"
    app.dependency_overrides.clear()


IRIS_CSV = (
    "id,sepal_length,sepal_width,petal_length,petal_width\n"
    "a,5.0,3.4,1.5,0.2\n"
    "b,6.7,3.0,5.6,2.2\n"
    "\n"
    "c,5.9,2.8,4.4,1.3\n"
)


def test_batch_infer_csv(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    iris = next(m for m in client.get("/api/models", headers=h).json() if m["name"] == "iris-logreg")
    url = f"/api/models/{iris['id']}/infer-batch"

    bad = client.post(url, json={"csv": "foo,bar\n1,2\n"}, headers=h)
    assert bad.status_code == 400 and "header" in bad.json()["detail"]
    bad = client.post(url, json={"csv": IRIS_CSV.replace("6.7", "99")}, headers=h)
    assert bad.status_code == 400 and bad.json()["detail"].startswith("row 3:")

    r = client.post(url, json={"csv": IRIS_CSV}, headers=h)
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["batch_rows"] == 3 and run["infer_input"] is None
    assert "CILITRAIN_INFER_BATCH" in run["job_yaml"]
    _finish(engine, run["id"])
    done = client.get(f"/api/runs/{run['id']}", headers=h).json()
    pred = done["prediction"]
    assert pred["type"] == "batch" and pred["rows"] == 3
    assert pred["counts"] == {"setosa": 1, "virginica": 1, "versicolor": 1}
    table = client.get(
        f"/api/runs/{run['id']}/artifacts/file", params={"path": "predictions.csv"}, headers=h
    ).text.splitlines()
    assert table[0].startswith("id,sepal_length,") and "label" in table[0]
    assert table[1].startswith("a,") and ",setosa," in table[1]

    again = client.post(f"/api/runs/{run['id']}/rerun", headers=h)
    assert again.status_code == 200, again.text
    assert again.json()["batch_rows"] == 3
    app.dependency_overrides.clear()


def test_batch_row_limit(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    nano = next(m for m in client.get("/api/models", headers=h).json() if m["name"] == "nanogpt-hamlet")
    rows = "prompt\n" + "".join(f"line {i}\n" for i in range(21))
    r = client.post(f"/api/models/{nano['id']}/infer-batch", json={"csv": rows}, headers=h)
    assert r.status_code == 400 and "20 rows" in r.json()["detail"]
    app.dependency_overrides.clear()


def test_model_download_and_versions(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    iris = next(m for m in client.get("/api/models", headers=h).json() if m["name"] == "iris-logreg")
    r = client.get(f"/api/models/{iris['id']}/download", headers=h)
    assert r.status_code == 200
    assert "iris-logreg-v1-model.joblib" in r.headers["content-disposition"]
    assert len(r.content) == iris["size_bytes"]

    g = _login(client, "guest", GUEST_PASS)
    assert client.get(f"/api/models/{iris['id']}/download", headers=g).status_code == 200
    assert isinstance(iris["source_params"], dict)
    app.dependency_overrides.clear()


def test_register_from_visitor_run(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    clusters = client.get("/api/clusters", headers=h).json()
    body = {
        "cluster_id": clusters[0]["id"],
        "name": "nano-mine",
        "template": "nanogpt-cpu",
        "image": "python:3.12-slim",
        "command": [],
        "args": [],
        "cpu": "1",
        "memory": "1Gi",
        "timeout_seconds": 600,
    }
    run = client.post("/api/runs", json=body, headers=h).json()
    early = client.post(f"/api/runs/{run['id']}/register-model", json={"name": "nano-mine"}, headers=h)
    assert early.status_code == 409
    _finish(engine, run["id"])
    bad = client.post(f"/api/runs/{run['id']}/register-model", json={"name": "Bad Name"}, headers=h)
    assert bad.status_code == 400
    m1 = client.post(f"/api/runs/{run['id']}/register-model", json={"name": "nanogpt-hamlet"}, headers=h)
    assert m1.status_code == 200, m1.text
    assert m1.json()["version"] == 2
    assert m1.json()["files"][0]["path"] == "model.pt"

    monitor = client.get("/api/runs/seed-monitor", headers=h).json()
    assert monitor["kind"] == "train"
    no = client.post("/api/runs/seed-gpu-smoke/register-model", json={"name": "gpu"}, headers=h)
    assert no.status_code in (400, 409)
    app.dependency_overrides.clear()


def test_guest_cannot_infer_or_register(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    h = _login(client, "guest", GUEST_PASS)
    models = client.get("/api/models", headers=h).json()
    assert models
    r = client.post(f"/api/models/{models[0]['id']}/infer", json={"input": {}}, headers=h)
    assert r.status_code == 403
    r = client.post("/api/runs/seed-nanogpt/register-model", json={"name": "x-y"}, headers=h)
    assert r.status_code == 403
    app.dependency_overrides.clear()


def test_prepare_resets_visitor_models(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    client.post("/api/runs/seed-sklearn/register-model", json={"name": "iris-extra"}, headers=h)
    assert len(client.get("/api/models", headers=h).json()) == 3
    with Session(engine) as s:
        prepare_showcase(s)
    assert len(client.get("/api/models", headers=h).json()) == 2
    app.dependency_overrides.clear()
