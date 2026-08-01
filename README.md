# Media Planning & Analysis Assistant

Takes a campaign brief and the agency's historical adex and TVR data, and
produces a defensible media plan: a recommended channel/programme lineup with
the reasoning a planner would put in front of a client, plus a full PDF report.

Node/Express backend on Railway, Postgres for storage, a Python worker for
charts and PDF layout, and the analysis model behind a provider adapter —
Gemini today, local Ollama later, one env var apart.

```
[Google Drive]                    Phase 1: [Gemini API]  --or--  Phase 2: [Ollama]
   |  adex data (30k+ rows)                 ^  HTTPS                   ^  Cloudflare Tunnel
   v                                        |                         |
[Railway: Node/Express] ------- [LLM adapter interface] --------------+
   |                                   analyzeAndRecommend()
   v
[Railway: Postgres]  <--- session-only ---  [TV_ChannelDetails / TV_GrpDetails uploads]
   |
   v
[Python worker: matplotlib + reportlab] --> PDF report
```

## The data

Five sources, each answering a different planning question.

| Source | Sheet / feed | Answers |
|---|---|---|
| MICOS dashboard | `C1` top programmes | which **programmes** |
| MICOS dashboard | `A1` channel summary | which **channels** |
| MICOS dashboard | `A2` day of week | which **days** |
| MICOS dashboard | `A3` day-part bands | which **day-parts** |
| MICOS dashboard | `TV GRP` spot log | who is **already buying** the slot |
| Media watch | spot log with cost | what a spot **costs** |
| Adex | monthly spend by brand | category **spend context** |

A MICOS export is not one table. Sheets are named by code (`A1`, `C1`,
`TV GRP`), a `Target` sheet above them carries the survey window and the custom
target group (`Custom TG: Meera 16-45`), and a `Sheet1` PivotTable scratch
sheet must be *ignored* or it double-counts. Sheets are therefore identified by
their header signature, not by name — the two `TV_GrpDetails` exports have
entirely different contents from each other despite the shared naming.

## Two rules that shape the design

**Adex is synced, not uploaded.** `adex_data` is a live table pulled from a
Google Drive folder on a schedule. Re-syncing a corrected file updates the rows
it covers instead of duplicating them.

**Ratings and cost uploads are session-only.** The workbook is parsed in memory,
the numbers go to Postgres, and the buffer is dropped. Nothing is written to
disk, so there is no file to forget to delete. Only the extracted rows live on.

## Quick start

```bash
npm install
pip install -r report/requirements.txt

cp .env.example .env        # set DATABASE_URL and GEMINI_API_KEY at minimum
npm run migrate
npm start
```

`GET /health` reports the database, the active LLM provider, the Python report
worker and the sync scheduler — check it first when something looks wrong.

### Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres. Railway provides this when you attach the plugin. |
| `PGSSL` | `true` on Railway (self-signed cert), `false` locally. |
| `LLM_PROVIDER` | `gemini` (Phase 1) or `ollama` (Phase 2). The only line that changes. |
| `GEMINI_API_KEY` | From [Google AI Studio](https://aistudio.google.com/apikey). |
| `GEMINI_MODEL` | Default `gemini-2.5-flash`. |
| `OLLAMA_BASE_URL` | Your machine, reached over a Cloudflare Tunnel. |
| `OLLAMA_MODEL` | Default `qwen2.5:7b-instruct-q4_K_M`. |
| `GDRIVE_FOLDER_ID` | The Drive folder holding adex workbooks. |
| `GDRIVE_SERVICE_ACCOUNT_JSON` | Service-account key, raw JSON or base64. |
| `SYNC_CRON` | Default `0 */4 * * *`. |
| `PYTHON_BIN` | Default `python3`. |

## The flow

Open the app at `/` and work down the page, or drive the same JSON API directly.

1. **Upload the brief** — `POST /api/briefs/parse` returns the fields it found,
   which label each one matched, and warnings. **It saves nothing.** Brief PDFs
   are messy multi-table layouts and the parse is a proposal, not a fact.
2. **Confirm** — the corrected fields go to `POST /api/briefs`.
3. **Aggregate** — targeted SQL, not row dumps: competitor spend by quarter, the
   own-brand trend, the top ~20 programmes by rating, each channel's strongest
   day and day-part (already ranked), observed spot rates joined on by channel
   and programme, and who else is buying those programmes.
4. **Model** — the aggregate plus the brief go to `analyzeAndRecommend()`, which
   returns the fixed JSON shape.
5. **Store and chart** — the recommendation, the chart series and the aggregates
   it was built from all land on `plan_recommendations`.
6. **Report** — `GET /api/plans/:id/report.pdf` renders the seven-section PDF.

Filtering afterwards (`/api/plans/brief/:id/filter`) re-runs the SQL only. The
model is called once per brief, so filter clicks are free and the rationale a
client has already seen doesn't shift under them.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | The browser UI. |
| `GET` | `/health` | Dependency status. |
| `GET` | `/api/facets` | Filter values (sectors, categories, languages, audiences). |
| `POST` | `/api/sync/now` | "Sync now". `?force=true` re-ingests unchanged files. |
| `GET` | `/api/sync/status` | Running state, adex coverage, recent runs. |
| `POST` | `/api/uploads/tv` | MICOS exports and media watch logs. Session-only. |
| `DELETE` | `/api/uploads/tv?confirm=true` | Clear ratings before a new survey. |
| `POST` | `/api/briefs/parse` | Parse a brief PDF. Saves nothing. |
| `POST` | `/api/briefs` | Save the confirmed brief. |
| `GET` | `/api/plans/preview/:briefId` | Exactly what the model would receive. No model call. |
| `POST` | `/api/plans/generate/:briefId` | The one endpoint that costs a model call. |
| `GET` | `/api/plans/brief/:briefId/filter` | Re-aggregate under filters. No model call. |
| `GET` | `/api/plans/:id/report.pdf` | The PDF report. |

## Parsing

The workbooks are hand-maintained: title banners above the table, merged group
headers with sub-labels on the row below, blank spacer rows, totals rows, and
columns that move between exports. So nothing assumes a fixed layout.
`src/parsers/sheet.js` finds the header row (trying one-, two- and three-row
spans), resolves merged cells, and maps each declared field to a column by
matching against a list of header wordings.

When a new export doesn't parse, the fix is almost always **adding a wording to
the synonym list**, not changing logic. `POST /api/uploads/tv` reports
`mappedColumns` per sheet, and the adex parser reports `unmappedFields`, so the
missing label is visible rather than guessed at.

MICOS sheets are matched the same way, by header signature rather than sheet
name, and every spec is scored so near-identical layouts (`A2` and `A3` differ
by one column) resolve to the right one.

The parsers have been run against the real `TV_ChannelDetails_*`,
`TV_GrpDetails_*` and adex files: 586 programmes, 336 day/day-part rows and
2,992 competitor spots load cleanly, keyed to the `Meera 16-45` panel over the
June 2026 survey window.

## Three places the numbers could go quietly wrong

All three are handled, and all three are worth knowing about — each one is a
silent wrong answer rather than an error.

**Natural keys and NULL.** The upsert key is
`(month, advertiser, brand, product2)`, but in Postgres `NULL != NULL`, so a
UNIQUE constraint containing a nullable column lets duplicates straight through
— exactly the "re-syncs shouldn't duplicate" failure the design is trying to
avoid. Those columns are `NOT NULL DEFAULT ''` and the parsers normalise missing
values to `''`.

**Budget units.** Briefs quote budgets as "Rs. 25 Lakhs", "LKR 2,500,000" and
"25 Mn". Reading one of those wrong is a factor-of-10⁵ error in every
budget-fit judgement the model makes. Unit words are converted; a bare number
is converted *and flagged in the warnings* for the planner to confirm.

**Month order in adex.** The adex exports write the month as `1/1/2021`,
`2/1/2021`, `3/1/2021` — month-first. Read day-first (the Sri Lankan
convention), every one of those collapses onto January, so a year of data
silently becomes one month and the natural key merges rows that should be
distinct. The parser cross-checks against the `Month2` name column and lets the
named month win.

## Grounding and costing checks

The load-bearing rule in the system prompt is "never invent channel names,
programmes or costs not present in the supplied data" — and it's the one a
model breaks most quietly. A plausible-sounding programme name in a
client-facing report is worse than a gap; an invented price is worse still,
because it goes straight into a client's budget.

So three things are verified in code rather than trusted:

- **Every channel and programme** is matched against the data the model was
  given — TV ratings, media watch rates (which is where radio lives), spot-level
  competitor activity and the channel summary. Unmatched entries are flagged.
- **Every quoted cost** must have an observed spot rate behind it for that
  channel and programme. A cost with no rate observation is flagged separately.
- **The plan is totalled** and compared against the brief's budget. A plan that
  quietly commits 140% of budget looks exactly like one that fits until someone
  adds it up.

Anything that fails is described in `gaps_or_caveats`, marked in the PDF lineup
table (`†` ungrounded, `‡` unsupported cost), and caps the plan's confidence at
`medium`. Flagged entries are **kept, not deleted** — a planner reviewing the
plan should see what was proposed and why it was doubted.

## PDF report

Seven sections: cover, executive summary, costed lineup table, four charts,
competitor analysis, confidence and caveats, and an appendix carrying the raw
aggregates — programme ratings, day and day-part tables, observed spot rates and
competitor activity — for audit.

Node spawns `report/build_report.py` with a JSON payload. **The worker has no
database access** — it can only draw what was already stored on the plan, which
keeps the PDF and the audit trail in agreement.

## Switching to Ollama (Phase 2)

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
```

Set `LLM_PROVIDER=ollama` and `OLLAMA_BASE_URL`. Nothing else changes — both
adapters take the same input, use the same system prompt, and return the same
shape.

Then measure rather than guess:

```bash
npm run bench -- --brief 3 --providers gemini,ollama --runs 2
```

It prints wall-clock time and tokens/sec per run. On CPU-only hardware, if the
7B model is too slow, `llama3.2:3b-instruct` is faster but its rationale is
noticeably shallower — a fair fallback, not a first choice for client-facing
work. Avoid 14B+ entirely at this RAM tier. Speed only tells you what's
tolerable; read the actual rationale before choosing.

## Tests

```bash
npm test
```

85 tests. The database ones skip unless `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://... npm test
```

Those are worth running — upsert idempotency and the aggregation SQL are only
meaningfully testable against real Postgres. `test/fixtures.js` generates
workbooks matching the real MICOS and adex layouts (including the `Target`
sheet, the PivotTable scratch sheet and the real column wording), and
`test/make_brief_pdf.py` generates a deliberately awkward brief PDF.

## Layout

```
public/                The browser UI (no build step)
db/schema.sql          Schema, idempotent, applied on boot
src/llm/               Adapter seam: index.js, gemini.js, ollama.js, systemPrompt.js
src/parsers/           sheet.js (header detection) + one parser per file type
                       adexParser, micosParser, mediaWatchParser, briefParser
src/sync/              Drive client, adex sync, cron scheduler
src/services/          aggregate.js (adex) + tvAggregate.js (ratings, days, cost),
                       repositories, plan pipeline, chart data
src/routes/            HTTP layer
report/                build_report.py, charts.py — the PDF worker
```
