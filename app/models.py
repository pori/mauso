from sqlalchemy import Column, Integer, LargeBinary, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .db import Base


class AppSetting(Base):
    """Generic key/value store for runtime-editable config -- provider
    endpoint URL, encrypted API key, model names. See settings_store.py."""
    __tablename__ = "app_setting"

    key = Column(String, primary_key=True)
    value = Column(Text, default="")


class Document(Base):
    """A file uploaded for the RAG skill. Stored and indexed in plaintext on
    this backend -- see the privacy note in docker-compose.yml/README.md,
    this is a deliberate scope boundary, not an oversight."""
    __tablename__ = "document"

    id = Column(Integer, primary_key=True)
    filename = Column(String, nullable=False)
    content_type = Column(String, default="")
    size_bytes = Column(Integer, default=0)
    status = Column(String, default="pending")  # pending, indexed, failed
    error = Column(Text, default="")
    created_at = Column(DateTime, server_default=func.now())

    chunks = relationship("Chunk", back_populates="document", cascade="all, delete-orphan")


class Chunk(Base):
    __tablename__ = "chunk"

    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey("document.id"), nullable=False)
    chunk_index = Column(Integer, nullable=False)
    text = Column(Text, nullable=False)
    embedding_json = Column(Text, nullable=False)  # JSON array of floats

    document = relationship("Document", back_populates="chunks")


class Profile(Base):
    """A user-defined preset -- a name, an optional pinned model, and extra
    system-prompt text appended to the base app system prompt (see
    agent.py's _build_system_prompt). Lets a conversation be pointed at
    e.g. "Terse coder" or "Brainstorm buddy" without retyping instructions
    every time. Selected per-conversation from the composer, same as the
    model picker -- see app.js's currentConvo.profileId."""
    __tablename__ = "profile"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    model = Column(String, default="")
    system_prompt = Column(Text, default="")
    created_at = Column(DateTime, server_default=func.now())


class Note(Base):
    """A persistent note managed from the Notes page (view/edit/create/
    delete) and looked up by the AI via the search_notes tool. Stored in
    plaintext on this backend -- same tradeoff as Document/Profile, not
    end-to-end encrypted like conversation history. Unrelated to the
    create_note tool (tools/notes.py's `run`), which is a pure formatting
    convention over the client-encrypted conversation and is never
    persisted here."""
    __tablename__ = "note"

    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    content_markdown = Column(Text, default="")
    tags = Column(String, default="")  # normalized comma-separated tags, see tools/notes.py
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class RenderJob(Base):
    """Tracks a generate_image/edit_image render across the request that
    started it, specifically so the render survives that request's task
    being cancelled (mobile tab backgrounded/navigated away mid-render --
    see #10). Deliberately holds no prompt/other params: the client
    already has those from the tool_call SSE event it received before the
    render started, so there's nothing here for the server to echo back --
    this table only needs to answer "did it finish, and if so with what
    bytes" for a client that reconnects later. `id` is an opaque token
    (render_jobs.create_job) that doubles as the resulting image's id, so
    the client's own pending-placeholder message already carries the right
    key to poll with. `result_data` is Fernet-encrypted at rest (same
    crypto.encrypt_bytes/decrypt_bytes path as provider API keys) and is a
    transient outbox, not storage -- deleted by the client as soon as it's
    pulled the bytes into its own IndexedDB, swept by render_jobs.py if
    nothing ever picks it up."""
    __tablename__ = "render_job"

    id = Column(String, primary_key=True)
    kind = Column(String, nullable=False)  # generate | edit
    status = Column(String, nullable=False, default="queued")  # queued|running|succeeded|failed
    error = Column(Text, default="")
    result_data = Column(LargeBinary, nullable=True)
    result_content_type = Column(String, default="image/png")
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ChatImage(Base):
    """An image that exists in a conversation -- either uploaded by the user
    (for the edit_image skill to work on) or produced by generate_image /
    edit_image. Addressed uniformly by id so edit_image can chain off a
    prior generate_image/edit_image result or an upload without caring
    which. Stored in plaintext on this backend for the same reason as
    Document -- ComfyUI has to be able to read it. See the privacy note in
    docker-compose.yml/README.md."""
    __tablename__ = "chat_image"

    id = Column(Integer, primary_key=True)
    content_type = Column(String, default="image/png")
    data = Column(LargeBinary, nullable=False)
    source = Column(String, default="upload")  # upload | generated | edited
    prompt = Column(Text, default="")
    created_at = Column(DateTime, server_default=func.now())
