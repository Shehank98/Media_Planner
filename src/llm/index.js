import { config } from '../config.js';
import { log } from '../util/logger.js';
import { normaliseResult, groundLineup, costPlan, flattenPlan } from './schema.js';
import { describeLlmError } from './errors.js';
import { buildSchedule } from '../services/schedule.js';
import { checkPlanClutter } from '../services/clutter.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';

// ---------------------------------------------------------------------------
// The single adapter seam.
//
// Callers use analyzeAndRecommend(brief, aggregatedData) and never learn which
// provider answered. Both adapters take identical input and return identical
// output, so switching provider is LLM_PROVIDER and nothing more.
//
// Everything after the model call is deterministic: ground the names, place the
// spots on dates, add up the money, and check the buy is not stacked into one
// time belt. The model reasons; the arithmetic is verified.
// ---------------------------------------------------------------------------

const ADAPTERS = { gemini, ollama };

export function getAdapter(provider = config.llm.provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}". Supported: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return adapter;
}

/**
 * Generate a media plan recommendation with its schedule.
 *
 * @param {Object} brief           confirmed campaign brief fields
 * @param {Object} aggregatedData  pre-aggregated ratings, cost and spend payload
 * @param {Object} [opts]
 * @param {string} [opts.provider] override the configured provider
 */
export async function analyzeAndRecommend(brief, aggregatedData, opts = {}) {
  const provider = opts.provider || config.llm.provider;
  const adapter = getAdapter(provider);

  log.info('llm call started', { provider, model: adapter.modelId() });

  let raw;
  let meta;
  try {
    ({ raw, meta } = await adapter.analyze(brief, aggregatedData));
  } catch (err) {
    // Every provider failure reaches the caller as an LlmError carrying a
    // status and a remedy, so the route can answer with something better than
    // a 500 and an opaque message.
    const described = describeLlmError(err, provider);
    log.error('llm call failed', {
      provider, model: adapter.modelId(), reason: described.message, fix: described.hint,
    });
    throw described;
  }

  const normalised = normaliseResult(raw);
  const grounded = groundLineup(normalised, aggregatedData);

  // Place the spots on real dates rather than asking the model to emit sixty
  // date columns, which it cannot do reliably.
  const schedule = buildSchedule(
    grounded.channel_plan,
    brief,
    aggregatedData?.programme_rates || [],
  );
  const budget = costPlan(schedule.totals, brief?.budget_lkr_lakhs);
  const clutter = checkPlanClutter(schedule.lines);

  const result = {
    ...grounded,
    // Kept for anything that wants one row per programme.
    lineup: flattenPlan(grounded.channel_plan),
    schedule: schedule.lines,
    schedule_totals: schedule.totals,
    schedule_warnings: schedule.warnings,
    budget,
    clutter,
  };

  const notes = [];
  if (budget.over_budget) {
    notes.push(
      `Automated check: the schedule totals LKR ${budget.total_cost_lakhs} lakhs against a stated `
      + `budget of ${budget.budget_lakhs} lakhs (${budget.utilisation_pct}% of budget). `
      + 'Trim the buy or confirm the budget before issuing this plan.',
    );
  }
  if (!clutter.ok) {
    // The clutter rule is the one most likely to be agreed to in the rationale
    // and ignored in the numbers, so the measured breach is what gets reported.
    notes.push(
      `Automated clutter check: ${clutter.issues.map((i) => i.detail).join(' ')}`,
    );
  }
  if (schedule.warnings.length) notes.push(...schedule.warnings);

  if (notes.length) {
    result.gaps_or_caveats = [result.gaps_or_caveats, ...notes].filter(Boolean).join('\n\n');
    if (result.confidence === 'high' && (budget.over_budget || !clutter.ok)) {
      result.confidence = 'medium';
    }
  }

  log.info('llm call finished', {
    provider,
    model: meta.model,
    elapsed_ms: meta.elapsed_ms,
    channels: result.channel_plan.length,
    schedule_lines: schedule.lines.length,
    total_spots: schedule.totals.total_spots,
    confidence: result.confidence,
    ungrounded: result.grounding?.unmatched?.length ?? 0,
    clutter_issues: clutter.issues.length,
    budget_utilisation_pct: budget.utilisation_pct,
  });

  return { ...result, meta };
}

export { SYSTEM_PROMPT } from './systemPrompt.js';
