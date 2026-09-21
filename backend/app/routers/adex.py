"""Tab 1: category / pitch analysis endpoints (+ shared batch admin)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from .. import charts
from ..database import get_db
from ..llm import gemini, prompt_guide
from ..services import adex_analysis, colors as colors_svc, ingest, market, report

router = APIRouter(prefix="/api/tab1", tags=["tab1-category"])


@router.get("/product-groups")
def product_groups(db: Session = Depends(get_db)):
    return adex_analysis.product_groups(db)


@router.get("/advertisers")
def advertisers(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    return adex_analysis.advertisers(db, product_groups)


@router.get("/medium-split")
def medium_split(
    product_groups: list[str] | None = Query(None),
    advertisers: list[str] | None = Query(None),
    db: Session = Depends(get_db),
):
    return adex_analysis.medium_split(db, product_groups, advertisers)


@router.get("/trend")
def trend(
    product_groups: list[str] | None = Query(None),
    advertisers: list[str] | None = Query(None),
    by: str = Query("month", pattern="^(month|year)$"),
    db: Session = Depends(get_db),
):
    return adex_analysis.spend_trend(db, product_groups, advertisers, by)


@router.get("/top-advertisers")
def top_advertisers(product_groups: list[str] | None = Query(None), limit: int = 10, db: Session = Depends(get_db)):
    return adex_analysis.top_advertisers(db, product_groups, limit)


@router.get("/sos")
def share_of_spend(
    product_groups: list[str] | None = Query(None),
    medium: str | None = None,
    limit: int = 5,
    db: Session = Depends(get_db),
):
    return adex_analysis.share_of_spend(db, product_groups, medium, limit)


@router.get("/channel-analysis")
def channel_analysis(
    channel: str,
    product_groups: list[str] | None = Query(None),
    db: Session = Depends(get_db),
):
    return adex_analysis.channel_analysis(db, channel, product_groups)


@router.get("/competitor")
def competitor(
    lead_advertiser: str,
    product_groups: list[str] | None = Query(None),
    db: Session = Depends(get_db),
):
    return adex_analysis.competitor_view(db, product_groups, lead_advertiser)


@router.get("/value-addition")
def value_addition(
    product_groups: list[str] | None = Query(None),
    advertisers: list[str] | None = Query(None),
    db: Session = Depends(get_db),
):
    return adex_analysis.value_addition(db, product_groups, advertisers)


@router.get("/advertiser-comparison")
def advertiser_comparison(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    return {
        "comparison": adex_analysis.advertiser_comparison(db, product_groups),
        "yearly": adex_analysis.yearly_by_advertiser(db, product_groups),
    }


@router.get("/charts/yearly-comparison.png")
def chart_yearly(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    data = adex_analysis.yearly_by_advertiser(db, product_groups, top_n=6)
    amap = colors_svc.advertiser_colors(db)
    png = charts.grouped_bar(data["labels"], data["series"], title="", money=True,
                             colors=[amap.get(n, charts.OTHERS) for n in data["series"].keys()])
    return Response(png, media_type="image/png")


# --- Charts (server-side PNG) ---------------------------------------------
@router.get("/charts/medium-split.png")
def chart_medium(product_groups: list[str] | None = Query(None), advertisers: list[str] | None = Query(None), db: Session = Depends(get_db)):
    data = adex_analysis.medium_split(db, product_groups, advertisers)
    png = charts.bar_chart([d["medium"] for d in data], [d["spend"] for d in data], title="", money=True, color_kind="medium")
    return Response(png, media_type="image/png")


@router.get("/charts/trend.png")
def chart_trend(product_groups: list[str] | None = Query(None), advertisers: list[str] | None = Query(None), by: str = "month", db: Session = Depends(get_db)):
    data = adex_analysis.spend_trend(db, product_groups, advertisers, by)
    png = charts.line_chart(data["labels"], data["series"], title="", money=True, area=True)
    return Response(png, media_type="image/png")


@router.get("/charts/sos.png")
def chart_sos(product_groups: list[str] | None = Query(None), medium: str | None = None, db: Session = Depends(get_db)):
    data = adex_analysis.share_of_spend(db, product_groups, medium, limit=5)
    names = [d["advertiser"] for d in data]
    png = charts.pie_chart(names, [d["share_pct"] for d in data], title="",
                           colors=colors_svc.color_list(colors_svc.advertiser_colors(db), names))
    return Response(png, media_type="image/png")


@router.get("/charts/top-advertisers.png")
def chart_top_adv(product_groups: list[str] | None = Query(None), db: Session = Depends(get_db)):
    data = adex_analysis.top_advertisers(db, product_groups, limit=10)
    names = [d["advertiser"] for d in data]
    png = charts.bar_chart(names, [d["spend"] for d in data], title="", money=True,
                           colors=colors_svc.color_list(colors_svc.advertiser_colors(db), names))
    return Response(png, media_type="image/png")


# --- Ad-hoc narrative (Gemini narrates a pre-computed pivot) ---------------
@router.post("/narrate")
def narrate(body: dict = Body(...), db: Session = Depends(get_db)):
    question = body.get("question", "")
    pgs = body.get("product_groups")
    advs = body.get("advertisers")
    computed = {
        "medium_split": adex_analysis.medium_split(db, pgs, advs),
        "trend": adex_analysis.spend_trend(db, pgs, advs, "month"),
        "top_advertisers": adex_analysis.top_advertisers(db, pgs, limit=8),
        "value_addition": adex_analysis.value_addition(db, pgs, advs),
    }
    text = gemini.narrate(prompt_guide.get_logic(db), prompt_guide.get_format(db), question, computed)
    return {"narrative": text, "computed": computed}


# --- Category research (Gemini + Google Search grounding + internal data) --
@router.post("/category-research")
def category_research(body: dict = Body(...), db: Session = Depends(get_db)):
    pgs = body.get("product_groups") or None
    advs = body.get("advertisers") or None
    category = (body.get("category") or (", ".join(pgs) if pgs else "")).strip()
    if not category:
        raise HTTPException(400, "category is required")

    # Blend in the client's own computed spend figures for the selection.
    internal = None
    if pgs:
        ov = market.overview(db, pgs)
        internal = {
            "category": pgs,
            "selected_advertisers": advs or "all in category",
            "date_range": [ov["date_from"], ov["date_to"]],
            "total_com_spend": ov["total_spend"],
            "advertisers_count": ov["advertisers"],
            "channels_count": ov["channels"],
            "medium_split": adex_analysis.medium_split(db, pgs, advs),
            "top_advertisers": adex_analysis.top_advertisers(db, pgs, limit=8),
            "share_of_spend_tv": adex_analysis.share_of_spend(db, pgs, medium="TV", limit=5),
            "monthly_trend": adex_analysis.spend_trend(db, pgs, advs, "month"),
            "value_addition": adex_analysis.value_addition(db, pgs, advs),
        }
    try:
        return gemini.category_research(category, body.get("region", ""), body.get("time_frame", ""), internal)
    except gemini.GeminiUnavailable as exc:
        raise HTTPException(503, str(exc))


# --- Report export --------------------------------------------------------
@router.get("/report/preview", response_class=HTMLResponse)
def report_preview(
    product_groups: list[str] = Query(...),
    lead_advertiser: str | None = None,
    include_research: bool = False,
    db: Session = Depends(get_db),
):
    if not product_groups:
        raise HTTPException(400, "product_groups is required")
    return HTMLResponse(report.build_html(db, product_groups, lead_advertiser, include_research))


@router.post("/report")
def report_export(body: dict = Body(...), db: Session = Depends(get_db)):
    pgs = body.get("product_groups") or []
    lead = body.get("lead_advertiser")
    research = bool(body.get("include_research"))
    fmt = (body.get("format") or "pdf").lower()
    if not pgs:
        raise HTTPException(400, "product_groups is required")
    if fmt == "docx":
        data = report.build_docx(db, pgs, lead, research)
        return Response(
            data,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": "attachment; filename=pitch-report.docx"},
        )
    data = report.build_pdf(db, pgs, lead, research)
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": "attachment; filename=pitch-report.pdf"})


# --- Batch admin ----------------------------------------------------------
@router.get("/batches")
def batches(db: Session = Depends(get_db)):
    return ingest.list_batches(db, "adex")


@router.delete("/batches")
def wipe_batches(db: Session = Depends(get_db)):
    """Wipe every adex dataset (all rows, batches, jobs, staged files)."""
    return ingest.wipe_kind(db, "adex")


@router.delete("/batches/{batch_id}")
def delete_batch(batch_id: str, db: Session = Depends(get_db)):
    n = ingest.delete_batch(db, "adex", batch_id)
    if n == 0:
        raise HTTPException(404, "batch not found")
    return {"deleted_rows": n}
