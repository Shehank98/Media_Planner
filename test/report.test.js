import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildChartData } from '../src/services/chartData.js';
import { SAMPLE_AGGREGATED, SAMPLE_BRIEF } from './fixtures.js';

const PLAN = {
  id: 1,
  channel_plan: [
    {
      channel: 'HIRU TV', share_of_audience: 28.04, in_source_data: true,
      why_this_channel: 'Highest share of audience on the panel with 68% individual reach.',
      programmes: [
        { programme: 'PAATA KURULLO', day_pattern: 'MON - FRI',
          time_band: 'Evening Peak (1900 - 2059)', duration_secs: 20, spots: 8, tvr: 21.33,
          rate_lkr: 145000, rationale: 'Top-rated programme for the panel; Dove and Lifebuoy are already here.',
          in_source_data: true, rate_supported: true },
        { programme: 'AKURATA YANA WELAWE', day_pattern: 'SAT - SUN',
          time_band: 'Evening Peak (1900 - 2059)', duration_secs: 20, spots: 4, tvr: 19.96,
          rate_lkr: null, rationale: 'Weekend extension at near-equal rating.',
          in_source_data: true, rate_supported: null },
      ],
    },
    {
      channel: 'DERANA TV', share_of_audience: 19.81, in_source_data: true,
      why_this_channel: 'Highest individual reach, so it adds people Hiru alone does not reach.',
      programmes: [
        { programme: 'Invented Mega Show', day_pattern: 'MON - FRI',
          time_band: 'Afternoon (1300 - 1559)', duration_secs: 10, spots: 6, tvr: 10.54,
          rate_lkr: 900000, rationale: 'Not present in the supplied data.',
          in_source_data: false, rate_supported: null },
      ],
    },
  ],
  overall_rationale: 'Hiru and Derana together carry 48% of panel share for Meera 16-45 and, between them, 78% individual reach.',
  competitor_analysis: 'Dove and Lifebuoy dominate the top teledrama blocks - 554 GRP in Sangeethe and 453 in Paata Kurullo.',
  clutter_strategy: 'Evening Peak takes 12 of 18 spots. The rest sits in the afternoon, away from the crowded break.',
  budget_fit: 'Only the Paata Kurullo line has an observed rate.',
  confidence: 'medium',
  gaps_or_caveats: 'Media watch coverage is thin.',
  model_used: 'gemini:gemini-2.5-flash',
};

const BUDGET = {
  total_cost_lkr: 1160000, total_cost_lakhs: 11.6, budget_lkr: 25000000,
  budget_lakhs: 250, utilisation_pct: 4.6, over_budget: false,
  total_spots: 18, costed_spots: 8, uncosted_spots: 10,
};

const SCHEDULE = {
  dates: ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-08'],
  lines: [
    { channel_name: 'HIRU TV', programme_name: 'PAATA KURULLO', day_pattern: 'MON - FRI',
      time_band: 'Evening Peak (1900 - 2059)', duration_secs: 20, spots: 8, rate_lkr: 145000,
      cost_lkr: 1160000, spot_dates: { '2026-09-01': 4, '2026-09-03': 4 } },
    { channel_name: 'HIRU TV', programme_name: 'AKURATA YANA WELAWE', day_pattern: 'SAT - SUN',
      time_band: 'Evening Peak (1900 - 2059)', duration_secs: 20, spots: 4, rate_lkr: null,
      cost_lkr: null, spot_dates: { '2026-09-05': 4 } },
    { channel_name: 'DERANA TV', programme_name: 'Invented Mega Show', day_pattern: 'MON - FRI',
      time_band: 'Afternoon (1300 - 1559)', duration_secs: 10, spots: 6, rate_lkr: 900000,
      cost_lkr: null, spot_dates: { '2026-09-08': 6 } },
  ],
  totals: {
    channels: [
      { channel_name: 'HIRU TV', spots: 12, cost_lkr: 1160000, lines: 2, uncosted_lines: 1 },
      { channel_name: 'DERANA TV', spots: 6, cost_lkr: 0, lines: 1, uncosted_lines: 1 },
    ],
    total_spots: 18, total_cost_lkr: 1160000,
  },
};

const CLUTTER = {
  total_spots: 18,
  by_belt: [
    { time_belt: 'Evening Peak (1900 - 2059)', spots: 12, share_pct: 66.7 },
    { time_belt: 'Afternoon (1300 - 1559)', spots: 6, share_pct: 33.3 },
  ],
  issues: [{ severity: 'high', time_belt: 'Evening Peak (1900 - 2059)',
    detail: '66.7% of all spots sit in Evening Peak (1900 - 2059).' }],
  ok: false,
};

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', args, {
      cwd: path.resolve('report'),
      env: { ...process.env, MPLCONFIGDIR: path.join(os.tmpdir(), 'mpl-cache') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
}

test('chart data is derived from the aggregates', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, PLAN, SAMPLE_BRIEF);

  assert.deepEqual(charts.competitor_spend.categories, ['2026-Q1', '2026-Q2']);
  const dove = charts.competitor_spend.series.find((s) => s.label === 'Dove');
  assert.deepEqual(dove.values, [4550, 5200], 'quarters align across series');

  const own = charts.competitor_spend.series.find((s) => s.is_own_brand);
  assert.ok(own, 'the own brand is always charted, even when not a top spender');
  assert.deepEqual(own.values, [1650, 1150]);
});

test('chart data marks which programmes made the plan', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, PLAN, SAMPLE_BRIEF);
  const items = charts.programme_ratings.items;
  assert.equal(items[0].label, 'PAATA KURULLO (HIRU TV)', 'ranked by rating');
  assert.equal(items[0].recommended, true, 'reads programmes nested under channels');
  assert.equal(items.find((i) => i.label.startsWith('SANGEETHE')).recommended, false);
});

test('the day chart shades the days the plan actually buys', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, { ...PLAN, clutter: CLUTTER }, SAMPLE_BRIEF);
  // "MON - FRI" and "SAT - SUN" have to be expanded before they can be matched
  // against day columns.
  assert.deepEqual(charts.day_of_week.highlighted,
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
});

test('the time-belt chart contrasts the plan with competitor activity', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, { ...PLAN, clutter: CLUTTER }, SAMPLE_BRIEF);
  const belts = charts.time_belts;
  assert.equal(belts.available, true);

  const plan = belts.series.find((s) => s.is_plan);
  const competitors = belts.series.find((s) => !s.is_plan);
  assert.ok(plan && competitors, 'both series present');

  const peak = belts.categories.indexOf('Evening Peak (1900 - 2059)');
  assert.ok(peak >= 0);
  assert.equal(plan.values[peak], 66.7, "the plan's own share");
  assert.ok(competitors.values[peak] > 0, 'against observed competitor activity');
});

test('the time-belt chart reports unavailable rather than empty', () => {
  const charts = buildChartData(
    { ...SAMPLE_AGGREGATED, time_belt_clutter: [] }, {}, SAMPLE_BRIEF,
  );
  assert.equal(charts.time_belts.available, false);
});

test('the python worker renders a complete PDF', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-report-test-'));
  try {
    const payload = {
      brief: SAMPLE_BRIEF,
      plan: PLAN,
      chart_data: buildChartData(SAMPLE_AGGREGATED, { ...PLAN, clutter: CLUTTER }, SAMPLE_BRIEF),
      aggregated: SAMPLE_AGGREGATED,
      budget: BUDGET,
      schedule: SCHEDULE,
      clutter: CLUTTER,
      meta: { model_used: 'gemini:gemini-2.5-flash' },
    };
    const payloadPath = path.join(dir, 'payload.json');
    const outPath = path.join(dir, 'report.pdf');
    await fs.writeFile(payloadPath, JSON.stringify(payload));

    await runPython(['build_report.py', '--payload', payloadPath, '--out', outPath, '--charts-dir', dir]);

    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 30_000, `PDF looks too small at ${stat.size} bytes`);

    const head = (await fs.readFile(outPath)).subarray(0, 5).toString();
    assert.equal(head, '%PDF-', 'output is a real PDF');

    for (const chart of ['competitor_spend.png', 'programme_ratings.png',
      'day_of_week.png', 'time_belts.png']) {
      const s = await fs.stat(path.join(dir, chart));
      assert.ok(s.size > 5_000, `${chart} did not render`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the report renders even with no data at all', async () => {
  // A brief uploaded before any TVR file has been provided must still produce a
  // document that says so, rather than crashing the export.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-report-empty-'));
  try {
    const empty = {
      scope: {}, competitor_spend_by_quarter: [], own_brand_trend: [],
      category_totals_by_quarter: [], programme_ratings: [], channel_performance: [],
      best_days: [], best_dayparts: [], programme_rates: [], competitor_spot_pressure: [],
      time_belt_clutter: [],
      data_notes: ['No programme rating data is available for this brief.'],
    };
    const emptyPlan = {
      channel_plan: [], overall_rationale: '', competitor_analysis: '',
      confidence: 'low', gaps_or_caveats: 'No data was available.',
    };
    const payload = {
      brief: { brand: 'Untested Brand' },
      plan: emptyPlan,
      chart_data: buildChartData(empty, emptyPlan, { brand: 'Untested Brand' }),
      aggregated: empty,
      meta: {},
    };
    const payloadPath = path.join(dir, 'payload.json');
    const outPath = path.join(dir, 'report.pdf');
    await fs.writeFile(payloadPath, JSON.stringify(payload));

    await runPython(['build_report.py', '--payload', payloadPath, '--out', outPath, '--charts-dir', dir]);
    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 5_000, 'an empty-state report is still produced');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
