import { pool } from '../db.js';
import { resolveAudience } from './tvAggregate.js';
import { resolveCategoryScope } from './aggregate.js';
import { beltForHour, beltForTime, checkPlanClutter } from './clutter.js';
import { buildSchedule } from './schedule.js';
import { costPlan } from '../llm/schema.js';
import { comparisonKey } from '../util/normalise.js';

// ---------------------------------------------------------------------------
// The interactive explorer (the flow the planner walks by hand).
//
// Instead of one model call that picks channels and programmes, the planner
// drives the selection:
//
//   1. analyzeForExplorer  - top channels ranked by share of audience, each
//      with how competitors behave on it (GRP share and spot count, the day and
//      time belts they favour, and observed spend), the top programmes, and the
//      full per-channel programme list the picker populates from - every
//      programme carried with its TVR and an average 30-second spot cost derived
//      from the media watch log.
//
//   2. buildScheduleFromPicks - the planner's chosen programmes are the fixed
//      line-up. Spots are placed on real dates in code, the buy is costed by
//      prorating the observed 30-second cost to the chosen copy length, the
//      clutter check runs, and only then is the model asked to explain the
//      schedule (schedulePicksToPlan + the explain step live in the route).
//
// "Average 3 sec cost" in the brief conversation meant the average 30-second
// spot cost - the standard TV benchmark unit - which every other length is
// prorated from at a constant cost per second.
// ---------------------------------------------------------------------------

const CHANNEL_LIMIT = 8;      // return a few beyond the headline 5 to pick from
const TOP_PROGRAMMES = 5;
const PROGRAMMES_PER_CHANNEL = 12;
const BENCHMARK_SECS = 30;

/**
 * Everything the explorer screen needs, in one payload.
 *
 * @param {Object} brief   confirmed brief (supplies audience, brand, category)
 * @param {Object} [opts]  { audience } to override the brief's target audience
 */
export async function analyzeForExplorer(brief, opts = {}) {
  const requested = opts.audience || brief.target_audience || null;
  const resolved = await resolveAudience(requested);
  const audience = resolved.audience;
  const scope = await resolveCategoryScope(brief, {});

  const [channels, competitorByChannel, competitorPatterns, spendByChannel,
    programmes, costs, pressureByProgramme, adexContext] = await Promise.all([
    channelPerformance(audience),
    competitorGrpByChannelBrand(audience),
    competitorPatternsByChannel(audience),
    observedSpendByChannel(),
    programmesByChannel(audience),
    costPerSecondByProgramme(),
    competitorPressureByProgramme(audience, brief),
    adexCategoryContext(scope, brief),
  ]);

  // Index the competitor and cost reads so they can be attached per channel and
  // per programme without another round trip.
  const costIndex = new Map(costs.map((c) => [`${c.ch}|${c.prog}`, c]));
  const pressureIndex = new Map(
    pressureByProgramme.map((p) => [`${comparisonKey(p.channel_name)}|${comparisonKey(p.programme_name)}`, p]),
  );
  const brandsByChannel = groupCompetitorBrands(competitorByChannel);
  const patternsByChannel = new Map(competitorPatterns.map((p) => [p.channel_name, p]));
  const spendIndex = new Map(spendByChannel.map((s) => [comparisonKey(s.channel_name), s]));
  const programmesByCh = groupProgrammes(programmes, costIndex, pressureIndex);

  const totalGrp = [...brandsByChannel.values()].reduce((a, c) => a + c.total_grp, 0) || 1;

  const enrichedChannels = channels.slice(0, CHANNEL_LIMIT).map((ch, i) => {
    const key = ch.channel_name;
    const grp = brandsByChannel.get(key) || { total_grp: 0, spots: 0, brands: 0, top_brands: [] };
    const patterns = patternsByChannel.get(key) || { top_belts: [], top_days: [] };
    const spend = spendIndex.get(comparisonKey(key));
    return {
      channel_name: key,
      rank: i + 1,
      is_top5: i < 5,
      share_of_audience: numOrNull(ch.share_of_audience),
      individual_reach_pct: numOrNull(ch.individual_reach_pct),
      total_ratings: numOrNull(ch.total_ratings),
      competitor: {
        grp_share_pct: +((grp.total_grp / totalGrp) * 100).toFixed(1),
        total_grp: grp.total_grp,
        spots: grp.spots,
        brands: grp.brands,
        top_brands: grp.top_brands,
        top_belts: patterns.top_belts,
        top_days: patterns.top_days,
        observed_spend_lkr: spend ? Number(spend.total_cost) : null,
        observed_spots_costed: spend ? Number(spend.spots) : null,
      },
      programmes: (programmesByCh.get(key) || []).slice(0, PROGRAMMES_PER_CHANNEL),
    };
  });

  // Top programmes across all returned channels, by TVR.
  const allProgrammes = enrichedChannels.flatMap((ch) =>
    ch.programmes.map((p) => ({ ...p, channel_name: ch.channel_name })));
  const topProgrammes = [...allProgrammes]
    .filter((p) => p.tvr !== null)
    .sort((a, b) => (b.tvr ?? 0) - (a.tvr ?? 0))
    .slice(0, TOP_PROGRAMMES);

  const notes = [];
  if (requested && !resolved.matched) {
    notes.push(
      `The brief's target audience "${requested}" does not match the audience panel in the `
      + `uploaded ratings (${resolved.available.join(', ') || 'none loaded'}). Figures cover all `
      + 'loaded audiences.',
    );
  } else if (resolved.loose) {
    notes.push(`Ratings are reported against the panel "${audience}", matched loosely to "${requested}".`);
  }
  if (!channels.length) notes.push('No channel performance data is loaded. Upload a MICOS channel-summary export.');
  if (!costs.length) notes.push('No media watch cost data is loaded, so 30-second costs are unavailable and picks cannot be costed.');

  return {
    audience: { requested, panel: audience, matched: resolved.matched },
    benchmark_secs: BENCHMARK_SECS,
    adex_context: adexContext,
    channels: enrichedChannels,
    top_programmes: topProgrammes,
    data_notes: notes,
  };
}

/**
 * The observed cost per second for a set of picks.
 *
 * Keyed lower(channel)|lower(programme). Used by the schedule builder to cost
 * each pick at its chosen copy length rather than trusting a rate from the
 * client.
 */
export async function costPerSecondFor(picks) {
  const costs = await costPerSecondByProgramme();
  const index = new Map(costs.map((c) => [`${c.ch}|${c.prog}`, c]));
  const out = new Map();
  for (const pick of picks) {
    const key = `${comparisonKey(pick.channel_name)}|${comparisonKey(pick.programme_name)}`;
    const hit = index.get(key);
    out.set(key, hit ? Number(hit.cost_per_sec) : null);
  }
  return out;
}

/**
 * Turn the planner's curated picks into a dated, costed, clutter-checked
 * schedule. The picks are the fixed line-up: the model never adds or drops a
 * programme here, it only explains the result (in the route).
 *
 * @param {Object} brief   supplies the campaign dates and budget
 * @param {Array}  picks   [{ channel_name, programme_name, duration_secs,
 *                            spots, day_pattern, time_start, time_end,
 *                            time_band, tvr }]
 * @returns {Promise<Object>} schedule lines, totals, budget, clutter, warnings
 */
export async function buildScheduleFromPicks(brief, picks = []) {
  const clean = (Array.isArray(picks) ? picks : []).filter(
    (p) => p && p.channel_name && p.programme_name,
  );
  if (!clean.length) {
    throw Object.assign(new Error('No programmes were picked, so there is nothing to schedule.'), {
      status: 400,
      hint: 'Choose at least one programme under a channel before building the schedule.',
    });
  }

  // Cost each pick at its chosen copy length from the observed per-second rate,
  // recomputed from the database rather than trusted from the client. The belt
  // each programme actually airs in comes from the same observed data, so the
  // clutter check measures a real time band rather than "Unspecified".
  const [costPerSec, beltIndex] = await Promise.all([
    costPerSecondFor(clean),
    programmeBeltFor(clean),
  ]);

  // Group into the channel-first shape buildSchedule expects, preserving the
  // order the planner picked them in.
  const byChannel = new Map();
  const warnings = [];
  for (const pick of clean) {
    const key = comparisonKey(pick.channel_name);
    const perSec = costPerSec.get(`${comparisonKey(pick.channel_name)}|${comparisonKey(pick.programme_name)}`);
    const duration = intOrNull(pick.duration_secs) ?? 30;
    const spots = Math.max(0, intOrNull(pick.spots) ?? 0);
    const rate = perSec !== null && perSec !== undefined ? Math.round(perSec * duration) : null;
    if (rate === null) {
      warnings.push(
        `No media watch cost was found for ${pick.channel_name} / ${pick.programme_name}, `
        + 'so this line is left uncosted.',
      );
    }

    const observedBelt = beltIndex.get(`${comparisonKey(pick.channel_name)}|${comparisonKey(pick.programme_name)}`);
    if (!byChannel.has(key)) {
      byChannel.set(key, { channel: pick.channel_name, programmes: [] });
    }
    byChannel.get(key).programmes.push({
      programme: pick.programme_name,
      day_pattern: pick.day_pattern || 'Mon - Fri',
      time_band: pick.time_band || beltForTime(pick.time_start) || observedBelt || null,
      time_start: pick.time_start || null,
      time_end: pick.time_end || null,
      duration_secs: duration,
      spots,
      tvr: numOrNull(pick.tvr),
      rate_lkr: rate,
      cost_lkr: rate !== null && spots ? rate * spots : null,
    });
  }

  const channelPlan = [...byChannel.values()];
  const schedule = buildSchedule(channelPlan, brief, []);
  const clutter = checkPlanClutter(schedule.lines);
  const budget = costPlan(schedule.totals, brief?.budget_lkr_lakhs);

  return {
    channel_plan: channelPlan,
    lines: schedule.lines,
    totals: schedule.totals,
    warnings: [...warnings, ...schedule.warnings],
    clutter,
    budget,
  };
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * The time belt each picked programme actually airs in.
 *
 * Modal air-hour from the spot-level GRP data, falling back to the media watch
 * log's advertisement time. Without this every hand-picked line would land in an
 * "Unspecified" belt and the clutter check would flag the whole buy as stacked.
 * Keyed lower(channel)|lower(programme).
 */
async function programmeBeltFor(picks) {
  const out = new Map();
  if (!picks.length) return out;

  const [grp, watch] = await Promise.all([
    pool.query(
      `SELECT lower(c.channel_name) AS ch, lower(s.programme_name) AS prog,
              extract(hour FROM s.aired_at)::int AS hour, count(*) AS n
         FROM tv_spot_grp s JOIN tv_channels c ON c.id = s.channel_id
        WHERE s.programme_name <> ''
        GROUP BY 1, 2, 3`,
    ),
    pool.query(
      `SELECT lower(channel_name) AS ch, lower(programme_name) AS prog,
              advt_time, prog_time
         FROM media_watch_spots
        WHERE programme_name <> ''`,
    ),
  ]);

  // Accumulate hour votes per programme from both sources.
  const votes = new Map(); // key -> Map(hour -> count)
  const addVote = (key, hour, n = 1) => {
    if (hour === null || Number.isNaN(hour)) return;
    if (!votes.has(key)) votes.set(key, new Map());
    const m = votes.get(key);
    m.set(hour, (m.get(hour) || 0) + n);
  };
  for (const r of grp.rows) addVote(`${r.ch}|${r.prog}`, Number(r.hour), Number(r.n));
  for (const r of watch.rows) {
    const hour = hourFromText(r.advt_time) ?? hourFromText(r.prog_time);
    if (hour !== null) addVote(`${r.ch}|${r.prog}`, hour, 1);
  }

  for (const [key, m] of votes) {
    const [hour] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const belt = beltForHour(hour);
    if (belt) out.set(key, belt);
  }
  return out;
}

function hourFromText(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) : null;
}

// --- queries ---------------------------------------------------------------

async function channelPerformance(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, p.share_of_audience, p.total_ratings,
            p.individual_reach, p.individual_reach_pct
       FROM tv_channel_performance p
       JOIN tv_channels c ON c.id = p.channel_id
      WHERE ($1::text IS NULL OR p.target_audience = $1)
      ORDER BY p.share_of_audience DESC NULLS LAST`,
    [audience],
  );
  return rows;
}

/** Competitor GRP and spots by channel and brand, for the per-channel read. */
async function competitorGrpByChannelBrand(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, s.brand,
            count(*)                       AS spots,
            round(sum(s.grp)::numeric, 2)  AS total_grp
       FROM tv_spot_grp s
       JOIN tv_channels c ON c.id = s.channel_id
      WHERE s.brand <> ''
        AND ($1::text IS NULL OR s.target_audience = $1)
      GROUP BY c.channel_name, s.brand`,
    [audience],
  );
  return rows;
}

/** Which day and time belt each channel's competitors favour. */
async function competitorPatternsByChannel(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name,
            extract(hour FROM s.aired_at)::int AS hour,
            extract(dow  FROM s.aired_at)::int AS dow,
            count(*)                       AS spots,
            round(sum(s.grp)::numeric, 2)  AS total_grp
       FROM tv_spot_grp s
       JOIN tv_channels c ON c.id = s.channel_id
      WHERE ($1::text IS NULL OR s.target_audience = $1)
      GROUP BY c.channel_name, 2, 3`,
    [audience],
  );

  const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const byChannel = new Map();
  for (const row of rows) {
    const entry = byChannel.get(row.channel_name)
      || { channel_name: row.channel_name, belts: new Map(), days: new Map() };
    const belt = beltForHour(row.hour);
    if (belt) entry.belts.set(belt, (entry.belts.get(belt) || 0) + Number(row.spots));
    const day = DAY[row.dow];
    if (day) entry.days.set(day, (entry.days.get(day) || 0) + Number(row.spots));
    byChannel.set(row.channel_name, entry);
  }

  return [...byChannel.values()].map((e) => ({
    channel_name: e.channel_name,
    top_belts: topEntries(e.belts, 3).map(([belt, spots]) => ({ belt, spots })),
    top_days: topEntries(e.days, 3).map(([day, spots]) => ({ day, spots })),
  }));
}

/** Observed money into each channel, from the media watch cost log. */
async function observedSpendByChannel() {
  const { rows } = await pool.query(
    `SELECT channel_name,
            round(sum(cost)::numeric, 0) AS total_cost,
            count(*)                     AS spots
       FROM media_watch_spots
      WHERE cost IS NOT NULL AND channel_name <> ''
      GROUP BY channel_name`,
  );
  return rows;
}

async function programmesByChannel(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, r.programme_name, r.programme_category,
            r.trp AS tvr, r.rank, r.instances,
            rank() OVER (PARTITION BY c.channel_name ORDER BY r.trp DESC NULLS LAST) AS tvr_rank
       FROM tv_programme_ratings r
       JOIN tv_channels c ON c.id = r.channel_id
      WHERE r.trp IS NOT NULL
        AND ($1::text IS NULL OR r.target_audience = $1)
      ORDER BY c.channel_name, r.trp DESC NULLS LAST`,
    [audience],
  );
  return rows;
}

/**
 * Average cost per second by channel and programme.
 *
 * cost / duration gives a per-second rate; averaging that across the observed
 * spots and holding it constant is the honest way to price copy lengths the
 * media watch log did not happen to record directly.
 */
async function costPerSecondByProgramme() {
  const { rows } = await pool.query(
    `SELECT lower(channel_name) AS ch, lower(programme_name) AS prog,
            round(avg(cost / NULLIF(duration_secs, 0))::numeric, 2) AS cost_per_sec,
            count(*) AS observed_spots
       FROM media_watch_spots
      WHERE cost IS NOT NULL AND duration_secs > 0
      GROUP BY 1, 2`,
  );
  return rows;
}

async function competitorPressureByProgramme(audience, brief) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, s.programme_name,
            count(*)                        AS spots,
            count(DISTINCT s.brand)         AS brands,
            round(sum(s.grp)::numeric, 2)   AS total_grp,
            (array_agg(DISTINCT s.brand ORDER BY s.brand))[1:5] AS top_brands,
            bool_or($2::text IS NOT NULL AND s.brand ILIKE $2) AS own_brand_present
       FROM tv_spot_grp s
       JOIN tv_channels c ON c.id = s.channel_id
      WHERE ($1::text IS NULL OR s.target_audience = $1)
      GROUP BY c.channel_name, s.programme_name`,
    [audience, brief.brand ? `%${brief.brand}%` : null],
  );
  return rows;
}

/** Category adex context - the macro picture the spot data cannot give. */
async function adexCategoryContext(scope, brief) {
  const { rows } = await pool.query(
    `SELECT brand,
            round(sum(COALESCE(total_000,
              COALESCE(tv_spend_000,0)+COALESCE(radio_spend_000,0)+COALESCE(press_spend_000,0)))::numeric, 1)
              AS total_spend_000
       FROM adex_data
      WHERE ($1::text IS NULL OR category = $1)
        AND ($2::text IS NULL OR sector   = $2)
        AND brand <> ''
      GROUP BY brand
      ORDER BY 2 DESC
      LIMIT 8`,
    [scope.category, scope.sector],
  );
  return {
    category: scope.category,
    sector: scope.sector,
    top_spenders: rows.map((r) => ({ brand: r.brand, total_spend_000: Number(r.total_spend_000) })),
    own_brand: brief.brand || null,
  };
}

// --- shaping helpers -------------------------------------------------------

function groupCompetitorBrands(rows) {
  const byChannel = new Map();
  for (const row of rows) {
    const entry = byChannel.get(row.channel_name)
      || { total_grp: 0, spots: 0, brandSet: new Set(), brands: [] };
    const grp = Number(row.total_grp) || 0;
    entry.total_grp += grp;
    entry.spots += Number(row.spots) || 0;
    entry.brandSet.add(row.brand);
    entry.brands.push({ brand: row.brand, grp, spots: Number(row.spots) || 0 });
    byChannel.set(row.channel_name, entry);
  }
  for (const entry of byChannel.values()) {
    entry.brands.sort((a, b) => b.grp - a.grp);
    entry.top_brands = entry.brands.slice(0, 5);
    entry.total_grp = +entry.total_grp.toFixed(2);
    entry.brands = entry.brandSet.size;
    delete entry.brandSet;
  }
  return byChannel;
}

function groupProgrammes(rows, costIndex, pressureIndex) {
  const byChannel = new Map();
  for (const row of rows) {
    const chKey = comparisonKey(row.channel_name);
    const progKey = comparisonKey(row.programme_name);
    const cost = costIndex.get(`${chKey}|${progKey}`);
    const pressure = pressureIndex.get(`${chKey}|${progKey}`);
    const costPerSec = cost ? Number(cost.cost_per_sec) : null;

    const list = byChannel.get(row.channel_name) || [];
    list.push({
      programme_name: row.programme_name,
      programme_category: row.programme_category || null,
      tvr: numOrNull(row.tvr),
      cost_per_sec: costPerSec,
      avg_cost_30s: costPerSec !== null ? Math.round(costPerSec * BENCHMARK_SECS) : null,
      observed_spots: cost ? Number(cost.observed_spots) : 0,
      competitor: pressure
        ? {
          total_grp: Number(pressure.total_grp) || 0,
          spots: Number(pressure.spots) || 0,
          brands: Number(pressure.brands) || 0,
          top_brands: pressure.top_brands || [],
          own_brand_present: Boolean(pressure.own_brand_present),
        }
        : { total_grp: 0, spots: 0, brands: 0, top_brands: [], own_brand_present: false },
    });
    byChannel.set(row.channel_name, list);
  }
  return byChannel;
}

function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function numOrNull(v) {
  return v === null || v === undefined ? null : Number(v);
}
