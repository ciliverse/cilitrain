"""Public models and the OpenAI-compatible gateway."""

import json

from fastapi.testclient import TestClient

from app.services.showcase import ADMIN_PASS
from tests.test_services import IRIS, _client, _login, _warm


def test_provider_model_service_and_openai_gateway(tmp_path, monkeypatch):
    client, _engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)

    catalog = client.get("/api/providers", headers=h)
    assert catalog.status_code == 200
    ids = {row["id"] for row in catalog.json()}
    assert {"kimi", "deepseek", "doubao", "claude", "gemini"} <= ids
    kimi = next(row for row in catalog.json() if row["id"] == "kimi")
    assert kimi["models"][0] == "kimi-k3.1-pro"
    deepseek = next(row for row in catalog.json() if row["id"] == "deepseek")
    assert "deepseek-chat" not in deepseek["models"]
    assert deepseek["model_versions"]["deepseek-flash"] == "V4.1-Flash-1017"
    assert deepseek["model_versions"]["deepseek-v4-pro"] == "V4-Pro-0813"
    qwen = next(row for row in catalog.json() if row["id"] == "qwen")
    assert qwen["model_versions"]["qwen3.8-max"] == "2026-09-02"
    assert "qwen3.8-max-0902" in qwen["models"]
    claude = next(row for row in catalog.json() if row["id"] == "claude")
    assert claude["model_versions"]["claude-sonnet-5-5"] == "2026-09-28"

    created = client.post(
        "/api/models/providers",
        json={
            "name": "desk-chat",
            "provider": "deepseek",
            "upstream_model": "deepseek-chat",
            "api_key": "sk-upstream-secret",
        },
        headers=h,
    )
    assert created.status_code == 200, created.text
    model = created.json()
    assert model["origin"] == "provider"
    assert model["base_url"] == "https://api.deepseek.com/v1"
    assert model["has_upstream_key"] is True
    assert "sk-upstream-secret" not in created.text

    published = client.post("/api/services", json={"model_id": model["id"], "name": "desk-api"}, headers=h)
    assert published.status_code == 200, published.text
    body = published.json()
    key = body["api_key"]
    svc = body["service"]
    assert key.startswith("ctk_")
    assert svc["protocol"] == "openai"
    assert svc["status"] == "running"
    assert svc["endpoint_path"] == "/api/v1/chat/completions"

    calls: list[dict] = []

    class _Response:
        status_code = 200
        text = ""

        def json(self):
            return {"id": "chatcmpl-up", "choices": [{"message": {"role": "assistant", "content": "pong"}}]}

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers, json):
            calls.append({"url": url, "headers": headers, "json": json})
            return _Response()

    monkeypatch.setattr("app.services.openai_gateway.httpx.AsyncClient", _Client)

    chat = client.post(
        "/v1/chat/completions",
        json={"model": "ignored", "messages": [{"role": "user", "content": "hi"}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert chat.status_code == 200, chat.text
    assert chat.json()["choices"][0]["message"]["content"] == "pong"
    assert calls[0]["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert calls[0]["json"]["model"] == "deepseek-chat"
    assert calls[0]["headers"]["Authorization"] == "Bearer sk-upstream-secret"

    listed = client.get("/api/v1/models", headers={"Authorization": f"Bearer {key}"})
    assert listed.status_code == 200
    assert listed.json()["data"][0]["id"] == "desk-api"

    extra = client.post(f"/api/services/{svc['id']}/keys", json={"name": "laptop"}, headers=h)
    assert extra.status_code == 200, extra.text
    extra_key = extra.json()["api_key"]
    assert extra_key.startswith("ctk_") and extra_key != key
    again = client.get("/v1/models", headers={"Authorization": f"Bearer {extra_key}"})
    assert again.status_code == 200

    revoked = client.delete(f"/api/services/{svc['id']}/keys/{extra.json()['key']['id']}", headers=h)
    assert revoked.status_code == 200
    dead = client.get("/v1/models", headers={"Authorization": f"Bearer {extra_key}"})
    assert dead.status_code == 401
    still = client.get("/v1/models", headers={"Authorization": f"Bearer {key}"})
    assert still.status_code == 200


def test_trained_service_answers_openai_chat(tmp_path, monkeypatch):
    client, engine = _client(tmp_path, monkeypatch)
    h = _login(client, "admin", ADMIN_PASS)
    iris = next(m for m in client.get("/api/models", headers=h).json() if m["name"] == "iris-logreg")
    published = client.post("/api/services", json={"model_id": iris["id"], "name": "iris-chat"}, headers=h)
    assert published.status_code == 200, published.text
    key, svc = published.json()["api_key"], published.json()["service"]
    assert svc["protocol"] == "predict"
    _warm(engine, svc["id"])
    from sqlmodel import Session

    from app.models.entities import InferenceService

    with Session(engine) as session:
        row = session.get(InferenceService, svc["id"])
        assert row is not None
        row.status = "running"
        session.add(row)
        session.commit()
    monkeypatch.setattr("app.services.serving.sync_service", lambda *args, **kwargs: (1, None))
    monkeypatch.setattr(
        "app.services.openai_gateway.predict",
        lambda session, service, kube, body: {"output": {"prediction": "setosa"}, "latency_ms": 3, "rows": 1},
    )

    chat = client.post(
        "/api/v1/chat/completions",
        json={"model": svc["name"], "messages": [{"role": "user", "content": json.dumps(IRIS)}]},
        headers={"Authorization": f"Bearer {key}"},
    )
    assert chat.status_code == 200, chat.text
    assert "setosa" in chat.json()["choices"][0]["message"]["content"]
    assert isinstance(client, TestClient)
