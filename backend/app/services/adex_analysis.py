"""Tab 1 (category / pitch) and Tab 3 (channel-first) analysis.

ALL numbers here are computed in SQL/Python - never by the LLM.

Critical business rule: V/A rows are bonus airtime, NOT paid spend. Every
spend/cost aggregation filters `va_com = 'Com'`. V/A is tracked separately
only as a 'bonus value received' metric for the narrative.
"""
from __future__ import annotations

import contextlib
import contextvars
import datetime as dt

from sqlalchemy import Integer, and_, case, cast, distinct, extract, func, select
from sqlalchemy.orm import Session

from ..models import AdexRow

COM = AdexRow.va_com == "Com"

_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def fiscal_bounds(year: int, start_month: int = 1) -> tuple[dt.date, dt.date]:
    """[from, to) date range for reporting `year`. With start_month=1 this is
    the calendar year; with start_month=4 it is Apr `year` to Mar `year`+1."""
    return dt.date(year, start_month, 1), dt.date(year + 1, start_month, 1)


def fiscal_year_expr(start_month: int = 1):
    """SQL expression giving the reporting year a spot_date belongs to."""
    y = cast(extract("year", AdexRow.spot_date), Integer)
    if start_month == 1:
        return y
    m = cast(extract("month", AdexRow.spot_date), Integer)
    return y - case((m < start_month, 1), else_=0)


def fiscal_label(year: int, start_month: int = 1) -> tuple[str, str]:
    """(short label, span text) for a reporting year, e.g. calendar -> ('2023',
    'Jan 2023 - Dec 2023'); financial (Apr) -> ('2023/24', 'Apr 2023 - Mar 2024')."""
    if start_month == 1:
        return str(year), f"Jan {year} - Dec {year}"
    end_month = start_month - 1 or 12
    return f"{year}/{str(year + 1)[-2:]}", f"{_MONTHS[start_month]} {year} - {_MONTHS[end_month]} {year + 1}"


# Optional year scope. When set (via `year_scope`), every query built through
# `_where` is transparently restricted to that reporting year (calendar or
# financial), so the whole analysis/report pipeline can be re-run for a single
# year without threading a `year` argument through dozens of functions.
_YEAR_SCOPE: contextvars.ContextVar[tuple[int, int] | None] = contextvars.ContextVar("adex_year_scope", default=None)


@contextlib.contextmanager
def year_scope(year: int | None, start_month: int = 1):
    token = _YEAR_SCOPE.set((year, start_month) if year is not None else None)
    try:
        yield
    finally:
        _YEAR_SCOPE.reset(token)


def _pg_filter(product_groups: list[str] | None):
    if product_groups:
        return AdexRow.product_group.in_(product_groups)
    return None


def _adv_filter(advertisers: list[str] | None):
    if advertisers:
        return AdexRow.advertiser.in_(advertisers)
    return None


def _where(*conds):
    scope = _YEAR_SCOPE.get()
    extra = None
    if scope is not None:
        year, start_month = scope
        lo, hi = fiscal_bounds(year, start_month)
        extra = and_(AdexRow.spot_date >= lo, AdexRow.spot_date < hi)
    return and_(*[c for c in (*conds, extra) if c is not None])


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


def category_channels_com_va(db: Session, product_groups=None, limit=12) -> list[dict]:
    """Per-channel Com (paid) spend + spots and V/A (bonus) spots + seconds for
    the selected category, ordered by Com spend. Lets the report show clearly
    how much is paid vs value addition on each channel."""
    com = {
        c: (round(s or 0, 2), n) for c, s, n in db.execute(
            select(AdexRow.channel, func.sum(AdexRow.cost), func.count())
            .where(_where(COM, _pg_filter(product_groups))).group_by(AdexRow.channel)
        ).all()
    }
    va = {
        c: (n, round(s or 0, 1)) for c, n, s in db.execute(
            select(AdexRow.channel, func.count(), func.sum(AdexRow.dur))
            .where(_where(AdexRow.va_com == "V/A", _pg_filter(product_groups))).group_by(AdexRow.channel)
        ).all()
    }
    out = [
        {
            "channel": c or "Unknown",
            "medium": None,
            "com_spend": com.get(c, (0.0, 0))[0],
            "com_spots": com.get(c, (0.0, 0))[1],
            "va_spots": va.get(c, (0, 0.0))[0],
            "va_seconds": va.get(c, (0, 0.0))[1],
        }
        for c in (set(com) | set(va))
    ]
    # attach medium for context
    med = dict(db.execute(
        select(AdexRow.channel, func.max(AdexRow.medium))
        .where(_pg_filter(product_groups)).group_by(AdexRow.channel)
    ).all())
    for r in out:
        r["medium"] = med.get(r["channel"]) if r["channel"] != "Unknown" else None
    out.sort(key=lambda x: x["com_spend"], reverse=True)
    return out[:limit]


def top_channel_advertiser_detail(db: Session, product_groups=None, top_channels=5, top_adv=15) -> dict:
    """For the top N channels (by Com spend) in the category, break down how
    every advertiser spent on each: Com (paid) spend + spots and V/A (bonus)
    spots + seconds. Returns a scannable Com-spend matrix plus per-channel
    detail rows, so the report can show 'who advertises where, paid vs bonus'.
    """
    top = category_channels_com_va(db, product_groups, limit=top_channels)
    channel_names = [c["channel"] for c in top if c["channel"] != "Unknown"]
    if not channel_names:
        return {"channels": [], "advertisers": [], "matrix": {}, "detail": {}}

    ch_cond = AdexRow.channel.in_(channel_names)

    com_rows = db.execute(
        select(AdexRow.channel, AdexRow.advertiser, func.sum(AdexRow.cost), func.count())
        .where(_where(COM, ch_cond, _pg_filter(product_groups), AdexRow.advertiser.isnot(None)))
        .group_by(AdexRow.channel, AdexRow.advertiser)
    ).all()
    va_rows = db.execute(
        select(AdexRow.channel, AdexRow.advertiser, func.count(), func.sum(AdexRow.dur))
        .where(_where(AdexRow.va_com == "V/A", ch_cond, _pg_filter(product_groups), AdexRow.advertiser.isnot(None)))
        .group_by(AdexRow.channel, AdexRow.advertiser)
    ).all()

    # matrix[advertiser][channel] = {com_spend, com_spots, va_spots, va_seconds}
    matrix: dict[str, dict[str, dict]] = {}
    totals: dict[str, float] = {}

    def _cell(adv, ch):
        return matrix.setdefault(adv, {}).setdefault(
            ch, {"com_spend": 0.0, "com_spots": 0, "va_spots": 0, "va_seconds": 0.0}
        )

    for ch, adv, spend, spots in com_rows:
        cell = _cell(adv, ch)
        cell["com_spend"] = round(spend or 0, 2)
        cell["com_spots"] = spots or 0
        totals[adv] = totals.get(adv, 0.0) + (spend or 0.0)
    for ch, adv, spots, secs in va_rows:
        cell = _cell(adv, ch)
        cell["va_spots"] = spots or 0
        cell["va_seconds"] = round(secs or 0, 1)
        totals.setdefault(adv, 0.0)

    advertisers = sorted(totals, key=lambda a: totals[a], reverse=True)[:top_adv]

    # Per-channel detail rows (only the kept advertisers), each channel ordered
    # by Com spend.
    detail: dict[str, list[dict]] = {}
    for ch in channel_names:
        rows = []
        for adv in advertisers:
            cell = matrix.get(adv, {}).get(ch)
            if not cell or (cell["com_spend"] == 0 and cell["com_spots"] == 0 and cell["va_spots"] == 0):
                continue
            rows.append({"advertiser": adv, **cell})
        rows.sort(key=lambda x: x["com_spend"], reverse=True)
        detail[ch] = rows

    return {
        "channels": top[:len(channel_names)],
        "advertisers": advertisers,
        "totals": {a: round(totals[a], 2) for a in advertisers},
        "matrix": {a: matrix.get(a, {}) for a in advertisers},
        "detail": detail,
    }


def advertiser_channel_breakdown(db: Session, product_groups=None, advertisers=None,
                                 top_adv=20, channels_per=12) -> list[dict]:
    """Per-advertiser page data: for each advertiser in the category, which
    channels they advertised on and how much, split into Com (paid) spend +
    spots and V/A (bonus) spots + seconds, plus their medium mix and totals.
    Ordered by total Com spend; each advertiser's channels ordered the same.
    """
    adv_cond = _adv_filter(advertisers)

    com = db.execute(
        select(AdexRow.advertiser, AdexRow.channel, func.max(AdexRow.medium),
               func.sum(AdexRow.cost), func.count(), func.sum(AdexRow.dur))
        .where(_where(COM, _pg_filter(product_groups), adv_cond, AdexRow.advertiser.isnot(None)))
        .group_by(AdexRow.advertiser, AdexRow.channel)
    ).all()
    va = db.execute(
        select(AdexRow.advertiser, AdexRow.channel, func.count(), func.sum(AdexRow.dur))
        .where(_where(AdexRow.va_com == "V/A", _pg_filter(product_groups), adv_cond, AdexRow.advertiser.isnot(None)))
        .group_by(AdexRow.advertiser, AdexRow.channel)
    ).all()

    # advertiser -> channel -> cell
    book: dict[str, dict[str, dict]] = {}

    def _cell(adv, ch, medium=None):
        cells = book.setdefault(adv, {})
        cell = cells.get(ch)
        if cell is None:
            cell = {"channel": ch or "Unknown", "medium": medium,
                    "com_spend": 0.0, "com_spots": 0, "va_spots": 0, "va_seconds": 0.0}
            cells[ch] = cell
        elif medium and not cell["medium"]:
            cell["medium"] = medium
        return cell

    for adv, ch, medium, spend, spots, secs in com:
        cell = _cell(adv, ch, medium)
        cell["com_spend"] = round(spend or 0, 2)
        cell["com_spots"] = spots or 0
    for adv, ch, spots, secs in va:
        cell = _cell(adv, ch)
        cell["va_spots"] = spots or 0
        cell["va_seconds"] = round(secs or 0, 1)

    out = []
    for adv, cells in book.items():
        chans = sorted(cells.values(), key=lambda x: x["com_spend"], reverse=True)
        com_spend = round(sum(c["com_spend"] for c in chans), 2)
        medium_mix: dict[str, float] = {}
        for c in chans:
            if c["com_spend"]:
                medium_mix[c["medium"] or "Other"] = round(medium_mix.get(c["medium"] or "Other", 0) + c["com_spend"], 2)
        out.append({
            "advertiser": adv,
            "com_spend": com_spend,
            "com_spots": sum(c["com_spots"] for c in chans),
            "va_spots": sum(c["va_spots"] for c in chans),
            "va_seconds": round(sum(c["va_seconds"] for c in chans), 1),
            "channels_count": len([c for c in chans if c["com_spend"] or c["com_spots"] or c["va_spots"]]),
            "medium_mix": medium_mix,
            "channels": chans[:channels_per],
        })
    out.sort(key=lambda x: x["com_spend"], reverse=True)
    return out[:top_adv]


def yearly_analysis(db: Session, product_groups=None, advertisers=None, top_adv=12, start_month=1) -> list[dict]:
    """A full breakdown per reporting year, mirroring the overall report but
    scoped to each year: total Com spend, YoY change, monthly spend, medium
    split, advertiser ranking (Com spend + share within the year), category
    split (when several categories are selected) and V/A bonus. `start_month`
    picks calendar (1) vs financial (e.g. 4 = Apr-Mar) years. Ordered oldest to
    newest. All figures are Com (paid); V/A is reported separately.
    """
    yr = fiscal_year_expr(start_month)
    mn = cast(extract("month", AdexRow.spot_date), Integer)
    com_base = _where(COM, AdexRow.spot_date.isnot(None), _pg_filter(product_groups), _adv_filter(advertisers))

    # One grouped pass per dimension, bucketed by year in Python.
    adv_rows = db.execute(
        select(yr, AdexRow.advertiser, func.sum(AdexRow.cost), func.count())
        .where(com_base).group_by(yr, AdexRow.advertiser)
    ).all()
    med_rows = db.execute(
        select(yr, AdexRow.medium, func.sum(AdexRow.cost)).where(com_base).group_by(yr, AdexRow.medium)
    ).all()
    mon_rows = db.execute(
        select(yr, mn, func.sum(AdexRow.cost)).where(com_base).group_by(yr, mn).order_by(yr, mn)
    ).all()
    cat_rows = db.execute(
        select(yr, AdexRow.product_group, func.sum(AdexRow.cost)).where(com_base).group_by(yr, AdexRow.product_group)
    ).all()
    va_rows = db.execute(
        select(yr, func.count(), func.sum(AdexRow.dur))
        .where(_where(AdexRow.va_com == "V/A", AdexRow.spot_date.isnot(None), _pg_filter(product_groups), _adv_filter(advertisers)))
        .group_by(yr)
    ).all()

    years = sorted({int(r[0]) for r in mon_rows if r[0] is not None}
                   | {int(r[0]) for r in adv_rows if r[0] is not None})
    if not years:
        return []

    by_adv: dict[int, list] = {}
    for y, a, s, n in adv_rows:
        by_adv.setdefault(int(y), []).append((a or "Unknown", round(s or 0, 2), n or 0))
    by_med: dict[int, dict] = {}
    for y, m, s in med_rows:
        by_med.setdefault(int(y), {})[m or "Other"] = round(s or 0, 2)
    by_mon: dict[int, list] = {}
    for y, m, s in mon_rows:
        by_mon.setdefault(int(y), []).append((int(m) if m else 0, round(s or 0, 2)))
    by_cat: dict[int, dict] = {}
    for y, c, s in cat_rows:
        by_cat.setdefault(int(y), {})[c or "Unknown"] = round(s or 0, 2)
    by_va = {int(y): (n or 0, round(sec or 0, 1)) for y, n, sec in va_rows}

    out = []
    prev_total = None
    for y in years:
        advs = sorted(by_adv.get(y, []), key=lambda x: x[1], reverse=True)
        total = round(sum(a[1] for a in advs), 2)
        adv_list = [{"advertiser": a, "spend": s, "spots": n,
                     "share_pct": round(100 * s / total, 1) if total else 0.0}
                    for a, s, n in advs[:top_adv]]
        med = sorted(by_med.get(y, {}).items(), key=lambda kv: kv[1], reverse=True)
        med_list = [{"medium": m, "spend": s, "share_pct": round(100 * s / total, 1) if total else 0.0}
                    for m, s in med]
        # Order months by their position within the reporting year (Apr first
        # for a financial year), and label each with its true calendar year.
        months = sorted(by_mon.get(y, []), key=lambda mo_s: (mo_s[0] - start_month) % 12)
        cal_year = lambda mo: y if mo >= start_month else y + 1
        monthly = {"labels": [f"{cal_year(mo)}-{mo:02d}" for mo, _ in months],
                   "month_names": [_MONTHS[mo] if 1 <= mo <= 12 else str(mo) for mo, _ in months],
                   "spend": [s for _, s in months]}
        cats = sorted(by_cat.get(y, {}).items(), key=lambda kv: kv[1], reverse=True)
        cat_list = [{"category": c, "spend": s, "share_pct": round(100 * s / total, 1) if total else 0.0}
                    for c, s in cats]
        va_spots, va_secs = by_va.get(y, (0, 0.0))
        yoy = round(100 * (total - prev_total) / prev_total, 1) if prev_total else None
        label, span = fiscal_label(y, start_month)
        out.append({
            "year": y,
            "label": label,
            "span": span,
            "total_spend": total,
            "yoy_pct": yoy,
            "advertisers_count": len(advs),
            "advertisers": adv_list,
            "medium_split": med_list,
            "monthly": monthly,
            "category_split": cat_list,
            "va_spots": va_spots,
            "va_seconds": va_secs,
        })
        prev_total = total
    return out


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


def advertiser_comparison(db: Session, product_groups=None, limit=15) -> list[dict]:
    """Side-by-side comparison of every advertiser in the selected category:
    Com spend, share %, TV/Radio/Press split, and V/A bonus. This is the
    'compare the 3 banks' view."""
    total = db.execute(select(func.sum(AdexRow.cost)).where(_where(COM, _pg_filter(product_groups)))).scalar() or 0.0

    # spend per advertiser + medium
    med = {}
    for a, m, s in db.execute(
        select(AdexRow.advertiser, AdexRow.medium, func.sum(AdexRow.cost))
        .where(_where(COM, _pg_filter(product_groups))).group_by(AdexRow.advertiser, AdexRow.medium)
    ).all():
        if not a:
            continue
        med.setdefault(a, {})[m or "Other"] = round(s or 0, 2)

    # spots per advertiser (Com) and V/A per advertiser
    spots = dict(db.execute(
        select(AdexRow.advertiser, func.count()).where(_where(COM, _pg_filter(product_groups))).group_by(AdexRow.advertiser)
    ).all())
    va = {a: (n, round(sec or 0, 1)) for a, n, sec in db.execute(
        select(AdexRow.advertiser, func.count(), func.sum(AdexRow.dur))
        .where(_where(AdexRow.va_com == "V/A", _pg_filter(product_groups))).group_by(AdexRow.advertiser)
    ).all() if a}

    out = []
    for a, mm in med.items():
        spend = round(sum(mm.values()), 2)
        out.append({
            "advertiser": a,
            "spend": spend,
            "share_pct": round(100 * spend / total, 1) if total else 0.0,
            "tv": mm.get("TV", 0.0),
            "radio": mm.get("Radio", 0.0),
            "press": mm.get("Press", 0.0),
            "com_spots": spots.get(a, 0),
            "va_spots": va.get(a, (0, 0))[0],
            "va_seconds": va.get(a, (0, 0))[1],
        })
    out.sort(key=lambda x: x["spend"], reverse=True)
    return out[:limit]


def yearly_by_advertiser(db: Session, product_groups=None, top_n=6) -> dict:
    """Spend by YEAR per top advertiser -> {labels:[years], series:{adv:[...]}}
    plus a flat matrix for tabular comparison."""
    y = cast(extract("year", AdexRow.spot_date), Integer)
    top = [a for (a,) in db.execute(
        select(AdexRow.advertiser).where(_where(COM, _pg_filter(product_groups)))
        .group_by(AdexRow.advertiser).order_by(func.sum(AdexRow.cost).desc()).limit(top_n)
    ).all() if a]
    if not top:
        return {"labels": [], "series": {}, "years": []}
    rows = db.execute(
        select(y, AdexRow.advertiser, func.sum(AdexRow.cost))
        .where(_where(COM, AdexRow.spot_date.isnot(None), AdexRow.advertiser.in_(top), _pg_filter(product_groups)))
        .group_by(y, AdexRow.advertiser)
    ).all()
    years = sorted({int(r[0]) for r in rows})
    series = {a: {} for a in top}
    for yr, adv, s in rows:
        series[adv][int(yr)] = round(s or 0, 2)
    labels = [str(v) for v in years]
    return {
        "labels": labels,
        "years": years,
        "series": {a: [series[a].get(v, 0) for v in years] for a in top},
    }


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


def channel_advertisers_on(db: Session) -> dict:
    """{channel: [advertisers]} used to populate the advertiser filter per channel."""
    rows = db.execute(
        select(AdexRow.channel, AdexRow.advertiser).where(
            _where(AdexRow.channel.isnot(None), AdexRow.advertiser.isnot(None))
        ).distinct()
    ).all()
    out: dict[str, set] = {}
    for ch, adv in rows:
        out.setdefault(ch, set()).add(adv)
    return {ch: sorted(advs) for ch, advs in out.items()}


def com_va(db: Session, channel: str | None = None, advertiser: str | None = None) -> dict:
    """Com (paid) spend vs V/A (bonus airtime) for a channel, optionally scoped
    to one advertiser. Com is money; V/A is free airtime, so it is reported as
    spots + seconds, never blended into spend."""
    conds = []
    if channel:
        conds.append(AdexRow.channel == channel)
    if advertiser:
        conds.append(AdexRow.advertiser == advertiser)

    com_spend, com_spots, com_secs = db.execute(
        select(func.sum(AdexRow.cost), func.count(), func.sum(AdexRow.dur)).where(_where(COM, *conds))
    ).one()
    va_spots, va_secs = db.execute(
        select(func.count(), func.sum(AdexRow.dur)).where(_where(AdexRow.va_com == "V/A", *conds))
    ).one()
    return {
        "com_spend": round(com_spend or 0, 2),
        "com_spots": com_spots or 0,
        "com_seconds": round(com_secs or 0, 1),
        "va_spots": va_spots or 0,
        "va_seconds": round(va_secs or 0, 1),
    }


def channel_advertisers(db: Session, channel: str, top=15) -> list[dict]:
    """Advertisers on a channel with BOTH paid (Com) spend and V/A bonus."""
    com = {
        a: (round(s or 0, 2), n) for a, s, n in db.execute(
            select(AdexRow.advertiser, func.sum(AdexRow.cost), func.count())
            .where(_where(COM, AdexRow.channel == channel)).group_by(AdexRow.advertiser)
        ).all() if a
    }
    va = {
        a: (n, round(s or 0, 1)) for a, n, s in db.execute(
            select(AdexRow.advertiser, func.count(), func.sum(AdexRow.dur))
            .where(_where(AdexRow.va_com == "V/A", AdexRow.channel == channel)).group_by(AdexRow.advertiser)
        ).all() if a
    }
    names = set(com) | set(va)
    out = [
        {
            "advertiser": a,
            "com_spend": com.get(a, (0, 0))[0],
            "com_spots": com.get(a, (0, 0))[1],
            "va_spots": va.get(a, (0, 0))[0],
            "va_seconds": va.get(a, (0, 0))[1],
        }
        for a in names
    ]
    out.sort(key=lambda x: x["com_spend"], reverse=True)
    return out[:top]


def advertiser_channel_trend(db: Session, channel: str, advertiser: str) -> dict:
    """Monthly Com spend for one advertiser on one channel (single line)."""
    month = func.to_char(AdexRow.spot_date, "YYYY-MM")
    rows = db.execute(
        select(month, func.sum(AdexRow.cost))
        .where(_where(COM, AdexRow.channel == channel, AdexRow.advertiser == advertiser, AdexRow.spot_date.isnot(None)))
        .group_by(month).order_by(month)
    ).all()
    labels = [r[0] for r in rows]
    return {"labels": labels, "series": {advertiser: [round(r[1] or 0, 2) for r in rows]}}
