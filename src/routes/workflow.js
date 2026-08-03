import express from 'express';
import { asyncRoute } from '../util/asyncRoute.js';
import {
  listImportBatches, deleteImportBatch, restoreImportBatch, deleteRows,
  listThemes, setThemeCategory, loadDaypartBoundaries, setDaypartBoundary, tagRows,
} from '../services/workflow/repo.js';
import { listAdvertisers, competitorBehaviour } from '../services/workflow/analytics.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// The planning workflow API: advertiser/competitor selection, competitor
// behaviour analytics, import-batch and row management, and the PT/Non-PT and
// theme-category settings that classify the monitored data.
// ---------------------------------------------------------------------------

/** Step 1: advertisers to pick from. */
router.get('/advertisers', asyncRoute(async (req, res) => {
  res.json({ advertisers: await listAdvertisers(pickRange(req.query)) });
}));

/** Step 2: how the advertiser and competitors behave over the set. */
router.post('/competitor-analysis', asyncRoute(async (req, res) => {
  const { advertisers, channel, from, to } = req.body || {};
  if (!Array.isArray(advertisers) || !advertisers.length) {
    return res.status(400).json({ error: 'Pick your advertiser and at least one competitor.' });
  }
  res.json(await competitorBehaviour({ advertisers, channel: channel || null, from: from || null, to: to || null }));
}));

// --- data management -------------------------------------------------------

router.get('/batches', asyncRoute(async (_req, res) => {
  res.json({ batches: await listImportBatches() });
}));

router.delete('/batches/:id', asyncRoute(async (req, res) => {
  const result = await deleteImportBatch(Number(req.params.id));
  if (!result.batch) return res.status(404).json({ error: 'Batch not found or already deleted.' });
  res.json({ ok: true, ...result });
}));

router.post('/batches/:id/restore', asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await restoreImportBatch(Number(req.params.id))) });
}));

/** Delete a filtered set of live rows (partial bad upload). */
router.post('/rows/delete', asyncRoute(async (req, res) => {
  const { advertiser, channel, from, to } = req.body || {};
  if (!advertiser && !channel && !from && !to) {
    return res.status(400).json({ error: 'Give at least one filter so this does not delete everything.' });
  }
  res.json(await deleteRows({
    advertiser: advertiser || null, channel: channel || null, from: from || null, to: to || null,
  }));
}));

// --- classification settings -----------------------------------------------

router.get('/themes', asyncRoute(async (_req, res) => {
  res.json({ themes: await listThemes() });
}));

router.put('/themes', asyncRoute(async (req, res) => {
  const { theme, category } = req.body || {};
  if (!theme) return res.status(400).json({ error: 'theme is required' });
  await setThemeCategory(theme, category);
  res.json({ ok: true, theme, category });
}));

router.get('/daypart', asyncRoute(async (_req, res) => {
  res.json(await loadDaypartBoundaries());
}));

/** Move the PT boundary and re-tag every live row. */
router.put('/daypart', asyncRoute(async (req, res) => {
  const ptStartHour = Number(req.body?.ptStartHour);
  const ptEndHour = Number(req.body?.ptEndHour ?? 24);
  if (!Number.isInteger(ptStartHour) || ptStartHour < 0 || ptStartHour > 23) {
    return res.status(400).json({ error: 'ptStartHour must be an hour 0-23.' });
  }
  await setDaypartBoundary(ptStartHour, ptEndHour);
  await tagRows({});
  res.json({ ok: true, ptStartHour, ptEndHour, retagged: true });
}));

function pickRange(query = {}) {
  return { from: query.from || null, to: query.to || null };
}
