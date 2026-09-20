"""Runtime settings + prompt guide endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..database import get_db
from ..llm import prompt_guide
from ..services import settings_store
from ..utils.timeparse import time_to_str

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    start, end = settings_store.get_prime_window(db)
    return {
        "prime_start": time_to_str(start),
        "prime_end": time_to_str(end),
        "prompt_guide_logic": prompt_guide.get_logic(db),
        "prompt_guide_format": prompt_guide.get_format(db),
    }


@router.put("/prime-window")
def set_prime_window(body: dict = Body(...), db: Session = Depends(get_db)):
    try:
        settings_store.set_prime_window(db, body["start"], body["end"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@router.put("/prompt-guide")
def set_prompt_guide(body: dict = Body(...), db: Session = Depends(get_db)):
    text = body.get("text", "")
    if not text.strip():
        raise HTTPException(400, "text is required")
    return prompt_guide.save_guide(db, text)


@router.post("/prompt-guide/upload")
async def upload_prompt_guide(file: UploadFile = File(...), db: Session = Depends(get_db)):
    raw = (await file.read()).decode("utf-8", errors="replace")
    return prompt_guide.save_guide(db, raw)
