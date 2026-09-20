"""TVR (television ratings) workbook parser - Tab 2 dataset.

This is a separate dataset from the adex / media-watch spend data.

Expected columns:
  Rank, Data Set, Channel, Date, Day, Start, End, Program, Duration,
  Category, TVR, Total TVR, TVR Share %, Reach, Reach %, Avg Time
"""
from __future__ import annotations

from typing import Any

from ..utils.dates import parse_any_date
from ..utils.timeparse import parse_time, time_to_str
from .excel import build_header_index, cell, find_column, load_sheets, to_float, to_int

_ALIASES = {
    "rank": ["rank"],
    "data_set": ["data set", "dataset"],
    "channel": ["channel"],
    "date": ["date"],
    "day": ["day"],
    "start": ["start", "start time"],
    "end": ["end", "end time"],
    "program": ["program", "programme"],
    "duration": ["duration", "dur"],
    "category": ["category"],
    "tvr": ["tvr"],
    "total_tvr": ["total tvr"],
    "tvr_share_pct": ["tvr share %", "tvr share", "tvr share%"],
    "reach": ["reach"],
    "reach_pct": ["reach %", "reach%"],
    "avg_time": ["avg time", "average time", "avg. time"],
}


def parse_workbook(path: str) -> dict:
    sheets = load_sheets(path)
    name, rows = max(sheets.items(), key=lambda kv: len(kv[1]), default=(None, []))
    if not rows:
        return {"headers_seen": [], "rows": [], "row_count": 0}

    header_index = build_header_index(rows[0])
    cols = {field: find_column(header_index, aliases) for field, aliases in _ALIASES.items()}

    missing = [f for f in ("channel", "program", "tvr") if cols[f] is None]

    parsed: list[dict] = []
    for raw in rows[1:]:
        if raw is None or all(c is None for c in raw):
            continue
        d = parse_any_date(cell(raw, cols["date"]))
        start_t = parse_time(cell(raw, cols["start"]))
        end_t = parse_time(cell(raw, cols["end"]))
        parsed.append(
            {
                "rank": to_int(cell(raw, cols["rank"])),
                "data_set": _s(cell(raw, cols["data_set"])),
                "channel": _s(cell(raw, cols["channel"])),
                "spot_date": d.isoformat() if d else None,
                "day": _s(cell(raw, cols["day"])),
                "start_time": time_to_str(start_t),
                "end_time": time_to_str(end_t),
                "program": _s(cell(raw, cols["program"])),
                "duration": to_float(cell(raw, cols["duration"])),
                "category": _s(cell(raw, cols["category"])),
                "tvr": to_float(cell(raw, cols["tvr"])),
                "total_tvr": to_float(cell(raw, cols["total_tvr"])),
                "tvr_share_pct": to_float(cell(raw, cols["tvr_share_pct"])),
                "reach": to_float(cell(raw, cols["reach"])),
                "reach_pct": to_float(cell(raw, cols["reach_pct"])),
                "avg_time": to_float(cell(raw, cols["avg_time"])),
            }
        )

    return {
        "sheet_name": name,
        "headers_seen": list(header_index.keys()),
        "missing_required": missing,
        "header_mismatch": bool(missing),
        "row_count": len(parsed),
        "rows": parsed,
    }


def _s(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None
