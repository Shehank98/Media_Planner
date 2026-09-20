"""Tab 1 (category / pitch) and Tab 3 (channel-first) analysis.

ALL numbers here are computed in SQL/Python - never by the LLM.

Critical business rule: V/A rows are bonus airtime, NOT paid spend. Every
spend/cost aggregation filters `va_com = 'Com'`. V/A is tracked separately
only as a 'bonus value received' metric for the narrative.
"""
from __future__ import annotations

from sqlalchemy import Integer, and_, cast, distinct, extract, func, select
from sqlalchemy.orm import Session

from ..models import AdexRow

COM = AdexRow.va_com == "Com"


def _pg_filter(product_groups: list[str] | None):
    if product_groups:
        return AdexRow.product_group.in_(product_groups)
    return None


def _adv_filter(advertisers: list[str] | None):
    if advertisers:
        return AdexRow.advertiser.in_(advertisers)
    return None


def _where(*conds):
    return and_(*[c for c in conds if c is not None])


# --------------------------------------------------------------------------
# Selection helpers
# --------------------------------------------------------------------------
def product_groups(db: Session) -> list[str]:
    rows = db.execute(
        select(distinct(AdexRow.product_group)).where(AdexRow.product_group.isnot(None))
    ).scalars().all()
    return sorted(r for r in rows if r)


def advertisers(db: Session, product_groups: list[str] | None) -> list[str]:
    stmt = select(distinct(AdexRow.advertiser)).where(
        _where(AdexRow.advertiser.isnot(None), _pg_filter(product_groups))
    )
    return sorted(r for r in db.execute(stmt).scalars().all() if r)


# --------------------------------------------------------------------------
# Core analyses
# --------------------------------------------------------------------------
def medium_split(db: Session, product_groups=None, advertisers=None) -> list[dict]:
    stmt = (
        select(AdexRow.medium, func.sum(AdexRow.cost), func.count())
        .where(_where(COM, _pg_filter(product_groups), _adv_filter(advertisers)))
        .group_by(AdexRow.medium)
        .order_by(func.sum(AdexRow.cost).desc())
    )
    return [
        {"medium": m or "Unknown", "spend": round(s or 0, 2), "spots": n}
        for m, s, n in db.execute(stmt).all()
    ]


def spend_trend(db: Session, product_groups=None, advertisers=None, by="month") -> dict:
    """Return {'labels': [...], 'series': {seriesname: [...]}}.

    Grouped by advertiser when advertisers are selected (competitor lines),
    otherwise a single 'Category' line.
    """
    y = cast(extract("year", AdexRow.spot_date), Integer).label("y")
    m = cast(extract("month", AdexRow.spot_date), Integer).label("m")

    group_by_adv = bool(advertisers) and len(advertisers) > 1
    cols = [y]
    if by == "month":
        cols.append(m)
    series_key = AdexRow.advertiser if group_by_adv else None
    if series_key is not None:
        cols.append(series_key)
    cols.append(func.sum(AdexRow.cost))

    stmt = (
        select(*cols)
        .where(_where(COM, AdexRow.spot_date.isnot(None), _pg_filter(product_groups), _adv_filter(advertisers)))
        .group_by(*[c for c in cols[:-1]])
        .order_by(y, *( [m] if by == "month" else [] ))
    )
    rows = db.execute(stmt).all()

    labels: list[str] = []
    series: dict[str, dict[str, float]] = {}
    for row in rows:
        yr = row[0]
        if by == "month":
            mn = row[1]
            label = f"{int(yr)}-{int(mn):02d}"
            rest = row[2:]
        else:
            label = str(int(yr))
            rest = row[1:]
        if label not in labels:
            labels.append(label)
        if group_by_adv:
            name = rest[0] or "Unknown"
            spend = rest[1]
        else:
            name = "Category"
            spend = rest[0]
        series.setdefault(name, {})[label] = round(spend or 0, 2)

    labels = sorted(set(labels))
    out_series = {name: [vals.get(lbl, 0) for lbl in labels] for name, vals in series.items()}
    return {"labels": labels, "series": out_series}


def top_advertisers(db: Session, product_groups=None, limit=10) -> list[dict]:
    stmt = (
        select(AdexRow.advertiser, func.sum(AdexRow.cost), func.count())
        .where(_where(COM, _pg_filter(product_groups)))
        .group_by(AdexRow.advertiser)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(limit)
    )
    return [
        {"advertiser": a or "Unknown", "spend": round(s or 0, 2), "spots": n}
        for a, s, n in db.execute(stmt).all()
    ]


def share_of_spend(db: Session, product_groups=None, medium=None, limit=5) -> list[dict]:
    """Top-N Share of Spend/Voice by advertiser for a category, optionally
    restricted to a medium (TV/Radio/Press)."""
    conds = [COM, _pg_filter(product_groups)]
    if medium:
        conds.append(AdexRow.medium == medium)
    total = db.execute(select(func.sum(AdexRow.cost)).where(_where(*conds))).scalar() or 0.0

    stmt = (
        select(AdexRow.advertiser, func.sum(AdexRow.cost))
        .where(_where(*conds))
        .group_by(AdexRow.advertiser)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(limit)
    )
    out = []
    for a, s in db.execute(stmt).all():
        spend = s or 0.0
        out.append(
            {
                "advertiser": a or "Unknown",
                "spend": round(spend, 2),
                "share_pct": round(100 * spend / total, 2) if total else 0.0,
            }
        )
    return out


def advertiser_channels(db: Session, product_groups, advertiser: str, limit=5) -> list[dict]:
    stmt = (
        select(AdexRow.channel, func.sum(AdexRow.cost), func.count())
        .where(_where(COM, _pg_filter(product_groups), AdexRow.advertiser == advertiser))
        .group_by(AdexRow.channel).order_by(func.sum(AdexRow.cost).desc()).limit(limit)
    )
    return [{"channel": c or "Unknown", "spend": round(s or 0, 2), "spots": n} for c, s, n in db.execute(stmt).all()]


def advertiser_programmes(db: Session, product_groups, advertiser: str, limit=5) -> list[dict]:
    stmt = (
        select(AdexRow.program, func.sum(AdexRow.cost), func.count())
        .where(_where(COM, _pg_filter(product_groups), AdexRow.advertiser == advertiser))
        .group_by(AdexRow.program).order_by(func.sum(AdexRow.cost).desc()).limit(limit)
    )
    return [{"programme": p or "Unknown", "spend": round(s or 0, 2), "spots": n} for p, s, n in db.execute(stmt).all()]


def category_channels(db: Session, product_groups=None, limit=10) -> list[dict]:
    stmt = (
        select(AdexRow.channel, func.sum(AdexRow.cost), func.count(distinct(AdexRow.advertiser)))
        .where(_where(COM, _pg_filter(product_groups)))
        .group_by(AdexRow.channel).order_by(func.sum(AdexRow.cost).desc()).limit(limit)
    )
    return [{"channel": c or "Unknown", "spend": round(s or 0, 2), "advertisers": n} for c, s, n in db.execute(stmt).all()]


def benchmark(db: Session, product_groups, advertisers: list[str]) -> list[dict]:
    """Per-advertiser comparison row: total spend, top medium, top channel,
    top programme, and medium mix."""
    out = []
    for adv in advertisers:
        ms = medium_split(db, product_groups, [adv])
        chans = advertiser_channels(db, product_groups, adv, 1)
        progs = advertiser_programmes(db, product_groups, adv, 1)
        total = round(sum(m["spend"] for m in ms), 2)
        out.append({
            "advertiser": adv,
            "spend": total,
            "top_medium": ms[0]["medium"] if ms else None,
            "top_channel": chans[0]["channel"] if chans else None,
            "top_programme": progs[0]["programme"] if progs else None,
            "medium_mix": {m["medium"]: m["spend"] for m in ms},
        })
    out.sort(key=lambda x: x["spend"], reverse=True)
    return out


def channel_analysis(db: Session, channel: str, product_groups=None, top=10) -> dict:
    """Within a category, who spends most on a channel and on which programmes."""
    base = [COM, AdexRow.channel == channel, _pg_filter(product_groups)]

    adv_stmt = (
        select(AdexRow.advertiser, func.sum(AdexRow.cost))
        .where(_where(*base))
        .group_by(AdexRow.advertiser)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(top)
    )
    top_spenders = [{"advertiser": a or "Unknown", "spend": round(s or 0, 2)} for a, s in db.execute(adv_stmt).all()]

    prog_stmt = (
        select(AdexRow.program, func.sum(AdexRow.cost), func.count())
        .where(_where(*base))
        .group_by(AdexRow.program)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(top)
    )
    top_programmes = [
        {"programme": p or "Unknown", "spend": round(s or 0, 2), "spots": n}
        for p, s, n in db.execute(prog_stmt).all()
    ]
    return {"channel": channel, "top_spenders": top_spenders, "top_programmes": top_programmes}


def competitor_view(db: Session, product_groups, lead_advertiser: str) -> dict:
    """Compare the lead advertiser against others in the same category(ies):
    spend, channel mix, programme mix."""
    others = [a for a in advertisers(db, product_groups) if a != lead_advertiser]

    def _channel_mix(adv):
        stmt = (
            select(AdexRow.channel, func.sum(AdexRow.cost))
            .where(_where(COM, _pg_filter(product_groups), AdexRow.advertiser == adv))
            .group_by(AdexRow.channel)
            .order_by(func.sum(AdexRow.cost).desc())
            .limit(8)
        )
        return [{"channel": c or "Unknown", "spend": round(s or 0, 2)} for c, s in db.execute(stmt).all()]

    def _total(adv):
        return round(
            db.execute(
                select(func.sum(AdexRow.cost)).where(
                    _where(COM, _pg_filter(product_groups), AdexRow.advertiser == adv)
                )
            ).scalar() or 0.0, 2
        )

    return {
        "lead": {"advertiser": lead_advertiser, "spend": _total(lead_advertiser), "channel_mix": _channel_mix(lead_advertiser)},
        "competitors": [
            {"advertiser": a, "spend": _total(a), "channel_mix": _channel_mix(a)} for a in others[:6]
        ],
    }


def value_addition(db: Session, product_groups=None, advertisers=None) -> dict:
    """Bonus airtime received (V/A rows) - tracked separately, never in spend."""
    stmt = select(func.count(), func.sum(AdexRow.dur)).where(
        _where(AdexRow.va_com == "V/A", _pg_filter(product_groups), _adv_filter(advertisers))
    )
    n, secs = db.execute(stmt).one()
    return {"va_spots": n or 0, "va_seconds": round(secs or 0, 1)}


# --------------------------------------------------------------------------
# Tab 3: channel-first drill-down (same dataset, different entry point)
# --------------------------------------------------------------------------
def channels(db: Session) -> list[str]:
    rows = db.execute(select(distinct(AdexRow.channel)).where(AdexRow.channel.isnot(None))).scalars().all()
    return sorted(r for r in rows if r)


def channel_first(db: Session, channel: str, top=15) -> dict:
    """Channel -> top advertisers on that channel -> their top programmes.
    Com-only. This is Tab 3."""
    base = [COM, AdexRow.channel == channel]

    adv_stmt = (
        select(AdexRow.advertiser, AdexRow.product_group, func.sum(AdexRow.cost), func.count())
        .where(_where(*base))
        .group_by(AdexRow.advertiser, AdexRow.product_group)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(top)
    )
    advertisers_on = [
        {"advertiser": a or "Unknown", "product_group": pg, "spend": round(s or 0, 2), "spots": n}
        for a, pg, s, n in db.execute(adv_stmt).all()
    ]

    prog_stmt = (
        select(AdexRow.program, func.sum(AdexRow.cost), func.count())
        .where(_where(*base))
        .group_by(AdexRow.program)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(top)
    )
    programmes_on = [
        {"programme": p or "Unknown", "spend": round(s or 0, 2), "spots": n}
        for p, s, n in db.execute(prog_stmt).all()
    ]
    return {"channel": channel, "advertisers": advertisers_on, "programmes": programmes_on}


def advertiser_on_channel(db: Session, channel: str, advertiser: str, top=15) -> list[dict]:
    stmt = (
        select(AdexRow.program, func.sum(AdexRow.cost), func.count())
        .where(_where(COM, AdexRow.channel == channel, AdexRow.advertiser == advertiser))
        .group_by(AdexRow.program)
        .order_by(func.sum(AdexRow.cost).desc())
        .limit(top)
    )
    return [
        {"programme": p or "Unknown", "spend": round(s or 0, 2), "spots": n}
        for p, s, n in db.execute(stmt).all()
    ]
