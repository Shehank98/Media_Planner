"""Asynchronous upload job orchestration.

Large uploads are processed off the request thread. The HTTP handler:
  1. saves the raw file under var/uploads/<job_id>,
  2. creates a Job row (status=pending) and returns the job_id immediately,
  3. schedules `run_parse_job` via FastAPI BackgroundTasks.

The worker parses the file, writes the full parsed payload to
var/staged/<job_id>.json, and flips the job to `awaiting_review` with a
summary preview. Nothing lands in the main tables until the user confirms.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import uuid

from .config import settings
from .database import SessionLocal
from .models import Job
from .parsers import adex as adex_parser
from .parsers import media_watch as mw_parser
from .parsers import rate_card as rc_parser


def _dir(name: str) -> str:
    path = os.path.join(settings.data_dir, name)
    os.makedirs(path, exist_ok=True)
    return path


def uploads_dir() -> str:
    return _dir("uploads")


def staged_dir() -> str:
    return _dir("staged")


def staged_path(job_id: str) -> str:
    return os.path.join(staged_dir(), f"{job_id}.json")


def new_job(kind: str, filename: str) -> str:
    job_id = str(uuid.uuid4())
    db = SessionLocal()
    try:
        db.add(Job(id=job_id, kind=kind, filename=filename, status="pending"))
        db.commit()
    finally:
        db.close()
    return job_id


def _set_status(job_id: str, status: str, error: str | None = None) -> None:
    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if job:
            job.status = status
            if error is not None:
                job.error = error
            if status in {"awaiting_review", "committed", "failed"}:
                job.finished_at = dt.datetime.utcnow()
            db.commit()
    finally:
        db.close()


_PARSERS = {
    "rate_card": rc_parser.parse_workbook,
    "adex": adex_parser.parse_workbook,
    "media_watch": mw_parser.parse_workbook,
}


def _summary(kind: str, payload) -> dict:
    """Small preview stored on the Job (the full payload lives on disk)."""
    if kind == "rate_card":
        return {
            "sheets": [
                {
                    "channel": b["channel"],
                    "effective_date": b["effective_date"],
                    "effective_date_method": b["effective_date_method"],
                    "rate_duration_secs": b["rate_duration_secs"],
                    "duration_needs_input": b["duration_needs_input"],
                    "row_count": b["row_count"],
                }
                for b in payload
            ]
        }
    if kind == "adex":
        return {
            k: payload[k]
            for k in (
                "sheet_name", "row_count", "com_rows", "va_rows",
                "com_spend_total", "header_mismatch", "missing_required",
                "headers_seen",
            )
        }
    if kind == "media_watch":
        return {
            k: payload[k]
            for k in ("sheet_name", "row_count", "header_mismatch", "missing_required", "headers_seen")
        }
    return {}


def run_parse_job(job_id: str, kind: str, file_path: str) -> None:
    """Background worker. Never raises to the caller - records failure on the Job."""
    _set_status(job_id, "parsing")
    try:
        payload = _PARSERS[kind](file_path)
        with open(staged_path(job_id), "w", encoding="utf-8") as fh:
            json.dump({"kind": kind, "payload": payload, "summary": _summary(kind, payload)}, fh)
        _set_status(job_id, "awaiting_review")
    except Exception as exc:  # noqa: BLE001 - surface any parse failure to the UI
        _set_status(job_id, "failed", error=f"{type(exc).__name__}: {exc}")


def load_staged(job_id: str) -> dict | None:
    path = staged_path(job_id)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def clear_staged(job_id: str) -> None:
    for path in (staged_path(job_id), os.path.join(uploads_dir(), job_id)):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
