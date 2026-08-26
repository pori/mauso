"""Chunking, embedding, and cosine-similarity search over uploaded documents.
Pure Python (no numpy/vector DB) -- fine at the chunk counts a PoC personal
knowledge base will actually see; revisit if that stops being true."""
import json
import math
from typing import Optional

from sqlalchemy.orm import Session

from . import llm_client
from .config import settings
from .models import Chunk, Document


def chunk_text(text: str) -> list:
    size = settings.chunk_chars
    overlap = settings.chunk_overlap_chars
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = end - overlap
    return chunks


async def index_document(db: Session, document: Document, text: str, base_url: str, api_key: str, embedding_model: str):
    pieces = chunk_text(text)
    if not pieces:
        document.status = "failed"
        document.error = "No extractable text found in this file."
        db.commit()
        return
    try:
        vectors = await llm_client.embed(base_url, api_key, embedding_model, pieces)
    except llm_client.LLMError as e:
        document.status = "failed"
        document.error = str(e)
        db.commit()
        return
    for i, (piece, vector) in enumerate(zip(pieces, vectors)):
        db.add(Chunk(document_id=document.id, chunk_index=i, text=piece, embedding_json=json.dumps(vector)))
    document.status = "indexed"
    document.error = ""
    db.commit()


def _cosine(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def search(
    db: Session, query: str, base_url: str, api_key: str, embedding_model: str,
    document_ids: Optional[list] = None, top_k: int = 5,
) -> list:
    """Returns a list of {filename, chunk_index, text, score}, best first."""
    vectors = await llm_client.embed(base_url, api_key, embedding_model, [query])
    query_vector = vectors[0]

    q = db.query(Chunk)
    if document_ids:
        q = q.filter(Chunk.document_id.in_(document_ids))
    candidates = q.all()

    scored = []
    for c in candidates:
        score = _cosine(query_vector, json.loads(c.embedding_json))
        scored.append((score, c))
    scored.sort(key=lambda pair: pair[0], reverse=True)

    results = []
    for score, c in scored[:top_k]:
        results.append({
            "filename": c.document.filename,
            "chunk_index": c.chunk_index,
            "text": c.text,
            "score": round(score, 4),
        })
    return results
