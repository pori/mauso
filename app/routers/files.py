import io

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import rag_store, settings_store
from ..config import settings
from ..db import get_db
from ..models import Document
from ..upload_validation import is_valid_pdf, looks_binary

router = APIRouter()

TEXT_EXTENSIONS = (".txt", ".md", ".markdown", ".csv", ".json", ".log")


def _extract_text(filename: str, content_type: str, data: bytes) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf") or content_type == "application/pdf":
        if not is_valid_pdf(data):
            raise ValueError(f"'{filename}' doesn't look like a valid PDF (missing PDF header).")
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if lower.endswith(TEXT_EXTENSIONS) or content_type.startswith("text/"):
        if looks_binary(data):
            raise ValueError(f"'{filename}' looks like a binary file, not text.")
        return data.decode("utf-8", errors="replace")
    raise ValueError(f"Unsupported file type for '{filename}'. Supported: .txt, .md, .csv, .json, .log, .pdf")


@router.get("/api/files")
def list_files(db: Session = Depends(get_db)):
    docs = db.query(Document).order_by(Document.created_at.desc()).all()
    return [{
        "id": d.id, "filename": d.filename, "size_bytes": d.size_bytes,
        "status": d.status, "error": d.error, "chunk_count": len(d.chunks),
    } for d in docs]


@router.post("/api/files")
async def upload_file(file: UploadFile, db: Session = Depends(get_db)):
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(400, f"File exceeds the {settings.max_upload_bytes // (1024 * 1024)}MB limit.")

    document = Document(
        filename=file.filename or "upload", content_type=file.content_type or "",
        size_bytes=len(data), status="pending",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    try:
        text = _extract_text(document.filename, document.content_type, data)
    except ValueError as e:
        document.status = "failed"
        document.error = str(e)
        db.commit()
        return {"id": document.id, "filename": document.filename, "status": document.status, "error": document.error}

    base_url = settings_store.get_base_url(db)
    api_key = settings_store.get_decrypted_api_key(db)
    embedding_model = settings_store.get_embedding_model(db)
    if not embedding_model:
        document.status = "failed"
        document.error = "No embedding model configured on the Settings page."
        db.commit()
    else:
        await rag_store.index_document(db, document, text, base_url, api_key, embedding_model)

    return {
        "id": document.id, "filename": document.filename,
        "status": document.status, "error": document.error, "chunk_count": len(document.chunks),
    }


@router.delete("/api/files/{document_id}")
def delete_file(document_id: int, db: Session = Depends(get_db)):
    document = db.get(Document, document_id)
    if not document:
        raise HTTPException(404, "Not found")
    db.delete(document)
    db.commit()
    return {"ok": True}
