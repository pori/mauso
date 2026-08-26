"""Test scaffold. Points the app at a throwaway sqlite file (never the real
/data/mauso.db) before any `app.*` module is imported, since config.py reads
DB_PATH once at import time."""
import os
from pathlib import Path

TEST_DB_PATH = Path(__file__).resolve().parent / "test.db"
os.environ["DB_PATH"] = str(TEST_DB_PATH)

import pytest
from fastapi.testclient import TestClient

from app.db import Base, engine, SessionLocal
from app.main import app


@pytest.fixture(autouse=True)
def _fresh_db():
    """Every test gets an empty schema and a clean file -- tests must not
    depend on ordering or leak rows into each other."""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)
    engine.dispose()
    if TEST_DB_PATH.exists():
        TEST_DB_PATH.unlink()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
