import { pool } from '../db.js';
import { tokens } from '../util/normalise.js';

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

  const [competitors, ownBrand, byQuarterTotals, programmes, channels] = await Promise.all([
    competitorSpendByQuarter(scope, brief, window),
    ownBrandTrend(brief, window),
    categoryTotalsByQuarter(scope, window),
    topProgrammes(brief, filters, programmeLimit),
    channelSummary(brief, filters),
  ]);

  const notes = [];
  if (!scope.category && !scope.sector) {
    notes.push(
      "The brief's brand was not found in the adex data, so the competitor set could not be " +
      'narrowed to its category or sector. Competitor figures below are unfiltered.',
    );
  }
  if (!competitors.length) notes.push('No competitor spend rows matched this category/sector and period.');
  if (!ownBrand.length) notes.push(`No historical adex spend found for brand "${brief.brand ?? ''}".`);
  if (!programmes.rows.length) {
    notes.push(
      'No programme rating data is available for this brief. Upload a TVR/channel workbook ' +
      'before relying on the programme lineup.',
    );
  } else if (programmes.audienceFallback) {
    notes.push(
      `No ratings matched the target audience "${brief.target_audience}". The programme list ` +
      'below covers all available audiences and is not audience-specific.',
    );
  }
  if (programmes.languageFallback) {
    notes.push(
      `No channels matched language "${brief.language}". The programme list covers all languages.`,
    );
  }

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
      language: brief.language ?? null,
    },
    competitor_spend_by_quarter: competitors,
    own_brand_trend: ownBrand,
    category_totals_by_quarter: byQuarterTotals,
    programme_ratings: programmes.rows,
    channels,
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

// --- ratings aggregations --------------------------------------------------

/**
 * Split a free-text audience into descriptor and age tokens.
 *
 * "Females 15-40" -> descriptors ["female"], ages ["15", "40"]. Descriptors are
 * de-pluralised so "Female" and "Females" match each other.
 */
function audienceTerms(audience) {
  const descriptors = [];
  const ages = [];
  for (const token of tokens(audience)) {
    if (/\d/.test(token)) ages.push(token);
    else descriptors.push(token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token);
  }
  return { descriptors, ages };
}

/** Escape a token for use inside a Postgres regex ('15+' would otherwise break it). */
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * Top programmes by GRP (falling back to TRP) for the brief's audience and
 * language.
 *
 * Audience strings are free text on both sides ("Females 15-40" vs "F 15-40"),
 * so matching is token-based - but it has to be tight in two specific ways:
 *
 *  - every descriptor must match, not merely one token. Matching on any token
 *    means "Males 15-40" satisfies a brief for "Females 15-40" on the shared
 *    "15", which quietly hands the planner the wrong demographic.
 *  - matching is word-boundary, not substring, because "male" is a substring of
 *    "female" and would pull the opposite gender in.
 *
 * The filter relaxes in stages - drop the age band, then the descriptor - and
 * every relaxation is reported so a shortlist for a different audience is
 * declared rather than passed off as targeted.
 */
async function topProgrammes(brief, filters, limit) {
  const audience = filters.target_audience || brief.target_audience || null;
  const language = filters.language || brief.language || null;
  const { descriptors, ages } = audienceTerms(audience);

  // Every term in the array must word-match, or the row is excluded.
  const attempt = async (terms, useLanguage) => {
    const { rows } = await pool.query(
      `SELECT c.channel_name,
              c.language,
              c.category AS channel_category,
              r.programme_name,
              r.day_part,
              r.target_audience,
              r.grp,
              r.trp,
              r.avg_duration_secs,
              r.period_start,
              r.period_end
         FROM tv_programme_ratings r
         JOIN tv_channels c ON c.id = r.channel_id
        WHERE (r.grp IS NOT NULL OR r.trp IS NOT NULL)
          AND ($1::text[] IS NULL OR (
                r.target_audience IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM unnest($1::text[]) AS tok
                   WHERE r.target_audience !~* ('\\m' || tok || 's?')
                )
              ))
          AND ($2::boolean IS NOT TRUE OR c.language ILIKE $3)
        ORDER BY COALESCE(r.grp, r.trp) DESC NULLS LAST
        LIMIT $4`,
      [
        terms && terms.length ? terms.map(escapeRegex) : null,
        useLanguage,
        language ? `%${language}%` : null,
        limit,
      ],
    );
    return rows;
  };

  const full = [...descriptors, ...ages];
  const wantLanguage = Boolean(language);

  // Ordered from most to least specific. Language is relaxed before the
  // audience: an audience-correct list in the wrong language is more useful to
  // a planner than the reverse.
  const stages = [
    { terms: full, language: wantLanguage, audienceFallback: false, languageFallback: false },
    { terms: full, language: false, audienceFallback: false, languageFallback: true },
    { terms: descriptors, language: wantLanguage, audienceFallback: true, languageFallback: false },
    { terms: descriptors, language: false, audienceFallback: true, languageFallback: true },
    { terms: null, language: wantLanguage, audienceFallback: true, languageFallback: false },
    { terms: null, language: false, audienceFallback: true, languageFallback: true },
  ];

  let lastEmpty = { audienceFallback: full.length > 0, languageFallback: wantLanguage };
  for (const stage of stages) {
    // Skip stages that aren't actually a relaxation of the previous one.
    if (stage.language && !wantLanguage) continue;
    if (stage.terms && !stage.terms.length) continue;

    const rows = await attempt(stage.terms, stage.language);
    if (rows.length) {
      return {
        rows,
        // Only a genuine narrowing of the audience counts as targeted; losing
        // the age band still means the shortlist isn't what was asked for.
        audienceFallback: stage.audienceFallback || (full.length > 0 && !stage.terms),
        languageFallback: stage.languageFallback && wantLanguage,
      };
    }
    lastEmpty = { audienceFallback: stage.audienceFallback, languageFallback: stage.languageFallback };
  }

  return { rows: [], ...lastEmpty };
}

/** Channel-level roll-up, so the model can reason above programme level too. */
async function channelSummary(brief, filters) {
  const language = filters.language || brief.language || null;
  const { rows } = await pool.query(
    `SELECT c.channel_name,
            c.language,
            c.category,
            c.reach_notes,
            count(r.id)                        AS programmes_rated,
            round(avg(COALESCE(r.grp, r.trp))::numeric, 2) AS avg_rating,
            round(max(COALESCE(r.grp, r.trp))::numeric, 2) AS peak_rating
       FROM tv_channels c
       LEFT JOIN tv_programme_ratings r ON r.channel_id = c.id
      WHERE ($1::text IS NULL OR c.language ILIKE $1)
      GROUP BY c.id, c.channel_name, c.language, c.category, c.reach_notes
      ORDER BY avg_rating DESC NULLS LAST
      LIMIT 40`,
    [language ? `%${language}%` : null],
  );
  return rows;
}
