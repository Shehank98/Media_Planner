"""Server-side chart rendering with matplotlib (Agg backend).

Charts render on the dark app theme by default (dark=True) so they sit
seamlessly inside the dark panels; the printed report passes dark=False to get
charts on a light background. Every chart returns a PNG as raw bytes for both
the browser and embedding into the Word / PDF report.

Colour mapping (same advertiser/channel = same colour everywhere) comes from
palette.py + services/colors.py.
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
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

from .palette import (  # noqa: E402
    ACCENT, DECLINE, GAIN, OTHERS, THEME, color_for, medium_color,
)

plt.rcParams.update({
    "figure.dpi": 140,
    "font.size": 11,
    "font.family": "sans-serif",
    "axes.titleweight": "600",
    "axes.titlelocation": "left",
    "axes.titlepad": 12,
    "axes.titlesize": 13,
    "axes.labelsize": 10,
    "xtick.labelsize": 9.5,
    "ytick.labelsize": 9.5,
    "legend.fontsize": 9.5,
})

# Dark teal ramp for the heatmap (panel -> teal).
_DARK_HEAT = LinearSegmentedColormap.from_list("mp_dark", ["#161C26", "#1D5C57", "#2DD4BF"])


def _th(dark: bool) -> dict:
    return THEME["dark" if dark else "light"]


def _new(figsize, dark):
    th = _th(dark)
    fig, ax = plt.subplots(figsize=figsize)
    fig.patch.set_facecolor(th["fig"])
    ax.set_facecolor(th["fig"])
    return fig, ax, th


def _style(ax, th, title, keep_left=True, keep_bottom=True):
    ax.tick_params(colors=th["muted"])
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.spines["left"].set_visible(keep_left)
    ax.spines["bottom"].set_visible(keep_bottom)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color(th["axis"])
    ax.xaxis.label.set_color(th["muted"])
    ax.yaxis.label.set_color(th["muted"])
    if title:
        ax.set_title(title, color=th["title"], loc="left")


def _grid(ax, th, axis):
    ax.grid(False)
    ax.grid(axis=axis, color=th["grid"], linewidth=1.0)
    ax.set_axisbelow(True)


def _thousands(x, _pos):
    if abs(x) >= 1_000_000:
        return f"{x/1_000_000:.1f}M"
    if abs(x) >= 1_000:
        return f"{x/1_000:.0f}K"
    return f"{x:.0f}"


def _finish(fig, th) -> bytes:
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor=th["fig"])
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def _fmt_val(v, money):
    if money:
        return _thousands(v, None)
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.1f}"


def _colors(names, kind):
    if kind == "medium":
        return [medium_color(n) for n in names]
    return [color_for(n) for n in names]


# --------------------------------------------------------------------------
def bar_chart(labels, values, title="", xlabel="", ylabel="", money=False, horizontal=True,
              value_labels=True, single_color=False, color_kind="name", colors=None, dark=True) -> bytes:
    if not labels:
        return _empty(title, dark)
    th = _th(dark)
    fig, ax, th = _new((8, max(3, 0.5 * len(labels) + 1.5)) if horizontal else (8, 4.5), dark)
    if colors is None:
        colors = [ACCENT] * len(labels) if single_color else _colors(labels, color_kind)
    if horizontal:
        bars = ax.barh(labels, values, color=colors, height=0.72)
        ax.invert_yaxis()
        _grid(ax, th, "x")
        if money:
            ax.xaxis.set_major_formatter(FuncFormatter(_thousands))
        if value_labels:
            ax.bar_label(bars, labels=[_fmt_val(v, money) for v in values], padding=4, fontsize=9, color=th["value"])
            ax.margins(x=0.18)
        _style(ax, th, title, keep_left=True, keep_bottom=False)
        plt.setp(ax.get_yticklabels(), color=th["text"])
    else:
        bars = ax.bar(labels, values, color=colors, width=0.66)
        _grid(ax, th, "y")
        if money:
            ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
        if value_labels:
            ax.bar_label(bars, labels=[_fmt_val(v, money) for v in values], padding=4, fontsize=9, color=th["value"])
            ax.margins(y=0.18)
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right", color=th["text"])
        _style(ax, th, title, keep_left=False, keep_bottom=True)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    return _finish(fig, th)


def delta_bar(labels, values, title="", money=True, dark=True) -> bytes:
    colors = [GAIN if v >= 0 else DECLINE for v in values]
    return bar_chart(labels, values, title=title, money=money, horizontal=True,
                     value_labels=True, colors=colors, dark=dark)


def stacked_bar(labels, series, title="", ylabel="", money=False, color_kind="medium", dark=True) -> bytes:
    if not labels:
        return _empty(title, dark)
    import numpy as np

    fig, ax, th = _new((9, 4.8), dark)
    bottom = np.zeros(len(labels))
    names = list(series.keys())
    seg_colors = _colors(names, color_kind)
    bar_w = 0.5 if len(labels) <= 3 else 0.72
    for i, (name, vals) in enumerate(series.items()):
        vals = np.array([v or 0 for v in vals], dtype=float)
        ax.bar(labels, vals, bottom=bottom, label=name, color=seg_colors[i], width=bar_w)
        bottom += vals
    ax.margins(x=0.1)
    _grid(ax, th, "y")
    if money:
        ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    ax.set_ylabel(ylabel)
    leg = ax.legend(frameon=False, ncol=min(len(series), 4), fontsize=9, labelcolor=th["text"])
    plt.setp(ax.get_xticklabels(), rotation=30, ha="right", color=th["text"])
    _style(ax, th, title)
    return _finish(fig, th)


def line_chart(x, series, title="", xlabel="", ylabel="", money=False, color_kind="name", colors=None, dark=True) -> bytes:
    if not x or not series:
        return _empty(title, dark)
    fig, ax, th = _new((9, 4.5), dark)
    names = list(series.keys())
    if colors is not None:
        line_colors = colors
    elif len(names) == 1 and names[0] in ("Category", "Total"):
        line_colors = [ACCENT]
    else:
        line_colors = _colors(names, color_kind)
    for i, (name, ys) in enumerate(series.items()):
        ax.plot(x, ys, marker="o", markersize=4, linewidth=2.4, color=line_colors[i], label=name)
    _grid(ax, th, "y")
    if money:
        ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    if len(series) > 1:
        ax.legend(frameon=False, ncol=min(len(series), 3), labelcolor=th["text"])
    plt.setp(ax.get_xticklabels(), rotation=30, ha="right", color=th["text"])
    _style(ax, th, title)
    return _finish(fig, th)


def pie_chart(labels, values, title="", color_kind="name", colors=None, dark=True) -> bytes:
    if not labels or not any(values):
        return _empty(title, dark)
    fig, ax, th = _new((6.5, 5.0), dark)
    if colors is None:
        colors = _colors(labels, color_kind)
    wedges, _t, autotexts = ax.pie(
        values, labels=None, colors=colors, autopct="%1.1f%%",
        startangle=90, pctdistance=0.78,
        wedgeprops={"width": 0.40, "edgecolor": th["fig"], "linewidth": 2},
    )
    for t in autotexts:
        t.set_color("#0B0E13" if dark else "white")
        t.set_fontsize(9)
    leg = ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(1.0, 0.5),
                    frameon=False, fontsize=10, labelcolor=th["text"])
    if title:
        ax.set_title(title, color=th["title"], loc="left")
    return _finish(fig, th)


def heatmap(rows, cols, matrix, title="", money=True, dark=True) -> bytes:
    if not rows or not cols:
        return _empty(title, dark)
    import numpy as np

    th = _th(dark)
    data = np.array(matrix, dtype=float)
    fig, ax = plt.subplots(figsize=(max(7, 0.7 * len(cols) + 3), max(3, 0.5 * len(rows) + 1.5)))
    fig.patch.set_facecolor(th["fig"])
    ax.set_facecolor(th["fig"])
    cmap = _DARK_HEAT if dark else plt.get_cmap("BuPu")
    im = ax.imshow(data, aspect="auto", cmap=cmap)
    ax.set_xticks(range(len(cols)))
    ax.set_xticklabels(cols, rotation=45, ha="right", fontsize=9, color=th["text"])
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels(rows, fontsize=9, color=th["text"])
    ax.tick_params(colors=th["muted"])
    for s in ax.spines.values():
        s.set_visible(False)
    vmax = data.max() if data.size else 0
    for i in range(len(rows)):
        for j in range(len(cols)):
            v = data[i, j]
            if v > 0:
                ax.text(j, i, _thousands(v, None), ha="center", va="center", fontsize=7,
                        color="#0B0E13" if v > vmax * 0.55 else th["text"])
    cbar = fig.colorbar(im, ax=ax, shrink=0.8)
    cbar.ax.yaxis.set_major_formatter(FuncFormatter(_thousands))
    cbar.ax.tick_params(colors=th["muted"])
    cbar.outline.set_visible(False)
    if title:
        ax.set_title(title, color=th["title"], loc="left")
    return _finish(fig, th)


def _empty(title="", dark=True) -> bytes:
    fig, ax, th = _new((7, 2.6), dark)
    ax.text(0.5, 0.5, "No data for this view yet", ha="center", va="center", color=th["muted"], fontsize=12)
    if title:
        ax.set_title(title, color=th["title"], loc="left")
    ax.axis("off")
    return _finish(fig, th)
