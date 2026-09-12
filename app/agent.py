"""The agent turn: resolve any tool calls the model wants against a plain
(non-streaming) endpoint, then stream the final answer once it stops asking
for tools. See llm_client.py's docstring on chat_completion_stream for why
the last hop is a separate streaming call rather than accumulating
streamed tool_call deltas.

Nothing here persists the conversation -- `messages` in and a stream of
events out, that's the whole contract. The caller (routers/chat.py) is
responsible for relaying events to the client; the client is responsible
for encrypting and storing the resulting transcript.
"""
import json
import logging
from typing import AsyncIterator

from sqlalchemy.orm import Session

from . import llm_client, settings_store
from .config import settings
from .models import Profile
from .tools import image_edit, image_gen, notes, rag, web_search
from .tools.registry import schemas_for

logger = logging.getLogger("mauso.agent")

ALL_TOOL_NAMES = {
    "generate_image", "edit_image", "create_note", "search_documents", "search_notes", "web_search",
}

_BASE_SYSTEM_PROMPT = (
    "You are the assistant embedded in mauso, a self-hosted chat app. The user's "
    "conversation history is end-to-end encrypted in their browser and lives only "
    "there -- this backend never stores or logs it. Images and notes are referenced "
    "by id in later turns as text placeholders, e.g. '[Image id=3: a red bicycle]' "
    "or '[Note \"Meeting notes\"]' -- when you're on a vision-capable model, the "
    "actual image is also attached alongside that placeholder, so you can describe "
    "or reason about its contents; keep using the id to refer back to it (e.g. for "
    "edit_image). Those in-conversation notes (create_note) are separate from the "
    "user's persistent saved notes managed on the Notes page -- use search_notes to "
    "look those up when asked."
)


def _build_system_prompt(tool_schemas: list, profile_prompt: str = "") -> str:
    if not tool_schemas:
        prompt = _BASE_SYSTEM_PROMPT + " You have no tools available this turn."
    else:
        tool_lines = "\n".join(
            f"- {s['function']['name']}: {s['function']['description']}" for s in tool_schemas
        )
        prompt = (
            f"{_BASE_SYSTEM_PROMPT} You have tool-calling available this turn -- use a "
            f"tool whenever it applies instead of just describing what you would do. "
            f"Available tools:\n{tool_lines}"
        )
    if profile_prompt.strip():
        prompt += (
            "\n\nAdditional instructions for this conversation, set by the user "
            f"via a Profile -- follow these:\n{profile_prompt.strip()}"
        )
    return prompt


async def _execute_tool(
    name: str, args: dict, db: Session, active_document_ids: list, base_url: str, api_key: str,
    embedding_model: str, comfyui_checkpoint: str, tavily_api_key: str, attached_images: dict,
    attached_notes: list,
) -> dict:
    if name == "generate_image":
        return await image_gen.run(args, db, comfyui_checkpoint)
    if name == "edit_image":
        return await image_edit.run(args, db, comfyui_checkpoint, attached_images)
    if name == "create_note":
        return notes.run(args)
    if name == "search_notes":
        return notes.search(args, db, attached_notes)
    if name == "search_documents":
        return await rag.run(args, db, active_document_ids, base_url, api_key, embedding_model)
    if name == "web_search":
        return await web_search.run(args, tavily_api_key)
    return {"error": f"Unknown tool: {name}"}


async def run_agent_turn(
    db: Session, messages: list, enabled_tools: set, active_document_ids: list, model_override: str = "",
    profile_id: int = None, attached_images: list = None, attached_notes: list = None,
) -> AsyncIterator[dict]:
    attached_images_by_id = {str(a["id"]): a for a in (attached_images or [])}
    base_url = settings_store.get_base_url(db)
    api_key = settings_store.get_decrypted_api_key(db)
    model = model_override or settings_store.get_model(db)
    embedding_model = settings_store.get_embedding_model(db)
    comfyui_checkpoint = settings_store.get_comfyui_checkpoint(db)
    tavily_api_key = settings_store.get_decrypted_tavily_api_key(db)

    profile_prompt = ""
    if profile_id:
        profile = db.get(Profile, profile_id)
        if profile:
            profile_prompt = profile.system_prompt

    tool_schemas = schemas_for(enabled_tools & ALL_TOOL_NAMES)
    system_prompt = _build_system_prompt(tool_schemas, profile_prompt)
    working_messages = [{"role": "system", "content": system_prompt}] + list(messages)

    try:
        for _ in range(settings.max_agent_tool_iterations):
            msg = await llm_client.chat_completion(base_url, api_key, model, working_messages, tools=tool_schemas or None)
            tool_calls = msg.get("tool_calls")
            if not tool_calls:
                break
            working_messages.append(msg)
            for tc in tool_calls:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield {"type": "tool_call", "name": name, "args": args}
                result = await _execute_tool(
                    name, args, db, active_document_ids, base_url, api_key, embedding_model, comfyui_checkpoint,
                    tavily_api_key, attached_images_by_id, attached_notes,
                )
                yield {"type": "tool_result", "name": name, "result": result}
                working_messages.append({
                    "role": "tool", "tool_call_id": tc.get("id", ""), "content": json.dumps(result),
                })
        else:
            yield {"type": "error", "message": "Reached the tool-call iteration limit without a final answer."}
            return

        # Surfaces which model actually answered -- the endpoint's echoed
        # `model` field if it sends one (routers/aliases can resolve the
        # requested id to a different served model), else falls back to
        # what was requested so the client always has something to show.
        resolved_model = None
        async for chunk in llm_client.chat_completion_stream(base_url, api_key, model, working_messages):
            if resolved_model is None and chunk.get("model"):
                resolved_model = chunk["model"]
                yield {"type": "model", "name": resolved_model}
            if chunk.get("content"):
                yield {"type": "token", "content": chunk["content"]}
        if resolved_model is None:
            yield {"type": "model", "name": model}
        yield {"type": "done"}
    except llm_client.LLMError as e:
        logger.warning("Agent turn failed: %s", e)
        yield {"type": "error", "message": str(e)}
