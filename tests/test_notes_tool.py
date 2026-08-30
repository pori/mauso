from app.models import Note
from app.tools import notes


def test_normalize_tags_dedupes_trims_and_lowercases():
    assert notes.normalize_tags(" Work, Ideas ,work, ,Ideas") == "work,ideas"


def test_normalize_tags_empty_input():
    assert notes.normalize_tags("") == ""
    assert notes.normalize_tags(None) == ""


def test_parse_tags_splits_on_comma_and_drops_empties():
    assert notes.parse_tags("work,ideas") == ["work", "ideas"]
    assert notes.parse_tags("") == []
    assert notes.parse_tags(None) == []


def _make_note(db_session, title, content="", tags=""):
    note = Note(title=title, content_markdown=content, tags=notes.normalize_tags(tags))
    db_session.add(note)
    db_session.commit()
    db_session.refresh(note)
    return note


def test_search_with_no_notes_is_graceful(db_session):
    result = notes.search({}, db_session)
    assert result["results"] == []
    assert "note" in result


def test_search_filters_by_tag(db_session):
    _make_note(db_session, "Recipe", tags="cooking, home")
    _make_note(db_session, "Standup notes", tags="work")

    result = notes.search({"tag": "work"}, db_session)
    assert [r["title"] for r in result["results"]] == ["Standup notes"]
    assert result["results"][0]["tags"] == ["work"]


def test_search_tag_filter_is_case_insensitive(db_session):
    _make_note(db_session, "Standup notes", tags="Work")

    result = notes.search({"tag": "WORK"}, db_session)
    assert [r["title"] for r in result["results"]] == ["Standup notes"]


def test_search_combines_query_and_tag_with_and_semantics(db_session):
    _make_note(db_session, "Standup notes", content="daily sync", tags="work")
    _make_note(db_session, "Grocery list", content="milk, eggs", tags="home")
    _make_note(db_session, "1:1 prep", content="talk about promo", tags="work")

    result = notes.search({"query": "sync", "tag": "work"}, db_session)
    assert [r["title"] for r in result["results"]] == ["Standup notes"]


def test_search_tag_with_no_matches_returns_empty(db_session):
    _make_note(db_session, "Recipe", tags="cooking")

    result = notes.search({"tag": "nonexistent"}, db_session)
    assert result["results"] == []
    assert "note" in result


def test_search_without_tag_returns_all_matching_query(db_session):
    _make_note(db_session, "Standup notes", tags="work")
    _make_note(db_session, "Recipe", tags="cooking")

    result = notes.search({}, db_session)
    assert {r["title"] for r in result["results"]} == {"Standup notes", "Recipe"}
