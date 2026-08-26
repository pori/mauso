"""Runtime-editable provider config, stored in the app_setting table -- lets
the endpoint URL/key/model names be changed from the Settings page without a
redeploy. Both API keys (LLM provider, Tavily) are encrypted at rest
(crypto.py) and this module never returns a decrypted value except via the
get_decrypted_*_api_key() functions, used only when actually calling out."""
from sqlalchemy.orm import Session

from . import crypto
from .config import settings
from .models import AppSetting

BASE_URL_KEY = "llm_base_url"
API_KEY_KEY = "llm_api_key_encrypted"
MODEL_KEY = "llm_model"
EMBEDDING_MODEL_KEY = "llm_embedding_model"
COMFYUI_CHECKPOINT_KEY = "comfyui_checkpoint"
TAVILY_API_KEY_KEY = "tavily_api_key_encrypted"

PLAIN_KEYS = (BASE_URL_KEY, MODEL_KEY, EMBEDDING_MODEL_KEY, COMFYUI_CHECKPOINT_KEY)


def _get(db: Session, key: str) -> str:
    row = db.get(AppSetting, key)
    return row.value if row and row.value else ""


def _set(db: Session, key: str, value: str):
    row = db.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()


def get_public(db: Session) -> dict:
    """Values safe to send to the browser -- never the decrypted API key."""
    return {
        "base_url": _get(db, BASE_URL_KEY),
        "model": get_model(db),
        "embedding_model": _get(db, EMBEDDING_MODEL_KEY),
        "comfyui_checkpoint": _get(db, COMFYUI_CHECKPOINT_KEY),
        "api_key_set": bool(_get(db, API_KEY_KEY)),
        "tavily_api_key_set": bool(_get(db, TAVILY_API_KEY_KEY)),
    }


def get_decrypted_api_key(db: Session) -> str:
    return crypto.decrypt(_get(db, API_KEY_KEY))


def get_decrypted_tavily_api_key(db: Session) -> str:
    return crypto.decrypt(_get(db, TAVILY_API_KEY_KEY))


def get_base_url(db: Session) -> str:
    return _get(db, BASE_URL_KEY)


def get_model(db: Session) -> str:
    # Falls back to DEFAULT_CHAT_MODEL (see config.py) only until something
    # is actually saved via the Settings page -- once saved, that value
    # always wins, even if the env var later changes.
    return _get(db, MODEL_KEY) or settings.default_chat_model


def get_embedding_model(db: Session) -> str:
    return _get(db, EMBEDDING_MODEL_KEY)


def get_comfyui_checkpoint(db: Session) -> str:
    return _get(db, COMFYUI_CHECKPOINT_KEY)


def save(
    db: Session, base_url: str, api_key: str, model: str, embedding_model: str, comfyui_checkpoint: str,
    tavily_api_key: str = "",
):
    _set(db, BASE_URL_KEY, base_url.strip())
    _set(db, MODEL_KEY, model.strip())
    _set(db, EMBEDDING_MODEL_KEY, embedding_model.strip())
    _set(db, COMFYUI_CHECKPOINT_KEY, comfyui_checkpoint.strip())
    if api_key.strip():  # blank means "leave the stored key alone"
        _set(db, API_KEY_KEY, crypto.encrypt(api_key.strip()))
    if tavily_api_key.strip():
        _set(db, TAVILY_API_KEY_KEY, crypto.encrypt(tavily_api_key.strip()))


def clear_api_key(db: Session):
    _set(db, API_KEY_KEY, "")


def clear_tavily_api_key(db: Session):
    _set(db, TAVILY_API_KEY_KEY, "")
