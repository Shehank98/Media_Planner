"""Adex (advertising expenditure / media-watch) workbook parser - Tab 1 / Tab 3.

The real media-watch sheet does NOT carry Medium or V/A|Com columns:
  Product_Group, Advertiser, Product, Advt_Theme, Ads, Channel, Program, Dd,
  Mn, Yr, Day, Prog_time, Advt_time, AdPos, TotAds, BrkNo, PosinBrk, AdsinBrk,
  Lng, Dur, Cost

So this parser DERIVES two columns on upload:
  * Medium  - from the Channel prefix, e.g. "Tv - Sirasa tv" -> TV,
              "Radio - Siyatha FM" -> Radio.
  * V/A|Com - from Advt_Theme: an exact (case-insensitive) match against the
              VA marker themes configured in Settings marks the row as V/A;
              everything else is Com (paid). VA is bonus airtime, excluded
              from spend.
If the sheet already contains a Medium or V/A|Com column, its value is used
and only blank cells fall back to the derivation.

Header validation: the canonical set is returned so the caller can compare
against a stored mapping and flag mismatches for user confirmation before
inserting.
"""
from __future__ import annotations

from typing import Any

from ..utils.dates import parse_row_date
from ..utils.media import medium_from_channel, norm_medium
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


def parse_workbook(path: str, va_themes: list[str] | None = None) -> dict:
    """Parse the first non-empty sheet. Return a summary + rows payload.

    `va_themes` is the list of Advt_Theme values (from Settings) that mark a
    spot as value addition; matching is exact and case-insensitive."""
    sheets = load_sheets(path)
    # Use the sheet with the most rows (adex is usually one big sheet).
    name, rows = max(sheets.items(), key=lambda kv: len(kv[1]), default=(None, []))
    if not rows:
        return {"headers_seen": [], "header_mismatch": True, "rows": [], "row_count": 0}

    header_index = build_header_index(rows[0])
    cols = {field: find_column(header_index, aliases) for field, aliases in _ALIASES.items()}

    # Medium and V/A|Com are derived from Channel and Advt_Theme, so they are
    # no longer required in the sheet.
    missing = [f for f in ("product_group", "advertiser", "cost") if cols[f] is None]
    header_mismatch = bool(missing)

    va_lookup = {t.strip().lower() for t in (va_themes or []) if str(t).strip()}
    derived_medium = cols["medium"] is None
    derived_va = cols["va_com"] is None

    parsed: list[dict] = []
    com_count = va_count = 0
    com_spend = 0.0
    for raw in rows[1:]:
        if raw is None or all(c is None for c in raw):
            continue
        channel = _s(cell(raw, cols["channel"]))
        theme = _s(cell(raw, cols["advt_theme"]))

        # Medium: sheet column if present and filled, else Channel prefix.
        medium = norm_medium(_s(cell(raw, cols["medium"]))) if cols["medium"] is not None else None
        if not medium:
            medium = medium_from_channel(channel)

        # V/A vs Com: sheet column if present and filled, else Advt_Theme match.
        va_com = _norm_va(cell(raw, cols["va_com"])) if cols["va_com"] is not None else None
        if not va_com:
            va_com = "V/A" if (theme or "").strip().lower() in va_lookup else "Com"

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
                "advt_theme": theme,
                "va_com": va_com,
                "medium": medium,
                "ads": _s(cell(raw, cols["ads"])),
                "channel": channel,
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
        "medium_derived": derived_medium,
        "va_derived": derived_va,
        "va_themes_used": sorted(va_lookup),
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
