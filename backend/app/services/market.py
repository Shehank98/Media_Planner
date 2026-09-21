"""Market-overview and advanced market-movement analyses (Tab 0 / dashboard).

All figures computed in SQL/Python. Com-only for spend; V/A tracked separately.
Reuses the filter helpers from adex_analysis so the Com rule is applied
identically everywhere.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import Integer, cast, distinct, extract, func, select
from sqlalchemy.orm import Session

from ..models import AdexRow
from .adex_analysis import COM, _adv_filter, _pg_filter, _where


def _month_expr():
    return func.to_char(AdexRow.spot_date, "YYYY-MM")


# --------------------------------------------------------------------------
# Headline KPIs
# --------------------------------------------------------------------------
def overview(db: Session, product_groups=None) -> dict:
    base = _where(COM, _pg_filter(product_groups))

    total_spend = db.execute(select(func.sum(AdexRow.cost)).where(base)).scalar() or 0.0
    spots = db.execute(select(func.count()).where(base)).scalar() or 0
    advertisers = db.execute(select(func.count(distinct(AdexRow.advertiser))).where(base)).scalar() or 0
    channels = db.execute(select(func.count(distinct(AdexRow.channel))).where(base)).scalar() or 0
    categories = db.execute(
        select(func.count(distinct(AdexRow.product_group))).where(_where(COM, _pg_filter(product_groups)))
    ).scalar() or 0
    date_min, date_max = db.execute(
        select(func.min(AdexRow.spot_date), func.max(AdexRow.spot_date)).where(base)
    ).one()

    # V/A bonus (never in spend)
    va_spots, va_secs = db.execute(
        select(func.count(), func.sum(AdexRow.dur)).where(_where(AdexRow.va_com == "V/A", _pg_filter(product_groups)))
    ).one()

    # medium split
    mediums = {
        (m or "Unknown"): round(s or 0, 2)
        for m, s in db.execute(
            select(AdexRow.medium, func.sum(AdexRow.cost)).where(base).group_by(AdexRow.medium)
        ).all()
    }

    # leading category / advertiser
    top_cat = db.execute(
        select(AdexRow.product_group, func.sum(AdexRow.cost)).where(base)
        .group_by(AdexRow.product_group).order_by(func.sum(AdexRow.cost).desc()).limit(1)
    ).first()
    top_adv = db.execute(
        select(AdexRow.advertiser, func.sum(AdexRow.cost)).where(base)
        .group_by(AdexRow.advertiser).order_by(func.sum(AdexRow.cost).desc()).limit(1)
    ).first()

    return {
        "total_spend": round(total_spend, 2),
        "spots": spots,
        "advertisers": advertisers,
        "channels": channels,
        "categories": categories,
        "date_from": date_min.isoformat() if date_min else None,
        "date_to": date_max.isoformat() if date_max else None,
        "va_spots": va_spots or 0,
        "va_seconds": round(va_secs or 0, 1),
        "medium_split": mediums,
        "top_category": {"name": top_cat[0], "spend": round(top_cat[1] or 0, 2)} if top_cat else None,
        "top_advertiser": {"name": top_adv[0], "spend": round(top_adv[1] or 0, 2)} if top_adv else None,
    }


def top_categories(db: Session, limit=10) -> list[dict]:
    total = db.execute(select(func.sum(AdexRow.cost)).where(_where(COM))).scalar() or 0.0
    rows = db.execute(
        select(AdexRow.product_group, func.sum(AdexRow.cost), func.count(distinct(AdexRow.advertiser)))
        .where(_where(COM)).group_by(AdexRow.product_group)
        .order_by(func.sum(AdexRow.cost).desc()).limit(limit)
    ).all()
    return [
        {"category": c or "Unknown", "spend": round(s or 0, 2),
         "advertisers": n, "share_pct": round(100 * (s or 0) / total, 1) if total else 0.0}
        for c, s, n in rows
    ]


def monthly_total(db: Session, product_groups=None) -> dict:
    """Total Com spend per month (for KPI sparklines)."""
    month = _month_expr()
    rows = db.execute(
        select(month, func.sum(AdexRow.cost))
        .where(_where(COM, AdexRow.spot_date.isnot(None), _pg_filter(product_groups)))
        .group_by(month).order_by(month)
    ).all()
    return {"labels": [r[0] for r in rows], "values": [round(r[1] or 0, 2) for r in rows]}


def market_trend(db: Session, product_groups=None) -> dict:
    """Total market spend by month, split by medium (for a stacked view)."""
    month = _month_expr()
    rows = db.execute(
        select(month, AdexRow.medium, func.sum(AdexRow.cost))
        .where(_where(COM, AdexRow.spot_date.isnot(None), _pg_filter(product_groups)))
        .group_by(month, AdexRow.medium).order_by(month)
    ).all()
    labels: list[str] = []
    series: dict[str, dict[str, float]] = {}
    for mo, medium, spend in rows:
        if mo not in labels:
            labels.append(mo)
        series.setdefault(medium or "Unknown", {})[mo] = round(spend or 0, 2)
    labels = sorted(set(labels))
    return {"labels": labels, "series": {k: [v.get(l, 0) for l in labels] for k, v in series.items()}}


# --------------------------------------------------------------------------
# Share of Voice over time (top-N advertisers, % of category spend per month)
# --------------------------------------------------------------------------
def sov_trend(db: Session, product_groups=None, top_n=5) -> dict:
    month = _month_expr()
    # top-N advertisers overall
    top = [
        a for (a,) in db.execute(
            select(AdexRow.advertiser).where(_where(COM, _pg_filter(product_groups)))
            .group_by(AdexRow.advertiser).order_by(func.sum(AdexRow.cost).desc()).limit(top_n)
        ).all() if a
    ]
    if not top:
        return {"labels": [], "series": {}}

    # month totals
    totals = {
        mo: (s or 0.0) for mo, s in db.execute(
            select(month, func.sum(AdexRow.cost))
            .where(_where(COM, AdexRow.spot_date.isnot(None), _pg_filter(product_groups)))
            .group_by(month)
        ).all()
    }
    # per-advertiser per-month
    rows = db.execute(
        select(month, AdexRow.advertiser, func.sum(AdexRow.cost))
        .where(_where(COM, AdexRow.spot_date.isnot(None), AdexRow.advertiser.in_(top), _pg_filter(product_groups)))
        .group_by(month, AdexRow.advertiser)
    ).all()
    labels = sorted(totals.keys())
    series: dict[str, dict[str, float]] = {a: {} for a in top}
    for mo, adv, spend in rows:
        tot = totals.get(mo) or 0
        series[adv][mo] = round(100 * (spend or 0) / tot, 2) if tot else 0.0
    return {"labels": labels, "series": {a: [series[a].get(l, 0) for l in labels] for a in top}}


# --------------------------------------------------------------------------
# Growth: first half vs second half of the date range, per advertiser
# --------------------------------------------------------------------------
def growth(db: Session, product_groups=None, limit=6) -> dict:
    date_min, date_max = db.execute(
        select(func.min(AdexRow.spot_date), func.max(AdexRow.spot_date))
        .where(_where(COM, _pg_filter(product_groups)))
    ).one()
    if not date_min or not date_max or date_min == date_max:
        return {"gainers": [], "losers": [], "new_entrants": [], "period": None}

    mid = date_min + (date_max - date_min) / 2

    def _spend_by_adv(lo, hi):
        rows = db.execute(
            select(AdexRow.advertiser, func.sum(AdexRow.cost))
            .where(_where(COM, _pg_filter(product_groups), AdexRow.spot_date >= lo, AdexRow.spot_date < hi))
            .group_by(AdexRow.advertiser)
        ).all()
        return {a: (s or 0.0) for a, s in rows if a}

    # include the final day in the second half
    first = _spend_by_adv(date_min, mid)
    second = _spend_by_adv(mid, date_max + dt.timedelta(days=1))

    changes = []
    new_entrants = []
    for adv in set(first) | set(second):
        a = first.get(adv, 0.0)
        b = second.get(adv, 0.0)
        delta = b - a
        pct = (100 * delta / a) if a else None
        if a == 0 and b > 0:
            new_entrants.append({"advertiser": adv, "spend": round(b, 2)})
        changes.append({"advertiser": adv, "before": round(a, 2), "after": round(b, 2),
                        "delta": round(delta, 2), "pct": round(pct, 1) if pct is not None else None})

    changes.sort(key=lambda x: x["delta"], reverse=True)
    gainers = [c for c in changes if c["delta"] > 0][:limit]
    losers = [c for c in changes if c["delta"] < 0][-limit:][::-1]
    new_entrants.sort(key=lambda x: x["spend"], reverse=True)
    return {
        "gainers": gainers,
        "losers": losers,
        "new_entrants": new_entrants[:limit],
        "period": {"from": date_min.isoformat(), "mid": mid.isoformat(), "to": date_max.isoformat()},
    }


# --------------------------------------------------------------------------
# Heatmap: top-N advertisers x month spend matrix
# --------------------------------------------------------------------------
def heatmap(db: Session, product_groups=None, top_n=10) -> dict:
    month = _month_expr()
    top = [
        a for (a,) in db.execute(
            select(AdexRow.advertiser).where(_where(COM, _pg_filter(product_groups)))
            .group_by(AdexRow.advertiser).order_by(func.sum(AdexRow.cost).desc()).limit(top_n)
        ).all() if a
    ]
    if not top:
        return {"rows": [], "cols": [], "matrix": []}
    data = db.execute(
        select(AdexRow.advertiser, month, func.sum(AdexRow.cost))
        .where(_where(COM, AdexRow.spot_date.isnot(None), AdexRow.advertiser.in_(top), _pg_filter(product_groups)))
        .group_by(AdexRow.advertiser, month)
    ).all()
    cols = sorted({mo for _, mo, _ in data})
    lookup = {(a, mo): (s or 0.0) for a, mo, s in data}
    matrix = [[round(lookup.get((a, mo), 0.0), 2) for mo in cols] for a in top]
    return {"rows": top, "cols": cols, "matrix": matrix}
