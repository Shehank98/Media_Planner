"""Pitch report generation - a properly organised document with REAL embedded
charts (never text descriptions of charts) and AI-written narrative.

Output formats: HTML (in-app preview), PDF (reportlab), Word (python-docx).
All three share one data-gathering pass and one chart-building pass, so they
are consistent. Numbers are computed in Python; the LLM only writes prose, and
is instructed to avoid chart descriptions and em dashes.
"""
from __future__ import annotations

import base64
import datetime as dt
import html
import io

from sqlalchemy.orm import Session

from .. import charts, palette
from ..llm import gemini, prompt_guide
from . import adex_analysis as ax
from . import basket, colors, market

# --------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------
def gather(db: Session, product_groups: list[str], lead_advertiser: str | None) -> dict:
    ov = market.overview(db, product_groups)
    top_adv = ax.top_advertisers(db, product_groups, limit=12)
    total = sum(a["spend"] for a in top_adv) or ov["total_spend"] or 0.0
    for a in top_adv:
        a["share_pct"] = round(100 * a["spend"] / total, 1) if total else 0.0

    names = [a["advertiser"] for a in top_adv[:6]]
    data = {
        "product_groups": product_groups,
        "lead_advertiser": lead_advertiser,
        "generated_on": dt.date.today().isoformat(),
        "overview": ov,
        "trend": ax.spend_trend(db, product_groups, by="month"),
        "medium_split": ax.medium_split(db, product_groups),
        "top_advertisers": top_adv,
        "sos_tv": ax.share_of_spend(db, product_groups, medium="TV", limit=5),
        "sov_trend": market.sov_trend(db, product_groups, top_n=5),
        "category_channels": ax.category_channels(db, product_groups, limit=8),
        "benchmark": ax.benchmark(db, product_groups, names),
        "value_addition": ax.value_addition(db, product_groups),
        "growth": market.growth(db, product_groups),
    }

    if lead_advertiser:
        data["deep_dive"] = {
            "advertiser": lead_advertiser,
            "trend": ax.spend_trend(db, product_groups, [lead_advertiser], by="month"),
            "medium_split": ax.medium_split(db, product_groups, [lead_advertiser]),
            "channels": ax.advertiser_channels(db, product_groups, lead_advertiser, 5),
            "programmes": ax.advertiser_programmes(db, product_groups, lead_advertiser, 5),
            "value_addition": ax.value_addition(db, product_groups, [lead_advertiser]),
        }

    # Recommended basket (only if TVR data exists)
    progs = [p for p in basket.best_programmes(db, limit=40) if p.get("cprp") is not None]
    progs.sort(key=lambda x: x["cprp"])
    data["recommended_basket"] = progs[:8]

    # Stable colour maps so report charts match the app and each other.
    data["_amap"] = colors.advertiser_colors(db)
    data["_cmap"] = colors.channel_colors(db)
    return data


# --------------------------------------------------------------------------
# Charts (built once, reused across formats)
# --------------------------------------------------------------------------
def build_charts(data: dict) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    amap = data.get("_amap", {})
    cmap = data.get("_cmap", {})
    def acols(names):
        return [amap.get(n, palette.OTHERS) for n in names]
    def ccols(names):
        return [cmap.get(n, palette.OTHERS) for n in names]
    tr = data["trend"]
    if tr["labels"]:
        out["trend"] = charts.line_chart(tr["labels"], tr["series"], title="Total category spend by month", money=True)
    ms = data["medium_split"]
    if ms:
        out["medium"] = charts.pie_chart([m["medium"] for m in ms], [m["spend"] for m in ms],
                                         title="Medium split", color_kind="medium")
    ta = data["top_advertisers"]
    if ta:
        names = [a["advertiser"] for a in ta[:8]]
        out["ranking"] = charts.bar_chart(names, [a["share_pct"] for a in ta[:8]],
                                          title="Advertisers by share of spend (%)", colors=acols(names))
    sov = data["sov_trend"]
    if sov["labels"]:
        out["sov"] = charts.line_chart(sov["labels"], sov["series"], title="Share of voice over time (%)",
                                       ylabel="% of spend", colors=acols(list(sov["series"].keys())))
    cc = data["category_channels"]
    if cc:
        names = [c["channel"] for c in cc]
        out["channels"] = charts.bar_chart(names, [c["spend"] for c in cc],
                                          title="Top channels by category spend", money=True, colors=ccols(names))
    dd = data.get("deep_dive")
    if dd:
        if dd["trend"]["labels"]:
            out["dd_trend"] = charts.line_chart(dd["trend"]["labels"], dd["trend"]["series"],
                                                title=f"{dd['advertiser']} spend by month", money=True)
        if dd["medium_split"]:
            out["dd_medium"] = charts.pie_chart([m["medium"] for m in dd["medium_split"]],
                                                [m["spend"] for m in dd["medium_split"]],
                                                title=f"{dd['advertiser']} medium split", color_kind="medium")
        if dd["channels"]:
            names = [c["channel"] for c in dd["channels"]]
            out["dd_channels"] = charts.bar_chart(names, [c["spend"] for c in dd["channels"]],
                                                  title=f"{dd['advertiser']} top channels", money=True, colors=ccols(names))
    rb = data["recommended_basket"]
    if rb:
        out["cprp"] = charts.bar_chart([f"{p['programme']} ({p['channel']})" for p in rb],
                                       [p["cprp"] for p in rb], title="Most cost-efficient programmes (CPRP)",
                                       colors=ccols([p["channel"] for p in rb]))
    return out


# --------------------------------------------------------------------------
# Narrative (AI, with deterministic fallback)
# --------------------------------------------------------------------------
def _context_for_ai(data: dict) -> dict:
    ov = data["overview"]
    return {
        "category": data["product_groups"],
        "lead_advertiser": data["lead_advertiser"],
        "total_spend": ov["total_spend"],
        "date_range": [ov["date_from"], ov["date_to"]],
        "medium_split": data["medium_split"],
        "monthly_trend": data["trend"],
        "top_advertisers": data["top_advertisers"][:6],
        "share_of_voice": data["sov_trend"],
        "growth": data["growth"],
        "deep_dive": {k: v for k, v in (data.get("deep_dive") or {}).items() if k != "trend"},
        "benchmark": data["benchmark"],
        "recommended_basket": data["recommended_basket"][:5],
        "value_addition": data["value_addition"],
    }


def get_sections(db: Session, data: dict) -> dict:
    sections = gemini.report_sections(prompt_guide.get_logic(db), prompt_guide.get_format(db), _context_for_ai(data))
    return {**_fallback_sections(data), **sections}  # AI overrides fallback where present


def _money(v):
    return f"Rs. {v:,.0f}" if v is not None else "n/a"


def _fallback_sections(data: dict) -> dict:
    ov = data["overview"]
    cat = ", ".join(data["product_groups"])
    ta = data["top_advertisers"]
    lead = ta[0] if ta else None
    second = ta[1] if len(ta) > 1 else None
    ms = data["medium_split"]
    top_medium = ms[0] if ms else None
    total = ov["total_spend"] or 0

    exec_s = f"The {cat} category recorded total advertising spend of {_money(total)} across TV, Radio and Press"
    if ov["date_from"]:
        exec_s += f" from {ov['date_from']} to {ov['date_to']}"
    exec_s += "."
    if lead:
        exec_s += f" {lead['advertiser']} leads with {lead['share_pct']}% share ({_money(lead['spend'])})."
    if second:
        exec_s += f" {second['advertiser']} follows with {second['share_pct']}% ({_money(second['spend'])})."
    if top_medium and total:
        exec_s += f" {top_medium['medium']} dominates the media mix at {round(100*top_medium['spend']/total)}% of spend."

    cat_s = "Spend is concentrated in " + (top_medium["medium"] if top_medium else "broadcast media") + \
            f", which is the leading medium. The category spans {ov['advertisers']} advertisers across {ov['channels']} channels."
    rank_s = "The ranking below shows each advertiser's share of category spend. " + \
             (f"{lead['advertiser']} captures the largest share at {lead['share_pct']}%." if lead else "")

    dd = data.get("deep_dive")
    dd_s = ""
    if dd:
        dd_ms = dd["medium_split"][0] if dd["medium_split"] else None
        dd_ch = dd["channels"][0] if dd["channels"] else None
        dd_s = f"{dd['advertiser']} concentrated spend on " + \
               (f"{dd_ms['medium']}" if dd_ms else "its lead medium") + \
               (f", led by {dd_ch['channel']}." if dd_ch else ".")

    ch = data["category_channels"]
    ch_s = ("The strongest channels by category spend are " +
            ", ".join(c["channel"] for c in ch[:3]) + ".") if ch else "No channel-level spend available."

    comp_s = "The benchmark compares the leading advertisers on spend, medium mix and top channel/programme."
    rb = data["recommended_basket"]
    rec_s = ("The most cost-efficient programmes (lowest CPRP) are listed below, balancing rating delivery against cost." if rb
             else "No TVR or rate card data is available yet, so a CPRP-based basket cannot be recommended.")

    return {
        "executive_summary": exec_s,
        "category_overview": cat_s,
        "advertiser_ranking": rank_s,
        "deep_dive": dd_s,
        "channel_analysis": ch_s,
        "competitor": comp_s,
        "recommendation": rec_s,
    }


# --------------------------------------------------------------------------
# HTML report (in-app preview, self-contained with data-URI charts)
# --------------------------------------------------------------------------
def _img(png: bytes | None) -> str:
    if not png:
        return '<div class="rp-nodata">No data available for this chart.</div>'
    b64 = base64.b64encode(png).decode()
    return f'<img class="rp-chart" src="data:image/png;base64,{b64}" alt="chart" />'


def _table(headers: list[str], rows: list[list], numeric: list[bool] | None = None) -> str:
    if not rows:
        return '<div class="rp-nodata">No data available.</div>'
    numeric = numeric or [False] * len(headers)
    th = "".join(f'<th class="{"num" if numeric[i] else ""}">{html.escape(str(h))}</th>' for i, h in enumerate(headers))
    trs = ""
    for r in rows:
        tds = "".join(f'<td class="{"num" if numeric[i] else ""}">{html.escape(str(c))}</td>' for i, c in enumerate(r))
        trs += f"<tr>{tds}</tr>"
    return f'<table class="rp-table"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'


def build_html(db: Session, product_groups: list[str], lead_advertiser: str | None) -> str:
    data = gather(db, product_groups, lead_advertiser)
    pngs = build_charts(data)
    s = get_sections(db, data)
    ov = data["overview"]
    cat = ", ".join(product_groups)
    total = ov["total_spend"] or 0

    def p(text):
        return f'<p class="rp-narr">{html.escape(text)}</p>' if text else ""

    # KPI strip
    kpis = [
        ("Total spend", _money(total)),
        ("Advertisers", f"{ov['advertisers']:,}"),
        ("Channels", f"{ov['channels']:,}"),
        ("Date range", f"{ov['date_from'] or 'n/a'} to {ov['date_to'] or 'n/a'}"),
    ]
    if ov["top_advertiser"]:
        kpis.append(("Leader", ov["top_advertiser"]["name"]))
    kpi_html = "".join(f'<div class="rp-kpi"><span>{html.escape(l)}</span><strong>{html.escape(str(v))}</strong></div>' for l, v in kpis)

    # ranking table
    rank_rows = [[a["advertiser"], _money(a["spend"]), f"{a['share_pct']}%"] for a in data["top_advertisers"]]
    rank_tbl = _table(["Advertiser", "Total spend", "Share"], rank_rows, [False, True, True])

    # benchmark table
    bm_rows = [[b["advertiser"], _money(b["spend"]), b["top_medium"] or "n/a", b["top_channel"] or "n/a", b["top_programme"] or "n/a"]
               for b in data["benchmark"]]
    bm_tbl = _table(["Advertiser", "Total spend", "Top medium", "Top channel", "Top programme"], bm_rows, [False, True, False, False, False])

    va = data["value_addition"]

    parts = [f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pitch Report - {html.escape(cat)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>{_REPORT_CSS}</style></head><body><div class="rp">
<header class="rp-cover">
  <div class="rp-kicker">Category pitch report</div>
  <h1>{html.escape(cat)}</h1>
  <div class="rp-meta">
    <span>Advertisers: {html.escape(lead_advertiser or "All advertisers in category")}</span>
    <span>Data range: {ov['date_from'] or 'n/a'} to {ov['date_to'] or 'n/a'}</span>
    <span>Generated: {data['generated_on']}</span>
  </div>
  <div class="rp-kpis">{kpi_html}</div>
</header>

<section class="rp-sec"><h2>1. Executive summary</h2>{p(s['executive_summary'])}</section>

<section class="rp-sec"><h2>2. Category overview</h2>{p(s['category_overview'])}
  <div class="rp-grid">{_img(pngs.get('trend'))}{_img(pngs.get('medium'))}</div>
</section>

<section class="rp-sec"><h2>3. Advertiser ranking (share of spend)</h2>{p(s['advertiser_ranking'])}
  {_img(pngs.get('ranking'))}
  {rank_tbl}
</section>"""]

    dd = data.get("deep_dive")
    if dd:
        dd_prog = _table(["Programme", "Spend", "Spots"],
                         [[x["programme"], _money(x["spend"]), x["spots"]] for x in dd["programmes"]], [False, True, True])
        dd_chan = _table(["Channel", "Spend", "Spots"],
                         [[x["channel"], _money(x["spend"]), x["spots"]] for x in dd["channels"]], [False, True, True])
        parts.append(f"""<section class="rp-sec"><h2>4. Focus advertiser: {html.escape(dd['advertiser'])}</h2>{p(s['deep_dive'])}
  <div class="rp-grid">{_img(pngs.get('dd_trend'))}{_img(pngs.get('dd_medium'))}</div>
  <div class="rp-grid"><div><h3>Top channels</h3>{dd_chan}</div><div><h3>Top programmes</h3>{dd_prog}</div></div>
  <p class="rp-narr rp-muted">Bonus value (V/A) attributed to {html.escape(dd['advertiser'])}: {dd['value_addition']['va_spots']:,} spots, {dd['value_addition']['va_seconds']:,.0f} seconds (excluded from spend).</p>
</section>""")

    parts.append(f"""<section class="rp-sec"><h2>{'5' if dd else '4'}. Channel analysis</h2>{p(s['channel_analysis'])}
  {_img(pngs.get('channels'))}
</section>

<section class="rp-sec"><h2>{'6' if dd else '5'}. Competitor benchmark</h2>{p(s['competitor'])}
  {bm_tbl}
  {_img(pngs.get('sov'))}
</section>

<section class="rp-sec"><h2>{'7' if dd else '6'}. Recommended channel / programme basket</h2>{p(s['recommendation'])}
  {_img(pngs.get('cprp'))}
  {_table(["Channel", "Programme", "Avg TVR", "CPRP"], [[b['channel'], b['programme'], b['avg_tvr'], b['cprp']] for b in data['recommended_basket']], [False, False, True, True])}
</section>

<section class="rp-sec rp-appendix"><h2>{'8' if dd else '7'}. Appendix</h2>
  <p class="rp-narr"><strong>Definitions.</strong> SOS (Share of Spend): an advertiser's percentage of total category spend.
  CPRP (Cost Per Rating Point): 30-second-equivalent rate divided by TVR, measuring cost efficiency.
  Com vs V/A: Com is paid commercial airtime; V/A is bonus airtime, excluded from all spend totals and rankings.</p>
  <p class="rp-narr rp-muted">Category-wide value addition: {va['va_spots']:,} spots, {va['va_seconds']:,.0f} seconds of bonus airtime, reported separately and not included in any spend figure.</p>
</section>
<footer class="rp-foot">Generated by the Media Analysis System - figures computed in Python; narrative written by AI over those figures.</footer>
</div></body></html>""")
    return "".join(parts)


# --------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------
def build_pdf(db: Session, product_groups: list[str], lead_advertiser: str | None) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

    data = gather(db, product_groups, lead_advertiser)
    pngs = build_charts(data)
    s = get_sections(db, data)
    ov = data["overview"]
    cat = ", ".join(product_groups)

    styles = getSampleStyleSheet()
    navy = colors.HexColor("#20242A")
    title = ParagraphStyle("t", parent=styles["Title"], textColor=navy, fontSize=24, spaceAfter=6)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], textColor=navy, spaceBefore=14)
    body = ParagraphStyle("b", parent=styles["BodyText"], fontSize=10.5, leading=15)
    meta = ParagraphStyle("m", parent=styles["BodyText"], fontSize=9, textColor=colors.HexColor("#6b7684"))

    story = [Paragraph("Category Pitch Report", title), Paragraph(cat, h2),
             Paragraph(f"Advertisers: {lead_advertiser or 'All advertisers in category'}", meta),
             Paragraph(f"Data range: {ov['date_from'] or 'n/a'} to {ov['date_to'] or 'n/a'} &nbsp;|&nbsp; Generated: {data['generated_on']}", meta),
             Spacer(1, 0.4 * cm)]

    def para(text):
        if text:
            story.append(Paragraph(html.escape(text), body))

    def chart(key, w=15):
        if key in pngs:
            story.append(Image(io.BytesIO(pngs[key]), width=w * cm, height=w * 0.52 * cm, kind="proportional"))
            story.append(Spacer(1, 0.25 * cm))

    def table(headers, rows, numeric=None):
        if not rows:
            return
        tdata = [headers] + rows
        t = Table(tdata, hAlign="LEFT")
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), navy), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d7dbe0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f4f6f8")]),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        story.append(t)
        story.append(Spacer(1, 0.3 * cm))

    story.append(Paragraph("1. Executive Summary", h2)); para(s["executive_summary"])
    story.append(Paragraph("2. Category Overview", h2)); para(s["category_overview"]); chart("trend"); chart("medium", 11)
    story.append(Paragraph("3. Advertiser Ranking", h2)); para(s["advertiser_ranking"]); chart("ranking")
    table(["Advertiser", "Total Spend", "Share"], [[a["advertiser"], _money(a["spend"]), f"{a['share_pct']}%"] for a in data["top_advertisers"]])

    n = 4
    dd = data.get("deep_dive")
    if dd:
        story.append(PageBreak())
        story.append(Paragraph(f"4. Focus Advertiser: {dd['advertiser']}", h2)); para(s["deep_dive"])
        chart("dd_trend"); chart("dd_medium", 11)
        table(["Channel", "Spend", "Spots"], [[x["channel"], _money(x["spend"]), x["spots"]] for x in dd["channels"]])
        table(["Programme", "Spend", "Spots"], [[x["programme"], _money(x["spend"]), x["spots"]] for x in dd["programmes"]])
        n = 5

    story.append(Paragraph(f"{n}. Channel Analysis", h2)); para(s["channel_analysis"]); chart("channels")
    story.append(Paragraph(f"{n+1}. Competitor Benchmark", h2)); para(s["competitor"])
    table(["Advertiser", "Spend", "Top Medium", "Top Channel"],
          [[b["advertiser"], _money(b["spend"]), b["top_medium"] or "n/a", b["top_channel"] or "n/a"] for b in data["benchmark"]])
    chart("sov")
    story.append(Paragraph(f"{n+2}. Recommended Basket", h2)); para(s["recommendation"]); chart("cprp")
    story.append(Paragraph(f"{n+3}. Appendix", h2))
    para("SOS: advertiser share of total category spend. CPRP: 30s-equivalent rate / TVR. "
         "Com is paid airtime; V/A is bonus airtime, excluded from all spend figures.")
    va = data["value_addition"]
    para(f"Category-wide value addition: {va['va_spots']:,} spots, {va['va_seconds']:,.0f} seconds of bonus airtime.")

    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, topMargin=1.5 * cm, bottomMargin=1.5 * cm).build(story)
    buf.seek(0)
    return buf.read()


# --------------------------------------------------------------------------
# Word
# --------------------------------------------------------------------------
def build_docx(db: Session, product_groups: list[str], lead_advertiser: str | None) -> bytes:
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor

    data = gather(db, product_groups, lead_advertiser)
    pngs = build_charts(data)
    s = get_sections(db, data)
    ov = data["overview"]
    cat = ", ".join(product_groups)
    navy = RGBColor(0x20, 0x24, 0x2A)

    doc = Document()
    t = doc.add_heading("Category Pitch Report", level=0)
    for r in t.runs:
        r.font.color.rgb = navy
    doc.add_heading(cat, level=1)
    doc.add_paragraph(f"Advertisers: {lead_advertiser or 'All advertisers in category'}")
    doc.add_paragraph(f"Data range: {ov['date_from'] or 'n/a'} to {ov['date_to'] or 'n/a'}  |  Generated: {data['generated_on']}")

    def chart(key, w=6.2):
        if key in pngs:
            doc.add_picture(io.BytesIO(pngs[key]), width=Inches(w))

    def table(headers, rows):
        if not rows:
            return
        tb = doc.add_table(rows=1, cols=len(headers)); tb.style = "Light Grid Accent 1"
        for i, h in enumerate(headers):
            tb.rows[0].cells[i].text = str(h)
        for r in rows:
            cells = tb.add_row().cells
            for i, c in enumerate(r):
                cells[i].text = str(c)

    doc.add_heading("1. Executive Summary", level=1); doc.add_paragraph(s["executive_summary"])
    doc.add_heading("2. Category Overview", level=1); doc.add_paragraph(s["category_overview"]); chart("trend"); chart("medium", 4.2)
    doc.add_heading("3. Advertiser Ranking", level=1); doc.add_paragraph(s["advertiser_ranking"]); chart("ranking")
    table(["Advertiser", "Total Spend", "Share"], [[a["advertiser"], _money(a["spend"]), f"{a['share_pct']}%"] for a in data["top_advertisers"]])

    n = 4
    dd = data.get("deep_dive")
    if dd:
        doc.add_heading(f"4. Focus Advertiser: {dd['advertiser']}", level=1); doc.add_paragraph(s["deep_dive"])
        chart("dd_trend"); chart("dd_medium", 4.2)
        table(["Channel", "Spend", "Spots"], [[x["channel"], _money(x["spend"]), x["spots"]] for x in dd["channels"]])
        table(["Programme", "Spend", "Spots"], [[x["programme"], _money(x["spend"]), x["spots"]] for x in dd["programmes"]])
        n = 5

    doc.add_heading(f"{n}. Channel Analysis", level=1); doc.add_paragraph(s["channel_analysis"]); chart("channels")
    doc.add_heading(f"{n+1}. Competitor Benchmark", level=1); doc.add_paragraph(s["competitor"])
    table(["Advertiser", "Spend", "Top Medium", "Top Channel"],
          [[b["advertiser"], _money(b["spend"]), b["top_medium"] or "n/a", b["top_channel"] or "n/a"] for b in data["benchmark"]])
    chart("sov")
    doc.add_heading(f"{n+2}. Recommended Basket", level=1); doc.add_paragraph(s["recommendation"]); chart("cprp")
    doc.add_heading(f"{n+3}. Appendix", level=1)
    doc.add_paragraph("SOS: advertiser share of total category spend. CPRP: 30s-equivalent rate / TVR. "
                      "Com is paid airtime; V/A is bonus airtime, excluded from all spend figures.")
    va = data["value_addition"]
    p = doc.add_paragraph(); run = p.add_run(f"Category-wide value addition: {va['va_spots']:,} spots, {va['va_seconds']:,.0f} seconds of bonus airtime.")
    run.font.size = Pt(9)

    buf = io.BytesIO(); doc.save(buf); buf.seek(0)
    return buf.read()


_REPORT_CSS = """
:root{--ink:#1A1D21;--ink2:#3B3F44;--muted:#6A6E73;--line:#E3E5E1;--line2:#CFD2CD;--paper:#F4F5F3;--accent:#0F6E63;--graphite:#20242A;--mono:'IBM Plex Mono',ui-monospace,monospace;}
*{box-sizing:border-box;} body{margin:0;background:var(--paper);font-family:'IBM Plex Sans',system-ui,sans-serif;color:var(--ink);font-size:14px;}
.rp{max-width:880px;margin:0 auto;background:#fff;border:1px solid var(--line);}
.rp-cover{background:var(--graphite);color:#EDEFF1;padding:40px 48px 32px;}
.rp-kicker{font-size:12.5px;color:#8AB6AE;font-weight:500;}
.rp-cover h1{font-size:32px;margin:8px 0 14px;font-weight:600;line-height:1.08;letter-spacing:-0.02em;color:#fff;}
.rp-meta{display:flex;flex-wrap:wrap;gap:6px 24px;font-size:12.5px;color:#A6ABB2;}
.rp-kpis{display:flex;flex-wrap:wrap;margin-top:24px;border:1px solid #363B43;border-radius:4px;overflow:hidden;}
.rp-kpi{flex:1 1 130px;padding:11px 15px;border-left:1px solid #363B43;}
.rp-kpi:first-child{border-left:none;}
.rp-kpi span{display:block;font-size:11px;color:#8B9097;}
.rp-kpi strong{display:block;font-size:17px;margin-top:3px;font-weight:600;font-family:var(--mono);color:#fff;}
.rp-sec{padding:26px 48px;border-bottom:1px solid var(--line);}
.rp-sec h2{color:var(--ink);font-size:16px;margin:0 0 12px;font-weight:600;letter-spacing:-0.01em;}
.rp-sec h3{font-size:12px;color:var(--muted);margin:16px 0 8px;font-weight:600;}
.rp-narr{font-size:14px;line-height:1.62;color:var(--ink2);margin:0 0 14px;max-width:72ch;}
.rp-muted{color:var(--muted);font-size:12.5px;}
.rp-chart{width:100%;border:1px solid var(--line);border-radius:4px;margin:8px 0;background:#fff;}
.rp-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;}
.rp-nodata{padding:16px;background:var(--paper);border:1px dashed var(--line2);border-radius:4px;color:var(--muted);font-size:12.5px;text-align:center;}
.rp-table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0;}
.rp-table th{background:var(--paper);color:var(--muted);text-align:left;padding:8px 12px;font-size:11.5px;font-weight:600;border-bottom:1px solid var(--line2);}
.rp-table td{padding:7px 12px;border-bottom:1px solid var(--line);color:var(--ink2);}
.rp-table tbody tr:nth-child(even) td{background:var(--paper);}
.rp-table .num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px;}
.rp-table th.num{font-family:inherit;}
.rp-foot{padding:20px 48px 36px;color:var(--muted);font-size:12px;}
@media(max-width:640px){.rp-cover,.rp-sec,.rp-foot{padding-left:22px;padding-right:22px;}.rp-grid{grid-template-columns:1fr;}}
"""
