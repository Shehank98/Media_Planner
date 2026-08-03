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

// ---------------------------------------------------------------------------
// Explain a schedule the planner built by hand in the explorer.
//
// The plan is already fixed and costed here, so the model does not choose
// anything - it narrates strategy over numbers it is handed. If no provider is
// configured or the call fails, a deterministic explanation is produced from
// the same numbers, so the explorer never depends on a model being reachable.
// ---------------------------------------------------------------------------

const EXPLAIN_PROMPT = `You are a Sri Lankan TV media planner explaining a schedule a colleague has already built and costed. You are NOT allowed to add, drop, or re-cost any line - only explain what is there.

You receive JSON: the brief, the schedule (channel -> programmes with day pattern, time band, duration, spots, TVR, rate, cost), the totals and budget fit, the automated clutter check, and how competitors behave on each channel.

Return ONLY a JSON object:
{
  "overall_rationale": "2-4 sentences: why this channel and programme mix suits the brief's audience, objective and budget.",
  "competitor_analysis": "2-3 sentences on how this buy sits against competitor GRP and spend on these channels.",
  "clutter_strategy": "1-2 sentences: if the clutter check flagged an issue, how to spread or re-time; if clean, say the spread is within limits.",
  "per_channel": [ { "channel_name": "...", "note": "one sentence on this channel's role in the plan" } ]
}
Ground every statement in the numbers supplied. Do not invent programmes, rates, or audiences.`;

export async function explainSchedule({ brief, schedule, totals, budget, clutter, channels = [] }, opts = {}) {
  const provider = opts.provider || config.llm.provider;
  const payload = {
    brief: {
      brand: brief?.brand, objective: brief?.objective,
      target_audience: brief?.target_audience, budget_lkr_lakhs: brief?.budget_lkr_lakhs,
      commercial_durations: brief?.commercial_durations,
    },
    schedule: (schedule || []).map((l) => ({
      channel: l.channel_name, programme: l.programme_name, day_pattern: l.day_pattern,
      time_band: l.time_band, duration_secs: l.duration_secs, spots: l.spots,
      tvr: l.tvr, rate_lkr: l.rate_lkr, cost_lkr: l.cost_lkr,
    })),
    totals, budget,
    clutter: { ok: clutter?.ok, issues: (clutter?.issues || []).map((i) => i.detail) },
    competitor_behaviour: channels,
  };

  try {
    const adapter = getAdapter(provider);
    if (typeof adapter.complete !== 'function') throw new Error('provider has no complete()');
    const { raw, meta } = await adapter.complete({ system: EXPLAIN_PROMPT, user: payload });
    return {
      overall_rationale: str(raw.overall_rationale),
      competitor_analysis: str(raw.competitor_analysis),
      clutter_strategy: str(raw.clutter_strategy),
      per_channel: Array.isArray(raw.per_channel)
        ? raw.per_channel.map((p) => ({ channel_name: str(p.channel_name), note: str(p.note) }))
          .filter((p) => p.channel_name)
        : [],
      model_used: meta?.model_used || null,
      source: 'model',
    };
  } catch (err) {
    log.warn('explainSchedule fell back to deterministic text', { provider, reason: err.message });
    return { ...deterministicExplanation(payload), source: 'fallback' };
  }
}

function deterministicExplanation({ brief, schedule, totals, budget, clutter, competitor_behaviour }) {
  const channelNames = [...new Set(schedule.map((l) => l.channel))];
  const spend = budget?.total_cost_lakhs;
  const util = budget?.utilisation_pct;
  const overall = [
    `${channelNames.length} channel${channelNames.length === 1 ? '' : 's'} `
    + `(${channelNames.join(', ')}) carry ${totals?.total_spots ?? 0} spots`
    + (spend ? ` at LKR ${spend} lakhs` : '')
    + (util ? ` (${util}% of budget)` : '') + '.',
    brief.target_audience ? `Selected against the ${brief.target_audience} audience.` : '',
    brief.objective ? `Objective: ${brief.objective}.` : '',
  ].filter(Boolean).join(' ');

  const clutterStrategy = clutter?.ok
    ? 'The buy is spread within the clutter limits: no single time belt is over-loaded.'
    : `Clutter check flagged: ${(clutter?.issues || []).join(' ')} Re-time or thin the affected belt.`;

  const perChannel = channelNames.map((name) => {
    const lines = schedule.filter((l) => l.channel === name);
    const spots = lines.reduce((a, l) => a + (l.spots || 0), 0);
    const comp = (competitor_behaviour || []).find((c) => c.channel_name === name);
    const share = comp?.share_of_audience;
    return {
      channel_name: name,
      note: `${lines.length} programme line${lines.length === 1 ? '' : 's'}, ${spots} spots`
        + (share ? `; ${share}% share of audience` : '')
        + (comp?.competitor?.grp_share_pct ? `, competitors hold ${comp.competitor.grp_share_pct}% of GRP here` : '')
        + '.',
    };
  });

  return {
    overall_rationale: overall,
    competitor_analysis: 'Competitor GRP and spend by channel are shown alongside each line; '
      + 'this buy is placed on the channels carrying the target audience.',
    clutter_strategy: clutterStrategy,
    per_channel: perChannel,
    model_used: null,
  };
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ---------------------------------------------------------------------------
// Competitor analysis read.
//
// Turns the rolled-up monitoring numbers into a decision-focused brief for the
// planner: where the brand stands, what each competitor is doing, and what to do
// about it. The model only ever sees the aggregates. If no provider answers, a
// deterministic read is built from the same numbers so the button always works.
// ---------------------------------------------------------------------------

const COMPETITOR_PROMPT = `You are a senior TV media analyst at a Sri Lankan media agency. You are given a competitor spend monitoring summary (from media watch) for a brand and its competitors over a period: per advertiser the ad count, monitored cost, share of voice and share of spend, value additions vs plain spots, and prime vs non-prime spend; plus the top channels and programmes by spend.

Write a decision-focused read for the brand's planner - not a description of the numbers, but what they mean and what to do. Currency is LKR. Ground every point in the figures and name brands, channels and programmes. To grow share, a brand's share of voice should at least match its share-of-market ambition.

Return ONLY this JSON:
{
  "headline": "one sentence: where the brand stands against the set",
  "reasoning": "2-4 sentences explaining the competitive picture from the numbers",
  "recommendations": [ { "action": "a specific thing to do", "rationale": "why, citing the numbers" } ],
  "opportunities": [ "short point" ],
  "threats": [ "short point" ],
  "key_inputs": [ "the specific figures this read leaned on, e.g. 'Competitor X: 69% SOS, 74% of spend in prime'" ]
}
Keep it tight and specific. No text outside the JSON. Do not use em dashes.`;

export async function explainCompetitors(payload, opts = {}) {
  const provider = opts.provider || config.llm.provider;
  try {
    const adapter = getAdapter(provider);
    if (typeof adapter.complete !== 'function') throw new Error('provider has no complete()');
    const { raw, meta } = await adapter.complete({ system: COMPETITOR_PROMPT, user: payload });
    return {
      headline: str(raw.headline),
      reasoning: str(raw.reasoning),
      recommendations: arr(raw.recommendations).map((r) => ({ action: str(r.action), rationale: str(r.rationale) })).filter((r) => r.action),
      opportunities: arr(raw.opportunities).map(str).filter(Boolean),
      threats: arr(raw.threats).map(str).filter(Boolean),
      key_inputs: arr(raw.key_inputs).map(str).filter(Boolean),
      model_used: meta?.model_used || null,
      source: 'model',
    };
  } catch (err) {
    log.warn('explainCompetitors fell back to deterministic read', { provider, reason: err.message });
    return { ...deterministicCompetitorRead(payload), source: 'fallback' };
  }
}

const arr = (v) => (Array.isArray(v) ? v : []);

function deterministicCompetitorRead(payload) {
  const set = payload.advertisers || [];
  const brand = set.find((a) => a.is_brand) || set[0];
  if (!brand) return { headline: 'No monitored spend for this selection.', reasoning: '', recommendations: [], opportunities: [], threats: [], key_inputs: [], model_used: null };

  const byCost = [...set].sort((a, b) => b.cost - a.cost);
  const leader = byCost[0];
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const ptShare = (a) => pct(a.pt_cost, a.pt_cost + a.non_pt_cost);
  const vaShare = (a) => pct(a.value_addition_ads, a.ads);
  const leads = leader.name === brand.name;

  const headline = leads
    ? `${brand.name} leads the set on spend (${brand.sos}% share of spend).`
    : `${brand.name} trails ${leader.name} on spend (${brand.sos}% vs ${leader.sos}% share of spend).`;

  const reasoning = `${leader.name} holds ${leader.sos}% of monitored spend and ${leader.sov}% of voice; `
    + `it runs ${ptShare(leader)}% of its money in prime time. ${brand.name} runs ${ptShare(brand)}% in prime `
    + `and ${vaShare(brand)}% of its ads as value additions.`;

  const recs = [];
  if (!leads) {
    recs.push({ action: `Close the share-of-voice gap with ${leader.name}`, rationale: `You are ${leader.sos - brand.sos} points behind on spend; matching voice is needed to defend or grow share.` });
  }
  const primeHeavy = [...set].sort((a, b) => ptShare(b) - ptShare(a))[0];
  if (primeHeavy && ptShare(brand) < ptShare(primeHeavy)) {
    recs.push({ action: 'Review your prime-time weight', rationale: `${primeHeavy.name} puts ${ptShare(primeHeavy)}% in prime versus your ${ptShare(brand)}%; the evening peak is where the audience is.` });
  }
  const topCh = (payload.top_channels || [])[0];
  if (topCh) recs.push({ action: `Assess presence on ${topCh.name}`, rationale: `${topCh.name} is the most-bought channel in the set (LKR ${Math.round(topCh.total).toLocaleString('en-US')}).` });

  return {
    headline,
    reasoning,
    recommendations: recs,
    opportunities: topCh ? [`Concentrated competitor spend on ${topCh.name} - a shared battleground to contest or avoid.`] : [],
    threats: leads ? [] : [`${leader.name} outspends you and could raise share of voice further.`],
    key_inputs: set.map((a) => `${a.name}: ${a.sos}% SOS, ${a.sov}% SOV, ${ptShare(a)}% prime`),
    model_used: null,
  };
}

export { SYSTEM_PROMPT } from './systemPrompt.js';
