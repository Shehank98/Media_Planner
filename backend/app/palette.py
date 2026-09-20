"""Shared visual token system (dark "intelligence terminal" theme).

The same advertiser/channel keeps the same colour in every chart and every
table swatch (see services/colors.py for the stable name->colour assignment).
Colours are tuned to read on the dark app background; the printed report renders
charts on a light background via the `dark=False` path in charts.py.
"""
from __future__ import annotations

# Interactive accent (UI only: buttons, active nav, links, focus, selection).
ACCENT = "#2DD4BF"
ACCENT_INK = "#04211E"      # text on an accent-filled button

# Neutral base tokens (kept in sync with styles.css :root).
INK = "#EAEFF5"
MUTED = "#78838F"
LINE = "#242C38"
PAPER = "#0B0E13"
PANEL = "#141922"

# Categorical palette for advertisers / channels (bright enough for dark bg,
# still legible on the light report). Avoids the accent teal.
CATEGORICAL = [
    "#6AA0F0",  # blue
    "#F07A52",  # coral
    "#E6B23E",  # amber
    "#63C08C",  # green
    "#B98AE0",  # violet
    "#E86FA6",  # pink
    "#4FC4D6",  # cyan
    "#C9A24B",  # gold
    "#9A8CF0",  # periwinkle
]
OTHERS = "#8A95A2"  # grey, reserved for an "Others" bucket

# Fixed medium colours (TV / Radio / Press) - stable everywhere.
MEDIUM_COLORS = {
    "TV": "#4DA3D9",
    "Radio": "#E6B23E",
    "Press": "#7FB069",
    "Unknown": OTHERS,
}

# Semantic colours (used app-wide).
GAIN = "#45C285"
DECLINE = "#FF6B5E"
VA = "#A98BEA"  # value-addition / bonus (excluded from spend)

# Sequential ramp name for heatmaps (light report path).
SEQUENTIAL_CMAP = "BuPu"

# Per-theme chart chrome colours.
THEME = {
    "dark": {
        "fig": "#141922", "text": "#C7D0D9", "title": "#EAEFF5",
        "grid": "#212A35", "muted": "#78838F", "axis": "#2A3441",
        "value": "#8A95A2",
    },
    "light": {
        "fig": "#FFFFFF", "text": "#3B3F44", "title": "#1A1D21",
        "grid": "#ECEDEA", "muted": "#6A6E73", "axis": "#D7DBDE",
        "value": "#6A6E73",
    },
}


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
