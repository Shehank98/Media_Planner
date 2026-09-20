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
        "Do not invent, recompute, or add figures that are not present. "
        "Do not use em dashes or en dashes; use commas or a spaced hyphen."
    )
    user = f"QUESTION:\n{question}\n\nCOMPUTED RESULT (JSON):\n{json.dumps(computed, default=str)}"
    if not settings.gemini_api_key or genai is None:
        return _fallback_narrative(question, computed)
    try:
        return _generate(system, user)
    except Exception as exc:  # noqa: BLE001
        return f"(AI narrative unavailable: {exc})\n\n" + _fallback_narrative(question, computed)


def report_sections(logic_guide: str, format_guide: str, context: dict) -> dict:
    """Return prose for each named report section as a JSON dict.

    The model writes NARRATIVE ONLY - it must not describe charts or tables
    (those are inserted programmatically) and must not invent numbers. Keys:
    executive_summary, category_overview, advertiser_ranking, deep_dive,
    channel_analysis, competitor, recommendation.
    """
    keys = [
        "executive_summary", "category_overview", "advertiser_ranking",
        "deep_dive", "channel_analysis", "competitor", "recommendation",
    ]
    if not settings.gemini_api_key or genai is None:
        return {}
    system = (
        f"{logic_guide}\n\n---\n{format_guide}\n\n---\n"
        "You write the narrative sections of a media pitch report. Rules:\n"
        "- Use ONLY the numbers in the provided data. Never invent figures.\n"
        "- Write PROSE ONLY. Do NOT describe, draw, or reference charts or "
        "tables (they are added separately). Do not write '(chart showing ...)'.\n"
        "- Do NOT use em dashes or en dashes; use commas, or a hyphen with spaces.\n"
        "- Keep each section to 2-4 tight sentences.\n"
        f"Return a single JSON object with exactly these keys: {', '.join(keys)}. "
        "Each value is a plain-text paragraph. Return JSON only, no code fences."
    )
    user = "REPORT DATA (JSON):\n" + json.dumps(context, default=str)
    try:
        raw = _generate(system, user, temperature=0.3)
        raw = raw.replace("```json", "").replace("```", "").strip()
        data = json.loads(raw)
        return {k: _no_dashes(str(v)) for k, v in data.items() if k in keys}
    except Exception:
        return {}


def _no_dashes(text: str) -> str:
    return text.replace("—", " - ").replace("–", "-")


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


def _money(v):
    try:
        return f"Rs. {float(v):,.0f}"
    except (TypeError, ValueError):
        return str(v)


def _fallback_narrative(question: str, computed: dict) -> str:
    """Deterministic, readable summary when no API key is present. Produces
    clean prose (never a raw data dump) so the UI stays presentable without
    Gemini configured."""
    parts: list[str] = []

    ov = computed.get("overview")
    if isinstance(ov, dict) and ov.get("total_spend") is not None:
        line = f"Total market spend is {_money(ov['total_spend'])} across {ov.get('advertisers', 0)} advertisers and {ov.get('channels', 0)} channels"
        if ov.get("date_from"):
            line += f", from {ov['date_from']} to {ov['date_to']}"
        line += "."
        if ov.get("top_advertiser"):
            line += f" {ov['top_advertiser']['name']} leads with {_money(ov['top_advertiser']['spend'])}."
        ms = ov.get("medium_split") or {}
        if ms:
            top_m = max(ms.items(), key=lambda kv: kv[1])
            total = sum(ms.values()) or 1
            line += f" {top_m[0]} is the leading medium at {round(100 * top_m[1] / total)}% of spend."
        parts.append(line)

    ta = computed.get("top_advertisers")
    if isinstance(ta, list) and ta:
        lead = ta[0]
        parts.append(f"The top advertiser is {lead.get('advertiser')} with {_money(lead.get('spend'))}"
                     + (f", followed by {ta[1].get('advertiser')} ({_money(ta[1].get('spend'))})." if len(ta) > 1 else "."))

    g = computed.get("growth")
    if isinstance(g, dict):
        if g.get("gainers"):
            parts.append("Biggest gainers: " + ", ".join(f"{x['advertiser']} (+{_money(x['delta'])})" for x in g["gainers"][:3]) + ".")
        if g.get("new_entrants"):
            parts.append("New entrants this period: " + ", ".join(x["advertiser"] for x in g["new_entrants"][:3]) + ".")

    ms = computed.get("medium_split")
    if isinstance(ms, list) and ms:
        parts.append("Spend by medium: " + ", ".join(f"{m['medium']} {_money(m['spend'])}" for m in ms) + ".")

    va = computed.get("value_addition")
    if isinstance(va, dict) and va.get("va_spots"):
        parts.append(f"Bonus airtime (V/A, excluded from spend): {va['va_spots']:,} spots, {va.get('va_seconds', 0):,.0f} seconds.")

    if not parts:
        return ("AI narrative is not configured (no Gemini API key). The figures above are "
                "computed and accurate; add a GEMINI_API_KEY to get a written analysis.")
    parts.append("(Written summary shown; add a Gemini API key for a fuller AI analysis.)")
    return "\n\n".join(parts)
