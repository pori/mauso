"""Covers agent.py's _with_heartbeat: a slow non-streaming LLM call or
tool execution must not leave the SSE connection silent long enough for a
client's own idle/request timeout to fire a spurious failure (observed
with vision-capable calls, which are slow and attach a large payload).
Drives this through the real /api/chat endpoint rather than unit-testing
_with_heartbeat in isolation, since the thing actually being guaranteed is
that a heartbeat event reaches the wire during the wait."""
import asyncio
import json

from app import llm_client
from app.config import settings


async def _slow_chat_completion(base_url, api_key, model, messages, tools=None):
    await asyncio.sleep(0.08)
    return {"role": "assistant", "content": "done"}


async def _fake_chat_completion_stream(base_url, api_key, model, messages):
    yield {"model": "fake-model", "content": "done"}


def _sse_event_types(body: str) -> list:
    types = []
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        types.append(json.loads(line[len("data:"):].strip())["type"])
    return types


def test_heartbeat_sent_while_waiting_on_a_slow_tool_decision_call(client, monkeypatch):
    monkeypatch.setattr(settings, "sse_heartbeat_interval_seconds", 0.01)
    monkeypatch.setattr(llm_client, "chat_completion", _slow_chat_completion)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)

    resp = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "describe this"}], "enabled_tools": []},
    )
    assert resp.status_code == 200
    types = _sse_event_types(resp.text)
    assert "heartbeat" in types
    # The internal "done" sentinel _with_heartbeat uses to hand back the
    # LLM's actual response must never leak onto the wire.
    assert not any(t.startswith("_with_heartbeat") for t in types)
    assert types[-1] == "done"


def test_no_heartbeats_when_the_call_is_fast(client, monkeypatch):
    async def _fast_chat_completion(base_url, api_key, model, messages, tools=None):
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(settings, "sse_heartbeat_interval_seconds", 5)
    monkeypatch.setattr(llm_client, "chat_completion", _fast_chat_completion)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)

    resp = client.post(
        "/api/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "enabled_tools": []},
    )
    assert resp.status_code == 200
    assert "heartbeat" not in _sse_event_types(resp.text)
