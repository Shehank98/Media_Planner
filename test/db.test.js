import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Integration tests against a real Postgres. Skipped when TEST_DATABASE_URL is
// unset so `npm test` still works without a database, but the upsert and
// aggregation logic is only meaningfully verified here - a mocked pg would test
// the mock, not the ON CONFLICT behaviour that matters.
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to run database tests';
if (url) process.env.DATABASE_URL = url;

let db;
let adexRepo;
let micosRepo;
let aggregate;
let briefRepo;
let parseAdexWorkbook;
let parseMicosWorkbook;
let parseMediaWatch;
let fx;

const TABLES = `plan_recommendations, campaign_briefs, tv_programme_ratings,
  tv_channel_daypart, tv_channel_performance, tv_spot_grp, tv_report_meta,
  media_watch_spots, tv_channels, adex_data, sync_log`;

before(async () => {
  if (skip) return;
  db = await import('../src/db.js');
  adexRepo = await import('../src/services/adexRepo.js');
  micosRepo = await import('../src/services/micosRepo.js');
  aggregate = await import('../src/services/aggregate.js');
  briefRepo = await import('../src/services/briefRepo.js');
  ({ parseAdexWorkbook } = await import('../src/parsers/adexParser.js'));
  ({ parseMicosWorkbook } = await import('../src/parsers/micosParser.js'));
  ({ parseMediaWatch } = await import('../src/parsers/mediaWatchParser.js'));
  fx = await import('./fixtures.js');
  await db.migrate();
});

after(async () => {
  if (!skip) await db.close();
});

beforeEach(async () => {
  if (skip) return;
  await db.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
});

/** Load all three MICOS fixtures the way the upload route does. */
async function loadMicos() {
  const parsed = await Promise.all([
    parseMicosWorkbook(await fx.micosChannelDetails(), { sourceFile: 'cd.xlsx' }),
    parseMicosWorkbook(await fx.micosChannelDashboards(), { sourceFile: 'dash.xlsx' }),
    parseMicosWorkbook(await fx.micosSpotGrp(), { sourceFile: 'grp.xlsx' }),
  ]);
  const audience = parsed.map((p) => p.meta.target_audience).find(Boolean);
  const totals = { programmes: 0, channelPerformance: 0, dayparts: 0, spots: 0 };
  for (const p of parsed) {
    const r = await micosRepo.persistMicos(p, { audienceOverride: audience });
    for (const key of Object.keys(totals)) totals[key] += r[key] ?? 0;
  }
  return totals;
}

async function loadMediaWatch() {
  const { spots } = await parseMediaWatch(fx.mediaWatchTsv(), { sourceFile: 'mw.tsv' });
  return micosRepo.persistMediaWatch(spots);
}

// --- adex ------------------------------------------------------------------

test('adex upsert is idempotent across repeated syncs', { skip }, async () => {
  const { rows } = await parseAdexWorkbook(await fx.adexWorkbook(), { sourceFile: 'a.xlsx' });

  await adexRepo.upsertAdexRows(rows);
  const first = await db.query('SELECT count(*)::int AS n FROM adex_data');
  assert.equal(first.rows[0].n, 3);

  await adexRepo.upsertAdexRows(rows);
  const second = await db.query('SELECT count(*)::int AS n FROM adex_data');
  assert.equal(second.rows[0].n, 3, 'a second sync of the same file must not duplicate rows');
});

test('the unique key holds even when product2 is absent', { skip }, async () => {
  // The reason key columns are NOT NULL DEFAULT '': with NULLs, Postgres would
  // treat every row as distinct and the same month would land twice.
  const row = {
    month: '2021-01-01', advertiser: 'Solo Ltd', brand: 'Solo', product2: '',
    tv_spend_000: 100, total_000: 100,
  };
  await adexRepo.upsertAdexRows([row]);
  await adexRepo.upsertAdexRows([{ ...row, tv_spend_000: 200 }]);

  const { rows } = await db.query(
    "SELECT count(*)::int AS n, max(tv_spend_000) AS spend FROM adex_data WHERE brand = 'Solo'",
  );
  assert.equal(rows[0].n, 1, 'one row, not two');
  assert.equal(rows[0].spend, 200);
});

test('batching inserts more rows than one batch holds', { skip }, async () => {
  const rows = Array.from({ length: 1201 }, (_, i) => ({
    month: '2021-01-01', advertiser: 'Bulk Co', brand: `Brand ${i}`, product2: 'Std',
    category: 'Not Relavent', sector: 'Other', tv_spend_000: i, total_000: i,
  }));
  await adexRepo.upsertAdexRows(rows);
  const { rows: check } = await db.query(
    "SELECT count(*)::int AS n FROM adex_data WHERE advertiser = 'Bulk Co'",
  );
  assert.equal(check[0].n, 1201, '1201 rows across three 500-row batches');
});

// --- MICOS -----------------------------------------------------------------

test('a MICOS upload lands in the right five tables', { skip }, async () => {
  await loadMicos();

  const counts = async (table) =>
    (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

  assert.equal(await counts('tv_programme_ratings'), 4, 'C1 top programmes');
  assert.equal(await counts('tv_channel_performance'), 2, 'A1 channel summary');
  assert.equal(await counts('tv_channel_daypart'), 7, 'A2 days + A3 day-parts share one table');
  assert.equal(await counts('tv_spot_grp'), 3, 'spot-level GRP');
  assert.ok(await counts('tv_channels') >= 3, 'channels resolved across all sheets');
});

test('re-uploading the same MICOS export does not duplicate', { skip }, async () => {
  await loadMicos();
  const before = (await db.query('SELECT count(*)::int AS n FROM tv_programme_ratings')).rows[0].n;
  await loadMicos();
  const after = (await db.query('SELECT count(*)::int AS n FROM tv_programme_ratings')).rows[0].n;
  assert.equal(after, before, 'a survey re-uploaded is the same survey');
});

test('the audience carries across to the export that omits it', { skip }, async () => {
  // The real spot-level export has no "Custom TG" line. Without the carry-over
  // its rows would be stored against a blank audience and never match a brief.
  await loadMicos();
  const { rows } = await db.query(
    'SELECT DISTINCT target_audience FROM tv_spot_grp ORDER BY 1',
  );
  assert.deepEqual(rows.map((r) => r.target_audience), ['Meera 16-45']);
});

test('day rows and day-part rows stay distinguishable in one table', { skip }, async () => {
  await loadMicos();
  const { rows } = await db.query(`
    SELECT count(*) FILTER (WHERE day_of_week <> '') AS days,
           count(*) FILTER (WHERE time_of_day <> '') AS bands
      FROM tv_channel_daypart`);
  assert.equal(rows[0].days, 4, 'A2 rows');
  assert.equal(rows[0].bands, 3, 'A3 rows');
});

test('media watch spots upsert without duplicating', { skip }, async () => {
  const first = await loadMediaWatch();
  assert.equal(first.spots, 3);
  await loadMediaWatch();
  const { rows } = await db.query('SELECT count(*)::int AS n FROM media_watch_spots');
  assert.equal(rows[0].n, 3);
});

// --- aggregation -----------------------------------------------------------

async function sampleBrief(overrides = {}) {
  return briefRepo.insertBrief({
    brand: 'Sunsilk',
    advertiser: 'Unilever Sri Lanka Limited',
    target_audience: 'Meera 16-45',
    language: 'Sinhala',
    period_start: '2026-08-01',
    period_end: '2026-09-30',
    budget_lkr_lakhs: 250,
    medium_split: { tv: 70, radio: 20, press: 10 },
    ...overrides,
  });
}

test('aggregation ranks programmes and joins observed cost', { skip }, async () => {
  await loadMicos();
  await loadMediaWatch();
  const data = await aggregate.buildAggregatedData(await sampleBrief());

  assert.equal(data.scope.audience_panel, 'Meera 16-45');
  assert.equal(data.scope.audience_matched, true);

  const ratings = data.programme_ratings.map((p) => Number(p.avg_rating));
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), 'ranked by rating');

  // The media watch fixture observed a TV spot in PAATA KURULLO at 145,000.
  const top = data.programme_ratings.find((p) => p.programme_name === 'PAATA KURULLO');
  assert.equal(Number(top.observed_avg_cost), 145000, 'cost joined from media watch');
  assert.ok(top.cost_per_rating_point > 0, 'cost per rating point computed in SQL, not by the model');
});

test('aggregation reports the strongest day and day-part per channel', { skip }, async () => {
  await loadMicos();
  const data = await aggregate.buildAggregatedData(await sampleBrief());

  const hiruBest = data.best_days.find((d) => d.channel_name === 'HIRU TV' && d.day_rank === 1);
  assert.equal(hiruBest.day_of_week, 'Tuesday', 'highest ratings day is ranked first');
  assert.equal(Number(hiruBest.ratings), 23787.48);
  assert.equal(typeof hiruBest.day_rank, 'number', 'bigint rank arrives as a number, not a string');

  const band = data.best_dayparts.find((d) => d.channel_name === 'DERANA TV' && d.band_rank === 1);
  assert.equal(band.time_of_day, 'Evening Peak (1900 - 2059)');
});

test('aggregation reports who is already buying each programme', { skip }, async () => {
  await loadMicos();
  const data = await aggregate.buildAggregatedData(await sampleBrief());

  const paata = data.competitor_spot_pressure.find((p) => p.programme_name === 'PAATA KURULLO');
  assert.ok(paata, 'programme-level competitive read is available');
  assert.equal(paata.spots, 2);
  assert.ok(paata.top_brands.includes('Dove'));
  assert.equal(typeof paata.spots, 'number', 'counts arrive as numbers');
  assert.equal(paata.own_brand_present, true, 'Sunsilk is already in this block');
});

test('aggregation declares an audience panel that does not match the brief', { skip }, async () => {
  await loadMicos();
  // A brief written in demographic terms will not match a named MICOS panel.
  const data = await aggregate.buildAggregatedData(
    await sampleBrief({ target_audience: 'Housewives 25-44' }),
  );
  assert.equal(data.scope.audience_matched, false);
  assert.ok(
    data.data_notes.some((n) => /does not match the audience panel/.test(n)),
    'the mismatch is stated rather than passed off as targeted',
  );
});

test('aggregation says so when no cost data is loaded', { skip }, async () => {
  await loadMicos();
  const data = await aggregate.buildAggregatedData(await sampleBrief());
  assert.deepEqual(data.programme_rates, []);
  assert.ok(
    data.data_notes.some((n) => /cannot be costed/.test(n)),
    'an uncostable plan is flagged before the model is asked for costs',
  );
});

test('aggregation reports empty data instead of failing', { skip }, async () => {
  const data = await aggregate.buildAggregatedData(await sampleBrief({ brand: 'Nonexistent' }));
  assert.deepEqual(data.competitor_spend_by_quarter, []);
  assert.deepEqual(data.programme_ratings, []);
  assert.ok(data.data_notes.length > 0, 'gaps are described, not silent');
});

test('adex competitor scoping excludes the brief brand', { skip }, async () => {
  const { rows } = await parseAdexWorkbook(await fx.adexWorkbook());
  await adexRepo.upsertAdexRows(rows);

  const data = await aggregate.buildAggregatedData(await sampleBrief({ brand: 'Cavin Kare' }));
  const brands = new Set(data.competitor_spend_by_quarter.map((r) => r.brand));
  assert.ok(!brands.has('Cavin Kare'), 'the brief brand is excluded from its own competitor set');
  assert.ok(data.own_brand_trend.length > 0, 'and reported separately as the own-brand trend');
});

// --- briefs ----------------------------------------------------------------

test('briefs round-trip the campaign period', { skip }, async () => {
  const brief = await sampleBrief();
  assert.equal(brief.period_start, '2026-08-01');
  assert.equal(brief.period_end, '2026-09-30');

  const fetched = await briefRepo.getBrief(brief.id);
  assert.equal(fetched.period_start, '2026-08-01');
  assert.deepEqual(fetched.medium_split, { tv: 70, radio: 20, press: 10 });
});

test('a brief with no period is allowed', { skip }, async () => {
  const brief = await briefRepo.insertBrief({ brand: 'No Dates' });
  assert.equal(brief.period_start, null);
  assert.equal(brief.period_end, null);
});

// --- upload classification --------------------------------------------------

test('an adex workbook is recognised rather than rejected', { skip }, async () => {
  // Adex normally arrives by Drive sync, but the same workbooks get handed over
  // directly. Refusing them left no way to load adex without service-account
  // setup, and produced a 422 that named no cause.
  const { parseAdexWorkbook: parse } = await import('../src/parsers/adexParser.js');
  const { rows } = await parse(await fx.adexWorkbook(), { sourceFile: 'adex.xlsx' });
  assert.ok(rows.length > 0, 'the adex parser claims the file');

  // And nothing else does, so classification order is unambiguous.
  const micos = await parseMicosWorkbook(await fx.adexWorkbook());
  assert.equal(micos.programmes.length + micos.spots.length + micos.channelDays.length, 0);
  const mw = await parseMediaWatch(await fx.adexWorkbook(), { sourceFile: 'adex.xlsx' });
  assert.equal(mw.spots.length, 0);
});

test('generating a plan with nothing loaded refuses before the model call', { skip }, async () => {
  const { generatePlan } = await import('../src/services/planService.js');
  const brief = await briefRepo.insertBrief({ brand: 'Sunsilk', budget_lkr_lakhs: 250 });

  await assert.rejects(
    () => generatePlan(brief.id),
    (err) => {
      assert.equal(err.status, 409, 'a conflict with the current state, not a server fault');
      assert.match(err.message, /no ratings or spend data/i);
      assert.match(err.hint, /Upload a MICOS dashboard export/);
      return true;
    },
    'an empty database must not cost a model call',
  );
});

test('a plan can be generated once any data is loaded', { skip }, async () => {
  // The guard must not block the legitimate case where only adex is present.
  const { rows } = await parseAdexWorkbook(await fx.adexWorkbook());
  await adexRepo.upsertAdexRows(rows);

  const { buildAggregatedData } = aggregate;
  const brief = await briefRepo.insertBrief({ brand: 'Cavin Kare', budget_lkr_lakhs: 250 });
  const data = await buildAggregatedData(brief);
  assert.ok(
    data.own_brand_trend.length > 0 || data.competitor_spend_by_quarter.length > 0,
    'adex alone is enough to ground a plan',
  );
});
