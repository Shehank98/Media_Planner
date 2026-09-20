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

# Professional, muted palette (deep navy lead + supporting tones).
PALETTE = ["#1f3a5f", "#c9a227", "#3d7ea6", "#8c4a5f", "#5a8f69", "#b5651d", "#6d6875", "#2a9d8f"]
LEAD = "#1f3a5f"
ACCENT = "#c9a227"

plt.rcParams.update(
    {
        "figure.dpi": 130,
        "font.size": 11,
        "font.family": "sans-serif",
        "axes.edgecolor": "#d7dbe0",
        "axes.grid": True,
        "grid.color": "#eceef1",
        "grid.linewidth": 0.8,
        "axes.axisbelow": True,
        "axes.titleweight": "bold",
        "axes.titlecolor": "#1f2933",
        "axes.titlesize": 13,
        "axes.labelcolor": "#52606d",
    }
)


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


def bar_chart(labels, values, title="", xlabel="", ylabel="", money=False, horizontal=True) -> bytes:
    fig, ax = plt.subplots(figsize=(8, max(3, 0.5 * len(labels) + 1.5)) if horizontal else (8, 4.5))
    colors = [PALETTE[i % len(PALETTE)] for i in range(len(labels))]
    if horizontal:
        ax.barh(labels, values, color=colors)
        ax.invert_yaxis()
        if money:
            ax.xaxis.set_major_formatter(FuncFormatter(_thousands))
    else:
        ax.bar(labels, values, color=colors)
        if money:
            ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    return _finish(fig)


def line_chart(x, series: dict[str, list], title="", xlabel="", ylabel="", money=False) -> bytes:
    fig, ax = plt.subplots(figsize=(9, 4.5))
    for i, (name, ys) in enumerate(series.items()):
        ax.plot(x, ys, marker="o", linewidth=2, color=PALETTE[i % len(PALETTE)], label=name)
    if money:
        ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    if len(series) > 1:
        ax.legend(frameon=False)
    plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    return _finish(fig)


def pie_chart(labels, values, title="") -> bytes:
    fig, ax = plt.subplots(figsize=(6.5, 5.5))
    colors = [PALETTE[i % len(PALETTE)] for i in range(len(labels))]
    wedges, _texts, autotexts = ax.pie(
        values, labels=None, colors=colors, autopct="%1.1f%%",
        startangle=90, pctdistance=0.8, wedgeprops={"width": 0.42, "edgecolor": "white"},
    )
    for t in autotexts:
        t.set_color("white")
        t.set_fontsize(9)
    ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(1.0, 0.5), frameon=False, fontsize=10)
    ax.set_title(title)
    return _finish(fig)


def grouped_bar(categories, groups: dict[str, list], title="", ylabel="", money=False) -> bytes:
    """categories on x-axis, one bar cluster per group (e.g. medium split per advertiser)."""
    import numpy as np

    fig, ax = plt.subplots(figsize=(9, 4.8))
    n = len(groups)
    x = np.arange(len(categories))
    width = 0.8 / max(n, 1)
    for i, (name, vals) in enumerate(groups.items()):
        ax.bar(x + i * width - 0.4 + width / 2, vals, width, label=name, color=PALETTE[i % len(PALETTE)])
    ax.set_xticks(x)
    ax.set_xticklabels(categories, rotation=30, ha="right")
    if money:
        ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.legend(frameon=False)
    return _finish(fig)
