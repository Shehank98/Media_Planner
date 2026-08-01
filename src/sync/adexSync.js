import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { log } from '../util/logger.js';
import { listAdexFiles, downloadFile } from './driveClient.js';
import { parseAdexWorkbook } from '../parsers/adexParser.js';
import { upsertAdexRows } from '../services/adexRepo.js';

// Only one sync may run at a time: the cron tick and a "Sync now" click can
// otherwise overlap and fight over the same ON CONFLICT targets.
let running = null;

export function isSyncRunning() {
  return running !== null;
}

/**
 * Pull the Drive folder and upsert everything that changed.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.force]  re-ingest files even if modifiedTime is unchanged
 * @param {string}  [opts.trigger] 'cron' | 'manual' | 'boot', recorded for the log
 */
export async function syncAdexFromDrive(opts = {}) {
  if (running) {
    log.info('sync already in progress, joining the running one');
    return running;
  }
  running = doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync({ force = false, trigger = 'manual' } = {}) {
  const runId = randomUUID();
  const startedAt = Date.now();
  log.info('adex sync started', { runId, trigger, force });

  const summary = {
    runId,
    trigger,
    files: [],
    rowsParsed: 0,
    rowsUpserted: 0,
    filesSkipped: 0,
    filesFailed: 0,
  };

  let files;
  try {
    files = await listAdexFiles();
  } catch (err) {
    await recordLog({
      runId, fileName: null, driveFileId: null, status: 'error',
      error: `Drive listing failed: ${err.message}`, durationMs: Date.now() - startedAt,
    });
    log.error('adex sync could not list the Drive folder', { runId, err });
    throw err;
  }

  const seen = force ? new Map() : await lastSuccessfulSyncTimes(files.map((f) => f.id));

  for (const file of files) {
    const fileStarted = Date.now();
    const modified = file.modifiedTime ? new Date(file.modifiedTime) : null;
    const previous = seen.get(file.id);

    // Unchanged since the last good run - nothing to do.
    if (!force && previous && modified && modified.getTime() <= previous.getTime()) {
      summary.filesSkipped += 1;
      summary.files.push({ name: file.name, status: 'skipped', reason: 'unchanged since last sync' });
      continue;
    }

    try {
      const buffer = await downloadFile(file);
      const { rows, sheets, warnings } = await parseAdexWorkbook(buffer, { sourceFile: file.name });

      if (!rows.length) {
        await recordLog({
          runId, fileName: file.name, driveFileId: file.id, driveModifiedAt: modified,
          rowsParsed: 0, rowsUpserted: 0, status: 'skipped',
          error: `No adex rows found. Sheets inspected: ${JSON.stringify(sheets)}`,
          durationMs: Date.now() - fileStarted,
        });
        summary.filesSkipped += 1;
        summary.files.push({ name: file.name, status: 'skipped', reason: 'no adex rows found', sheets });
        continue;
      }

      const upserted = await upsertAdexRows(rows);

      summary.rowsParsed += rows.length;
      summary.rowsUpserted += upserted;
      summary.files.push({
        name: file.name, status: 'ok', rowsParsed: rows.length, rowsUpserted: upserted, sheets, warnings,
      });

      await recordLog({
        runId, fileName: file.name, driveFileId: file.id, driveModifiedAt: modified,
        rowsParsed: rows.length, rowsUpserted: upserted, status: 'ok',
        error: warnings.length ? warnings.slice(0, 20).join('; ') : null,
        durationMs: Date.now() - fileStarted,
      });
      log.info('adex file synced', { runId, file: file.name, rows: rows.length, upserted });
    } catch (err) {
      // One bad workbook shouldn't abort the run - log it and keep going.
      summary.filesFailed += 1;
      summary.files.push({ name: file.name, status: 'error', error: err.message });
      await recordLog({
        runId, fileName: file.name, driveFileId: file.id, driveModifiedAt: modified,
        status: 'error', error: err.message, durationMs: Date.now() - fileStarted,
      });
      log.error('adex file failed to sync', { runId, file: file.name, err });
    }
  }

  summary.durationMs = Date.now() - startedAt;
  log.info('adex sync finished', {
    runId,
    files: files.length,
    rowsUpserted: summary.rowsUpserted,
    failed: summary.filesFailed,
    durationMs: summary.durationMs,
  });
  return summary;
}

/** modifiedTime of the last successful ingest, per Drive file id. */
async function lastSuccessfulSyncTimes(fileIds) {
  const map = new Map();
  if (!fileIds.length) return map;
  const { rows } = await pool.query(
    `SELECT drive_file_id, max(drive_modified_at) AS last_modified
       FROM sync_log
      WHERE drive_file_id = ANY($1) AND status = 'ok'
      GROUP BY drive_file_id`,
    [fileIds],
  );
  for (const row of rows) {
    if (row.last_modified) map.set(row.drive_file_id, new Date(row.last_modified));
  }
  return map;
}

async function recordLog({
  runId, fileName, driveFileId, driveModifiedAt = null,
  rowsParsed = 0, rowsUpserted = 0, rowsSkipped = 0,
  status, error = null, durationMs = null,
}) {
  try {
    await pool.query(
      `INSERT INTO sync_log
         (run_id, file_name, drive_file_id, drive_modified_at,
          rows_parsed, rows_upserted, rows_skipped, status, error, duration_ms, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [runId, fileName, driveFileId, driveModifiedAt, rowsParsed, rowsUpserted, rowsSkipped,
       status, error ? String(error).slice(0, 4000) : null, durationMs],
    );
  } catch (err) {
    // Losing an audit row must never take down the sync itself.
    log.error('failed to write sync_log row', { err });
  }
}

export async function recentSyncRuns(limit = 50) {
  const { rows } = await pool.query(
    `SELECT run_id, file_name, rows_parsed, rows_upserted, status, error, duration_ms, started_at
       FROM sync_log ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
