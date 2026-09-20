"""Fuzzy date parsing for the free-text 'Effective: ...' fragment in rate
card sheet titles.

Seen variants: `2025.sep.1`, `2026 sep 1`, `2026.08.07`, `2026 july 1st`.

Strategy:
  1. Try a set of manual regex patterns aimed at the `Effective:` fragment.
  2. Fall back to dateutil's fuzzy parser over the whole title.
  3. If both fail, return None and let the UI require manual entry.

The parsed date is ALWAYS surfaced to the user for confirm/correct before
save - this function never decides on its own.
"""
from __future__ import annotations

import datetime as dt
import re

try:
    from dateutil import parser as _du_parser
except Exception:  # pragma: no cover - dateutil is a hard dependency in prod
    _du_parser = None


_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def _strip_ordinal(s: str) -> str:
    return re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", s, flags=re.IGNORECASE)


def parse_effective_date(title: str | None) -> tuple[dt.date | None, str]:
    """Return (date_or_none, method_label). method_label documents how the
    value was obtained so the UI can show it ('regex', 'fuzzy', 'failed')."""
    if not title:
        return None, "failed"

    text = title.strip()

    # Isolate the fragment after 'Effective' if present.
    m = re.search(r"effective[:\s]*", text, flags=re.IGNORECASE)
    fragment = text[m.end():] if m else text
    fragment = _strip_ordinal(fragment).strip()

    # --- Manual regex patterns -------------------------------------------
    # YYYY <sep> Month <sep> D   e.g. 2025.sep.1 / 2026 sep 1 / 2026 july 1
    rx1 = re.search(
        r"(\d{4})[.\s\-/]+([A-Za-z]{3,9})[.\s\-/]+(\d{1,2})", fragment
    )
    if rx1:
        y, mon, d = rx1.group(1), rx1.group(2).lower(), rx1.group(3)
        if mon[:3] in _MONTHS or mon in _MONTHS:
            month = _MONTHS.get(mon) or _MONTHS.get(mon[:3])
            try:
                return dt.date(int(y), month, int(d)), "regex"
            except ValueError:
                pass

    # YYYY.MM.DD numeric  e.g. 2026.08.07
    rx2 = re.search(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", fragment)
    if rx2:
        try:
            return dt.date(int(rx2.group(1)), int(rx2.group(2)), int(rx2.group(3))), "regex"
        except ValueError:
            pass

    # Month D, YYYY  e.g. July 1 2026
    rx3 = re.search(r"([A-Za-z]{3,9})[.\s]+(\d{1,2})[,.\s]+(\d{4})", fragment)
    if rx3:
        mon = rx3.group(1).lower()
        month = _MONTHS.get(mon) or _MONTHS.get(mon[:3])
        if month:
            try:
                return dt.date(int(rx3.group(3)), month, int(rx3.group(2))), "regex"
            except ValueError:
                pass

    # --- dateutil fuzzy fallback -----------------------------------------
    if _du_parser is not None:
        for candidate in (fragment, text):
            try:
                d = _du_parser.parse(candidate, fuzzy=True, dayfirst=False)
                return d.date(), "fuzzy"
            except (ValueError, OverflowError, TypeError):
                continue

    return None, "failed"


def parse_row_date(dd, mn, yr) -> dt.date | None:
    """Combine Dd / Mn / Yr adex columns into a date. Values may be ints,
    floats or strings; month may be a name or a number."""
    if dd is None or mn is None or yr is None:
        return None
    try:
        day = int(float(dd))
    except (ValueError, TypeError):
        return None

    # Month
    month = None
    try:
        month = int(float(mn))
    except (ValueError, TypeError):
        mon = str(mn).strip().lower()
        month = _MONTHS.get(mon) or _MONTHS.get(mon[:3])
    if not month:
        return None

    try:
        year = int(float(yr))
    except (ValueError, TypeError):
        return None
    if year < 100:  # two-digit year
        year += 2000

    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def parse_any_date(value) -> dt.date | None:
    """Best-effort single-cell date parse (used for media-watch Date column)."""
    if value is None or value == "":
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if _du_parser is not None:
        try:
            return _du_parser.parse(str(value), dayfirst=True).date()
        except (ValueError, OverflowError, TypeError):
            return None
    return None
