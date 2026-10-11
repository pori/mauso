import logging

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from . import render_jobs
from .db import SessionLocal, init_db
from .routers import chat, files, images, notes_router, profiles, render_jobs_router, settings_router
from .templating import templates

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mauso")

app = FastAPI(title="mauso")

app.include_router(chat.router)
app.include_router(settings_router.router)
app.include_router(files.router)
app.include_router(images.router)
app.include_router(profiles.router)
app.include_router(notes_router.router)
app.include_router(render_jobs_router.router)

app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.on_event("startup")
def on_startup():
    init_db()
    db = SessionLocal()
    try:
        render_jobs.reset_stale_jobs(db)
    finally:
        db.close()


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/files")
def files_page(request: Request):
    return templates.TemplateResponse("files.html", {"request": request})


@app.get("/settings")
def settings_page(request: Request):
    return templates.TemplateResponse("settings.html", {"request": request})


@app.get("/profiles")
def profiles_page(request: Request):
    return templates.TemplateResponse("profiles.html", {"request": request})


@app.get("/notes")
def notes_page(request: Request):
    return templates.TemplateResponse("notes.html", {"request": request})
