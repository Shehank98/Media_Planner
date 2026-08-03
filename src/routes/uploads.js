import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { parseMicosWorkbook } from '../parsers/micosParser.js';
import { parseMediaWatch } from '../parsers/mediaWatchParser.js';
import { parseAdexWorkbook } from '../parsers/adexParser.js';
import {
  persistMicos, persistMediaWatch, micosFacets,
  listMediaWatchSources, deleteMediaWatchSource,
} from '../services/micosRepo.js';
import { createImportBatch, tagRows } from '../services/workflow/repo.js';
import { upsertAdexRows, adexFacets } from '../services/adexRepo.js';
import { archiveUpload, purgeArchive, archiveStatus } from '../services/driveArchive.js';
import { pushAll } from '../util/arrays.js';
import { pool } from '../db.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// Session-only uploads.
//
// memoryStorage is deliberate. multer's disk engine would write the workbook to
// a temp path, and "delete it afterwards" is a promise that breaks on the first
// crash or early return. Holding the file as a Buffer means there is no file to
// forget to delete - it is parsed, the numbers go to Postgres, the buffer is
// archived to Drive if configured, and then dropped.
//
// Files arrive in named slots (channel_summary, top_programmes, …) so a planner
// can see which dataset is missing. The slot is a label, not a parser
// selection: content still decides how a file is read, because the MICOS
// exports carry different sheets under identical names and mislabelling one
// should not silently load the wrong table.
// ---------------------------------------------------------------------------

export const DATASETS = {
  channel_summary: 'Channel summary (share of audience, reach)',
  top_programmes: 'Top programmes (ratings, airings, duration)',
  top_spend: 'Top spend (competitor spend by brand)',
  category_analysis: 'Category analysis',
  media_watch: 'Media watch spot log (with cost)',
  adex: 'Adex monthly spend',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 24 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls|csv|tsv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error(`${file.originalname}: expected .xlsx/.xls or .csv/.tsv`), ok);
  },
});

/** Classify one file by content, reporting what it turned out to be. */
async function classify(file) {
  const micos = await parseMicosWorkbook(file.buffer, { sourceFile: file.originalname })
    .catch((err) => ({ error: err.message }));

  const micosRows = micos.error
    ? 0
    : micos.programmes.length + micos.channelPerformance.length
      + micos.channelDays.length + micos.channelDayparts.length + micos.spots.length;

  if (micosRows > 0) {
    return {
      kind: 'micos_dashboard',
      micos,
      rows: {
        programmes: micos.programmes.length,
        channel_performance: micos.channelPerformance.length,
        days: micos.channelDays.length,
        dayparts: micos.channelDayparts.length,
        spots: micos.spots.length,
      },
      sheets: micos.sheets,
      warnings: micos.warnings,
      target_audience: micos.meta.target_audience,
      period: { from: micos.meta.period_start, to: micos.meta.period_end },
    };
  }

  const mw = await parseMediaWatch(file.buffer, { sourceFile: file.originalname })
    .catch((err) => ({ spots: [], sheets: [], warnings: [err.message] }));
  if (mw.spots.length) {
    return {
      kind: 'media_watch', spots: mw.spots, rows: { spots: mw.spots.length },
      sheets: mw.sheets, warnings: mw.warnings,
    };
  }

  const adex = await parseAdexWorkbook(file.buffer, { sourceFile: file.originalname })
    .catch((err) => ({ rows: [], sheets: [], warnings: [err.message] }));
  if (adex.rows.length) {
    return {
      kind: 'adex', adexRows: adex.rows, rows: { adex: adex.rows.length },
      sheets: adex.sheets, warnings: adex.warnings,
    };
  }

  return {
    kind: 'unrecognised',
    rows: {},
    sheets: micos.error ? [] : micos.sheets,
    warnings: [
      micos.error
        ? `Could not read as a workbook: ${micos.error}`
        : 'This file did not match a MICOS dashboard export, a media watch spot log, or an '
          + 'adex workbook. Check the header row names the columns the parser looks for.',
      ...(mw.warnings || []),
    ],
  };
}

/**
 * Upload one or more datasets.
 *
 * Field names carry the slot: `channel_summary`, `media_watch`, `adex`, and so
 * on. Anything under `files` is accepted too and classified purely by content,
 * which keeps the single-dropzone flow working.
 */
router.post('/tv', upload.any(), asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'No file uploaded. Attach at least one export.' });
  }

  const runId = randomUUID();
  const perFile = [];
  const micosParsed = [];
  const mediaWatchSpots = [];
  const adexRows = [];
  const warnings = [];
  const forArchive = [];

  try {
    for (const file of files) {
      const slot = DATASETS[file.fieldname] ? file.fieldname : null;
      const detail = {
        file: file.originalname,
        slot,
        size_bytes: file.size,
        kind: null,
        warnings: [],
      };

      const result = await classify(file);
      detail.kind = result.kind;
      detail.rows = result.rows;
      detail.sheets = result.sheets;
      detail.warnings.push(...(result.warnings || []));
      if (result.target_audience) detail.target_audience = result.target_audience;
      if (result.period) detail.period = result.period;

      if (result.kind === 'micos_dashboard') micosParsed.push(result.micos);
      // Spread-push would overflow the stack on a large spot log or workbook.
      else if (result.kind === 'media_watch') pushAll(mediaWatchSpots, result.spots);
      else if (result.kind === 'adex') pushAll(adexRows, result.adexRows);

      // A file dropped in the wrong slot still loads, but say so - silently
      // accepting it is how a planner ends up believing a dataset is present
      // when it never was.
      if (slot && result.kind !== 'unrecognised' && !slotMatches(slot, result.kind)) {
        detail.warnings.push(
          `Uploaded under "${DATASETS[slot]}" but read as ${result.kind.replace('_', ' ')}. `
          + 'It has been loaded correctly; the slot label is only a hint.',
        );
      }

      if (result.kind !== 'unrecognised') {
        forArchive.push({
          name: file.originalname,
          buffer: file.buffer,
          dataset: result.kind === 'adex' ? 'adex' : (slot || result.kind),
        });
      }
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
    // - the spot-level GRP export omits it. When another file in the same
    // upload declares one, apply it rather than storing rows against a blank
    // audience, and say so. Files uploaded together are one survey.
    const declared = micosParsed.map((m) => m.meta.target_audience).filter(Boolean);
    const audienceOverride = declared.length ? declared[0] : null;
    if (audienceOverride && micosParsed.some((m) => !m.meta.target_audience)) {
      warnings.push(
        `Some files in this upload did not state a target group; "${audienceOverride}" was `
        + 'taken from the others in the same upload. Re-upload separately if they cover '
        + 'different audiences.',
      );
    }

    const persisted = { programmes: 0, channelPerformance: 0, dayparts: 0, spots: 0, channels: 0 };
    for (const parsed of micosParsed) {
      const result = await persistMicos(parsed, { audienceOverride });
      for (const key of Object.keys(persisted)) persisted[key] += result[key] ?? 0;
    }
    // Media watch lands under an import batch so a whole bad upload can be
    // undone, and every row is tagged PT/Non-PT and Value Addition/Spot.
    let mwResult = { spots: 0 };
    let mwBatchId = null;
    if (mediaWatchSpots.length) {
      const dates = mediaWatchSpots.map((s) => s.aired_on).filter(Boolean).sort();
      mwBatchId = await createImportBatch({
        sourceFileName: files.map((f) => f.originalname).join(', ').slice(0, 300),
        kind: 'media_watch',
        periodStart: dates[0] || null,
        periodEnd: dates[dates.length - 1] || null,
        rowCount: mediaWatchSpots.length,
      });
      mwResult = await persistMediaWatch(mediaWatchSpots, { batchId: mwBatchId });
      await tagRows({ batchId: mwBatchId });
    }
    const adexUpserted = adexRows.length ? await upsertAdexRows(adexRows) : 0;

    // Archive last: the data is already safely in Postgres, so a Drive outage
    // degrades to "not archived" rather than failing the upload.
    const archive = await archiveUpload(forArchive, { runId });

    log.info('upload ingested', {
      runId, files: files.length, ...persisted,
      mediaWatch: mwResult.spots, adex: adexUpserted, archived: archive.archived.length,
    });

    res.json({
      ok: true,
      run_id: runId,
      files: perFile,
      persisted: { ...persisted, media_watch_spots: mwResult.spots, adex_rows: adexUpserted },
      target_audience: audienceOverride,
      warnings,
      archive: {
        archived: archive.archived.length,
        folder_id: archive.folderId || null,
        skipped: archive.skipped || null,
        hint: archive.hint || null,
      },
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

/** Which content kinds a slot is expected to hold. */
function slotMatches(slot, kind) {
  if (slot === 'media_watch') return kind === 'media_watch';
  if (slot === 'adex') return kind === 'adex';
  // The four MICOS slots are all dashboard exports.
  return kind === 'micos_dashboard';
}

/** The upload slots the UI renders, so the list lives in one place. */
router.get('/datasets', (_req, res) => {
  res.json({
    datasets: Object.entries(DATASETS).map(([key, label]) => ({
      key,
      label,
      // Adex accumulates; everything else is a point-in-time survey.
      retained: key === 'adex',
    })),
  });
});

/**
 * The media watch sheets currently loaded.
 *
 * Each is a `<file>#<sheet>` source, so a planner who uploads sheets one at a
 * time can see them listed separately and drop one without touching the others.
 */
router.get('/media-watch/sources', asyncRoute(async (_req, res) => {
  res.json({ sources: await listMediaWatchSources() });
}));

/** Delete every row belonging to one media watch sheet. */
router.delete('/media-watch/source', asyncRoute(async (req, res) => {
  const source = req.query.source || req.body?.source;
  if (!source) {
    return res.status(400).json({ error: 'Name the media watch sheet to delete via ?source=...' });
  }
  const deleted = await deleteMediaWatchSource(String(source));
  if (!deleted) {
    return res.status(404).json({ error: `No media watch sheet named "${source}" is loaded.` });
  }
  res.json({ ok: true, source: String(source), deleted });
}));

/** What data is currently loaded. */
router.get('/tv/summary', asyncRoute(async (_req, res) => {
  const [ratings, adex, archive] = await Promise.all([
    micosFacets(pool), adexFacets(), archiveStatus(20),
  ]);
  res.json({ ratings, adex, archive });
}));

/** Remove archived sources from Drive. Adex is kept regardless. */
router.post('/archive/purge', asyncRoute(async (req, res) => {
  const result = await purgeArchive({
    runId: req.body?.run_id || null,
    olderThanHours: req.body?.older_than_hours || null,
  });
  res.json(result);
}));

router.get('/archive', asyncRoute(async (_req, res) => {
  res.json(await archiveStatus(100));
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
