"""Covers the magic-byte checks added on top of the client-claimed
Content-Type in routers/images.py and routers/files.py -- a file that
claims to be one format but isn't should be rejected, not stored/parsed."""
import io

from pypdf import PdfWriter

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _valid_pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_upload_chat_image_rejects_mismatched_content(client):
    resp = client.post(
        "/api/chat-images",
        files={"file": ("fake.png", b"not actually a png", "image/png")},
    )
    assert resp.status_code == 400
    assert "doesn't match a supported image format" in resp.json()["detail"]


def test_upload_chat_image_accepts_real_png_bytes(client):
    resp = client.post(
        "/api/chat-images",
        files={"file": ("real.png", PNG_SIGNATURE + b"rest-of-file", "image/png")},
    )
    assert resp.status_code == 200
    assert "id" in resp.json()


def test_upload_chat_image_rejects_non_image_content_type(client):
    resp = client.post(
        "/api/chat-images",
        files={"file": ("doc.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 400
    assert "Expected an image" in resp.json()["detail"]


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
