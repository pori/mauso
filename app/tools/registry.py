"""OpenAI function-calling schemas for the skills the agent can invoke.
Tool *execution* lives in the sibling modules (image_gen.py, notes.py,
rag.py) -- this file is just the schema the model sees."""

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": (
                "Generate an image from a text prompt using the local ComfyUI "
                "instance. Use this when the user asks for a picture, illustration, "
                "or visual to be created."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Description of the image to generate."},
                    "negative_prompt": {"type": "string", "description": "Things to avoid in the image. Optional."},
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_image",
            "description": (
                "Edit an existing image using a text instruction (e.g. 'make the "
                "sky purple', 'remove the background'). The source image must "
                "already exist in this conversation -- either one you previously "
                "made with generate_image/edit_image (use its image_id), or one "
                "the user uploaded (its id is given in the conversation)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_image_id": {"type": "integer", "description": "id of the image to edit."},
                    "prompt": {"type": "string", "description": "What to change about the image."},
                },
                "required": ["source_image_id", "prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_note",
            "description": (
                "Produce a structured, well-formatted note (e.g. a summary, a "
                "set of meeting notes, a plan) as a distinct artifact in the "
                "conversation, separate from your conversational reply. Use this "
                "when the user asks you to write up, summarize, or save notes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short title for the note."},
                    "content_markdown": {"type": "string", "description": "The note body, in Markdown."},
                },
                "required": ["title", "content_markdown"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_notes",
            "description": (
                "Search the user's saved notes (managed on the Notes page) for "
                "ones relevant to a query, or list them all if the query is "
                "empty. Use this when the user asks you to reference, recall, "
                "or use something from their saved notes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for. Leave empty to list all saved notes."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the live web for current information via the Tavily "
                "search API. Use this for anything time-sensitive, recent, or "
                "outside your training data -- current events, prices, "
                "documentation for fast-moving software, or anything the user "
                "asks you to look up online."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": (
                "Search the user's uploaded documents for passages relevant to a "
                "query. Use this before answering questions about content the user "
                "has uploaded to this conversation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for."},
                },
                "required": ["query"],
            },
        },
    },
]


def schemas_for(enabled_tool_names: set) -> list:
    return [s for s in TOOL_SCHEMAS if s["function"]["name"] in enabled_tool_names]
