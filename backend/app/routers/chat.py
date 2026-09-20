"""Ad-hoc questions.

Two modes:
  * Narrative over a pivot (default) - handled by the tab-specific /narrate.
  * True ad-hoc SQL - Gemini writes ONE read-only SELECT, which is executed
    through the restricted SQL guard, then Gemini narrates the returned rows.

The restricted SQL path is opt-in per request (run_sql=true) and always runs
against the SELECT-only role / read-only transaction.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..llm import gemini, prompt_guide
from ..services import restricted_sql

router = APIRouter(prefix="/api/chat", tags=["chat"])

_SCHEMA_HINT = (
    "adex_rows(product_group, advertiser, product, advt_theme, va_com, medium, "
    "channel, program, spot_date, cost, dur). Spend = SUM(cost) WHERE va_com='Com'.\n"
    "media_watch_rows(channel, program, spot_date, tvr, tvr_share_pct, reach, reach_pct, prime_non_prime).\n"
    "rate_cards(channel, programme, effective_date, rate_30s_equivalent, prime_non_prime)."
)


@router.post("/ask")
def ask(body: dict = Body(...), db: Session = Depends(get_db)):
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(400, "question is required")
    run_sql = bool(body.get("run_sql"))

    logic = prompt_guide.get_logic(db)
    fmt = prompt_guide.get_format(db)

    if not run_sql:
        # No pivot context given -> just answer conversationally within guide rules.
        text = gemini.narrate(logic, fmt, question, {"note": "no pre-computed pivot supplied"})
        return {"mode": "narrative", "answer": text}

    # Ad-hoc SQL path.
    try:
        sql = gemini.write_sql(logic, _SCHEMA_HINT, question)
    except gemini.GeminiUnavailable as exc:
        raise HTTPException(503, f"ad-hoc SQL needs Gemini: {exc}")

    try:
        result = restricted_sql.run(sql)
    except restricted_sql.UnsafeQuery as exc:
        raise HTTPException(422, f"generated query rejected by guard: {exc}")

    narrative = gemini.narrate(logic, fmt, question, {"sql_result": result})
    return {"mode": "sql", "sql": sql, "result": result, "answer": narrative}
