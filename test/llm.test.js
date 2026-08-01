import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson, normaliseResult, groundLineup, costPlan } from '../src/llm/schema.js';
import { SYSTEM_PROMPT } from '../src/llm/systemPrompt.js';
import { SAMPLE_AGGREGATED } from './fixtures.js';

test('parseModelJson reads a clean object', () => {
  assert.deepEqual(parseModelJson('{"confidence":"high"}'), { confidence: 'high' });
});

test('parseModelJson strips markdown fences local models add', () => {
  const out = parseModelJson('```json\n{"confidence":"medium"}\n```');
  assert.equal(out.confidence, 'medium');
});

test('parseModelJson survives a preamble and trailing commentary', () => {
  const out = parseModelJson('Here is the plan:\n{"confidence":"low"}\nHope this helps!');
  assert.equal(out.confidence, 'low');
});

test('parseModelJson is not fooled by braces inside strings', () => {
  const out = parseModelJson('{"overall_rationale":"budget is {tight} here","confidence":"low"}');
  assert.equal(out.overall_rationale, 'budget is {tight} here');
});

test('parseModelJson throws rather than returning junk', () => {
  assert.throws(() => parseModelJson('no json at all'), /no JSON object/);
  assert.throws(() => parseModelJson(''), /empty/);
});

test('normaliseResult produces the exact Section 7 shape', () => {
  const out = normaliseResult({});
  assert.deepEqual(Object.keys(out).sort(), [
    'budget_fit', 'competitor_analysis', 'confidence', 'gaps_or_caveats',
    'overall_rationale', 'recommended_lineup',
  ]);
  assert.deepEqual(out.recommended_lineup, []);
  assert.equal(out.confidence, 'low', 'an unspecified confidence is not optimistic');
});

test('normaliseResult accepts the field aliases models drift into', () => {
  const out = normaliseResult({
    lineup: [{
      channel_name: 'HIRU TV', program: 'PAATA KURULLO', dayPart: 'Evening Peak',
      day_of_week: 'Tuesday', duration_secs: '15', spot_count: '8',
      avg_rating: '21.33', estimated_cost: '145000', why: 'reach',
    }],
    rationale: 'text',
    caveats: 'gap',
    confidence: 'HIGH',
  });
  assert.equal(out.recommended_lineup.length, 1);
  assert.deepEqual(out.recommended_lineup[0], {
    channel: 'HIRU TV', programme: 'PAATA KURULLO', day: 'Tuesday', day_part: 'Evening Peak',
    spot_duration_secs: 15, spots: 8, rating: 21.33, est_cost_lkr: 145000, rationale: 'reach',
  });
  assert.equal(out.overall_rationale, 'text');
  assert.equal(out.gaps_or_caveats, 'gap');
  assert.equal(out.confidence, 'high');
});

test('normaliseResult rejects an out-of-range confidence', () => {
  assert.equal(normaliseResult({ confidence: 'very high' }).confidence, 'low');
  assert.equal(normaliseResult({ confidence: 'certain' }).confidence, 'low');
});

test('normaliseResult drops entries with neither channel nor programme', () => {
  const out = normaliseResult({ recommended_lineup: [{ rationale: 'nothing here' }, null, 'junk'] });
  assert.equal(out.recommended_lineup.length, 0);
});

test('groundLineup passes entries that exist in the supplied data', () => {
  const result = normaliseResult({
    recommended_lineup: [{ channel: 'HIRU TV', programme: 'PAATA KURULLO', rating: 21.33 }],
    confidence: 'high',
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.grounding.unmatched.length, 0);
  assert.equal(grounded.recommended_lineup[0].in_source_data, true);
  assert.equal(grounded.confidence, 'high', 'a fully grounded plan keeps its confidence');
});

test('groundLineup flags an invented programme and caps confidence', () => {
  const result = normaliseResult({
    recommended_lineup: [
      { channel: 'HIRU TV', programme: 'PAATA KURULLO' },
      { channel: 'HIRU TV', programme: 'Sunday Blockbuster' }, // not in the data
    ],
    confidence: 'high',
    gaps_or_caveats: 'Existing caveat.',
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  assert.deepEqual(grounded.grounding.unmatched, ['HIRU TV - Sunday Blockbuster']);
  assert.equal(grounded.recommended_lineup[1].in_source_data, false);
  assert.equal(grounded.confidence, 'medium', 'an ungrounded plan cannot claim high confidence');
  assert.match(grounded.gaps_or_caveats, /Existing caveat\./, 'the model\'s own caveat is kept');
  assert.match(grounded.gaps_or_caveats, /Sunday Blockbuster/);
});

test('groundLineup keeps flagged entries rather than deleting them', () => {
  const result = normaliseResult({
    recommended_lineup: [{ channel: 'Made Up TV', programme: 'Made Up Show' }],
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.recommended_lineup.length, 1, 'the planner still sees what was proposed');
  assert.equal(grounded.recommended_lineup[0].in_source_data, false);
});

test('groundLineup matches names case- and punctuation-insensitively', () => {
  const result = normaliseResult({
    recommended_lineup: [{ channel: 'hiru  tv', programme: 'paata kurullo' }],
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.grounding.unmatched.length, 0);
});

test('groundLineup skips the check when no ratings were supplied', () => {
  const result = normaliseResult({ recommended_lineup: [{ channel: 'X', programme: 'Y' }] });
  const grounded = groundLineup(result, { programme_ratings: [], channels: [] });
  assert.equal(grounded.grounding.checked, false);
});

test('the system prompt keeps the planner framing and demands strict JSON', () => {
  assert.match(SYSTEM_PROMPT, /senior media analyst and media buying professional at a Sri Lankan media agency/);
  assert.match(SYSTEM_PROMPT, /Never invent spend figures, ratings,\s*costs, channel names, or programmes/);
  assert.match(SYSTEM_PROMPT, /No text outside the JSON object\./);
  assert.match(SYSTEM_PROMPT, /"confidence": "high\|medium\|low"/);
});

test('the system prompt constrains days, durations and costs to observed data', () => {
  // The three ways a plan can look authoritative while being made up.
  assert.match(SYSTEM_PROMPT, /Recommend a day only where day-of-week or day-part data supports it/);
  assert.match(SYSTEM_PROMPT, /Use only spot durations and costs that appear in the observed cost data/);
  assert.match(SYSTEM_PROMPT, /must respect the brief's budget/);
  for (const field of ['day', 'day_part', 'spot_duration_secs', 'spots', 'est_cost_lkr']) {
    assert.ok(SYSTEM_PROMPT.includes(`"${field}"`), `output shape declares ${field}`);
  }
});

test('costPlan totals the lineup and compares it against the budget', () => {
  const lineup = [
    { est_cost_lkr: 1_160_000 },
    { est_cost_lkr: 870_000 },
    { est_cost_lkr: null },
  ];
  const budget = costPlan(lineup, 250); // 250 lakhs = LKR 25,000,000

  assert.equal(budget.total_cost_lkr, 2_030_000);
  assert.equal(budget.total_cost_lakhs, 20.3);
  assert.equal(budget.utilisation_pct, 8.1);
  assert.equal(budget.over_budget, false);
  assert.equal(budget.costed_lines, 2);
  assert.equal(budget.uncosted_lines, 1, 'a line with no observed rate is reported, not counted');
});

test('costPlan catches a plan that exceeds the budget', () => {
  const budget = costPlan([{ est_cost_lkr: 30_000_000 }], 250);
  assert.equal(budget.over_budget, true);
  assert.equal(budget.utilisation_pct, 120);
});

test('costPlan copes with a brief that states no budget', () => {
  const budget = costPlan([{ est_cost_lkr: 5000 }], null);
  assert.equal(budget.budget_lkr, null);
  assert.equal(budget.over_budget, null, 'unknown, not "fine"');
  assert.equal(budget.total_cost_lkr, 5000);
});

test('groundLineup accepts a radio line backed only by media watch', () => {
  // Radio never appears in the TV ratings panel. Without the cost feed as a
  // grounding source, every radio line would be reported as invented.
  const result = normaliseResult({
    recommended_lineup: [{
      channel: 'Neth FM', programme: 'Hathara Wate', day: 'Thursday',
      spot_duration_secs: 15, spots: 12, est_cost_lkr: 156000,
    }],
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  assert.deepEqual(grounded.grounding.unmatched, []);
  assert.equal(grounded.recommended_lineup[0].in_source_data, true);
  assert.equal(grounded.recommended_lineup[0].cost_supported, true);
});

test('groundLineup flags a cost with no observed rate behind it', () => {
  const result = normaliseResult({
    recommended_lineup: [{
      // Rated programme, but media watch never observed a spot in it.
      channel: 'DERANA TV', programme: 'SANGEETHE - SEASON 2', est_cost_lkr: 900_000,
    }],
    confidence: 'high',
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  assert.equal(grounded.recommended_lineup[0].in_source_data, true, 'the programme is real');
  assert.equal(grounded.recommended_lineup[0].cost_supported, false, 'the price is not');
  assert.deepEqual(grounded.grounding.unsupported_costs, ['DERANA TV - SANGEETHE - SEASON 2']);
  assert.equal(grounded.confidence, 'medium');
  assert.match(grounded.gaps_or_caveats, /no observed spot rate/);
});

test('groundLineup leaves an uncosted line alone', () => {
  const result = normaliseResult({
    recommended_lineup: [{ channel: 'DERANA TV', programme: 'SANGEETHE - SEASON 2', est_cost_lkr: null }],
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.recommended_lineup[0].cost_supported, null, 'no cost claimed, nothing to check');
  assert.deepEqual(grounded.grounding.unsupported_costs, []);
});
