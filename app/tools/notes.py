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

See tools/registry.py for both schemas."""

from sqlalchemy.orm import Session

from ..models import Note

MAX_RESULTS = 10


def run(args: dict) -> dict:
    title = (args.get("title") or "Untitled note").strip()
    content = (args.get("content_markdown") or "").strip()
    return {"title": title, "content_markdown": content}


def search(args: dict, db: Session) -> dict:
    query = (args.get("query") or "").strip().lower()
    notes = db.query(Note).order_by(Note.updated_at.desc()).all()
    if query:
        notes = [n for n in notes if query in n.title.lower() or query in n.content_markdown.lower()]
    if not notes:
        return {"results": [], "note": "No saved notes matched (or none exist yet -- see the Notes page)."}
    return {
        "results": [
            {"id": n.id, "title": n.title, "content_markdown": n.content_markdown}
            for n in notes[:MAX_RESULTS]
        ],
    }
