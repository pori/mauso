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


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    active_document_ids: list[int] = []
    enabled_tools: list[str] = [
        "generate_image", "edit_image", "create_note", "search_documents", "search_notes", "web_search",
    ]
    model: str = ""  # blank = use the Settings-page default
    profile_id: int | None = None


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
        ):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
