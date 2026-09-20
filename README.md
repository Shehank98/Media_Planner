# Media Analysis System

A single-user internal tool for a media buying agency. It preps client pitches:
given a category (e.g. **Banking**), it shows how the category and its
advertisers spend across **TV / Radio / Press**, which channels and programmes
perform best, and recommends an optimal channel/programme basket using **CPRP**
(cost per rating point).

- **Backend:** FastAPI + Postgres (SQLAlchemy)
- **Charts:** matplotlib, rendered server-side (embeddable into reports)
- **AI:** Gemini — used for **narrative explanation and ad-hoc questions only**.
  All numeric analysis is computed in Python/SQL, so numbers are never
  hallucinated.
- **Deploy:** Railway (Nixpacks / Procfile provided)

---

## Why numbers are trustworthy

Every headline figure — spend, share of spend, CPRP, basket totals — is computed
in `backend/app/services/*.py` using SQL aggregates. Gemini only ever receives a
**pre-computed result** and writes prose around it (`llm/gemini.py:narrate`). The
one place the LLM can shape a query is the opt-in **ad-hoc SQL** feature, and
that runs through a SELECT-only guard (`services/restricted_sql.py`) against a
restricted DB role.

### The one business rule that matters most

`V/A | Com` marks each adex row as a paid commercial (`Com`) or a value-addition
(`V/A`, bonus free airtime). **Spend totals only ever count `Com` rows.** V/A is
tracked separately as "bonus value received" for the narrative and never blended
into spend. This filter lives in `services/adex_analysis.py` (`COM = va_com == 'Com'`).

---

## Market Overview (dashboard)

The landing view answers "what's happening in the market" at a glance:

- **KPI tiles** — total market spend, advertisers, channels, categories, date
  range, leading category/advertiser, and bonus V/A airtime.
- **Monthly spend by medium** (stacked), **Top categories**, **Share of Voice
  over time**, an **advertiser × month spend heatmap**, and **biggest movers**.
- **Growth analysis** — gainers, decliners and **new entrants** (2nd half of the
  date range vs the 1st).
- **AI market read** — Gemini reads the pre-computed figures and writes a sharp
  summary (who's winning/losing, where spend concentrates, one recommendation).
  It only ever sees computed numbers.

The same endpoints accept a `product_groups` filter, so Tab 1 reuses them for a
category-scoped dashboard with its own KPI tiles and AI analysis.

## The three tabs

### Tab 1 — Category / Pitch Analysis (adex data)
Select product group(s) → advertiser(s). Computes: medium split, monthly/yearly
spend trend, top advertisers, Top-5 Share of Spend (per medium), competitor view,
and V/A bonus metric. Exports a pitch report (**PDF or Word**) with embedded
charts and a Gemini narrative. Inline "ask a question" narrates the current pivot.

### Tab 2 — Channel Basket & Programme Selection (TVR data)

> Terminology: **adex** and **media watch** both mean the advertising-spend
> dataset (Tab 1 / Tab 3). **TVR data** is a *separate* ratings dataset used
> here in Tab 2. They are uploaded independently.

Ranks programmes by TVR / TVR share % / reach % within prime/non-prime buckets,
and computes **CPRP = rate_30s_equivalent ÷ TVR** by joining to the rate card
store (matched by channel + programme, falling back to channel + slot, using the
rate card version effective on/before the programme's date). The **basket
builder** sums TVR, reach, cost and blended CPRP for selected programmes. Raw
rate + duration are always shown alongside so the 30s normalisation is visible.

### Tab 3 — Channel View
A **channel-first drill-down on the same Com-only adex dataset** (not a separate
upload): pick a channel → top advertisers on it → their top programmes.

---

## Shared: Rate Card Store

Upload one Excel workbook, one sheet per channel. The parser reads headers
**per sheet** (column layout varies) and:

1. Sheet name → channel.
2. **Effective date** — fuzzy-parsed from the free-text title (regex patterns +
   `dateutil` fuzzy). Always shown for confirm/correct before saving; if it can't
   be parsed you must enter it manually.
3. **Rack-rate duration** — detected from the header (`30 Sec`, `10 Sec`). If the
   header is a plain `Rack Rate` with no duration, it's flagged for you to specify.
4. **30s-equivalent** — `rate_30s_equivalent = rack_rate × (30 / duration)`,
   stored alongside the raw rate. Cross-channel CPRP always uses the 30s figure.
5. **Prime/Non-Prime** — uses the sheet's PT/NPT when given, otherwise inferred
   from start time against the configurable prime-time window, applied
   consistently across every channel.
6. **Day/s** normalised into a weekday set (original text kept).
7. **Start/End** normalised from mixed time formats.
8. The sheet's own `Rating` and `CPRP Rack Rate` are stored for reference only —
   the system always recomputes CPRP from live TVR.
9. **Review before save** — every upload shows a per-channel table of parsed +
   inferred fields to correct before committing.

Rate cards are versioned: multiple effective-date versions per channel are kept,
and CPRP joins to the latest version on/before the analysed date. Batches can be
deleted/replaced manually.

---

## Uploads are asynchronous

Large workbooks don't block the request. `POST /api/uploads/{kind}` returns a
`job_id` immediately; parsing runs in the background; the client polls
`GET /api/jobs/{id}` and then fetches `/review`. Nothing is written to the main
tables until you `POST /api/jobs/{id}/confirm`. Every stored row carries a
`batch_id` + `uploaded_at` for independent manual delete.

---

## Prompt guides (two, independent)

Managed separately under **Settings** — each editable inline or uploadable as a
`.txt`/`.md` file:

- **Analysis rules** (business logic) — injected **before** any interpretation:
  the Com/V-A rule, CPRP formula, category conventions, definitions.
- **Report template guide** (tone & format) — injected **before** writing chat
  answers or the report: house tone, structure, section order, phrasing.

They are stored under separate keys and never derived from one another.

---

## Running locally

```bash
# 1. Postgres
createdb media_planner   # or use Docker

# 2. Python deps
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt

# 3. Config
cp .env.example .env      # set DATABASE_URL, optionally GEMINI_API_KEY

# 4. Run
uvicorn app.main:app --reload --app-dir backend
# open http://localhost:8000
```

Tables are auto-created on startup. To enable the restricted ad-hoc SQL role:

```bash
psql "$DATABASE_URL" -f db/restricted_role.sql   # edit the password first
# then set READONLY_DATABASE_URL in .env
```

## Seeding rate cards from the command line

Besides the web upload, a rate card workbook can be loaded straight into
Postgres with the same parser/commit logic:

```bash
export DATABASE_URL=postgresql://.../media_planner
python scripts/seed_rate_cards.py RateCards.xlsx \
    --duration "Sirasa TV=30" \    # for a sheet with a plain "Rack Rate" header
    --effective "TV Derana="       # blank -> NULL (always-applicable)
```

The sheet's own `CPRP Rack Rate` column is dropped by default (the system
recomputes CPRP from live TVR); pass `--keep-cprp` to store it for reference.
Use `--dry-run` to preview the plan without writing.

## Deploying on Railway

1. Attach a Postgres plugin (sets `DATABASE_URL`).
2. Set `PGSSL=true` and `GEMINI_API_KEY`.
3. Nixpacks uses `nixpacks.toml` to install `backend/requirements.txt` and start
   uvicorn. (`Procfile` is provided as a fallback.)

---

## API surface (selected)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/uploads/{rate_card\|adex\|tvr}` | async upload |
| GET  | `/api/jobs/{id}` · `/review` | poll / review |
| POST | `/api/jobs/{id}/confirm` | commit reviewed data |
| GET  | `/api/market/overview` · `/growth` · `/sov-trend` | market dashboard data |
| GET  | `/api/market/charts/{trend\|sov\|heatmap\|top-categories\|growth}.png` | dashboard charts |
| POST | `/api/market/ai-read` | AI market read over computed figures |
| GET  | `/api/tab1/*` | category analysis + charts |
| POST | `/api/tab1/report` | PDF / Word pitch report |
| GET  | `/api/tab2/best-programmes` · `POST /api/tab2/basket` | CPRP + basket |
| GET  | `/api/tab3/overview` | channel-first view |
| POST | `/api/chat/ask` | ad-hoc (narrative or restricted SQL) |
| GET/PUT | `/api/settings*` | prime window + prompt guide |

Interactive docs at `/docs` (FastAPI/Swagger).

---

## Project layout

```
backend/app/
  main.py            FastAPI app + static frontend mount
  config.py          env config
  database.py        engines (rw + read-only), session, init
  models.py          SQLAlchemy tables (all carry batch_id + uploaded_at)
  jobs.py            async upload orchestration (stage → review → confirm)
  charts.py          server-side matplotlib charts (shared by app + reports)
  parsers/           rate_card / adex / tvr (per-sheet header reading)
  services/          rate_cards, adex_analysis (Tab1/3), market (dashboard +
                     SoV/growth/heatmap), basket (Tab2), ingest, report
                     (PDF/Word), restricted_sql, settings_store
  llm/               gemini client + prompt_guide store
  routers/           HTTP endpoints per tab
frontend/            single-page UI (index.html / styles.css / app.js)
db/restricted_role.sql
```
