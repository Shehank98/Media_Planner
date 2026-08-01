import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDbError, isDbError } from '../src/util/dbError.js';
import { describeLlmError, describeEmptyResponse, LlmError } from '../src/llm/errors.js';

// Every case here is a real deploy failure that previously surfaced as a bare
// 500 or 503 with no indication of what to change.

test('a missing DATABASE_URL is named outright', () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const d = describeDbError(new Error('whatever'));
    assert.match(d.message, /DATABASE_URL is not set/);
    assert.match(d.hint, /Railway/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('database failures map to a cause and a remedy', () => {
  process.env.DATABASE_URL ||= 'postgres://u:p@h:5432/d';

  const refused = describeDbError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }));
  assert.match(refused.message, /Nothing is listening/);
  assert.match(refused.hint, /localhost inside a container/);

  const tls = describeDbError(new Error('self signed certificate in certificate chain'));
  assert.match(tls.hint, /PGSSL=true/, 'the Railway TLS trap is called out by name');

  const auth = describeDbError(Object.assign(new Error('nope'), { code: '28P01' }));
  assert.match(auth.message, /rejected the credentials/);

  const noTable = describeDbError(Object.assign(new Error('relation "adex_data" does not exist'), { code: '42P01' }));
  assert.match(noTable.hint, /npm run migrate/);
  assert.equal(noTable.fatal, false, 'a missing schema is fixable without redeploying');
});

test('isDbError distinguishes database faults from ordinary errors', () => {
  assert.equal(isDbError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isDbError(Object.assign(new Error('x'), { code: '42P01' })), true);
  assert.equal(isDbError(new Error('a normal bug')), false);
  assert.equal(isDbError(null), false);
});

test('Gemini errors are unwrapped from their JSON envelope', () => {
  // The SDK hands back the whole error document as the message, which is what
  // used to reach the browser verbatim.
  const raw = new Error(JSON.stringify({
    error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
  }));
  const d = describeLlmError(raw, 'gemini');
  assert.match(d.message, /API key was rejected/);
  assert.match(d.hint, /GEMINI_API_KEY/);
  assert.equal(d.status, 502);
  assert.equal(d.dependency, 'llm');
});

test('quota exhaustion is reported as such, not as a generic failure', () => {
  const d = describeLlmError(Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }), 'gemini');
  assert.equal(d.status, 429);
  assert.match(d.hint, /free tier/i);
});

test('an unreachable Ollama suggests the fallback', () => {
  const d = describeLlmError(new Error('Could not reach Ollama at http://x: fetch failed'), 'ollama');
  assert.equal(d.status, 503);
  assert.match(d.hint, /LLM_PROVIDER=gemini/);
});

test('an already-described error passes through unchanged', () => {
  const original = new LlmError('specific thing', { hint: 'do this', status: 504 });
  assert.equal(describeLlmError(original, 'gemini'), original);
});

test('an empty response blames the token budget, not the JSON parser', () => {
  // gemini-2.5-* spends thinking tokens from the output allowance, so the call
  // succeeds and the candidate is empty. Without this the failure surfaced as
  // "model returned no text" from the parser.
  const d = describeEmptyResponse(
    { candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'gemini', 'gemini-2.5-flash',
  );
  assert.match(d.message, /hit its output limit/);
  assert.match(d.hint, /GEMINI_THINKING_BUDGET=0/);
});

test('a blocked prompt is distinguished from a truncated one', () => {
  const d = describeEmptyResponse(
    { promptFeedback: { blockReason: 'SAFETY' } }, 'gemini', 'gemini-2.5-flash',
  );
  assert.match(d.message, /refused the request \(SAFETY\)/);
  assert.ok(!/output limit/.test(d.message));
});
