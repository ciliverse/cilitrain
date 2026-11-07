"""OpenAI-compatible chat for published services.

A caller key selects one service. Public models are forwarded to their provider.
A model registered from a training run answers through the existing predict path:
a single text field takes the last user message, and other templates take a JSON object.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from app.models.entities import InferenceService, ModelVersion
from app.services.inference import infer_spec
from app.services.serving import predict


def chat_completion(model: str, content: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _user_text(body: dict[str, Any]) -> str:
    prompt = body.get("prompt")
    messages = body.get("messages")
    if isinstance(prompt, str) and not messages:
        return prompt
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") in (None, "text")
            )
    return ""


def _local_input(svc: InferenceService, text: str) -> dict[str, Any]:
    raw: dict[str, Any] | None = None
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            raw = parsed
    if raw is None:
        fields = (infer_spec(svc.template) or {}).get("fields") or []
        if len(fields) == 1 and fields[0].get("type") == "text":
            raw = {str(fields[0]["key"]): text}
        else:
            raise HTTPException(
                status_code=400,
                detail="put the inference input in the user message as a JSON object",
            )
    return raw


def _sse(payload: dict[str, Any]) -> str:
    choice = payload["choices"][0]
    chunk = {
        "id": payload["id"],
        "object": "chat.completion.chunk",
        "created": payload["created"],
        "model": payload["model"],
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": choice["message"]["content"]}, "finish_reason": "stop"}],
    }
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\ndata: [DONE]\n\n"


async def _proxy(model: ModelVersion, body: dict[str, Any]) -> Any:
    url = model.base_url.rstrip("/") + "/chat/completions"
    payload = dict(body)
    payload["model"] = model.upstream_model
    headers = {"Content-Type": "application/json"}
    if model.upstream_key:
        headers["Authorization"] = f"Bearer {model.upstream_key}"
    timeout = httpx.Timeout(120.0, connect=10.0)
    if payload.get("stream"):
        client = httpx.AsyncClient(timeout=timeout)
        try:
            response = await client.send(client.build_request("POST", url, headers=headers, json=payload), stream=True)
        except httpx.HTTPError as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"provider request failed: {exc}") from exc
        if response.status_code >= 400:
            raw = (await response.aread())[:800].decode("utf-8", "replace")
            await response.aclose()
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"provider returned {response.status_code}: {raw}")

        async def chunks() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()
                await client.aclose()

        return StreamingResponse(chunks(), media_type=response.headers.get("content-type", "text/event-stream"))
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"provider request failed: {exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"provider returned {response.status_code}: {response.text[:800]}")
    try:
        return response.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="provider returned a non-JSON body") from exc


async def complete(session: Session, svc: InferenceService, body: dict[str, Any], kube: Any) -> Any:
    if svc.status not in ("running", "starting"):
        raise HTTPException(status_code=409, detail=f"service is {svc.status}")
    model = session.get(ModelVersion, svc.model_id)
    if model is not None and (model.origin or "trained") == "provider":
        if not model.base_url or not model.upstream_model:
            raise HTTPException(status_code=409, detail="provider model is missing its upstream address")
        return await _proxy(model, body)
    from app.services.serving import sync_service

    sync_service(session, svc, kube)
    session.refresh(svc)
    if svc.status != "running":
        raise HTTPException(status_code=409, detail=f"service is {svc.status}")
    out = predict(session, svc, kube, {"input": _local_input(svc, _user_text(body))})
    output = out.get("output")
    text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    done = chat_completion(svc.name, text)
    if body.get("stream"):
        return StreamingResponse(iter([_sse(done)]), media_type="text/event-stream")
    return done
