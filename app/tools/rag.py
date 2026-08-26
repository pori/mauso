from sqlalchemy.orm import Session

from .. import rag_store


async def run(args: dict, db: Session, document_ids: list, base_url: str, api_key: str, embedding_model: str) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "No query given."}
    if not embedding_model:
        return {"error": "No embedding model configured on the Settings page -- can't search documents."}
    try:
        results = await rag_store.search(
            db, query, base_url, api_key, embedding_model, document_ids=document_ids or None,
        )
    except Exception as e:  # noqa: BLE001 -- surfaced to the model as a tool result, not a crash
        return {"error": str(e)}
    if not results:
        return {"results": [], "note": "No matching passages found (or no documents are active in this conversation)."}
    return {"results": results}
