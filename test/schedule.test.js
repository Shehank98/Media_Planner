import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule, daysForPattern, distributeSpots, summarise,
} from '../src/services/schedule.js';
import { checkPlanClutter, beltForTime, TIME_BELTS } from '../src/services/clutter.js';

// --- day patterns ----------------------------------------------------------

test('day patterns resolve to the weekdays a planner means', () => {
  // 0 = Sunday, matching Date#getUTCDay.
  assert.deepEqual(daysForPattern('MON - FRI').days, [1, 2, 3, 4, 5]);
  assert.deepEqual(daysForPattern('Weekdays').days, [1, 2, 3, 4, 5]);
  assert.deepEqual(daysForPattern('SAT - SUN').days, [6, 0]);
  assert.deepEqual(daysForPattern('Weekends').days, [6, 0]);
  assert.deepEqual(daysForPattern('TUE - THU').days, [2, 3, 4]);
  assert.deepEqual(daysForPattern('Mon, Wed, Fri').days.sort(), [1, 3, 5]);
});

test('an unreadable day pattern falls back to every day, and says so', () => {
  // Dropping the line would silently shrink the plan; a wider spread is
  // visible and correctable.
  const result = daysForPattern('whenever there is room');
  assert.equal(result.recognised, false);
  assert.equal(result.days.length, 7);
});

// --- spot distribution -----------------------------------------------------

test('spots are spread across the available dates, not bunched', () => {
  const dates = Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const grid = distributeSpots(3, dates);

  const placed = Object.keys(grid).sort();
  assert.equal(placed.length, 3);
  assert.equal(Object.values(grid).reduce((a, b) => a + b, 0), 3, 'every spot is placed');

  // Three spots over fifteen days belong apart, not on consecutive days.
  const positions = placed.map((d) => dates.indexOf(d));
  const gaps = positions.slice(1).map((p, i) => p - positions[i]);
  assert.ok(Math.min(...gaps) >= 3, `expected spacing, got positions ${positions.join(',')}`);
});

test('more spots than dates doubles up rather than dropping any', () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03'];
  const grid = distributeSpots(7, dates);
  assert.equal(Object.values(grid).reduce((a, b) => a + b, 0), 7);
  // 7 over 3 days: 3, 2, 2 - the remainder front-loads.
  assert.deepEqual(Object.values(grid), [3, 2, 2]);
});

test('no dates means no spots placed, rather than an exception', () => {
  assert.deepEqual(distributeSpots(5, []), {});
  assert.deepEqual(distributeSpots(0, ['2026-09-01']), {});
});

// --- schedule --------------------------------------------------------------

const BRIEF = { period_start: '2026-09-01', period_end: '2026-09-21' };

const PLAN = [
  {
    channel: 'HIRU TV',
    programmes: [
      {
        programme: 'PAATA KURULLO', day_pattern: 'MON - FRI',
        time_band: 'Evening Peak (1900 - 2059)', duration_secs: 20, spots: 8, tvr: 21.33,
      },
      {
        programme: 'AKURATA YANA WELAWE', day_pattern: 'SAT - SUN',
        time_band: 'Evening Peak (1900 - 2059)', duration_secs: 20, spots: 4, tvr: 19.96,
      },
    ],
  },
];

const RATES = [
  { channel_name: 'HIRU TV', programme_name: 'PAATA KURULLO', duration_secs: 20, avg_cost: 145000 },
];

test('the schedule places spots only on the days the pattern allows', () => {
  const { lines } = buildSchedule(PLAN, BRIEF, RATES);
  assert.equal(lines.length, 2);

  const weekday = lines.find((l) => l.day_pattern === 'MON - FRI');
  for (const date of Object.keys(weekday.spot_dates)) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${date} is not a weekday`);
  }

  const weekend = lines.find((l) => l.day_pattern === 'SAT - SUN');
  for (const date of Object.keys(weekend.spot_dates)) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    assert.ok(dow === 0 || dow === 6, `${date} is not a weekend day`);
  }
});

test('every spot lands inside the campaign period', () => {
  const { lines } = buildSchedule(PLAN, BRIEF, RATES);
  for (const line of lines) {
    for (const date of Object.keys(line.spot_dates)) {
      assert.ok(date >= BRIEF.period_start && date <= BRIEF.period_end,
        `${date} falls outside ${BRIEF.period_start}..${BRIEF.period_end}`);
    }
    const placed = Object.values(line.spot_dates).reduce((a, b) => a + b, 0);
    assert.equal(placed, line.spots, 'the placed count matches the line total');
  }
});

test('the schedule accepts the brief in the shape the model receives', () => {
  // analyzeAndRecommend is handed the model-facing brief, which nests the
  // dates. Reading only the flat form silently produced an empty grid.
  const nested = { campaign_period: { start: '2026-09-01', end: '2026-09-21' } };
  const { lines, warnings } = buildSchedule(PLAN, nested, RATES);
  assert.ok(Object.keys(lines[0].spot_dates).length > 0, 'spots were placed');
  assert.equal(warnings.length, 0);
});

test('rates are joined from observed cost when the model omits them', () => {
  const { lines } = buildSchedule(PLAN, BRIEF, RATES);
  const costed = lines.find((l) => l.programme_name === 'PAATA KURULLO');
  assert.equal(costed.rate_lkr, 145000, 'rate taken from media watch');
  assert.equal(costed.cost_lkr, 145000 * 8);
  assert.equal(costed.rate_observed, true);

  const uncosted = lines.find((l) => l.programme_name === 'AKURATA YANA WELAWE');
  assert.equal(uncosted.rate_lkr, null, 'no observation, so no invented price');
  assert.equal(uncosted.cost_lkr, null);
});

test('a brief with no period reports the gap instead of guessing dates', () => {
  const { lines, warnings } = buildSchedule(PLAN, {}, RATES);
  assert.equal(lines.length, 2, 'the lineup is still costed');
  assert.deepEqual(lines[0].spot_dates, {});
  assert.match(warnings[0], /no campaign period/i);
});

test('a day pattern with no matching day in the flight is reported', () => {
  // A one-week Monday-to-Friday flight cannot carry a weekend line.
  const { warnings } = buildSchedule(
    PLAN, { period_start: '2026-09-07', period_end: '2026-09-11' }, RATES,
  );
  assert.ok(warnings.some((w) => /no such day falls inside the campaign period/.test(w)));
});

test('summarise totals by channel and overall', () => {
  const { totals } = buildSchedule(PLAN, BRIEF, RATES);
  assert.equal(totals.total_spots, 12);
  assert.equal(totals.total_cost_lkr, 145000 * 8);
  assert.equal(totals.channels.length, 1);
  assert.equal(totals.channels[0].channel_name, 'HIRU TV');
  assert.equal(totals.uncosted_spots, 4, 'the weekend line has no rate');
});

test('summarise totals GRPs as TVR x spots and grades the weight', () => {
  const { totals } = buildSchedule(PLAN, BRIEF, RATES);
  // 21.33*8 + 19.96*4 = 170.64 + 79.84 = 250.48
  assert.equal(totals.total_grp, 250.5);
  assert.equal(totals.channels[0].grp, 250.5);
  assert.equal(totals.weight_band, 'light', 'below the maintenance benchmark');
});

test('weight bands follow the launch and maintenance benchmarks', () => {
  const grpFor = (tvr, spots) => summarise([{ channel_name: 'C', tvr, spots }]).weight_band;
  assert.equal(grpFor(30, 30), 'launch', '900 GRPs is launch weight');
  assert.equal(grpFor(10, 55), 'maintenance', '550 GRPs is maintenance weight');
  assert.equal(grpFor(5, 20), 'light', '100 GRPs is light');
  assert.equal(summarise([]).weight_band, 'none');
});

test('summarise copes with an empty schedule', () => {
  const totals = summarise([]);
  assert.equal(totals.total_spots, 0);
  assert.equal(totals.total_grp, 0);
  assert.deepEqual(totals.channels, []);
});

// --- clutter ---------------------------------------------------------------

test('time belts cover the day without overlapping', () => {
  // "Morning (0500 - 1059)" also exists in the MICOS data as a rollup over
  // three of these; counting it too would double every morning spot.
  const sorted = [...TIME_BELTS].sort((a, b) => a.from - b.from);
  assert.equal(sorted[0].from, 0);
  assert.equal(sorted[sorted.length - 1].to, 24);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.equal(sorted[i].from, sorted[i - 1].to, 'belts must be contiguous and non-overlapping');
  }
});

test('beltForTime reads clock times and band labels alike', () => {
  assert.equal(beltForTime('19:30'), 'Evening Peak (1900 - 2059)');
  assert.equal(beltForTime('08:00'), 'Morning Off-Peak (0800 - 1059)');
  assert.equal(beltForTime('Evening Peak (1900 - 2059)'), 'Evening Peak (1900 - 2059)');
  assert.equal(beltForTime(''), null);
});

test('a plan spread across belts passes the clutter check', () => {
  const lines = [
    { channel_name: 'A', time_belt: 'Evening Peak (1900 - 2059)', spots: 4, spot_dates: { '2026-09-01': 2, '2026-09-03': 2 } },
    { channel_name: 'A', time_belt: 'Afternoon (1300 - 1559)', spots: 4, spot_dates: { '2026-09-02': 2, '2026-09-04': 2 } },
    { channel_name: 'B', time_belt: 'Morning Off-Peak (0800 - 1059)', spots: 4, spot_dates: { '2026-09-01': 2, '2026-09-03': 2 } },
  ];
  const result = checkPlanClutter(lines);
  assert.equal(result.total_spots, 12);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('a plan stacked into one belt is flagged', () => {
  // The failure the user described: everything piled into one half hour.
  const lines = [
    { channel_name: 'A', time_belt: 'Evening Peak (1900 - 2059)', spots: 10, spot_dates: { '2026-09-01': 10 } },
    { channel_name: 'B', time_belt: 'Afternoon (1300 - 1559)', spots: 2, spot_dates: { '2026-09-01': 2 } },
  ];
  const result = checkPlanClutter(lines);
  assert.equal(result.ok, false);

  const share = result.issues.find((i) => i.severity === 'high');
  assert.ok(share, 'the belt share breach is reported');
  assert.match(share.detail, /Evening Peak/);
  assert.match(share.detail, /83\.3%/);
});

test('too many channels in one belt on one day is flagged', () => {
  // Three channels airing in the same belt on the same day duplicates viewers
  // rather than adding them.
  const lines = ['A', 'B', 'C', 'D'].map((channel_name) => ({
    channel_name,
    time_belt: 'Evening Peak (1900 - 2059)',
    spots: 1,
    spot_dates: { '2026-09-01': 1 },
  }));
  const result = checkPlanClutter(lines);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => /channels run in/.test(i.detail)));
});

test('an empty plan is not reported as cluttered', () => {
  const result = checkPlanClutter([]);
  assert.equal(result.ok, true);
  assert.equal(result.total_spots, 0);
});
