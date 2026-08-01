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

-- TVR / programme ratings - parsed from session upload, file itself discarded.
-- Source: the "C1 - TV Top Programs" sheet of a MICOS dashboard export.
-- MICOS reports "Avg. Ratings" (a TVR), so trp carries it; grp stays available
-- for the spot-level GRP totals rolled up from the TV GRP sheet.
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
  raw JSONB,
  programme_category TEXT,
  instances INTEGER,          -- airings in the survey period
  total_reach NUMERIC,
  avg_reach NUMERIC,
  rank INTEGER
);
-- Added after the first release, once the real MICOS layout was known.
ALTER TABLE tv_programme_ratings ADD COLUMN IF NOT EXISTS programme_category TEXT;
ALTER TABLE tv_programme_ratings ADD COLUMN IF NOT EXISTS instances INTEGER;
ALTER TABLE tv_programme_ratings ADD COLUMN IF NOT EXISTS total_reach NUMERIC;
ALTER TABLE tv_programme_ratings ADD COLUMN IF NOT EXISTS avg_reach NUMERIC;
ALTER TABLE tv_programme_ratings ADD COLUMN IF NOT EXISTS rank INTEGER;
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

-- ---------------------------------------------------------------------------
-- MICOS dashboard datasets.
--
-- A TV_ChannelDetails / TV_GrpDetails export is not one table but five, spread
-- across sheets, plus a "Target" sheet carrying the survey period and the
-- custom target group ("Custom TG: Meera 16-45"). Each lands in its own table
-- because each answers a different planning question - which channel, which
-- programme, which day, which day-part, and who else is already buying it.
-- ---------------------------------------------------------------------------

-- Provenance for one uploaded export. Everything below points back at this.
CREATE TABLE IF NOT EXISTS tv_report_meta (
  id SERIAL PRIMARY KEY,
  source_file TEXT,
  target_audience TEXT,
  period_start DATE,
  period_end DATE,
  exported_at TIMESTAMPTZ,
  exported_by TEXT,
  sheets JSONB,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

-- Sheet A1: channel-level share and reach.
CREATE TABLE IF NOT EXISTS tv_channel_performance (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES tv_channels(id) ON DELETE CASCADE,
  target_audience TEXT NOT NULL DEFAULT '',
  share_of_audience NUMERIC,
  total_ratings NUMERIC,
  avg_daily_minutes NUMERIC,
  individual_reach NUMERIC,
  individual_reach_pct NUMERIC,
  period_start DATE,
  period_end DATE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tv_channel_perf
  ON tv_channel_performance (
    channel_id, target_audience,
    COALESCE(period_start, DATE '0001-01-01'),
    COALESCE(period_end, DATE '0001-01-01')
  );

-- Sheets A2 and A3: when the audience is actually watching.
-- A2 gives one row per day of week; A3 gives Weekdays/Weekend x time band.
-- Both live here, distinguished by which of day_of_week / time_of_day is set.
CREATE TABLE IF NOT EXISTS tv_channel_daypart (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES tv_channels(id) ON DELETE CASCADE,
  target_audience TEXT NOT NULL DEFAULT '',
  day_of_week TEXT NOT NULL DEFAULT '',   -- Sunday..Saturday (A2)
  day_group TEXT NOT NULL DEFAULT '',     -- Weekdays | Weekend (A3)
  time_of_day TEXT NOT NULL DEFAULT '',   -- "Prime Time (1900 - 2159)" (A3)
  ratings NUMERIC,
  reach NUMERIC,
  reach_pct NUMERIC,
  period_start DATE,
  period_end DATE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tv_channel_daypart
  ON tv_channel_daypart (
    channel_id, target_audience, day_of_week, day_group, time_of_day,
    COALESCE(period_start, DATE '0001-01-01'),
    COALESCE(period_end, DATE '0001-01-01')
  );
CREATE INDEX IF NOT EXISTS idx_daypart_ratings ON tv_channel_daypart (ratings DESC);

-- Sheet "TV GRP": one row per aired advertisement spot, with the GRP it earned.
-- This is where competitor pressure at programme level comes from - who is
-- already buying the slot being considered.
CREATE TABLE IF NOT EXISTS tv_spot_grp (
  id SERIAL PRIMARY KEY,
  aired_at TIMESTAMP NOT NULL,
  channel_id INTEGER REFERENCES tv_channels(id) ON DELETE CASCADE,
  programme_name TEXT NOT NULL DEFAULT '',
  programme_category TEXT,
  category TEXT,
  sub_category TEXT,
  brand TEXT NOT NULL DEFAULT '',
  sub_brand TEXT,
  company TEXT,
  ad_type TEXT,
  ad_name TEXT NOT NULL DEFAULT '',
  duration_secs INTEGER,
  not_rated BOOLEAN,
  grp NUMERIC,
  reach NUMERIC,
  target_audience TEXT NOT NULL DEFAULT '',
  period_start DATE,
  period_end DATE
);
-- The same brand can air twice in one minute on one channel, so the ad name and
-- duration are part of the identity too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tv_spot_grp
  ON tv_spot_grp (aired_at, channel_id, brand, ad_name, COALESCE(duration_secs, -1), target_audience);
CREATE INDEX IF NOT EXISTS idx_spot_programme ON tv_spot_grp (programme_name, channel_id);
CREATE INDEX IF NOT EXISTS idx_spot_brand ON tv_spot_grp (brand);
CREATE INDEX IF NOT EXISTS idx_spot_category ON tv_spot_grp (category);

-- Media watch: one row per aired spot with what it cost. This is the only
-- source of rate information, so it is what turns a programme shortlist into a
-- costed plan.
CREATE TABLE IF NOT EXISTS media_watch_spots (
  id SERIAL PRIMARY KEY,
  medium TEXT,                -- TV | Radio | Press, derived from the channel label
  channel_name TEXT NOT NULL DEFAULT '',
  programme_name TEXT NOT NULL DEFAULT '',
  aired_on DATE NOT NULL,
  day_of_week TEXT,
  prog_time TEXT,
  advt_time TEXT NOT NULL DEFAULT '',
  product_group TEXT,
  advertiser TEXT,
  product TEXT,
  advt_theme TEXT,
  ad_pos INTEGER,
  tot_ads INTEGER,
  brk_no INTEGER,
  pos_in_brk INTEGER,
  ads_in_brk INTEGER,
  language TEXT,
  duration_secs INTEGER,
  cost NUMERIC,
  source_file TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_watch_spot
  ON media_watch_spots (
    channel_name, programme_name, aired_on, advt_time,
    COALESCE(product, ''), COALESCE(duration_secs, -1)
  );
CREATE INDEX IF NOT EXISTS idx_mw_channel_prog ON media_watch_spots (channel_name, programme_name);
CREATE INDEX IF NOT EXISTS idx_mw_advertiser ON media_watch_spots (advertiser);
CREATE INDEX IF NOT EXISTS idx_mw_aired ON media_watch_spots (aired_on);

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

-- ---------------------------------------------------------------------------
-- Runtime settings.
--
-- Drive configuration lives here rather than only in environment variables so
-- a planner can point the app at a different folder without a redeploy. Env
-- vars remain the fallback, which keeps existing deployments working and gives
-- a way to seed a fresh one.
--
-- Values marked secret are never returned by the API - only whether they are
-- set - so a service-account private key cannot be read back out of the UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  is_secret BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Files archived to Drive for one planning run, so they can be purged once the
-- report exists. Adex is deliberately excluded from purging - it is the only
-- dataset that accumulates rather than being superseded.
CREATE TABLE IF NOT EXISTS drive_archive (
  id SERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  dataset TEXT NOT NULL,
  file_name TEXT NOT NULL,
  drive_file_id TEXT,
  drive_folder_id TEXT,
  bytes INTEGER,
  keep BOOLEAN NOT NULL DEFAULT false,
  purged_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drive_archive_run ON drive_archive (run_id);
CREATE INDEX IF NOT EXISTS idx_drive_archive_pending
  ON drive_archive (purged_at) WHERE purged_at IS NULL AND keep = false;

-- The generated schedule: one row per channel/programme/day-pattern line, plus
-- the dated spot grid. Stored separately from plan_recommendations because it
-- is derived deterministically from the plan and the campaign dates, and gets
-- regenerated when either changes.
CREATE TABLE IF NOT EXISTS plan_schedule (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER REFERENCES plan_recommendations(id) ON DELETE CASCADE,
  channel_name TEXT NOT NULL,
  programme_name TEXT NOT NULL,
  day_pattern TEXT,
  time_band TEXT,
  time_start TEXT,
  time_end TEXT,
  duration_secs INTEGER,
  spots INTEGER,
  tvr NUMERIC,
  rate_lkr NUMERIC,
  cost_lkr NUMERIC,
  -- date -> spots for that line, e.g. {"2026-09-01": 1, "2026-09-03": 1}
  spot_dates JSONB,
  line_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_schedule_plan ON plan_schedule (plan_id, line_order);

-- Commercial durations the planner will buy (10s, 15s, 20s, 30s). Replaces the
-- TV/radio/press percentage split, which does not survive contact with how a
-- TV plan is actually built.
ALTER TABLE campaign_briefs ADD COLUMN IF NOT EXISTS commercial_durations JSONB;

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
