from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Note

router = APIRouter()


class NoteIn(BaseModel):
    title: str
    content_markdown: str = ""


def _public(n: Note) -> dict:
    return {
        "id": n.id, "title": n.title, "content_markdown": n.content_markdown,
        "created_at": n.created_at.isoformat() if n.created_at else None,
        "updated_at": n.updated_at.isoformat() if n.updated_at else None,
    }


@router.get("/api/notes")
def list_notes(db: Session = Depends(get_db)):
    notes = db.query(Note).order_by(Note.updated_at.desc()).all()
    return [_public(n) for n in notes]


@router.post("/api/notes")
def create_note(body: NoteIn, db: Session = Depends(get_db)):
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "Title is required.")
    note = Note(title=title, content_markdown=body.content_markdown)
    db.add(note)
    db.commit()
    db.refresh(note)
    return _public(note)


@router.put("/api/notes/{note_id}")
def update_note(note_id: int, body: NoteIn, db: Session = Depends(get_db)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Not found")
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "Title is required.")
    note.title = title
    note.content_markdown = body.content_markdown
    db.commit()
    return _public(note)


@router.delete("/api/notes/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Not found")
    db.delete(note)
    db.commit()
    return {"ok": True}
