"""Adex (advertising expenditure) workbook parser - Tab 1 / Tab 3 dataset.

Expected columns:
  Product_Group, Advertiser, Product, Advt_Theme, V/A | Com, Medium, Ads,
  Channel, Program, Dd, Mn, Yr, Day, Prog_time, Advt_time, AdPos, TotAds,
  BrkNo, PosinBrk, AdsinBrk, Lng, Dur, Cost

Header validation: the canonical set is returned so the caller can compare
against a stored mapping and flag mismatches for user confirmation before
inserting.
"""
from __future__ import annotations

from typing import Any

from ..utils.dates import parse_row_date
from .excel import build_header_index, cell, find_column, load_sheets, to_float, to_int

CANONICAL_HEADERS = [
    "product_group", "advertiser", "product", "advt_theme", "v/a | com",
    "medium", "ads", "channel", "program", "dd", "mn", "yr", "day",
    "prog_time", "advt_time", "adpos", "totads", "brkno", "posinbrk",
    "adsinbrk", "lng", "dur", "cost",
]

_ALIASES = {
    "product_group": ["product_group", "product group", "productgroup"],
    "advertiser": ["advertiser"],
    "product": ["product"],
    "advt_theme": ["advt_theme", "advt theme", "theme"],
    "va_com": ["v/a | com", "v/a|com", "va | com", "v/a com", "va com", "v/a"],
    "medium": ["medium"],
    "ads": ["ads"],
    "channel": ["channel"],
    "program": ["program", "programme"],
    "dd": ["dd", "day of month"],
    "mn": ["mn", "month"],
    "yr": ["yr", "year"],
    "day": ["day"],
    "prog_time": ["prog_time", "prog time", "programme time"],
    "advt_time": ["advt_time", "advt time", "advert time"],
    "ad_pos": ["adpos", "ad pos", "ad position"],
    "tot_ads": ["totads", "tot ads", "total ads"],
    "brk_no": ["brkno", "brk no", "break no"],
    "pos_in_brk": ["posinbrk", "pos in brk"],
    "ads_in_brk": ["adsinbrk", "ads in brk"],
    "lng": ["lng", "length"],
    "dur": ["dur", "duration"],
    "cost": ["cost", "amount", "spend"],
}


def parse_workbook(path: str) -> dict:
    """Parse the first non-empty sheet. Return a summary + rows payload."""
    sheets = load_sheets(path)
    # Use the sheet with the most rows (adex is usually one big sheet).
    name, rows = max(sheets.items(), key=lambda kv: len(kv[1]), default=(None, []))
    if not rows:
        return {"headers_seen": [], "header_mismatch": True, "rows": [], "row_count": 0}

    header_index = build_header_index(rows[0])
    cols = {field: find_column(header_index, aliases) for field, aliases in _ALIASES.items()}

    missing = [f for f in ("product_group", "advertiser", "va_com", "cost", "medium") if cols[f] is None]
    header_mismatch = bool(missing)

    parsed: list[dict] = []
    com_count = va_count = 0
    com_spend = 0.0
    for raw in rows[1:]:
        if raw is None or all(c is None for c in raw):
            continue
        va_raw = cell(raw, cols["va_com"])
        va_com = _norm_va(va_raw)
        cost = to_float(cell(raw, cols["cost"]))
        d = parse_row_date(cell(raw, cols["dd"]), cell(raw, cols["mn"]), cell(raw, cols["yr"]))

        if va_com == "Com":
            com_count += 1
            com_spend += cost or 0.0
        elif va_com == "V/A":
            va_count += 1

        parsed.append(
            {
                "product_group": _s(cell(raw, cols["product_group"])),
                "advertiser": _s(cell(raw, cols["advertiser"])),
                "product": _s(cell(raw, cols["product"])),
                "advt_theme": _s(cell(raw, cols["advt_theme"])),
                "va_com": va_com,
                "medium": _s(cell(raw, cols["medium"])),
                "ads": _s(cell(raw, cols["ads"])),
                "channel": _s(cell(raw, cols["channel"])),
                "program": _s(cell(raw, cols["program"])),
                "spot_date": d.isoformat() if d else None,
                "day": _s(cell(raw, cols["day"])),
                "prog_time": _s(cell(raw, cols["prog_time"])),
                "advt_time": _s(cell(raw, cols["advt_time"])),
                "ad_pos": _s(cell(raw, cols["ad_pos"])),
                "tot_ads": to_int(cell(raw, cols["tot_ads"])),
                "brk_no": _s(cell(raw, cols["brk_no"])),
                "pos_in_brk": _s(cell(raw, cols["pos_in_brk"])),
                "ads_in_brk": _s(cell(raw, cols["ads_in_brk"])),
                "lng": _s(cell(raw, cols["lng"])),
                "dur": to_float(cell(raw, cols["dur"])),
                "cost": cost,
            }
        )

    return {
        "sheet_name": name,
        "headers_seen": list(header_index.keys()),
        "canonical_headers": CANONICAL_HEADERS,
        "missing_required": missing,
        "header_mismatch": header_mismatch,
        "row_count": len(parsed),
        "com_rows": com_count,
        "va_rows": va_count,
        "com_spend_total": round(com_spend, 2),
        "rows": parsed,
    }


def _norm_va(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip().lower()
    if s in {"com", "c", "commercial"}:
        return "Com"
    if s in {"v/a", "va", "value addition", "v a", "v/addition"}:
        return "V/A"
    return s.upper() if s else None


def _s(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None
