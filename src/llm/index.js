import { config } from '../config.js';
import { log } from '../util/logger.js';
import { normaliseResult, groundLineup, costPlan } from './schema.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';

// ---------------------------------------------------------------------------
// The single adapter seam (Section 1).
//
// Callers use analyzeAndRecommend(brief, aggregatedData) and never learn which
// provider answered. Both adapters take identical input and return identical
// output, so Phase 2 is LLM_PROVIDER=ollama and nothing more.
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
 * Generate a media plan recommendation.
 *
 * @param {Object} brief           confirmed campaign brief fields
 * @param {Object} aggregatedData  pre-aggregated adex + ratings payload
 * @param {Object} [opts]
 * @param {string} [opts.provider] override the configured provider (used by the benchmark)
 * @returns {Promise<Object>} Section 7 JSON plus a `meta` block
 */
export async function analyzeAndRecommend(brief, aggregatedData, opts = {}) {
  const provider = opts.provider || config.llm.provider;
  const adapter = getAdapter(provider);

  log.info('llm call started', { provider, model: adapter.modelId() });
  const { raw, meta } = await adapter.analyze(brief, aggregatedData);

  const normalised = normaliseResult(raw);
  const grounded = groundLineup(normalised, aggregatedData);
  // Add the plan up rather than taking the model's word for the budget fit.
  const budget = costPlan(grounded.recommended_lineup, brief?.budget_lkr_lakhs);

  const result = { ...grounded, budget };
  if (budget.over_budget) {
    const note =
      `Automated check: the lineup totals LKR ${budget.total_cost_lakhs} lakhs against a stated ` +
      `budget of ${budget.budget_lakhs} lakhs (${budget.utilisation_pct}% of budget). ` +
      'Trim the lineup or confirm the budget before issuing this plan.';
    result.gaps_or_caveats = [result.gaps_or_caveats, note].filter(Boolean).join('\n\n');
    if (result.confidence === 'high') result.confidence = 'medium';
  }

  log.info('llm call finished', {
    provider,
    model: meta.model,
    elapsed_ms: meta.elapsed_ms,
    tokens_per_sec: meta.tokens_per_sec,
    lineup_size: result.recommended_lineup.length,
    confidence: result.confidence,
    ungrounded: result.grounding?.unmatched?.length ?? 0,
    budget_utilisation_pct: budget.utilisation_pct,
  });

  return { ...result, meta };
}

export { SYSTEM_PROMPT } from './systemPrompt.js';
