"""Tab 3: channel-first drill-down on the adex dataset.

Channel -> advertisers on that channel (paid spend and V/A bonus) -> drill into
one advertiser to see how they worked on the channel: Com vs V/A, monthly trend,
and top programmes.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from .. import charts
from ..database import get_db
from ..services import adex_analysis, colors as colors_svc

router = APIRouter(prefix="/api/tab3", tags=["tab3-channel-first"])


@router.get("/channels")
def channels(db: Session = Depends(get_db)):
    return adex_analysis.channels(db)


@router.get("/advertisers-by-channel")
def advertisers_by_channel(db: Session = Depends(get_db)):
    return adex_analysis.channel_advertisers_on(db)


@router.get("/overview")
def overview(channel: str, top: int = 15, db: Session = Depends(get_db)):
    data = adex_analysis.channel_first(db, channel, top)
    data["com_va"] = adex_analysis.com_va(db, channel)
    data["advertisers"] = adex_analysis.channel_advertisers(db, channel, top)
    return data


@router.get("/advertiser-detail")
def advertiser_detail(channel: str, advertiser: str, top: int = 15, db: Session = Depends(get_db)):
    return {
        "channel": channel,
        "advertiser": advertiser,
        "com_va": adex_analysis.com_va(db, channel, advertiser),
        "programmes": adex_analysis.advertiser_on_channel(db, channel, advertiser, top),
        "trend": adex_analysis.advertiser_channel_trend(db, channel, advertiser),
    }


# --- charts ---------------------------------------------------------------
@router.get("/charts/advertisers.png")
def chart_advertisers(channel: str, db: Session = Depends(get_db)):
    data = adex_analysis.channel_advertisers(db, channel, top=12)
    names = [a["advertiser"] for a in data]
    png = charts.bar_chart(
        names, [a["com_spend"] for a in data], title="", money=True,
        colors=colors_svc.color_list(colors_svc.advertiser_colors(db), names),
    )
    return Response(png, media_type="image/png")


@router.get("/charts/programmes.png")
def chart_programmes(channel: str, advertiser: str | None = None, db: Session = Depends(get_db)):
    if advertiser:
        data = adex_analysis.advertiser_on_channel(db, channel, advertiser, top=12)
    else:
        data = adex_analysis.channel_first(db, channel, top=12)["programmes"]
    png = charts.bar_chart(
        [p["programme"] for p in data], [p["spend"] for p in data], title="", money=True, single_color=True,
    )
    return Response(png, media_type="image/png")


@router.get("/charts/advertiser-trend.png")
def chart_advertiser_trend(channel: str, advertiser: str, db: Session = Depends(get_db)):
    data = adex_analysis.advertiser_channel_trend(db, channel, advertiser)
    amap = colors_svc.advertiser_colors(db)
    png = charts.line_chart(data["labels"], data["series"], title="", money=True,
                            colors=[amap.get(advertiser, charts.OTHERS)])
    return Response(png, media_type="image/png")
