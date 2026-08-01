import { comparisonKey } from '../util/normalise.js';

// ---------------------------------------------------------------------------
// Normalisation and grounding checks for model output.
//
// Both adapters funnel through here so the pipeline downstream (schedule,
// storage, charts, PDF) can rely on exactly one shape regardless of provider.
// Gemini with response_mime_type=application/json is well behaved; Ollama
// models on CPU are less so, hence the fence-stripping and brace-scanning.
// ---------------------------------------------------------------------------

const CONFIDENCE = new Set(['high', 'medium', 'low']);

export const EMPTY_RESULT = {
  channel_plan: [],
  overall_rationale: '',
  competitor_analysis: '',
  clutter_strategy: '',
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

const intOrNull = (v) => {
  const n = numberOrNull(v);
  return n === null ? null : Math.max(0, Math.round(n));
};

/** Coerce arbitrary model output into the channel-first shape. */
export function normaliseResult(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};

  const source = Array.isArray(obj.channel_plan) ? obj.channel_plan
    : Array.isArray(obj.channels) ? obj.channels
      // A model that reverts to a flat lineup still produces a usable plan:
      // group it by channel rather than discarding it.
      : Array.isArray(obj.recommended_lineup) ? groupFlatLineup(obj.recommended_lineup)
        : [];

  const channel_plan = source
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      channel: text(c.channel ?? c.channel_name),
      share_of_audience: numberOrNull(c.share_of_audience ?? c.share),
      why_this_channel: text(c.why_this_channel ?? c.why ?? c.rationale),
      programmes: (Array.isArray(c.programmes) ? c.programmes : [])
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          programme: text(p.programme ?? p.programme_name ?? p.program),
          day_pattern: text(p.day_pattern ?? p.days ?? p.day),
          time_band: text(p.time_band ?? p.day_part ?? p.belt),
          time_start: text(p.time_start ?? p.start_time),
          time_end: text(p.time_end ?? p.end_time),
          duration_secs: intOrNull(p.duration_secs ?? p.spot_duration_secs ?? p.duration),
          spots: intOrNull(p.spots ?? p.no_of_spots ?? p.spot_count) ?? 0,
          tvr: numberOrNull(p.tvr ?? p.rating ?? p.avg_rating),
          // null means "no observed rate", which is a real and reportable
          // state - not the same as free.
          rate_lkr: numberOrNull(p.rate_lkr ?? p.rate ?? p.cost_per_spot),
          cost_lkr: numberOrNull(p.cost_lkr ?? p.total_cost),
          rationale: text(p.rationale ?? p.why ?? p.reason),
        }))
        .filter((p) => p.programme),
    }))
    .filter((c) => c.channel && c.programmes.length);

  const confidenceRaw = text(obj.confidence).toLowerCase();

  return {
    channel_plan,
    overall_rationale: text(obj.overall_rationale ?? obj.rationale ?? obj.summary),
    competitor_analysis: text(obj.competitor_analysis ?? obj.competitors),
    clutter_strategy: text(obj.clutter_strategy ?? obj.clutter ?? obj.spread),
    budget_fit: text(obj.budget_fit ?? obj.budget ?? obj.budget_summary),
    confidence: CONFIDENCE.has(confidenceRaw) ? confidenceRaw : 'low',
    gaps_or_caveats: text(obj.gaps_or_caveats ?? obj.caveats ?? obj.gaps),
  };
}

/** Rebuild channel groups from a flat lineup, preserving order. */
function groupFlatLineup(lineup) {
  const byChannel = new Map();
  for (const item of lineup) {
    if (!item || typeof item !== 'object') continue;
    const channel = text(item.channel ?? item.channel_name);
    if (!channel) continue;
    if (!byChannel.has(channel)) byChannel.set(channel, { channel, programmes: [] });
    byChannel.get(channel).programmes.push(item);
  }
  return [...byChannel.values()];
}

/** Flatten the channel plan back to one row per programme, for checks and display. */
export function flattenPlan(channelPlan) {
  const out = [];
  for (const channel of channelPlan || []) {
    for (const programme of channel.programmes || []) {
      out.push({ channel: channel.channel, ...programme });
    }
  }
  return out;
}

/**
 * Verify every recommended channel and programme appears in the supplied data,
 * and that every quoted rate has an observation behind it.
 *
 * "Never invent programmes or costs" is the load-bearing rule in the prompt and
 * the one a model breaks most quietly. A plausible-sounding programme name in a
 * client-facing plan is worse than a gap; an invented rate is worse still,
 * because it goes straight into a client's budget.
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
  //  - programme_rates covers radio, which never appears in the TV panel;
  //  - competitor_spot_pressure names programmes outside the shortlist;
  //  - channel_performance covers channels with no shortlisted programme.
  learn(aggregatedData?.programme_ratings);
  learn(aggregatedData?.programme_rates);
  learn(aggregatedData?.competitor_spot_pressure);
  learn(aggregatedData?.channel_performance);
  learn(aggregatedData?.channels);

  if (!knownProgrammes.size && !knownChannels.size) {
    return { ...result, grounding: { checked: false, reason: 'no rating data supplied' } };
  }

  const rateIndex = new Set();
  for (const rate of aggregatedData?.programme_rates || []) {
    rateIndex.add(`${comparisonKey(rate.channel_name)}|${comparisonKey(rate.programme_name)}`);
  }
  for (const p of aggregatedData?.programme_ratings || []) {
    if (p.observed_avg_cost !== null && p.observed_avg_cost !== undefined) {
      rateIndex.add(`${comparisonKey(p.channel_name)}|${comparisonKey(p.programme_name)}`);
    }
  }

  const unmatched = [];
  const unsupportedRates = [];

  const channel_plan = (result.channel_plan || []).map((channel) => {
    const channelOk = knownChannels.has(comparisonKey(channel.channel));
    const programmes = channel.programmes.map((p) => {
      const programmeOk = knownProgrammes.has(comparisonKey(p.programme));
      const label = `${channel.channel} - ${p.programme}`;

      if (!channelOk || !programmeOk) {
        unmatched.push(label);
        return { ...p, in_source_data: false, rate_supported: null };
      }

      let rateSupported = null;
      if (p.rate_lkr !== null && p.rate_lkr !== undefined) {
        rateSupported = rateIndex.has(
          `${comparisonKey(channel.channel)}|${comparisonKey(p.programme)}`,
        );
        if (!rateSupported) unsupportedRates.push(label);
      }
      return { ...p, in_source_data: true, rate_supported: rateSupported };
    });
    return { ...channel, in_source_data: channelOk, programmes };
  });

  const problems = [];
  if (unmatched.length) {
    problems.push(
      `${unmatched.length} recommended entry/entries could not be matched to the supplied `
      + `rating data (${unmatched.join('; ')})`,
    );
  }
  if (unsupportedRates.length) {
    problems.push(
      `${unsupportedRates.length} entry/entries quote a rate with no observed spot cost in the `
      + `media watch data (${unsupportedRates.join('; ')})`,
    );
  }

  if (!problems.length) {
    return {
      ...result,
      channel_plan,
      grounding: { checked: true, unmatched: [], unsupported_rates: [] },
    };
  }

  const note = `Automated check: ${problems.join('. ')}. Verify against the source before issuing the plan.`;

  return {
    ...result,
    channel_plan,
    // Never let an ungrounded plan claim high confidence.
    confidence: result.confidence === 'high' ? 'medium' : result.confidence,
    gaps_or_caveats: [result.gaps_or_caveats, note].filter(Boolean).join('\n\n'),
    grounding: { checked: true, unmatched, unsupported_rates: unsupportedRates },
  };
}

/**
 * Total the schedule and compare it against the brief's budget.
 *
 * Arithmetic the model should not be trusted with: a plan that quietly commits
 * 140% of the budget looks exactly like one that fits, unless someone adds the
 * numbers up. Budgets are held in LKR lakhs, spot costs in LKR.
 */
export function costPlan(scheduleTotals, budgetLakhs) {
  const total = scheduleTotals?.total_cost_lkr ?? 0;
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
    total_spots: scheduleTotals?.total_spots ?? 0,
    costed_spots: scheduleTotals?.costed_spots ?? 0,
    uncosted_spots: scheduleTotals?.uncosted_spots ?? 0,
  };
}
