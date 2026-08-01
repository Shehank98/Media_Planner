-- ---------------------------------------------------------------------------
-- Media Planning & Analysis Assistant - Postgres schema
--
-- Sections 2/3/4 of the build spec. Idempotent: safe to re-run on every boot.
--
-- A note on the natural keys. The spec asks for upserts on
--   adex_data              (month, advertiser, brand, product2)
--   tv_channels            (channel_name)
--   tv_programme_ratings   (channel, programme, period)
-- In Postgres, NULL is never equal to NULL, so a UNIQUE constraint containing a
-- nullable column silently lets duplicates through - exactly the "re-syncs
-- shouldn't duplicate" failure the spec is trying to avoid. Rather than rely on
-- every writer remembering that, the text key columns below are NOT NULL with a
-- '' default, and the ingest layer normalises missing values to ''. Dates that
-- can legitimately be absent (period_start/period_end) are handled with a
-- COALESCE'd unique index instead.
-- ---------------------------------------------------------------------------

-- Adex data - synced from Google Drive, ~30k+ rows, growing monthly
CREATE TABLE IF NOT EXISTS adex_data (
  id SERIAL PRIMARY KEY,
  month DATE NOT NULL,
  super_category TEXT,
  product_group TEXT,
  mother_brand TEXT,
  advertiser TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  tv_spend_000 NUMERIC,
  tv_freq INTEGER,
  tv_dur_secs INTEGER,
  radio_spend_000 NUMERIC,
  radio_freq INTEGER,
  radio_dur_secs INTEGER,
  press_spend_000 NUMERIC,
  press_ins INTEGER,
  total_000 NUMERIC,
  fy TEXT,
  month2 TEXT,
  quarter TEXT,
  sector TEXT,
  category TEXT,
  product2 TEXT NOT NULL DEFAULT '',
  source_file TEXT,
  synced_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (month, advertiser, brand, product2)
);
CREATE INDEX IF NOT EXISTS idx_adex_brand_month ON adex_data (brand, month);
CREATE INDEX IF NOT EXISTS idx_adex_category_month ON adex_data (category, month);
CREATE INDEX IF NOT EXISTS idx_adex_advertiser ON adex_data (advertiser);
-- Competitor-set lookups filter on sector/category then group by quarter.
CREATE INDEX IF NOT EXISTS idx_adex_sector_month ON adex_data (sector, month);

-- TV channel master data - parsed from session upload, file itself discarded
CREATE TABLE IF NOT EXISTS tv_channels (
  id SERIAL PRIMARY KEY,
  channel_name TEXT NOT NULL,
  language TEXT,
  category TEXT,
  reach_notes TEXT,
  rate_card_ref TEXT,
  raw JSONB
);
-- Channel names arrive with inconsistent casing/spacing across workbooks, so
-- the identity is the normalised name (see util/normalise.js).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tv_channels_name
  ON tv_channels (channel_name);

-- TVR / programme ratings - parsed from session upload, file itself discarded
CREATE TABLE IF NOT EXISTS tv_programme_ratings (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES tv_channels(id) ON DELETE CASCADE,
  programme_name TEXT,
  day_part TEXT,
  target_audience TEXT,
  grp NUMERIC,
  trp NUMERIC,
  avg_duration_secs INTEGER,
  period_start DATE,
  period_end DATE,
  raw JSONB
);
-- "Match on channel_name + programme_name + period" (Section 4). Target
-- audience is part of the key too: the same programme is reported once per
-- audience segment, and collapsing those would destroy the data.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tv_programme_ratings_natural
  ON tv_programme_ratings (
    channel_id,
    programme_name,
    COALESCE(day_part, ''),
    COALESCE(target_audience, ''),
    COALESCE(period_start, DATE '0001-01-01'),
    COALESCE(period_end, DATE '0001-01-01')
  );
CREATE INDEX IF NOT EXISTS idx_tvr_audience ON tv_programme_ratings (target_audience);
CREATE INDEX IF NOT EXISTS idx_tvr_grp ON tv_programme_ratings (grp DESC);

-- Parsed campaign briefs
CREATE TABLE IF NOT EXISTS campaign_briefs (
  id SERIAL PRIMARY KEY,
  brand TEXT,
  advertiser TEXT,
  objective TEXT,
  target_audience TEXT,
  campaign_period TSTZRANGE,
  budget_lkr_lakhs NUMERIC,
  medium_split JSONB,
  language TEXT,
  territory TEXT,
  source_file TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

-- Generated recommendations - full audit trail, source for PDF export
CREATE TABLE IF NOT EXISTS plan_recommendations (
  id SERIAL PRIMARY KEY,
  brief_id INTEGER REFERENCES campaign_briefs(id) ON DELETE CASCADE,
  recommended_lineup JSONB,
  overall_rationale TEXT,
  competitor_analysis TEXT,
  chart_data JSONB,
  confidence TEXT,
  gaps_or_caveats TEXT,
  model_used TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_brief ON plan_recommendations (brief_id, created_at DESC);

-- Sync run log (Section 3) - what landed, when, and what broke.
CREATE TABLE IF NOT EXISTS sync_log (
  id SERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  file_name TEXT,
  drive_file_id TEXT,
  drive_modified_at TIMESTAMPTZ,
  rows_parsed INTEGER DEFAULT 0,
  rows_upserted INTEGER DEFAULT 0,
  rows_skipped INTEGER DEFAULT 0,
  status TEXT NOT NULL,           -- started | ok | error | skipped
  error TEXT,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_log_started ON sync_log (started_at DESC);
-- Lets the sync skip Drive files whose modifiedTime hasn't moved since the
-- last successful run.
CREATE INDEX IF NOT EXISTS idx_sync_log_file ON sync_log (drive_file_id, status, started_at DESC);
