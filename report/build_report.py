"""Build the media plan PDF (Section 6).

Invoked as a subprocess by the Node backend:

    python3 report/build_report.py --payload <payload.json> --out <report.pdf>

The payload carries the brief, the recommendation, the chart data and the raw
aggregates. Nothing is fetched here - this process has no database access, so
the report can only ever show numbers that were already stored against the
plan.
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from charts import render_all

INK = colors.HexColor("#2B2F36")
MUTED = colors.HexColor("#6B7280")
ACCENT = colors.HexColor("#C8734A")
RULE = colors.HexColor("#DDE1E6")
BAND = colors.HexColor("#F4F6F8")

PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 18 * mm
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN

CONFIDENCE_COLOURS = {
    "high": colors.HexColor("#3F7A54"),
    "medium": colors.HexColor("#B5822C"),
    "low": colors.HexColor("#A6483F"),
}


# --------------------------------------------------------------------------
# Styles
# --------------------------------------------------------------------------

def build_styles():
    base = getSampleStyleSheet()
    s = {}
    s["title"] = ParagraphStyle(
        "PlanTitle", parent=base["Title"], fontName="Helvetica-Bold",
        fontSize=26, leading=31, textColor=INK, alignment=TA_LEFT, spaceAfter=6,
    )
    s["subtitle"] = ParagraphStyle(
        "PlanSubtitle", parent=base["Normal"], fontName="Helvetica",
        fontSize=12.5, leading=17, textColor=MUTED, spaceAfter=4,
    )
    s["h1"] = ParagraphStyle(
        "PlanH1", parent=base["Heading1"], fontName="Helvetica-Bold",
        fontSize=15, leading=19, textColor=INK, spaceBefore=4, spaceAfter=9,
    )
    s["h2"] = ParagraphStyle(
        "PlanH2", parent=base["Heading2"], fontName="Helvetica-Bold",
        fontSize=11, leading=14, textColor=INK, spaceBefore=10, spaceAfter=5,
    )
    s["body"] = ParagraphStyle(
        "PlanBody", parent=base["BodyText"], fontName="Helvetica",
        fontSize=9.8, leading=14.6, textColor=INK, spaceAfter=8,
    )
    s["small"] = ParagraphStyle(
        "PlanSmall", parent=base["BodyText"], fontName="Helvetica",
        fontSize=8.2, leading=11.5, textColor=MUTED, spaceAfter=4,
    )
    s["cell"] = ParagraphStyle(
        "PlanCell", parent=base["BodyText"], fontName="Helvetica",
        fontSize=8.2, leading=11, textColor=INK, spaceAfter=0,
    )
    s["cell_head"] = ParagraphStyle(
        "PlanCellHead", parent=s["cell"], fontName="Helvetica-Bold",
        fontSize=8.2, textColor=colors.white,
    )
    return s


def esc(value):
    """Escape for reportlab's mini-HTML, preserving paragraph breaks."""
    if value is None:
        return ""
    text = str(value)
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return text.replace("\r\n", "\n").replace("\n", "<br/>")


def fmt_num(value, dp=1):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return "-"
    return f"{n:,.{dp}f}"


# --------------------------------------------------------------------------
# Page furniture
# --------------------------------------------------------------------------

def page_decoration(canvas, doc):
    """Footer rule, brand line and page number on every page after the cover."""
    canvas.saveState()
    if doc.page > 1:
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.5)
        canvas.line(MARGIN, 13 * mm, PAGE_WIDTH - MARGIN, 13 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, 9 * mm, doc.footer_left)
        canvas.drawRightString(PAGE_WIDTH - MARGIN, 9 * mm, f"Page {doc.page}")
    canvas.restoreState()


# --------------------------------------------------------------------------
# Sections
# --------------------------------------------------------------------------

def section_cover(story, styles, brief, plan, meta):
    """1. Cover - brand, campaign period, budget, prepared date."""
    brand = brief.get("brand") or "Unnamed brand"
    story.append(Spacer(1, 42 * mm))
    story.append(Paragraph(esc(brand), styles["title"]))
    story.append(Paragraph("Media Plan Recommendation", styles["subtitle"]))
    story.append(Spacer(1, 10 * mm))

    period = format_period(brief)
    budget = brief.get("budget_lkr_lakhs")
    rows = [
        ("Advertiser", brief.get("advertiser") or "-"),
        ("Campaign period", period),
        ("Budget", f"LKR {fmt_num(budget, 2)} lakhs" if budget is not None else "Not stated"),
        ("Target audience", brief.get("target_audience") or "-"),
        ("Language", brief.get("language") or "-"),
        ("Territory", brief.get("territory") or "-"),
        ("Prepared", datetime.now(timezone.utc).strftime("%d %B %Y")),
    ]
    table = Table(
        [[Paragraph(f"<b>{esc(k)}</b>", styles["cell"]), Paragraph(esc(v), styles["cell"])] for k, v in rows],
        colWidths=[42 * mm, CONTENT_WIDTH - 42 * mm],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(table)

    story.append(Spacer(1, 14 * mm))
    confidence = (plan.get("confidence") or "low").lower()
    story.append(confidence_badge(confidence, styles))

    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(
        f"Generated by {esc(meta.get('model_used') or plan.get('model_used') or 'the configured model')}. "
        "All figures are drawn from the agency's adex and TVR data; see the appendix for the "
        "aggregates this plan was built on.",
        styles["small"],
    ))
    story.append(PageBreak())


def confidence_badge(confidence, styles):
    colour = CONFIDENCE_COLOURS.get(confidence, MUTED)
    badge = Table(
        [[Paragraph(
            f'<font color="white"><b>CONFIDENCE: {esc(confidence.upper())}</b></font>',
            styles["cell"],
        )]],
        colWidths=[52 * mm],
    )
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colour),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
    ]))
    return badge


def section_executive_summary(story, styles, plan):
    """2. Executive summary - the model's overall rationale."""
    story.append(Paragraph("Executive summary", styles["h1"]))
    rationale = plan.get("overall_rationale") or "No rationale was returned for this plan."
    story.append(Paragraph(esc(rationale), styles["body"]))
    story.append(Spacer(1, 4 * mm))


def section_lineup(story, styles, plan, budget):
    """3. Recommended plan - channels first, programmes beneath each."""
    story.append(Paragraph("Recommended plan", styles["h1"]))
    channels = plan.get("channel_plan") or []
    if not channels:
        story.append(Paragraph(
            "The model did not return a channel plan. See the caveats section.",
            styles["body"],
        ))
        return

    flagged_note = False
    rate_note = False

    for channel in channels:
        name = channel.get("channel") or "-"
        share = channel.get("share_of_audience")
        heading = f"{name}" + (f"  ·  {fmt_num(share, 2)}% share of audience" if share else "")
        block = [Paragraph(esc(heading), styles["h2"])]
        if channel.get("why_this_channel"):
            block.append(Paragraph(esc(channel["why_this_channel"]), styles["small"]))
            block.append(Spacer(1, 2 * mm))

        header = ["Programme", "Day", "Time band", "Dur", "Spots", "TVR", "Rate", "Why this slot"]
        data = [[Paragraph(f"<b>{esc(h)}</b>", styles["cell_head"]) for h in header]]
        flagged_rows = []
        rate_rows = []

        for idx, p in enumerate(channel.get("programmes") or []):
            programme = p.get("programme") or "-"
            # groundLineup() marks entries it could not match against the
            # supplied data, and rates with no observation behind them. Both
            # must be visible in the printed plan, not only in the API response.
            if p.get("in_source_data") is False:
                programme = f"{programme} \u2020"
                flagged_rows.append(idx)
                flagged_note = True

            rate = p.get("rate_lkr")
            rate_text = "-" if rate is None else f"{float(rate):,.0f}"
            if p.get("rate_supported") is False:
                rate_text = f"{rate_text} \u2021"
                rate_rows.append(idx)
                rate_note = True

            duration = p.get("duration_secs")
            data.append([
                Paragraph(esc(programme), styles["cell"]),
                Paragraph(esc(p.get("day_pattern") or "-"), styles["cell"]),
                Paragraph(esc(p.get("time_band") or "-"), styles["cell"]),
                Paragraph("-" if duration is None else f"{int(duration)}s", styles["cell"]),
                Paragraph("-" if p.get("spots") is None else str(p.get("spots")), styles["cell"]),
                Paragraph(fmt_num(p.get("tvr"), 2), styles["cell"]),
                Paragraph(rate_text, styles["cell"]),
                Paragraph(esc(p.get("rationale") or ""), styles["cell"]),
            ])

        table = Table(
            data,
            colWidths=[32 * mm, 20 * mm, 30 * mm, 10 * mm, 12 * mm, 13 * mm, 18 * mm,
                       CONTENT_WIDTH - 135 * mm],
            repeatRows=1,
        )
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), INK),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("GRID", (0, 0), (-1, -1), 0.4, RULE),
            ("ALIGN", (3, 1), (6, -1), "RIGHT"),
        ]
        for r in range(1, len(data)):
            if r % 2 == 0:
                style.append(("BACKGROUND", (0, r), (-1, r), BAND))
        for idx in flagged_rows:
            style.append(("TEXTCOLOR", (0, idx + 1), (0, idx + 1), ACCENT))
        for idx in rate_rows:
            style.append(("TEXTCOLOR", (6, idx + 1), (6, idx + 1), ACCENT))
        table.setStyle(TableStyle(style))
        block.append(table)

        story.append(KeepTogether(block))
        story.append(Spacer(1, 5 * mm))

    if budget:
        story.append(budget_summary_table(styles, budget, plan))

    notes = []
    if flagged_note:
        notes.append("\u2020 This entry could not be matched against the supplied rating data. "
                     "Verify it before the plan goes to the client.")
    if rate_note:
        notes.append("\u2021 This rate has no observed spot cost behind it in the media watch data.")
    if notes:
        story.append(Spacer(1, 3 * mm))
        for note in notes:
            story.append(Paragraph(note, styles["small"]))
    story.append(Spacer(1, 4 * mm))


def section_schedule(story, styles, schedule):
    """4. The dated schedule - channel, programme, day, duration, spots per date."""
    lines = schedule.get("lines") or []
    if not lines:
        return
    dates = schedule.get("dates") or []

    story.append(PageBreak())
    story.append(Paragraph("Schedule", styles["h1"]))
    story.append(Paragraph(
        "Spots placed across the campaign. The grid shows how many run on each date.",
        styles["small"],
    ))
    story.append(Spacer(1, 3 * mm))

    # A long flight has more dates than fit across a page, so the grid is split
    # into chunks that stay legible rather than being shrunk to nothing.
    per_page = 14
    chunks = [dates[i:i + per_page] for i in range(0, len(dates), per_page)] or [[]]

    for chunk_no, chunk in enumerate(chunks):
        if chunk_no:
            story.append(PageBreak())
            story.append(Paragraph(
                f"Schedule (continued, {chunk[0]} onwards)", styles["h2"]))
            story.append(Spacer(1, 2 * mm))

        header = ["Channel", "Programme", "Day", "Dur", "Spots"] + [d[5:] for d in chunk]
        data = [[Paragraph(f"<b>{esc(h)}</b>", styles["cell_head"]) for h in header]]

        for line in lines:
            grid = line.get("spot_dates") or {}
            duration = line.get("duration_secs")
            row = [
                Paragraph(esc(line.get("channel_name") or "-"), styles["cell"]),
                Paragraph(esc(line.get("programme_name") or "-"), styles["cell"]),
                Paragraph(esc(line.get("day_pattern") or "-"), styles["cell"]),
                Paragraph("-" if duration is None else f"{int(duration)}s", styles["cell"]),
                Paragraph(str(line.get("spots") or 0), styles["cell"]),
            ]
            for d in chunk:
                n = grid.get(d)
                row.append(Paragraph(str(n) if n else "", styles["cell"]))
            data.append(row)

        fixed = 24 * mm + 34 * mm + 20 * mm + 10 * mm + 12 * mm
        date_width = max(6 * mm, (CONTENT_WIDTH - fixed) / max(1, len(chunk)))
        table = Table(
            data,
            colWidths=[24 * mm, 34 * mm, 20 * mm, 10 * mm, 12 * mm] + [date_width] * len(chunk),
            repeatRows=1,
        )
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), INK),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("GRID", (0, 0), (-1, -1), 0.4, RULE),
            ("ALIGN", (3, 1), (-1, -1), "CENTER"),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
        ]
        for r in range(1, len(data)):
            if r % 2 == 0:
                style.append(("BACKGROUND", (0, r), (-1, r), BAND))
        table.setStyle(TableStyle(style))
        story.append(table)

    totals = schedule.get("totals") or {}
    if totals.get("channels"):
        story.append(Spacer(1, 6 * mm))
        story.append(Paragraph("Channel totals", styles["h2"]))
        rows = [
            [c.get("channel_name"), str(c.get("lines") or 0), str(c.get("spots") or 0),
             fmt_num(c.get("cost_lkr"), 0)]
            for c in totals["channels"]
        ]
        rows.append(["TOTAL", "", str(totals.get("total_spots") or 0),
                     fmt_num(totals.get("total_cost_lkr"), 0)])
        story.append(simple_table(
            styles, ["Channel", "Lines", "Spots", "Cost (LKR)"], rows,
            [50 * mm, 22 * mm, 22 * mm, CONTENT_WIDTH - 94 * mm],
            numeric_from=1,
        ))


def section_clutter(story, styles, plan, clutter):
    """Where the buy sits across time belts, and whether that is defensible."""
    if not clutter and not plan.get("clutter_strategy"):
        return
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Clutter &amp; spread", styles["h1"]))

    if plan.get("clutter_strategy"):
        story.append(Paragraph(esc(plan["clutter_strategy"]), styles["body"]))

    by_belt = (clutter or {}).get("by_belt") or []
    if by_belt:
        rows = [[b.get("time_belt"), str(b.get("spots") or 0), f"{fmt_num(b.get('share_pct'), 1)}%"]
                for b in by_belt]
        story.append(simple_table(
            styles, ["Time belt", "Spots", "Share of plan"], rows,
            [70 * mm, 25 * mm, CONTENT_WIDTH - 95 * mm],
            numeric_from=1,
        ))

    issues = (clutter or {}).get("issues") or []
    if issues:
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph(
            "The automated check flagged the following concentrations:", styles["small"]))
        for issue in issues:
            story.append(Paragraph(f"\u2022 {esc(issue.get('detail'))}", styles["body"]))
    elif clutter:
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(
            "The automated check found no over-concentration in any single belt.",
            styles["small"],
        ))


def budget_summary_table(styles, budget, plan):
    """Committed spend against the brief's budget, totalled independently."""
    total_lakhs = budget.get("total_cost_lakhs")
    budget_lakhs = budget.get("budget_lakhs")
    util = budget.get("utilisation_pct")
    over = budget.get("over_budget")

    if budget_lakhs is None:
        summary = f"Plan total: LKR {fmt_num(total_lakhs, 2)} lakhs. No budget was stated in the brief."
        colour = MUTED
    else:
        summary = (
            f"Plan total: LKR {fmt_num(total_lakhs, 2)} lakhs of "
            f"{fmt_num(budget_lakhs, 2)} lakhs budget ({fmt_num(util, 1)}%)"
        )
        colour = CONFIDENCE_COLOURS["low"] if over else CONFIDENCE_COLOURS["high"]

    uncosted = budget.get("uncosted_lines") or 0
    if uncosted:
        summary += f". {uncosted} line(s) carry no cost and are excluded from this total."

    rows = [[Paragraph(f'<font color="white"><b>{esc(summary)}</b></font>', styles["cell"])]]
    fit = plan.get("budget_fit")
    table = Table(rows, colWidths=[CONTENT_WIDTH])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colour),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ]))
    if not fit:
        return table
    return KeepTogether([table, Spacer(1, 2 * mm), Paragraph(esc(fit), styles["small"])])


def section_charts(story, styles, chart_paths):
    """4. Charts - competitor spend, programme ratings, medium split."""
    story.append(PageBreak())
    story.append(Paragraph("Charts", styles["h1"]))

    captions = [
        ("competitor_spend", "Competitor spend by quarter",
         "Category spend from adex over the analysis window. The brief's own brand is highlighted."),
        ("programme_ratings", "Programme ratings for the target audience",
         "Average ratings for the audience panel. Highlighted bars are in the recommended lineup."),
        ("day_of_week", "Audience by day of week",
         "Ratings by day for the channels in the plan. Shaded days are the ones the plan buys."),
        ("time_belts", "Time-belt spread",
         "Where this plan's spots sit against where competitors already are. A plan stacked into "
         "one belt repeats the same audience instead of building reach."),
    ]

    for idx, (key, heading, caption) in enumerate(captions):
        path = chart_paths.get(key)
        if not path or not os.path.exists(path):
            continue
        block = [
            Paragraph(heading, styles["h2"]),
            Paragraph(caption, styles["small"]),
            Spacer(1, 2 * mm),
            scaled_image(path),
        ]
        story.append(KeepTogether(block))
        story.append(Spacer(1, 7 * mm))
        # Two charts to a page keeps each one legible.
        if idx % 2 == 1 and idx < len(captions) - 1:
            story.append(PageBreak())


def scaled_image(path, max_width=None, max_height=170 * mm):
    """Fit a PNG to the content width without distorting it."""
    max_width = max_width or CONTENT_WIDTH
    img = Image(path)
    ratio = img.imageHeight / float(img.imageWidth)
    width = max_width
    height = width * ratio
    if height > max_height:
        height = max_height
        width = height / ratio
    img.drawWidth = width
    img.drawHeight = height
    return img


def section_competitor_analysis(story, styles, plan):
    """5. Competitor analysis - full text."""
    story.append(PageBreak())
    story.append(Paragraph("Competitor analysis", styles["h1"]))
    text = plan.get("competitor_analysis") or "No competitor analysis was returned for this plan."
    story.append(Paragraph(esc(text), styles["body"]))


def section_caveats(story, styles, plan, data_notes):
    """6. Confidence & caveats - limitations stay visible, not buried."""
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Confidence &amp; caveats", styles["h1"]))
    confidence = (plan.get("confidence") or "low").lower()
    story.append(confidence_badge(confidence, styles))
    story.append(Spacer(1, 5 * mm))

    caveats = plan.get("gaps_or_caveats")
    story.append(Paragraph(
        esc(caveats) if caveats else "The model did not flag any gaps or caveats.",
        styles["body"],
    ))

    if data_notes:
        story.append(Paragraph("Data coverage notes", styles["h2"]))
        for note in data_notes:
            story.append(Paragraph(f"• {esc(note)}", styles["body"]))


def section_appendix(story, styles, aggregated):
    """7. Appendix - the raw aggregated numbers, for audit."""
    story.append(PageBreak())
    story.append(Paragraph("Appendix: aggregated data used", styles["h1"]))
    story.append(Paragraph(
        "These are the figures passed to the model. Anything not present here was not "
        "available to it.",
        styles["small"],
    ))
    story.append(Spacer(1, 4 * mm))

    scope = aggregated.get("scope") or {}
    scope_rows = [
        ("Brand", scope.get("brand")),
        ("Category", scope.get("category")),
        ("Sector", scope.get("sector")),
        ("Window", f"{scope.get('period_from') or '-'} to {scope.get('period_to') or '-'}"),
        ("Quarters covered", scope.get("quarters_covered")),
        ("Target audience", scope.get("target_audience")),
        ("Language", scope.get("language")),
    ]
    story.append(simple_table(
        styles,
        ["Scope", "Value"],
        [[k, v if v not in (None, "") else "-"] for k, v in scope_rows],
        [46 * mm, CONTENT_WIDTH - 46 * mm],
    ))
    story.append(Spacer(1, 6 * mm))

    competitors = aggregated.get("competitor_spend_by_quarter") or []
    if competitors:
        story.append(Paragraph("Competitor spend by quarter (LKR 000)", styles["h2"]))
        rows = [
            [c.get("brand"), c.get("quarter"), fmt_num(c.get("tv_spend_000")),
             fmt_num(c.get("radio_spend_000")), fmt_num(c.get("press_spend_000")),
             fmt_num(c.get("total_spend_000"))]
            for c in competitors[:60]
        ]
        story.append(simple_table(
            styles, ["Brand", "Quarter", "TV", "Radio", "Press", "Total"], rows,
            [40 * mm, 22 * mm, 24 * mm, 24 * mm, 24 * mm, CONTENT_WIDTH - 134 * mm],
            numeric_from=2,
        ))
        if len(competitors) > 60:
            story.append(Paragraph(f"Showing 60 of {len(competitors)} rows.", styles["small"]))
        story.append(Spacer(1, 6 * mm))

    own = aggregated.get("own_brand_trend") or []
    if own:
        story.append(Paragraph("Own brand spend trend (LKR 000)", styles["h2"]))
        rows = [
            [o.get("quarter"), fmt_num(o.get("tv_spend_000")), fmt_num(o.get("radio_spend_000")),
             fmt_num(o.get("press_spend_000")), fmt_num(o.get("total_spend_000"))]
            for o in own
        ]
        story.append(simple_table(
            styles, ["Quarter", "TV", "Radio", "Press", "Total"], rows,
            [30 * mm, 30 * mm, 30 * mm, 30 * mm, CONTENT_WIDTH - 120 * mm],
            numeric_from=1,
        ))
        story.append(Spacer(1, 6 * mm))

    programmes = aggregated.get("programme_ratings") or []
    if programmes:
        story.append(Paragraph("Programme ratings shortlist", styles["h2"]))
        rows = [
            [p.get("channel_name"), p.get("programme_name"),
             (p.get("programme_category") or "-")[:22],
             fmt_num(p.get("avg_rating"), 2), str(p.get("instances") or "-"),
             fmt_num(p.get("observed_avg_cost"), 0), fmt_num(p.get("cost_per_rating_point"), 0)]
            for p in programmes
        ]
        story.append(simple_table(
            styles,
            ["Channel", "Programme", "Category", "Rating", "Airings", "Avg cost", "Cost/point"],
            rows,
            [24 * mm, 34 * mm, 30 * mm, 16 * mm, 16 * mm, 20 * mm, CONTENT_WIDTH - 140 * mm],
            numeric_from=3,
        ))
        story.append(Spacer(1, 6 * mm))

    days = aggregated.get("best_days") or []
    if days:
        story.append(Paragraph("Ratings by day of week", styles["h2"]))
        rows = [
            [d.get("channel_name"), d.get("day_of_week"), fmt_num(d.get("ratings"), 0),
             fmt_num(d.get("reach"), 0), fmt_num(d.get("reach_pct"), 1), str(d.get("day_rank") or "-")]
            for d in days[:60]
        ]
        story.append(simple_table(
            styles, ["Channel", "Day", "Ratings", "Reach", "Reach %", "Rank"], rows,
            [34 * mm, 26 * mm, 26 * mm, 26 * mm, 22 * mm, CONTENT_WIDTH - 134 * mm],
            numeric_from=2,
        ))
        if len(days) > 60:
            story.append(Paragraph(f"Showing 60 of {len(days)} rows.", styles["small"]))
        story.append(Spacer(1, 6 * mm))

    dayparts = aggregated.get("best_dayparts") or []
    if dayparts:
        story.append(Paragraph("Ratings by day-part", styles["h2"]))
        rows = [
            [d.get("channel_name"), d.get("day_group") or "-", d.get("time_of_day"),
             fmt_num(d.get("ratings"), 0), fmt_num(d.get("reach_pct"), 1)]
            for d in dayparts[:60]
        ]
        story.append(simple_table(
            styles, ["Channel", "Days", "Time band", "Ratings", "Reach %"], rows,
            [30 * mm, 22 * mm, 48 * mm, 24 * mm, CONTENT_WIDTH - 124 * mm],
            numeric_from=3,
        ))
        if len(dayparts) > 60:
            story.append(Paragraph(f"Showing 60 of {len(dayparts)} rows.", styles["small"]))
        story.append(Spacer(1, 6 * mm))

    rates = aggregated.get("programme_rates") or []
    if rates:
        story.append(Paragraph("Observed spot rates (media watch)", styles["h2"]))
        story.append(Paragraph(
            "What other advertisers were actually charged. This is an observation, not a rate card.",
            styles["small"],
        ))
        story.append(Spacer(1, 2 * mm))
        rows = [
            [r.get("medium") or "-", r.get("channel_name"), r.get("programme_name"),
             f"{r.get('duration_secs') or '-'}s", str(r.get("spots_observed") or "-"),
             fmt_num(r.get("avg_cost"), 0), fmt_num(r.get("min_cost"), 0), fmt_num(r.get("max_cost"), 0)]
            for r in rates[:60]
        ]
        story.append(simple_table(
            styles, ["Medium", "Channel", "Programme", "Dur", "Spots", "Avg", "Min", "Max"], rows,
            [16 * mm, 26 * mm, 34 * mm, 12 * mm, 14 * mm, 20 * mm, 20 * mm,
             CONTENT_WIDTH - 142 * mm],
            numeric_from=3,
        ))
        if len(rates) > 60:
            story.append(Paragraph(f"Showing 60 of {len(rates)} rows.", styles["small"]))
        story.append(Spacer(1, 6 * mm))

    pressure = aggregated.get("competitor_spot_pressure") or []
    if pressure:
        story.append(Paragraph("Competitor activity by programme", styles["h2"]))
        rows = [
            [p.get("channel_name"), p.get("programme_name"), str(p.get("spots") or "-"),
             str(p.get("brands") or "-"), fmt_num(p.get("total_grp"), 2),
             ", ".join((p.get("top_brands") or [])[:4])]
            for p in pressure[:40]
        ]
        story.append(simple_table(
            styles, ["Channel", "Programme", "Spots", "Brands", "Total GRP", "Who is buying"], rows,
            [24 * mm, 32 * mm, 14 * mm, 16 * mm, 20 * mm, CONTENT_WIDTH - 106 * mm],
            numeric_from=2,
        ))


def simple_table(styles, header, rows, col_widths, numeric_from=None):
    data = [[Paragraph(f"<b>{esc(h)}</b>", styles["cell_head"]) for h in header]]
    for row in rows:
        data.append([Paragraph(esc(c), styles["cell"]) for c in row])

    table = Table(data, colWidths=col_widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
    ]
    if numeric_from is not None:
        style.append(("ALIGN", (numeric_from, 1), (-1, -1), "RIGHT"))
    for r in range(1, len(data)):
        if r % 2 == 0:
            style.append(("BACKGROUND", (0, r), (-1, r), BAND))
    table.setStyle(TableStyle(style))
    return table


def format_period(brief):
    start = brief.get("period_start")
    end = brief.get("period_end")
    if start and end:
        return f"{start} to {end}"
    if start:
        return f"From {start}"
    return "Not stated"


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def build_report(payload, out_path, charts_dir):
    brief = payload.get("brief") or {}
    plan = payload.get("plan") or {}
    chart_data = payload.get("chart_data") or {}
    aggregated = payload.get("aggregated") or {}
    meta = payload.get("meta") or {}
    budget = payload.get("budget") or {}
    schedule = payload.get("schedule") or {}
    clutter = payload.get("clutter") or {}

    chart_paths = render_all(chart_data, charts_dir)
    styles = build_styles()

    brand = brief.get("brand") or "Media plan"
    doc = SimpleDocTemplate(
        out_path,
        pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN + 6 * mm,
        title=f"{brand} - Media Plan Recommendation",
        author="Media Planning & Analysis Assistant",
        subject="Media plan recommendation",
    )
    doc.footer_left = f"{brand} - Media Plan Recommendation"

    story = []
    section_cover(story, styles, brief, plan, meta)
    section_executive_summary(story, styles, plan)
    section_lineup(story, styles, plan, budget)
    section_schedule(story, styles, schedule)
    section_clutter(story, styles, plan, clutter)
    section_charts(story, styles, chart_paths)
    section_competitor_analysis(story, styles, plan)
    section_caveats(story, styles, plan, aggregated.get("data_notes") or [])
    section_appendix(story, styles, aggregated)

    doc.build(story, onFirstPage=page_decoration, onLaterPages=page_decoration)
    return out_path


def main():
    parser = argparse.ArgumentParser(description="Render a media plan PDF report.")
    parser.add_argument("--payload", required=True, help="Path to the JSON payload")
    parser.add_argument("--out", required=True, help="Path to write the PDF to")
    parser.add_argument("--charts-dir", help="Directory for intermediate chart PNGs")
    args = parser.parse_args()

    with open(args.payload, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    charts_dir = args.charts_dir or tempfile.mkdtemp(prefix="mp-charts-")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)

    try:
        build_report(payload, args.out, charts_dir)
    except Exception as exc:  # noqa: BLE001 - surface the reason to the Node caller
        print(f"report generation failed: {exc}", file=sys.stderr)
        raise

    print(json.dumps({"ok": True, "path": args.out}))


if __name__ == "__main__":
    main()
