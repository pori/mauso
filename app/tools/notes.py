"""Two unrelated skills live here:

`run` (create_note) is deliberately just a formatting convention, not a
storage feature -- the note is returned to the client as part of the
(client-encrypted, browser-stored) conversation like any other message, so
it inherits the same end-to-end encryption and never touches this
backend's disk.

`search` (search_notes) looks up the persistent notes managed from the
Notes page (see routers/notes_router.py, models.Note) -- those DO live in
plaintext on this backend, same tradeoff as uploaded RAG documents. Plain
substring matching, not embeddings: notebooks here are small and don't
warrant the embedding-model dependency search_documents has.

`search` also accepts an optional `attached_notes` corpus -- the client's
own copy of its notes, attached directly to a single /api/chat request the
same way `edit_image` accepts `attached_images` (see routers/chat.py,
tools/image_edit.py). When present, matching runs against that list
instead of querying the Note table, and nothing here touches the DB. This
is the first slice of #12 (moving saved notes to client-side-only storage)
-- until the rest of that migration lands, callers that don't attach a
corpus keep getting the existing DB-backed behavior unchanged.

See tools/registry.py for both schemas."""

from sqlalchemy.orm import Session

from ..models import Note

MAX_RESULTS = 10


def run(args: dict) -> dict:
    title = (args.get("title") or "Untitled note").strip()
    content = (args.get("content_markdown") or "").strip()
    return {"title": title, "content_markdown": content}


def normalize_tags(raw: str) -> str:
    """Comma-separated tag input -> deduped/trimmed/lowercased, comma-joined
    for storage on Note.tags."""
    seen = []
    for part in (raw or "").split(","):
        tag = part.strip().lower()
        if tag and tag not in seen:
            seen.append(tag)
    return ",".join(seen)


def parse_tags(raw: str) -> list:
    """Note.tags storage string -> list of tags."""
    return [t for t in (raw or "").split(",") if t]


def search(args: dict, db: Session, attached_notes: list = None) -> dict:
    query = (args.get("query") or "").strip().lower()
    tag = (args.get("tag") or "").strip().lower()

    if attached_notes:
        candidates = [
            {
                "id": n.get("id"),
                "title": n.get("title") or "",
                "content_markdown": n.get("content_markdown") or "",
                "tags": [t.strip().lower() for t in (n.get("tags") or []) if t.strip()],
            }
            for n in attached_notes
        ]
    else:
        candidates = [
            {"id": n.id, "title": n.title, "content_markdown": n.content_markdown, "tags": parse_tags(n.tags)}
            for n in db.query(Note).order_by(Note.updated_at.desc()).all()
        ]

    if query:
        candidates = [n for n in candidates if query in n["title"].lower() or query in n["content_markdown"].lower()]
    if tag:
        candidates = [n for n in candidates if tag in n["tags"]]
    if not candidates:
        return {"results": [], "note": "No saved notes matched (or none exist yet -- see the Notes page)."}
    return {"results": candidates[:MAX_RESULTS]}
