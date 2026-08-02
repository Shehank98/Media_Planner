import { pool } from '../db.js';

// ---------------------------------------------------------------------------
// Time-belt clutter.
//
// A plan that stacks spots into one half hour across three channels is not a
// plan - it is the same impression bought three times. The audience overlaps,
// the break is already crowded with competitors, and the marginal spot buys
// almost nothing.
//
// Two halves:
//   observed  - how contested each belt already is, from competitor spot data.
//               Given to the model so it can avoid the crowded belts.
//   check     - what the generated plan actually does, computed here. The model
//               is asked to spread the buy; whether it did is arithmetic, and
//               arithmetic is verified rather than trusted.
// ---------------------------------------------------------------------------

/**
 * The MICOS day-part bands, as half-open hour ranges.
 *
 * "Morning (0500 - 1059)" also appears in the data as a rollup spanning three
 * of these. It is deliberately excluded: counting it alongside its own
 * constituents would double every morning spot.
 */
export const TIME_BELTS = [
  { label: 'Night/Overnight (0000 - 0459)', from: 0, to: 5 },
  { label: 'Early Morning (0500 - 0659)', from: 5, to: 7 },
  { label: 'Morning Rush (0700 - 0759)', from: 7, to: 8 },
  { label: 'Morning Off-Peak (0800 - 1059)', from: 8, to: 11 },
  { label: 'Noon (1100 - 1259)', from: 11, to: 13 },
  { label: 'Afternoon (1300 - 1559)', from: 13, to: 16 },
  { label: 'Early Evening (1600 - 1859)', from: 16, to: 19 },
  { label: 'Evening Peak (1900 - 2059)', from: 19, to: 21 },
  { label: 'Night (2100 - 2359)', from: 21, to: 24 },
];

/** Belt containing an hour, or null. */
export function beltForHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return null;
  return TIME_BELTS.find((b) => h >= b.from && h < b.to)?.label ?? null;
}

/** Belt for a "HH:MM" string, or for a MICOS band label passed straight through. */
export function beltForTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const hhmm = text.match(/^(\d{1,2}):(\d{2})/);
  if (hhmm) return beltForHour(Number(hhmm[1]));
  // Already a band label - match it against the canonical list.
  const known = TIME_BELTS.find((b) => b.label.toLowerCase() === text.toLowerCase());
  if (known) return known.label;
  // A label carrying its own range, e.g. "Evening Peak (1900 - 2059)".
  const range = text.match(/\((\d{2})(\d{2})\s*-\s*\d{4}\)/);
  if (range) return beltForHour(Number(range[1]));
  return null;
}

/**
 * How contested each belt already is, from competitor spot activity.
 *
 * Spot-level GRP data records when every competitor advertisement aired, so the
 * count per belt is a direct measure of how crowded the break is.
 */
export async function observedClutter(audience = null) {
  const { rows } = await pool.query(
    `SELECT extract(hour FROM s.aired_at)::int AS hour,
            c.channel_name,
            count(*)                        AS spots,
            count(DISTINCT s.brand)         AS brands,
            round(sum(s.grp)::numeric, 2)   AS total_grp
       FROM tv_spot_grp s
       JOIN tv_channels c ON c.id = s.channel_id
      WHERE ($1::text IS NULL OR s.target_audience = $1)
      GROUP BY 1, 2`,
    [audience],
  );

  const byBelt = new Map(TIME_BELTS.map((b) => [b.label, {
    time_belt: b.label, spots: 0, brands: new Set(), total_grp: 0, channels: new Map(),
  }]));

  for (const row of rows) {
    const belt = beltForHour(row.hour);
    if (!belt) continue;
    const entry = byBelt.get(belt);
    entry.spots += Number(row.spots) || 0;
    entry.total_grp += Number(row.total_grp) || 0;
    const perChannel = entry.channels.get(row.channel_name) || 0;
    entry.channels.set(row.channel_name, perChannel + (Number(row.spots) || 0));
  }

  const totalSpots = [...byBelt.values()].reduce((a, b) => a + b.spots, 0) || 1;

  return [...byBelt.values()]
    .map((e) => ({
      time_belt: e.time_belt,
      competitor_spots: e.spots,
      share_of_competitor_spots_pct: +((e.spots / totalSpots) * 100).toFixed(1),
      total_grp: +e.total_grp.toFixed(2),
      busiest_channels: [...e.channels.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([channel, spots]) => ({ channel, spots })),
    }))
    .filter((e) => e.competitor_spots > 0)
    .sort((a, b) => b.competitor_spots - a.competitor_spots);
}

// A belt carrying more than this share of the plan is over-concentrated.
const BELT_SHARE_LIMIT_PCT = 40;
// Spots in one belt on one day, across all channels, beyond which the buy is
// competing with itself rather than building reach.
const SAME_DAY_BELT_LIMIT = 6;
// Channels sharing one belt on one day, beyond which the overlap is wasteful.
const SAME_BELT_CHANNEL_LIMIT = 3;

/**
 * Check a generated schedule for self-inflicted clutter.
 *
 * Works off the expanded schedule lines (which carry a belt, a channel and a
 * dated spot map), so it measures what the plan actually does rather than what
 * the rationale claims.
 */
export function checkPlanClutter(scheduleLines) {
  const lines = scheduleLines || [];
  const totalSpots = lines.reduce((a, l) => a + (l.spots || 0), 0);
  if (!totalSpots) {
    return { total_spots: 0, by_belt: [], issues: [], ok: true };
  }

  const beltTotals = new Map();
  // belt -> date -> { spots, channels:Set }
  const beltDay = new Map();

  for (const line of lines) {
    // Schedule lines carry the belt as `time_band`; synthetic lines and older
    // callers use `time_belt`. Accept either, then fall back to the start time.
    const belt = line.time_belt || line.time_band || beltForTime(line.time_start) || 'Unspecified';
    beltTotals.set(belt, (beltTotals.get(belt) || 0) + (line.spots || 0));

    if (!beltDay.has(belt)) beltDay.set(belt, new Map());
    const days = beltDay.get(belt);
    for (const [date, spots] of Object.entries(line.spot_dates || {})) {
      if (!days.has(date)) days.set(date, { spots: 0, channels: new Set() });
      const day = days.get(date);
      day.spots += Number(spots) || 0;
      day.channels.add(line.channel_name);
    }
  }

  const by_belt = [...beltTotals.entries()]
    .map(([time_belt, spots]) => ({
      time_belt,
      spots,
      share_pct: +((spots / totalSpots) * 100).toFixed(1),
    }))
    .sort((a, b) => b.spots - a.spots);

  const issues = [];

  for (const belt of by_belt) {
    if (belt.share_pct > BELT_SHARE_LIMIT_PCT) {
      issues.push({
        severity: 'high',
        time_belt: belt.time_belt,
        detail: `${belt.share_pct}% of all spots sit in ${belt.time_belt}. Concentrating more `
          + `than ${BELT_SHARE_LIMIT_PCT}% of the buy in one belt repeats the same audience `
          + 'instead of building reach.',
      });
    }
  }

  for (const [belt, days] of beltDay) {
    for (const [date, day] of days) {
      if (day.spots > SAME_DAY_BELT_LIMIT) {
        issues.push({
          severity: 'medium',
          time_belt: belt,
          date,
          detail: `${day.spots} spots land in ${belt} on ${date} across `
            + `${day.channels.size} channel(s). Beyond about ${SAME_DAY_BELT_LIMIT} in one belt `
            + 'on one day the extra spots mostly reach people already reached.',
        });
      }
      if (day.channels.size > SAME_BELT_CHANNEL_LIMIT) {
        issues.push({
          severity: 'medium',
          time_belt: belt,
          date,
          detail: `${day.channels.size} channels run in ${belt} on ${date} `
            + `(${[...day.channels].join(', ')}). Simultaneous airing across that many channels `
            + 'duplicates viewers rather than adding them.',
        });
      }
    }
  }

  // One line per belt/date pair is enough; the pattern repeats.
  const seen = new Set();
  const deduped = issues.filter((i) => {
    const key = `${i.severity}|${i.time_belt}|${i.date || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    total_spots: totalSpots,
    by_belt,
    issues: deduped.slice(0, 12),
    ok: deduped.length === 0,
    thresholds: {
      belt_share_limit_pct: BELT_SHARE_LIMIT_PCT,
      same_day_belt_limit: SAME_DAY_BELT_LIMIT,
      same_belt_channel_limit: SAME_BELT_CHANNEL_LIMIT,
    },
  };
}
