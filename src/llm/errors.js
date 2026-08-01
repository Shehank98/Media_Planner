// ---------------------------------------------------------------------------
// Turn an LLM provider failure into something a planner can act on.
//
// The raw failures are unhelpful in different ways: Gemini returns a nested
// JSON blob as the message, Ollama returns a bare connection error, and an
// empty-but-successful response throws from the JSON parser with no clue that
// the model never produced text. All three land on the user as "500".
// ---------------------------------------------------------------------------

export class LlmError extends Error {
  constructor(message, { hint = null, status = 502, provider = null, cause = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.hint = hint;
    this.status = status;
    this.provider = provider;
    this.dependency = 'llm';
    if (cause) this.cause = cause;
  }
}

/** Gemini nests the real message inside a JSON string. Dig it out. */
function unwrapGeminiMessage(raw) {
  const text = String(raw || '');
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || text;
  } catch {
    // Sometimes the JSON is embedded in a longer string.
    const m = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\"/g, '"') : text;
  }
}

export function describeLlmError(err, provider) {
  if (err instanceof LlmError) return err;

  const raw = String(err?.message || err || '');
  const message = provider === 'gemini' ? unwrapGeminiMessage(raw) : raw;
  const status = err?.status ?? err?.code;

  if (/API key not valid|API_KEY_INVALID/i.test(message)) {
    return new LlmError('The Gemini API key was rejected.', {
      hint: 'Check GEMINI_API_KEY in the service variables. Keys are issued at '
        + 'aistudio.google.com/apikey and are project-specific.',
      status: 502, provider, cause: err,
    });
  }

  if (/PERMISSION_DENIED|SERVICE_DISABLED|has not been used in project/i.test(message)) {
    return new LlmError('Gemini refused the request for this project.', {
      hint: 'Enable the Generative Language API for the key\'s project in the Google Cloud '
        + 'console, then retry.',
      status: 502, provider, cause: err,
    });
  }

  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
    return new LlmError('Gemini rejected the request for exceeding its quota.', {
      hint: 'The free tier has per-minute and per-day caps. Wait and retry, or move the key '
        + 'to a billed project.',
      status: 429, provider, cause: err,
    });
  }

  if (/not found|NOT_FOUND|is not supported|unknown model/i.test(message)) {
    return new LlmError(`The configured model is not available: ${message}`, {
      hint: 'Check GEMINI_MODEL (default gemini-2.5-flash) or OLLAMA_MODEL.',
      status: 502, provider, cause: err,
    });
  }

  if (/Could not reach Ollama|ECONNREFUSED|fetch failed/i.test(message)) {
    return new LlmError(`Could not reach the Ollama server: ${message}`, {
      hint: 'Check OLLAMA_BASE_URL and that the Cloudflare Tunnel is up. Switch '
        + 'LLM_PROVIDER=gemini to fall back to the hosted model.',
      status: 503, provider, cause: err,
    });
  }

  if (/did not respond within|timed out|AbortError/i.test(message)) {
    return new LlmError(message, {
      hint: 'CPU-only inference is slow. Raise OLLAMA_TIMEOUT_MS, or use a smaller model.',
      status: 504, provider, cause: err,
    });
  }

  return new LlmError(`The model call failed: ${message}`, {
    hint: null, status: 502, provider, cause: err,
  });
}

/**
 * Explain a response that succeeded at the HTTP level but carried no usable
 * text.
 *
 * This is the failure that looks most like a bug in our code, because the
 * parser throws rather than the API. On gemini-2.5-* it is usually thinking
 * tokens consuming the whole output budget - the call "worked", the candidate
 * is empty, and the only clue is finishReason.
 */
export function describeEmptyResponse(response, provider, model) {
  const candidate = response?.candidates?.[0];
  const finish = candidate?.finishReason;
  const blockReason = response?.promptFeedback?.blockReason;

  if (blockReason) {
    return new LlmError(`${model} refused the request (${blockReason}).`, {
      hint: 'The prompt tripped a safety filter. This is usually a brand or programme name '
        + 'being misread; check the brief text.',
      status: 502, provider,
    });
  }

  if (finish === 'MAX_TOKENS') {
    return new LlmError(
      `${model} hit its output limit before producing any JSON.`,
      {
        hint: 'On gemini-2.5 models the thinking budget is spent from the same allowance. '
          + 'Raise GEMINI_MAX_OUTPUT_TOKENS, or set GEMINI_THINKING_BUDGET=0 to turn thinking off.',
        status: 502, provider,
      },
    );
  }

  if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'PROHIBITED_CONTENT') {
    return new LlmError(`${model} stopped generating (${finish}).`, {
      hint: 'The response was filtered. Retry; if it persists, the brief text is the likely trigger.',
      status: 502, provider,
    });
  }

  return new LlmError(
    `${model} returned an empty response${finish ? ` (finishReason: ${finish})` : ''}.`,
    {
      hint: 'Retry. If it repeats, reduce the amount of data sent by lowering the programme '
        + 'shortlist size.',
      status: 502, provider,
    },
  );
}
