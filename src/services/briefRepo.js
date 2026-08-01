import { pool } from '../db.js';

// Briefs are only written once a human has confirmed the parsed fields
// (Section 5, step 2) - the parse endpoint returns a proposal and saves nothing.

/** Build a Postgres tstzrange literal, or null when the period is unknown. */
function periodRange(start, end) {
  if (!start && !end) return null;
  // '[)' - inclusive start, exclusive end, the usual convention for date spans.
  return `[${start ? `${start} 00:00:00+00` : ''},${end ? `${end} 23:59:59+00` : ''})`;
}

export async function insertBrief(fields) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_briefs
       (brand, advertiser, objective, target_audience, campaign_period,
        budget_lkr_lakhs, medium_split, language, territory, source_file)
     VALUES ($1,$2,$3,$4,$5::tstzrange,$6,$7::jsonb,$8,$9,$10)
     RETURNING *`,
    [
      fields.brand ?? null,
      fields.advertiser ?? null,
      fields.objective ?? null,
      fields.target_audience ?? null,
      periodRange(fields.period_start, fields.period_end),
      fields.budget_lkr_lakhs ?? null,
      fields.medium_split ? JSON.stringify(fields.medium_split) : null,
      fields.language ?? null,
      fields.territory ?? null,
      fields.source_file ?? null,
    ],
  );
  return hydrate(rows[0]);
}

export async function updateBrief(id, fields) {
  const { rows } = await pool.query(
    `UPDATE campaign_briefs SET
       brand = $2, advertiser = $3, objective = $4, target_audience = $5,
       campaign_period = $6::tstzrange, budget_lkr_lakhs = $7,
       medium_split = $8::jsonb, language = $9, territory = $10
     WHERE id = $1
     RETURNING *`,
    [
      id,
      fields.brand ?? null,
      fields.advertiser ?? null,
      fields.objective ?? null,
      fields.target_audience ?? null,
      periodRange(fields.period_start, fields.period_end),
      fields.budget_lkr_lakhs ?? null,
      fields.medium_split ? JSON.stringify(fields.medium_split) : null,
      fields.language ?? null,
      fields.territory ?? null,
    ],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function getBrief(id) {
  const { rows } = await pool.query('SELECT * FROM campaign_briefs WHERE id = $1', [id]);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function listBriefs(limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, brand, advertiser, objective, budget_lkr_lakhs, campaign_period, uploaded_at
       FROM campaign_briefs ORDER BY uploaded_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(hydrate);
}

/**
 * Flatten campaign_period back into period_start / period_end.
 *
 * Everything downstream (aggregation windows, chart labels, the PDF cover)
 * wants plain dates, not range syntax.
 */
function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  const range = row.campaign_period;
  out.period_start = null;
  out.period_end = null;

  if (range && typeof range === 'object') {
    // node-postgres may hand back a parsed range object.
    out.period_start = toIsoDate(range.lower);
    out.period_end = toIsoDate(range.upper);
  } else if (typeof range === 'string') {
    const m = range.match(/^[[(]"?([^",]*)"?,"?([^",]*)"?[\])]$/);
    if (m) {
      out.period_start = toIsoDate(m[1]);
      out.period_end = toIsoDate(m[2]);
    }
  }
  return out;
}

function toIsoDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
