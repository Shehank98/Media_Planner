"""Shared visual token system for the whole app.

The key requirement for a pitch tool: the SAME advertiser or channel gets the
SAME colour in every chart and every table swatch, across all views. We achieve
that with a deterministic name -> colour hash (FNV-1a), mirrored byte-for-byte
in the frontend (frontend/app.js `colorFor`) so server charts and client chips
match exactly. No shared state or coordination needed.

Palette is a curated, well-separated qualitative set on a light "paper" base;
the interactive accent (petrol teal) is deliberately kept OUT of the categorical
set so an advertiser is never coloured like a button.
"""
from __future__ import annotations

# Interactive accent (UI only: buttons, active nav, links, focus, selection).
ACCENT = "#0F6E63"

# Neutral base tokens (kept in sync with styles.css :root).
INK = "#1A1D21"
MUTED = "#6A6E73"
LINE = "#E2E4E1"
PAPER = "#F4F5F3"

# Categorical palette for advertisers / channels (avoids the accent teal).
CATEGORICAL = [
    "#3F6DA6",  # slate blue
    "#B4523C",  # rust
    "#C08A2E",  # ochre
    "#5B8C5A",  # sage
    "#6B5B95",  # plum
    "#B23B6E",  # rose
    "#4B7B8C",  # steel
    "#8A6D3B",  # bronze
    "#A0553B",  # clay
]
OTHERS = "#8A8D91"  # grey, reserved for an "Others" bucket

# Fixed medium colours (TV / Radio / Press) - stable everywhere.
MEDIUM_COLORS = {
    "TV": "#1C5D7C",
    "Radio": "#B8823A",
    "Press": "#6C7A45",
    "Unknown": OTHERS,
}

# Semantic colours (used app-wide).
GAIN = "#2F7D4F"
DECLINE = "#C0392B"
VA = "#6B5B95"  # value-addition / bonus (excluded from spend)

# Sequential ramp name for heatmaps.
SEQUENTIAL_CMAP = "BuPu"


def color_for(name: str | None) -> str:
    """Deterministic name -> categorical colour (FNV-1a 32-bit, mod palette)."""
    if not name:
        return OTHERS
    if name.strip().lower() == "others":
        return OTHERS
    h = 2166136261
    for ch in str(name):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return CATEGORICAL[h % len(CATEGORICAL)]


def medium_color(name: str | None) -> str:
    return MEDIUM_COLORS.get((name or "Unknown"), OTHERS)
