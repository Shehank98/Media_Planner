import { config } from '../config.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { parseModelJson } from './schema.js';
import { LlmError } from './errors.js';

// Phase 2 provider. Same system prompt, same input, same output shape as the
// Gemini adapter - switching is LLM_PROVIDER=ollama and nothing else.
//
// Reached from Railway over a Cloudflare Tunnel, so the timeout is generous:
// a 7B model on CPU can take minutes for a report-sized response.

export const name = 'ollama';

export function modelId() {
  return `ollama:${config.llm.ollama.model}`;
}

export async function analyze(brief, aggregatedData) {
  const { baseUrl, model, numCtx, temperature, timeoutMs } = config.llm.ollama;
  const started = Date.now();

  // AbortSignal.timeout would leave the request-level error message opaque;
  // an explicit controller lets us say what actually happened.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        // Ollama's JSON mode constrains sampling to valid JSON.
        format: 'json',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ brief, data: aggregatedData }) },
        ],
        options: {
          temperature,
          // Section 8: keep the context modest - the payload is pre-aggregated,
          // never raw rows, so this is ample and keeps CPU inference tractable.
          num_ctx: numCtx,
        },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LlmError(`Ollama did not respond within ${timeoutMs}ms at ${baseUrl}.`, {
        hint: 'CPU-only inference is slow. Raise OLLAMA_TIMEOUT_MS, or move to a smaller model '
          + '(llama3.2:3b-instruct).',
        status: 504, provider: 'ollama', cause: err,
      });
    }
    throw new LlmError(`Could not reach Ollama at ${baseUrl}: ${err.message}`, {
      hint: 'Check OLLAMA_BASE_URL and that the Cloudflare Tunnel is up. Switch '
        + 'LLM_PROVIDER=gemini to fall back to the hosted model.',
      status: 503, provider: 'ollama', cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmError(`Ollama returned ${response.status}: ${body.slice(0, 300)}`, {
      hint: response.status === 404
        ? `The model "${model}" is not pulled. Run: ollama pull ${model}`
        : null,
      status: 502, provider: 'ollama',
    });
  }

  const payload = await response.json();
  const elapsedMs = Date.now() - started;

  // Ollama reports timings in nanoseconds. eval_count is the generated token
  // count, so this is the real tokens/sec for the benchmark in Section 8.
  const outputTokens = payload.eval_count ?? null;
  const evalNs = payload.eval_duration ?? null;
  const tokensPerSec =
    outputTokens && evalNs ? +(outputTokens / (evalNs / 1e9)).toFixed(1) : null;

  const content = payload.message?.content;
  if (!content || !String(content).trim()) {
    throw new LlmError(`${model} returned an empty response.`, {
      hint: 'Retry. If it repeats, the context may be too small for the payload - raise '
        + 'OLLAMA_NUM_CTX or lower the programme shortlist size.',
      status: 502, provider: 'ollama',
    });
  }

  return {
    raw: parseModelJson(content),
    meta: {
      provider: 'ollama',
      model,
      model_used: modelId(),
      elapsed_ms: elapsedMs,
      prompt_tokens: payload.prompt_eval_count ?? null,
      output_tokens: outputTokens,
      total_tokens:
        (payload.prompt_eval_count ?? 0) + (outputTokens ?? 0) || null,
      tokens_per_sec: tokensPerSec,
      load_ms: payload.load_duration ? Math.round(payload.load_duration / 1e6) : null,
    },
  };
}

/**
 * A focused JSON completion with a caller-supplied instruction, mirroring the
 * Gemini adapter so the explorer's explain step is provider-agnostic.
 */
export async function complete({ system, user }) {
  const { baseUrl, model, numCtx, temperature, timeoutMs } = config.llm.ollama;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
        ],
        options: { temperature, num_ctx: numCtx },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LlmError(`Ollama did not respond within ${timeoutMs}ms at ${baseUrl}.`, {
        hint: 'CPU-only inference is slow. Raise OLLAMA_TIMEOUT_MS.', status: 504, provider: 'ollama', cause: err,
      });
    }
    throw new LlmError(`Could not reach Ollama at ${baseUrl}: ${err.message}`, {
      status: 503, provider: 'ollama', cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmError(`Ollama returned ${response.status}: ${body.slice(0, 300)}`, {
      status: 502, provider: 'ollama',
    });
  }

  const payload = await response.json();
  const content = payload.message?.content;
  if (!content || !String(content).trim()) {
    throw new LlmError(`${model} returned an empty response.`, { status: 502, provider: 'ollama' });
  }
  return { raw: parseModelJson(content), meta: { model_used: modelId(), elapsed_ms: Date.now() - started } };
}

/** Confirm the tunnel is up and the configured model is actually pulled. */
export async function healthCheck() {
  const { baseUrl, model } = config.llm.ollama;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    const models = (body.models || []).map((m) => m.name);
    return {
      ok: true,
      models,
      // Ollama appends ":latest" when a tag is omitted.
      configuredModelPresent: models.some((m) => m === model || m.split(':')[0] === model.split(':')[0]),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
