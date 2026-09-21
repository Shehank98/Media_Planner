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
        "analysis_guide": prompt_guide.get_logic(db),
        "template_guide": prompt_guide.get_format(db),
        "va_themes": settings_store.get_va_themes(db),
    }


@router.put("/va-themes")
def set_va_themes(body: dict = Body(...), db: Session = Depends(get_db)):
    """Update the Advt_Theme values that mark a spot as value addition (V/A).

    Accepts either a list under `themes` or a newline/comma-separated `text`."""
    themes = body.get("themes")
    if themes is None:
        raw = body.get("text", "")
        themes = [t.strip() for t in str(raw).replace(",", "\n").split("\n") if t.strip()]
    saved = settings_store.set_va_themes(db, themes)
    return {"va_themes": saved}


@router.put("/prime-window")
def set_prime_window(body: dict = Body(...), db: Session = Depends(get_db)):
    try:
        settings_store.set_prime_window(db, body["start"], body["end"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@router.put("/analysis-guide")
def set_analysis_guide(body: dict = Body(...), db: Session = Depends(get_db)):
    return prompt_guide.save_analysis(db, body.get("text", ""))


@router.put("/template-guide")
def set_template_guide(body: dict = Body(...), db: Session = Depends(get_db)):
    return prompt_guide.save_template(db, body.get("text", ""))


@router.post("/analysis-guide/upload")
async def upload_analysis_guide(file: UploadFile = File(...), db: Session = Depends(get_db)):
    raw = (await file.read()).decode("utf-8", errors="replace")
    return prompt_guide.save_analysis(db, raw)


@router.post("/template-guide/upload")
async def upload_template_guide(file: UploadFile = File(...), db: Session = Depends(get_db)):
    raw = (await file.read()).decode("utf-8", errors="replace")
    return prompt_guide.save_template(db, raw)
