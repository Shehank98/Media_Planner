// ---------------------------------------------------------------------------
// Channel identity.
//
// Every MICOS dataset and the media watch log key on the channel, and the same
// channel is written inconsistently across exports ("HIRU TV", "Hiru TV").
// tv_channels is the single place that identity is resolved; everything else
// stores channel_id.
//
// The ratings, day-part, spot and cost tables are written by micosRepo.js.
// ---------------------------------------------------------------------------

const CHANNEL_BATCH = 200;

/**
 * Postgres refuses an ON CONFLICT statement whose own VALUES list contains the
 * same key twice ("cannot affect row a second time"). That happens whenever an
 * upload names one channel from several sheets at once, so deduping here keeps
 * the invariant true for every caller.
 */
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
    // Later mentions fill gaps but never overwrite a value already supplied.
    for (const field of ['language', 'category', 'reach_notes', 'rate_card_ref', 'raw']) {
      existing[field] ??= channel[field];
    }
  }
  return [...byKey.values()];
}

/**
 * Upsert channels on channel_name and return a lowercased-name -> id map.
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

export async function tvFacets(pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT array_agg(DISTINCT channel_name ORDER BY channel_name) FROM tv_channels) AS channels,
      (SELECT array_agg(DISTINCT language ORDER BY language)
         FROM tv_channels WHERE language IS NOT NULL) AS languages,
      (SELECT count(*) FROM tv_channels) AS channel_count
  `);
  const r = rows[0] || {};
  return {
    channels: r.channels || [],
    languages: r.languages || [],
    channelCount: Number(r.channel_count || 0),
  };
}
