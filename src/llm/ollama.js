import { config } from '../config.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { parseModelJson } from './schema.js';

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
      throw new Error(
        `Ollama did not respond within ${timeoutMs}ms at ${baseUrl}. ` +
        'On CPU-only hardware, either raise OLLAMA_TIMEOUT_MS or move to a smaller model.',
      );
    }
    throw new Error(`Could not reach Ollama at ${baseUrl}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  const elapsedMs = Date.now() - started;

  // Ollama reports timings in nanoseconds. eval_count is the generated token
  // count, so this is the real tokens/sec for the benchmark in Section 8.
  const outputTokens = payload.eval_count ?? null;
  const evalNs = payload.eval_duration ?? null;
  const tokensPerSec =
    outputTokens && evalNs ? +(outputTokens / (evalNs / 1e9)).toFixed(1) : null;

  return {
    raw: parseModelJson(payload.message?.content),
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
