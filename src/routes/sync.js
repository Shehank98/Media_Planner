import express from 'express';
import { syncAdexFromDrive, recentSyncRuns, isSyncRunning } from '../sync/adexSync.js';
import { adexFacets } from '../services/adexRepo.js';
import { asyncRoute } from '../util/asyncRoute.js';

export const router = express.Router();

/** "Sync now" button (Section 3). */
router.post('/now', asyncRoute(async (req, res) => {
  const force = req.query.force === 'true' || req.body?.force === true;
  const summary = await syncAdexFromDrive({ force, trigger: 'manual' });
  res.json(summary);
}));

router.get('/status', asyncRoute(async (_req, res) => {
  const [runs, facets] = await Promise.all([recentSyncRuns(20), adexFacets()]);
  res.json({ running: isSyncRunning(), adex: facets, recent_runs: runs });
}));

router.get('/log', asyncRoute(async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 500);
  res.json({ runs: await recentSyncRuns(limit) });
}));
