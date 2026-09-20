"""Runtime-adjustable settings persisted in the app_settings table.

Currently: prime-time window, adex column mapping (for header validation on
repeat uploads), and the two prompt-guide blocks.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings as cfg
from ..models import AppSetting
from ..utils.timeparse import parse_time

PRIME_START_KEY = "prime_start"
PRIME_END_KEY = "prime_end"
PROMPT_GUIDE_LOGIC_KEY = "prompt_guide_logic"
PROMPT_GUIDE_FORMAT_KEY = "prompt_guide_format"
ADEX_MAPPING_KEY = "adex_header_mapping"


def get(db: Session, key: str, default: str | None = None) -> str | None:
    row = db.get(AppSetting, key)
    return row.value if row else default


def put(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
        row.updated_at = dt.datetime.utcnow()
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()


def get_prime_window(db: Session) -> tuple[dt.time, dt.time]:
    start = get(db, PRIME_START_KEY, cfg.default_prime_start) or cfg.default_prime_start
    end = get(db, PRIME_END_KEY, cfg.default_prime_end) or cfg.default_prime_end
    return (parse_time(start) or dt.time(18, 0), parse_time(end) or dt.time(22, 0))


def set_prime_window(db: Session, start: str, end: str) -> None:
    # Validate.
    if not parse_time(start) or not parse_time(end):
        raise ValueError("prime window times must be HH:MM")
    put(db, PRIME_START_KEY, start)
    put(db, PRIME_END_KEY, end)


def all_settings(db: Session) -> dict:
    rows = db.execute(select(AppSetting)).scalars().all()
    return {r.key: r.value for r in rows}
