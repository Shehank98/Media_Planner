import { pool } from '../../db.js';
import { loadDaypartBoundaries } from './repo.js';

// ---------------------------------------------------------------------------
// Step 1 (advertiser/competitor picker) and Step 2 (competitor behaviour).
//
// All aggregation is SQL - the Gemini layer only ever sees these rolled-up
// numbers, never raw rows. Everything is scoped to live rows (deleted_at IS
// NULL) and to the advertiser + competitor set chosen in Step 1.
// ---------------------------------------------------------------------------

/** Distinct advertisers in live data, for the Step 1 picker. */
export async function listAdvertisers({ from = null, to = null } = {}) {
  const { rows } = await pool.query(
    `SELECT advertiser, count(*)::int AS ads, round(sum(cost)::numeric, 0) AS cost
       FROM media_watch_spots
      WHERE deleted_at IS NULL AND COALESCE(advertiser, '') <> ''
        AND ($1::date IS NULL OR aired_on >= $1)
        AND ($2::date IS NULL OR aired_on <= $2)
      GROUP BY advertiser
      ORDER BY sum(cost) DESC NULLS LAST`,
    [from, to],
  );
  return rows;
}

/**
 * Step 2: how the advertiser and each competitor behave over the set.
 *
 * @param {Object} args
 * @param {string[]} args.advertisers  your advertiser + selected competitors
 * @param {string}  [args.channel]     limit to one channel (Step 3 drill-in)
 */
export async function competitorBehaviour({ advertisers = [], channel = null, from = null, to = null }) {
  const set = advertisers.filter(Boolean);
  if (!set.length) {
    return { advertisers: [], set_totals: { ads: 0, cost: 0 }, by_channel: [], by_program: [], data_notes: [] };
  }
  const args = [set, channel, from, to];
  const where = `deleted_at IS NULL AND advertiser = ANY($1::text[])
    AND ($2::text IS NULL OR channel_name = $2)
    AND ($3::date IS NULL OR aired_on >= $3)
    AND ($4::date IS NULL OR aired_on <= $4)`;

  const summary = await pool.query(
    `SELECT advertiser,
            count(*)::int AS ads,
            round(sum(cost)::numeric, 2) AS cost,
            count(*) FILTER (WHERE ad_category = 'Value Addition')::int AS va_ads,
            round(coalesce(sum(cost) FILTER (WHERE ad_category = 'Value Addition'), 0)::numeric, 2) AS va_cost,
            count(*) FILTER (WHERE ad_category = 'Spot')::int AS spot_ads,
            round(coalesce(sum(cost) FILTER (WHERE ad_category = 'Spot'), 0)::numeric, 2) AS spot_cost,
            count(*) FILTER (WHERE daypart = 'PT')::int AS pt_ads,
            round(coalesce(sum(cost) FILTER (WHERE daypart = 'PT'), 0)::numeric, 2) AS pt_cost,
            count(*) FILTER (WHERE daypart = 'Non-PT')::int AS npt_ads,
            round(coalesce(sum(cost) FILTER (WHERE daypart = 'Non-PT'), 0)::numeric, 2) AS npt_cost
       FROM media_watch_spots
      WHERE ${where}
      GROUP BY advertiser`,
    args,
  );

  const byChannel = await pool.query(
    `SELECT advertiser, channel_name,
            count(*)::int AS ads, round(sum(cost)::numeric, 2) AS cost
       FROM media_watch_spots
      WHERE ${where}
      GROUP BY advertiser, channel_name
      ORDER BY sum(cost) DESC NULLS LAST`,
    args,
  );

  const byProgram = await pool.query(
    `SELECT advertiser, channel_name, programme_name,
            count(*)::int AS ads, round(sum(cost)::numeric, 2) AS cost
       FROM media_watch_spots
      WHERE ${where}
      GROUP BY advertiser, channel_name, programme_name
      ORDER BY sum(cost) DESC NULLS LAST`,
    args,
  );

  const setAds = summary.rows.reduce((a, r) => a + Number(r.ads || 0), 0);
  const setCost = summary.rows.reduce((a, r) => a + Number(r.cost || 0), 0);
  const pct = (n, d) => (d ? +((Number(n) / d) * 100).toFixed(1) : 0);

  const perAdvertiser = summary.rows.map((r) => ({
    advertiser: r.advertiser,
    ads: Number(r.ads),
    cost: Number(r.cost) || 0,
    value_addition: { ads: Number(r.va_ads), cost: Number(r.va_cost) || 0 },
    spot: { ads: Number(r.spot_ads), cost: Number(r.spot_cost) || 0 },
    pt: { ads: Number(r.pt_ads), cost: Number(r.pt_cost) || 0 },
    non_pt: { ads: Number(r.npt_ads), cost: Number(r.npt_cost) || 0 },
    // Share of the set: SOV by ad count, SOS by monitored spend.
    share_of_voice_pct: pct(r.ads, setAds),
    share_of_spend_pct: pct(r.cost, setCost),
  })).sort((a, b) => b.cost - a.cost);

  const notes = [];
  const missingAdvertisers = set.filter((a) => !summary.rows.some((r) => r.advertiser === a));
  if (missingAdvertisers.length) {
    notes.push(`No spots found for: ${missingAdvertisers.join(', ')} (in this period/channel).`);
  }

  return {
    advertisers: perAdvertiser,
    set_totals: { ads: setAds, cost: +setCost.toFixed(2) },
    by_channel: byChannel.rows.map(numify),
    by_program: byProgram.rows.map(numify),
    data_notes: notes,
  };
}

function numify(r) {
  return { ...r, ads: Number(r.ads), cost: Number(r.cost) || 0 };
}

/**
 * Step 3: top channels by Share of Audience, each with the competitor set's
 * behaviour on that channel and the total monitored spend there.
 *
 * @param {Object} args
 * @param {string[]} args.advertisers  advertiser + competitor set
 * @param {number}  [args.limit]       how many channels (default 10)
 */
export async function topChannels({ advertisers = [], limit = 10, from = null, to = null }) {
  const set = advertisers.filter(Boolean);

  // SOA ranking from the channel-summary (A1) data.
  const ranked = await pool.query(
    `SELECT c.channel_name, max(p.share_of_audience) AS soa
       FROM tv_channel_performance p JOIN tv_channels c ON c.id = p.channel_id
      GROUP BY c.channel_name
      ORDER BY max(p.share_of_audience) DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, Math.min(50, limit))],
  );
  const channels = ranked.rows.map((r) => r.channel_name);
  if (!channels.length) return { channels: [], data_notes: ['No channel summary (A1) data loaded.'] };

  // Total monitored spend on each channel (all advertisers), from media watch.
  const spend = await pool.query(
    `SELECT channel_name, count(*)::int AS ads, round(sum(cost)::numeric, 0) AS spend
       FROM media_watch_spots
      WHERE deleted_at IS NULL AND channel_name = ANY($1::text[])
        AND ($2::date IS NULL OR aired_on >= $2) AND ($3::date IS NULL OR aired_on <= $3)
      GROUP BY channel_name`,
    [channels, from, to],
  );
  const spendByChannel = new Map(spend.rows.map((r) => [r.channel_name, r]));

  // The set's per-advertiser behaviour on each channel.
  const breakdown = set.length ? await pool.query(
    `SELECT channel_name, advertiser,
            count(*)::int AS ads, round(sum(cost)::numeric, 2) AS cost,
            count(*) FILTER (WHERE ad_category = 'Value Addition')::int AS va_ads,
            count(*) FILTER (WHERE ad_category = 'Spot')::int AS spot_ads,
            count(*) FILTER (WHERE daypart = 'PT')::int AS pt_ads,
            count(*) FILTER (WHERE daypart = 'Non-PT')::int AS npt_ads,
            round(coalesce(sum(cost) FILTER (WHERE daypart = 'PT'), 0)::numeric, 0) AS pt_cost,
            round(coalesce(sum(cost) FILTER (WHERE daypart = 'Non-PT'), 0)::numeric, 0) AS npt_cost
       FROM media_watch_spots
      WHERE deleted_at IS NULL AND channel_name = ANY($1::text[]) AND advertiser = ANY($2::text[])
        AND ($3::date IS NULL OR aired_on >= $3) AND ($4::date IS NULL OR aired_on <= $4)
      GROUP BY channel_name, advertiser`,
    [channels, set, from, to],
  ) : { rows: [] };

  const byChannel = new Map();
  for (const r of breakdown.rows) {
    if (!byChannel.has(r.channel_name)) byChannel.set(r.channel_name, []);
    byChannel.get(r.channel_name).push({
      advertiser: r.advertiser,
      ads: Number(r.ads), cost: Number(r.cost) || 0,
      value_addition_ads: Number(r.va_ads), spot_ads: Number(r.spot_ads),
      pt: { ads: Number(r.pt_ads), cost: Number(r.pt_cost) || 0 },
      non_pt: { ads: Number(r.npt_ads), cost: Number(r.npt_cost) || 0 },
    });
  }

  return {
    channels: ranked.rows.map((r, i) => {
      const s = spendByChannel.get(r.channel_name);
      return {
        rank: i + 1,
        channel: r.channel_name,
        share_of_audience: r.soa === null ? null : Number(r.soa),
        observed_spend: s ? Number(s.spend) : 0,
        observed_ads: s ? Number(s.ads) : 0,
        competitors: (byChannel.get(r.channel_name) || []).sort((a, b) => b.cost - a.cost),
      };
    }),
    data_notes: [],
  };
}

/**
 * Step 4: the programme basket for the chosen channels, split PT / Non-PT.
 *
 * Rating comes from the top-programmes sheet; PT/Non-PT is read from the
 * programme's own air time (media watch Prog_time), and each programme carries
 * how the competitor set behaved on it.
 */
export async function programmeBasket({ channels = [], advertisers = [], from = null, to = null }) {
  const chans = channels.filter(Boolean);
  if (!chans.length) return { channels: [], data_notes: ['No channels selected.'] };
  const set = advertisers.filter(Boolean);

  const rated = await pool.query(
    `SELECT c.channel_name, r.programme_name, max(r.trp) AS avg_rating
       FROM tv_programme_ratings r JOIN tv_channels c ON c.id = r.channel_id
      WHERE c.channel_name = ANY($1::text[]) AND r.trp IS NOT NULL
      GROUP BY c.channel_name, r.programme_name`,
    [chans],
  );

  // Programme daypart from Prog_time, using the configured PT boundary.
  const { ptStartHour, ptEndHour } = await loadDaypartBoundaries();
  const s = Math.trunc(ptStartHour);
  const e = Math.trunc(ptEndHour);
  const test = e > s ? `hh >= ${s} AND hh < ${e}` : `hh >= ${s} OR hh < ${e}`;
  const dayparts = await pool.query(
    `SELECT channel_name, programme_name,
            CASE WHEN ${test} THEN 'PT' ELSE 'Non-PT' END AS daypart, count(*)::int AS n
       FROM (
         SELECT channel_name, programme_name, split_part(prog_time, ':', 1)::int AS hh
           FROM media_watch_spots
          WHERE deleted_at IS NULL AND channel_name = ANY($1::text[])
            AND prog_time ~ '^[0-9]{1,2}:'
       ) x
      GROUP BY channel_name, programme_name, daypart`,
    [chans],
  );
  const dpVotes = new Map();
  for (const r of dayparts.rows) {
    const key = `${r.channel_name}|${r.programme_name}`;
    const cur = dpVotes.get(key) || {};
    cur[r.daypart] = (cur[r.daypart] || 0) + Number(r.n);
    dpVotes.set(key, cur);
  }
  const daypartOf = (channel, programme) => {
    const v = dpVotes.get(`${channel}|${programme}`);
    if (!v) return null;
    return (v.PT || 0) >= (v['Non-PT'] || 0) ? 'PT' : 'Non-PT';
  };

  // Competitor behaviour per programme for the set.
  const comp = set.length ? await pool.query(
    `SELECT channel_name, programme_name, advertiser,
            count(*)::int AS ads, round(sum(cost)::numeric, 0) AS cost
       FROM media_watch_spots
      WHERE deleted_at IS NULL AND channel_name = ANY($1::text[]) AND advertiser = ANY($2::text[])
        AND ($3::date IS NULL OR aired_on >= $3) AND ($4::date IS NULL OR aired_on <= $4)
      GROUP BY channel_name, programme_name, advertiser`,
    [chans, set, from, to],
  ) : { rows: [] };
  const compByProg = new Map();
  for (const r of comp.rows) {
    const key = `${r.channel_name}|${r.programme_name}`;
    if (!compByProg.has(key)) compByProg.set(key, []);
    compByProg.get(key).push({ advertiser: r.advertiser, ads: Number(r.ads), cost: Number(r.cost) || 0 });
  }

  const byChannel = new Map();
  for (const r of rated.rows) {
    const key = `${r.channel_name}|${r.programme_name}`;
    const programme = {
      programme_name: r.programme_name,
      avg_rating: r.avg_rating === null ? null : Number(r.avg_rating),
      daypart: daypartOf(r.channel_name, r.programme_name),
      competitors: (compByProg.get(key) || []).sort((a, b) => b.ads - a.ads),
    };
    if (!byChannel.has(r.channel_name)) byChannel.set(r.channel_name, { pt: [], non_pt: [], unknown: [] });
    const bucket = programme.daypart === 'PT' ? 'pt' : programme.daypart === 'Non-PT' ? 'non_pt' : 'unknown';
    byChannel.get(r.channel_name)[bucket].push(programme);
  }

  const sortRating = (a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0);
  const notes = [];
  const result = [...byChannel.entries()].map(([channel, b]) => {
    if (b.unknown.length) {
      notes.push(`${b.unknown.length} programme(s) on ${channel} have no Prog_time in the data, so PT/Non-PT is unknown.`);
    }
    return {
      channel,
      pt_programmes: b.pt.sort(sortRating),
      non_pt_programmes: b.non_pt.sort(sortRating),
      unclassified_programmes: b.unknown.sort(sortRating),
    };
  });
  return { channels: result, data_notes: notes };
}
