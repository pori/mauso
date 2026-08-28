from app.chat_images import store_chat_image


def test_delete_chat_image_removes_row(client, db_session):
    record = store_chat_image(db_session, b"fake-png-bytes", "image/png")
    image_id = record.id

    resp = client.get(f"/api/chat-images/{image_id}")
    assert resp.status_code == 200

    resp = client.delete(f"/api/chat-images/{image_id}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    resp = client.get(f"/api/chat-images/{image_id}")
    assert resp.status_code == 404


def test_delete_chat_image_missing_returns_404(client):
    resp = client.delete("/api/chat-images/999999")
    assert resp.status_code == 404


def test_delete_chat_image_is_idempotent_failure(client, db_session):
    record = store_chat_image(db_session, b"fake-png-bytes", "image/png")
    image_id = record.id

    resp = client.delete(f"/api/chat-images/{image_id}")
    assert resp.status_code == 200

    resp = client.delete(f"/api/chat-images/{image_id}")
    assert resp.status_code == 404
