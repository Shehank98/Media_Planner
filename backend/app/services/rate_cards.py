"""Rate card store: commit reviewed data, versioned lookup, list/delete."""
from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..models import Batch, RateCard
from ..utils.days import parse_days
from ..utils.timeparse import in_window, parse_time
from . import colors, settings_store


def commit_review(db: Session, filename: str, blocks: list[dict]) -> dict:
    """Persist reviewed/corrected rate card blocks.

    `blocks` mirrors the parser output but with any user corrections applied
    (effective_date, rate_duration_secs, per-row rack rates, etc). We (re)apply
    the 30s-equivalent and the prime/non-prime inference here so the stored
    values always reflect the confirmed inputs.
    """
    prime_start, prime_end = settings_store.get_prime_window(db)
    batch_id = str(uuid.uuid4())
    total = 0

    for block in blocks:
        channel = (block.get("channel") or block.get("source_sheet_name") or "").strip()
        eff = _parse_date(block.get("effective_date"))
        block_duration = block.get("rate_duration_secs")

        for row in block.get("rows", []):
            duration = row.get("rate_duration_secs") or block_duration
            rack = _f(row.get("rack_rate"))
            rate_30s = None
            if rack is not None and duration:
                rate_30s = round(rack * (30.0 / float(duration)), 4)

            # Prime/non-prime: use given value, else infer from start time.
            pnp = row.get("prime_non_prime")
            source = row.get("prime_non_prime_source") or ("given" if pnp else "inferred")
            start_t = parse_time(row.get("start_time"))
            if not pnp:
                pnp = "PT" if in_window(start_t, prime_start, prime_end) else ("NPT" if start_t else None)
                source = "inferred"

            days = row.get("days_of_week")
            if days is None and row.get("day_pattern_raw"):
                days = parse_days(row.get("day_pattern_raw"))

            db.add(
                RateCard(
                    batch_id=batch_id,
                    channel=channel,
                    effective_date=eff,
                    programme=row.get("programme"),
                    prime_non_prime=pnp,
                    prime_non_prime_source=source,
                    rating=_f(row.get("rating")),
                    day_pattern_raw=row.get("day_pattern_raw"),
                    days_of_week=days or None,
                    start_time=start_t,
                    end_time=parse_time(row.get("end_time")),
                    rack_rate=rack,
                    rate_duration_secs=int(duration) if duration else None,
                    rate_30s_equivalent=rate_30s,
                    additional_notes=row.get("additional_notes"),
                    extra_cost=_f(row.get("extra_cost")),
                    sheet_cprp_rack_rate=_f(row.get("sheet_cprp_rack_rate")),
                    source_sheet_name=block.get("source_sheet_name"),
                )
            )
            total += 1

    db.add(Batch(id=batch_id, kind="rate_card", filename=filename, row_count=total))
    db.commit()
    colors.clear_cache()
    return {"batch_id": batch_id, "rows": total}


def lookup_rate(
    db: Session,
    channel: str,
    programme: str | None,
    on_date: dt.date | None,
    prime_non_prime: str | None = None,
) -> tuple[RateCard | None, str | None]:
    """Find the applicable rate for CPRP.

    Returns (rate_row, match_type) where match_type documents how it was found
    so the UI can show an honest rate source. Match precedence:
      1. channel + exact programme (case-insensitive), version effective on/before date
      2. channel + prime/non-prime slot (when programme not found)
      3. channel only, latest version effective on/before date
      4. nearest available version (when nothing is effective on/before the date)
    """
    base = select(RateCard).where(func.lower(RateCard.channel) == channel.strip().lower())

    def _apply_date(stmt):
        if on_date is not None:
            stmt = stmt.where(
                (RateCard.effective_date.is_(None)) | (RateCard.effective_date <= on_date)
            )
        return stmt.order_by(RateCard.effective_date.desc().nullslast())

    if programme:
        stmt = _apply_date(base.where(func.lower(RateCard.programme) == programme.strip().lower()))
        row = db.execute(stmt).scalars().first()
        if row:
            return row, "exact programme"

    if prime_non_prime:
        stmt = _apply_date(base.where(RateCard.prime_non_prime == prime_non_prime))
        row = db.execute(stmt).scalars().first()
        if row:
            return row, f"channel + {prime_non_prime} slot"

    row = db.execute(_apply_date(base)).scalars().first()
    if row:
        return row, "channel fallback"

    # Final fallback: no version is effective on/before the analysed date (e.g.
    # the rate card only holds a newer/future rate). Rather than return no CPRP
    # at all, use the nearest available version for the channel.
    row = db.execute(base.order_by(RateCard.effective_date.asc().nullslast())).scalars().first()
    if row:
        return row, "nearest version (none effective on/before date)"
    return None, None


def list_batches(db: Session) -> list[dict]:
    rows = db.execute(
        select(Batch).where(Batch.kind == "rate_card").order_by(Batch.uploaded_at.desc())
    ).scalars().all()
    return [
        {
            "batch_id": b.id,
            "filename": b.filename,
            "uploaded_at": b.uploaded_at.isoformat() if b.uploaded_at else None,
            "row_count": b.row_count,
            "channels": _channels_for_batch(db, b.id),
        }
        for b in rows
    ]


def _channels_for_batch(db: Session, batch_id: str) -> list[str]:
    rows = db.execute(
        select(RateCard.channel).where(RateCard.batch_id == batch_id).distinct()
    ).scalars().all()
    return sorted(c for c in rows if c)


def delete_batch(db: Session, batch_id: str) -> int:
    n = db.execute(delete(RateCard).where(RateCard.batch_id == batch_id)).rowcount
    db.execute(delete(Batch).where(Batch.id == batch_id))
    db.commit()
    colors.clear_cache()
    return n or 0


def _parse_date(value) -> dt.date | None:
    if not value:
        return None
    if isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _f(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None
