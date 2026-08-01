import { pool } from '../db.js';
import { buildTvAggregates } from './tvAggregate.js';
// ---------------------------------------------------------------------------
// Pre-aggregation for the model payload (Section 5, step 3).
//
// The model never sees raw rows. At 30k+ adex rows that would be both
// impossible to fit in a modest num_ctx and useless to reason over, so
// everything is rolled up in Postgres first: competitor spend by brand and
// quarter, the own-brand trend, and a ranked programme shortlist.
//
// Quarters are derived from `month` with date_trunc rather than read from the
// `quarter` text column, because that column is free text from the source
// workbooks and is inconsistent across files. The label is generated here so
// sorting and grouping are reliable.
// ---------------------------------------------------------------------------
const DEFAULT_QUARTERS = 6;
const DEFAULT_PROGRAMME_LIMIT = 20;
const COMPETITOR_LIMIT = 12;
/**
 * Build the full aggregated payload for a brief.
 *
 * @param {Object} brief   confirmed brief fields
 * @param {Object} [opts]
 * @param {number} [opts.quarters]        how far back to look (spec: 4-6)
 * @param {number} [opts.programmeLimit]  shortlist size (spec: 15-20)
 * @param {Object} [opts.filters]         in-app filter overrides
 */
export async function buildAggregatedData(brief, opts = {}) {
  const quarters = clamp(opts.quarters ?? DEFAULT_QUARTERS, 1, 24);
  const programmeLimit = clamp(opts.programmeLimit ?? DEFAULT_PROGRAMME_LIMIT, 1, 100);
  const filters = opts.filters || {};
  const anchor = await resolveAnchorMonth(brief, filters);
  const window = anchorWindow(anchor, quarters);
  const scope = await resolveCategoryScope(brief, filters);
  const [competitors, ownBrand, byQuarterTotals, tv] = await Promise.all([
    competitorSpendByQuarter(scope, brief, window),
    ownBrandTrend(brief, window),
    categoryTotalsByQuarter(scope, window),
    // The MICOS datasets and the media watch cost log - which channel, which
    // programme, which day, which day-part, and what it costs.
    buildTvAggregates(brief, filters, programmeLimit),
  ]);
  const notes = [...tv.data_notes];
  if (!scope.category && !scope.sector) {
    notes.push(
      "The brief's brand was not found in the adex data, so the competitor set could not be " +
      'narrowed to its category or sector. Competitor figures below are unfiltered.',
    );
  }
  if (!competitors.length) notes.push('No competitor spend rows matched this category/sector and period.');
  if (!ownBrand.length) notes.push(`No historical adex spend found for brand "${brief.brand ?? ''}".`);
  return {
    scope: {
      brand: brief.brand ?? null,
      advertiser: brief.advertiser ?? null,
      category: scope.category,
      sector: scope.sector,
      quarters_covered: quarters,
      period_from: window.from,
      period_to: window.to,
      target_audience: brief.target_audience ?? null,
      audience_panel: tv.audience_panel,
      audience_matched: tv.audience_matched,
      language: brief.language ?? null,
      budget_lkr_lakhs: brief.budget_lkr_lakhs ?? null,
    },
    // Adex: category spend context, by quarter.
    competitor_spend_by_quarter: competitors,
    own_brand_trend: ownBrand,
    category_totals_by_quarter: byQuarterTotals,
    // MICOS: what the audience actually watches.
    programme_ratings: tv.programme_ratings,
    channel_performance: tv.channel_performance,
    best_days: tv.best_days,
    best_dayparts: tv.best_dayparts,
    // Media watch: what a spot actually costs.
    programme_rates: tv.programme_rates,
    // Spot-level competitive read at the slot the plan would occupy.
    competitor_spot_pressure: tv.competitor_spot_pressure,
    data_notes: notes,
  };
}
// --- scope resolution ------------------------------------------------------
function clamp(n, lo, hi) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
}
/**
 * Anchor the lookback window on the campaign start when it's inside the data,
 * otherwise on the newest month available - a brief for next quarter must not
 * produce an empty competitor read.
 */
async function resolveAnchorMonth(brief, filters) {
  const { rows } = await pool.query('SELECT max(month) AS latest FROM adex_data');
  const latest = rows[0]?.latest || null;
  const requested = filters.to || brief.period_start || null;
  if (requested && latest && requested <= latest) return requested;
  return latest;
}
function anchorWindow(anchorMonth, quarters) {
  if (!anchorMonth) return { from: null, to: null };
  const [y, m] = String(anchorMonth).split('-').map(Number);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const end = new Date(Date.UTC(y, quarterStartMonth - 1 + 3, 0)); // last day of anchor quarter
  const start = new Date(Date.UTC(y, quarterStartMonth - 1 - (quarters - 1) * 3, 1));
  return { from: iso(start), to: iso(end) };
}
const iso = (d) => d.toISOString().slice(0, 10);
/** Find the brand's category/sector from adex so competitors can be scoped. */
async function resolveCategoryScope(brief, filters) {
  if (filters.category || filters.sector) {
    return { category: filters.category || null, sector: filters.sector || null };
  }
  if (!brief.brand && !brief.advertiser) return { category: null, sector: null };
  const { rows } = await pool.query(
    `SELECT category, sector, count(*) AS n
       FROM adex_data
      WHERE ($1::text IS NOT NULL AND brand ILIKE $1)
         OR ($2::text IS NOT NULL AND advertiser ILIKE $2)
      GROUP BY category, sector
      ORDER BY n DESC
      LIMIT 1`,
    [brief.brand || null, brief.advertiser || null],
  );
  return { category: rows[0]?.category || null, sector: rows[0]?.sector || null };
}
// --- adex aggregations -----------------------------------------------------
const QUARTER_LABEL = `to_char(date_trunc('quarter', month), 'YYYY') || '-Q' || to_char(date_trunc('quarter', month), 'Q')`;
/**
 * Competitor spend by brand and quarter within the brief's category/sector.
 *
 * Limited to the top N brands by total spend so the payload stays small and the
 * model sees the brands that actually matter competitively.
 */
async function competitorSpendByQuarter(scope, brief, window) {
  const { rows } = await pool.query(
    `WITH scoped AS (
       SELECT brand, advertiser, month,
              COALESCE(tv_spend_000, 0)    AS tv,
              COALESCE(radio_spend_000, 0) AS radio,
              COALESCE(press_spend_000, 0) AS press,
              COALESCE(total_000, COALESCE(tv_spend_000,0) + COALESCE(radio_spend_000,0) + COALESCE(press_spend_000,0)) AS total
         FROM adex_data
        WHERE ($1::text IS NULL OR category = $1)
          AND ($2::text IS NULL OR sector   = $2)
          AND ($3::date IS NULL OR month   >= $3)
          AND ($4::date IS NULL OR month   <= $4)
          AND brand <> ''
          AND ($5::text IS NULL OR brand NOT ILIKE $5)
     ),
     top_brands AS (
       SELECT brand FROM scoped
        GROUP BY brand
        ORDER BY sum(total) DESC
        LIMIT $6
     )
     SELECT s.brand,
            ${QUARTER_LABEL.replaceAll('month', 's.month')} AS quarter,
            min(s.month) AS quarter_start,
            round(sum(s.tv)::numeric, 1)    AS tv_spend_000,
            round(sum(s.radio)::numeric, 1) AS radio_spend_000,
            round(sum(s.press)::numeric, 1) AS press_spend_000,
            round(sum(s.total)::numeric, 1) AS total_spend_000
       FROM scoped s
       JOIN top_brands t ON t.brand = s.brand
      GROUP BY s.brand, date_trunc('quarter', s.month)
      ORDER BY sum(s.total) DESC, quarter_start`,
    [scope.category, scope.sector, window.from, window.to, brief.brand || null, COMPETITOR_LIMIT],
  );
  return rows;
}
/** The brief's own brand, same shape, so the model can compare like with like. */
async function ownBrandTrend(brief, window) {
  if (!brief.brand) return [];
  const { rows } = await pool.query(
    `SELECT ${QUARTER_LABEL} AS quarter,
            min(month) AS quarter_start,
            round(sum(COALESCE(tv_spend_000,0))::numeric, 1)    AS tv_spend_000,
            round(sum(COALESCE(radio_spend_000,0))::numeric, 1) AS radio_spend_000,
            round(sum(COALESCE(press_spend_000,0))::numeric, 1) AS press_spend_000,
            round(sum(COALESCE(total_000, COALESCE(tv_spend_000,0)+COALESCE(radio_spend_000,0)+COALESCE(press_spend_000,0)))::numeric, 1) AS total_spend_000
       FROM adex_data
      WHERE brand ILIKE $1
        AND ($2::date IS NULL OR month >= $2)
        AND ($3::date IS NULL OR month <= $3)
      GROUP BY date_trunc('quarter', month)
      ORDER BY quarter_start`,
    [brief.brand, window.from, window.to],
  );
  return rows;
}
/** Category-level totals - the denominator for share-of-voice reasoning. */
async function categoryTotalsByQuarter(scope, window) {
  const { rows } = await pool.query(
    `SELECT ${QUARTER_LABEL} AS quarter,
            min(month) AS quarter_start,
            round(sum(COALESCE(total_000, COALESCE(tv_spend_000,0)+COALESCE(radio_spend_000,0)+COALESCE(press_spend_000,0)))::numeric, 1) AS total_spend_000,
            count(DISTINCT brand) AS active_brands
       FROM adex_data
      WHERE ($1::text IS NULL OR category = $1)
        AND ($2::text IS NULL OR sector   = $2)
        AND ($3::date IS NULL OR month   >= $3)
        AND ($4::date IS NULL OR month   <= $4)
      GROUP BY date_trunc('quarter', month)
      ORDER BY quarter_start`,
    [scope.category, scope.sector, window.from, window.to],
  );
  return rows;
}
// Ratings, day-parts and cost aggregations live in tvAggregate.js - they query
// the MICOS and media watch tables rather than adex, and are large enough to
// keep separate.
