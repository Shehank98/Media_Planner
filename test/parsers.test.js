import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdexWorkbook } from '../src/parsers/adexParser.js';
import { parseMicosWorkbook } from '../src/parsers/micosParser.js';
import { parseMediaWatch } from '../src/parsers/mediaWatchParser.js';
import {
  adexWorkbook, micosChannelDetails, micosChannelDashboards, micosSpotGrp, mediaWatchTsv,
} from './fixtures.js';

// --- adex ------------------------------------------------------------------

test('adex parser reads the real column wording under a banner', async () => {
  const { rows, sheets } = await parseAdexWorkbook(await adexWorkbook(), { sourceFile: 'adex.xlsx' });

  assert.equal(rows.length, 3, 'three data rows, totals row excluded');
  assert.equal(sheets[0].headerRow, 4, 'header found below the two banner rows');

  const jan = rows.find((r) => r.month === '2021-01-01');
  assert.ok(jan);
  assert.equal(jan.brand, 'Cavin Kare');
  assert.equal(jan.advertiser, 'Cavin Kare Lanka (Pvt) Ltd.');
  assert.equal(jan.tv_spend_000, 1200.5, 'thousands separator handled');
  assert.equal(jan.press_spend_000, 188);
  assert.equal(jan.product2, 'Cavin', '"Product 2" maps to product2');
  assert.equal(jan.fy, '20-21');
});

test('adex parser resolves merged medium banners to the right sub-columns', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  const jan = rows.find((r) => r.month === '2021-01-01');
  // "Tv" merged over (000Rs)/Frq/Dur must not bleed into the Radio group.
  assert.equal(jan.tv_freq, 45);
  assert.equal(jan.tv_dur_secs, 900);
  assert.equal(jan.radio_spend_000, 300);
  assert.equal(jan.radio_freq, 20);
  assert.equal(jan.press_ins, 1);
});

test('adex parser reads the sheet quarter label rather than deriving it', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  // The adex files run on a financial year: January 2021 is Q4 of FY20-21,
  // not calendar Q1. Overriding that with a derived quarter would silently
  // reassign a third of the year.
  const jan = rows.find((r) => r.month === '2021-01-01');
  assert.equal(jan.quarter, 'Q4');
  assert.equal(jan.month2, 'January');
});

test('adex parser excludes totals rows', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  assert.ok(!rows.some((r) => r.tv_spend_000 === 3400.5), 'the Total row must not be ingested');
});

test('adex parser derives a missing total instead of dropping the spend', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  const mar = rows.find((r) => r.month === '2021-03-01');
  assert.equal(mar.tv_spend_000, -200, 'parenthesised negative');
  assert.equal(mar.total_000, -50, '-200 + 100 + 50');
});

test('adex parser handles a different column order and wording', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook({ shuffled: true }));
  assert.equal(rows.length, 2);
  const cavin = rows.find((r) => r.brand === 'Cavin Kare');
  assert.equal(cavin.month, '2021-04-01');
  assert.equal(cavin.tv_spend_000, 900);
});

test('adex key columns are never null, so the unique constraint can fire', async () => {
  const { rows } = await parseAdexWorkbook(await adexWorkbook());
  for (const row of rows) {
    for (const key of ['advertiser', 'brand', 'product2']) {
      assert.equal(typeof row[key], 'string', `${key} must be a string, not null`);
    }
  }
});

// --- MICOS -----------------------------------------------------------------

test('MICOS parser reads the survey window and custom target group', async () => {
  const { meta } = await parseMicosWorkbook(await micosChannelDetails(), { sourceFile: 'cd.xlsx' });
  assert.equal(meta.target_audience, 'Meera 16-45', 'read from "Custom TG:" on the Target sheet');
  assert.equal(meta.period_start, '2026-06-01');
  assert.equal(meta.period_end, '2026-06-30');
  assert.equal(meta.exported_by, 'planner@agency.lk');
});

test('MICOS parser identifies the C1 top-programmes sheet', async () => {
  const r = await parseMicosWorkbook(await micosChannelDetails());
  assert.equal(r.programmes.length, 4);

  const top = r.programmes.find((p) => p.programme_name === 'PAATA KURULLO');
  assert.equal(top.channel_name, 'HIRU TV');
  assert.equal(top.trp, 21.33, '"Avg. Ratings" is a TVR, stored as trp');
  assert.equal(top.grp, null, 'and must not be mistaken for GRP');
  assert.equal(top.instances, 22);
  assert.equal(top.avg_duration_secs, 1620, 'MICOS reports 27 minutes; stored as seconds');
  assert.equal(top.programme_category, 'TELEDRAMAS - SINHALA');
  assert.equal(top.target_audience, 'Meera 16-45');
  assert.equal(top.rank, 1);
});

test('MICOS parser ignores the PivotTable helper sheet', async () => {
  const r = await parseMicosWorkbook(await micosChannelDetails());
  const helper = r.sheets.find((s) => s.sheet === 'Sheet1');
  assert.match(helper.kind, /ignored/, 'Sheet1 is derived data and would double-count');
  assert.equal(r.warnings.filter((w) => w.includes('Sheet1')).length, 0, 'and is not warned about');
});

test('MICOS parser separates the A1, A2 and A3 dashboards', async () => {
  const r = await parseMicosWorkbook(await micosChannelDashboards());

  assert.equal(r.channelPerformance.length, 2);
  assert.equal(r.channelDays.length, 4);
  assert.equal(r.channelDayparts.length, 3);

  const hiru = r.channelPerformance.find((c) => c.channel_name === 'HIRU TV');
  assert.equal(hiru.share_of_audience, 28.04);
  assert.equal(hiru.individual_reach_pct, 68.06);
});

test('A2 rows carry a day of week and A3 rows carry a time band', async () => {
  const r = await parseMicosWorkbook(await micosChannelDashboards());

  // The two sheets share one table, distinguished by which field is populated.
  assert.ok(r.channelDays.every((d) => d.day_of_week && !d.time_of_day));
  assert.ok(r.channelDayparts.every((d) => d.time_of_day && !d.day_of_week));

  const tuesday = r.channelDays.find((d) => d.channel_name === 'HIRU TV' && d.day_of_week === 'Tuesday');
  assert.equal(tuesday.ratings, 23787.48);

  const peak = r.channelDayparts.find((d) => d.day_group === 'Weekdays');
  assert.equal(peak.time_of_day, 'Evening Peak (1900 - 2059)');
  assert.equal(peak.ratings, 33292.55);
});

test('MICOS parser reads the spot-level GRP sheet', async () => {
  const r = await parseMicosWorkbook(await micosSpotGrp(), { sourceFile: 'grp.xlsx' });
  assert.equal(r.spots.length, 3);

  const dove = r.spots.find((s) => s.brand === 'Dove');
  assert.equal(dove.aired_at, '2026-06-02 20:15:00');
  assert.equal(dove.channel_name, 'HIRU TV');
  assert.equal(dove.programme_name, 'PAATA KURULLO');
  assert.equal(dove.company, 'Unilever Sri Lanka Limited');
  assert.equal(dove.duration_secs, 15);
  assert.equal(dove.grp, 25.18);
  assert.equal(dove.category, 'Shampoos/conditioners');
  assert.equal(dove.not_rated, false);
});

test('the spot-level export has no target group of its own', async () => {
  // The real file omits the "Custom TG" line, which is why the upload route
  // carries the audience across from sibling files in the same upload.
  const r = await parseMicosWorkbook(await micosSpotGrp());
  assert.equal(r.meta.target_audience, null);
  assert.ok(
    r.warnings.some((w) => /Custom TG/.test(w)),
    'the missing audience is reported rather than silently left blank',
  );
});

test('MICOS parser reports a sheet it cannot identify', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mystery');
  ws.addRow(['Alpha', 'Beta', 'Gamma']);
  ws.addRow([1, 2, 3]);
  const r = await parseMicosWorkbook(await wb.xlsx.writeBuffer());
  assert.ok(r.warnings.some((w) => w.includes('Mystery')), 'unknown layouts are surfaced');
});

// --- media watch -----------------------------------------------------------

test('media watch parser reads a tab-delimited spot log', async () => {
  const { spots } = await parseMediaWatch(mediaWatchTsv(), { sourceFile: 'mw.tsv' });
  assert.equal(spots.length, 3);

  const radio = spots.find((s) => s.programme_name === 'Hathara Wate');
  assert.equal(radio.cost, 13000, 'thousands separator handled');
  assert.equal(radio.duration_secs, 15);
  assert.equal(radio.aired_on, '2025-02-06', 'date assembled from Dd/Mn/Yr');
  assert.equal(radio.language, 'Sinhala', '"Sin" expanded');
  assert.equal(radio.advertiser, 'Mobitel Lanka Ltd.');
});

test('media watch parser splits the medium off the channel label', async () => {
  const { spots } = await parseMediaWatch(mediaWatchTsv());
  const radio = spots.find((s) => s.programme_name === 'Hathara Wate');
  assert.equal(radio.medium, 'Radio');
  assert.equal(radio.channel_name, 'Neth FM', 'prefix stripped so it joins to MICOS channel names');

  const tv = spots.find((s) => s.programme_name === 'PAATA KURULLO');
  assert.equal(tv.medium, 'TV');
  assert.equal(tv.channel_name, 'HIRU TV');
});

test('media watch spots join to MICOS programmes by channel and programme', async () => {
  // The whole point of the cost feed: it must line up with the ratings data.
  const { spots } = await parseMediaWatch(mediaWatchTsv());
  const micos = await parseMicosWorkbook(await micosChannelDetails());

  const tvSpot = spots.find((s) => s.medium === 'TV');
  const match = micos.programmes.find(
    (p) => p.channel_name.toLowerCase() === tvSpot.channel_name.toLowerCase()
      && p.programme_name.toLowerCase() === tvSpot.programme_name.toLowerCase(),
  );
  assert.ok(match, 'the TV spot resolves to a rated programme');
  assert.equal(match.trp, 21.33);
});

test('media watch parser also accepts a workbook', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Spots');
  ws.addRow(['Channel', 'Program', 'Dd', 'Mn', 'Yr', 'Advt_time', 'Dur', 'Cost']);
  ws.addRow(['TV - HIRU TV', 'PAATA KURULLO', 3, 6, 2026, '20:20:11', 15, 145000]);
  const { spots } = await parseMediaWatch(await wb.xlsx.writeBuffer(), { sourceFile: 'mw.xlsx' });
  assert.equal(spots.length, 1);
  assert.equal(spots[0].cost, 145000);
});
