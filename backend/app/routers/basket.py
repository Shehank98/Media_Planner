"""Tab 2: channel basket & programme selection endpoints."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from .. import charts
from ..database import get_db
from ..services import basket, ingest

router = APIRouter(prefix="/api/tab2", tags=["tab2-basket"])


@router.get("/channels")
def channels(db: Session = Depends(get_db)):
    return basket.channels(db)


@router.get("/best-programmes")
def best_programmes(
    channel: str | None = None,
    slot: str | None = Query(None, pattern="^(PT|NPT)$"),
    metric: str = Query("tvr", pattern="^(tvr|tvr_share_pct|reach_pct)$"),
    limit: int = 25,
    db: Session = Depends(get_db),
):
    return basket.best_programmes(db, channel, slot, metric, limit)


@router.get("/cprp-chart.png")
def cprp_chart(channel: str | None = None, slot: str | None = None, limit: int = 15, db: Session = Depends(get_db)):
    data = [p for p in basket.best_programmes(db, channel, slot, "tvr", limit) if p["cprp"] is not None]
    data.sort(key=lambda x: x["cprp"])
    png = charts.bar_chart(
        [f"{p['programme']} ({p['channel']})" for p in data],
        [p["cprp"] for p in data],
        title="CPRP by Programme (lower = more efficient)",
        xlabel="CPRP",
    )
    return Response(png, media_type="image/png")


@router.post("/basket")
def build_basket(body: dict = Body(...), db: Session = Depends(get_db)):
    selections = body.get("selections") or []
    if not selections:
        raise HTTPException(400, "selections is required")
    return basket.build_basket(db, selections)


@router.post("/basket/export.csv")
def export_basket(body: dict = Body(...), db: Session = Depends(get_db)):
    selections = body.get("selections") or []
    result = basket.build_basket(db, selections)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Channel", "Programme", "Slot", "TVR", "Reach", "Reach %", "30s Rate", "CPRP"])
    for line in result["lines"]:
        w.writerow([line["channel"], line["programme"], line["slot"], line["tvr"], line["reach"], line["reach_pct"], line["rate_30s_equivalent"], line["cprp"]])
    t = result["totals"]
    w.writerow([])
    w.writerow(["TOTAL", "", "", t["total_tvr"], t["total_reach"], "", t["total_cost"], t["blended_cprp"]])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=basket.csv"})


@router.get("/batches")
def batches(db: Session = Depends(get_db)):
    return ingest.list_batches(db, "tvr")


@router.delete("/batches/{batch_id}")
def delete_batch(batch_id: str, db: Session = Depends(get_db)):
    n = ingest.delete_batch(db, "tvr", batch_id)
    if n == 0:
        raise HTTPException(404, "batch not found")
    return {"deleted_rows": n}
