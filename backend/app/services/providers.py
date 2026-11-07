"""Public model providers that speak the OpenAI chat-completions protocol.

`models` is the provider's published chat-model list. It is not loaded with a user API key.
"""

from __future__ import annotations

PROVIDERS: list[dict] = [
    {
        "id": "kimi",
        "label": "Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "model_hint": "kimi-k3.1-pro",
        "models": ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3"],
        "model_versions": {
            "kimi-k3.1-pro": "2026-10-23",
            "kimi-k3.1-pro-highspeed": "2026-10-23",
            "kimi-k3": "2026-07",
        },
    },
    {
        "id": "deepseek",
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "model_hint": "deepseek-flash",
        "models": ["deepseek-flash", "deepseek-v4-pro"],
        "model_versions": {
            "deepseek-flash": "V4.1-Flash-1017",
            "deepseek-v4-pro": "V4-Pro-0813",
        },
    },
    {
        "id": "qwen",
        "label": "通义千问",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model_hint": "qwen3.8-max",
        "models": [
            "qwen3.8-max",
            "qwen3.8-max-0902",
            "qwen3.7-max",
            "qwen3.7-max-2026-06-08",
            "qwen-max",
            "qwen3.7-plus",
            "qwen3.7-plus-2026-05-26",
            "qwen3.6-plus",
            "qwen3.6-plus-2026-04-02",
            "qwen3.5-plus",
            "qwen3.5-plus-2026-02-15",
            "qwen-plus",
            "qwen-plus-2025-12-01",
            "qwen3.8-flash",
            "qwen3.7-flash",
            "qwen3.7-flash-2026-07-15",
            "qwen3.6-flash",
            "qwen3.6-flash-2026-04-16",
            "qwen3.5-flash",
            "qwen3.5-flash-2026-02-23",
            "qwen-flash",
        ],
        "model_versions": {
            "qwen3.8-max": "2026-09-02",
            "qwen3.8-max-0902": "2026-09-02",
            "qwen3.7-max": "2026-06-08",
            "qwen3.7-max-2026-06-08": "2026-06-08",
            "qwen3.7-plus": "2026-05-26",
            "qwen3.7-plus-2026-05-26": "2026-05-26",
            "qwen3.6-plus": "2026-04-02",
            "qwen3.6-plus-2026-04-02": "2026-04-02",
            "qwen3.5-plus": "2026-02-15",
            "qwen3.5-plus-2026-02-15": "2026-02-15",
            "qwen-plus": "2025-12-01",
            "qwen-plus-2025-12-01": "2025-12-01",
            "qwen3.7-flash": "2026-07-15",
            "qwen3.7-flash-2026-07-15": "2026-07-15",
            "qwen3.6-flash": "2026-04-16",
            "qwen3.6-flash-2026-04-16": "2026-04-16",
            "qwen3.5-flash": "2026-02-23",
            "qwen3.5-flash-2026-02-23": "2026-02-23",
        },
    },
    {
        "id": "doubao",
        "label": "豆包",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "model_hint": "doubao-seed-2-1-pro-260915",
        "models": [
            "doubao-seed-evolving",
            "doubao-seed-2-1-pro-260915",
            "doubao-seed-2-1-lite-260915",
            "doubao-seed-2-1-turbo-260628",
            "doubao-seed-2-1-pro-260628",
            "doubao-seed-2-0-lite-260428",
            "doubao-seed-2-0-mini-260428",
            "doubao-seed-character-260628",
        ],
        "model_versions": {
            "doubao-seed-2-1-pro-260915": "2026-09-15",
            "doubao-seed-2-1-lite-260915": "2026-09-15",
            "doubao-seed-2-1-turbo-260628": "2026-06-28",
            "doubao-seed-2-1-pro-260628": "2026-06-28",
            "doubao-seed-2-0-lite-260428": "2026-04-28",
            "doubao-seed-2-0-mini-260428": "2026-04-28",
            "doubao-seed-character-260628": "2026-06-28",
        },
    },
    {
        "id": "zhipu",
        "label": "智谱",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model_hint": "glm-5.3",
        "models": ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5", "glm-4.7", "glm-4.7-flash"],
        "model_versions": {
            "glm-5.3": "2026-08-19",
            "glm-5.3-flash": "2026-08-26",
        },
    },
    {
        "id": "minimax",
        "label": "MiniMax",
        "base_url": "https://api.minimax.cn/v1",
        "model_hint": "MiniMax-M3.1-Flash",
        "models": ["MiniMax-M3.1-Flash", "MiniMax-M3"],
    },
    {
        "id": "stepfun",
        "label": "阶跃星辰",
        "base_url": "https://api.stepfun.com/v1",
        "model_hint": "step-5-preview",
        "models": ["step-5-preview", "step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603", "step-1o-turbo-vision"],
        "model_versions": {"step-3.5-flash-2603": "2026-03"},
    },
    {
        "id": "hunyuan",
        "label": "混元",
        "base_url": "https://tokenhub.tencentmaas.com/v1",
        "model_hint": "hy4",
        "models": ["hy4", "hy4-preview", "hy3", "hy3-preview"],
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model_hint": "gpt-6-astra",
        "models": ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    },
    {
        "id": "claude",
        "label": "Claude",
        "base_url": "https://api.anthropic.com/v1",
        "model_hint": "claude-sonnet-5-5",
        "models": ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        "model_versions": {
            "claude-fable-5-1": "2026-09-01",
            "claude-opus-5-5": "2026-09-22",
            "claude-sonnet-5-5": "2026-09-28",
            "claude-haiku-5-5": "2026-10-07",
        },
    },
    {
        "id": "gemini",
        "label": "Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model_hint": "gemini-3.8-flash",
        "models": [
            "gemini-4-argon",
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.1-pro-preview",
            "gemini-3.1-flash-lite",
            "gemini-3-flash-preview",
        ],
        "model_versions": {
            "gemini-4-argon": "2026-10-13",
            "gemini-3.8-flash": "2026-09-02",
            "gemini-3.6-flash": "2026-07-21",
            "gemini-3.5-flash-lite": "2026-07-21",
        },
    },
    {
        "id": "grok",
        "label": "Grok",
        "base_url": "https://api.x.ai/v1",
        "model_hint": "grok-4.7",
        "models": ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"],
        "model_versions": {
            "grok-4.7": "2026-09-21",
            "grok-4.6": "2026-08-12",
        },
    },
    {
        "id": "groq",
        "label": "Groq",
        "base_url": "https://api.groq.com/openai/v1",
        "model_hint": "openai/gpt-oss-120b",
        "models": ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    },
    {
        "id": "ollama",
        "label": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "model_hint": "llama3.1",
        "models": ["llama3.3", "llama3.2", "llama3.1", "qwen2.5", "gemma2", "mistral", "deepseek-r1", "phi3"],
    },
    {
        "id": "custom",
        "label": "OpenAI 兼容",
        "base_url": "",
        "model_hint": "my-model",
        "models": [],
    },
]

_BY_ID = {row["id"]: row for row in PROVIDERS}
# Older records used the company name. The API is the same Kimi endpoint.
_BY_ID["moonshot"] = {**_BY_ID["kimi"], "id": "moonshot"}


def provider_catalog() -> list[dict]:
    out: list[dict] = []
    for row in PROVIDERS:
        item = dict(row)
        item["models"] = list(row.get("models") or [])
        item["model_versions"] = dict(row.get("model_versions") or {})
        out.append(item)
    return out


def provider_base_url(provider: str, override: str = "") -> str:
    row = _BY_ID.get(provider)
    if row is None:
        raise KeyError(provider)
    custom = (override or "").strip().rstrip("/")
    if provider == "custom":
        return custom
    return custom or row["base_url"]
