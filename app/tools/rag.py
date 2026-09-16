"""search_documents (RAG). Accepts an optional `attached_doc_chunks` corpus
-- the client's own copy of its active documents' chunks, attached directly
to a single /api/chat request the same way `search_notes` accepts
`attached_notes` (see routers/chat.py, tools/notes.py). When present,
ranking runs against that list instead of querying the Chunk table, and
nothing here touches the DB for candidates. This is the first slice of #13
(moving RAG documents to client-side-only storage) -- until the rest of
that migration lands, callers that don't attach a corpus keep getting the
existing DB-backed behavior unchanged."""
from sqlalchemy.orm import Session

from .. import rag_store


async def run(
    args: dict, db: Session, document_ids: list, base_url: str, api_key: str, embedding_model: str,
    attached_doc_chunks: list = None,
) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "No query given."}
    if not embedding_model:
        return {"error": "No embedding model configured on the Settings page -- can't search documents."}
    try:
        results = await rag_store.search(
            db, query, base_url, api_key, embedding_model, document_ids=document_ids or None,
            attached_chunks=attached_doc_chunks,
        )
    except Exception as e:  # noqa: BLE001 -- surfaced to the model as a tool result, not a crash
        return {"error": str(e)}
    if not results:
        return {"results": [], "note": "No matching passages found (or no documents are active in this conversation)."}
    return {"results": results}
