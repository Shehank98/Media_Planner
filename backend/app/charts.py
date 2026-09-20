"""Server-side chart rendering with matplotlib (Agg backend).

Every chart returns a PNG as raw bytes so it can be:
  * streamed to the browser (image/png), and
  * embedded directly into the Word / PDF pitch report.

A single restrained palette keeps the app and the exported report visually
consistent and professional.
"""
from __future__ import annotations

import io
import os
import tempfile

# matplotlib needs a writable config/font-cache dir. On some hosts (e.g. Railpack
# on Railway) HOME may not be writable, so default it to a temp dir before import.
os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "matplotlib"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

from .palette import (  # noqa: E402
    ACCENT, CATEGORICAL, DECLINE, GAIN, INK, LINE, MUTED, OTHERS,
    SEQUENTIAL_CMAP, color_for, medium_color,
)

# Instrument styling: ink on light paper, hairline axes, y-grid only.
plt.rcParams.update(
    {
        "figure.dpi": 140,
        "font.size": 11,
        "font.family": "sans-serif",
        "text.color": INK,
        "axes.edgecolor": LINE,
        "axes.linewidth": 1.0,
        "axes.grid": True,
        "grid.color": "#ECEDEA",
        "grid.linewidth": 1.0,
        "axes.axisbelow": True,
        "axes.titleweight": "600",
        "axes.titlecolor": INK,
        "axes.titlesize": 13,
        "axes.titlelocation": "left",
        "axes.titlepad": 12,
        "axes.labelcolor": MUTED,
        "axes.labelsize": 10,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.labelsize": 9.5,
        "ytick.labelsize": 9.5,
        "legend.fontsize": 9.5,
        "figure.facecolor": "white",
        "savefig.facecolor": "white",
    }
)


def _colors(names, kind="name"):
    """Map a list of labels to colours consistently across every chart."""
    if kind == "medium":
        return [medium_color(n) for n in names]
    if kind == "accent":
        return [INK] * len(names)
    if kind == "delta":  # gainers green, decliners red (by value sign, set by caller)
        return names  # caller passes explicit colours here
    return [color_for(n) for n in names]


def _despine(ax, keep_left=True, keep_bottom=True):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(keep_left)
    ax.spines["bottom"].set_visible(keep_bottom)


def _thousands(x, _pos):
    if abs(x) >= 1_000_000:
        return f"{x/1_000_000:.1f}M"
    if abs(x) >= 1_000:
        return f"{x/1_000:.0f}K"
    return f"{x:.0f}"


def _finish(fig) -> bytes:
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def _fmt_val(v, money):
    if money:
        return _thousands(v, None)
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.1f}"


def bar_chart(labels, values, title="", xlabel="", ylabel="", money=False, horizontal=True,
              value_labels=True, single_color=False, color_kind="name", colors=None) -> bytes:
    if not labels:
        return _empty(title)
    fig, ax = plt.subplots(figsize=(8, max(3, 0.5 * len(labels) + 1.5)) if horizontal else (8, 4.5))
    if colors is None:
        colors = [INK] * len(labels) if single_color else _colors(labels, color_kind)
    if horizontal:
        bars = ax.barh(labels, values, color=colors, height=0.72)
        ax.invert_yaxis()
        ax.grid(False); ax.grid(axis="x")
        if money:
            ax.xaxis.set_major_formatter(FuncFormatter(_thousands))
        if value_labels:
            ax.bar_label(bars, labels=[_fmt_val(v, money) for v in values], padding=4, fontsize=9, color=MUTED)
            ax.margins(x=0.18)
        _despine(ax, keep_left=True, keep_bottom=False)
    else:
        bars = ax.bar(labels, values, color=colors, width=0.66)
        ax.grid(False); ax.grid(axis="y")
        if money:
            ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
        if value_labels:
            ax.bar_label(bars, labels=[_fmt_val(v, money) for v in values], padding=4, fontsize=9, color=MUTED)
            ax.margins(y=0.18)
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
        _despine(ax, keep_left=False, keep_bottom=True)
    if title:
        ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    return _finish(fig)


def delta_bar(labels, values, title="", money=True) -> bytes:
    """Horizontal bars coloured green for gains, red for declines (spend movers)."""
    colors = [GAIN if v >= 0 else DECLINE for v in values]
    return bar_chart(labels, values, title=title, money=money, horizontal=True,
                     value_labels=True, colors=colors)


def stacked_bar(labels, series: dict[str, list], title="", ylabel="", money=False, color_kind="medium") -> bytes:
    """Stacked vertical bars, one stack segment per series (e.g. medium over months)."""
    if not labels:
        return _empty(title)
    import numpy as np

    fig, ax = plt.subplots(figsize=(9, 4.8))
    bottom = np.zeros(len(labels))
    names = list(series.keys())
    seg_colors = _colors(names, color_kind)
    bar_w = 0.5 if len(labels) <= 3 else 0.72
    for i, (name, vals) in enumerate(series.items()):
        vals = np.array([v or 0 for v in vals], dtype=float)
        ax.bar(labels, vals, bottom=bottom, label=name, color=seg_colors[i], width=bar_w)
        bottom += vals
    ax.margins(x=0.1)
    ax.grid(False); ax.grid(axis="y")
    if money:
        ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    if title:
        ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.legend(frameon=False, ncol=min(len(series), 4), fontsize=9)
    plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    _despine(ax)
    return _finish(fig)


def heatmap(rows, cols, matrix, title="", money=True) -> bytes:
    """Advertiser x month spend heatmap."""
    if not rows or not cols:
        return _empty(title)
    import numpy as np

    data = np.array(matrix, dtype=float)
    fig, ax = plt.subplots(figsize=(max(7, 0.7 * len(cols) + 3), max(3, 0.5 * len(rows) + 1.5)))
    im = ax.imshow(data, aspect="auto", cmap=SEQUENTIAL_CMAP)
    ax.set_xticks(range(len(cols)))
    ax.set_xticklabels(cols, rotation=45, ha="right", fontsize=9)
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels(rows, fontsize=9)
    # annotate
    vmax = data.max() if data.size else 0
    for i in range(len(rows)):
        for j in range(len(cols)):
            v = data[i, j]
            if v > 0:
                ax.text(j, i, _thousands(v, None), ha="center", va="center", fontsize=7,
                        color="white" if v > vmax * 0.55 else "#1f2933")
    cbar = fig.colorbar(im, ax=ax, shrink=0.8)
    cbar.ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    if title:
        ax.set_title(title)
    return _finish(fig)


def _empty(title="") -> bytes:
    fig, ax = plt.subplots(figsize=(7, 2.6))
    ax.text(0.5, 0.5, "No data for this view yet", ha="center", va="center", color=MUTED, fontsize=12)
    if title:
        ax.set_title(title)
    ax.axis("off")
    return _finish(fig)


def line_chart(x, series: dict[str, list], title="", xlabel="", ylabel="", money=False, color_kind="name", colors=None) -> bytes:
    if not x or not series:
        return _empty(title)
    fig, ax = plt.subplots(figsize=(9, 4.5))
    names = list(series.keys())
    if colors is not None:
        line_colors = colors
    elif len(names) == 1 and names[0] in ("Category", "Total"):
        line_colors = [ACCENT]
    else:
        line_colors = _colors(names, color_kind)
    for i, (name, ys) in enumerate(series.items()):
        ax.plot(x, ys, marker="o", markersize=4, linewidth=2.4, color=line_colors[i], label=name)
    ax.grid(False); ax.grid(axis="y")
    if money:
        ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    if title:
        ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    if len(series) > 1:
        ax.legend(frameon=False, ncol=min(len(series), 3))
    plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    _despine(ax)
    return _finish(fig)


def pie_chart(labels, values, title="", color_kind="name", colors=None) -> bytes:
    if not labels or not any(values):
        return _empty(title)
    fig, ax = plt.subplots(figsize=(6.5, 5.0))
    if colors is None:
        colors = _colors(labels, color_kind)
    wedges, _texts, autotexts = ax.pie(
        values, labels=None, colors=colors, autopct="%1.1f%%",
        startangle=90, pctdistance=0.78, wedgeprops={"width": 0.40, "edgecolor": "white", "linewidth": 1.5},
    )
    for t in autotexts:
        t.set_color("white")
        t.set_fontsize(9)
    ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(1.0, 0.5), frameon=False, fontsize=10)
    if title:
        ax.set_title(title)
    return _finish(fig)
