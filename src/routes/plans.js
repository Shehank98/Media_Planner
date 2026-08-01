import express from 'express';
import { asyncRoute } from '../util/asyncRoute.js';
import { generatePlan, getPlan, listPlans, latestPlanForBrief, reaggregate } from '../services/planService.js';
import { buildAggregatedData } from '../services/aggregate.js';
import { getBrief } from '../services/briefRepo.js';
import { generateReport } from '../services/reportService.js';

export const router = express.Router();

/**
 * Run the pipeline for a brief: aggregate -> model -> store.
 *
 * This is the only endpoint that costs a model call.
 */
router.post('/generate/:briefId', asyncRoute(async (req, res) => {
  const briefId = Number(req.params.briefId);
  const { quarters, programmeLimit, provider } = req.body || {};
  const result = await generatePlan(briefId, { quarters, programmeLimit, provider });

  res.status(201).json({
    plan_id: result.plan.id,
    brief_id: briefId,
    recommended_lineup: result.recommendation.recommended_lineup,
    overall_rationale: result.recommendation.overall_rationale,
    competitor_analysis: result.recommendation.competitor_analysis,
    confidence: result.recommendation.confidence,
    gaps_or_caveats: result.recommendation.gaps_or_caveats,
    grounding: result.recommendation.grounding,
    meta: result.recommendation.meta,
    data_notes: result.aggregated.data_notes,
  });
}));

/**
 * Preview exactly what the model would be sent, without calling it.
 *
 * Worth having on its own: if a plan reads oddly the first question is always
 * whether the aggregation fed it the right numbers.
 */
router.get('/preview/:briefId', asyncRoute(async (req, res) => {
  const brief = await getBrief(Number(req.params.briefId));
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  const aggregated = await buildAggregatedData(brief, {
    quarters: req.query.quarters,
    programmeLimit: req.query.programmeLimit,
    filters: pickFilters(req.query),
  });
  res.json({ brief, aggregated, model_called: false });
}));

router.get('/', asyncRoute(async (req, res) => {
  const briefId = req.query.brief_id ? Number(req.query.brief_id) : null;
  res.json({ plans: await listPlans(briefId) });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const plan = await getPlan(Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json(plan);
}));

router.get('/brief/:briefId/latest', asyncRoute(async (req, res) => {
  const plan = await latestPlanForBrief(Number(req.params.briefId));
  if (!plan) return res.status(404).json({ error: 'No plan generated for this brief yet' });
  res.json(plan);
}));

/**
 * Re-filter against live Postgres without re-calling the model (Section 5,
 * step 7). Filter clicks are free and the rationale stays put.
 */
router.get('/brief/:briefId/filter', asyncRoute(async (req, res) => {
  const result = await reaggregate(Number(req.params.briefId), pickFilters(req.query));
  res.json(result);
}));

/** Stream the PDF report for a plan. */
router.get('/:id/report.pdf', asyncRoute(async (req, res) => {
  const { path: filePath, filename, cleanup } = await generateReport(Number(req.params.id));
  res.download(filePath, filename, (err) => {
    // Always clear the working directory, whether or not the transfer finished.
    cleanup();
    if (err && !res.headersSent) res.status(500).json({ error: 'Failed to send report' });
  });
}));

function pickFilters(query = {}) {
  const filters = {};
  for (const key of ['category', 'sector', 'language', 'target_audience', 'from', 'to']) {
    if (query[key]) filters[key] = String(query[key]);
  }
  if (query.quarters) filters.quarters = Number(query.quarters);
  if (query.programmeLimit) filters.programmeLimit = Number(query.programmeLimit);
  return filters;
}
