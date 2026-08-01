import { withTransaction } from '../db.js';
import { upsertChannels } from './tvRepo.js';

// ---------------------------------------------------------------------------
// Persistence for MICOS dashboard exports and media watch spot logs.
//
// Session-only, like every upload: the workbook is a Buffer that is dropped
// once these functions return. Only the extracted numbers live on.
// ---------------------------------------------------------------------------

const BATCH = 500;

/** Generic batched upsert. Column order drives the placeholder generation. */
async function upsertBatch(client, { table, columns, conflict, update, rows }) {
  let affected = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const tuples = [];
    batch.forEach((row, idx) => {
      const base = idx * columns.length;
      tuples.push(`(${columns.map((_, c) => `$${base + c + 1}`).join(',')})`);
      for (const col of columns) values.push(row[col] ?? null);
    });

    const setClause = update.length
      ? `DO UPDATE SET ${update.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
      : 'DO NOTHING';

    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(',')})
       VALUES ${tuples.join(',')}
       ON CONFLICT ${conflict} ${setClause}`,
      values,
    );
    affected += result.rowCount ?? batch.length;
  }
  return affected;
}

/**
 * Persist one MICOS export in a single transaction.
 *
 * @param {Object} parsed  output of parseMicosWorkbook
 * @param {Object} [opts]
 * @param {string} [opts.audienceOverride]  target group taken from a sibling
 *   file in the same upload, for exports whose Target sheet omits it
 */
export async function persistMicos(parsed, { audienceOverride = null } = {}) {
  const audience = parsed.meta.target_audience || audienceOverride || '';

  return withTransaction(async (client) => {
    // Every dataset keys on the channel, so resolve ids once up front.
    const names = new Set();
    for (const r of parsed.programmes) names.add(r.channel_name);
    for (const r of parsed.channelPerformance) names.add(r.channel_name);
    for (const r of parsed.channelDays) names.add(r.channel_name);
    for (const r of parsed.channelDayparts) names.add(r.channel_name);
    for (const r of parsed.spots) names.add(r.channel_name);

    const channelIds = await upsertChannels(
      [...names].filter(Boolean).map((channel_name) => ({ channel_name })),
      client,
    );
    const idOf = (name) => channelIds.get(String(name).toLowerCase());
    const withAudience = (row) => ({ ...row, target_audience: row.target_audience || audience });

    const counts = {};

    const programmes = parsed.programmes
      .map((r) => ({ ...withAudience(r), channel_id: idOf(r.channel_name) }))
      .filter((r) => r.channel_id);
    counts.programmes = await upsertBatch(client, {
      table: 'tv_programme_ratings',
      columns: [
        'channel_id', 'programme_name', 'day_part', 'target_audience', 'grp', 'trp',
        'avg_duration_secs', 'period_start', 'period_end',
        'programme_category', 'instances', 'total_reach', 'avg_reach', 'rank',
      ],
      conflict: `(channel_id, programme_name, COALESCE(day_part, ''), COALESCE(target_audience, ''),
                 COALESCE(period_start, DATE '0001-01-01'), COALESCE(period_end, DATE '0001-01-01'))`,
      update: ['trp', 'avg_duration_secs', 'programme_category', 'instances',
        'total_reach', 'avg_reach', 'rank'],
      rows: programmes,
    });

    const performance = parsed.channelPerformance
      .map((r) => ({ ...withAudience(r), channel_id: idOf(r.channel_name) }))
      .filter((r) => r.channel_id);
    counts.channelPerformance = await upsertBatch(client, {
      table: 'tv_channel_performance',
      columns: ['channel_id', 'target_audience', 'share_of_audience', 'total_ratings',
        'avg_daily_minutes', 'individual_reach', 'individual_reach_pct',
        'period_start', 'period_end'],
      conflict: `(channel_id, target_audience, COALESCE(period_start, DATE '0001-01-01'),
                 COALESCE(period_end, DATE '0001-01-01'))`,
      update: ['share_of_audience', 'total_ratings', 'avg_daily_minutes',
        'individual_reach', 'individual_reach_pct'],
      rows: performance,
    });

    // A2 (day of week) and A3 (day-part) share one table.
    const dayparts = [...parsed.channelDays, ...parsed.channelDayparts]
      .map((r) => ({ ...withAudience(r), channel_id: idOf(r.channel_name) }))
      .filter((r) => r.channel_id);
    counts.dayparts = await upsertBatch(client, {
      table: 'tv_channel_daypart',
      columns: ['channel_id', 'target_audience', 'day_of_week', 'day_group', 'time_of_day',
        'ratings', 'reach', 'reach_pct', 'period_start', 'period_end'],
      conflict: `(channel_id, target_audience, day_of_week, day_group, time_of_day,
                 COALESCE(period_start, DATE '0001-01-01'), COALESCE(period_end, DATE '0001-01-01'))`,
      update: ['ratings', 'reach', 'reach_pct'],
      rows: dayparts,
    });

    const spots = parsed.spots
      .map((r) => ({ ...withAudience(r), channel_id: idOf(r.channel_name) }))
      .filter((r) => r.channel_id);
    counts.spots = await upsertBatch(client, {
      table: 'tv_spot_grp',
      columns: ['aired_at', 'channel_id', 'programme_name', 'programme_category', 'category',
        'sub_category', 'brand', 'sub_brand', 'company', 'ad_type', 'ad_name',
        'duration_secs', 'not_rated', 'grp', 'reach', 'target_audience',
        'period_start', 'period_end'],
      conflict: `(aired_at, channel_id, brand, ad_name, COALESCE(duration_secs, -1), target_audience)`,
      update: ['programme_name', 'programme_category', 'category', 'sub_category',
        'sub_brand', 'company', 'ad_type', 'not_rated', 'grp', 'reach'],
      rows: spots,
    });

    await client.query(
      `INSERT INTO tv_report_meta
         (source_file, target_audience, period_start, period_end, exported_at, exported_by, sheets)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        parsed.meta.source_file, audience || null,
        parsed.meta.period_start, parsed.meta.period_end,
        parsed.meta.exported_at, parsed.meta.exported_by,
        JSON.stringify(parsed.sheets),
      ],
    );

    return { ...counts, channels: channelIds.size, target_audience: audience || null };
  });
}

/** Persist a media watch spot log. */
export async function persistMediaWatch(spots) {
  if (!spots.length) return { spots: 0 };
  return withTransaction(async (client) => {
    const upserted = await upsertBatch(client, {
      table: 'media_watch_spots',
      columns: ['medium', 'channel_name', 'programme_name', 'aired_on', 'day_of_week',
        'prog_time', 'advt_time', 'product_group', 'advertiser', 'product', 'advt_theme',
        'ad_pos', 'tot_ads', 'brk_no', 'pos_in_brk', 'ads_in_brk', 'language',
        'duration_secs', 'cost', 'source_file'],
      conflict: `(channel_name, programme_name, aired_on, advt_time,
                 COALESCE(product, ''), COALESCE(duration_secs, -1))`,
      update: ['medium', 'day_of_week', 'prog_time', 'product_group', 'advertiser',
        'advt_theme', 'ad_pos', 'tot_ads', 'brk_no', 'pos_in_brk', 'ads_in_brk',
        'language', 'cost', 'source_file'],
      rows: spots,
    });
    return { spots: upserted };
  });
}

/** What TVR/cost data is currently loaded - drives the UI's filter controls. */
export async function micosFacets(pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT array_agg(DISTINCT target_audience ORDER BY target_audience)
         FROM tv_programme_ratings WHERE COALESCE(target_audience,'') <> '') AS audiences,
      (SELECT array_agg(DISTINCT programme_category ORDER BY programme_category)
         FROM tv_programme_ratings WHERE programme_category IS NOT NULL) AS programme_categories,
      (SELECT array_agg(DISTINCT time_of_day ORDER BY time_of_day)
         FROM tv_channel_daypart WHERE time_of_day <> '') AS time_bands,
      (SELECT count(*) FROM tv_programme_ratings) AS programme_rows,
      (SELECT count(*) FROM tv_channel_daypart) AS daypart_rows,
      (SELECT count(*) FROM tv_spot_grp) AS spot_rows,
      (SELECT count(*) FROM media_watch_spots) AS media_watch_rows,
      (SELECT min(period_start) FROM tv_report_meta) AS period_start,
      (SELECT max(period_end) FROM tv_report_meta) AS period_end
  `);
  const r = rows[0] || {};
  return {
    audiences: r.audiences || [],
    programmeCategories: r.programme_categories || [],
    timeBands: r.time_bands || [],
    programmeRows: Number(r.programme_rows || 0),
    daypartRows: Number(r.daypart_rows || 0),
    spotRows: Number(r.spot_rows || 0),
    mediaWatchRows: Number(r.media_watch_rows || 0),
    periodStart: r.period_start || null,
    periodEnd: r.period_end || null,
  };
}
