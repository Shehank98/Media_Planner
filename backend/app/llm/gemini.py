"""Gemini client wrapper.

Two roles, both narrative-only for the pre-built pivots:
  * narrate(...)      - given a pre-computed result + the business-logic and
                        formatting guide blocks, write the agency-tone narrative.
                        The model NEVER touches raw data or writes SQL here.
  * write_sql(...)    - ONLY for genuine ad-hoc questions outside the pivots.
                        Produces a single read-only SELECT that is then run
                        through the restricted SQL guard (see restricted_sql).

If GEMINI_API_KEY is unset the wrapper degrades gracefully: narrate() returns a
templated summary and write_sql() raises so the caller can tell the user the
feature needs a key.
"""
from __future__ import annotations

import json

from ..config import settings

try:  # google-genai SDK
    from google import genai
    from google.genai import types as genai_types
except Exception:  # pragma: no cover
    genai = None
    genai_types = None


class GeminiUnavailable(RuntimeError):
    pass


def _client():
    if not settings.gemini_api_key:
        raise GeminiUnavailable("GEMINI_API_KEY is not configured")
    if genai is None:
        raise GeminiUnavailable("google-genai package is not installed")
    return genai.Client(api_key=settings.gemini_api_key)


def _generate(system: str, user: str, temperature: float | None = None) -> str:
    client = _client()
    cfg = None
    if genai_types is not None:
        cfg = genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=settings.gemini_temperature if temperature is None else temperature,
        )
    resp = client.models.generate_content(model=settings.gemini_model, contents=user, config=cfg)
    return (resp.text or "").strip()


def narrate(logic_guide: str, format_guide: str, question: str, computed: dict) -> str:
    """Write a narrative over a PRE-COMPUTED result. No raw data, no SQL."""
    system = (
        f"{logic_guide}\n\n---\n{format_guide}\n\n---\n"
        "You are given a QUESTION and a COMPUTED RESULT (already calculated in "
        "Python from the database). Use ONLY the numbers in the computed result. "
        "Do not invent, recompute, or add figures that are not present."
    )
    user = f"QUESTION:\n{question}\n\nCOMPUTED RESULT (JSON):\n{json.dumps(computed, default=str)}"
    if not settings.gemini_api_key or genai is None:
        return _fallback_narrative(question, computed)
    try:
        return _generate(system, user)
    except Exception as exc:  # noqa: BLE001
        return f"(AI narrative unavailable: {exc})\n\n" + _fallback_narrative(question, computed)


def write_sql(logic_guide: str, schema_hint: str, question: str) -> str:
    """Return a single read-only SELECT for an ad-hoc question."""
    system = (
        f"{logic_guide}\n\n---\n"
        "Translate the user's question into ONE PostgreSQL SELECT statement. "
        "Rules: SELECT only; no semicolons; no comments; no DML/DDL. "
        "Remember spend excludes V/A rows (filter va_com = 'Com'). "
        f"Schema:\n{schema_hint}\n"
        "Return ONLY the SQL, no markdown fences, no explanation."
    )
    sql = _generate(system, question, temperature=0.0)
    # Strip accidental code fences.
    sql = sql.replace("```sql", "").replace("```", "").strip()
    return sql


def _fallback_narrative(question: str, computed: dict) -> str:
    """Deterministic summary when no API key is present - keeps the app usable."""
    lines = [f"Summary for: {question}", ""]
    for key, val in computed.items():
        if isinstance(val, list) and val and isinstance(val[0], dict):
            lines.append(f"{key}:")
            for item in val[:5]:
                lines.append("  - " + ", ".join(f"{k}={v}" for k, v in item.items()))
        else:
            lines.append(f"{key}: {val}")
    return "\n".join(lines)
