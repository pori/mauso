"""Guards the app's defining architectural fact (see CLAUDE.md): this backend
must never persist conversation content. There is no Message/Conversation
table by design -- the client owns all transcript storage (encrypted, in
IndexedDB) and the server only ever sees plaintext messages for the duration
of a single /api/chat request, to relay onward.

These tests don't prove the absence of a bug so much as make a future
regression loud: if someone adds a table to persist chat turns, or a code
path that writes message content to disk, one of these should fail."""
import base64
import json

from sqlalchemy import select

from app.db import Base, SessionLocal, engine
from app import agent, llm_client, settings_store
from app.models import AppSetting, ChatImage, Chunk, Document, Note, Profile
from app.tools import comfy_common

ALL_MODELS = [AppSetting, Document, Chunk, Profile, Note, ChatImage]

# A minimal but valid PNG signature -- upload_validation.is_valid_image only
# looks at the magic bytes, and ComfyUI itself is mocked in the test below.
FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"fake-rest-of-file"


def test_no_conversation_or_message_table_exists():
    """Static guard: the schema itself must never grow a place to put chat
    history. A table named e.g. "message" or "conversation" appearing here
    would mean someone started building server-side transcript storage."""
    forbidden_substrings = ("message", "conversation", "transcript")
    for table_name in Base.metadata.tables:
        lowered = table_name.lower()
        assert not any(s in lowered for s in forbidden_substrings), (
            f"table {table_name!r} looks like conversation storage -- "
            "conversation history must stay client-side only"
        )


async def _fake_chat_completion(base_url, api_key, model, messages, tools=None):
    # Asserting on the real argument (not just returning a canned reply)
    # matters -- a stub that ignores what it's called with can't catch a bug
    # where the wrong (or no) messages reach the LLM call.
    assert messages is not None
    assert any("secret only the browser" in str(m.get("content", "")) for m in messages)
    return {"role": "assistant", "content": "hello there"}


async def _fake_chat_completion_stream(base_url, api_key, model, messages):
    assert messages is not None
    yield {"model": "fake-model", "content": "hello"}
    yield {"model": None, "content": " there"}


def _row_counts(db):
    return {m.__tablename__: db.execute(select(m)).scalars().all().__len__() for m in ALL_MODELS}


def test_chat_endpoint_writes_nothing_to_disk(client, db_session, monkeypatch):
    """Dynamic guard: driving a full /api/chat turn (no tools enabled, so
    only the plain chat path runs) must leave every table's row count
    unchanged -- the plaintext messages in the request body must never touch
    the database."""
    monkeypatch.setattr(llm_client, "chat_completion", _fake_chat_completion)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)

    before = _row_counts(db_session)

    resp = client.post(
        "/api/chat",
        json={
            "messages": [
                {"role": "user", "content": "This is a secret only the browser should ever store."},
            ],
            "enabled_tools": [],
        },
    )
    assert resp.status_code == 200
    body = resp.text
    assert "hello there" in body or "hello" in body  # streamed final answer came through

    after = _row_counts(db_session)
    assert after == before


async def _fake_upload_source_image(filename, content_type, data):
    return "uploaded.png"


async def _fake_submit_and_wait(graph, timeout_polls=None):
    return b"fake-edited-output"


def test_edit_image_with_attached_source_does_not_persist_the_source_image(client, db_session, monkeypatch):
    """A source image the browser attaches directly to the request (rather
    than one already stored server-side via a prior /api/chat-images upload)
    must never itself become a ChatImage row -- only the edited *output*
    does, exactly as generate_image already does today. This is the concrete
    slice of "no persistent server-side copy" this stage of #11 delivers:
    the ChatImage table grows by exactly one row (the result), never two."""
    calls = {"n": 0}

    async def _fake_chat_completion(base_url, api_key, model, messages, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {
                        "name": "edit_image",
                        "arguments": json.dumps({"source_image_id": "att-1", "prompt": "make it blue"}),
                    },
                }],
            }
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(llm_client, "chat_completion", _fake_chat_completion)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)
    monkeypatch.setattr(comfy_common, "upload_source_image", _fake_upload_source_image)
    monkeypatch.setattr(comfy_common, "submit_and_wait", _fake_submit_and_wait)

    before = _row_counts(db_session)

    resp = client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "edit that image to be blue"}],
            "enabled_tools": ["edit_image"],
            "attached_images": [{
                "id": "att-1",
                "data_b64": base64.b64encode(FAKE_PNG).decode(),
                "content_type": "image/png",
            }],
        },
    )
    assert resp.status_code == 200

    after = _row_counts(db_session)
    assert after["chat_image"] == before["chat_image"] + 1
    for model in ("app_setting", "document", "chunk", "profile", "note"):
        assert after[model] == before[model]


def test_search_notes_with_attached_corpus_does_not_touch_the_note_table(client, db_session, monkeypatch):
    """The #12 stage-1 slice: a client that attaches its own notes corpus to
    the request must get results from that corpus, and the Note table --
    however many rows already exist in it -- must be left completely
    untouched, not read from and not written to."""
    async def _fake_chat_completion(base_url, api_key, model, messages, tools=None):
        if not any(m.get("role") == "tool" for m in messages):
            return {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "search_notes", "arguments": json.dumps({"query": "sync"})},
                }],
            }
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(llm_client, "chat_completion", _fake_chat_completion)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)

    before = _row_counts(db_session)

    resp = client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "search my notes for sync"}],
            "enabled_tools": ["search_notes"],
            "attached_notes": [
                {"id": "n1", "title": "Standup notes", "content_markdown": "daily sync", "tags": ["work"]},
            ],
        },
    )
    assert resp.status_code == 200
    assert "Standup notes" in resp.text

    after = _row_counts(db_session)
    assert after == before


async def _fake_embed(base_url, api_key, embedding_model, texts):
    return [[1.0, 0.0] for _ in texts]


def test_search_documents_with_attached_chunks_does_not_touch_document_or_chunk_tables(client, db_session, monkeypatch):
    """The #13 stage-1 slice: a client that attaches its own doc-chunk corpus
    to the request must get results ranked from that corpus, and the
    Document/Chunk tables -- however many rows already exist in them --
    must be left completely untouched, not read from and not written to."""
    settings_store.save(db_session, "http://fake-llm", "", "fake-model", "fake-embed-model", "")

    async def _fake_chat_completion(base_url, api_key, model, messages, tools=None):
        if not any(m.get("role") == "tool" for m in messages):
            return {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "search_documents", "arguments": json.dumps({"query": "budget"})},
                }],
            }
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(llm_client, "chat_completion", _fake_chat_completion)
    monkeypatch.setattr(llm_client, "chat_completion_stream", _fake_chat_completion_stream)
    monkeypatch.setattr(llm_client, "embed", _fake_embed)

    before = _row_counts(db_session)

    resp = client.post(
        "/api/chat",
        json={
            "messages": [{"role": "user", "content": "search my documents for the budget"}],
            "enabled_tools": ["search_documents"],
            "attached_doc_chunks": [{
                "document_id": "d1", "filename": "Q3 plan.md", "chunk_index": 0,
                "text": "the budget is 10k", "vector": [1.0, 0.0],
            }],
        },
    )
    assert resp.status_code == 200
    assert "Q3 plan.md" in resp.text

    after = _row_counts(db_session)
    assert after == before
