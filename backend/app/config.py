"""Application configuration, loaded from environment variables.

Railway injects DATABASE_URL when a Postgres plugin is attached. Everything
else has a sensible default so the app boots even before the operator has
filled in a full .env file.
"""
from __future__ import annotations

import os
from functools import lru_cache


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    """Plain settings object. Kept dependency-free on purpose so the app has
    no hard requirement on pydantic-settings just to read a handful of vars."""

    def __init__(self) -> None:
        # --- Database -----------------------------------------------------
        self.database_url: str = os.getenv(
            "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/media_planner"
        )
        # Railway's managed Postgres uses a self-signed cert; libpq needs sslmode.
        self.pg_ssl: bool = _bool(os.getenv("PGSSL"), default=False)

        # A SELECT-only, row-limited, timeout-bound role used exclusively for
        # the ad-hoc Gemini SQL feature. If unset we fall back to the main URL
        # but STILL wrap every statement in a read-only transaction guard.
        self.readonly_database_url: str | None = os.getenv("READONLY_DATABASE_URL")

        # --- Gemini -------------------------------------------------------
        self.gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
        self.gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        self.gemini_temperature: float = float(os.getenv("GEMINI_TEMPERATURE", "0.3"))

        # --- Uploads / jobs ----------------------------------------------
        self.max_upload_mb: int = int(os.getenv("MAX_UPLOAD_MB", "50"))
        # Where staged upload payloads live while awaiting review/confirm.
        self.data_dir: str = os.getenv("DATA_DIR", os.path.join(os.getcwd(), "var"))

        # --- Business defaults -------------------------------------------
        # Default prime-time window (24h clock). Adjustable at runtime via the
        # Settings API, stored in the app_settings table.
        self.default_prime_start: str = os.getenv("PRIME_START", "18:00")
        self.default_prime_end: str = os.getenv("PRIME_END", "22:00")

        # --- Restricted SQL guard rails ----------------------------------
        self.readonly_row_limit: int = int(os.getenv("READONLY_ROW_LIMIT", "500"))
        self.readonly_timeout_ms: int = int(os.getenv("READONLY_TIMEOUT_MS", "5000"))

        # --- Server ------------------------------------------------------
        self.port: int = int(os.getenv("PORT", "8000"))

    @property
    def sqlalchemy_url(self) -> str:
        """Normalise to a SQLAlchemy + psycopg2 URL. Railway sometimes hands
        out `postgres://` which SQLAlchemy no longer accepts."""
        url = self.database_url
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg2://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
        return url

    @property
    def connect_args(self) -> dict:
        return {"sslmode": "require"} if self.pg_ssl else {}


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
