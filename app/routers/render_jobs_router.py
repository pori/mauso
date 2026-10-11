"""Lets the client recover a generate_image/edit_image render that
finished after its /api/chat request got cancelled (tab backgrounded/
navigated away mid-render -- see #10, models.RenderJob). No auth beyond
the unguessable job id, same no-user-model design as
/api/chat-images/{id}."""
import base64

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crypto
from ..db import get_db
from ..models import RenderJob

router = APIRouter()


@router.get("/api/render-jobs/{job_id}")
def get_render_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(RenderJob, job_id)
    if not job:
        raise HTTPException(404, "Not found")
    body = {"status": job.status, "error": job.error or ""}
    if job.status == "succeeded" and job.result_data is not None:
        body["image_b64"] = base64.b64encode(crypto.decrypt_bytes(job.result_data)).decode()
        body["content_type"] = job.result_content_type or "image/png"
    return body


@router.delete("/api/render-jobs/{job_id}")
def delete_render_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(RenderJob, job_id)
    if not job:
        raise HTTPException(404, "Not found")
    db.delete(job)
    db.commit()
    return {"ok": True}
