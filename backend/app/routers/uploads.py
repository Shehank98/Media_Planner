"""Async upload endpoints (shared by all three dataset kinds) + job polling
and review/confirm.

Flow:
  POST /api/uploads/{kind}        -> accept file, return job_id immediately
  GET  /api/jobs/{job_id}         -> poll status
  GET  /api/jobs/{job_id}/review  -> full parsed payload for review
  POST /api/jobs/{job_id}/confirm -> commit reviewed data to Postgres
"""
from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import jobs
from ..config import settings
from ..database import get_db
from ..models import Job
from ..services import ingest, rate_cards

router = APIRouter(tags=["uploads"])

_KINDS = {"rate_card", "adex", "tvr"}
_CHUNK = 1024 * 1024  # stream to disk 1 MB at a time so big files never sit in RAM


@router.post("/api/uploads/{kind}")
async def upload(kind: str, background: BackgroundTasks, file: UploadFile = File(...)):
    if kind not in _KINDS:
        raise HTTPException(400, f"unknown upload kind: {kind}")

    max_bytes = settings.max_upload_mb * 1024 * 1024

    # Stream the upload straight to a temp file in chunks, enforcing the size
    # limit as we go. This keeps memory flat regardless of file size (a large
    # xlsx is never fully loaded into RAM) and lets us reject oversize files
    # before doing any work.
    tmp = os.path.join(jobs.uploads_dir(), f"tmp-{uuid.uuid4()}")
    size = 0
    try:
        with open(tmp, "wb") as fh:
            while True:
                chunk = await file.read(_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        413,
                        f"file is {size / 1024 / 1024:.0f} MB, over the {settings.max_upload_mb} MB "
                        f"limit. Raise MAX_UPLOAD_MB in the deployment settings to allow larger files.",
                    )
                fh.write(chunk)
    except BaseException:
        _quiet_remove(tmp)
        raise

    job_id = jobs.new_job(kind, file.filename or "upload.xlsx")
    dest = os.path.join(jobs.uploads_dir(), job_id)
    os.replace(tmp, dest)

    # Parse off the request thread; return immediately.
    background.add_task(jobs.run_parse_job, job_id, kind, dest)
    return {"job_id": job_id, "status": "pending", "kind": kind}


def _quiet_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


@router.get("/api/jobs/{job_id}")
def job_status(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "job_id": job.id,
        "kind": job.kind,
        "filename": job.filename,
        "status": job.status,
        "error": job.error,
        "batch_id": job.batch_id,
    }


@router.get("/api/jobs/{job_id}/review")
def job_review(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.status == "failed":
        raise HTTPException(422, f"parse failed: {job.error}")
    if job.status != "awaiting_review":
        return {"status": job.status}
    staged = jobs.load_staged(job_id)
    if not staged:
        raise HTTPException(410, "staged payload no longer available")
    return {"status": job.status, "kind": staged["kind"], "summary": staged["summary"], "payload": staged["payload"]}


@router.post("/api/jobs/{job_id}/confirm")
def job_confirm(job_id: str, body: dict | None = None, db: Session = Depends(get_db)):
    """Commit reviewed data. Body may contain corrected data:
      rate_card: {blocks: [...]}     (overrides staged blocks)
      adex/tvr: {payload: {...}} (optional overrides)
    """
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.status == "committed":
        raise HTTPException(409, "job already committed")

    staged = jobs.load_staged(job_id)
    if not staged:
        raise HTTPException(410, "staged payload no longer available")

    body = body or {}
    kind = staged["kind"]
    filename = body.get("filename") or job.filename

    if kind == "rate_card":
        blocks = body.get("blocks") or staged["payload"]
        result = rate_cards.commit_review(db, filename, blocks)
    elif kind == "adex":
        payload = body.get("payload") or staged["payload"]
        result = ingest.commit_adex(db, filename, payload)
    elif kind == "tvr":
        payload = body.get("payload") or staged["payload"]
        result = ingest.commit_tvr(db, filename, payload)
    else:
        raise HTTPException(400, f"unknown kind {kind}")

    job.status = "committed"
    job.batch_id = result["batch_id"]
    db.commit()
    jobs.clear_staged(job_id)
    return {"status": "committed", **result}
