"""Covers GET/DELETE /api/render-jobs/{id} -- the client's recovery path
for a render that finished after its /api/chat request got cancelled
(#10). No auth beyond the unguessable job id, same no-user-model design
as /api/chat-images/{id}."""
import base64

from app import crypto, render_jobs


def test_get_queued_job(client, db_session):
    job = render_jobs.create_job(db_session, "generate")
    resp = client.get(f"/api/render-jobs/{job.id}")
    assert resp.status_code == 200
    assert resp.json() == {"status": "queued", "error": ""}


def test_get_failed_job_includes_error(client, db_session):
    job = render_jobs.create_job(db_session, "generate")
    render_jobs.mark_failed(job.id, "No prompt given.")
    resp = client.get(f"/api/render-jobs/{job.id}")
    assert resp.status_code == 200
    assert resp.json() == {"status": "failed", "error": "No prompt given."}


def test_get_succeeded_job_returns_decryptable_bytes(client, db_session):
    job = render_jobs.create_job(db_session, "generate")
    job.status = "succeeded"
    job.result_data = crypto.encrypt_bytes(b"the-finished-image")
    job.result_content_type = "image/jpeg"
    db_session.commit()

    resp = client.get(f"/api/render-jobs/{job.id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "succeeded"
    assert base64.b64decode(body["image_b64"]) == b"the-finished-image"
    assert body["content_type"] == "image/jpeg"


def test_get_missing_job_is_404(client):
    resp = client.get("/api/render-jobs/does-not-exist")
    assert resp.status_code == 404


def test_delete_job_removes_the_row(client, db_session):
    job = render_jobs.create_job(db_session, "generate")
    resp = client.delete(f"/api/render-jobs/{job.id}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert client.get(f"/api/render-jobs/{job.id}").status_code == 404


def test_delete_missing_job_is_404(client):
    resp = client.delete("/api/render-jobs/does-not-exist")
    assert resp.status_code == 404
