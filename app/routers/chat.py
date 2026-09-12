import json
from typing import Union

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import agent
from ..db import get_db

router = APIRouter()


class ChatMessage(BaseModel):
    role: str
    # A plain string for text-only turns, or an OpenAI-style multipart list
    # (`[{"type": "text", ...}, {"type": "image_url", ...}]`) when the
    # client attaches an image -- passed straight through to the LLM
    # endpoint untouched, see llm_client.py.
    content: Union[str, list]


class AttachedImage(BaseModel):
    """A client-held image the browser attaches directly to this request
    for edit_image to operate on, instead of it having been uploaded to
    /api/chat-images (and persisted server-side) first. Part of the
    request-scoped "client-attached material" pattern -- these bytes never
    touch disk here, only this request's memory, for the duration of this
    single turn, same boundary as the message text itself."""
    id: str
    data_b64: str
    content_type: str = "image/png"


class AttachedNote(BaseModel):
    """A client-held saved note the browser attaches directly to this
    request for search_notes to search, instead of the tool querying the
    (still server-side, for now -- see #12) Note table. Same
    "client-attached material" pattern as AttachedImage above -- never
    persisted, only this request's memory for the duration of this turn."""
    id: str
    title: str
    content_markdown: str
    tags: list[str] = []


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    active_document_ids: list[int] = []
    enabled_tools: list[str] = [
        "generate_image", "edit_image", "create_note", "search_documents", "search_notes", "web_search",
    ]
    model: str = ""  # blank = use the Settings-page default
    profile_id: int | None = None
    attached_images: list[AttachedImage] = []
    attached_notes: list[AttachedNote] = []


@router.post("/api/chat")
async def chat(body: ChatRequest, db: Session = Depends(get_db)):
    """The only place plaintext conversation content reaches this backend --
    for the duration of this single request, to relay to the configured LLM
    endpoint and run the tool loop. Nothing here is written to disk; the
    client is solely responsible for persisting (encrypted) history."""
    messages = [m.model_dump() for m in body.messages]

    async def event_stream():
        async for event in agent.run_agent_turn(
            db, messages, set(body.enabled_tools), body.active_document_ids,
            model_override=body.model, profile_id=body.profile_id,
            attached_images=[a.model_dump() for a in body.attached_images],
            attached_notes=[n.model_dump() for n in body.attached_notes],
        ):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
