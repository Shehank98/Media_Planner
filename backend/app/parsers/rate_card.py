"""Rate card workbook parser.

One workbook, one sheet per channel. Each sheet:
  Row 0 : title with channel name + free-text 'Effective: <date>'
  Row 1 : headers (column layout varies per sheet)
  Row 2+: data rows

Produces a review payload (one block per sheet) with all parsed AND inferred
fields, plus per-sheet flags the UI must surface before save:
  * effective_date_method  - regex | fuzzy | failed (failed => manual entry)
  * duration_needs_input   - True when the rack-rate header states no duration
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Any

from ..utils.dates import parse_effective_date
from ..utils.days import days_label, parse_days
from ..utils.timeparse import parse_time, time_to_str
from .excel import (
    build_header_index,
    cell,
    find_column,
    load_sheets,
    to_float,
)

# Header aliases (normalised match handled by find_column).
H_PRIME = ["prime / non prime", "prime/non prime", "prime non prime", "pt/npt", "pt / npt", "prime"]
H_PROGRAMME = ["programme", "program", "show"]
H_RATING = ["rating", "tvr"]
H_DAYS = ["day/s", "days", "day"]
H_START = ["start", "start time"]
H_END = ["end", "end time"]
H_NOTES = ["additional notes", "notes", "remarks"]
H_EXTRA = ["extra cost", "additional cost"]
H_CPRP = ["cprp rack rate", "cprp"]


def _detect_rate_column(header_index: dict[str, int]) -> tuple[int | None, int | None, bool]:
    """Find the rack-rate column and infer its spot duration from the header.

    Returns (col_index, duration_secs_or_None, needs_manual_duration).
    """
    rate_col = None
    for header, i in header_index.items():
        if "rack rate" in header or (header.startswith("rate") and "cprp" not in header):
            rate_col = i
            header_text = header
            break
    else:
        return None, None, False

    m = re.search(r"(\d{1,3})\s*sec", header_text)
    if m:
        return rate_col, int(m.group(1)), False
    # Plain "Rack Rate" with no duration - flag for manual input.
    return rate_col, None, True


def _normalise_prime(value: Any, source_default: str) -> tuple[str | None, str]:
    """Return (PT|NPT|None, source). Source is 'given' when the sheet supplied
    a usable value, else 'inferred' (caller will fill from start time)."""
    if value is None:
        return None, "inferred"
    s = str(value).strip().lower()
    if not s:
        return None, "inferred"
    if s in {"pt", "prime", "prime time", "p"}:
        return "PT", "given"
    if s in {"npt", "non prime", "non-prime", "non prime time", "np", "n"}:
        return "NPT", "given"
    return None, "inferred"


def parse_workbook(path: str) -> list[dict]:
    """Return a list of per-sheet review blocks."""
    sheets = load_sheets(path)
    blocks: list[dict] = []

    for sheet_name, rows in sheets.items():
        if not rows:
            continue
        title = " ".join(str(c) for c in (rows[0] or []) if c is not None).strip()
        eff_date, method = parse_effective_date(title or sheet_name)

        header_row = rows[1] if len(rows) > 1 else []
        header_index = build_header_index(header_row)

        prime_col = find_column(header_index, H_PRIME)
        prog_col = find_column(header_index, H_PROGRAMME)
        rating_col = find_column(header_index, H_RATING)
        days_col = find_column(header_index, H_DAYS)
        start_col = find_column(header_index, H_START)
        end_col = find_column(header_index, H_END)
        notes_col = find_column(header_index, H_NOTES)
        extra_col = find_column(header_index, H_EXTRA)
        cprp_col = find_column(header_index, H_CPRP)
        rate_col, duration, duration_needs_input = _detect_rate_column(header_index)

        parsed_rows: list[dict] = []
        for raw in rows[2:]:
            if raw is None or all(c is None for c in raw):
                continue
            programme = cell(raw, prog_col)
            rack = to_float(cell(raw, rate_col))
            # Skip empty separator rows with no programme and no rate.
            if not programme and rack is None:
                continue

            prime_val, prime_source = _normalise_prime(cell(raw, prime_col), "given")
            start_t = parse_time(cell(raw, start_col))
            end_t = parse_time(cell(raw, end_col))
            day_raw = cell(raw, days_col)
            dow = parse_days(day_raw)

            rate_30s = None
            if rack is not None and duration:
                rate_30s = round(rack * (30.0 / duration), 2)

            parsed_rows.append(
                {
                    "programme": str(programme).strip() if programme else None,
                    "prime_non_prime": prime_val,
                    "prime_non_prime_source": prime_source,
                    "rating": to_float(cell(raw, rating_col)),
                    "day_pattern_raw": str(day_raw).strip() if day_raw else None,
                    "days_of_week": dow,
                    "days_label": days_label(dow),
                    "start_time": time_to_str(start_t),
                    "end_time": time_to_str(end_t),
                    "rack_rate": rack,
                    "rate_duration_secs": duration,
                    "rate_30s_equivalent": rate_30s,
                    "additional_notes": (str(cell(raw, notes_col)).strip() if cell(raw, notes_col) else None),
                    "extra_cost": to_float(cell(raw, extra_col)),
                    "sheet_cprp_rack_rate": to_float(cell(raw, cprp_col)),
                }
            )

        blocks.append(
            {
                "source_sheet_name": sheet_name,
                "channel": sheet_name.strip(),
                "title": title,
                "effective_date": eff_date.isoformat() if eff_date else None,
                "effective_date_method": method,
                "rate_duration_secs": duration,
                "duration_needs_input": duration_needs_input,
                "headers_seen": list(header_index.keys()),
                "row_count": len(parsed_rows),
                "rows": parsed_rows,
            }
        )

    return blocks
