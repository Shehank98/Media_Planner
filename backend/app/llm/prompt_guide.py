"""Prompt guide store.

The guide is uploaded once (and re-uploadable) as text/markdown, split into
two blocks that are injected at different points of a Gemini call:

  * business-logic rules  -> injected BEFORE any query/interpretation step
  * formatting/tone rules  -> injected BEFORE generating chat answers / reports

Splitting convention: a line containing '## FORMATTING' (case-insensitive)
marks the boundary. Everything above is business logic, everything below is
formatting/tone. If no marker is found, the whole text is treated as business
logic and a small default formatting block is used.
"""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ..services import settings_store

_DEFAULT_LOGIC = (
    "You are a media analyst for a Sri Lankan media buying agency.\n"
    "- Spend/cost figures always exclude V/A (value addition / bonus airtime); "
    "only 'Com' rows are paid spend.\n"
    "- CPRP = 30-second-equivalent rate / TVR. Lower CPRP is more cost-efficient.\n"
    "- Never invent numbers. Use only the figures provided to you."
)
_DEFAULT_FORMAT = (
    "Write in a confident, concise, pitch-ready tone. Lead with the headline "
    "insight, then support it. Use short paragraphs. Refer to figures exactly "
    "as given; do not recompute or round differently."
)

_MARKER = re.compile(r"^#+\s*format", re.IGNORECASE | re.MULTILINE)


def save_guide(db: Session, text: str) -> dict:
    logic, fmt = split_guide(text)
    settings_store.put(db, settings_store.PROMPT_GUIDE_LOGIC_KEY, logic)
    settings_store.put(db, settings_store.PROMPT_GUIDE_FORMAT_KEY, fmt)
    return {"logic_chars": len(logic), "format_chars": len(fmt)}


def split_guide(text: str) -> tuple[str, str]:
    m = _MARKER.search(text)
    if m:
        return text[: m.start()].strip(), text[m.start():].strip()
    return text.strip(), _DEFAULT_FORMAT


def get_logic(db: Session) -> str:
    return settings_store.get(db, settings_store.PROMPT_GUIDE_LOGIC_KEY) or _DEFAULT_LOGIC


def get_format(db: Session) -> str:
    return settings_store.get(db, settings_store.PROMPT_GUIDE_FORMAT_KEY) or _DEFAULT_FORMAT
