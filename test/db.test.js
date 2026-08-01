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
let tvRepo;
let aggregate;
let briefRepo;
let parseAdexWorkbook;
let parseGrpWorkbook;
let parseChannelWorkbook;
let fixtures;

before(async () => {
  if (skip) return;
  db = await import('../src/db.js');
  adexRepo = await import('../src/services/adexRepo.js');
  tvRepo = await import('../src/services/tvRepo.js');
  aggregate = await import('../src/services/aggregate.js');
  briefRepo = await import('../src/services/briefRepo.js');
  ({ parseAdexWorkbook } = await import('../src/parsers/adexParser.js'));
  ({ parseGrpWorkbook } = await import('../src/parsers/tvGrpParser.js'));
  ({ parseChannelWorkbook } = await import('../src/parsers/tvChannelParser.js'));
  fixtures = await import('./fixtures.js');
  await db.migrate();
});

after(async () => {
  if (!skip) await db.close();
});

beforeEach(async () => {
  if (skip) return;
  await db.query('TRUNCATE plan_recommendations, campaign_briefs, tv_programme_ratings, tv_channels, adex_data, sync_log RESTART IDENTITY CASCADE');
});

test('adex upsert is idempotent across repeated syncs', { skip }, async () => {
  const { rows } = await parseAdexWorkbook(await fixtures.adexWorkbook(), { sourceFile: 'a.xlsx' });

  await adexRepo.upsertAdexRows(rows);
  const first = await db.query('SELECT count(*)::int AS n FROM adex_data');
  assert.equal(first.rows[0].n, 4);

  // Re-syncing the same Drive file must update, not duplicate.
  await adexRepo.upsertAdexRows(rows);
  const second = await db.query('SELECT count(*)::int AS n FROM adex_data');
  assert.equal(second.rows[0].n, 4, 'a second sync of the same file must not duplicate rows');
});

test('adex upsert refreshes the values on re-sync', { skip }, async () => {
  const { rows } = await parseAdexWorkbook(await fixtures.adexWorkbook());
  await adexRepo.upsertAdexRows(rows);

  const revised = rows.map((r) => ({ ...r, tv_spend_000: 9999 }));
  await adexRepo.upsertAdexRows(revised);

  const { rows: check } = await db.query('SELECT DISTINCT tv_spend_000 FROM adex_data');
  assert.deepEqual(check.map((r) => r.tv_spend_000), [9999], 'corrected figures overwrite the old ones');
});

test('the unique key holds even when product2 is absent', { skip }, async () => {
  // The reason key columns are NOT NULL DEFAULT '': with NULLs, Postgres would
  // treat every row as distinct and the same month would land twice.
  const row = {
    month: '2024-01-01', advertiser: 'Solo Ltd', brand: 'Solo', product2: '',
    tv_spend_000: 100, total_000: 100,
  };
  await adexRepo.upsertAdexRows([row]);
  await adexRepo.upsertAdexRows([{ ...row, tv_spend_000: 200 }]);

  const { rows } = await db.query("SELECT count(*)::int AS n, max(tv_spend_000) AS spend FROM adex_data WHERE brand = 'Solo'");
  assert.equal(rows[0].n, 1, 'one row, not two');
  assert.equal(rows[0].spend, 200);
});

test('batching inserts more rows than one batch holds', { skip }, async () => {
  const rows = Array.from({ length: 1201 }, (_, i) => ({
    month: '2024-01-01',
    advertiser: 'Bulk Co',
    brand: `Brand ${i}`,
    product2: 'Std',
    category: 'Beverages',
    sector: 'FMCG',
    tv_spend_000: i,
    total_000: i,
  }));
  await adexRepo.upsertAdexRows(rows);
  const { rows: check } = await db.query("SELECT count(*)::int AS n FROM adex_data WHERE advertiser = 'Bulk Co'");
  assert.equal(check[0].n, 1201, '1201 rows across three 500-row batches');
});

test('TVR upload persists channels and ratings, and re-upload does not duplicate', { skip }, async () => {
  const { channels } = await parseChannelWorkbook(await fixtures.channelWorkbook());
  const { ratings } = await parseGrpWorkbook(await fixtures.grpWorkbookWide());

  const first = await tvRepo.persistTvUpload({ channels, ratings });
  assert.ok(first.ratingsUpserted > 0);

  const countRatings = async () =>
    (await db.query('SELECT count(*)::int AS n FROM tv_programme_ratings')).rows[0].n;
  const afterFirst = await countRatings();

  await tvRepo.persistTvUpload({ channels, ratings });
  assert.equal(await countRatings(), afterFirst, 're-uploading the same workbook must upsert, not duplicate');
});

test('ratings for a channel missing from the master list still land', { skip }, async () => {
  const { ratings } = await parseGrpWorkbook(await fixtures.grpWorkbookWide());
  // No channel workbook at all - the ratings name their own channels.
  await tvRepo.persistTvUpload({ channels: [], ratings });

  const { rows } = await db.query(
    `SELECT c.channel_name, count(r.id)::int AS n
       FROM tv_channels c JOIN tv_programme_ratings r ON r.channel_id = c.id
      GROUP BY c.channel_name ORDER BY c.channel_name`,
  );
  assert.ok(rows.length >= 3, 'stub channels are created for ratings-only uploads');
});

test('aggregation scopes competitors to the brand category and excludes own brand', { skip }, async () => {
  const { rows } = await parseAdexWorkbook(await fixtures.adexWorkbook());
  await adexRepo.upsertAdexRows(rows);

  const brief = await briefRepo.insertBrief({
    brand: 'Alpha Cola', advertiser: 'Alpha Ltd', target_audience: 'Females 15-40',
    language: 'Sinhala', period_start: '2024-04-01', period_end: '2024-06-30',
    budget_lkr_lakhs: 250, medium_split: { tv: 70, radio: 20, press: 10 },
  });

  const data = await aggregate.buildAggregatedData(brief);
  assert.equal(data.scope.category, 'Beverages', 'category resolved from the brand');

  const brands = new Set(data.competitor_spend_by_quarter.map((r) => r.brand));
  assert.ok(brands.has('Beta Fizz'), 'the competitor is present');
  assert.ok(!brands.has('Alpha Cola'), 'the brief brand is excluded from its own competitor set');

  assert.ok(data.own_brand_trend.length > 0, 'own-brand trend is reported separately');
  assert.match(data.own_brand_trend[0].quarter, /^\d{4}-Q[1-4]$/);
});

test('aggregation returns programmes for the target audience', { skip }, async () => {
  const { channels } = await parseChannelWorkbook(await fixtures.channelWorkbook());
  const { ratings } = await parseGrpWorkbook(await fixtures.grpWorkbookLong());
  await tvRepo.persistTvUpload({ channels, ratings });

  const brief = await briefRepo.insertBrief({
    brand: 'Alpha Cola', target_audience: 'Females 15-40', language: 'Sinhala',
  });
  const data = await aggregate.buildAggregatedData(brief);

  assert.ok(data.programme_ratings.length > 0);
  assert.ok(
    data.programme_ratings.every((p) => /female/i.test(p.target_audience)),
    'only the requested audience is returned',
  );
  // Ranked by GRP.
  const grps = data.programme_ratings.map((p) => Number(p.grp));
  assert.deepEqual(grps, [...grps].sort((a, b) => b - a));
});

test('audience matching does not leak the opposite gender', { skip }, async () => {
  // "Females 15-40" and "Males 15-40" share the age tokens, and "male" is a
  // substring of "female" - both are ways a looser matcher hands a planner the
  // wrong demographic without saying so.
  const { channels } = await parseChannelWorkbook(await fixtures.channelWorkbook());
  const { ratings } = await parseGrpWorkbook(await fixtures.grpWorkbookWide());
  await tvRepo.persistTvUpload({ channels, ratings });

  const males = await briefRepo.insertBrief({ brand: 'X', target_audience: 'Males 15-40' });
  const data = await aggregate.buildAggregatedData(males);

  assert.ok(data.programme_ratings.length > 0);
  assert.ok(
    data.programme_ratings.every((p) => /^males/i.test(p.target_audience)),
    `expected only male audiences, got: ${[...new Set(data.programme_ratings.map((p) => p.target_audience))].join(', ')}`,
  );
});

test('aggregation declares an audience fallback rather than passing it off as targeted', { skip }, async () => {
  const { channels } = await parseChannelWorkbook(await fixtures.channelWorkbook());
  const { ratings } = await parseGrpWorkbook(await fixtures.grpWorkbookLong());
  await tvRepo.persistTvUpload({ channels, ratings });

  const brief = await briefRepo.insertBrief({
    brand: 'Alpha Cola', target_audience: 'Kids 4-9', language: 'Sinhala',
  });
  const data = await aggregate.buildAggregatedData(brief);

  assert.ok(data.programme_ratings.length > 0, 'something is still returned to work with');
  assert.ok(
    data.data_notes.some((n) => /did not match|No ratings matched/i.test(n)),
    'the mismatch is stated in data_notes so the model can caveat it',
  );
});

test('aggregation reports empty data instead of failing', { skip }, async () => {
  const brief = await briefRepo.insertBrief({ brand: 'Nonexistent Brand' });
  const data = await aggregate.buildAggregatedData(brief);

  assert.deepEqual(data.competitor_spend_by_quarter, []);
  assert.deepEqual(data.programme_ratings, []);
  assert.ok(data.data_notes.length > 0, 'gaps are described, not silent');
});

test('briefs round-trip the campaign period', { skip }, async () => {
  const brief = await briefRepo.insertBrief({
    brand: 'Alpha Cola', period_start: '2024-04-01', period_end: '2024-06-30',
    medium_split: { tv: 70, radio: 30 },
  });
  assert.equal(brief.period_start, '2024-04-01');
  assert.equal(brief.period_end, '2024-06-30');

  const fetched = await briefRepo.getBrief(brief.id);
  assert.equal(fetched.period_start, '2024-04-01');
  assert.equal(fetched.period_end, '2024-06-30');
  assert.deepEqual(fetched.medium_split, { tv: 70, radio: 30 });
});

test('a brief with no period is allowed', { skip }, async () => {
  const brief = await briefRepo.insertBrief({ brand: 'No Dates' });
  assert.equal(brief.period_start, null);
  assert.equal(brief.period_end, null);
});
