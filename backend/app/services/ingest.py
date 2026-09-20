"""Commit reviewed adex / TVR staged payloads into the main tables."""
from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import AdexRow, Batch, TvrRow
from ..utils.timeparse import in_window, parse_time
from . import colors, settings_store


def _date(value) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def commit_adex(db: Session, filename: str, payload: dict) -> dict:
    batch_id = str(uuid.uuid4())
    rows = payload.get("rows", [])
    for r in rows:
        db.add(
            AdexRow(
                batch_id=batch_id,
                product_group=r.get("product_group"),
                advertiser=r.get("advertiser"),
                product=r.get("product"),
                advt_theme=r.get("advt_theme"),
                va_com=r.get("va_com"),
                medium=_norm_medium(r.get("medium")),
                ads=r.get("ads"),
                channel=r.get("channel"),
                program=r.get("program"),
                spot_date=_date(r.get("spot_date")),
                day=r.get("day"),
                prog_time=r.get("prog_time"),
                advt_time=r.get("advt_time"),
                ad_pos=r.get("ad_pos"),
                tot_ads=r.get("tot_ads"),
                brk_no=r.get("brk_no"),
                pos_in_brk=r.get("pos_in_brk"),
                ads_in_brk=r.get("ads_in_brk"),
                lng=r.get("lng"),
                dur=r.get("dur"),
                cost=r.get("cost"),
            )
        )
    db.add(Batch(id=batch_id, kind="adex", filename=filename, row_count=len(rows)))

    # Persist the header mapping so repeat uploads can be validated against it.
    if payload.get("headers_seen"):
        settings_store.put(db, settings_store.ADEX_MAPPING_KEY, ",".join(payload["headers_seen"]))
    db.commit()
    colors.clear_cache()
    return {"batch_id": batch_id, "rows": len(rows)}


def commit_tvr(db: Session, filename: str, payload: dict) -> dict:
    prime_start, prime_end = settings_store.get_prime_window(db)
    batch_id = str(uuid.uuid4())
    rows = payload.get("rows", [])
    for r in rows:
        start_t = parse_time(r.get("start_time"))
        pnp = "PT" if in_window(start_t, prime_start, prime_end) else ("NPT" if start_t else None)
        db.add(
            TvrRow(
                batch_id=batch_id,
                rank=r.get("rank"),
                data_set=r.get("data_set"),
                channel=r.get("channel"),
                spot_date=_date(r.get("spot_date")),
                day=r.get("day"),
                start_time=start_t,
                end_time=parse_time(r.get("end_time")),
                program=r.get("program"),
                duration=r.get("duration"),
                category=r.get("category"),
                tvr=r.get("tvr"),
                total_tvr=r.get("total_tvr"),
                tvr_share_pct=r.get("tvr_share_pct"),
                reach=r.get("reach"),
                reach_pct=r.get("reach_pct"),
                avg_time=r.get("avg_time"),
                prime_non_prime=pnp,
            )
        )
    db.add(Batch(id=batch_id, kind="tvr", filename=filename, row_count=len(rows)))
    db.commit()
    colors.clear_cache()
    return {"batch_id": batch_id, "rows": len(rows)}


def _norm_medium(m: str | None) -> str | None:
    if not m:
        return None
    s = m.strip().lower()
    if s.startswith("tv") or "televi" in s:
        return "TV"
    if "radio" in s or s == "fm":
        return "Radio"
    if "press" in s or "print" in s or "news" in s or "paper" in s:
        return "Press"
    return m.strip()


def list_batches(db: Session, kind: str) -> list[dict]:
    rows = db.execute(
        select(Batch).where(Batch.kind == kind).order_by(Batch.uploaded_at.desc())
    ).scalars().all()
    return [
        {
            "batch_id": b.id,
            "filename": b.filename,
            "uploaded_at": b.uploaded_at.isoformat() if b.uploaded_at else None,
            "row_count": b.row_count,
        }
        for b in rows
    ]


def delete_batch(db: Session, kind: str, batch_id: str) -> int:
    model = AdexRow if kind == "adex" else TvrRow
    n = db.execute(delete(model).where(model.batch_id == batch_id)).rowcount
    db.execute(delete(Batch).where(Batch.id == batch_id))
    db.commit()
    colors.clear_cache()
    return n or 0


def stored_adex_mapping(db: Session) -> list[str]:
    raw = settings_store.get(db, settings_store.ADEX_MAPPING_KEY)
    return raw.split(",") if raw else []
