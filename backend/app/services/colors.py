"""Stable colour assignment for advertisers and channels.

The pitch tool needs the SAME advertiser/channel to keep the SAME colour across
every chart and table. We assign the categorical palette over the sorted set of
ALL advertisers (and all channels) in the database, so:
  * the assignment is deterministic and stable across every view, and
  * names that are close in the sorted order (e.g. the "John Keells ..."
    cluster) get distinct colours instead of random hash collisions.

The map is small and cheap; we cache it per process and clear it on ingest.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AdexRow, RateCard, TvrRow
from ..palette import CATEGORICAL, MEDIUM_COLORS, OTHERS

_cache: dict[str, dict[str, str]] = {}


def clear_cache() -> None:
    _cache.clear()


def _assign(names) -> dict[str, str]:
    uniq = sorted({n for n in names if n})
    return {n: CATEGORICAL[i % len(CATEGORICAL)] for i, n in enumerate(uniq)}


def advertiser_colors(db: Session) -> dict[str, str]:
    if "advertisers" not in _cache:
        names = db.execute(select(AdexRow.advertiser).where(AdexRow.advertiser.isnot(None)).distinct()).scalars().all()
        _cache["advertisers"] = _assign(names)
    return _cache["advertisers"]


def channel_colors(db: Session) -> dict[str, str]:
    if "channels" not in _cache:
        a = db.execute(select(AdexRow.channel).where(AdexRow.channel.isnot(None)).distinct()).scalars().all()
        t = db.execute(select(TvrRow.channel).where(TvrRow.channel.isnot(None)).distinct()).scalars().all()
        r = db.execute(select(RateCard.channel).where(RateCard.channel.isnot(None)).distinct()).scalars().all()
        _cache["channels"] = _assign(list(a) + list(t) + list(r))
    return _cache["channels"]


def color_list(mapping: dict[str, str], names) -> list[str]:
    return [mapping.get(n, OTHERS) for n in names]


def all_maps(db: Session) -> dict:
    return {
        "advertisers": advertiser_colors(db),
        "channels": channel_colors(db),
        "mediums": MEDIUM_COLORS,
    }
