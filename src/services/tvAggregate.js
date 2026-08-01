import { pool } from '../db.js';
import { observedClutter } from './clutter.js';

// ---------------------------------------------------------------------------
// Aggregations over the MICOS datasets and the media watch cost log.
//
// These are what let the plan say "this channel, this programme, this day, this
// duration, and here is what it costs" rather than just naming programmes:
//
//   topProgrammes        C1  - which programmes, and how long they run
//   channelPerformance   A1  - which channels carry the audience
//   bestDays             A2  - which days of the week deliver
//   bestDayparts         A3  - which time bands deliver
//   programmeRates       media watch - observed cost per spot, by duration
//   competitorSpotPressure  TV GRP - who is already buying these programmes
// ---------------------------------------------------------------------------

const DEFAULT_PROGRAMME_LIMIT = 20;

/** Audience filter shared by every MICOS query: exact match, else unfiltered. */
async function resolveAudience(requested) {
  const { rows } = await pool.query(
    `SELECT DISTINCT target_audience FROM tv_programme_ratings
      WHERE COALESCE(target_audience,'') <> ''`,
  );
  const available = rows.map((r) => r.target_audience);
  if (!requested) return { audience: null, matched: false, available };

  // The MICOS custom TG ("Meera 16-45") is a named panel definition, not a
  // demographic string, so a brief saying "Females 16-45" will not match it
  // textually. Exact match first, then a loose containment attempt, then give
  // up and use everything - reporting which happened either way.
  const exact = available.find((a) => a.toLowerCase() === requested.toLowerCase());
  if (exact) return { audience: exact, matched: true, available };

  const loose = available.find(
    (a) => a.toLowerCase().includes(requested.toLowerCase())
      || requested.toLowerCase().includes(a.toLowerCase()),
  );
  if (loose) return { audience: loose, matched: true, loose: true, available };

  return { audience: null, matched: false, available };
}

export async function buildTvAggregates(brief, filters = {}, limit = DEFAULT_PROGRAMME_LIMIT) {
  const requested = filters.target_audience || brief.target_audience || null;
  const resolved = await resolveAudience(requested);
  const audience = resolved.audience;

  const [programmes, channels, days, dayparts, rates, pressure, clutter] = await Promise.all([
    topProgrammes(audience, filters, limit),
    channelPerformance(audience),
    bestDays(audience),
    bestDayparts(audience),
    programmeRates(filters),
    competitorSpotPressure(brief, audience),
    // How contested each time belt already is, so the plan can avoid piling
    // into the belts everyone else is already buying.
    observedClutter(audience),
  ]);

  const notes = [];
  if (requested && !resolved.matched) {
    notes.push(
      `The brief's target audience "${requested}" does not match the audience panel in the ` +
      `uploaded ratings (${resolved.available.join(', ') || 'none loaded'}). The figures below ` +
      'cover all loaded audiences and are not specific to the brief.',
    );
  } else if (resolved.loose) {
    notes.push(
      `Ratings are reported against the panel "${audience}", matched loosely to the brief's ` +
      `"${requested}". Confirm the panel definition covers the brief's audience.`,
    );
  }
  if (!programmes.length) {
    notes.push('No programme ratings are loaded. Upload a MICOS TV_ChannelDetails export.');
  }
  if (!rates.length) {
    notes.push(
      'No media watch cost data is loaded, so the plan cannot be costed. Spot rates and ' +
      'the budget split below are unverified.',
    );
  }
  if (!dayparts.length && !days.length) {
    notes.push('No day or day-part data is loaded, so day recommendations are not evidence-based.');
  }

  return {
    audience_panel: audience,
    audience_requested: requested,
    audience_matched: resolved.matched,
    programme_ratings: programmes,
    channel_performance: channels,
    best_days: days,
    best_dayparts: dayparts,
    programme_rates: rates,
    competitor_spot_pressure: pressure,
    time_belt_clutter: clutter,
    data_notes: notes,
  };
}

/**
 * Top programmes for the audience, with the observed rate joined on where the
 * media watch log covers the same channel and programme.
 *
 * Joining rates here rather than leaving it to the model is deliberate: cost
 * per rating point is arithmetic, and arithmetic is not something to delegate
 * to a language model when the numbers end up in a client's budget.
 */
async function topProgrammes(audience, filters, limit) {
  const { rows } = await pool.query(
    `WITH rates AS (
       SELECT lower(channel_name) AS ch, lower(programme_name) AS prog,
              round(avg(cost)::numeric, 0)  AS avg_cost,
              round(min(cost)::numeric, 0)  AS min_cost,
              round(max(cost)::numeric, 0)  AS max_cost,
              round(avg(duration_secs)::numeric, 0) AS avg_spot_secs,
              count(*) AS observed_spots
         FROM media_watch_spots
        WHERE cost IS NOT NULL
        GROUP BY 1, 2
     )
     SELECT c.channel_name,
            r.programme_name,
            r.programme_category,
            r.target_audience,
            r.trp             AS avg_rating,
            r.instances,
            r.avg_duration_secs,
            r.total_reach,
            r.avg_reach,
            r.rank,
            r.period_start,
            r.period_end,
            rt.avg_cost       AS observed_avg_cost,
            rt.min_cost       AS observed_min_cost,
            rt.max_cost       AS observed_max_cost,
            rt.avg_spot_secs  AS observed_spot_secs,
            rt.observed_spots,
            CASE WHEN rt.avg_cost IS NOT NULL AND r.trp > 0
                 THEN round((rt.avg_cost / r.trp)::numeric, 0) END AS cost_per_rating_point
       FROM tv_programme_ratings r
       JOIN tv_channels c ON c.id = r.channel_id
       LEFT JOIN rates rt
              ON rt.ch = lower(c.channel_name) AND rt.prog = lower(r.programme_name)
      WHERE ($1::text IS NULL OR r.target_audience = $1)
        AND ($2::text IS NULL OR r.programme_category ILIKE '%' || $2 || '%')
        AND r.trp IS NOT NULL
      ORDER BY r.trp DESC NULLS LAST
      LIMIT $3`,
    [audience, filters.programme_category || null, limit],
  );
  return rows;
}

async function channelPerformance(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, p.share_of_audience, p.total_ratings, p.avg_daily_minutes,
            p.individual_reach, p.individual_reach_pct, p.period_start, p.period_end
       FROM tv_channel_performance p
       JOIN tv_channels c ON c.id = p.channel_id
      WHERE ($1::text IS NULL OR p.target_audience = $1)
      ORDER BY p.share_of_audience DESC NULLS LAST
      LIMIT 30`,
    [audience],
  );
  return rows;
}

/**
 * Ratings by day of week, per channel, plus each channel's own best day.
 *
 * The rank is computed here so the model is handed the answer to "which day"
 * rather than being asked to sort numbers itself.
 */
async function bestDays(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, d.day_of_week, d.ratings, d.reach, d.reach_pct,
            rank() OVER (PARTITION BY d.channel_id ORDER BY d.ratings DESC NULLS LAST) AS day_rank
       FROM tv_channel_daypart d
       JOIN tv_channels c ON c.id = d.channel_id
      WHERE d.day_of_week <> ''
        AND ($1::text IS NULL OR d.target_audience = $1)
      ORDER BY c.channel_name,
               array_position(
                 ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
                 d.day_of_week)`,
    [audience],
  );
  return rows;
}

async function bestDayparts(audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name, d.day_group, d.time_of_day, d.ratings, d.reach, d.reach_pct,
            rank() OVER (PARTITION BY d.channel_id, d.day_group
                         ORDER BY d.ratings DESC NULLS LAST) AS band_rank
       FROM tv_channel_daypart d
       JOIN tv_channels c ON c.id = d.channel_id
      WHERE d.time_of_day <> ''
        AND ($1::text IS NULL OR d.target_audience = $1)
      ORDER BY c.channel_name, d.day_group, d.ratings DESC NULLS LAST`,
    [audience],
  );
  return rows;
}

/**
 * Observed spot rates by channel, programme and duration.
 *
 * This is a rate *observation*, not a rate card: it is what other advertisers
 * were actually charged, which is the honest basis for a cost estimate.
 */
async function programmeRates(filters) {
  const { rows } = await pool.query(
    `SELECT medium, channel_name, programme_name, duration_secs,
            count(*)                       AS spots_observed,
            round(avg(cost)::numeric, 0)   AS avg_cost,
            round(min(cost)::numeric, 0)   AS min_cost,
            round(max(cost)::numeric, 0)   AS max_cost,
            array_agg(DISTINCT day_of_week) FILTER (WHERE day_of_week IS NOT NULL) AS days_observed
       FROM media_watch_spots
      WHERE cost IS NOT NULL
        AND ($1::text IS NULL OR medium = $1)
        AND ($2::text IS NULL OR language ILIKE '%' || $2 || '%')
      GROUP BY medium, channel_name, programme_name, duration_secs
      HAVING count(*) >= 1
      ORDER BY avg(cost) DESC
      LIMIT 120`,
    [filters.medium || null, filters.language || null],
  );
  return rows;
}

/**
 * Who else is buying the programmes under consideration.
 *
 * Rolled up from spot level to programme level: total GRP bought, spots aired,
 * and the brands doing it. This is the competitive read at the slot the plan
 * would actually occupy, which category-level adex spend cannot give.
 */
async function competitorSpotPressure(brief, audience) {
  const { rows } = await pool.query(
    `SELECT c.channel_name,
            s.programme_name,
            s.programme_category,
            count(*)                        AS spots,
            count(DISTINCT s.brand)         AS brands,
            round(sum(s.grp)::numeric, 2)   AS total_grp,
            round(avg(s.duration_secs)::numeric, 0) AS avg_duration_secs,
            (array_agg(DISTINCT s.brand ORDER BY s.brand))[1:8] AS top_brands,
            bool_or($2::text IS NOT NULL AND s.brand ILIKE $2) AS own_brand_present
       FROM tv_spot_grp s
       JOIN tv_channels c ON c.id = s.channel_id
      WHERE ($1::text IS NULL OR s.target_audience = $1)
      GROUP BY c.channel_name, s.programme_name, s.programme_category
      ORDER BY sum(s.grp) DESC NULLS LAST, count(*) DESC
      LIMIT 40`,
    [audience, brief.brand ? `%${brief.brand}%` : null],
  );
  return rows;
}

/** Category-level competitor read from spot data, for the brief's category. */
export async function spotCategoryLeaders(category, audience = null) {
  const { rows } = await pool.query(
    `SELECT s.brand, s.company, s.category,
            count(*) AS spots,
            round(sum(s.grp)::numeric, 2) AS total_grp,
            count(DISTINCT s.programme_name) AS programmes
       FROM tv_spot_grp s
      WHERE ($1::text IS NULL OR s.category ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR s.target_audience = $2)
      GROUP BY s.brand, s.company, s.category
      ORDER BY sum(s.grp) DESC NULLS LAST
      LIMIT 20`,
    [category, audience],
  );
  return rows;
}
