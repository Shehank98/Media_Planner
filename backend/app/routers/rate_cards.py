"""Rate card store management endpoints (list / delete batches)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..services import rate_cards

router = APIRouter(prefix="/api/rate-cards", tags=["rate-cards"])


@router.get("/batches")
def list_batches(db: Session = Depends(get_db)):
    return rate_cards.list_batches(db)


@router.delete("/batches/{batch_id}")
def delete_batch(batch_id: str, db: Session = Depends(get_db)):
    n = rate_cards.delete_batch(db, batch_id)
    if n == 0:
        raise HTTPException(404, "batch not found or already empty")
    return {"deleted_rows": n}
