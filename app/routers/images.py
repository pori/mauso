"""Images are client-side-only storage as of #11 stage 2 -- this router no
longer accepts or persists uploads. What's left:

- GET/DELETE /api/chat-images/{id}: legacy/migration-only. They still serve
  and clean up ChatImage rows written before this stage shipped (and any
  the maintainer-run migrate_encrypt_images.py script touched), so the
  browser's one-time migration pass can pull old images into IndexedDB and
  so stale rows can be cleaned up by hand. Nothing writes a new row through
  this file anymore. The ChatImage table itself is a deliberate holdover --
  dropping it is a separate, later, manual step (see PROJECT_NOTES.md).
- POST /api/chat-images/fetch-url: stays, but is now stateless. Pasting an
  image copied from a web page only gives the browser a URL (not bytes),
  and fetching that URL has to happen server-side -- a client-side fetch()
  would be blocked by CORS for most third-party image hosts, and the
  SSRF guard below needs to run somewhere trusted either way. This handler
  fetches, validates, and hands the bytes back to the client as base64;
  it no longer stores them."""
import base64
import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..chat_images import read_chat_image_bytes
from ..config import settings
from ..db import get_db
from ..models import ChatImage
from ..upload_validation import sniff_image_type

router = APIRouter()

_MAX_REDIRECTS = 3


class FetchImageUrlRequest(BaseModel):
    url: str


def _reject_private_host(hostname: str) -> None:
    """Blocks the server from being tricked into fetching (and storing) a
    response from an internal/private address -- e.g. this host's own
    docker network (comfyui:8188) or a cloud metadata endpoint -- via a
    pasted URL. Resolves DNS itself since httpx doesn't screen for this."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise HTTPException(400, "Could not resolve that host.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HTTPException(400, "That URL points at a private/internal address, which isn't allowed.")


def _validate_public_http_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(400, "Only http/https URLs are supported.")
    if not parsed.hostname:
        raise HTTPException(400, "Invalid URL.")
    _reject_private_host(parsed.hostname)


async def _fetch_image_bytes(url: str) -> tuple[bytes, str]:
    for _ in range(_MAX_REDIRECTS + 1):
        _validate_public_http_url(url)
        try:
            async with httpx.AsyncClient(timeout=settings.image_fetch_timeout_seconds, follow_redirects=False) as client:
                async with client.stream("GET", url) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("location")
                        if not location:
                            raise HTTPException(400, "Redirect with no Location header.")
                        url = urljoin(url, location)
                        continue
                    if resp.status_code != 200:
                        raise HTTPException(400, f"Fetching that URL returned HTTP {resp.status_code}.")
                    content_type = (resp.headers.get("content-type") or "").split(";")[0].strip()
                    if not content_type.startswith("image/"):
                        raise HTTPException(400, f"That URL isn't an image (content-type '{content_type}').")
                    data = bytearray()
                    async for chunk in resp.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > settings.max_upload_bytes:
                            raise HTTPException(400, f"Image exceeds the {settings.max_upload_bytes // (1024 * 1024)}MB limit.")
                    sniffed = sniff_image_type(bytes(data))
                    if sniffed is None:
                        raise HTTPException(400, "That URL's response claimed to be an image but its content doesn't match a supported image format (PNG, JPEG, GIF, WEBP).")
                    return bytes(data), sniffed
        except httpx.RequestError as e:
            raise HTTPException(400, f"Could not fetch that URL: {e}")
    raise HTTPException(400, "Too many redirects.")


@router.post("/api/chat-images/fetch-url")
async def fetch_chat_image_from_url(body: FetchImageUrlRequest):
    data, content_type = await _fetch_image_bytes(body.url.strip())
    return {"data_b64": base64.b64encode(data).decode(), "content_type": content_type}


@router.get("/api/chat-images/{image_id}")
def get_chat_image(image_id: int, db: Session = Depends(get_db)):
    record = db.get(ChatImage, image_id)
    if not record:
        raise HTTPException(404, "Not found")
    return Response(content=read_chat_image_bytes(record), media_type=record.content_type or "image/png")


@router.delete("/api/chat-images/{image_id}")
def delete_chat_image(image_id: int, db: Session = Depends(get_db)):
    record = db.get(ChatImage, image_id)
    if not record:
        raise HTTPException(404, "Not found")
    db.delete(record)
    db.commit()
    return {"ok": True}
