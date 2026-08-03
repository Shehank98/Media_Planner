import { pool } from '../../db.js';

// ---------------------------------------------------------------------------
// Import batches, PT/Non-PT + category tagging, the theme map, and soft-delete.
//
// Tagging is done in SQL against a batch (or all live rows) rather than row by
// row in Node, so re-classifying 30k+ spots after a settings change is one
// statement. Every read filters deleted_at IS NULL.
// ---------------------------------------------------------------------------

/** The PT window from daypart_settings, as integer hours. Defaults 18-24. */
export async function loadDaypartBoundaries() {
  const { rows } = await pool.query(
    "SELECT extract(hour FROM start_time)::int AS s, extract(hour FROM end_time)::int AS e "
    + "FROM daypart_settings WHERE label = 'PT' LIMIT 1",
  );
  const r = rows[0];
  const ptStartHour = Number.isInteger(r?.s) ? r.s : 18;
  // 00:00 stored for a window that ends at midnight reads back as hour 0; treat
  // that as 24 so [18,24) works.
  const ptEndHour = r && Number.isInteger(r.e) ? (r.e === 0 ? 24 : r.e) : 24;
  return { ptStartHour, ptEndHour };
}

export async function setDaypartBoundary(ptStartHour, ptEndHour) {
  const end = ptEndHour === 24 ? '00:00' : `${String(ptEndHour).padStart(2, '0')}:00`;
  const start = `${String(ptStartHour).padStart(2, '0')}:00`;
  await pool.query(
    `INSERT INTO daypart_settings (label, start_time, end_time) VALUES ('PT', $1, $2)
       ON CONFLICT (label) DO UPDATE SET start_time = $1, end_time = $2`,
    [start, end],
  );
  await pool.query(
    `INSERT INTO daypart_settings (label, start_time, end_time) VALUES ('Non-PT', $1, $2)
       ON CONFLICT (label) DO UPDATE SET start_time = $1, end_time = $2`,
    [end === '00:00' ? '00:00' : end, start],
  );
  return { ptStartHour, ptEndHour };
}

/** Create a batch and return its id. */
export async function createImportBatch({ sourceFileName, kind, periodStart, periodEnd, rowCount, importedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO import_batches (source_file_name, kind, period_start, period_end, row_count, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [sourceFileName || null, kind || null, periodStart || null, periodEnd || null, rowCount || 0, importedBy || null],
  );
  return rows[0].id;
}

/** Tag PT/Non-PT and Value Addition/Spot for one batch (or all live rows). */
export async function tagRows({ batchId = null } = {}) {
  const { ptStartHour, ptEndHour } = await loadDaypartBoundaries();
  const scope = batchId ? 'import_batch_id = $1' : 'TRUE';
  const params = batchId ? [batchId] : [];
  // The boundary hours are validated integers we own, so they are interpolated
  // directly - binding them makes Postgres infer one type across two different
  // comparison contexts and fail with "integer >= text".
  const s = Math.trunc(ptStartHour);
  const e = Math.trunc(ptEndHour);
  const test = e > s
    ? `hh >= ${s} AND hh < ${e}`   // non-wrapping window
    : `hh >= ${s} OR hh < ${e}`;   // window that wraps past midnight

  // Daypart from the hour of advt_time; non-numeric or empty times stay null.
  await pool.query(
    `UPDATE media_watch_spots SET daypart = CASE
       WHEN advt_time IS NULL OR advt_time = '' OR split_part(advt_time, ':', 1) !~ '^[0-9]{1,2}$' THEN NULL
       ELSE (
         SELECT CASE WHEN ${test} THEN 'PT' ELSE 'Non-PT' END
         FROM (SELECT split_part(advt_time, ':', 1)::int AS hh) x
       )
     END
     WHERE ${scope} AND deleted_at IS NULL`,
    params,
  );

  // Category from the theme map, defaulting the rest to Spot.
  await pool.query(
    `UPDATE media_watch_spots m SET ad_category = t.category
       FROM theme_category_map t
      WHERE lower(m.advt_theme) = lower(t.advt_theme)
        AND ${scope} AND m.deleted_at IS NULL`,
    params,
  );
  await pool.query(
    `UPDATE media_watch_spots SET ad_category = 'Spot'
      WHERE ad_category IS NULL AND ${scope} AND deleted_at IS NULL`,
    params,
  );
  return { ptStartHour, ptEndHour };
}

/** Batches that still have live rows behind them. */
export async function listImportBatches() {
  const { rows } = await pool.query(
    `SELECT b.id, b.source_file_name, b.kind, b.imported_at, b.period_start, b.period_end,
            b.row_count,
            (SELECT count(*)::int FROM media_watch_spots m
              WHERE m.import_batch_id = b.id AND m.deleted_at IS NULL) AS live_rows
       FROM import_batches b
      WHERE b.deleted_at IS NULL
      ORDER BY b.imported_at DESC`,
  );
  return rows;
}

/** Soft-delete a batch and everything imported under it. */
export async function deleteImportBatch(batchId) {
  const mw = await pool.query(
    'UPDATE media_watch_spots SET deleted_at = now() WHERE import_batch_id = $1 AND deleted_at IS NULL',
    [batchId],
  );
  const b = await pool.query(
    'UPDATE import_batches SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
    [batchId],
  );
  return { batch: b.rowCount, media_watch_rows: mw.rowCount };
}

/** Restore a soft-deleted batch (within the retention window). */
export async function restoreImportBatch(batchId) {
  const mw = await pool.query(
    'UPDATE media_watch_spots SET deleted_at = NULL WHERE import_batch_id = $1 AND deleted_at IS NOT NULL',
    [batchId],
  );
  const b = await pool.query(
    'UPDATE import_batches SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL',
    [batchId],
  );
  return { batch: b.rowCount, media_watch_rows: mw.rowCount };
}

/** Soft-delete a filtered set of live rows (partial-bad-upload case). */
export async function deleteRows({ advertiser = null, channel = null, from = null, to = null } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE media_watch_spots SET deleted_at = now()
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR advertiser ILIKE $1)
        AND ($2::text IS NULL OR channel_name ILIKE $2)
        AND ($3::date IS NULL OR aired_on >= $3)
        AND ($4::date IS NULL OR aired_on <= $4)`,
    [advertiser, channel, from, to],
  );
  return { deleted: rowCount };
}

// --- theme -> category map -------------------------------------------------

export async function loadThemeMap() {
  const { rows } = await pool.query('SELECT advt_theme, category FROM theme_category_map');
  return new Map(rows.map((r) => [String(r.advt_theme).toLowerCase(), r.category]));
}

/** Every theme seen in live data, with how it is currently classified. */
export async function listThemes() {
  const { rows } = await pool.query(
    `SELECT m.advt_theme,
            count(*)::int AS spots,
            COALESCE(t.category, 'Spot') AS category,
            (t.advt_theme IS NOT NULL) AS mapped
       FROM media_watch_spots m
       LEFT JOIN theme_category_map t ON lower(t.advt_theme) = lower(m.advt_theme)
      WHERE m.deleted_at IS NULL AND COALESCE(m.advt_theme, '') <> ''
      GROUP BY m.advt_theme, t.category, t.advt_theme
      ORDER BY count(*) DESC`,
  );
  return rows;
}

export async function setThemeCategory(theme, category) {
  if (!['Value Addition', 'Spot'].includes(category)) {
    throw Object.assign(new Error('category must be "Value Addition" or "Spot"'), { status: 400 });
  }
  await pool.query(
    `INSERT INTO theme_category_map (advt_theme, category) VALUES ($1, $2)
       ON CONFLICT (advt_theme) DO UPDATE SET category = $2, updated_at = now()`,
    [theme, category],
  );
  // Re-tag just the rows carrying this theme.
  await pool.query(
    "UPDATE media_watch_spots SET ad_category = $2 WHERE lower(advt_theme) = lower($1) AND deleted_at IS NULL",
    [theme, category],
  );
}
