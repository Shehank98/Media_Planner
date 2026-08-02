import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, assertConfigured, ROOT } from './config.js';
import { log } from './util/logger.js';
import { migrate, pool, close } from './db.js';
import { startScheduler, stopScheduler } from './sync/scheduler.js';
import { asyncRoute } from './util/asyncRoute.js';
import { describeDbError, isDbError } from './util/dbError.js';
import { getAdapter } from './llm/index.js';
import { healthCheck as ollamaHealth } from './llm/ollama.js';
import { reportWorkerHealth } from './services/reportService.js';
import { adexFacets } from './services/adexRepo.js';
import { tvFacets } from './services/tvRepo.js';
import { micosFacets } from './services/micosRepo.js';

import { router as syncRouter } from './routes/sync.js';
import { router as uploadsRouter } from './routes/uploads.js';
import { router as briefsRouter } from './routes/briefs.js';
import { router as plansRouter } from './routes/plans.js';
import { router as exploreRouter } from './routes/explore.js';
import { router as settingsRouter } from './routes/settings.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// The browser UI. Served from the same origin as the API so there is no CORS
// configuration to get wrong, and no build step to run before deploying.
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

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
    // Confirms the schema is applied, not just that the socket opened - a
    // connected database with no tables fails every real request.
    await pool.query('SELECT count(*) FROM adex_data');
    checks.db = { ok: true };
  } catch (err) {
    const described = describeDbError(err);
    checks.db = { ok: false, error: described.message, hint: described.hint, code: err.code };
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
  const [adex, tv, micos] = await Promise.all([adexFacets(), tvFacets(pool), micosFacets(pool)]);
  res.json({ adex, tv, ratings: micos });
}));

// --- api -------------------------------------------------------------------

app.use('/api/sync', syncRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/briefs', briefsRouter);
app.use('/api/plans', plansRouter);
app.use('/api/explore', exploreRouter);
app.use('/api/settings', settingsRouter);

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// --- errors ----------------------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large. The limit is ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB.`
      : err.message;
    return res.status(400).json({ error: message, code: err.code });
  }

  // A database that is down is a failed dependency, not a bug in the request.
  // 503 says "try again once the database is back" where 500 says "this is
  // broken", and the described cause travels with it so the UI can show it.
  if (isDbError(err)) {
    const described = describeDbError(err);
    log.error('database unavailable', { err, code: err.code });
    return res.status(503).json({
      error: described.message,
      hint: described.hint,
      code: err.code,
      dependency: 'database',
    });
  }

  // Provider failures carry their own status and remedy.
  if (err.dependency === 'llm') {
    return res.status(err.status || 502).json({
      error: err.message,
      hint: err.hint || null,
      dependency: 'llm',
      provider: err.provider || config.llm.provider,
    });
  }

  const status = err.status || 500;
  if (status >= 500) log.error('unhandled request error', { err });
  res.status(status).json({
    error: err.message || 'Internal server error',
    hint: err.hint || null,
  });
});

// --- boot ------------------------------------------------------------------

const problems = assertConfigured();
for (const problem of problems) log.warn('configuration problem', { problem });

try {
  await migrate();
} catch (err) {
  const described = describeDbError(err);
  // The single most useful line in the logs when a deploy comes up broken, so
  // it says what to do rather than just what failed.
  log.error('could not apply the schema on boot - the app will serve but every '
    + 'data request will fail until this is fixed', {
    reason: described.message,
    fix: described.hint,
    code: err.code,
  });
  // Keep serving: /health reports the database as down with the same
  // explanation, which is more useful than a container that crash-loops before
  // anyone can read the logs.
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
