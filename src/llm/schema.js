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
    .map((item) => ({
      channel: text(item.channel ?? item.channel_name),
      programme: text(item.programme ?? item.programme_name ?? item.program),
      day_part: text(item.day_part ?? item.dayPart ?? item.daypart),
      grp: numberOrNull(item.grp ?? item.GRP ?? item.trp) ?? 0,
      rationale: text(item.rationale ?? item.why ?? item.reason),
    }))
    .filter((item) => item.channel || item.programme);

  const confidenceRaw = text(obj.confidence).toLowerCase();
  const confidence = CONFIDENCE.has(confidenceRaw) ? confidenceRaw : 'low';

  return {
    recommended_lineup,
    overall_rationale: text(obj.overall_rationale ?? obj.rationale ?? obj.summary),
    competitor_analysis: text(obj.competitor_analysis ?? obj.competitors),
    confidence,
    gaps_or_caveats: text(obj.gaps_or_caveats ?? obj.caveats ?? obj.gaps),
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
  const programmes = aggregatedData?.programme_ratings || [];
  const knownProgrammes = new Set();
  const knownChannels = new Set();
  for (const p of programmes) {
    if (p.programme_name) knownProgrammes.add(comparisonKey(p.programme_name));
    if (p.channel_name) knownChannels.add(comparisonKey(p.channel_name));
  }
  // Channels can legitimately come from the channel master list even when no
  // programme for them cleared the audience filter.
  for (const c of aggregatedData?.channels || []) {
    if (c.channel_name) knownChannels.add(comparisonKey(c.channel_name));
  }

  // With no rating data at all there's nothing to check against; the model
  // should already be saying so in gaps_or_caveats.
  if (!knownProgrammes.size && !knownChannels.size) {
    return { ...result, grounding: { checked: false, reason: 'no rating data supplied' } };
  }

  const unmatched = [];
  const lineup = result.recommended_lineup.map((item) => {
    const channelOk = !item.channel || knownChannels.has(comparisonKey(item.channel));
    const programmeOk = !item.programme || knownProgrammes.has(comparisonKey(item.programme));
    if (channelOk && programmeOk) return { ...item, in_source_data: true };

    unmatched.push(
      [item.channel, item.programme].filter(Boolean).join(' - ') || '(unnamed entry)',
    );
    return { ...item, in_source_data: false };
  });

  if (!unmatched.length) {
    return {
      ...result,
      recommended_lineup: lineup,
      grounding: { checked: true, unmatched: [] },
    };
  }

  const note =
    `Automated check: ${unmatched.length} recommended entry/entries could not be matched ` +
    `to the supplied rating data (${unmatched.join('; ')}). Verify these against the source ` +
    'before issuing the plan.';

  return {
    ...result,
    recommended_lineup: lineup,
    // Never let an ungrounded plan claim high confidence.
    confidence: result.confidence === 'high' ? 'medium' : result.confidence,
    gaps_or_caveats: [result.gaps_or_caveats, note].filter(Boolean).join('\n\n'),
    grounding: { checked: true, unmatched },
  };
}
