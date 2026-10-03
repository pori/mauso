"""Helper for the legacy ChatImage table. As of #11 stage 2, images are
client-side-only -- generate_image/edit_image no longer call
store_chat_image, and the upload route that used to call it is gone.
store_chat_image() stays only because tests still use it to seed legacy
rows for the GET/DELETE routes' and image_edit.py's DB-fallback path's
coverage; it is not a live write path anymore. read_chat_image_bytes() is
still live -- it's how the browser's one-time migration pass and the
legacy GET route read old rows.

Blobs already on disk stay encrypted at rest with MAUSO_SECRET_KEY (same
Fernet mechanism as the provider API keys, see crypto.py) -- this protects
against someone reading mauso.db/its backups directly, though the running
mauso process can always decrypt (it holds the key). Dropping the
ChatImage table entirely (and this module with it) is a separate, later,
manual step -- see PROJECT_NOTES.md.
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
