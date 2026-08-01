import { comparisonKey } from '../util/normalise.js';

// ---------------------------------------------------------------------------
// Normalisation and grounding checks for model output.
//
// Both adapters funnel through here so the pipeline downstream (storage, charts,
// PDF) can rely on exactly the Section 7 shape regardless of provider. Gemini
// with response_mime_type=application/json is well behaved; Ollama models on
// CPU are less so, hence the fence-stripping and brace-scanning below.
// ---------------------------------------------------------------------------

const CONFIDENCE = new Set(['high', 'medium', 'low']);

export const EMPTY_RESULT = {
  recommended_lineup: [],
  overall_rationale: '',
  competitor_analysis: '',
  budget_fit: '',
  confidence: 'low',
  gaps_or_caveats: '',
};

/**
 * Extract a JSON object from raw model text.
 *
 * Handles the three failure modes seen from local models: markdown fences, a
 * preamble sentence before the object, and trailing commentary after it.
 */
export function parseModelJson(text) {
  if (text === null || text === undefined) throw new Error('model returned no text');
  if (typeof text === 'object') return text;

  let s = String(text).trim();
  if (!s) throw new Error('model returned empty text');

  // ```json ... ``` or ``` ... ```
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    // Fall through to brace scanning.
  }

  // Take the outermost balanced {...}, ignoring braces inside string literals.
  const start = s.indexOf('{');
  if (start === -1) throw new Error(`model output contained no JSON object: ${s.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error(`model output was not valid JSON: ${s.slice(0, 200)}`);
}

const text = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(' ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const numberOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Coerce arbitrary model output into the exact Section 7 shape. */
export function normaliseResult(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};

  const lineupSource = Array.isArray(obj.recommended_lineup)
    ? obj.recommended_lineup
    : Array.isArray(obj.lineup)
      ? obj.lineup
      : [];

  const recommended_lineup = lineupSource
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const spots = numberOrNull(item.spots ?? item.no_of_spots ?? item.spot_count);
      const cost = numberOrNull(item.est_cost_lkr ?? item.est_cost ?? item.cost ?? item.estimated_cost);
      return {
        channel: text(item.channel ?? item.channel_name),
        programme: text(item.programme ?? item.programme_name ?? item.program),
        day: text(item.day ?? item.day_of_week ?? item.days),
        day_part: text(item.day_part ?? item.dayPart ?? item.daypart ?? item.time_band),
        spot_duration_secs: numberOrNull(
          item.spot_duration_secs ?? item.duration_secs ?? item.duration ?? item.spot_duration,
        ),
        spots: spots === null ? null : Math.max(0, Math.round(spots)),
        // MICOS reports "Avg. Ratings"; accept the older grp/trp keys too.
        rating: numberOrNull(item.rating ?? item.avg_rating ?? item.trp ?? item.grp),
        // null means "no observed cost for this slot", which is a real and
        // reportable state - not the same as zero.
        est_cost_lkr: cost,
        rationale: text(item.rationale ?? item.why ?? item.reason),
      };
    })
    .filter((item) => item.channel || item.programme);

  const confidenceRaw = text(obj.confidence).toLowerCase();
  const confidence = CONFIDENCE.has(confidenceRaw) ? confidenceRaw : 'low';

  return {
    recommended_lineup,
    overall_rationale: text(obj.overall_rationale ?? obj.rationale ?? obj.summary),
    competitor_analysis: text(obj.competitor_analysis ?? obj.competitors),
    budget_fit: text(obj.budget_fit ?? obj.budget ?? obj.budget_summary),
    confidence,
    gaps_or_caveats: text(obj.gaps_or_caveats ?? obj.caveats ?? obj.gaps),
  };
}

/**
 * Total the plan's cost and compare it against the brief's budget.
 *
 * Arithmetic the model should not be trusted with: a plan that quietly commits
 * 140% of the budget looks exactly like one that fits, unless someone adds the
 * numbers up. Budgets are held in LKR lakhs, spot costs in LKR.
 */
export function costPlan(lineup, budgetLakhs) {
  let total = 0;
  let costedLines = 0;
  let uncostedLines = 0;

  for (const item of lineup) {
    if (item.est_cost_lkr === null || item.est_cost_lkr === undefined) {
      uncostedLines += 1;
      continue;
    }
    // est_cost_lkr is the cost for the line as a whole when spots is absent.
    total += item.est_cost_lkr;
    costedLines += 1;
  }

  const budgetLkr = budgetLakhs === null || budgetLakhs === undefined
    ? null
    : Number(budgetLakhs) * 100_000;

  return {
    total_cost_lkr: Math.round(total),
    total_cost_lakhs: +(total / 100_000).toFixed(2),
    budget_lkr: budgetLkr,
    budget_lakhs: budgetLakhs ?? null,
    utilisation_pct: budgetLkr ? +((total / budgetLkr) * 100).toFixed(1) : null,
    over_budget: budgetLkr ? total > budgetLkr : null,
    costed_lines: costedLines,
    uncosted_lines: uncostedLines,
  };
}

/**
 * Verify every recommended channel/programme actually appears in the data the
 * model was given.
 *
 * "Never invent channel names or programmes not present in the supplied data"
 * is the load-bearing rule in the system prompt, and it's the one a model is
 * most likely to break quietly - a plausible-sounding programme name in a
 * client-facing report is worse than a gap. Rather than silently trusting it,
 * unmatched entries are flagged on the row, appended to gaps_or_caveats so they
 * surface in the PDF, and the confidence is capped at "medium".
 *
 * Entries are annotated, not deleted: a planner reviewing the plan should see
 * what the model proposed and why it was doubted.
 */
export function groundLineup(result, aggregatedData) {
  const knownProgrammes = new Set();
  const knownChannels = new Set();

  const learn = (rows) => {
    for (const row of rows || []) {
      if (row.programme_name) knownProgrammes.add(comparisonKey(row.programme_name));
      if (row.channel_name) knownChannels.add(comparisonKey(row.channel_name));
    }
  };

  // TV ratings are the main source, but not the only legitimate one:
  //  - programme_rates covers radio, which never appears in the TV ratings
  //    panel at all. Without it, every radio line would be reported as
  //    invented, which is both wrong and corrosive to trust in the flag.
  //  - competitor_spot_pressure names programmes the plan can legitimately
  //    target even when they fall outside the ratings shortlist.
  //  - channel_performance covers channels with no shortlisted programme.
  learn(aggregatedData?.programme_ratings);
  learn(aggregatedData?.programme_rates);
  learn(aggregatedData?.competitor_spot_pressure);
  learn(aggregatedData?.channel_performance);
  learn(aggregatedData?.channels);

  // With no rating data at all there's nothing to check against; the model
  // should already be saying so in gaps_or_caveats.
  if (!knownProgrammes.size && !knownChannels.size) {
    return { ...result, grounding: { checked: false, reason: 'no rating data supplied' } };
  }

  // Observed spot rates, keyed by channel|programme, for checking quoted costs.
  const rateIndex = new Map();
  for (const rate of aggregatedData?.programme_rates || []) {
    const key = `${comparisonKey(rate.channel_name)}|${comparisonKey(rate.programme_name)}`;
    if (!rateIndex.has(key)) rateIndex.set(key, []);
    rateIndex.get(key).push(rate);
  }

  const unmatched = [];
  const unsupportedCosts = [];

  const lineup = result.recommended_lineup.map((item) => {
    const channelOk = !item.channel || knownChannels.has(comparisonKey(item.channel));
    const programmeOk = !item.programme || knownProgrammes.has(comparisonKey(item.programme));
    const label = [item.channel, item.programme].filter(Boolean).join(' - ') || '(unnamed entry)';

    if (!channelOk || !programmeOk) {
      unmatched.push(label);
      return { ...item, in_source_data: false, cost_supported: null };
    }

    // A cost is only defensible if media watch actually observed a rate for
    // that channel and programme. An invented price is the most damaging thing
    // in the whole plan - it goes straight into a client's budget.
    let costSupported = null;
    if (item.est_cost_lkr !== null && item.est_cost_lkr !== undefined) {
      const rates = rateIndex.get(`${comparisonKey(item.channel)}|${comparisonKey(item.programme)}`);
      costSupported = Boolean(rates && rates.length);
      if (!costSupported) unsupportedCosts.push(label);
    }
    return { ...item, in_source_data: true, cost_supported: costSupported };
  });

  const problems = [];
  if (unmatched.length) {
    problems.push(
      `${unmatched.length} recommended entry/entries could not be matched to the supplied ` +
      `rating data (${unmatched.join('; ')})`,
    );
  }
  if (unsupportedCosts.length) {
    problems.push(
      `${unsupportedCosts.length} entry/entries quote a cost with no observed spot rate in the ` +
      `media watch data (${unsupportedCosts.join('; ')})`,
    );
  }

  if (!problems.length) {
    return {
      ...result,
      recommended_lineup: lineup,
      grounding: { checked: true, unmatched: [], unsupported_costs: [] },
    };
  }

  const note =
    `Automated check: ${problems.join('. ')}. Verify against the source before issuing the plan.`;

  return {
    ...result,
    recommended_lineup: lineup,
    // Never let an ungrounded plan claim high confidence.
    confidence: result.confidence === 'high' ? 'medium' : result.confidence,
    gaps_or_caveats: [result.gaps_or_caveats, note].filter(Boolean).join('\n\n'),
    grounding: { checked: true, unmatched, unsupported_costs: unsupportedCosts },
  };
}
