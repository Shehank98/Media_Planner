"""SQLAlchemy engine / session wiring.

Two engines exist:
  * `engine`      - the normal read/write connection for the app.
  * `ro_engine`   - a lazily-created SELECT-only connection used ONLY by the
                    ad-hoc Gemini SQL feature. It prefers a dedicated
                    READONLY_DATABASE_URL (a restricted Postgres role); if that
                    is not configured it reuses the main URL but every query is
                    still forced into a read-only, statement-timeout-bound
                    transaction (see services/restricted_sql.py).
"""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(
    settings.sqlalchemy_url,
    connect_args=settings.connect_args,
    pool_pre_ping=True,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def _ro_url() -> str:
    url = settings.readonly_database_url or settings.database_url
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg2://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    return url


_ro_engine = None


def get_ro_engine():
    global _ro_engine
    if _ro_engine is None:
        _ro_engine = create_engine(
            _ro_url(),
            connect_args=settings.connect_args,
            pool_pre_ping=True,
            future=True,
        )
    return _ro_engine


def get_db():
    """FastAPI dependency yielding a scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables if they do not exist. Kept intentionally simple (no
    Alembic) since this is a single-user internal tool; schema changes are
    infrequent and applied by hand."""
    from . import models  # noqa: F401  (register mappers)

    Base.metadata.create_all(bind=engine)
