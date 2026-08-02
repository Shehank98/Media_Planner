import express from 'express';
import { asyncRoute } from '../util/asyncRoute.js';
import { pool } from '../db.js';
import { getBrief } from '../services/briefRepo.js';
import { analyzeForExplorer, buildScheduleFromPicks } from '../services/explorer.js';
import { saveSchedule } from '../services/planService.js';
import { explainSchedule } from '../llm/index.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// The interactive explorer: the planner picks channels and programmes, then the
// schedule is built from those picks (Section: channel-first, planner-driven).
//
//   GET  /:briefId/analyze   top channels + competitor read + programme picker
//   POST /:briefId/schedule  build a dated schedule from the planner's picks
// ---------------------------------------------------------------------------

/** Everything the explorer screen needs to let the planner choose. */
router.get('/:briefId/analyze', asyncRoute(async (req, res) => {
  const brief = await getBrief(Number(req.params.briefId));
  if (!brief) return res.status(404).json({ error: 'Brief not found' });

  const analysis = await analyzeForExplorer(brief, { audience: req.query.audience });
  if (!analysis.channels.length) {
    return res.status(409).json({
      error: 'No channel data is loaded, so there is nothing to explore.',
      hint: 'Upload a MICOS channel-summary export under the Data tab first.',
      data_notes: analysis.data_notes,
    });
  }
  res.json({ brief_id: brief.id, ...analysis });
}));

/**
 * Build, cost, clutter-check and explain a schedule from the planner's picks.
 *
 * The picks are the fixed line-up. Spot placement, costing and the clutter check
 * are deterministic; the model only explains the result, and if it is
 * unreachable a deterministic explanation is used instead. The plan is stored so
 * the Excel and PDF exports work exactly as they do for a generated plan.
 */
router.post('/:briefId/schedule', asyncRoute(async (req, res) => {
  const brief = await getBrief(Number(req.params.briefId));
  if (!brief) return res.status(404).json({ error: 'Brief not found' });

  const picks = req.body?.picks || [];
  const built = await buildScheduleFromPicks(brief, picks);

  const explanation = await explainSchedule({
    brief,
    schedule: built.lines,
    totals: built.totals,
    budget: built.budget,
    clutter: built.clutter,
    channels: req.body?.channels || [],
  }, { provider: req.body?.provider });

  const budgetFit = built.budget.over_budget === null
    ? 'No budget stated, so the buy is not measured against one.'
    : built.budget.over_budget
      ? `Over budget: LKR ${built.budget.total_cost_lakhs} lakhs is ${built.budget.utilisation_pct}% of the ${built.budget.budget_lakhs} lakh budget.`
      : `Within budget: LKR ${built.budget.total_cost_lakhs} lakhs is ${built.budget.utilisation_pct ?? '?'}% of the ${built.budget.budget_lakhs} lakh budget.`;

  const caveats = [];
  if (built.warnings.length) caveats.push(...built.warnings);
  if (!built.clutter.ok) caveats.push(`Clutter: ${built.clutter.issues.map((i) => i.detail).join(' ')}`);

  const confidence = built.clutter.ok && built.budget.over_budget !== true ? 'high' : 'medium';

  const chartData = {
    schedule_totals: built.totals,
    budget: built.budget,
    budget_fit: budgetFit,
    clutter: built.clutter,
    clutter_strategy: explanation.clutter_strategy,
    competitor_analysis: explanation.competitor_analysis,
    per_channel: explanation.per_channel,
    explorer: true,
    picks,
  };

  const { rows } = await pool.query(
    `INSERT INTO plan_recommendations
       (brief_id, recommended_lineup, overall_rationale, competitor_analysis,
        chart_data, confidence, gaps_or_caveats, model_used)
     VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7,$8)
     RETURNING id`,
    [
      brief.id,
      JSON.stringify(built.channel_plan),
      explanation.overall_rationale,
      explanation.competitor_analysis,
      JSON.stringify(chartData),
      confidence,
      caveats.join('\n\n') || null,
      explanation.model_used || 'explorer',
    ],
  );
  const planId = rows[0].id;
  await saveSchedule(planId, built.lines);

  const dates = [...new Set(built.lines.flatMap((l) => Object.keys(l.spot_dates || {})))].sort();

  res.status(201).json({
    plan_id: planId,
    brief_id: brief.id,
    schedule: built.lines,
    dates,
    schedule_totals: built.totals,
    budget: built.budget,
    budget_fit: budgetFit,
    clutter: built.clutter,
    warnings: built.warnings,
    confidence,
    explanation,
  });
}));
