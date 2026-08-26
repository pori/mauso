"""Shared helper for persisting a ChatImage row -- used by the upload route
and by the generate_image/edit_image tools alike, so every image that
exists in a conversation (user-supplied or agent-produced) is addressed the
same way: an integer id, fetched via GET /api/chat-images/{id}.

Blobs are encrypted at rest with MAUSO_SECRET_KEY (same Fernet mechanism as
the provider API keys, see crypto.py) -- this protects against someone
reading mauso.db/its backups directly, though the running mauso process can
always decrypt (it holds the key), so it's not the stronger "server never
holds a usable copy" guarantee client-side encryption would give; see
PROJECT_NOTES.md's Privacy/security model section for that tradeoff and the
design sketch for doing it properly later.
"""
import logging

from cryptography.fernet import InvalidToken
from sqlalchemy.orm import Session

from . import crypto
from .models import ChatImage

logger = logging.getLogger("mauso.chat_images")


def store_chat_image(db: Session, data: bytes, content_type: str, prompt: str = "", source: str = "upload") -> ChatImage:
    record = ChatImage(content_type=content_type, data=crypto.encrypt_bytes(data), prompt=prompt, source=source)
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def read_chat_image_bytes(record: ChatImage) -> bytes:
    """Decrypts a stored ChatImage's bytes. Rows written before this
    encryption was added hold plaintext directly -- an InvalidToken there
    isn't a real error, it just means "pre-encryption row", so those are
    served as-is rather than migrated on read. Run
    migrate_encrypt_images.py once to bring old rows up to the encrypted
    format instead of leaving them plaintext indefinitely."""
    try:
        return crypto.decrypt_bytes(record.data)
    except InvalidToken:
        logger.info("ChatImage %s is unencrypted (pre-encryption row) -- serving as-is.", record.id)
        return record.data
