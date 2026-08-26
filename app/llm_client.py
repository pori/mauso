"""Thin async client for whatever OpenAI-compatible endpoint the user has
configured on the Settings page (self-hosted litellm/ollama, or a hosted
provider). base_url is used exactly as given, in the same convention as the
official OpenAI SDK -- i.e. it should already include any `/v1` suffix the
provider needs (e.g. `http://litellm:4000/v1`, `https://api.openai.com/v1`).
This module only appends `/chat/completions` and `/embeddings`.
"""
import json
from typing import AsyncIterator, Optional

import httpx

from .config import settings


class LLMError(Exception):
    pass


def _client(base_url: str, api_key: str) -> httpx.AsyncClient:
    if not base_url:
        raise LLMError("No LLM endpoint configured yet. Set one on the Settings page.")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return httpx.AsyncClient(base_url=base_url, headers=headers, timeout=settings.llm_timeout_seconds)


async def chat_completion(
    base_url: str, api_key: str, model: str, messages: list, tools: Optional[list] = None,
) -> dict:
    """Non-streaming call, used for the tool-calling loop turns -- we need
    the full message (including any tool_calls) in one shot to decide what
    to execute next."""
    if not model:
        raise LLMError("No model configured. Set one on the Settings page.")
    body = {"model": model, "messages": messages}
    if tools:
        body["tools"] = tools
    async with _client(base_url, api_key) as client:
        try:
            resp = await client.post("/chat/completions", json=body)
        except httpx.RequestError as e:
            raise LLMError(f"Could not reach {base_url}: {e}") from e
    if resp.status_code != 200:
        raise LLMError(f"LLM endpoint returned HTTP {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]
    except (KeyError, IndexError) as e:
        raise LLMError(f"Unexpected response shape from LLM endpoint: {data}") from e


async def chat_completion_stream(
    base_url: str, api_key: str, model: str, messages: list,
) -> AsyncIterator[dict]:
    """Streaming call for the final answer (no tools -- by this point the
    tool loop has already resolved). Yields {"model": ..., "content": ...}
    per chunk -- `model` carries the endpoint's own `model` field (routers/
    aliases can resolve a requested model id to a different served one;
    plain passthrough endpoints just echo back what was requested), `content`
    is the text delta, either may be None on a given chunk."""
    if not model:
        raise LLMError("No model configured. Set one on the Settings page.")
    body = {"model": model, "messages": messages, "stream": True}
    async with _client(base_url, api_key) as client:
        try:
            async with client.stream("POST", "/chat/completions", json=body) as resp:
                if resp.status_code != 200:
                    error_bytes = await resp.aread()
                    raise LLMError(f"LLM endpoint returned HTTP {resp.status_code}: {error_bytes[:500]!r}")
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    yield {"model": chunk.get("model"), "content": delta.get("content")}
        except httpx.RequestError as e:
            raise LLMError(f"Could not reach {base_url}: {e}") from e


# Substrings of known vision-capable model ids, lowercased. Only a handful
# of providers expose real capability metadata on /models (checked first in
# _model_supports_vision below) -- vanilla OpenAI, Ollama, and plain LiteLLM
# expose nothing, so this name-matching fallback is what actually drives
# detection for most endpoints in practice. Best-effort and non-exhaustive;
# extend as new vision models show up.
#
# Anthropic gets its own rule below rather than a per-generation hint here:
# essentially every current Claude model (3.x/4.x/5.x, any tier) is
# multimodal, so "contains 'claude' and isn't one of the ancient text-only
# ones" is both simpler and more durable than chasing each new version
# string (this is also why claude-opus-5/claude-sonnet-5 must NOT be
# matched by a literal "claude-5" substring -- it doesn't appear in either).
_VISION_NAME_HINTS = (
    "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-5",
    "o1-preview", "o1-mini", "o1-pro", "o3-mini", "o3-pro", "o4-mini",
    "gemini", "pixtral", "llava", "qwen-vl", "qwen2-vl", "qwen2.5-vl",
    "internvl", "phi-3.5-vision", "phi-4-multimodal", "llama-3.2-vision",
    "grok-4", "grok-3", "grok-2-vision", "mistral-small-3",
)
_NON_VISION_CLAUDE_HINTS = ("claude-1", "claude-2", "claude-instant")


def _model_supports_vision(item: dict) -> bool:
    if isinstance(item.get("supports_vision"), bool):  # LiteLLM extension
        return item["supports_vision"]
    architecture = item.get("architecture")
    if isinstance(architecture, dict) and isinstance(architecture.get("input_modalities"), list):  # OpenRouter
        return "image" in architecture["input_modalities"]
    if isinstance(item.get("modalities"), list):
        return "image" in item["modalities"]
    capabilities = item.get("capabilities")
    if isinstance(capabilities, list):
        return any(str(c).lower() in ("vision", "image", "image_input") for c in capabilities)
    model_id = str(item.get("id", "")).lower()
    if "claude" in model_id:
        return not any(hint in model_id for hint in _NON_VISION_CLAUDE_HINTS)
    return any(hint in model_id for hint in _VISION_NAME_HINTS)


async def list_models(base_url: str, api_key: str) -> list:
    """Returns [{"id": ..., "vision": bool}, ...] for the models the
    endpoint reports via its OpenAI-compatible GET /models -- used to
    populate the chat window's model picker and to decide whether an
    attached image gets sent to that model or falls back to a text
    placeholder. See _model_supports_vision for how `vision` is derived."""
    async with _client(base_url, api_key) as client:
        try:
            resp = await client.get("/models")
        except httpx.RequestError as e:
            raise LLMError(f"Could not reach {base_url}: {e}") from e
    if resp.status_code != 200:
        raise LLMError(f"LLM endpoint returned HTTP {resp.status_code} for /models: {resp.text[:500]}")
    data = resp.json()
    try:
        items = sorted(data["data"], key=lambda item: item["id"])
    except (KeyError, TypeError) as e:
        raise LLMError(f"Unexpected /models response shape from LLM endpoint: {data}") from e
    return [{"id": item["id"], "vision": _model_supports_vision(item)} for item in items]


async def embed(base_url: str, api_key: str, embedding_model: str, texts: list) -> list:
    """Returns a list of embedding vectors (list[float]), one per input text."""
    if not embedding_model:
        raise LLMError("No embedding model configured. Set one on the Settings page.")
    async with _client(base_url, api_key) as client:
        try:
            resp = await client.post("/embeddings", json={"model": embedding_model, "input": texts})
        except httpx.RequestError as e:
            raise LLMError(f"Could not reach {base_url}: {e}") from e
    if resp.status_code != 200:
        raise LLMError(f"LLM endpoint returned HTTP {resp.status_code} for embeddings: {resp.text[:500]}")
    data = resp.json()
    try:
        items = sorted(data["data"], key=lambda d: d["index"])
        return [item["embedding"] for item in items]
    except (KeyError, IndexError) as e:
        raise LLMError(f"Unexpected embeddings response shape from LLM endpoint: {data}") from e
