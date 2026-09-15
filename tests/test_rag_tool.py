import asyncio
import json

from app import rag_store
from app.models import Chunk, Document
from app.tools import rag


def _run(coro):
    # No async test runner (pytest-asyncio/anyio) in this repo's dev deps --
    # mirrors test_image_edit_tool.py's `_run` helper.
    return asyncio.run(coro)


async def _fake_embed(base_url, api_key, embedding_model, texts):
    # Returns a fixed unit vector for every input -- the tests below care
    # about which candidates get ranked/returned, not about real embedding
    # quality, so the query vector just needs to be *something* consistent.
    return [[1.0, 0.0] for _ in texts]


def _make_document_with_chunk(db_session, filename, chunk_index, text, vector):
    doc = Document(filename=filename, status="indexed")
    db_session.add(doc)
    db_session.commit()
    db_session.refresh(doc)
    chunk = Chunk(document_id=doc.id, chunk_index=chunk_index, text=text, embedding_json=json.dumps(vector))
    db_session.add(chunk)
    db_session.commit()
    return doc


def test_search_with_no_documents_is_graceful(db_session, monkeypatch):
    monkeypatch.setattr(rag_store.llm_client, "embed", _fake_embed)

    result = _run(rag.run({"query": "budget"}, db_session, [], "http://fake", "", "fake-embed-model"))

    assert result["results"] == []
    assert "note" in result


def test_run_errors_without_a_query(db_session):
    result = _run(rag.run({}, db_session, [], "http://fake", "", "fake-embed-model"))
    assert "error" in result


def test_run_errors_without_an_embedding_model(db_session):
    result = _run(rag.run({"query": "budget"}, db_session, [], "http://fake", "", ""))
    assert "error" in result


def test_search_ranks_db_backed_chunks_by_cosine_similarity(db_session, monkeypatch):
    monkeypatch.setattr(rag_store.llm_client, "embed", _fake_embed)
    _make_document_with_chunk(db_session, "close.md", 0, "close match", [1.0, 0.0])
    _make_document_with_chunk(db_session, "far.md", 0, "far match", [0.0, 1.0])

    result = _run(rag.run({"query": "budget"}, db_session, [], "http://fake", "", "fake-embed-model"))

    assert [r["filename"] for r in result["results"]] == ["close.md", "far.md"]


def test_search_with_attached_chunks_ignores_the_db(db_session, monkeypatch):
    """When the client attaches a doc-chunk corpus, that's what gets ranked --
    any rows in the (still server-side, for now) Chunk/Document tables must
    be ignored entirely, not merged in. This is the crux of #13, mirroring
    #12's search_notes/attached_notes tension."""
    monkeypatch.setattr(rag_store.llm_client, "embed", _fake_embed)
    _make_document_with_chunk(db_session, "db-only.md", 0, "should never surface", [1.0, 0.0])
    attached = [{"document_id": "d1", "filename": "attached.md", "chunk_index": 0, "text": "from the browser", "vector": [1.0, 0.0]}]

    result = _run(rag.run(
        {"query": "budget"}, db_session, [], "http://fake", "", "fake-embed-model", attached_doc_chunks=attached,
    ))

    assert [r["filename"] for r in result["results"]] == ["attached.md"]


def test_search_attached_chunks_ranked_by_cosine_similarity(db_session, monkeypatch):
    monkeypatch.setattr(rag_store.llm_client, "embed", _fake_embed)
    attached = [
        {"document_id": "d1", "filename": "far.md", "chunk_index": 0, "text": "far", "vector": [0.0, 1.0]},
        {"document_id": "d2", "filename": "close.md", "chunk_index": 0, "text": "close", "vector": [1.0, 0.0]},
    ]

    result = _run(rag.run(
        {"query": "budget"}, db_session, [], "http://fake", "", "fake-embed-model", attached_doc_chunks=attached,
    ))

    assert [r["filename"] for r in result["results"]] == ["close.md", "far.md"]


def test_search_falls_back_to_db_when_attached_chunks_is_empty(db_session, monkeypatch):
    monkeypatch.setattr(rag_store.llm_client, "embed", _fake_embed)
    _make_document_with_chunk(db_session, "db.md", 0, "db chunk", [1.0, 0.0])

    result = _run(rag.run(
        {"query": "budget"}, db_session, [], "http://fake", "", "fake-embed-model", attached_doc_chunks=[],
    ))

    assert [r["filename"] for r in result["results"]] == ["db.md"]
