"""Tab 3: channel-first drill-down on the Tab 1 adex dataset.

Not a separate upload - a different entry path into the same Com-only data:
channel -> top advertisers on that channel -> their top programmes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from .. import charts
from ..database import get_db
from ..services import adex_analysis

router = APIRouter(prefix="/api/tab3", tags=["tab3-channel-first"])


@router.get("/channels")
def channels(db: Session = Depends(get_db)):
    return adex_analysis.channels(db)


@router.get("/overview")
def overview(channel: str, top: int = 15, db: Session = Depends(get_db)):
    return adex_analysis.channel_first(db, channel, top)


@router.get("/advertiser-programmes")
def advertiser_programmes(channel: str, advertiser: str, top: int = 15, db: Session = Depends(get_db)):
    return adex_analysis.advertiser_on_channel(db, channel, advertiser, top)


@router.get("/charts/advertisers.png")
def chart_advertisers(channel: str, db: Session = Depends(get_db)):
    data = adex_analysis.channel_first(db, channel, top=12)["advertisers"]
    png = charts.bar_chart(
        [a["advertiser"] for a in data], [a["spend"] for a in data],
        title=f"Top Advertisers on {channel}", money=True,
    )
    return Response(png, media_type="image/png")


@router.get("/charts/programmes.png")
def chart_programmes(channel: str, db: Session = Depends(get_db)):
    data = adex_analysis.channel_first(db, channel, top=12)["programmes"]
    png = charts.bar_chart(
        [p["programme"] for p in data], [p["spend"] for p in data],
        title=f"Top Programmes on {channel}", money=True,
    )
    return Response(png, media_type="image/png")
