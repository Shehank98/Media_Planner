import express from 'express';
import multer from 'multer';
import { config, assertConfigured } from './config.js';
import { log } from './util/logger.js';
import { migrate, pool, close } from './db.js';
import { startScheduler, stopScheduler } from './sync/scheduler.js';
import { asyncRoute } from './util/asyncRoute.js';
import { getAdapter } from './llm/index.js';
import { healthCheck as ollamaHealth } from './llm/ollama.js';
import { reportWorkerHealth } from './services/reportService.js';
import { adexFacets } from './services/adexRepo.js';
import { tvFacets } from './services/tvRepo.js';

import { router as syncRouter } from './routes/sync.js';
import { router as uploadsRouter } from './routes/uploads.js';
import { router as briefsRouter } from './routes/briefs.js';
import { router as plansRouter } from './routes/plans.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    log.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

// --- health ----------------------------------------------------------------

app.get('/health', asyncRoute(async (_req, res) => {
  const checks = { db: { ok: false }, llm: { provider: config.llm.provider } };
  try {
    await pool.query('SELECT 1');
    checks.db = { ok: true };
  } catch (err) {
    checks.db = { ok: false, error: err.message };
  }

  try {
    checks.llm.model = getAdapter().modelId();
    checks.llm.configured = config.llm.provider !== 'gemini' || Boolean(config.llm.gemini.apiKey);
  } catch (err) {
    checks.llm.error = err.message;
  }
  // Only probe Ollama when it's the active provider - the tunnel may be down
  // during Phase 1 and that isn't a failure.
  if (config.llm.provider === 'ollama') checks.llm.reachable = await ollamaHealth();

  checks.report_worker = await reportWorkerHealth();
  checks.drive_sync = {
    enabled: config.drive.enabled,
    folder_configured: Boolean(config.drive.folderId),
    cron: config.drive.cron,
  };

  const ok = checks.db.ok;
  res.status(ok ? 200 : 503).json({ ok, ...checks });
}));

/** Everything the in-app filter controls need in one call. */
app.get('/api/facets', asyncRoute(async (_req, res) => {
  const [adex, tv] = await Promise.all([adexFacets(), tvFacets(pool)]);
  res.json({ adex, tv });
}));

// --- api -------------------------------------------------------------------

app.use('/api/sync', syncRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/briefs', briefsRouter);
app.use('/api/plans', plansRouter);

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// --- errors ----------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large. The limit is ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB.`
      : err.message;
    return res.status(400).json({ error: message, code: err.code });
  }
  const status = err.status || 500;
  if (status >= 500) log.error('unhandled request error', { err });
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// --- boot ------------------------------------------------------------------

const problems = assertConfigured();
for (const problem of problems) log.warn('configuration problem', { problem });

try {
  await migrate();
} catch (err) {
  log.error('could not apply the schema on boot', { err });
  // Keep serving: /health will report the database as down, which is more
  // useful than a container that crash-loops before anyone can read the logs.
}

startScheduler();

const server = app.listen(config.port, () => {
  log.info('media planner listening', {
    port: config.port,
    llm_provider: config.llm.provider,
    node: process.version,
  });
});

async function shutdown(signal) {
  log.info('shutting down', { signal });
  stopScheduler();
  server.close();
  await close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
