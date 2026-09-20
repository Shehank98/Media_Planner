"""Normalise mixed time formats into a single datetime.time.

Rate cards / TVR sheets mix real time objects (`18:55:00`) with strings
like `"01:30 pm"`, `"1830"`, `"6:00 PM"`.
"""
from __future__ import annotations

import datetime as dt
import re


def parse_time(value) -> dt.time | None:
    if value is None or value == "":
        return None
    if isinstance(value, dt.time):
        return value
    if isinstance(value, dt.datetime):
        return value.time()

    s = str(value).strip().lower()
    if not s:
        return None

    # 12-hour with am/pm, e.g. "01:30 pm", "6 pm"
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)$", s)
    if m:
        hour = int(m.group(1)) % 12
        minute = int(m.group(2) or 0)
        second = int(m.group(3) or 0)
        if m.group(4) == "pm":
            hour += 12
        try:
            return dt.time(hour, minute, second)
        except ValueError:
            return None

    # 24-hour with separators, e.g. "18:55:00", "18:55"
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", s)
    if m:
        try:
            return dt.time(int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))
        except ValueError:
            return None

    # Compact "1830"
    m = re.match(r"^(\d{2})(\d{2})$", s)
    if m:
        try:
            return dt.time(int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None

    return None


def time_to_str(t: dt.time | None) -> str | None:
    return t.strftime("%H:%M") if t else None


def in_window(t: dt.time | None, start: dt.time, end: dt.time) -> bool:
    """Is time t within [start, end)? Handles windows that wrap past midnight."""
    if t is None:
        return False
    if start <= end:
        return start <= t < end
    # wrap-around window (e.g. 20:00-02:00)
    return t >= start or t < end
