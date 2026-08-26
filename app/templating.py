from pathlib import Path

from fastapi.templating import Jinja2Templates

STATIC_DIR = Path(__file__).parent / "static"


def static_url(filename: str) -> str:
    """/static/<filename> with a ?v=<mtime> cache-buster. Without this,
    browsers (mobile Safari in particular) keep serving a stale cached CSS/JS
    file across redeploys, since these are otherwise referenced by a fixed
    URL that never changes."""
    try:
        version = int((STATIC_DIR / filename).stat().st_mtime)
    except OSError:
        version = 0
    return f"/static/{filename}?v={version}"


templates = Jinja2Templates(directory="app/templates")
templates.env.globals["static_url"] = static_url
