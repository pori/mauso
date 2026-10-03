"""Covers the same-turn chaining fix in agent.py (#11 stage 2): a model that
calls generate_image and then, in the same turn, calls edit_image targeting
the id generate_image just produced, must be able to resolve that image's
bytes via the request-scoped attached-images bag -- without either call
ever writing a ChatImage row. Before this fix, attached_images_by_id was
built once at the top of run_agent_turn and never updated mid-loop, so a
same-turn edit of a freshly generated image had no way to find its source
once generate_image/edit_image stopped persisting to the DB."""
import json

from sqlalchemy import select

from app import llm_client
from app.models import ChatImage
from app.tools import comfy_common

# Needs a real PNG magic-byte signature -- the attached-images path in
# image_edit.py's _resolve_source runs upload_validation.is_valid_image on
# whatever generate_image "produced" before accepting it as an edit source,
# same as it would for any client-attached image.
FAKE_GENERATED_PNG = b"\x89PNG\r\n\x1a\n" + b"freshly-generated"
FAKE_EDITED_PNG = b"\x89PNG\r\n\x1a\n" + b"edited-output"


async def _fake_upload_source_image(filename, content_type, data):
    _fake_upload_source_image.calls.append((filename, content_type, data))
    return "uploaded.png"


_fake_upload_source_image.calls = []


async def _fake_submit_and_wait(graph, timeout_polls=None):
    _fake_submit_and_wait.calls += 1
    if _fake_submit_and_wait.calls == 1:
        return FAKE_GENERATED_PNG
    return FAKE_EDITED_PNG


_fake_submit_and_wait.calls = 0


async def _fake_chat_completion_stream(base_url, api_key, model, messages):
    yield {"model": "fake-model", "content": "done"}


def test_edit_image_can_chain_onto_a_same_turn_generate_image(client, db_session, monkeypatch):
    _fake_upload_source_image.calls = []
    _fake_submit_and_wait.calls = 0
    monkeypatch.setattr(comfy_common, "upload_source_image", _fake_upload_source_image)
    monkeypatch.setattr(comfy_common, "submit_and_wait", _fake_submit_and_wait)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)

    generated_image_id = {}

    async def _fake_chat_completion(base_url, api_key, model, messages, tools=None):
        tool_messages = [m for m in messages if m.get("role") == "tool"]
        if len(tool_messages) == 0:
            return {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "generate_image", "arguments": json.dumps({"prompt": "a red bicycle"})},
                }],
            }
        if len(tool_messages) == 1:
            first_result = json.loads(tool_messages[0]["content"])
            generated_image_id["id"] = first_result["image_id"]
            return {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_2",
                    "function": {
                        "name": "edit_image",
                        "arguments": json.dumps({
                            "source_image_id": first_result["image_id"],
                            "prompt": "make it blue",
                        }),
                    },
                }],
            }
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(llm_client, "chat_completion", _fake_chat_completion)

    before = len(db_session.execute(select(ChatImage)).scalars().all())

    resp = client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "generate a red bicycle then make it blue"}],
            "enabled_tools": ["generate_image", "edit_image"],
        },
    )
    assert resp.status_code == 200

    after = len(db_session.execute(select(ChatImage)).scalars().all())
    assert after == before, "neither the generated nor the edited image should ever hit the ChatImage table"

    # Proves the second tool call actually resolved the first result's
    # bytes through the attached-images bag, not a DB row -- the uploaded
    # source matches exactly what the mocked generate_image step produced.
    assert len(_fake_upload_source_image.calls) == 1
    filename, content_type, data = _fake_upload_source_image.calls[0]
    assert data == FAKE_GENERATED_PNG
    assert generated_image_id["id"]
