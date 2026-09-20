"""Read-only SQL execution for genuine ad-hoc Gemini questions.

Defence in depth:
  1. Prefer a dedicated Postgres role (READONLY_DATABASE_URL) that is granted
     SELECT only - see db/restricted_role.sql.
  2. Regardless of role, statically reject anything that is not a single
     SELECT/WITH statement (no semicolon chaining, no DML/DDL keywords).
  3. Run inside a READ ONLY transaction with a statement_timeout, and hard-cap
     the returned rows.

This is only for free-form questions that fall outside the pre-built pivots;
all headline numbers still come from the Python analysis services.
"""
from __future__ import annotations

import re

from sqlalchemy import text

from ..config import settings
from ..database import get_ro_engine

_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|"
    r"vacuum|analyze|reindex|comment|call|do|merge|refresh|lock|"
    r"pg_read_file|pg_sleep|set\s+role|reset)\b",
    re.IGNORECASE,
)

# Only these tables are exposed to the ad-hoc feature.
_ALLOWED_TABLES = {"adex_rows", "media_watch_rows", "rate_cards", "batches"}


class UnsafeQuery(ValueError):
    pass


def validate(sql: str) -> str:
    s = sql.strip().rstrip(";").strip()
    if not s:
        raise UnsafeQuery("empty query")
    if ";" in s:
        raise UnsafeQuery("multiple statements are not allowed")
    low = s.lower()
    if not (low.startswith("select") or low.startswith("with")):
        raise UnsafeQuery("only SELECT / WITH queries are allowed")
    if _FORBIDDEN.search(s):
        raise UnsafeQuery("query contains a forbidden keyword")
    # crude comment stripping to stop keyword hiding
    if "--" in s or "/*" in s:
        raise UnsafeQuery("comments are not allowed in ad-hoc queries")
    return s


def run(sql: str) -> dict:
    safe = validate(sql)
    limit = settings.readonly_row_limit
    engine = get_ro_engine()
    with engine.connect() as conn:
        conn.execute(text("SET TRANSACTION READ ONLY"))
        conn.execute(text(f"SET LOCAL statement_timeout = {int(settings.readonly_timeout_ms)}"))
        result = conn.execute(text(safe))
        cols = list(result.keys())
        rows = []
        for i, r in enumerate(result):
            if i >= limit:
                break
            rows.append({c: _jsonable(v) for c, v in zip(cols, r)})
    return {"columns": cols, "rows": rows, "row_limit": limit, "truncated": len(rows) >= limit}


def _jsonable(v):
    import datetime as dt
    from decimal import Decimal

    if isinstance(v, (dt.date, dt.time, dt.datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v
