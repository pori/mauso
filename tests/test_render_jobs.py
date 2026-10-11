"""Covers render_jobs.py's actual mechanism (#10): a RenderJob row that
tracks a generate_image/edit_image render independently of the request
that started it, so a client disconnect mid-render doesn't lose the
result. The load-bearing test here is
test_task_survives_cancellation_of_the_awaiting_caller -- it drives the
real asyncio.shield() behavior this whole feature depends on, not just
the bookkeeping around it."""
import asyncio
from datetime import datetime, timedelta, timezone

from app import crypto, render_jobs
from app.models import RenderJob


def _run(coro):
    return asyncio.run(coro)


def test_create_job_inserts_a_queued_row(db_session):
    job = render_jobs.create_job(db_session, "generate")
    assert job.status == "queued"
    assert job.kind == "generate"
    assert job.id  # opaque, non-empty
    assert db_session.get(RenderJob, job.id) is not None


def test_task_survives_cancellation_of_the_awaiting_caller(db_session):
    """The actual bug fix: cancelling the coroutine that's awaiting
    track() must not cancel the render itself."""
    job = render_jobs.create_job(db_session, "generate")
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_render():
        started.set()
        await release.wait()
        return b"the-real-output"

    async def scenario():
        caller_task = asyncio.create_task(render_jobs.track(job.id, slow_render()))
        await started.wait()
        caller_task.cancel()
        try:
            await caller_task
        except asyncio.CancelledError:
            pass
        # The tracked render is still running at this point -- let it finish.
        release.set()
        # Give the detached task a chance to actually run its completion.
        for _ in range(50):
            await asyncio.sleep(0)

    _run(scenario())

    db_session.expire_all()
    job = db_session.get(RenderJob, job.id)
    assert job.status == "succeeded"
    assert crypto.decrypt_bytes(job.result_data) == b"the-real-output"


def test_track_records_failure_from_the_wrapped_coroutine(db_session):
    job = render_jobs.create_job(db_session, "generate")

    async def failing():
        raise ValueError("comfyui exploded")

    try:
        _run(render_jobs.track(job.id, failing()))
    except ValueError:
        pass

    db_session.expire_all()
    job = db_session.get(RenderJob, job.id)
    assert job.status == "failed"
    assert "comfyui exploded" in job.error


def test_mark_failed_transitions_a_queued_job(db_session):
    job = render_jobs.create_job(db_session, "edit")
    render_jobs.mark_failed(job.id, "No prompt given.")

    db_session.expire_all()
    job = db_session.get(RenderJob, job.id)
    assert job.status == "failed"
    assert job.error == "No prompt given."


def test_reset_stale_jobs_fails_queued_and_running_rows(db_session):
    queued = render_jobs.create_job(db_session, "generate")
    running = render_jobs.create_job(db_session, "generate")
    running.status = "running"
    succeeded = render_jobs.create_job(db_session, "generate")
    succeeded.status = "succeeded"
    db_session.commit()

    render_jobs.reset_stale_jobs(db_session)

    db_session.expire_all()
    assert db_session.get(RenderJob, queued.id).status == "failed"
    assert db_session.get(RenderJob, running.id).status == "failed"
    assert db_session.get(RenderJob, succeeded.id).status == "succeeded"  # untouched


def test_ttl_sweep_deletes_old_terminal_jobs_but_not_fresh_ones(db_session):
    old_job = render_jobs.create_job(db_session, "generate")
    old_job_id = old_job.id
    old_job.status = "failed"
    old_job.updated_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=48)
    db_session.commit()

    fresh_job = render_jobs.create_job(db_session, "generate")
    fresh_job_id = fresh_job.id
    fresh_job.status = "failed"
    db_session.commit()

    # create_job's own sweep runs on every call -- one more call is enough
    # to trigger it against the rows seeded above.
    render_jobs.create_job(db_session, "generate")

    db_session.expire_all()
    assert db_session.get(RenderJob, old_job_id) is None
    assert db_session.get(RenderJob, fresh_job_id) is not None
