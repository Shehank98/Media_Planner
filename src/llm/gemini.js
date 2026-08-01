import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { parseModelJson } from './schema.js';

// Phase 1 provider. response_mime_type=application/json makes Gemini return a
// bare JSON object, so no fence stripping is needed here - parseModelJson still
// runs for safety but should be a straight JSON.parse.

let client = null;

function getClient() {
  if (!config.llm.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not set (required when LLM_PROVIDER=gemini)');
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

  const response = await ai.models.generateContent({
    model: config.llm.gemini.model,
    contents: JSON.stringify({ brief, data: aggregatedData }),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      // Analytical task, not creative writing - keep it near-deterministic.
      temperature: config.llm.gemini.temperature,
    },
  });

  const text = response.text;
  const usage = response.usageMetadata || {};
  const elapsedMs = Date.now() - started;
  const outputTokens = usage.candidatesTokenCount ?? null;

  return {
    raw: parseModelJson(text),
    meta: {
      provider: 'gemini',
      model: config.llm.gemini.model,
      model_used: modelId(),
      elapsed_ms: elapsedMs,
      prompt_tokens: usage.promptTokenCount ?? null,
      output_tokens: outputTokens,
      total_tokens: usage.totalTokenCount ?? null,
      tokens_per_sec: outputTokens ? +(outputTokens / (elapsedMs / 1000)).toFixed(1) : null,
    },
  };
}
