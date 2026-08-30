from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from .config import settings

engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from . import models  # noqa: F401 -- ensure models are registered
    Base.metadata.create_all(bind=engine)
    _migrate_note_tags_column()


def _migrate_note_tags_column():
    """create_all() only creates missing tables -- it never alters a `note`
    table that already exists on a deployed volume from before tagging was
    added. Back-fill the column so upgrading doesn't crash on first note
    read/write. No-op on a fresh DB, where create_all already included it."""
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(note)").fetchall()}
        if "tags" not in cols:
            conn.exec_driver_sql("ALTER TABLE note ADD COLUMN tags TEXT DEFAULT ''")
