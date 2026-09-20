"""Tab 2: channel basket & programme selection.

CPRP = rate_30s_equivalent / TVR   (TVR from the TVR-data upload, NOT the rate
card's own reference Rating column). The raw rate + duration are always returned
alongside so the normalisation basis is visible, never hidden.
"""
from __future__ import annotations

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from ..models import TvrRow
from . import rate_cards, settings_store

RANK_METRICS = {"tvr": TvrRow.tvr, "tvr_share_pct": TvrRow.tvr_share_pct, "reach_pct": TvrRow.reach_pct}


def channels(db: Session) -> list[str]:
    rows = db.execute(select(TvrRow.channel).where(TvrRow.channel.isnot(None)).distinct()).scalars().all()
    return sorted(r for r in rows if r)


def best_programmes(
    db: Session,
    channel: str | None = None,
    slot: str | None = None,  # 'PT' | 'NPT' | None
    metric: str = "tvr",
    limit: int = 25,
) -> list[dict]:
    """Rank programmes by the chosen metric, averaging the metric across the
    dates each programme aired, and attach CPRP from the rate card store."""
    order_col = RANK_METRICS.get(metric, TvrRow.tvr)
    conds = []
    if channel:
        conds.append(TvrRow.channel == channel)
    if slot:
        conds.append(TvrRow.prime_non_prime == slot)

    stmt = (
        select(
            TvrRow.channel,
            TvrRow.program,
            TvrRow.prime_non_prime,
            func.avg(TvrRow.tvr),
            func.avg(TvrRow.tvr_share_pct),
            func.avg(TvrRow.reach),
            func.avg(TvrRow.reach_pct),
            func.max(TvrRow.spot_date),
            func.count(),
        )
        .where(and_(*conds) if conds else True)
        .group_by(TvrRow.channel, TvrRow.program, TvrRow.prime_non_prime)
        .order_by(func.avg(order_col).desc().nullslast())
        .limit(limit)
    )

    out = []
    for ch, prog, pnp, tvr, share, reach, reach_pct, last_date, n in db.execute(stmt).all():
        tvr = round(tvr, 3) if tvr is not None else None
        rate, rate_source = rate_cards.lookup_rate(db, ch, prog, last_date, pnp)
        cprp = None
        rate_30s = raw_rate = duration = None
        if rate:
            rate_30s = rate.rate_30s_equivalent
            raw_rate = rate.rack_rate
            duration = rate.rate_duration_secs
            if rate_30s and tvr:
                cprp = round(rate_30s / tvr, 2)
        out.append(
            {
                "channel": ch,
                "programme": prog,
                "slot": pnp,
                "avg_tvr": tvr,
                "avg_tvr_share_pct": round(share, 2) if share is not None else None,
                "avg_reach": round(reach, 1) if reach is not None else None,
                "avg_reach_pct": round(reach_pct, 2) if reach_pct is not None else None,
                "airings": n,
                "rate_30s_equivalent": rate_30s,
                "raw_rate": raw_rate,
                "rate_duration_secs": duration,
                "rate_source": rate_source,
                "cprp": cprp,
            }
        )
    return out


def build_basket(db: Session, selections: list[dict]) -> dict:
    """selections: [{channel, programme}]. Returns per-line detail plus
    combined total TVR, total reach, blended CPRP and total cost."""
    lines = []
    total_tvr = 0.0
    total_reach = 0.0
    total_cost = 0.0
    for sel in selections:
        ch = sel.get("channel")
        prog = sel.get("programme")
        row = db.execute(
            select(
                func.avg(TvrRow.tvr),
                func.avg(TvrRow.reach),
                func.avg(TvrRow.reach_pct),
                TvrRow.prime_non_prime,
                func.max(TvrRow.spot_date),
            )
            .where(and_(TvrRow.channel == ch, TvrRow.program == prog))
            .group_by(TvrRow.prime_non_prime)
        ).first()
        if not row:
            continue
        tvr, reach, reach_pct, pnp, last_date = row
        tvr = round(tvr or 0, 3)
        reach = round(reach or 0, 1)
        rate, _ = rate_cards.lookup_rate(db, ch, prog, last_date, pnp)
        cost = rate.rate_30s_equivalent if rate and rate.rate_30s_equivalent else None
        cprp = round(cost / tvr, 2) if cost and tvr else None

        lines.append(
            {
                "channel": ch,
                "programme": prog,
                "slot": pnp,
                "tvr": tvr,
                "reach": reach,
                "reach_pct": round(reach_pct or 0, 2),
                "rate_30s_equivalent": cost,
                "cprp": cprp,
            }
        )
        total_tvr += tvr
        total_reach += reach
        if cost:
            total_cost += cost

    blended_cprp = round(total_cost / total_tvr, 2) if total_tvr and total_cost else None
    return {
        "lines": lines,
        "totals": {
            "total_tvr": round(total_tvr, 3),
            "total_reach": round(total_reach, 1),
            "total_cost": round(total_cost, 2),
            "blended_cprp": blended_cprp,
        },
    }
