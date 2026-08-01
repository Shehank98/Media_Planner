import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson, normaliseResult, groundLineup } from '../src/llm/schema.js';
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
    'competitor_analysis', 'confidence', 'gaps_or_caveats',
    'overall_rationale', 'recommended_lineup',
  ]);
  assert.deepEqual(out.recommended_lineup, []);
  assert.equal(out.confidence, 'low', 'an unspecified confidence is not optimistic');
});

test('normaliseResult accepts the field aliases models drift into', () => {
  const out = normaliseResult({
    lineup: [{ channel_name: 'TV Derana', program: 'Derana News', dayPart: 'Prime', GRP: '12.5', why: 'reach' }],
    rationale: 'text',
    caveats: 'gap',
    confidence: 'HIGH',
  });
  assert.equal(out.recommended_lineup.length, 1);
  assert.deepEqual(out.recommended_lineup[0], {
    channel: 'TV Derana', programme: 'Derana News', day_part: 'Prime', grp: 12.5, rationale: 'reach',
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
    recommended_lineup: [{ channel: 'TV Derana', programme: 'Derana News', grp: 12.5 }],
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
      { channel: 'TV Derana', programme: 'Derana News' },
      { channel: 'TV Derana', programme: 'Sunday Blockbuster' }, // not in the data
    ],
    confidence: 'high',
    gaps_or_caveats: 'Existing caveat.',
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);

  assert.deepEqual(grounded.grounding.unmatched, ['TV Derana - Sunday Blockbuster']);
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
    recommended_lineup: [{ channel: 'tv  derana', programme: 'DERANA NEWS' }],
  });
  const grounded = groundLineup(result, SAMPLE_AGGREGATED);
  assert.equal(grounded.grounding.unmatched.length, 0);
});

test('groundLineup skips the check when no ratings were supplied', () => {
  const result = normaliseResult({ recommended_lineup: [{ channel: 'X', programme: 'Y' }] });
  const grounded = groundLineup(result, { programme_ratings: [], channels: [] });
  assert.equal(grounded.grounding.checked, false);
});

test('the system prompt is the spec text and demands strict JSON', () => {
  assert.match(SYSTEM_PROMPT, /senior media analyst and media buying professional at a Sri Lankan media agency/);
  assert.match(SYSTEM_PROMPT, /Never invent spend figures, GRPs/);
  assert.match(SYSTEM_PROMPT, /No text outside the JSON object\./);
  assert.match(SYSTEM_PROMPT, /"confidence": "high\|medium\|low"/);
});
