"""FastAPI application entry point.

Serves the JSON API under /api/* and the single-page frontend from /.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .database import init_db
from .routers import adex, basket, channel_view, chat, rate_cards, settings as settings_router, uploads

app = FastAPI(title="Media Analysis System", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # single-user internal tool; served same-origin anyway
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    os.makedirs(settings.data_dir, exist_ok=True)
    init_db()


@app.get("/api/health")
def health():
    return {"status": "ok", "gemini_configured": bool(settings.gemini_api_key)}


# API routers
app.include_router(uploads.router)
app.include_router(rate_cards.router)
app.include_router(adex.router)
app.include_router(basket.router)
app.include_router(channel_view.router)
app.include_router(chat.router)
app.include_router(settings_router.router)


# --- Frontend (served last so /api takes precedence) ----------------------
_FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend")

if os.path.isdir(_FRONTEND_DIR):
    @app.get("/")
    def index():
        return FileResponse(os.path.join(_FRONTEND_DIR, "index.html"))

    app.mount("/", StaticFiles(directory=_FRONTEND_DIR, html=True), name="frontend")
