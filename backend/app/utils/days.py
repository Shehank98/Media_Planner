"""Normalise free-text day patterns into a structured day-of-week set.

0 = Monday ... 6 = Sunday (matching Python's date.weekday()).

Handles: 'Daily', 'Mon-Fri', 'Mon - Sun', 'Saturday', 'Sat & Sun',
'Weekdays', 'Weekend', comma lists like 'Mon, Wed, Fri'.
"""
from __future__ import annotations

import re

_NAME_TO_IDX = {
    "mon": 0, "monday": 0,
    "tue": 1, "tues": 1, "tuesday": 1,
    "wed": 2, "weds": 2, "wednesday": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
    "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5,
    "sun": 6, "sunday": 6,
}

_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _idx(token: str) -> int | None:
    return _NAME_TO_IDX.get(token.strip().lower())


def parse_days(raw) -> list[int]:
    """Return a sorted list of weekday indices. Empty list if unparseable."""
    if raw is None:
        return []
    s = str(raw).strip().lower()
    if not s:
        return []

    if "dai" in s or s in {"everyday", "every day", "all"}:
        return [0, 1, 2, 3, 4, 5, 6]
    if "weekday" in s:
        return [0, 1, 2, 3, 4]
    if "weekend" in s:
        return [5, 6]

    days: set[int] = set()

    # Range patterns: "mon-fri", "mon - sun"
    for a, b in re.findall(r"([a-z]{3,9})\s*[-–to]+\s*([a-z]{3,9})", s):
        ia, ib = _idx(a), _idx(b)
        if ia is not None and ib is not None:
            if ia <= ib:
                days.update(range(ia, ib + 1))
            else:  # wrap e.g. sat-sun handled, or fri-mon
                days.update(list(range(ia, 7)) + list(range(0, ib + 1)))

    # Individual day tokens (also catches comma / '&' separated lists)
    for token in re.split(r"[,&/+]|\band\b|\s", s):
        i = _idx(token)
        if i is not None:
            days.add(i)

    return sorted(days)


def days_label(indices: list[int] | None) -> str:
    if not indices:
        return ""
    return ", ".join(_ORDER[i][:3].title() for i in sorted(indices))
