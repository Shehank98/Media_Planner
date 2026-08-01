import { withTransaction } from '../db.js';

// ---------------------------------------------------------------------------
// Persistence for channel/TVR data extracted from session uploads.
//
// Only the extracted numbers live on - the uploaded workbook is a Buffer that
// is dropped as soon as these functions return (see routes/uploads.js).
// ---------------------------------------------------------------------------

const CHANNEL_BATCH = 200;
const RATING_BATCH = 500;

// Postgres refuses an ON CONFLICT statement whose own VALUES list contains the
// same key twice ("cannot affect row a second time"). That happens whenever a
// planner uploads the channel workbook and the ratings workbook together - the
// ratings sheet names channels too. Deduping here rather than at the call site
// keeps the invariant true for every caller, including future ones.
function dedupeChannels(channels) {
  const byKey = new Map();
  for (const channel of channels) {
    if (!channel?.channel_name) continue;
    const key = channel.channel_name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...channel });
      continue;
    }
    // Later mentions fill gaps but never overwrite a value already supplied -
    // the channel master workbook is richer than a ratings sheet's name column.
    for (const field of ['language', 'category', 'reach_notes', 'rate_card_ref', 'raw']) {
      existing[field] ??= channel[field];
    }
  }
  return [...byKey.values()];
}

/** Same protection for ratings: two uploads can cover an overlapping period. */
function dedupeRatings(ratings) {
  const byKey = new Map();
  for (const r of ratings) {
    if (!r?.channel_id || !r.programme_name) continue;
    const key = [
      r.channel_id,
      r.programme_name.toLowerCase(),
      r.day_part || '',
      r.target_audience || '',
      r.period_start || '',
      r.period_end || '',
    ].join('|');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r });
      continue;
    }
    existing.grp ??= r.grp;
    existing.trp ??= r.trp;
    existing.avg_duration_secs ??= r.avg_duration_secs;
  }
  return [...byKey.values()];
}

/**
 * Upsert channels on channel_name and return a name -> id map.
 *
 * COALESCE on update so a later upload that omits, say, the language column
 * doesn't blank out a value an earlier upload supplied.
 */
export async function upsertChannels(channels, client) {
  const ids = new Map();
  const deduped = dedupeChannels(channels);
  if (!deduped.length) return ids;

  for (let i = 0; i < deduped.length; i += CHANNEL_BATCH) {
    const batch = deduped.slice(i, i + CHANNEL_BATCH);
    const values = [];
    const tuples = [];
    batch.forEach((c, idx) => {
      const b = idx * 6;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      values.push(
        c.channel_name,
        c.language ?? null,
        c.category ?? null,
        c.reach_notes ?? null,
        c.rate_card_ref ?? null,
        c.raw ? JSON.stringify(c.raw) : null,
      );
    });

    const { rows } = await client.query(
      `INSERT INTO tv_channels (channel_name, language, category, reach_notes, rate_card_ref, raw)
       VALUES ${tuples.join(',')}
       ON CONFLICT (channel_name) DO UPDATE SET
         language      = COALESCE(EXCLUDED.language, tv_channels.language),
         category      = COALESCE(EXCLUDED.category, tv_channels.category),
         reach_notes   = COALESCE(EXCLUDED.reach_notes, tv_channels.reach_notes),
         rate_card_ref = COALESCE(EXCLUDED.rate_card_ref, tv_channels.rate_card_ref),
         raw           = COALESCE(EXCLUDED.raw, tv_channels.raw)
       RETURNING id, channel_name`,
      values,
    );
    for (const row of rows) ids.set(row.channel_name.toLowerCase(), row.id);
  }
  return ids;
}

/** Resolve channel ids for names, creating stub rows for any not yet known. */
export async function ensureChannels(names, client) {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return new Map();
  return upsertChannels(unique.map((channel_name) => ({ channel_name })), client);
}

export async function upsertRatings(ratings, channelIds, client) {
  let upserted = 0;
  const resolved = ratings
    .map((r) => ({ ...r, channel_id: channelIds.get(r.channel_name.toLowerCase()) }))
    .filter((r) => r.channel_id);
  const rows = dedupeRatings(resolved);

  for (let i = 0; i < rows.length; i += RATING_BATCH) {
    const batch = rows.slice(i, i + RATING_BATCH);
    const values = [];
    const tuples = [];
    batch.forEach((r, idx) => {
      const b = idx * 9;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`,
      );
      values.push(
        r.channel_id,
        r.programme_name,
        r.day_part ?? null,
        r.target_audience ?? null,
        r.grp ?? null,
        r.trp ?? null,
        r.avg_duration_secs ?? null,
        r.period_start ?? null,
        r.period_end ?? null,
      );
    });

    // The conflict target must repeat the unique index's COALESCE expressions
    // verbatim for Postgres to match it.
    const result = await client.query(
      `INSERT INTO tv_programme_ratings
         (channel_id, programme_name, day_part, target_audience,
          grp, trp, avg_duration_secs, period_start, period_end)
       VALUES ${tuples.join(',')}
       ON CONFLICT (channel_id, programme_name, COALESCE(day_part, ''),
                    COALESCE(target_audience, ''),
                    COALESCE(period_start, DATE '0001-01-01'),
                    COALESCE(period_end, DATE '0001-01-01'))
       DO UPDATE SET
         grp               = COALESCE(EXCLUDED.grp, tv_programme_ratings.grp),
         trp               = COALESCE(EXCLUDED.trp, tv_programme_ratings.trp),
         avg_duration_secs = COALESCE(EXCLUDED.avg_duration_secs, tv_programme_ratings.avg_duration_secs)`,
      values,
    );
    upserted += result.rowCount ?? batch.length;
  }
  return { upserted, skipped: ratings.length - rows.length };
}

/** Persist a parsed upload in one transaction: all of it lands, or none. */
export async function persistTvUpload({ channels = [], ratings = [] }) {
  return withTransaction(async (client) => {
    const channelIds = await upsertChannels(channels, client);
    // Ratings can name channels the channel workbook didn't include.
    const missing = ratings
      .map((r) => r.channel_name)
      .filter((n) => n && !channelIds.has(n.toLowerCase()));
    if (missing.length) {
      const extra = await ensureChannels(missing, client);
      for (const [k, v] of extra) channelIds.set(k, v);
    }
    const { upserted, skipped } = await upsertRatings(ratings, channelIds, client);
    return {
      channelsUpserted: channelIds.size,
      ratingsUpserted: upserted,
      // Rows dropped because their channel could not be resolved at all.
      ratingsSkipped: skipped < 0 ? 0 : skipped,
    };
  });
}

export async function tvFacets(pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT array_agg(DISTINCT language ORDER BY language)
         FROM tv_channels WHERE language IS NOT NULL) AS languages,
      (SELECT array_agg(DISTINCT target_audience ORDER BY target_audience)
         FROM tv_programme_ratings WHERE target_audience IS NOT NULL) AS audiences,
      (SELECT count(*) FROM tv_channels) AS channel_count,
      (SELECT count(*) FROM tv_programme_ratings) AS rating_count
  `);
  const r = rows[0] || {};
  return {
    languages: r.languages || [],
    audiences: r.audiences || [],
    channelCount: Number(r.channel_count || 0),
    ratingCount: Number(r.rating_count || 0),
  };
}
