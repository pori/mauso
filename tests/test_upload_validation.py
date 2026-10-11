"""Covers the magic-byte checks added on top of the client-claimed
Content-Type in routers/files.py -- a file that claims to be one format but
isn't should be rejected, not stored/parsed. Also covers the repurposed
(stateless, #11 stage 2) /api/chat-images/fetch-url route."""
import base64
import io

from pypdf import PdfWriter
from sqlalchemy import select

from app.models import ChatImage
from app.routers import images as images_router

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _valid_pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_fetch_image_from_url_returns_bytes_without_storing(client, monkeypatch):
    data = PNG_SIGNATURE + b"rest-of-file"

    async def _fake_fetch(url):
        assert url == "http://example.com/pic.png"
        return data, "image/png"

    monkeypatch.setattr(images_router, "_fetch_image_bytes", _fake_fetch)

    resp = client.post("/api/chat-images/fetch-url", json={"url": "http://example.com/pic.png"})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"data_b64": base64.b64encode(data).decode(), "content_type": "image/png"}
    assert "id" not in body
    assert "url" not in body


def test_fetch_image_from_url_does_not_create_a_chat_image_row(client, db_session, monkeypatch):
    async def _fake_fetch(url):
        return PNG_SIGNATURE + b"rest-of-file", "image/png"

    monkeypatch.setattr(images_router, "_fetch_image_bytes", _fake_fetch)

    before = len(db_session.execute(select(ChatImage)).scalars().all())
    resp = client.post("/api/chat-images/fetch-url", json={"url": "http://example.com/pic.png"})
    assert resp.status_code == 200
    after = len(db_session.execute(select(ChatImage)).scalars().all())
    assert after == before


def test_upload_chat_images_route_no_longer_exists(client):
    resp = client.post(
        "/api/chat-images",
        files={"file": ("real.png", PNG_SIGNATURE + b"rest-of-file", "image/png")},
    )
    assert resp.status_code == 404


def test_upload_file_rejects_pdf_with_bad_header(client):
    resp = client.post(
        "/api/files",
        files={"file": ("fake.pdf", b"not a real pdf", "application/pdf")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert "doesn't look like a valid PDF" in body["error"]


def test_upload_file_accepts_real_pdf_header(client):
    resp = client.post(
        "/api/files",
        files={"file": ("real.pdf", _valid_pdf_bytes(), "application/pdf")},
    )
    assert resp.status_code == 200
    body = resp.json()
    # No embedding model is configured in tests, so indexing fails *after*
    # extraction -- proves the PDF header check let a real PDF through.
    assert body["status"] == "failed"
    assert body["error"] == "No embedding model configured on the Settings page."


def test_upload_file_rejects_binary_disguised_as_text(client):
    resp = client.post(
        "/api/files",
        files={"file": ("notes.txt", b"hello\x00world", "text/plain")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert "looks like a binary file" in body["error"]


def test_upload_file_accepts_plain_text(client):
    resp = client.post(
        "/api/files",
        files={"file": ("notes.txt", b"hello world", "text/plain")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["error"] == "No embedding model configured on the Settings page."
