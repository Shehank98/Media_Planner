import { beltForTime } from './clutter.js';

// ---------------------------------------------------------------------------
// Expand a recommended lineup into a dated schedule.
//
// The model says "MON - FRI, 6 spots"; the schedule needs those six spots
// placed on actual dates across the campaign. That placement is arithmetic over
// a calendar, so it happens here rather than in the prompt: a model asked to
// emit sixty date columns will drop days, double-count, and put spots outside
// the flight, and none of that is visible until someone checks by hand.
//
// The output matches the agency schedule format: one line per
// channel/programme/day-pattern/duration, with a date -> spots map.
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Which weekdays a day pattern covers.
 *
 * Handles "MON - FRI", "SAT - SUN", "Weekdays", "Weekends", a single day, and
 * comma lists. Anything unrecognised falls back to every day, flagged by the
 * caller, because dropping the line entirely would silently shrink the plan.
 */
export function daysForPattern(pattern) {
  const text = String(pattern || '').trim().toLowerCase();
  if (!text) return { days: [0, 1, 2, 3, 4, 5, 6], recognised: false };

  if (/week\s*days?\b/.test(text) || /^mon\s*[-–to]+\s*fri/.test(text)) {
    return { days: [1, 2, 3, 4, 5], recognised: true };
  }
  if (/week\s*ends?\b/.test(text) || /^sat\s*[-–to]+\s*sun/.test(text)) {
    return { days: [6, 0], recognised: true };
  }
  if (/^(all|every)\s*day/.test(text) || text === 'daily' || /^mon\s*[-–to]+\s*sun/.test(text)) {
    return { days: [1, 2, 3, 4, 5, 6, 0], recognised: true };
  }

  // A range like "TUE - THU".
  const range = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*[-–]\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/);
  if (range) {
    const start = SHORT_DAYS[range[1]];
    const end = SHORT_DAYS[range[2]];
    const days = [];
    for (let i = 0, d = start; i < 7; i += 1, d = (d + 1) % 7) {
      days.push(d);
      if (d === end) break;
    }
    return { days, recognised: true };
  }

  // A list of individual days.
  const listed = [...text.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/g)]
    .map((m) => SHORT_DAYS[m[1]]);
  if (listed.length) return { days: [...new Set(listed)], recognised: true };

  return { days: [0, 1, 2, 3, 4, 5, 6], recognised: false };
}

/** Every date in [start, end] whose weekday is in `days`. */
function eligibleDates(start, end, days) {
  const out = [];
  if (!start) return out;
  const from = new Date(`${start}T00:00:00Z`);
  const to = new Date(`${end || start}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return out;

  // A campaign longer than a year is a data error, not a plan; cap the walk.
  const limit = 400;
  for (let d = new Date(from), i = 0; d <= to && i < limit; d.setUTCDate(d.getUTCDate() + 1), i += 1) {
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Spread `spots` across `dates` as evenly as the calendar allows.
 *
 * Even spacing is what a planner means by a spread buy: three spots over
 * fifteen eligible days belong at the start, middle and end, not on three
 * consecutive days. Where spots outnumber dates the remainder doubles up on
 * the earliest dates, which front-loads a heavy week rather than leaving a
 * ragged tail.
 */
export function distributeSpots(spots, dates) {
  const grid = {};
  const total = Math.max(0, Math.round(Number(spots) || 0));
  if (!total || !dates.length) return grid;

  if (total <= dates.length) {
    // Pick evenly spaced positions across the available dates.
    const step = dates.length / total;
    for (let i = 0; i < total; i += 1) {
      const date = dates[Math.min(dates.length - 1, Math.floor(i * step + step / 2))];
      grid[date] = (grid[date] || 0) + 1;
    }
    return grid;
  }

  const base = Math.floor(total / dates.length);
  let remainder = total % dates.length;
  for (const date of dates) {
    grid[date] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return grid;
}

/**
 * Build the schedule from a channel-first plan.
 *
 * @param {Array}  channelPlan  the model's channel -> programmes structure
 * @param {Object} brief        supplies the campaign dates
 * @param {Array}  rates        observed spot rates, for costing
 * @returns {{lines: Array, warnings: Array, totals: Object}}
 */
export function buildSchedule(channelPlan, brief, rates = []) {
  const warnings = [];
  const lines = [];
  // The brief reaches here in the shape given to the model, which nests the
  // dates under campaign_period; accept the flat form too so the function works
  // with a row straight from the database.
  const start = brief?.period_start || brief?.campaign_period?.start || null;
  const end = brief?.period_end || brief?.campaign_period?.end || start;

  if (!start) {
    warnings.push(
      'The brief has no campaign period, so spots could not be placed on dates. '
      + 'The lineup is still costed, but there is no schedule grid.',
    );
  }

  // channel|programme|duration -> observed rate, for lines the model left
  // uncosted. Rate lookup is exact-ish: same channel, same programme, same
  // spot length.
  const rateIndex = new Map();
  for (const rate of rates) {
    const key = rateKey(rate.channel_name, rate.programme_name, rate.duration_secs);
    if (!rateIndex.has(key)) rateIndex.set(key, rate);
  }

  let order = 0;
  for (const channel of channelPlan || []) {
    for (const programme of channel.programmes || []) {
      const { days, recognised } = daysForPattern(programme.day_pattern);
      if (!recognised && programme.day_pattern) {
        warnings.push(
          `Could not read the day pattern "${programme.day_pattern}" for `
          + `${channel.channel} / ${programme.programme}; treated as every day.`,
        );
      }

      const dates = start ? eligibleDates(start, end, days) : [];
      const spots = Math.max(0, Math.round(Number(programme.spots) || 0));
      const spotDates = distributeSpots(spots, dates);
      const placed = Object.values(spotDates).reduce((a, b) => a + b, 0);

      if (start && spots && !dates.length) {
        warnings.push(
          `${channel.channel} / ${programme.programme} is scheduled for `
          + `"${programme.day_pattern}", but no such day falls inside the campaign period.`,
        );
      }

      const duration = programme.duration_secs ?? null;
      const observed = rateIndex.get(rateKey(channel.channel, programme.programme, duration))
        || rateIndex.get(rateKey(channel.channel, programme.programme, null));

      const rate = programme.rate_lkr ?? observed?.avg_cost ?? null;
      const cost = programme.cost_lkr
        ?? (rate !== null && spots ? Math.round(rate * spots) : null);

      lines.push({
        line_order: order,
        channel_name: channel.channel,
        programme_name: programme.programme,
        day_pattern: programme.day_pattern || null,
        time_band: programme.time_band || beltForTime(programme.time_start) || null,
        time_start: programme.time_start || null,
        time_end: programme.time_end || null,
        duration_secs: duration,
        spots: placed || spots,
        tvr: programme.tvr ?? null,
        rate_lkr: rate,
        cost_lkr: cost,
        rate_observed: Boolean(observed),
        spot_dates: spotDates,
        rationale: programme.rationale || '',
      });
      order += 1;
    }
  }

  return { lines, warnings, totals: summarise(lines) };
}

function rateKey(channel, programme, duration) {
  return [
    String(channel || '').toLowerCase().trim(),
    String(programme || '').toLowerCase().trim(),
    duration ?? 'any',
  ].join('|');
}

/** Channel subtotals and a campaign total, as the agency format expects. */
export function summarise(lines) {
  const byChannel = new Map();
  let spots = 0;
  let cost = 0;
  let costedSpots = 0;

  for (const line of lines) {
    const entry = byChannel.get(line.channel_name)
      || { channel_name: line.channel_name, spots: 0, cost_lkr: 0, lines: 0, uncosted_lines: 0 };
    entry.spots += line.spots || 0;
    entry.lines += 1;
    if (line.cost_lkr === null || line.cost_lkr === undefined) entry.uncosted_lines += 1;
    else entry.cost_lkr += line.cost_lkr;
    byChannel.set(line.channel_name, entry);

    spots += line.spots || 0;
    if (line.cost_lkr !== null && line.cost_lkr !== undefined) {
      cost += line.cost_lkr;
      costedSpots += line.spots || 0;
    }
  }

  return {
    channels: [...byChannel.values()].sort((a, b) => b.spots - a.spots),
    total_spots: spots,
    total_cost_lkr: Math.round(cost),
    total_cost_lakhs: +(cost / 100_000).toFixed(2),
    costed_spots: costedSpots,
    uncosted_spots: spots - costedSpots,
  };
}

/** Every date the schedule touches, in order - the grid's column headers. */
export function scheduleDates(lines) {
  const dates = new Set();
  for (const line of lines) {
    for (const date of Object.keys(line.spot_dates || {})) dates.add(date);
  }
  return [...dates].sort();
}

export { WEEKDAY_NAMES };
