import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdexWorkbook } from '../src/parsers/adexParser.js';
import { parseChannelWorkbook } from '../src/parsers/tvChannelParser.js';
import { parseGrpWorkbook } from '../src/parsers/tvGrpParser.js';
import { adexWorkbook, channelWorkbook, grpWorkbookWide, grpWorkbookLong } from './fixtures.js';

test('adex parser finds the table under a banner and merged headers', async () => {
  const { rows, sheets } = await parseAdexWorkbook(await adexWorkbook(), { sourceFile: 'adex.xlsx' });

  assert.equal(rows.length, 4, 'four data rows, totals row excluded');
  assert.equal(sheets[0].headerRow, 4, 'header detected below the two banner rows');

  const jan = rows.find((r) => r.month === '2024-01-01' && r.brand === 'Alpha Cola');
  assert.ok(jan);
  assert.equal(jan.tv_spend_000, 1200.5, 'thousands separator handled');
  assert.equal(jan.press_spend_000, 150.25);
  assert.equal(jan.tv_freq, 45);
  assert.equal(jan.sector, 'FMCG');
  assert.equal(jan.category, 'Beverages');
  assert.equal(jan.quarter, '2024-Q1', 'quarter derived from month');
});

test('adex parser resolves merged medium banners to the right sub-columns', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  const jan = rows.find((r) => r.brand === 'Alpha Cola' && r.month === '2024-01-01');
  // "TV" merged across Spend/Freq/Dur must not bleed into the Radio group.
  assert.equal(jan.radio_spend_000, 300);
  assert.equal(jan.radio_freq, 20);
  assert.equal(jan.radio_dur_secs, 600);
  assert.equal(jan.press_ins, 4);
});

test('adex parser excludes totals rows', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  assert.ok(!rows.some((r) => r.tv_spend_000 === 5200), 'the Total row must not be ingested');
});

test('adex parser derives a missing total instead of dropping the spend', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  const feb = rows.find((r) => r.month === '2024-02-01' && r.brand === 'Alpha Cola');
  assert.equal(feb.tv_spend_000, -200, 'parenthesised negative');
  // Total column was blank: -200 + 100 + 50.
  assert.equal(feb.total_000, -50);
});

test('adex parser handles a different column order and wording', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook({ shuffled: true }));
  assert.equal(rows.length, 2);
  const alpha = rows.find((r) => r.brand === 'Alpha Cola');
  assert.equal(alpha.month, '2024-03-01');
  assert.equal(alpha.tv_spend_000, 900);
  assert.equal(alpha.advertiser, 'Alpha Ltd');
  assert.equal(alpha.product2, 'Regular', '"Product" maps to product2');
});

test('adex key columns are never null, so the unique constraint can fire', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  for (const row of rows) {
    for (const key of ['advertiser', 'brand', 'product2']) {
      assert.equal(typeof row[key], 'string', `${key} must be a string, not null`);
    }
  }
});

test('channel parser reads the master list under a banner', async () => {
  const { channels } = await parseChannelWorkbook(await channelWorkbook(), { sourceFile: 'ch.xlsx' });
  assert.equal(channels.length, 4);

  const derana = channels.find((c) => c.channel_name === 'TV Derana');
  assert.equal(derana.language, 'Sinhala');
  assert.equal(derana.category, 'General Entertainment', '"Genre" maps to category');
  assert.equal(derana.rate_card_ref, 'RC-2024-01');
  assert.ok(derana.raw.cells, 'unmapped columns are preserved in raw');
});

test('GRP parser unpivots a wide audience layout', async () => {
  const { ratings } = await parseGrpWorkbook(await grpWorkbookWide(), { sourceFile: 'grp.xlsx' });

  const audiences = [...new Set(ratings.map((r) => r.target_audience))].sort();
  assert.deepEqual(audiences, ['Females 15 40', 'Males 15 40']);

  const female = ratings.find(
    (r) => r.programme_name === 'Derana News' && r.target_audience === 'Females 15 40',
  );
  assert.equal(female.grp, 12.5);
  assert.equal(female.trp, 4.2, 'the TVR column under the same audience banner');
  assert.equal(female.channel_name, 'TV Derana');
});

test('GRP parser carries a blank channel down from the row above', async () => {
  const { ratings } = await parseGrpWorkbook(await grpWorkbookWide());
  const teledrama = ratings.filter((r) => r.programme_name === 'Teledrama Hour');
  assert.ok(teledrama.length);
  assert.ok(teledrama.every((r) => r.channel_name === 'TV Derana'));
});

test('GRP parser reads the survey period from the sheet banner', async () => {
  const { ratings } = await parseGrpWorkbook(await grpWorkbookWide());
  assert.equal(ratings[0].period_start, '2024-01-01');
  assert.equal(ratings[0].period_end, '2024-03-31');
});

test('GRP parser converts hh:mm:ss durations to seconds', async () => {
  const { ratings } = await parseGrpWorkbook(await grpWorkbookWide());
  const news = ratings.find((r) => r.programme_name === 'Derana News');
  assert.equal(news.avg_duration_secs, 1800, '00:30:00 is 1800 seconds');
});

test('GRP parser drops the totals row', async () => {
  const { ratings } = await parseGrpWorkbook(await grpWorkbookWide());
  assert.ok(!ratings.some((r) => r.programme_name?.toLowerCase().includes('total')));
});

test('GRP parser also handles the long layout', async () => {
  const { ratings } = await parseGrpWorkbook(await grpWorkbookLong());
  assert.equal(ratings.length, 3);
  const derana = ratings.find(
    (r) => r.programme_name === 'Derana News' && r.target_audience === 'Females 15-40',
  );
  assert.equal(derana.grp, 12.5);
  assert.equal(derana.period_start, '2024-01-01');
  assert.equal(derana.period_end, '2024-03-31');
});
