import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { log } from '../util/logger.js';
import { getSetting, SETTING_KEYS } from './settings.js';
import {
  ensureFolder, uploadBuffer, deleteFile, ARCHIVE_ROOT_NAME, DriveNotConfigured,
} from '../sync/driveClient.js';

// ---------------------------------------------------------------------------
// Archive uploaded source files to Drive for the life of one planning run.
//
// The workbooks are still never written to this server's disk - they go from
// the request buffer straight to Drive, so the session-only guarantee holds.
// Drive is where a planner can go back and check what the plan was built from
// while the report is being reviewed.
//
// Once the PDF exists the sources have served their purpose and are removed,
// with one exception: adex accumulates month on month rather than being
// superseded, so adex files are marked keep and left alone.
// ---------------------------------------------------------------------------

const KEEP_DATASETS = new Set(['adex']);

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  pdf: 'application/pdf',
};

function mimeFor(name) {
  const ext = String(name).split('.').pop()?.toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export async function archiveEnabled() {
  return (await getSetting(SETTING_KEYS.DRIVE_ARCHIVE_ENABLED)) !== 'false';
}

/**
 * Resolve the folder this run's files go into.
 *
 * "Media Planner" holds one dated subfolder per run, so a run's sources stay
 * together and a purge is a folder's worth of deletes rather than a scavenger
 * hunt.
 */
async function runFolder(runId) {
  const configuredRoot = await getSetting(SETTING_KEYS.DRIVE_ARCHIVE_FOLDER);
  const root = configuredRoot || await ensureFolder(ARCHIVE_ROOT_NAME);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return ensureFolder(`${stamp} · ${runId.slice(0, 8)}`, root);
}

/**
 * Archive the files from one upload.
 *
 * Never throws: Drive being unconfigured or unreachable must not fail an
 * upload whose data has already been parsed into Postgres. The outcome is
 * reported so the UI can say the archive did not happen and why.
 */
export async function archiveUpload(files, { runId = randomUUID() } = {}) {
  if (!files.length) return { runId, archived: [], skipped: 'no files' };

  if (!await archiveEnabled()) {
    return { runId, archived: [], skipped: 'archiving is turned off in Settings' };
  }

  let folderId;
  try {
    folderId = await runFolder(runId);
  } catch (err) {
    const why = err instanceof DriveNotConfigured
      ? err.message
      : `Drive was unreachable: ${err.message}`;
    log.warn('drive archive skipped', { runId, reason: why });
    return { runId, archived: [], skipped: why, hint: err.hint || null };
  }

  const archived = [];
  for (const file of files) {
    const keep = KEEP_DATASETS.has(file.dataset);
    try {
      const uploaded = await uploadBuffer({
        name: file.name,
        buffer: file.buffer,
        folderId,
        mimeType: mimeFor(file.name),
      });
      await pool.query(
        `INSERT INTO drive_archive
           (run_id, dataset, file_name, drive_file_id, drive_folder_id, bytes, keep)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, file.dataset, file.name, uploaded.id, folderId, file.buffer.length, keep],
      );
      archived.push({ name: file.name, dataset: file.dataset, keep, drive_file_id: uploaded.id });
    } catch (err) {
      log.warn('drive archive failed for one file', { runId, file: file.name, err });
      await pool.query(
        `INSERT INTO drive_archive (run_id, dataset, file_name, drive_folder_id, bytes, keep, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, file.dataset, file.name, folderId, file.buffer.length, keep, err.message],
      );
      archived.push({ name: file.name, dataset: file.dataset, error: err.message });
    }
  }

  log.info('drive archive written', { runId, folderId, files: archived.length });
  return { runId, folderId, archived };
}

/**
 * Remove archived sources once the report exists.
 *
 * Adex rows are marked keep and skipped. Failures are recorded rather than
 * raised - the report has already been produced, and a file left behind in
 * Drive is a tidiness problem, not a broken run.
 */
export async function purgeArchive({ runId = null, olderThanHours = null } = {}) {
  const conditions = ['purged_at IS NULL', 'keep = false', 'drive_file_id IS NOT NULL'];
  const params = [];
  if (runId) {
    params.push(runId);
    conditions.push(`run_id = $${params.length}`);
  }
  if (olderThanHours) {
    params.push(olderThanHours);
    conditions.push(`created_at < now() - ($${params.length} || ' hours')::interval`);
  }

  const { rows } = await pool.query(
    `SELECT id, drive_file_id, file_name, dataset FROM drive_archive
      WHERE ${conditions.join(' AND ')}`,
    params,
  );
  if (!rows.length) return { purged: 0, kept: 0, failed: 0 };

  let purged = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deleteFile(row.drive_file_id);
      await pool.query('UPDATE drive_archive SET purged_at = now() WHERE id = $1', [row.id]);
      purged += 1;
    } catch (err) {
      // Already gone counts as purged - someone tidying up by hand is fine.
      const gone = err?.code === 404 || /not found|notFound/i.test(err?.message || '');
      if (gone) {
        await pool.query('UPDATE drive_archive SET purged_at = now() WHERE id = $1', [row.id]);
        purged += 1;
      } else {
        failed += 1;
        await pool.query('UPDATE drive_archive SET error = $2 WHERE id = $1', [row.id, err.message]);
        log.warn('drive purge failed', { file: row.file_name, err });
      }
    }
  }

  const { rows: keptRows } = await pool.query(
    'SELECT count(*)::int AS n FROM drive_archive WHERE keep = true AND purged_at IS NULL',
  );
  log.info('drive archive purged', { runId, purged, failed });
  return { purged, failed, kept: keptRows[0].n };
}

export async function archiveStatus(limit = 50) {
  const { rows } = await pool.query(
    `SELECT run_id, dataset, file_name, bytes, keep, purged_at, error, created_at
       FROM drive_archive ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  const { rows: totals } = await pool.query(`
    SELECT count(*) FILTER (WHERE purged_at IS NULL AND keep = false) AS pending,
           count(*) FILTER (WHERE keep = true) AS kept,
           count(*) FILTER (WHERE purged_at IS NOT NULL) AS purged
      FROM drive_archive`);
  return { files: rows, totals: totals[0] };
}
