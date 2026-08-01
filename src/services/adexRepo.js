import { pool } from '../db.js';

// Column order is fixed here and reused for every batch so the generated
// placeholder list stays in lockstep with the values array.
const COLUMNS = [
  'month', 'super_category', 'product_group', 'mother_brand', 'advertiser', 'brand',
  'tv_spend_000', 'tv_freq', 'tv_dur_secs',
  'radio_spend_000', 'radio_freq', 'radio_dur_secs',
  'press_spend_000', 'press_ins',
  'total_000', 'fy', 'month2', 'quarter', 'sector', 'category', 'product2', 'source_file',
];

// Everything except the natural key gets refreshed when a file is re-synced.
const UPDATE_COLUMNS = COLUMNS.filter(
  (c) => !['month', 'advertiser', 'brand', 'product2'].includes(c),
);

const BATCH_SIZE = 500;

/**
 * Batch-upsert adex rows, 500 at a time (Section 3).
 *
 * Row-by-row inserts at 30k+ rows would mean 30k round trips; this is ~60.
 * Each batch is its own statement, so a malformed batch fails without taking
 * the whole sync with it - the caller decides whether to abort.
 */
export async function upsertAdexRows(rows, { client = pool, batchSize = BATCH_SIZE } = {}) {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const tuples = [];

    batch.forEach((row, idx) => {
      const base = idx * COLUMNS.length;
      tuples.push(`(${COLUMNS.map((_, c) => `$${base + c + 1}`).join(',')})`);
      for (const col of COLUMNS) values.push(row[col] ?? null);
    });

    const sql = `
      INSERT INTO adex_data (${COLUMNS.join(',')})
      VALUES ${tuples.join(',')}
      ON CONFLICT (month, advertiser, brand, product2) DO UPDATE SET
        ${UPDATE_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(',\n        ')},
        synced_at = now()
    `;
    const result = await client.query(sql, values);
    upserted += result.rowCount ?? batch.length;
  }
  return upserted;
}

/** Distinct filter values for the in-app filter controls. */
export async function adexFacets() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT array_agg(DISTINCT sector   ORDER BY sector)   FROM adex_data WHERE sector   IS NOT NULL) AS sectors,
      (SELECT array_agg(DISTINCT category ORDER BY category) FROM adex_data WHERE category IS NOT NULL) AS categories,
      (SELECT min(month) FROM adex_data) AS min_month,
      (SELECT max(month) FROM adex_data) AS max_month,
      (SELECT count(*)   FROM adex_data) AS row_count
  `);
  const r = rows[0] || {};
  return {
    sectors: r.sectors || [],
    categories: r.categories || [],
    minMonth: r.min_month || null,
    maxMonth: r.max_month || null,
    rowCount: Number(r.row_count || 0),
  };
}

export const ADEX_COLUMNS = COLUMNS;
