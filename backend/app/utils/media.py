"""Medium normalisation + channel-to-medium inference.

The media-watch (adex) sheet does not carry a Medium column. Instead the
Channel value encodes it as a prefix, e.g. "Tv - Sirasa tv" -> TV,
"Radio - Siyatha FM" -> Radio. `medium_from_channel` extracts that prefix and
`norm_medium` maps any medium label onto the canonical TV / Radio / Press set.
"""
from __future__ import annotations

import re

# Separators that may sit between the medium prefix and the channel name.
_SEP = re.compile(r"\s*[-–—:|/]\s*")


def norm_medium(value: str | None) -> str | None:
    if not value:
        return None
    s = str(value).strip().lower()
    if not s:
        return None
    padded = f" {s} "
    if s.startswith("tv") or " tv" in padded or "televi" in s:
        return "TV"
    if "radio" in s or " fm" in padded:
        return "Radio"
    if "press" in s or "print" in s or "news" in s or "paper" in s or "mag" in s:
        return "Press"
    return str(value).strip()


def medium_from_channel(channel: str | None) -> str | None:
    """Infer the canonical medium from a channel label's prefix.

    "Tv - Sirasa tv" -> TV, "Radio - Siyatha FM" -> Radio. Anything a channel
    resolves to that is not TV or Radio is treated as Press (newspapers and
    magazines rarely carry a clear prefix), so every channel with a value maps
    to one of TV / Radio / Press. An empty channel stays None."""
    if not channel:
        return None
    prefix = _SEP.split(str(channel).strip(), 1)[0].strip()
    m = norm_medium(prefix) or norm_medium(str(channel))
    return m if m in ("TV", "Radio") else "Press"
