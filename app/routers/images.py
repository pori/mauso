"""Serves ChatImage bytes (both agent-generated/edited images and
user-uploaded ones) to the browser, and accepts uploads for the
edit_image skill to work on. See chat_images.py / models.ChatImage.

Also accepts a URL instead of file bytes, for pasting an image copied from
a web page (see static/app.js's paste handler): the browser clipboard often
carries only the image's URL (not its bytes), so that has to be fetched
server-side rather than via a client-side fetch(), which would be blocked
by CORS for most third-party image hosts anyway."""
import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..chat_images import read_chat_image_bytes, store_chat_image
from ..config import settings
from ..db import get_db
from ..models import ChatImage

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
                    return bytes(data), content_type
        except httpx.RequestError as e:
            raise HTTPException(400, f"Could not fetch that URL: {e}")
    raise HTTPException(400, "Too many redirects.")


@router.post("/api/chat-images")
async def upload_chat_image(file: UploadFile, db: Session = Depends(get_db)):
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(400, f"Expected an image, got content-type '{file.content_type}'.")
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(400, f"Image exceeds the {settings.max_upload_bytes // (1024 * 1024)}MB limit.")
    record = store_chat_image(db, data, file.content_type, source="upload")
    return {"id": record.id, "url": f"/api/chat-images/{record.id}"}


@router.post("/api/chat-images/fetch-url")
async def fetch_chat_image_from_url(body: FetchImageUrlRequest, db: Session = Depends(get_db)):
    data, content_type = await _fetch_image_bytes(body.url.strip())
    record = store_chat_image(db, data, content_type, source="url")
    return {"id": record.id, "url": f"/api/chat-images/{record.id}"}


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
