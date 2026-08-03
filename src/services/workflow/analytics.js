import { pool } from '../../db.js';

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
