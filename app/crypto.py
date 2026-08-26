"""Server-side secret storage -- for third-party API keys the backend holds
on the user's behalf (the LLM provider's key, the Tavily key for
web_search). See settings_store.py for what's stored under which key.

Not to be confused with the browser-side Web Crypto encryption of
conversation content (see app/static/crypto.js), which this module has no
part in and cannot decrypt -- this backend never receives an encryption
key or ciphertext for conversations, only plaintext messages for the
duration of a single /api/chat request.
"""
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


class SecretKeyNotConfigured(Exception):
    pass


@lru_cache
def _fernet() -> Fernet:
    if not settings.secret_key:
        raise SecretKeyNotConfigured(
            "MAUSO_SECRET_KEY is not set. Generate one (see .env.example) and "
            "restart the container before saving a provider API key."
        )
    return Fernet(settings.secret_key.encode())


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        return ""


# Byte-oriented variants, for ChatImage blobs (chat_images.py) rather than
# the string settings above. Deliberately doesn't swallow InvalidToken like
# decrypt() does -- a blank string is a harmless fallback for a settings
# field, but silently serving 0 bytes for an image would just look like a
# broken image with no signal as to why. Callers decide how to handle it;
# see chat_images.read_chat_image_bytes for the legacy-plaintext fallback
# used by every read site.
def encrypt_bytes(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_bytes(data: bytes) -> bytes:
    return _fernet().decrypt(data)
