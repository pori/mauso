import os
from pathlib import Path


class Settings:
    """Runtime configuration sourced from environment variables. Per-provider
    values (endpoint URL, API key, model names) are NOT here -- those are
    user-editable at runtime via the Settings page and live in the
    app_setting table (see settings_store.py), since this is meant to be
    pointed at whatever OpenAI-compatible endpoint the user has, not a
    fixed one baked in at deploy time."""

    db_path: Path = Path(os.environ.get("DB_PATH", "/data/mauso.db"))
    data_dir: Path = db_path.parent

    secret_key: str = os.environ.get("MAUSO_SECRET_KEY", "")

    comfyui_base_url: str = os.environ.get("COMFYUI_BASE_URL", "http://comfyui:8188")

    # Initial value only -- the Settings page's saved choice (app_setting
    # table) takes precedence once set. Lets the deploy-time environment
    # pick a sane default chat model without baking it into the image.
    default_chat_model: str = os.environ.get("DEFAULT_CHAT_MODEL", "")

    llm_timeout_seconds: float = float(os.environ.get("LLM_TIMEOUT", "120"))
    comfyui_timeout_seconds: float = float(os.environ.get("COMFYUI_TIMEOUT", "300"))
    tavily_timeout_seconds: float = float(os.environ.get("TAVILY_TIMEOUT", "30"))
    image_fetch_timeout_seconds: float = float(os.environ.get("IMAGE_FETCH_TIMEOUT", "20"))

    max_upload_bytes: int = int(os.environ.get("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
    chunk_chars: int = int(os.environ.get("RAG_CHUNK_CHARS", "1200"))
    chunk_overlap_chars: int = int(os.environ.get("RAG_CHUNK_OVERLAP_CHARS", "150"))

    max_agent_tool_iterations: int = int(os.environ.get("MAX_AGENT_TOOL_ITERATIONS", "5"))


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
