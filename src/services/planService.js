import { pool } from '../db.js';
import { log } from '../util/logger.js';
import { analyzeAndRecommend } from '../llm/index.js';
import { buildAggregatedData } from './aggregate.js';
import { buildChartData } from './chartData.js';
import { getBrief } from './briefRepo.js';

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
  const aggregated = await buildAggregatedData(brief, opts);

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
      JSON.stringify(recommendation.recommended_lineup),
      recommendation.overall_rationale,
      recommendation.competitor_analysis,
      // The aggregates travel with the charts so the PDF appendix and any later
      // re-render work from exactly the numbers the model saw.
      JSON.stringify({ ...chartData, aggregated, meta: recommendation.meta }),
      recommendation.confidence,
      recommendation.gaps_or_caveats,
      recommendation.meta.model_used,
    ],
  );

  log.info('plan generated', {
    briefId,
    planId: rows[0].id,
    model: recommendation.meta.model_used,
    total_ms: Date.now() - started,
    llm_ms: recommendation.meta.elapsed_ms,
  });

  return { plan: rows[0], recommendation, aggregated, brief };
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
    budget_lkr_lakhs: brief.budget_lkr_lakhs,
    medium_split: brief.medium_split,
  };
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
