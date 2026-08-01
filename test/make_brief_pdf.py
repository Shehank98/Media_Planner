"""Generate a campaign brief PDF fixture that mimics the messy real ones.

Deliberately awkward: fields spread across two side-by-side tables, a label
with its value stacked underneath rather than beside it, a budget quoted with a
unit word, and a medium split laid out as its own small table.

    python3 test/make_brief_pdf.py out.pdf
"""

import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def build(path):
    doc = SimpleDocTemplate(path, pagesize=A4, topMargin=18 * mm, bottomMargin=18 * mm)
    styles = getSampleStyleSheet()
    story = [
        Paragraph("CAMPAIGN BRIEF - 2024", styles["Title"]),
        Paragraph("Media Buying Department", styles["Normal"]),
        Spacer(1, 8 * mm),
    ]

    grid = TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ])

    # Two label/value columns side by side, as briefs are usually laid out.
    story.append(Table(
        [
            ["Brand", "Alpha Cola", "Advertiser", "Alpha Ltd"],
            ["Language", "Sinhala", "Territory", "National"],
            ["Campaign Period", "01 April 2024 to 30 June 2024", "Budget", "Rs. 250 Lakhs"],
        ],
        colWidths=[32 * mm, 52 * mm, 30 * mm, 46 * mm],
        style=grid,
    ))
    story.append(Spacer(1, 6 * mm))

    # Label on its own row with the value stacked beneath it.
    story.append(Table(
        [
            ["Campaign Objective"],
            ["Rebuild share of voice ahead of the April season and regain shelf momentum."],
            ["Target Audience"],
            ["Females 15-40"],
        ],
        colWidths=[160 * mm],
        style=grid,
    ))
    story.append(Spacer(1, 6 * mm))

    story.append(Paragraph("Medium Split", styles["Heading3"]))
    story.append(Table(
        [["Medium", "Share"], ["TV", "70%"], ["Radio", "20%"], ["Press", "10%"]],
        colWidths=[40 * mm, 30 * mm],
        style=grid,
    ))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(
        "Please revert with a recommended channel and programme lineup by 15 March.",
        styles["Normal"],
    ))

    doc.build(story)
    return path


if __name__ == "__main__":
    build(sys.argv[1])
