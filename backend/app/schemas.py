"""Pydantic request/response models for the endpoints that need structure.
Many analysis endpoints accept simple query params and return plain dicts."""
from __future__ import annotations

from pydantic import BaseModel


class JobOut(BaseModel):
    job_id: str
    status: str
    kind: str
    filename: str
    error: str | None = None


class RateCardConfirm(BaseModel):
    filename: str | None = None
    blocks: list[dict]  # reviewed/corrected per-sheet blocks


class GenericConfirm(BaseModel):
    filename: str | None = None
    payload: dict | None = None  # optional overrides; if absent, uses staged payload


class BasketRequest(BaseModel):
    selections: list[dict]  # [{channel, programme}]


class PrimeWindow(BaseModel):
    start: str
    end: str


class PromptGuideIn(BaseModel):
    text: str


class AdHocQuestion(BaseModel):
    question: str
    run_sql: bool = False  # when True, allow the ad-hoc restricted-SQL path


class NarrateRequest(BaseModel):
    question: str
    product_groups: list[str] | None = None
    advertisers: list[str] | None = None


class ReportRequest(BaseModel):
    product_groups: list[str]
    lead_advertiser: str | None = None
    format: str = "pdf"  # pdf | docx
