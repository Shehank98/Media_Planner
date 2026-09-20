"""Market Overview dashboard + advanced market-movement endpoints.

Accepts an optional product_groups filter so the same endpoints power both the
whole-market dashboard and a category-filtered view in Tab 1.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query, Response
from sqlalchemy.orm import Session

from .. import charts
from ..database import get_db
from ..llm import gemini, prompt_guide
from ..services import colors as colors_svc, market

router = APIRouter(prefix="/api/market", tags=["market-overview"])


@router.get("/colors")
def color_maps(db: Session = Depends(get_db)):
    """Stable advertiser/channel/medium colour maps for the frontend so table
    swatches match server-rendered chart colours exactly."""
    return colors_svc.all_maps(db)


@router.get("/overview")
def overview(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    return market.overview(db, product_groups)


@router.get("/top-categories")
def top_categories(limit: int = 10, db: Session = Depends(get_db)):
    return market.top_categories(db, limit)


@router.get("/growth")
def growth(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    return market.growth(db, product_groups)


@router.get("/sov-trend")
def sov_trend(product_groups: list[str] | None = Query(None), top_n: int = 5, db: Session = Depends(get_db)):
    return market.sov_trend(db, product_groups, top_n)


# --- charts ---------------------------------------------------------------
@router.get("/charts/top-categories.png")
def chart_top_categories(limit: int = 10, db: Session = Depends(get_db)):
    data = market.top_categories(db, limit)
    png = charts.bar_chart([d["category"] for d in data], [d["spend"] for d in data],
                           title="", money=True, single_color=True)
    return Response(png, media_type="image/png")


@router.get("/charts/trend.png")
def chart_trend(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    data = market.market_trend(db, product_groups)
    png = charts.stacked_bar(data["labels"], data["series"], title="", money=True)
    return Response(png, media_type="image/png")


@router.get("/charts/sov.png")
def chart_sov(product_groups: list[str] | None = Query(None), top_n: int = 5, db: Session = Depends(get_db)):
    data = market.sov_trend(db, product_groups, top_n)
    amap = colors_svc.advertiser_colors(db)
    png = charts.line_chart(data["labels"], data["series"], title="", ylabel="% of spend",
                            colors=[amap.get(n, charts.OTHERS) for n in data["series"].keys()])
    return Response(png, media_type="image/png")


@router.get("/charts/heatmap.png")
def chart_heatmap(product_groups: list[str] | None = Query(None), top_n: int = 10, db: Session = Depends(get_db)):
    data = market.heatmap(db, product_groups, top_n)
    png = charts.heatmap(data["rows"], data["cols"], data["matrix"], title="")
    return Response(png, media_type="image/png")


@router.get("/charts/growth.png")
def chart_growth(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    g = market.growth(db, product_groups)
    movers = (g["gainers"] + g["losers"])
    movers.sort(key=lambda x: x["delta"])
    png = charts.delta_bar([m["advertiser"] for m in movers], [m["delta"] for m in movers],
                           title="")
    return Response(png, media_type="image/png")


# --- AI market read -------------------------------------------------------
@router.post("/ai-read")
def ai_read(body: dict = Body(default={}), db: Session = Depends(get_db)):
    pgs = body.get("product_groups")
    computed = {
        "overview": market.overview(db, pgs),
        "top_categories": market.top_categories(db, 6) if not pgs else None,
        "share_of_voice_trend": market.sov_trend(db, pgs, 5),
        "growth": market.growth(db, pgs),
    }
    scope = ", ".join(pgs) if pgs else "the whole market"
    q = (f"Give a sharp market read for {scope}: what is happening, who is winning and losing, "
         f"where spend is concentrating, and one clear recommendation. Base it only on the figures.")
    text = gemini.narrate(prompt_guide.get_logic(db), prompt_guide.get_format(db), q, computed)
    return {"analysis": text, "computed": computed}
