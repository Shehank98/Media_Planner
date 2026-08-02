import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportHtml } from '../src/services/reportHtml.js';
import { filterAggregatedToChannels } from '../src/services/planService.js';

// --- the print-ready HTML report -------------------------------------------

const PLAN = {
  confidence: 'medium',
  overall_rationale: 'Two channels carry the audience.',
  competitor_analysis: 'Rivals concentrate in prime time on Hiru.',
  recommended_lineup: [{
    channel: 'Hiru', share_of_audience: 28.1, why_this_channel: 'Highest share.',
    programmes: [{
      programme: 'Hiru News', day_pattern: 'Mon - Fri', time_band: 'Evening Peak (1900 - 2059)',
      duration_secs: 30, spots: 6, tvr: 15.3, rate_lkr: 151500,
    }],
  }],
  chart_data: {
    schedule_totals: { total_spots: 6 },
    budget: { budget_lakhs: 15, total_cost_lakhs: 9.09, utilisation_pct: 60.6, over_budget: false, total_spots: 6 },
    clutter_strategy: 'Spread across belts.',
  },
};
const SCHEDULE = [{
  channel_name: 'Hiru', programme_name: 'Hiru News', day_pattern: 'Mon - Fri',
  time_band: 'Evening Peak (1900 - 2059)', duration_secs: 30, tvr: 15.3, spots: 6,
  cost_lkr: 909000, spot_dates: { '2026-09-01': 1, '2026-09-03': 1, '2026-09-07': 1 },
}];

test('report HTML is a standalone document with the plan and a print control', () => {
  const html = buildReportHtml({
    brief: { brand: 'Fizz', objective: 'Awareness', period_start: '2026-09-01', period_end: '2026-09-14', budget_lkr_lakhs: 15 },
    plan: PLAN, schedule: SCHEDULE,
  });
  assert.ok(html.startsWith('<!doctype html>'), 'is a full document');
  assert.match(html, /Fizz/);
  assert.match(html, /Hiru News/);
  assert.match(html, /Evening Peak/);
  assert.match(html, /window\.print\(\)/, 'has a print button for save-as-PDF');
  assert.match(html, /09-01/, 'the dated grid is present');
});

test('report HTML escapes untrusted brief text', () => {
  const html = buildReportHtml({ brief: { brand: '<script>alert(1)</script>' }, plan: {}, schedule: [] });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script is not emitted');
  assert.match(html, /&lt;script&gt;/);
});

test('report HTML renders even with an empty plan', () => {
  const html = buildReportHtml({ brief: {}, plan: {}, schedule: [] });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /Media plan/);
});

// --- narrowing the model payload to chosen channels ------------------------

test('filterAggregatedToChannels keeps only the chosen channels', () => {
  const aggregated = {
    programme_ratings: [
      { channel_name: 'Hiru', programme_name: 'Hiru News' },
      { channel_name: 'Derana', programme_name: 'Ada Derana' },
      { channel_name: 'Sirasa', programme_name: 'Sirasa News' },
    ],
    channel_performance: [
      { channel_name: 'Hiru' }, { channel_name: 'Derana' }, { channel_name: 'Sirasa' },
    ],
    competitor_spot_pressure: [{ channel_name: 'Sirasa', programme_name: 'Sirasa News' }],
    data_notes: ['existing note'],
  };
  const out = filterAggregatedToChannels(aggregated, ['Hiru', 'Derana']);

  assert.deepEqual(out.programme_ratings.map((p) => p.channel_name), ['Hiru', 'Derana']);
  assert.deepEqual(out.channel_performance.map((c) => c.channel_name), ['Hiru', 'Derana']);
  assert.equal(out.competitor_spot_pressure.length, 0, 'Sirasa competitor rows dropped');
  assert.ok(out.data_notes.some((n) => /restricted to the channels you chose/.test(n)));
  assert.ok(out.data_notes.includes('existing note'), 'existing notes are kept');
});

test('filterAggregatedToChannels matches channel names case- and spacing-insensitively', () => {
  const out = filterAggregatedToChannels(
    { programme_ratings: [{ channel_name: 'TV Derana' }, { channel_name: 'hiru' }] },
    ['tv  derana'],
  );
  assert.deepEqual(out.programme_ratings.map((p) => p.channel_name), ['TV Derana']);
});
