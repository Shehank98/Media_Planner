import { pool } from '../db.js';
import { log } from '../util/logger.js';
import { analyzeAndRecommend } from '../llm/index.js';
import { buildAggregatedData } from './aggregate.js';
import { buildChartData } from './chartData.js';
import { getBrief } from './briefRepo.js';
import { comparisonKey } from '../util/normalise.js';

// ---------------------------------------------------------------------------
// The query -> aggregate -> model -> JSON pipeline (Section 5, steps 3-6).
//
// The model is called once per brief. Filtering afterwards re-runs the SQL
// aggregation only (see reaggregate below), so a planner can slice by category,
// sector, competitor or date range without paying for another generation.
// ---------------------------------------------------------------------------

export async function generatePlan(briefId, opts = {}) {
  const brief = await getBrief(briefId);
  if (!brief) throw Object.assign(new Error(`Brief ${briefId} not found`), { status: 404 });

  const started = Date.now();
  let aggregated = await buildAggregatedData(brief, opts);

  // When the planner has already chosen channels, narrow what the model sees to
  // those channels so it plans within them rather than re-picking the mix.
  if (opts.channels?.length) {
    aggregated = filterAggregatedToChannels(aggregated, opts.channels);
  }

  // Refuse before spending a model call. With nothing loaded the model can only
  // invent a lineup or decline, and either way the planner learns nothing they
  // could not be told here for free.
  const hasRatings = (aggregated.programme_ratings || []).length > 0;
  const hasAdex = (aggregated.competitor_spend_by_quarter || []).length > 0
    || (aggregated.own_brand_trend || []).length > 0;
  if (!hasRatings && !hasAdex && !opts.force) {
    throw Object.assign(
      new Error('There is no ratings or spend data loaded, so a plan cannot be grounded in anything.'),
      {
        status: 409,
        hint: 'Upload a MICOS dashboard export under "Ratings & cost data" first, or sync the '
          + 'adex workbooks. Use "Preview data" to see what is currently loaded.',
      },
    );
  }

  const modelInput = briefForModel(brief);
  const recommendation = await analyzeAndRecommend(modelInput, aggregated, opts);

  const chartData = buildChartData(aggregated, recommendation, brief);

  const { rows } = await pool.query(
    `INSERT INTO plan_recommendations
       (brief_id, recommended_lineup, overall_rationale, competitor_analysis,
        chart_data, confidence, gaps_or_caveats, model_used)
     VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7,$8)
     RETURNING *`,
    [
      briefId,
      JSON.stringify(recommendation.channel_plan),
      recommendation.overall_rationale,
      recommendation.competitor_analysis,
      // The aggregates travel with the charts so the PDF appendix and any later
      // re-render work from exactly the numbers the model saw.
      JSON.stringify({
        ...chartData,
        aggregated,
        meta: recommendation.meta,
        budget: recommendation.budget,
        budget_fit: recommendation.budget_fit,
        clutter_strategy: recommendation.clutter_strategy,
        clutter: recommendation.clutter,
        schedule_totals: recommendation.schedule_totals,
        grounding: recommendation.grounding,
      }),
      recommendation.confidence,
      recommendation.gaps_or_caveats,
      recommendation.meta.model_used,
    ],
  );

  // The schedule is derived, so it lives in its own table and is rewritten
  // whenever the plan is regenerated.
  await saveSchedule(rows[0].id, recommendation.schedule);

  log.info('plan generated', {
    briefId,
    planId: rows[0].id,
    model: recommendation.meta.model_used,
    channels: recommendation.channel_plan.length,
    schedule_lines: recommendation.schedule.length,
    total_ms: Date.now() - started,
    llm_ms: recommendation.meta.elapsed_ms,
  });

  return { plan: rows[0], recommendation, aggregated, brief };
}

/**
 * Narrow the aggregated payload to a chosen set of channels.
 *
 * Used when the planner has already picked the channels and wants the model to
 * plan within them. Everything keyed by channel is filtered; the adex context
 * (which is category-level, not per-channel) is left as-is.
 */
export function filterAggregatedToChannels(aggregated, channels) {
  const keep = new Set(channels.map((c) => comparisonKey(c)));
  const byChannel = (rows) => (rows || []).filter((r) => keep.has(comparisonKey(r.channel_name)));
  return {
    ...aggregated,
    programme_ratings: byChannel(aggregated.programme_ratings),
    channel_performance: byChannel(aggregated.channel_performance),
    best_days: byChannel(aggregated.best_days),
    best_dayparts: byChannel(aggregated.best_dayparts),
    programme_rates: byChannel(aggregated.programme_rates),
    competitor_spot_pressure: byChannel(aggregated.competitor_spot_pressure),
    data_notes: [
      ...(aggregated.data_notes || []),
      `Planning was restricted to the channels you chose: ${channels.join(', ')}.`,
    ],
  };
}

/** Only the fields the system prompt promises the model - nothing internal. */
function briefForModel(brief) {
  return {
    brand: brief.brand,
    advertiser: brief.advertiser,
    objective: brief.objective,
    target_audience: brief.target_audience,
    language: brief.language,
    territory: brief.territory,
    campaign_period: { start: brief.period_start, end: brief.period_end },
    campaign_days: campaignDays(brief),
    budget_lkr_lakhs: brief.budget_lkr_lakhs,
    // The commercial lengths the plan may buy. The model must not invent others.
    commercial_durations_secs: brief.commercial_durations || [],
  };
}

/** Length of the flight, so the model can size the number of spots sensibly. */
function campaignDays(brief) {
  if (!brief.period_start || !brief.period_end) return null;
  const from = new Date(`${brief.period_start}T00:00:00Z`);
  const to = new Date(`${brief.period_end}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/** Replace the stored schedule for a plan. */
export async function saveSchedule(planId, lines) {
  await pool.query('DELETE FROM plan_schedule WHERE plan_id = $1', [planId]);
  if (!lines?.length) return;

  const columns = ['plan_id', 'channel_name', 'programme_name', 'day_pattern', 'time_band',
    'time_start', 'time_end', 'duration_secs', 'spots', 'tvr', 'rate_lkr', 'cost_lkr',
    'spot_dates', 'line_order'];
  const values = [];
  const tuples = [];
  lines.forEach((line, idx) => {
    const base = idx * columns.length;
    tuples.push(`(${columns.map((_, c) => `$${base + c + 1}`).join(',')})`);
    values.push(
      planId, line.channel_name, line.programme_name, line.day_pattern, line.time_band,
      line.time_start, line.time_end, line.duration_secs, line.spots, line.tvr,
      line.rate_lkr, line.cost_lkr, JSON.stringify(line.spot_dates || {}), line.line_order ?? idx,
    );
  });
  await pool.query(
    `INSERT INTO plan_schedule (${columns.join(',')}) VALUES ${tuples.join(',')}`,
    values,
  );
}

/** The stored schedule for a plan, in display order. */
export async function getSchedule(planId) {
  const { rows } = await pool.query(
    'SELECT * FROM plan_schedule WHERE plan_id = $1 ORDER BY line_order',
    [planId],
  );
  return rows;
}

export async function getPlan(planId) {
  const { rows } = await pool.query('SELECT * FROM plan_recommendations WHERE id = $1', [planId]);
  return rows[0] || null;
}

export async function latestPlanForBrief(briefId) {
  const { rows } = await pool.query(
    'SELECT * FROM plan_recommendations WHERE brief_id = $1 ORDER BY created_at DESC LIMIT 1',
    [briefId],
  );
  return rows[0] || null;
}

export async function listPlans(briefId) {
  const { rows } = await pool.query(
    `SELECT id, brief_id, confidence, model_used, created_at,
            jsonb_array_length(COALESCE(recommended_lineup, '[]'::jsonb)) AS lineup_size
       FROM plan_recommendations
      WHERE ($1::int IS NULL OR brief_id = $1)
      ORDER BY created_at DESC LIMIT 100`,
    [briefId ?? null],
  );
  return rows;
}

/**
 * Re-run the aggregation for an existing plan under new filters.
 *
 * Deliberately does not call the model (Section 5, step 7): the narrative stays
 * fixed while the numbers move, so filter clicks are free and the rationale a
 * client already saw doesn't silently change underneath them.
 */
export async function reaggregate(briefId, filters = {}) {
  const brief = await getBrief(briefId);
  if (!brief) throw Object.assign(new Error(`Brief ${briefId} not found`), { status: 404 });

  const aggregated = await buildAggregatedData(brief, { filters, ...filters });
  const plan = await latestPlanForBrief(briefId);
  const recommendation = plan
    ? { recommended_lineup: plan.recommended_lineup || [] }
    : { recommended_lineup: [] };

  return {
    brief,
    filters,
    aggregated,
    chart_data: buildChartData(aggregated, recommendation, brief),
    plan_id: plan?.id ?? null,
    model_called: false,
  };
}
