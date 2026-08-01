import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Minimal .env loader so local dev doesn't need dotenv. Railway injects real
// environment variables, so this is a no-op there.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // real env always wins
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv();

const bool = (v, fallback) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);
const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const num = (v, fallback) => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int(process.env.PORT, 3000),
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,

  db: {
    url: process.env.DATABASE_URL,
    // Railway's Postgres presents a self-signed cert; verification off, TLS on.
    ssl: bool(process.env.PGSSL, false) ? { rejectUnauthorized: false } : false,
  },

  llm: {
    provider: (process.env.LLM_PROVIDER || 'gemini').toLowerCase(),
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      temperature: num(process.env.GEMINI_TEMPERATURE, 0.3),
    },
    ollama: {
      baseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      model: process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M',
      numCtx: int(process.env.OLLAMA_NUM_CTX, 8192),
      temperature: num(process.env.OLLAMA_TEMPERATURE, 0.3),
      timeoutMs: int(process.env.OLLAMA_TIMEOUT_MS, 600_000),
    },
  },

  drive: {
    folderId: process.env.GDRIVE_FOLDER_ID,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    credentialsJson: process.env.GDRIVE_SERVICE_ACCOUNT_JSON,
    cron: process.env.SYNC_CRON || '0 */4 * * *',
    enabled: bool(process.env.SYNC_ENABLED, true),
  },

  report: {
    pythonBin: process.env.PYTHON_BIN || 'python3',
    timeoutMs: int(process.env.REPORT_TIMEOUT_MS, 120_000),
    workDir: path.join(ROOT, 'tmp'),
  },
};

export function assertConfigured() {
  const problems = [];
  if (!config.db.url) problems.push('DATABASE_URL is not set');
  if (config.llm.provider === 'gemini' && !config.llm.gemini.apiKey) {
    problems.push('LLM_PROVIDER=gemini but GEMINI_API_KEY is not set');
  }
  if (!['gemini', 'ollama'].includes(config.llm.provider)) {
    problems.push(`LLM_PROVIDER must be "gemini" or "ollama", got "${config.llm.provider}"`);
  }
  return problems;
}
