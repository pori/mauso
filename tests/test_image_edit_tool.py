import asyncio
import base64

from app.chat_images import store_chat_image
from app.models import ChatImage
from app.tools import comfy_common, image_edit

# A minimal but valid PNG signature -- enough for upload_validation.is_valid_image
# to accept it; the bytes after the signature are never actually decoded as an
# image anywhere in this path (ComfyUI is mocked), so they can be arbitrary.
FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"fake-rest-of-file"


def _run(coro):
    # No async test runner (pytest-asyncio/anyio) in this repo's dev deps --
    # every existing test drives async code indirectly via TestClient. This
    # mirrors that by just running the coroutine to completion synchronously,
    # without adding a new dependency for one test file.
    return asyncio.run(coro)


async def _fake_upload_source_image(filename, content_type, data):
    _fake_upload_source_image.calls.append((filename, content_type, data))
    return "uploaded.png"


_fake_upload_source_image.calls = []


async def _fake_submit_and_wait(graph, timeout_polls=None):
    return b"fake-output-bytes"


def _mock_comfy(monkeypatch):
    _fake_upload_source_image.calls = []
    monkeypatch.setattr(comfy_common, "upload_source_image", _fake_upload_source_image)
    monkeypatch.setattr(comfy_common, "submit_and_wait", _fake_submit_and_wait)


def _attached(image_id: str, data: bytes = FAKE_PNG, content_type: str = "image/png"):
    return {image_id: {"data_b64": base64.b64encode(data).decode(), "content_type": content_type}}


def test_missing_source_image_id_is_graceful(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run({"prompt": "make it blue"}, db_session, ""))
    assert "error" in result


def test_missing_prompt_is_graceful(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run({"source_image_id": 1}, db_session, ""))
    assert "error" in result


def test_db_backed_source_not_found_is_graceful(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run({"source_image_id": 999999, "prompt": "make it blue"}, db_session, ""))
    assert "error" in result
    assert not _fake_upload_source_image.calls


def test_db_backed_source_id_must_be_a_number(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run({"source_image_id": "not-a-number", "prompt": "make it blue"}, db_session, ""))
    assert "error" in result


def test_db_backed_source_still_works_unchanged(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    record = store_chat_image(db_session, b"original-bytes", "image/jpeg", source="upload")

    result = _run(image_edit.run({"source_image_id": record.id, "prompt": "make it blue"}, db_session, ""))

    assert "error" not in result
    assert result["source_image_id"] == record.id
    assert result["image_id"] != record.id
    filename, content_type, data = _fake_upload_source_image.calls[0]
    assert content_type == "image/jpeg"
    assert data == b"original-bytes"


def test_attached_image_is_used_without_any_db_lookup(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run(
        {"source_image_id": "att-1", "prompt": "make it blue"}, db_session, "",
        attached_images=_attached("att-1"),
    ))

    assert "error" not in result
    assert result["source_image_id"] == "att-1"
    filename, content_type, data = _fake_upload_source_image.calls[0]
    assert content_type == "image/png"
    assert data == FAKE_PNG


def test_attached_image_wins_over_a_same_id_db_row(db_session, monkeypatch):
    """If source_image_id happens to also parse as an existing ChatImage id,
    the attached bag still takes precedence -- the client's own bytes are
    what it asked to edit, not whatever the server happens to have stored
    under that same id."""
    _mock_comfy(monkeypatch)
    record = store_chat_image(db_session, b"stale-db-bytes", "image/jpeg", source="upload")

    result = _run(image_edit.run(
        {"source_image_id": record.id, "prompt": "make it blue"}, db_session, "",
        attached_images=_attached(str(record.id)),
    ))

    assert "error" not in result
    assert result["source_image_id"] == str(record.id)
    filename, content_type, data = _fake_upload_source_image.calls[0]
    assert content_type == "image/png"
    assert data == FAKE_PNG


def test_unmatched_attached_id_falls_back_to_db(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    record = store_chat_image(db_session, b"original-bytes", "image/png", source="upload")

    result = _run(image_edit.run(
        {"source_image_id": record.id, "prompt": "make it blue"}, db_session, "",
        attached_images=_attached("some-other-id"),
    ))

    assert "error" not in result
    assert result["source_image_id"] == record.id


def test_attached_image_invalid_base64_is_graceful(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run(
        {"source_image_id": "att-1", "prompt": "make it blue"}, db_session, "",
        attached_images={"att-1": {"data_b64": "not valid base64!!!", "content_type": "image/png"}},
    ))
    assert "error" in result
    assert not _fake_upload_source_image.calls


def test_attached_image_that_is_not_actually_an_image_is_graceful(db_session, monkeypatch):
    _mock_comfy(monkeypatch)
    result = _run(image_edit.run(
        {"source_image_id": "att-1", "prompt": "make it blue"}, db_session, "",
        attached_images=_attached("att-1", data=b"just some plain text, not an image"),
    ))
    assert "error" in result
    assert not _fake_upload_source_image.calls


def test_attached_image_does_not_create_a_chat_image_row(db_session, monkeypatch):
    from sqlalchemy import select

    _mock_comfy(monkeypatch)
    before = len(db_session.execute(select(ChatImage)).scalars().all())

    result = _run(image_edit.run(
        {"source_image_id": "att-1", "prompt": "make it blue"}, db_session, "",
        attached_images=_attached("att-1"),
    ))

    after = len(db_session.execute(select(ChatImage)).scalars().all())
    assert "error" not in result
    # Exactly one new row -- the edited *output* -- never a row for the
    # attached *source*.
    assert after == before + 1
