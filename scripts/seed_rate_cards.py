#!/usr/bin/env python3
"""Seed rate cards from an Excel workbook directly into Postgres.

Runs the workbook through the SAME parser and commit service the web upload
uses (`app.parsers.rate_card` + `app.services.rate_cards.commit_review`), so the
stored result is identical to reviewing and confirming an upload in the UI -
30s-equivalent normalization, PT/NPT inference, day/time parsing and rate-card
versioning all apply.

Usage:
    # point DATABASE_URL at your database first (Railway sets it automatically)
    export DATABASE_URL=postgresql://.../media_planner
    python scripts/seed_rate_cards.py path/to/RateCards.xlsx \
        --duration "Sirasa TV=30" \
        --effective "TV Derana="

Flags:
    --duration "Channel=SECS"   Set the spot duration for a sheet whose header
                                did not state one (e.g. a plain "Rack Rate"
                                column). Repeatable. Recomputes 30s-equivalent.
    --effective "Channel=DATE"   Override/blank the effective date for a sheet.
                                An empty value stores NULL (always-applicable).
                                Repeatable.
    --keep-cprp                 Also import the sheet's own "CPRP Rack Rate"
                                column (stored for reference only). By default it
                                is dropped, since the system recomputes CPRP from
                                live TVR - the sheet's figure is not authoritative.
    --dry-run                   Parse and print the plan, but do not write.
"""
from __future__ import annotations

import argparse
import os
import sys

# Make the backend package importable when run from the repo root.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from app.database import SessionLocal, init_db  # noqa: E402
from app.parsers import rate_card  # noqa: E402
from app.services import rate_cards as rc_service  # noqa: E402


def _parse_kv(items: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items or []:
        if "=" not in item:
            raise SystemExit(f"expected Channel=value, got: {item!r}")
        key, _, val = item.partition("=")
        out[key.strip()] = val.strip()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed rate cards from an Excel workbook.")
    ap.add_argument("workbook", help="path to the rate card .xlsx")
    ap.add_argument("--duration", action="append", default=[], metavar="Channel=SECS")
    ap.add_argument("--effective", action="append", default=[], metavar="Channel=YYYY-MM-DD")
    ap.add_argument("--keep-cprp", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    durations = {k: int(v) for k, v in _parse_kv(args.duration).items()}
    effectives = _parse_kv(args.effective)

    blocks = rate_card.parse_workbook(args.workbook)

    for b in blocks:
        ch = b["channel"]

        # Effective date override (empty string -> NULL / always-applicable).
        if ch in effectives:
            b["effective_date"] = effectives[ch] or None

        # Duration override for sheets that stated none (recompute 30s equiv).
        if ch in durations:
            secs = durations[ch]
            b["rate_duration_secs"] = secs
            for row in b["rows"]:
                row["rate_duration_secs"] = secs
                if row.get("rack_rate") is not None:
                    row["rate_30s_equivalent"] = round(row["rack_rate"] * (30.0 / secs), 4)

        # Drop the sheet's own CPRP figure unless explicitly kept.
        if not args.keep_cprp:
            for row in b["rows"]:
                row["sheet_cprp_rack_rate"] = None

    # Report the plan.
    print(f"Workbook: {args.workbook}")
    for b in blocks:
        dur = b["rate_duration_secs"]
        flag = "  [DURATION STILL MISSING]" if (dur is None and not any(r.get("rate_duration_secs") for r in b["rows"])) else ""
        print(f"  - {b['channel']:<16} rows={b['row_count']:<3} "
              f"effective={b['effective_date'] or 'NULL':<12} duration={dur or '-'}s{flag}")

    missing = [b["channel"] for b in blocks
               if b["rate_duration_secs"] is None and not any(r.get("rate_duration_secs") for r in b["rows"])]
    if missing:
        print(f"\nWARNING: no duration for: {', '.join(missing)} - 30s-equivalent will be NULL "
              f"for those (pass --duration \"Channel=SECS\").")

    if args.dry_run:
        print("\n[dry-run] nothing written.")
        return 0

    init_db()
    db = SessionLocal()
    try:
        result = rc_service.commit_review(db, os.path.basename(args.workbook), blocks)
    finally:
        db.close()
    print(f"\nCommitted batch {result['batch_id']} - {result['rows']} rate rows across {len(blocks)} channels.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
