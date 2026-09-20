"""Pitch report generation - PDF (reportlab) and Word (python-docx).

Charts are rendered server-side via charts.py (matplotlib) and embedded into
both formats so the exported document matches the in-app visuals. Narrative
sections come from Gemini (narrative only - all numbers are pre-computed).
"""
from __future__ import annotations

import io

from sqlalchemy.orm import Session

from .. import charts
from ..llm import gemini, prompt_guide
from . import adex_analysis, basket


def _gather(db: Session, product_groups: list[str], lead_advertiser: str | None) -> dict:
    return {
        "product_groups": product_groups,
        "lead_advertiser": lead_advertiser,
        "medium_split": adex_analysis.medium_split(db, product_groups),
        "trend": adex_analysis.spend_trend(db, product_groups, by="month"),
        "top_advertisers": adex_analysis.top_advertisers(db, product_groups, limit=10),
        "sos_tv": adex_analysis.share_of_spend(db, product_groups, medium="TV", limit=5),
        "value_addition": adex_analysis.value_addition(db, product_groups),
        "competitor": adex_analysis.competitor_view(db, product_groups, lead_advertiser) if lead_advertiser else None,
    }


def _chart_pngs(data: dict) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    ms = data["medium_split"]
    if ms:
        out["medium"] = charts.bar_chart(
            [m["medium"] for m in ms], [m["spend"] for m in ms],
            title="Spend by Medium", money=True,
        )
    tr = data["trend"]
    if tr["labels"]:
        out["trend"] = charts.line_chart(
            tr["labels"], tr["series"], title="Spend Trend", money=True,
        )
    ta = data["top_advertisers"]
    if ta:
        out["top_adv"] = charts.bar_chart(
            [a["advertiser"] for a in ta], [a["spend"] for a in ta],
            title="Top Advertisers by Spend", money=True,
        )
    sos = data["sos_tv"]
    if sos:
        out["sos"] = charts.pie_chart(
            [s["advertiser"] for s in sos], [s["share_pct"] for s in sos],
            title="Top 5 Share of Spend - TV",
        )
    return out


def _narrative(db: Session, data: dict) -> str:
    logic = prompt_guide.get_logic(db)
    fmt = prompt_guide.get_format(db)
    q = (
        f"Write a pitch narrative for category {data['product_groups']} "
        + (f"with lead advertiser {data['lead_advertiser']}." if data["lead_advertiser"] else ".")
    )
    return gemini.narrate(logic, fmt, q, data)


def build_pdf(db: Session, product_groups: list[str], lead_advertiser: str | None) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    data = _gather(db, product_groups, lead_advertiser)
    pngs = _chart_pngs(data)
    narrative = _narrative(db, data)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=1.6 * cm, bottomMargin=1.6 * cm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("t", parent=styles["Title"], textColor=colors.HexColor("#1f3a5f"))
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], textColor=colors.HexColor("#1f3a5f"))
    body = styles["BodyText"]

    story = [
        Paragraph("Category Pitch Analysis", title_style),
        Paragraph("Category: " + ", ".join(product_groups), body),
    ]
    if lead_advertiser:
        story.append(Paragraph("Lead advertiser: " + lead_advertiser, body))
    story.append(Spacer(1, 0.4 * cm))

    story.append(Paragraph("Narrative", h2))
    for para in narrative.split("\n"):
        if para.strip():
            story.append(Paragraph(para.strip(), body))
    story.append(Spacer(1, 0.4 * cm))

    def add_chart(key, heading):
        if key in pngs:
            story.append(Paragraph(heading, h2))
            story.append(Image(io.BytesIO(pngs[key]), width=16 * cm, height=8 * cm, kind="proportional"))
            story.append(Spacer(1, 0.3 * cm))

    add_chart("medium", "Medium Split")
    add_chart("trend", "Spend Trend")
    add_chart("top_adv", "Top Advertisers")
    add_chart("sos", "Share of Spend")

    # Top advertisers table
    ta = data["top_advertisers"]
    if ta:
        story.append(Paragraph("Top Advertisers (table)", h2))
        table_data = [["Advertiser", "Spend", "Spots"]] + [
            [a["advertiser"], f"{a['spend']:,.0f}", a["spots"]] for a in ta
        ]
        tbl = Table(table_data, hAlign="LEFT")
        tbl.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f3a5f")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d7dbe0")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f4f6f8")]),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                ]
            )
        )
        story.append(tbl)

    va = data["value_addition"]
    story.append(Spacer(1, 0.3 * cm))
    story.append(
        Paragraph(
            f"Bonus value received (V/A, excluded from spend): "
            f"{va['va_spots']} spots / {va['va_seconds']:.0f} seconds.",
            body,
        )
    )

    doc.build(story)
    buf.seek(0)
    return buf.read()


def build_docx(db: Session, product_groups: list[str], lead_advertiser: str | None) -> bytes:
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor

    data = _gather(db, product_groups, lead_advertiser)
    pngs = _chart_pngs(data)
    narrative = _narrative(db, data)

    doc = Document()
    title = doc.add_heading("Category Pitch Analysis", level=0)
    for run in title.runs:
        run.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
    doc.add_paragraph("Category: " + ", ".join(product_groups))
    if lead_advertiser:
        doc.add_paragraph("Lead advertiser: " + lead_advertiser)

    doc.add_heading("Narrative", level=1)
    for para in narrative.split("\n"):
        if para.strip():
            doc.add_paragraph(para.strip())

    def add_chart(key, heading):
        if key in pngs:
            doc.add_heading(heading, level=1)
            doc.add_picture(io.BytesIO(pngs[key]), width=Inches(6.3))

    add_chart("medium", "Medium Split")
    add_chart("trend", "Spend Trend")
    add_chart("top_adv", "Top Advertisers")
    add_chart("sos", "Share of Spend")

    ta = data["top_advertisers"]
    if ta:
        doc.add_heading("Top Advertisers (table)", level=1)
        table = doc.add_table(rows=1, cols=3)
        table.style = "Light Grid Accent 1"
        hdr = table.rows[0].cells
        hdr[0].text, hdr[1].text, hdr[2].text = "Advertiser", "Spend", "Spots"
        for a in ta:
            cells = table.add_row().cells
            cells[0].text = str(a["advertiser"])
            cells[1].text = f"{a['spend']:,.0f}"
            cells[2].text = str(a["spots"])

    va = data["value_addition"]
    p = doc.add_paragraph()
    run = p.add_run(
        f"Bonus value received (V/A, excluded from spend): "
        f"{va['va_spots']} spots / {va['va_seconds']:.0f} seconds."
    )
    run.font.size = Pt(9)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()
