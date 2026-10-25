"""Hyperparameters, env vars, dataset mount, resume and sweeps."""

from datetime import datetime, timedelta, timezone

import pytest
import yaml
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import app
from app.models.entities import Run
from app.services.job_builder import build_job
from app.services.showcase import ADMIN_PASS, advance_simulated, prepare_showcase
from app.services.training import (
    expand_sweep,
    param_env,
    sweep_label,
    validate_env,
    validate_mount_path,
    validate_params,
)


def test_params_fill_defaults_and_check_ranges():
    p = validate_params("nanogpt-cpu", {"epochs": 3})
    assert p == {"epochs": 3, "steps_per_epoch": 40, "learning_rate": 0.0003, "batch_size": 16}
    with pytest.raises(HTTPException) as e:
        validate_params("nanogpt-cpu", {"epochs": 0})
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        validate_params("nanogpt-cpu", {"dropout": 0.1})
    with pytest.raises(HTTPException):
        validate_params("custom", {"epochs": 1})
    assert validate_params("custom", {}) == {}


def test_param_env_names():
    env = param_env({"epochs": 3, "learning_rate": 0.001})
    assert env["CILITRAIN_EPOCHS"] == "3"
    assert env["CILITRAIN_LEARNING_RATE"] == "0.001"
    assert '"epochs": 3' in env["CILITRAIN_PARAMS"]


def test_env_rejects_reserved_and_bad_names():
    assert validate_env({"HF_HOME": "/cache", "SEED": 7}) == {"HF_HOME": "/cache", "SEED": "7"}
    for bad in ({"CILITRAIN_OUTPUT": "/x"}, {"1BAD": "x"}, {"PATH": "/bin"}, {"A": "x" * 5000}):
        with pytest.raises(HTTPException):
            validate_env(bad)


def test_mount_path_rules():
    assert validate_mount_path("/datasets/iris/") == "/datasets/iris"
    for bad in ("relative", "/workspace", "/model/x", "/etc", "/data/../etc"):
        with pytest.raises(HTTPException):
            validate_mount_path(bad)


def test_sweep_expands_grid():
    combos = expand_sweep("sklearn-cpu", {"max_iter": 300}, {"c": [0.1, 1, 10], "test_size": [0.2, 0.3]})
    assert len(combos) == 6
    assert all(c["max_iter"] == 300 for c in combos)
    assert sweep_label(combos[0], ["c", "test_size"]) == "c0.1-test_size0.2"
    with pytest.raises(HTTPException):
        expand_sweep("sklearn-cpu", None, {"c": [1, 2, 3, 4], "max_iter": [10, 20, 30, 40]})
    with pytest.raises(HTTPException):
        expand_sweep("sklearn-cpu", None, {"c": [500]})
    with pytest.raises(HTTPException):
        expand_sweep("custom", None, {"c": [1]})


def test_job_env_has_data_mount():
    job = build_job(
        run_id="r1",
        name="n",
        namespace="default",
        template="custom",
        image="python:3.12-slim",
        command=["python"],
        args=[],
        cpu="1",
        memory="1Gi",
        timeout_seconds=600,
        pvc_name="iris",
        pvc_mount_path="/datasets",
    )
    env = {e["name"]: e["value"] for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env["CILITRAIN_DATA"] == "/datasets"


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
    client = TestClient(app)
    tok = client.post("/api/auth/login", json={"username": "admin", "password": ADMIN_PASS}).json()
    return client, engine, {"Authorization": f"Bearer {tok['access_token']}"}


def _finish(engine, run_id):
    with Session(engine) as s:
        advance_simulated(s, s.get(Run, run_id), datetime.now(timezone.utc) + timedelta(seconds=60))


def _body(client, h, **extra):
    cluster = client.get("/api/clusters", headers=h).json()[0]["id"]
    return {
        "cluster_id": cluster,
        "name": "nano",
        "template": "nanogpt-cpu",
        "image": "python:3.12-slim",
        "cpu": "1",
        "memory": "1Gi",
        "timeout_seconds": 600,
        **extra,
    }


def test_run_with_params_and_env(tmp_path, monkeypatch):
    client, engine, h = _client(tmp_path, monkeypatch)
    tmpl = next(t for t in client.get("/api/templates", headers=h).json() if t["id"] == "nanogpt-cpu")
    assert tmpl["resumable"] is True
    assert {p["key"] for p in tmpl["params"]} >= {"epochs", "learning_rate"}

    r = client.post(
        "/api/runs",
        json=_body(client, h, params={"epochs": 3, "learning_rate": 0.001}, env={"SEED": "7"}),
        headers=h,
    )
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["params"]["epochs"] == 3
    assert run["env"] == {"SEED": "7"}
    env = {
        e["name"]: e["value"]
        for e in yaml.safe_load(run["job_yaml"])["spec"]["template"]["spec"]["containers"][0]["env"]
    }
    assert env["CILITRAIN_EPOCHS"] == "3" and env["SEED"] == "7"

    _finish(engine, run["id"])
    metrics = client.get(f"/api/runs/{run['id']}/metrics", headers=h).json()
    assert metrics["summary"]["epochs"] == 3

    bad = client.post("/api/runs", json=_body(client, h, env={"CILITRAIN_X": "1"}), headers=h)
    assert bad.status_code == 400
    app.dependency_overrides.clear()


def test_resume_continues_epochs(tmp_path, monkeypatch):
    client, engine, h = _client(tmp_path, monkeypatch)
    first = client.post("/api/runs", json=_body(client, h, params={"epochs": 4}), headers=h).json()
    early = client.post(
        "/api/runs", json=_body(client, h, name="nano-more", resume_from=first["id"]), headers=h
    )
    assert early.status_code == 409
    _finish(engine, first["id"])

    r = client.post(
        "/api/runs",
        json=_body(client, h, name="nano-more", params={"epochs": 2}, resume_from=first["id"]),
        headers=h,
    )
    assert r.status_code == 200, r.text
    resumed = r.json()
    assert resumed["resume_from"] == first["id"]
    assert resumed["resume_from_name"] == "nano"
    assert "/model" in resumed["job_yaml"] and "CILITRAIN_RESUME_DIR" in resumed["job_yaml"]
    assert (tmp_path / "resume" / resumed["id"] / "model.pt").exists()
    _finish(engine, resumed["id"])
    metrics = client.get(f"/api/runs/{resumed['id']}/metrics", headers=h).json()
    assert metrics["summary"]["epochs"] == 6

    wrong = client.post(
        "/api/runs",
        json=_body(client, h, template="sklearn-cpu", resume_from=first["id"]),
        headers=h,
    )
    assert wrong.status_code == 400
    no = client.post(
        "/api/runs", json=_body(client, h, template="sklearn-cpu", resume_from="seed-sklearn"), headers=h
    )
    assert no.status_code == 400
    app.dependency_overrides.clear()


def test_sweep_creates_grouped_runs(tmp_path, monkeypatch):
    client, engine, h = _client(tmp_path, monkeypatch)
    r = client.post(
        "/api/sweeps",
        json={
            "run": _body(client, h, name="iris", template="sklearn-cpu"),
            "grid": {"c": [0.01, 10]},
        },
        headers=h,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["runs"]) == 2
    assert {x["sweep_id"] for x in data["runs"]} == {data["sweep_id"]}
    assert {x["name"] for x in data["runs"]} == {"iris-c0.01", "iris-c10"}
    for x in data["runs"]:
        _finish(engine, x["id"])
    accs = [
        client.get(f"/api/runs/{x['id']}/metrics", headers=h).json()["summary"]["acc"]
        for x in data["runs"]
    ]
    assert accs[0] < accs[1]
    ids = ",".join(x["id"] for x in data["runs"])
    cmp = client.get(f"/api/compare/runs?ids={ids}", headers=h).json()
    assert sorted(x["params"]["c"] for x in cmp["runs"]) == [0.01, 10]
    assert {x["sweep_id"] for x in cmp["runs"]} == {data["sweep_id"]}
    app.dependency_overrides.clear()


def test_large_sweep_queues_beyond_limit(tmp_path, monkeypatch):
    client, engine, h = _client(tmp_path, monkeypatch)
    r = client.post(
        "/api/sweeps",
        json={
            "run": _body(client, h, name="nano", params={"epochs": 2}),
            "grid": {"learning_rate": [0.0001, 0.001], "batch_size": [8, 16, 32]},
        },
        headers=h,
    )
    assert r.status_code == 200, r.text
    runs = r.json()["runs"]
    assert len(runs) == 6
    # seed-monitor is a long-running seed and already holds one of the three slots.
    statuses = [x["status"] for x in runs]
    assert statuses == ["pending", "pending", "queued", "queued", "queued", "queued"]
    assert [x["queue_position"] for x in runs[2:]] == [1, 2, 3, 4]

    for x in runs[:2]:
        _finish(engine, x["id"])
    listed = {x["id"]: x for x in client.get("/api/runs", headers=h).json()}
    assert [listed[x["id"]]["status"] for x in runs[2:]] == ["pending", "pending", "queued", "queued"]
    assert listed[runs[4]["id"]]["queue_position"] == 1
    app.dependency_overrides.clear()
