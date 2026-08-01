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
  recommended_lineup: [
    { channel: 'TV Derana', programme: 'Teledrama Hour', day_part: 'Prime Time', grp: 18.2, rationale: 'Highest GRP against the target audience, and Beta Fizz is not buying it.', in_source_data: true },
    { channel: 'TV Derana', programme: 'Derana News', day_part: 'Prime Time', grp: 12.5, rationale: 'Consistent delivery at a lower rate than the teledrama block.', in_source_data: true },
    { channel: 'Sirasa TV', programme: 'Sunday Blockbuster', day_part: 'Weekend', grp: 9.0, rationale: 'Weekend reach extension.', in_source_data: false },
  ],
  overall_rationale: 'Alpha Cola has been outspent roughly four to one by Beta Fizz over the last two quarters. The plan concentrates the TV budget on prime-time Sinhala programming where the target audience is strongest.',
  competitor_analysis: 'Beta Fizz spent LKR 5.2m in Q1 against Alpha Cola\'s 1.15m, with 81% of that on TV. Gamma Drink is the only brand meaningfully present in radio.',
  confidence: 'medium',
  gaps_or_caveats: 'Rating data covers Jan-Mar 2024 only.\n\nAutomated check: 1 recommended entry could not be matched to the supplied rating data (Sirasa TV - Sunday Blockbuster).',
  model_used: 'gemini:gemini-2.5-flash',
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

  assert.deepEqual(charts.competitor_spend.categories, ['2023-Q4', '2024-Q1']);
  const beta = charts.competitor_spend.series.find((s) => s.label === 'Beta Fizz');
  assert.deepEqual(beta.values, [4550, 5200], 'quarters align across series');

  const own = charts.competitor_spend.series.find((s) => s.is_own_brand);
  assert.ok(own, 'the own brand is always charted, even when not a top spender');
  assert.deepEqual(own.values, [1650, 1150]);
});

test('chart data marks which programmes made the lineup', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, PLAN, SAMPLE_BRIEF);
  const items = charts.programme_ratings.items;
  assert.equal(items[0].label, 'Teledrama Hour (TV Derana)', 'ranked by rating');
  assert.equal(items[0].recommended, true);
  assert.equal(items.find((i) => i.label.startsWith('Sirasa News')).recommended, false);
});

test('medium split charts the brief against the category benchmark', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, PLAN, SAMPLE_BRIEF);
  assert.equal(charts.medium_split.brief.available, true);
  assert.deepEqual(
    charts.medium_split.brief.slices,
    [{ label: 'TV', value: 70 }, { label: 'Radio', value: 20 }, { label: 'Press', value: 10 }],
  );

  const benchmark = charts.medium_split.benchmark;
  assert.equal(benchmark.available, true);
  const total = benchmark.slices.reduce((a, s) => a + s.value, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `benchmark shares should total 100, got ${total}`);
});

test('medium split copes with a brief that states no split', () => {
  const charts = buildChartData(SAMPLE_AGGREGATED, PLAN, { ...SAMPLE_BRIEF, medium_split: null });
  assert.equal(charts.medium_split.brief.available, false);
  assert.equal(charts.medium_split.benchmark.available, true, 'the benchmark still renders');
});

test('the python worker renders a complete PDF', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-report-test-'));
  try {
    const payload = {
      brief: SAMPLE_BRIEF,
      plan: PLAN,
      chart_data: buildChartData(SAMPLE_AGGREGATED, PLAN, SAMPLE_BRIEF),
      aggregated: SAMPLE_AGGREGATED,
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

    for (const chart of ['competitor_spend.png', 'programme_ratings.png', 'medium_split.png']) {
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
      category_totals_by_quarter: [], programme_ratings: [], channels: [],
      data_notes: ['No programme rating data is available for this brief.'],
    };
    const emptyPlan = {
      recommended_lineup: [], overall_rationale: '', competitor_analysis: '',
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
