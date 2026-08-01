import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { parseModelJson } from './schema.js';
import { LlmError, describeLlmError, describeEmptyResponse } from './errors.js';

// Phase 1 provider. response_mime_type=application/json makes Gemini return a
// bare JSON object, so no fence stripping is needed here - parseModelJson still
// runs for safety but should be a straight JSON.parse.

let client = null;

function getClient() {
  if (!config.llm.gemini.apiKey) {
    throw new LlmError('GEMINI_API_KEY is not set.', {
      hint: 'Set it in the service variables (LLM_PROVIDER=gemini requires it), or switch '
        + 'LLM_PROVIDER=ollama.',
      status: 503,
      provider: 'gemini',
    });
  }
  client ??= new GoogleGenAI({ apiKey: config.llm.gemini.apiKey });
  return client;
}

export const name = 'gemini';

export function modelId() {
  return `gemini:${config.llm.gemini.model}`;
}

export async function analyze(brief, aggregatedData) {
  const ai = getClient();
  const started = Date.now();
  const model = config.llm.gemini.model;

  const generationConfig = {
    systemInstruction: SYSTEM_PROMPT,
    responseMimeType: 'application/json',
    // Analytical task, not creative writing - keep it near-deterministic.
    temperature: config.llm.gemini.temperature,
    // A full lineup with rationales is long. Left at the default this response
    // gets truncated mid-JSON, which surfaces as a parse error rather than as
    // the truncation it is.
    maxOutputTokens: config.llm.gemini.maxOutputTokens,
  };

  // On gemini-2.5-* the thinking budget is spent from the same output
  // allowance as the answer, so a model left to think freely can return a
  // candidate with no text at all. Default is thinking off: this task is
  // structured extraction over pre-aggregated numbers, not open reasoning.
  if (config.llm.gemini.thinkingBudget !== null) {
    generationConfig.thinkingConfig = { thinkingBudget: config.llm.gemini.thinkingBudget };
  }

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: JSON.stringify({ brief, data: aggregatedData }),
      config: generationConfig,
    });
  } catch (err) {
    throw describeLlmError(err, 'gemini');
  }

  const text = response?.text;
  // A successful call with no text is the failure most likely to be mistaken
  // for a bug in the parser, so it is diagnosed here where finishReason and
  // promptFeedback are still available.
  if (!text || !String(text).trim()) {
    throw describeEmptyResponse(response, 'gemini', model);
  }

  const usage = response.usageMetadata || {};
  const elapsedMs = Date.now() - started;
  const outputTokens = usage.candidatesTokenCount ?? null;

  let raw;
  try {
    raw = parseModelJson(text);
  } catch (err) {
    throw new LlmError(`${model} did not return valid JSON: ${err.message}`, {
      hint: response?.candidates?.[0]?.finishReason === 'MAX_TOKENS'
        ? 'The response was cut off at the token limit. Raise GEMINI_MAX_OUTPUT_TOKENS.'
        : 'Retry; if it persists, the payload may be too large for the model.',
      status: 502,
      provider: 'gemini',
      cause: err,
    });
  }

  return {
    raw,
    meta: {
      provider: 'gemini',
      model,
      model_used: modelId(),
      elapsed_ms: elapsedMs,
      prompt_tokens: usage.promptTokenCount ?? null,
      output_tokens: outputTokens,
      thinking_tokens: usage.thoughtsTokenCount ?? null,
      total_tokens: usage.totalTokenCount ?? null,
      tokens_per_sec: outputTokens ? +(outputTokens / (elapsedMs / 1000)).toFixed(1) : null,
      finish_reason: response?.candidates?.[0]?.finishReason ?? null,
    },
  };
}
