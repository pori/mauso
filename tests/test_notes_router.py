def test_create_note_normalizes_and_returns_tags(client):
    resp = client.post("/api/notes", json={
        "title": "Recipe",
        "content_markdown": "flour, water",
        "tags": " Cooking , Home ,cooking",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["tags"] == ["cooking", "home"]


def test_create_note_defaults_to_no_tags(client):
    resp = client.post("/api/notes", json={"title": "Untagged"})
    assert resp.status_code == 200
    assert resp.json()["tags"] == []


def test_list_notes_includes_tags(client):
    client.post("/api/notes", json={"title": "Recipe", "tags": "cooking"})
    resp = client.get("/api/notes")
    assert resp.status_code == 200
    notes = resp.json()
    assert len(notes) == 1
    assert notes[0]["tags"] == ["cooking"]


def test_update_note_replaces_tags(client):
    created = client.post("/api/notes", json={"title": "Recipe", "tags": "cooking"}).json()

    resp = client.put(f"/api/notes/{created['id']}", json={
        "title": "Recipe",
        "content_markdown": "updated",
        "tags": "cooking, dessert",
    })
    assert resp.status_code == 200
    assert resp.json()["tags"] == ["cooking", "dessert"]


def test_update_note_can_clear_tags(client):
    created = client.post("/api/notes", json={"title": "Recipe", "tags": "cooking"}).json()

    resp = client.put(f"/api/notes/{created['id']}", json={"title": "Recipe", "tags": ""})
    assert resp.status_code == 200
    assert resp.json()["tags"] == []
