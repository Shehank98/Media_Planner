import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { parseMicosWorkbook } from '../parsers/micosParser.js';
import { parseMediaWatch } from '../parsers/mediaWatchParser.js';
import { parseAdexWorkbook } from '../parsers/adexParser.js';
import { persistMicos, persistMediaWatch, micosFacets } from '../services/micosRepo.js';
import { upsertAdexRows, adexFacets } from '../services/adexRepo.js';
import { pool } from '../db.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// Session-only uploads: MICOS dashboard exports, media watch spot logs and
// adex workbooks.
//
// memoryStorage is deliberate. multer's disk engine would write the workbook to
// a temp path, and "delete it afterwards" is a promise that breaks on the first
// crash or early return. Holding the file as a Buffer means there is no file to
// forget to delete - it is parsed, the numbers go to Postgres, and the Buffer
// is dropped when the request ends.
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls|csv|tsv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error(`${file.originalname}: expected .xlsx/.xls or .csv/.tsv`), ok);
  },
});

/**
 * Upload MICOS exports, media watch logs and adex workbooks, in any combination.
 *
 * Each file is classified by content rather than by field name or filename:
 * TV_ChannelDetails and TV_GrpDetails exports carry entirely different sheets
 * from each other despite the naming, and the media watch log arrives as either
 * a workbook or delimited text. Classification is ordered most to least
 * specific, so a file is only treated as adex once the other two have declined
 * it.
 */
router.post('/tv', upload.any(), asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'No file uploaded. Attach at least one export.' });
  }

  const perFile = [];
  const micosParsed = [];
  const mediaWatchSpots = [];
  const adexRows = [];
  const warnings = [];

  try {
    for (const file of files) {
      const detail = { file: file.originalname, size_bytes: file.size, kind: null, warnings: [] };

      const micos = await parseMicosWorkbook(file.buffer, { sourceFile: file.originalname })
        .catch((err) => ({ error: err.message }));

      const micosRowCount = micos.error
        ? 0
        : micos.programmes.length + micos.channelPerformance.length
          + micos.channelDays.length + micos.channelDayparts.length + micos.spots.length;

      if (micosRowCount > 0) {
        micosParsed.push(micos);
        detail.kind = 'micos_dashboard';
        detail.target_audience = micos.meta.target_audience;
        detail.period = { from: micos.meta.period_start, to: micos.meta.period_end };
        detail.sheets = micos.sheets;
        detail.rows = {
          programmes: micos.programmes.length,
          channel_performance: micos.channelPerformance.length,
          days: micos.channelDays.length,
          dayparts: micos.channelDayparts.length,
          spots: micos.spots.length,
        };
        detail.warnings.push(...micos.warnings);
        perFile.push(detail);
        continue;
      }

      const mw = await parseMediaWatch(file.buffer, { sourceFile: file.originalname })
        .catch((err) => ({ spots: [], sheets: [], warnings: [err.message] }));

      if (mw.spots.length) {
        mediaWatchSpots.push(...mw.spots);
        detail.kind = 'media_watch';
        detail.rows = { spots: mw.spots.length };
        detail.sheets = mw.sheets;
        detail.warnings.push(...mw.warnings);
        perFile.push(detail);
        continue;
      }

      // Adex monthly spend. Normally this arrives by Drive sync, but the same
      // workbooks get handed over directly often enough that refusing them
      // here just sends people looking for an upload button that doesn't exist.
      const adex = await parseAdexWorkbook(file.buffer, { sourceFile: file.originalname })
        .catch((err) => ({ rows: [], sheets: [], warnings: [err.message] }));

      if (adex.rows.length) {
        adexRows.push(...adex.rows);
        detail.kind = 'adex';
        detail.rows = { adex: adex.rows.length };
        detail.sheets = adex.sheets;
        detail.warnings.push(...adex.warnings);
        perFile.push(detail);
        continue;
      }

      detail.kind = 'unrecognised';
      detail.sheets = micos.error ? [] : micos.sheets;
      detail.warnings.push(
        micos.error
          ? `Could not read as a workbook: ${micos.error}`
          : 'This file did not match a MICOS dashboard export, a media watch spot log, or an '
            + 'adex workbook. Check the header row names the columns the parser looks for.',
        ...(mw.warnings || []),
      );
      perFile.push(detail);
    }

    if (!micosParsed.length && !mediaWatchSpots.length && !adexRows.length) {
      return res.status(422).json({
        error: 'No usable rows could be extracted from the upload.',
        hint: 'Expected a MICOS dashboard export (TV_ChannelDetails / TV_GrpDetails), a media '
          + 'watch spot log with a Channel and Cost column, or an adex workbook with a Month '
          + 'column. The per-file detail below lists the sheets that were inspected.',
        files: perFile,
      });
    }

    // A MICOS export's Target sheet does not always carry the "Custom TG" line
    // - the spot-level GRP export supplied omits it. When another file in the
    // same upload declares one, apply it rather than storing the rows against a
    // blank audience, and say so. Files uploaded together are one survey.
    const declared = micosParsed.map((m) => m.meta.target_audience).filter(Boolean);
    const audienceOverride = declared.length ? declared[0] : null;
    if (audienceOverride && micosParsed.some((m) => !m.meta.target_audience)) {
      warnings.push(
        `Some files in this upload did not state a target group; "${audienceOverride}" was ` +
        'taken from the others in the same upload. Re-upload separately if they cover ' +
        'different audiences.',
      );
    }

    const persisted = { programmes: 0, channelPerformance: 0, dayparts: 0, spots: 0, channels: 0 };
    for (const parsed of micosParsed) {
      const result = await persistMicos(parsed, { audienceOverride });
      for (const key of Object.keys(persisted)) persisted[key] += result[key] ?? 0;
    }
    const mwResult = mediaWatchSpots.length
      ? await persistMediaWatch(mediaWatchSpots)
      : { spots: 0 };
    const adexUpserted = adexRows.length ? await upsertAdexRows(adexRows) : 0;

    log.info('upload ingested', {
      files: files.length, ...persisted, mediaWatch: mwResult.spots, adex: adexUpserted,
    });

    res.json({
      ok: true,
      files: perFile,
      persisted: { ...persisted, media_watch_spots: mwResult.spots, adex_rows: adexUpserted },
      target_audience: audienceOverride,
      warnings,
      // Stated explicitly so the guarantee is visible to whoever calls the API.
      source_files_retained: false,
      facets: await micosFacets(pool),
      adex: await adexFacets(),
    });
  } finally {
    // Drop the references so the buffers are collectable as soon as the
    // response is written, rather than lingering on req for the request's life.
    for (const file of files) file.buffer = null;
    req.files = [];
  }
}));

/** What TVR/cost data is currently loaded. */
router.get('/tv/summary', asyncRoute(async (_req, res) => {
  res.json(await micosFacets(pool));
}));

/**
 * Clear ratings data.
 *
 * Ratings are a point-in-time survey; when a new one supersedes the old, a
 * planner needs to start clean rather than blend two periods.
 */
router.delete('/tv', asyncRoute(async (req, res) => {
  if (req.query.confirm !== 'true') {
    return res.status(400).json({ error: 'Refusing to delete rating data without ?confirm=true' });
  }
  const deleted = {};
  for (const table of ['tv_programme_ratings', 'tv_channel_daypart',
    'tv_channel_performance', 'tv_spot_grp', 'tv_report_meta']) {
    deleted[table] = (await pool.query(`DELETE FROM ${table}`)).rowCount;
  }
  if (req.query.media_watch === 'true') {
    deleted.media_watch_spots = (await pool.query('DELETE FROM media_watch_spots')).rowCount;
  }
  if (req.query.channels === 'true') {
    deleted.tv_channels = (await pool.query('DELETE FROM tv_channels')).rowCount;
  }
  res.json({ deleted });
}));
