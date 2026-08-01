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

## Two rules that shape the design

**Adex is synced, not uploaded.** `adex_data` is a live table pulled from a
Google Drive folder on a schedule. Re-syncing a corrected file updates the rows
it covers instead of duplicating them.

**TVR/channel uploads are session-only.** The workbook is parsed in memory,
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

1. **Upload the brief** — `POST /api/briefs/parse` returns the fields it found,
   which label each one matched, and warnings. **It saves nothing.** Brief PDFs
   are messy multi-table layouts and the parse is a proposal, not a fact.
2. **Confirm** — the corrected fields go to `POST /api/briefs`.
3. **Aggregate** — targeted SQL, not row dumps: competitor spend by brand and
   quarter in the same category, the own-brand trend, and the top ~20 programmes
   by GRP for the brief's audience and language.
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
| `GET` | `/health` | Dependency status. |
| `GET` | `/api/facets` | Filter values (sectors, categories, languages, audiences). |
| `POST` | `/api/sync/now` | "Sync now". `?force=true` re-ingests unchanged files. |
| `GET` | `/api/sync/status` | Running state, adex coverage, recent runs. |
| `POST` | `/api/uploads/tv` | Channel/TVR workbooks. Session-only. |
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

The TVR parser handles both layouts it has seen:

- **long** — one row per programme × audience, with a Target Audience column
- **wide** — an audience banner merged across GRP/TVR column pairs, unpivoted
  into one row per audience

> **These parsers have not yet been run against the real
> `TV_ChannelDetails_*` / `TV_GrpDetails_*` files** — those weren't available
> when this was built, so they're calibrated against fixtures reproducing the
> layout problems described above. Drop the real files in `samples/` and check
> them (see `samples/README.md`); expect to add header wordings.

## Two places the numbers could go quietly wrong

Both are handled, and both are worth knowing about.

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

## Grounding check

The load-bearing rule in the system prompt is "never invent channel names or
programmes not present in the supplied data" — and it's the one a model breaks
most quietly. A plausible-sounding programme name in a client-facing report is
worse than a gap.

So it's verified in code rather than trusted: every recommended channel and
programme is matched against the data the model was actually given. Unmatched
entries are flagged on the row, described in `gaps_or_caveats`, marked with a
dagger in the PDF lineup table, and the plan's confidence is capped at
`medium`. Flagged entries are **kept, not deleted** — a planner reviewing the
plan should see what was proposed and why it was doubted.

## PDF report

Seven sections: cover, executive summary, lineup table, three charts, competitor
analysis, confidence and caveats, and an appendix with the raw aggregates for
audit.

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

68 tests. The database ones skip unless `TEST_DATABASE_URL` is set:

```bash
TEST_DATABASE_URL=postgres://... npm test
```

Those are worth running — upsert idempotency and the audience-matching rules
are only meaningfully testable against real Postgres. `test/fixtures.js`
generates workbooks with the same layout problems as the real files, and
`test/make_brief_pdf.py` generates a deliberately awkward brief PDF.

## Layout

```
db/schema.sql          Schema, idempotent, applied on boot
src/llm/               Adapter seam: index.js, gemini.js, ollama.js, systemPrompt.js
src/parsers/           sheet.js (header detection) + one parser per file type
src/sync/              Drive client, adex sync, cron scheduler
src/services/          Aggregation, repositories, plan pipeline, chart data
src/routes/            HTTP layer
report/                build_report.py, charts.py — the PDF worker
```
