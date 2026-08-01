"""Chart rendering for the media plan PDF.

Every figure is drawn from the chart_data blob computed in Node and stored on
plan_recommendations - this module does no querying and no aggregation, so what
lands in the PDF is exactly what was audited into Postgres.
"""

import os

import matplotlib

# Headless: Railway containers have no display, and this must be set before
# pyplot is imported.
matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

# A restrained categorical palette - these charts sit in a client-facing
# document, so the accent colour is reserved for "this is the recommendation"
# and everything else stays neutral.
PALETTE = [
    "#2E5A88", "#C8734A", "#6E8B74", "#8E6C99",
    "#B5A24C", "#4F7D8C", "#A5615F", "#7A8290",
]
ACCENT = "#C8734A"
# The accent means "this is the brief's own brand" / "this is recommended", so
# it must never also appear as an ordinary series colour - two bars in the same
# orange reads as two own brands.
SERIES_PALETTE = [c for c in PALETTE if c != ACCENT]
NEUTRAL = "#9AA3AE"
TEXT = "#2B2F36"
GRID = "#DDE1E6"

DPI = 150


def _style(ax, *, title=None, subtitle=None, xlabel=None, ylabel=None):
    """Shared axis treatment: light grid, no boxing, muted labels."""
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=TEXT, labelsize=8, length=0)
    ax.grid(axis="y", color=GRID, linewidth=0.7, alpha=0.9)
    ax.set_axisbelow(True)
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=8.5, color=TEXT, labelpad=8)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=8.5, color=TEXT, labelpad=8)
    if title:
        ax.set_title(
            title,
            fontsize=11.5,
            color=TEXT,
            loc="left",
            pad=18 if subtitle else 10,
            fontweight="bold",
        )
    if subtitle:
        ax.annotate(
            subtitle,
            xy=(0, 1),
            xytext=(0, 8),
            xycoords="axes fraction",
            textcoords="offset points",
            fontsize=8,
            color="#6B7280",
            va="bottom",
        )


def _thousands(value, _pos):
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:,.1f}M"
    if abs(value) >= 1_000:
        return f"{value / 1_000:,.0f}K"
    return f"{value:,.0f}"


def _save(fig, path):
    # pad_inches keeps legends placed below the axes from being shaved off at
    # the crop boundary.
    fig.savefig(path, dpi=DPI, bbox_inches="tight", pad_inches=0.2, facecolor="white")
    plt.close(fig)
    return path


def _placeholder(path, message):
    """A labelled empty state beats a missing chart - the gap is the finding."""
    fig, ax = plt.subplots(figsize=(8, 2.4))
    ax.axis("off")
    ax.text(
        0.5, 0.5, message,
        ha="center", va="center", fontsize=10, color="#6B7280", wrap=True,
    )
    return _save(fig, path)


def competitor_spend_chart(data, out_dir):
    """Grouped bars: spend per brand per quarter, own brand highlighted."""
    path = os.path.join(out_dir, "competitor_spend.png")
    categories = data.get("categories") or []
    series = data.get("series") or []
    if not categories or not series:
        return _placeholder(path, "No competitor spend data available for this category and period.")

    n_series = len(series)
    group_width = 0.82
    bar_width = group_width / n_series
    positions = range(len(categories))

    fig, ax = plt.subplots(figsize=(9, 4.6))
    for idx, s in enumerate(series):
        offset = -group_width / 2 + bar_width * (idx + 0.5)
        is_own = s.get("is_own_brand")
        ax.bar(
            [p + offset for p in positions],
            s.get("values") or [],
            width=bar_width * 0.92,
            label=s.get("label", ""),
            color=ACCENT if is_own else SERIES_PALETTE[idx % len(SERIES_PALETTE)],
            edgecolor="white",
            linewidth=0.4,
            zorder=3,
        )

    ax.set_xticks(list(positions))
    ax.set_xticklabels(categories, fontsize=8.5)
    ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    _style(
        ax,
        title=data.get("title", "Competitor spend by quarter"),
        subtitle=data.get("subtitle"),
        ylabel=data.get("y_label", "Spend (LKR 000)"),
    )
    ax.legend(
        frameon=False, fontsize=7.5, ncol=min(4, n_series),
        loc="upper center", bbox_to_anchor=(0.5, -0.13),
    )
    return _save(fig, path)


def programme_rating_chart(data, out_dir):
    """Horizontal bars, ranked. Recommended programmes carry the accent colour."""
    path = os.path.join(out_dir, "programme_ratings.png")
    items = data.get("items") or []
    if not items:
        return _placeholder(path, "No programme rating data available for this target audience.")

    items = items[:20]
    # Highest value at the top: matplotlib draws barh bottom-up, so reverse.
    items = list(reversed(items))
    labels = [i.get("label", "") for i in items]
    values = [i.get("value") or 0 for i in items]
    colors = [ACCENT if i.get("recommended") else NEUTRAL for i in items]

    fig, ax = plt.subplots(figsize=(9, max(3.2, 0.32 * len(items) + 1.4)))
    bars = ax.barh(range(len(items)), values, color=colors, height=0.72, zorder=3)
    ax.set_yticks(range(len(items)))
    ax.set_yticklabels(labels, fontsize=7.8)
    ax.grid(axis="x", color=GRID, linewidth=0.7)
    ax.grid(axis="y", visible=False)

    span = max(values) if values else 1
    for bar, value in zip(bars, values):
        ax.text(
            bar.get_width() + span * 0.012,
            bar.get_y() + bar.get_height() / 2,
            f"{value:,.1f}",
            va="center", fontsize=7.2, color=TEXT,
        )
    ax.set_xlim(0, span * 1.12)

    _style(
        ax,
        title=data.get("title", "Programme ratings"),
        subtitle=data.get("subtitle"),
        xlabel=data.get("x_label", "GRP / TRP"),
    )
    ax.grid(axis="y", visible=False)

    if any(i.get("recommended") for i in items):
        from matplotlib.patches import Patch

        ax.legend(
            handles=[
                Patch(color=ACCENT, label="In recommended lineup"),
                Patch(color=NEUTRAL, label="Available, not selected"),
            ],
            frameon=False, fontsize=7.5, loc="lower right",
        )
    return _save(fig, path)


def medium_split_chart(data, out_dir):
    """Side-by-side donuts: the brief's split against the category benchmark."""
    path = os.path.join(out_dir, "medium_split.png")
    brief = data.get("brief") or {}
    benchmark = data.get("benchmark") or {}
    panels = [p for p in (brief, benchmark) if p.get("available") and p.get("slices")]
    if not panels:
        return _placeholder(path, "No medium split available from the brief, and no category spend to benchmark against.")

    fig, axes = plt.subplots(1, len(panels), figsize=(4.6 * len(panels), 4.0))
    if len(panels) == 1:
        axes = [axes]

    for ax, panel in zip(axes, panels):
        slices = panel["slices"]
        values = [s.get("value") or 0 for s in slices]
        labels = [s.get("label", "") for s in slices]
        wedges, _texts, autotexts = ax.pie(
            values,
            labels=labels,
            autopct=lambda pct: f"{pct:.0f}%",
            startangle=90,
            counterclock=False,
            colors=PALETTE[: len(values)],
            wedgeprops={"width": 0.42, "edgecolor": "white", "linewidth": 1.6},
            textprops={"fontsize": 8.5, "color": TEXT},
            pctdistance=0.78,
        )
        for t in autotexts:
            t.set_color("white")
            t.set_fontsize(8)
            t.set_fontweight("bold")
        ax.set_title(panel.get("label", ""), fontsize=10, color=TEXT, fontweight="bold", pad=12)

    fig.suptitle(
        data.get("title", "Medium split"),
        fontsize=11.5, color=TEXT, fontweight="bold", x=0.02, ha="left", y=1.02,
    )
    return _save(fig, path)


def day_of_week_chart(data, out_dir):
    """Grouped bars per channel across the week; bought days are accented."""
    path = os.path.join(out_dir, "day_of_week.png")
    categories = data.get("categories") or []
    series = data.get("series") or []
    if not categories or not series:
        return _placeholder(path, "No day-of-week rating data available.")

    highlighted = {d.lower() for d in (data.get("highlighted") or [])}
    n_series = len(series)
    group_width = 0.82
    bar_width = group_width / n_series
    positions = range(len(categories))

    fig, ax = plt.subplots(figsize=(9, 4.2))
    for idx, s in enumerate(series):
        offset = -group_width / 2 + bar_width * (idx + 0.5)
        ax.bar(
            [p + offset for p in positions],
            s.get("values") or [],
            width=bar_width * 0.92,
            label=s.get("label", ""),
            color=SERIES_PALETTE[idx % len(SERIES_PALETTE)],
            edgecolor="white",
            linewidth=0.4,
            zorder=3,
        )

    # Shade the days the plan actually buys, so the day column in the lineup
    # can be checked against the evidence at a glance.
    for i, day in enumerate(categories):
        if day.lower() in highlighted:
            ax.axvspan(i - 0.5, i + 0.5, color=ACCENT, alpha=0.10, zorder=0)

    ax.set_xticks(list(positions))
    ax.set_xticklabels(categories, fontsize=8.5)
    ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    _style(
        ax,
        title=data.get("title", "Audience by day of week"),
        subtitle=data.get("subtitle"),
        ylabel=data.get("y_label", "Ratings"),
    )
    ax.legend(
        frameon=False, fontsize=7.5, ncol=min(4, n_series),
        loc="upper center", bbox_to_anchor=(0.5, -0.13),
    )
    if highlighted:
        ax.annotate(
            "Shaded = days in the recommended plan",
            xy=(1, 1), xytext=(0, 8), xycoords="axes fraction",
            textcoords="offset points", fontsize=7.5, color="#6B7280", ha="right", va="bottom",
        )
    return _save(fig, path)


def render_all(chart_data, out_dir):
    """Render every chart, returning a name -> path map."""
    os.makedirs(out_dir, exist_ok=True)
    return {
        "competitor_spend": competitor_spend_chart(chart_data.get("competitor_spend") or {}, out_dir),
        "programme_ratings": programme_rating_chart(chart_data.get("programme_ratings") or {}, out_dir),
        "day_of_week": day_of_week_chart(chart_data.get("day_of_week") or {}, out_dir),
        "medium_split": medium_split_chart(chart_data.get("medium_split") or {}, out_dir),
    }
