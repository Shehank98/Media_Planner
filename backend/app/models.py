"""SQLAlchemy ORM models.

Every ingested row carries a `batch_id` + `uploaded_at` so an upload can be
identified and deleted independently (manual delete, no auto-expiry).
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    ARRAY,
    Boolean,
    Date,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    Time,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class Batch(Base):
    """One upload = one batch. Groups rows for identify / delete / replace."""

    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)  # rate_card|adex|media_watch
    filename: Mapped[str] = mapped_column(String(512))
    uploaded_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class RateCard(Base):
    __tablename__ = "rate_cards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(String(36), index=True)
    channel: Mapped[str] = mapped_column(String(128), index=True)
    effective_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True, index=True)
    programme: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    prime_non_prime: Mapped[str | None] = mapped_column(String(8), nullable=True)  # PT|NPT
    prime_non_prime_source: Mapped[str | None] = mapped_column(String(16), nullable=True)  # given|inferred
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    day_pattern_raw: Mapped[str | None] = mapped_column(String(128), nullable=True)
    days_of_week: Mapped[list[int] | None] = mapped_column(ARRAY(Integer), nullable=True)  # 0=Mon..6=Sun
    start_time: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    rack_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    rate_duration_secs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rate_30s_equivalent: Mapped[float | None] = mapped_column(Float, nullable=True)
    additional_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    sheet_cprp_rack_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_sheet_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    uploaded_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AdexRow(Base):
    """Advertising expenditure rows (Tab 1 / Tab 3 dataset)."""

    __tablename__ = "adex_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(String(36), index=True)
    product_group: Mapped[str | None] = mapped_column(String(256), index=True)
    advertiser: Mapped[str | None] = mapped_column(String(256), index=True)
    product: Mapped[str | None] = mapped_column(String(256), nullable=True)
    advt_theme: Mapped[str | None] = mapped_column(String(256), nullable=True)
    va_com: Mapped[str | None] = mapped_column(String(16), index=True)  # 'Com' | 'V/A'
    medium: Mapped[str | None] = mapped_column(String(64), index=True)  # TV|Radio|Press
    ads: Mapped[str | None] = mapped_column(String(256), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(128), index=True)
    program: Mapped[str | None] = mapped_column(String(256), index=True)
    spot_date: Mapped[dt.date | None] = mapped_column(Date, index=True)
    day: Mapped[str | None] = mapped_column(String(32), nullable=True)
    prog_time: Mapped[str | None] = mapped_column(String(32), nullable=True)
    advt_time: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ad_pos: Mapped[str | None] = mapped_column(String(32), nullable=True)
    tot_ads: Mapped[int | None] = mapped_column(Integer, nullable=True)
    brk_no: Mapped[str | None] = mapped_column(String(32), nullable=True)
    pos_in_brk: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ads_in_brk: Mapped[str | None] = mapped_column(String(32), nullable=True)
    lng: Mapped[str | None] = mapped_column(String(32), nullable=True)
    dur: Mapped[float | None] = mapped_column(Float, nullable=True)  # duration seconds
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    uploaded_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MediaWatchRow(Base):
    """TVR / media-watch rows (Tab 2 dataset)."""

    __tablename__ = "media_watch_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(String(36), index=True)
    rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    data_set: Mapped[str | None] = mapped_column(String(128), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(128), index=True)
    spot_date: Mapped[dt.date | None] = mapped_column(Date, index=True)
    day: Mapped[str | None] = mapped_column(String(32), nullable=True)
    start_time: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    program: Mapped[str | None] = mapped_column(String(256), index=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    category: Mapped[str | None] = mapped_column(String(128), index=True)
    tvr: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_tvr: Mapped[float | None] = mapped_column(Float, nullable=True)
    tvr_share_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    reach: Mapped[float | None] = mapped_column(Float, nullable=True)
    reach_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_time: Mapped[float | None] = mapped_column(Float, nullable=True)
    prime_non_prime: Mapped[str | None] = mapped_column(String(8), nullable=True)  # PT|NPT (derived)
    uploaded_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Job(Base):
    """Async upload job. Parsed payloads are staged on disk (var/staged/<id>.json)
    and the summary preview is stored here until the user confirms."""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    filename: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    # pending -> parsing -> awaiting_review -> committed | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    batch_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AppSetting(Base):
    """Key/value store for runtime-adjustable settings (prime-time window,
    column mappings, prompt guide text)."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
