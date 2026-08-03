import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainSchedule, explainCompetitors } from '../src/llm/index.js';
import { checkPlanClutter } from '../src/services/clutter.js';

// The explorer's schedule step must not depend on a model being reachable: if
// no provider answers, a deterministic explanation is produced from the same
// numbers. An unknown provider makes getAdapter throw, which exercises exactly
// that fallback path without any network or database.

const SCHEDULE = [
  {
    channel_name: 'Derana', programme_name: 'Ada Derana 7PM', day_pattern: 'Mon - Fri',
    time_band: 'Evening Peak (1900 - 2059)', duration_secs: 30, spots: 4, tvr: 8.4,
    rate_lkr: 120000, cost_lkr: 480000,
  },
  {
    channel_name: 'Hiru', programme_name: 'Hiru News', day_pattern: 'Daily',
    time_band: 'Evening Peak (1900 - 2059)', duration_secs: 30, spots: 5, tvr: 15.3,
    rate_lkr: 150000, cost_lkr: 750000,
  },
];

const CONTEXT = {
  brief: {
    brand: 'Fizz', objective: 'Awareness', target_audience: 'Females 16-45',
    budget_lkr_lakhs: 15, commercial_durations: [15, 30],
  },
  schedule: SCHEDULE,
  totals: { total_spots: 9, total_cost_lkr: 1230000, total_cost_lakhs: 12.3 },
  budget: {
    total_cost_lakhs: 12.3, budget_lakhs: 15, utilisation_pct: 82, over_budget: false,
  },
  clutter: { ok: true, issues: [] },
  channels: [
    { channel_name: 'Derana', share_of_audience: 22.5, competitor: { grp_share_pct: 31.2 } },
    { channel_name: 'Hiru', share_of_audience: 28.1, competitor: { grp_share_pct: 40.5 } },
  ],
};

test('explainSchedule falls back deterministically when no provider answers', async () => {
  const out = await explainSchedule(CONTEXT, { provider: 'no-such-provider' });

  assert.equal(out.source, 'fallback');
  assert.equal(out.model_used, null);
  // Names both channels and the spot total in the rationale.
  assert.match(out.overall_rationale, /Derana/);
  assert.match(out.overall_rationale, /Hiru/);
  assert.match(out.overall_rationale, /9 spots/);
  // A clean clutter check is described as within limits, not flagged.
  assert.match(out.clutter_strategy, /within the clutter limits/i);
});

test('explainSchedule fallback returns a note per channel with its share', async () => {
  const out = await explainSchedule(CONTEXT, { provider: 'no-such-provider' });

  assert.equal(out.per_channel.length, 2);
  const derana = out.per_channel.find((p) => p.channel_name === 'Derana');
  assert.ok(derana, 'Derana note present');
  assert.match(derana.note, /22\.5% share/);
  assert.match(derana.note, /31\.2% of GRP/);
});

test('explainCompetitors falls back to a grounded read when no provider answers', async () => {
  const payload = {
    brand: 'Fizz',
    advertisers: [
      { name: 'Fizz', is_brand: true, ads: 100, cost: 5_000_000, sov: 30, sos: 25, value_addition_ads: 10, spot_ads: 90, pt_cost: 4_000_000, non_pt_cost: 1_000_000 },
      { name: 'Rival A', is_brand: false, ads: 200, cost: 12_000_000, sov: 60, sos: 60, value_addition_ads: 5, spot_ads: 195, pt_cost: 11_000_000, non_pt_cost: 1_000_000 },
    ],
    top_channels: [{ name: 'Derana', total: 9_000_000 }],
    top_programmes: [{ name: 'Dream Star', total: 4_000_000 }],
  };
  const out = await explainCompetitors(payload, { provider: 'no-such-provider' });
  assert.equal(out.source, 'fallback');
  assert.match(out.headline, /Fizz/);
  assert.match(out.headline, /Rival A/, 'names the leader it trails');
  assert.ok(out.recommendations.length >= 1, 'gives at least one recommendation');
  assert.ok(out.key_inputs.some((k) => /SOS/.test(k)), 'cites the figures it used');
});

test('the clutter check reads the belt from time_band, as schedule lines carry it', () => {
  // buildSchedule emits the belt as `time_band` (not `time_belt`), so the
  // clutter check must read it there or every real schedule collapses into one
  // "Unspecified" belt and is falsely flagged.
  const lines = [
    { channel_name: 'Hiru', time_band: 'Evening Peak (1900 - 2059)', spots: 2, spot_dates: { '2026-09-01': 1, '2026-09-08': 1 } },
    { channel_name: 'Derana', time_band: 'Noon (1100 - 1259)', spots: 2, spot_dates: { '2026-09-02': 1, '2026-09-09': 1 } },
    { channel_name: 'Sirasa', time_band: 'Afternoon (1300 - 1559)', spots: 2, spot_dates: { '2026-09-03': 1, '2026-09-10': 1 } },
  ];
  const result = checkPlanClutter(lines);
  const belts = result.by_belt.map((b) => b.time_belt);
  assert.ok(belts.includes('Evening Peak (1900 - 2059)'), 'reads Evening Peak from time_band');
  assert.ok(belts.includes('Noon (1100 - 1259)'), 'reads Noon from time_band');
  assert.ok(!belts.includes('Unspecified'), 'no belt is Unspecified');
  assert.equal(result.ok, true, 'an even split across three belts is not flagged');
});

test('explainSchedule fallback reports a flagged clutter breach', async () => {
  const flagged = {
    ...CONTEXT,
    clutter: { ok: false, issues: [{ detail: 'Evening Peak carries 78% of the buy.' }] },
  };
  const out = await explainSchedule(flagged, { provider: 'no-such-provider' });
  assert.match(out.clutter_strategy, /Evening Peak carries 78%/);
});
