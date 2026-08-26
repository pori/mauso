from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import llm_client, settings_store
from ..db import get_db

router = APIRouter()


class SettingsIn(BaseModel):
    base_url: str = ""
    api_key: str = ""  # blank = leave the stored key untouched
    model: str = ""
    embedding_model: str = ""
    comfyui_checkpoint: str = ""
    tavily_api_key: str = ""  # blank = leave the stored key untouched


class ClearKeyIn(BaseModel):
    clear_api_key: bool = True


@router.get("/api/settings")
def get_settings(db: Session = Depends(get_db)):
    return settings_store.get_public(db)


@router.post("/api/settings")
def save_settings(body: SettingsIn, db: Session = Depends(get_db)):
    settings_store.save(
        db, body.base_url, body.api_key, body.model, body.embedding_model, body.comfyui_checkpoint,
        body.tavily_api_key,
    )
    return settings_store.get_public(db)


@router.post("/api/settings/clear-api-key")
def clear_api_key(db: Session = Depends(get_db)):
    settings_store.clear_api_key(db)
    return settings_store.get_public(db)


@router.post("/api/settings/clear-tavily-key")
def clear_tavily_key(db: Session = Depends(get_db)):
    settings_store.clear_tavily_api_key(db)
    return settings_store.get_public(db)


@router.get("/api/models")
async def list_models(db: Session = Depends(get_db)):
    """Feeds the chat window's model picker. Excludes the configured
    embedding model -- it'd show up in the same /models listing as the
    chat models but can't actually serve a chat completion."""
    base_url = settings_store.get_base_url(db)
    if not base_url:
        return {"models": []}
    try:
        models = await llm_client.list_models(base_url, settings_store.get_decrypted_api_key(db))
    except llm_client.LLMError as e:
        raise HTTPException(502, str(e)) from e
    embedding_model = settings_store.get_embedding_model(db)
    return {"models": [m for m in models if m["id"] != embedding_model]}
