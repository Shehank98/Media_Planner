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

test('normaliseResult produces the channel-first shape', () => {
  const out = normaliseResult({});
  assert.deepEqual(Object.keys(out).sort(), [
    'budget_fit', 'channel_plan', 'clutter_strategy', 'competitor_analysis',
    'confidence', 'gaps_or_caveats', 'overall_rationale',
  ]);
  assert.deepEqual(out.channel_plan, []);
  assert.equal(out.confidence, 'low', 'an unspecified confidence is not optimistic');
});

test('normaliseResult accepts the field aliases models drift into', () => {
  const out = normaliseResult({
    channels: [{
      channel_name: 'HIRU TV',
      programmes: [{
        program: 'PAATA KURULLO', days: 'MON - FRI', day_part: 'Evening Peak',
        duration: '20', no_of_spots: '8', avg_rating: '21.33', rate: '145000', why: 'reach',
      }],
    }],
    rationale: 'text',
    caveats: 'gap',
    confidence: 'HIGH',
  });
  assert.equal(out.channel_plan.length, 1);
  assert.deepEqual(out.channel_plan[0].programmes[0], {
    programme: 'PAATA KURULLO', day_pattern: 'MON - FRI', time_band: 'Evening Peak',
    time_start: '', time_end: '', duration_secs: 20, spots: 8, tvr: 21.33,
    rate_lkr: 145000, cost_lkr: null, rationale: 'reach',
  });
  assert.equal(out.overall_rationale, 'text');
  assert.equal(out.confidence, 'high');
});

test('normaliseResult regroups a flat lineup by channel', () => {
  // A model that reverts to the old flat shape still produces a usable plan
  // rather than an empty one.
  const out = normaliseResult({
    recommended_lineup: [
      { channel: 'HIRU TV', programme: 'PAATA KURULLO', spots: 4 },
      { channel: 'HIRU TV', programme: 'HIRU NEWS 6:55 PM', spots: 6 },
      { channel: 'DERANA TV', programme: 'ISKOLE', spots: 3 },
    ],
  });
  assert.equal(out.channel_plan.length, 2, 'grouped into two channels');
  assert.equal(out.channel_plan[0].programmes.length, 2);
});

test('normaliseResult rejects an out-of-range confidence', () => {
  assert.equal(normaliseResult({ confidence: 'very high' }).confidence, 'low');
  assert.equal(normaliseResult({ confidence: 'certain' }).confidence, 'low');
});

test('normaliseResult drops channels with no usable programmes', () => {
  const out = normaliseResult({
    channel_plan: [{ channel: 'HIRU TV', programmes: [{ rationale: 'no name' }] }, null, 'junk'],
  });
  assert.equal(out.channel_plan.length, 0);
});

/** Build a channel-first result for the grounding tests. */
function planOf(channel, programmes, extra = {}) {
  return normaliseResult({
    channel_plan: [{ channel, programmes }],
    ...extra,
  });
}

test('groundLineup passes entries that exist in the supplied data', () => {
  const result = planOf('HIRU TV', [{ programme: 'PAATA KURULLO', tvr: 21.33 }], { confidence: 'high' });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.grounding.unmatched.length, 0);
  assert.equal(grounded.channel_plan[0].programmes[0].in_source_data, true);
  assert.equal(grounded.confidence, 'high', 'a fully grounded plan keeps its confidence');
});

test('groundLineup flags an invented programme and caps confidence', () => {
  const result = planOf('HIRU TV', [
    { programme: 'PAATA KURULLO' },
    { programme: 'Sunday Blockbuster' }, // not in the data
  ], { confidence: 'high', gaps_or_caveats: 'Existing caveat.' });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  assert.deepEqual(grounded.grounding.unmatched, ['HIRU TV - Sunday Blockbuster']);
  assert.equal(grounded.channel_plan[0].programmes[1].in_source_data, false);
  assert.equal(grounded.confidence, 'medium', 'an ungrounded plan cannot claim high confidence');
  assert.match(grounded.gaps_or_caveats, /Existing caveat\./, 'the model\'s own caveat is kept');
  assert.match(grounded.gaps_or_caveats, /Sunday Blockbuster/);
});

test('groundLineup keeps flagged entries rather than deleting them', () => {
  const result = planOf('Made Up TV', [{ programme: 'Made Up Show' }]);
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.channel_plan[0].programmes.length, 1,
    'the planner still sees what was proposed');
  assert.equal(grounded.channel_plan[0].programmes[0].in_source_data, false);
});

test('groundLineup matches names case- and punctuation-insensitively', () => {
  const result = planOf('hiru  tv', [{ programme: 'paata kurullo' }]);
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.grounding.unmatched.length, 0);
});

test('groundLineup skips the check when no ratings were supplied', () => {
  const result = planOf('X', [{ programme: 'Y' }]);
  const grounded = groundLineup(result, { programme_ratings: [], channels: [] });
  assert.equal(grounded.grounding.checked, false);
});

test('the system prompt keeps the planner framing and demands strict JSON', () => {
  assert.match(SYSTEM_PROMPT, /senior media analyst and media buying professional at a Sri Lankan media agency/);
  assert.match(SYSTEM_PROMPT, /Never invent ratings, costs,\s*channel names, or programmes/);
  assert.match(SYSTEM_PROMPT, /No text outside the JSON object\./);
  assert.match(SYSTEM_PROMPT, /"confidence": "high\|medium\|low"/);
});

test('the system prompt carries the Sri Lanka market context and doctrine', () => {
  // The 2024/25 landscape knowledge must travel with the prompt so every plan
  // reasons with it, without loosening grounding.
  assert.match(SYSTEM_PROMPT, /MARKET CONTEXT & PLANNING DOCTRINE/);
  assert.match(SYSTEM_PROMPT, /DUOPOLY/);
  assert.match(SYSTEM_PROMPT, /weekdays and weekends/);
  assert.match(SYSTEM_PROMPT, /Derana indexes urban/);
  // It reasserts, not relaxes, grounding.
  assert.match(SYSTEM_PROMPT, /only channels, programmes and costs present in the supplied data|only those present in the supplied data/);
});

test('the system prompt asks for channels before programmes', () => {
  assert.match(SYSTEM_PROMPT, /choose the CHANNELS first/);
  assert.match(SYSTEM_PROMPT, /smallest number of channels/);
  for (const field of ['channel_plan', 'programmes', 'day_pattern', 'duration_secs', 'spots']) {
    assert.ok(SYSTEM_PROMPT.includes(`"${field}"`), `output shape declares ${field}`);
  }
});

test('the system prompt states the clutter rule in numbers', () => {
  // The rule the user cares about most: not stacking the buy into one belt.
  assert.match(SYSTEM_PROMPT, /CLUTTER: do not stack the buy into one time belt/);
  assert.match(SYSTEM_PROMPT, /more than about 40% of total spots/);
  assert.match(SYSTEM_PROMPT, /more than three channels/);
  assert.ok(SYSTEM_PROMPT.includes('"clutter_strategy"'));
});

test('the system prompt does not ask the model to place spots on dates', () => {
  // Dated placement is arithmetic over a calendar and is done in schedule.js;
  // asking for it produces dropped days and spots outside the flight.
  assert.match(SYSTEM_PROMPT, /Do not output a date-by-date schedule/);
});

test('the system prompt restricts commercial lengths to the brief', () => {
  assert.match(SYSTEM_PROMPT, /Only use commercial lengths listed in the brief/);
});

test('costPlan compares the schedule total against the budget', () => {
  const budget = costPlan(
    { total_cost_lkr: 2_030_000, total_spots: 34, costed_spots: 20, uncosted_spots: 14 },
    250, // lakhs = LKR 25,000,000
  );
  assert.equal(budget.total_cost_lakhs, 20.3);
  assert.equal(budget.utilisation_pct, 8.1);
  assert.equal(budget.over_budget, false);
  assert.equal(budget.uncosted_spots, 14, 'spots with no rate are reported, not counted');
});

test('costPlan catches a plan that exceeds the budget', () => {
  const budget = costPlan({ total_cost_lkr: 30_000_000 }, 250);
  assert.equal(budget.over_budget, true);
  assert.equal(budget.utilisation_pct, 120);
});

test('costPlan copes with a brief that states no budget', () => {
  const budget = costPlan({ total_cost_lkr: 5000 }, null);
  assert.equal(budget.budget_lkr, null);
  assert.equal(budget.over_budget, null, 'unknown, not "fine"');
  assert.equal(budget.total_cost_lkr, 5000);
});

test('groundLineup accepts a radio line backed only by media watch', () => {
  // Radio never appears in the TV ratings panel. Without the cost feed as a
  // grounding source, every radio line would be reported as invented.
  const result = planOf('Neth FM', [{
    programme: 'Hathara Wate', day_pattern: 'THU', duration_secs: 15, spots: 12, rate_lkr: 13000,
  }]);
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  assert.deepEqual(grounded.grounding.unmatched, []);
  assert.equal(grounded.channel_plan[0].programmes[0].in_source_data, true);
  assert.equal(grounded.channel_plan[0].programmes[0].rate_supported, true);
});

test('groundLineup flags a rate with no observation behind it', () => {
  // Rated programme, but media watch never observed a spot in it.
  const result = planOf('DERANA TV',
    [{ programme: 'SANGEETHE - SEASON 2', rate_lkr: 900_000 }], { confidence: 'high' });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  const p = grounded.channel_plan[0].programmes[0];
  assert.equal(p.in_source_data, true, 'the programme is real');
  assert.equal(p.rate_supported, false, 'the price is not');
  assert.deepEqual(grounded.grounding.unsupported_rates, ['DERANA TV - SANGEETHE - SEASON 2']);
  assert.equal(grounded.confidence, 'medium');
  assert.match(grounded.gaps_or_caveats, /no observed spot cost/);
});

test('groundLineup leaves an unrated line alone', () => {
  const result = planOf('DERANA TV', [{ programme: 'SANGEETHE - SEASON 2', rate_lkr: null }]);
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.channel_plan[0].programmes[0].rate_supported, null,
    'no rate claimed, nothing to check');
  assert.deepEqual(grounded.grounding.unsupported_rates, []);
});
