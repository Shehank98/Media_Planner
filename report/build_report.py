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


def section_lineup(story, styles, plan):
    """3. Recommended lineup - channel, programme, day-part, GRP, why."""
    story.append(Paragraph("Recommended lineup", styles["h1"]))
    lineup = plan.get("recommended_lineup") or []
    if not lineup:
        story.append(Paragraph(
            "The model did not return a programme lineup. See the caveats section.",
            styles["body"],
        ))
        return

    header = ["Channel", "Programme", "Day part", "GRP", "Why this slot"]
    data = [[Paragraph(f"<b>{esc(h)}</b>", styles["cell_head"]) for h in header]]
    flagged = []

    for idx, item in enumerate(lineup):
        programme = item.get("programme") or "-"
        # groundLineup() marks entries it could not match to the supplied
        # ratings. A planner must be able to see that in the printed plan, not
        # only in the API response.
        if item.get("in_source_data") is False:
            programme = f"{programme} †"
            flagged.append(idx)
        data.append([
            Paragraph(esc(item.get("channel") or "-"), styles["cell"]),
            Paragraph(esc(programme), styles["cell"]),
            Paragraph(esc(item.get("day_part") or "-"), styles["cell"]),
            Paragraph(fmt_num(item.get("grp")), styles["cell"]),
            Paragraph(esc(item.get("rationale") or ""), styles["cell"]),
        ])

    table = Table(
        data,
        colWidths=[26 * mm, 36 * mm, 22 * mm, 14 * mm, CONTENT_WIDTH - 98 * mm],
        repeatRows=1,
    )
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("ALIGN", (3, 1), (3, -1), "RIGHT"),
    ]
    for r in range(1, len(data)):
        if r % 2 == 0:
            style.append(("BACKGROUND", (0, r), (-1, r), BAND))
    for idx in flagged:
        style.append(("TEXTCOLOR", (1, idx + 1), (1, idx + 1), ACCENT))
    table.setStyle(TableStyle(style))
    story.append(table)

    if flagged:
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph(
            "† This entry could not be matched against the supplied rating data. "
            "Verify it before the plan goes to the client.",
            styles["small"],
        ))
    story.append(Spacer(1, 4 * mm))


def section_charts(story, styles, chart_paths):
    """4. Charts - competitor spend, programme ratings, medium split."""
    story.append(PageBreak())
    story.append(Paragraph("Charts", styles["h1"]))

    captions = [
        ("competitor_spend", "Competitor spend by quarter",
         "Category spend from adex over the analysis window. The brief's own brand is highlighted."),
        ("programme_ratings", "Programme ratings for the target audience",
         "Ranked by GRP, falling back to TRP where GRP is unavailable. Highlighted bars are in the recommended lineup."),
        ("medium_split", "Medium split",
         "The brief's stated budget split against the category's actual medium mix from adex."),
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
        if idx == 1:
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
            [p.get("channel_name"), p.get("programme_name"), p.get("day_part") or "-",
             p.get("target_audience") or "-", fmt_num(p.get("grp")), fmt_num(p.get("trp"))]
            for p in programmes
        ]
        story.append(simple_table(
            styles, ["Channel", "Programme", "Day part", "Audience", "GRP", "TRP"], rows,
            [28 * mm, 40 * mm, 22 * mm, 30 * mm, 16 * mm, CONTENT_WIDTH - 136 * mm],
            numeric_from=4,
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
    section_lineup(story, styles, plan)
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
