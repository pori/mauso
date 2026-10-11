"""Keeps a generate_image/edit_image render alive past the request that
started it (see models.RenderJob's docstring and #10). The mechanism:
asyncio.create_task() detaches the actual ComfyUI submit+poll coroutine
from the request's own task, and the caller awaits it via asyncio.shield()
-- if the *caller's* task gets cancelled (client disconnect), the shield
absorbs that cancellation at the await point while the tracked task keeps
running to completion independently. No Redis/Celery: this is a single-
container, single-worker app, an in-process asyncio.Task is enough.

_tasks holds a strong reference to every in-flight task -- asyncio only
keeps a weak one internally, so without this a task can be garbage
collected mid-render if nothing else references it (the original awaiter
may have already been cancelled and dropped its reference by then)."""
import asyncio
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, update

from . import crypto
from .config import settings
from .db import SessionLocal
from .models import RenderJob

_tasks: set[asyncio.Task] = set()


def create_job(db, kind: str) -> RenderJob:
    _sweep_expired(db)
    job = RenderJob(id=secrets.token_urlsafe(16), kind=kind, status="queued")
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def _sweep_expired(db) -> None:
    # Naive UTC, to match the naive timestamps SQLite/func.now() store on
    # the other DateTime columns in this app (see models.py) -- a
    # tz-aware cutoff compared against those would raise.
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=settings.render_job_ttl_hours)
    db.execute(
        delete(RenderJob).where(RenderJob.status.in_(["succeeded", "failed"]), RenderJob.updated_at < cutoff)
    )
    db.commit()


async def _run_and_record(job_id: str, coro) -> bytes:
    # A fresh session, not the caller's -- the request's own session may
    # already be closed (or about to be) by the time a backgrounded render
    # actually finishes.
    db = SessionLocal()
    try:
        job = db.get(RenderJob, job_id)
        job.status = "running"
        db.commit()
        try:
            result_bytes = await coro
        except Exception as e:
            job.status = "failed"
            job.error = str(e)
            db.commit()
            raise
        job.status = "succeeded"
        job.result_data = crypto.encrypt_bytes(result_bytes)
        db.commit()
        return result_bytes
    finally:
        db.close()


def mark_failed(job_id: str, error: str) -> None:
    """For a tool-level validation error that happens before track() is
    ever called (e.g. a missing prompt/source image) -- without this, a
    job created in agent.py right before the tool call would dangle in
    "queued" forever instead of reporting the real failure."""
    db = SessionLocal()
    try:
        job = db.get(RenderJob, job_id)
        job.status = "failed"
        job.error = error
        db.commit()
    finally:
        db.close()


async def track(job_id: str, coro) -> bytes:
    """Awaits coro to completion via a detached task, recording status
    transitions on the RenderJob row as it goes. Cancelling the awaiting
    coroutine (e.g. this call's own caller being cancelled by a client
    disconnect) does NOT cancel the underlying render -- that's the whole
    point of this function existing."""
    task = asyncio.create_task(_run_and_record(job_id, coro))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return await asyncio.shield(task)


def reset_stale_jobs(db) -> None:
    """Called once at startup. Any row still queued/running belonged to an
    in-memory task from a process that no longer exists -- there's nothing
    left that could ever finish it."""
    db.execute(
        update(RenderJob)
        .where(RenderJob.status.in_(["queued", "running"]))
        .values(status="failed", error="Interrupted by a server restart.")
    )
    db.commit()
