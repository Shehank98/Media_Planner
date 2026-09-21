"""Commit reviewed adex / TVR staged payloads into the main tables."""
from __future__ import annotations

import datetime as dt
import gc
import uuid

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from ..models import AdexRow, Batch, Job, TvrRow
from ..utils.media import medium_from_channel, norm_medium
from ..utils.timeparse import in_window, parse_time
from . import colors, settings_store

# Insert in chunks so a very large upload never builds one giant list of ORM
# objects in memory. Core `insert()` with a list of dicts is a lightweight
# executemany (no per-row ORM instance, no identity-map bloat).
_CHUNK = 5000


def _date(value) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _bulk_insert(db: Session, model, mappings: list[dict]) -> None:
    """Insert `mappings` in bounded chunks, freeing each chunk as it goes."""
    for i in range(0, len(mappings), _CHUNK):
        chunk = mappings[i:i + _CHUNK]
        db.execute(insert(model), chunk)
        chunk.clear()


def commit_adex(db: Session, filename: str, payload: dict) -> dict:
    batch_id = str(uuid.uuid4())
    rows = payload.get("rows", [])
    mappings = [
        {
            "batch_id": batch_id,
            "product_group": r.get("product_group"),
            "advertiser": r.get("advertiser"),
            "product": r.get("product"),
            "advt_theme": r.get("advt_theme"),
            "va_com": r.get("va_com"),
            "medium": norm_medium(r.get("medium")) or medium_from_channel(r.get("channel")),
            "ads": r.get("ads"),
            "channel": r.get("channel"),
            "program": r.get("program"),
            "spot_date": _date(r.get("spot_date")),
            "day": r.get("day"),
            "prog_time": r.get("prog_time"),
            "advt_time": r.get("advt_time"),
            "ad_pos": r.get("ad_pos"),
            "tot_ads": r.get("tot_ads"),
            "brk_no": r.get("brk_no"),
            "pos_in_brk": r.get("pos_in_brk"),
            "ads_in_brk": r.get("ads_in_brk"),
            "lng": r.get("lng"),
            "dur": r.get("dur"),
            "cost": r.get("cost"),
        }
        for r in rows
    ]
    n = len(mappings)
    _bulk_insert(db, AdexRow, mappings)
    db.add(Batch(id=batch_id, kind="adex", filename=filename, row_count=n))

    # Persist the header mapping so repeat uploads can be validated against it.
    if payload.get("headers_seen"):
        settings_store.put(db, settings_store.ADEX_MAPPING_KEY, ",".join(payload["headers_seen"]))
    db.commit()
    colors.clear_cache()
    del mappings
    gc.collect()
    return {"batch_id": batch_id, "rows": n}


def commit_tvr(db: Session, filename: str, payload: dict) -> dict:
    prime_start, prime_end = settings_store.get_prime_window(db)
    batch_id = str(uuid.uuid4())
    rows = payload.get("rows", [])

    def _map(r):
        start_t = parse_time(r.get("start_time"))
        pnp = "PT" if in_window(start_t, prime_start, prime_end) else ("NPT" if start_t else None)
        return {
            "batch_id": batch_id,
            "rank": r.get("rank"),
            "data_set": r.get("data_set"),
            "channel": r.get("channel"),
            "spot_date": _date(r.get("spot_date")),
            "day": r.get("day"),
            "start_time": start_t,
            "end_time": parse_time(r.get("end_time")),
            "program": r.get("program"),
            "duration": r.get("duration"),
            "category": r.get("category"),
            "tvr": r.get("tvr"),
            "total_tvr": r.get("total_tvr"),
            "tvr_share_pct": r.get("tvr_share_pct"),
            "reach": r.get("reach"),
            "reach_pct": r.get("reach_pct"),
            "avg_time": r.get("avg_time"),
            "prime_non_prime": pnp,
        }

    mappings = [_map(r) for r in rows]
    n = len(mappings)
    _bulk_insert(db, TvrRow, mappings)
    db.add(Batch(id=batch_id, kind="tvr", filename=filename, row_count=n))
    db.commit()
    colors.clear_cache()
    del mappings
    gc.collect()
    return {"batch_id": batch_id, "rows": n}


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


def _drop_job_files(job_ids) -> None:
    """Remove the on-disk staged payload + raw upload for each job."""
    from .. import jobs
    for jid in job_ids:
        jobs.clear_staged(jid)


def delete_batch(db: Session, kind: str, batch_id: str) -> int:
    """Delete a single batch and everything tied to it: the data rows, the
    batch record, the job(s) that produced it and their staged/upload files,
    then drop cached colour maps and reclaim memory."""
    model = AdexRow if kind == "adex" else TvrRow
    n = db.execute(delete(model).where(model.batch_id == batch_id)).rowcount

    job_ids = db.execute(select(Job.id).where(Job.batch_id == batch_id)).scalars().all()
    db.execute(delete(Job).where(Job.batch_id == batch_id))
    db.execute(delete(Batch).where(Batch.id == batch_id))
    db.commit()

    _drop_job_files(job_ids)
    db.expire_all()          # drop any objects the session was still holding
    colors.clear_cache()
    gc.collect()             # return the freed rows/objects to the allocator
    return n or 0


def wipe_kind(db: Session, kind: str) -> dict:
    """Wipe EVERY dataset of a kind: all data rows, all batches, all jobs of
    that kind and their staged/upload files, plus cached maps. Use this to
    fully reset a dataset and reclaim its memory/disk in one go."""
    model = AdexRow if kind == "adex" else TvrRow
    rows = db.execute(delete(model)).rowcount
    batches = db.execute(delete(Batch).where(Batch.kind == kind)).rowcount

    job_ids = db.execute(select(Job.id).where(Job.kind == kind)).scalars().all()
    db.execute(delete(Job).where(Job.kind == kind))
    db.commit()

    _drop_job_files(job_ids)
    if kind == "adex":
        # Forget the remembered header mapping too, so the next upload is clean.
        settings_store.put(db, settings_store.ADEX_MAPPING_KEY, "")
    db.expire_all()
    colors.clear_cache()
    gc.collect()
    return {"rows": rows or 0, "batches": batches or 0}


def stored_adex_mapping(db: Session) -> list[str]:
    raw = settings_store.get(db, settings_store.ADEX_MAPPING_KEY)
    return raw.split(",") if raw else []
