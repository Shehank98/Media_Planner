// ---------------------------------------------------------------------------
// Chart data derivation (Section 5 step 6, feeding Section 6's charts).
//
// Computed in Node from the aggregates and the recommendation, then stored on
// plan_recommendations.chart_data. The Python report worker only draws what it
// is handed - it does no querying and no analysis of its own, so the numbers in
// the PDF are exactly the numbers that were audited into Postgres.
// ---------------------------------------------------------------------------


const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** One row per programme, from either the channel-first plan or a flat lineup. */
function plannedProgrammes(recommendation) {
  if (Array.isArray(recommendation?.lineup)) return recommendation.lineup;
  if (Array.isArray(recommendation?.channel_plan)) {
    return recommendation.channel_plan.flatMap((c) =>
      (c.programmes || []).map((p) => ({ channel: c.channel, ...p })));
  }
  if (Array.isArray(recommendation?.recommended_lineup)) {
    // Stored plans hold the channel-first structure under this column.
    return recommendation.recommended_lineup.flatMap((c) =>
      c?.programmes
        ? c.programmes.map((p) => ({ channel: c.channel, ...p }))
        : [c]);
  }
  return [];
}

/** Weekday names a day pattern covers, lowercased for comparison. */
function expandDayPattern(pattern) {
  const text = String(pattern || '').toLowerCase();
  if (!text) return [];
  if (/week\s*day|mon\s*[-–to]+\s*fri/.test(text)) return WEEKDAYS.slice(1, 6);
  if (/week\s*end|sat\s*[-–to]+\s*sun/.test(text)) return ['saturday', 'sunday'];
  return WEEKDAYS.filter((d) => text.includes(d.slice(0, 3)));
}

export function buildChartData(aggregated, recommendation, brief) {
  return {
    competitor_spend: competitorSpendSeries(aggregated),
    programme_ratings: programmeRatingSeries(aggregated, recommendation),
    // Where the buy sits across time belts, against where competitors already
    // are. This replaced the medium-split donut when the brief stopped
    // carrying TV/radio/press percentages.
    time_belts: timeBeltSeries(aggregated, recommendation),
    // Which days the audience is actually available - the evidence behind the
    // "day" column in the lineup.
    day_of_week: dayOfWeekSeries(aggregated, recommendation),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Ratings by day of week, for the channels the plan actually uses.
 *
 * Charting every loaded channel would be unreadable; the ones in the lineup are
 * the ones a reader needs to sanity-check the day choice against.
 */
function dayOfWeekSeries(aggregated, recommendation) {
  const rows = aggregated.best_days || [];
  const ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const programmes = plannedProgrammes(recommendation);
  const planned = new Set(programmes.map((i) => (i.channel || '').toLowerCase()).filter(Boolean));
  // Day patterns are ranges ("MON - FRI"), so expand them to actual weekdays
  // before deciding which columns to shade.
  const plannedDays = new Set();
  for (const item of programmes) {
    for (const day of expandDayPattern(item.day_pattern || item.day)) plannedDays.add(day);
  }

  const byChannel = new Map();
  for (const row of rows) {
    const key = row.channel_name;
    if (planned.size && !planned.has(key.toLowerCase())) continue;
    if (!byChannel.has(key)) byChannel.set(key, new Map());
    byChannel.get(key).set(row.day_of_week, Number(row.ratings) || 0);
  }

  // No lineup yet (or no overlap): fall back to the strongest channels.
  const source = byChannel.size ? byChannel : fallbackChannels(rows);

  const series = [...source.entries()]
    .map(([label, values]) => ({
      label,
      values: ORDER.map((d) => values.get(d) ?? 0),
      total: [...values.values()].reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6)
    .map(({ label, values }) => ({ label, values }));

  return {
    title: 'Audience by day of week',
    subtitle: aggregated.scope?.audience_panel
      ? `Panel: ${aggregated.scope.audience_panel}`
      : 'All loaded audiences',
    y_label: 'Ratings',
    categories: ORDER,
    // Days the plan actually buys, so the chart can mark them.
    highlighted: ORDER.filter((d) => plannedDays.has(d.toLowerCase())),
    series,
  };
}

function fallbackChannels(rows) {
  const byChannel = new Map();
  for (const row of rows) {
    if (!byChannel.has(row.channel_name)) byChannel.set(row.channel_name, new Map());
    byChannel.get(row.channel_name).set(row.day_of_week, Number(row.ratings) || 0);
  }
  return byChannel;
}

/** Grouped bars: one series per brand, one bar per quarter. */
function competitorSpendSeries(aggregated) {
  const rows = aggregated.competitor_spend_by_quarter || [];
  const own = aggregated.own_brand_trend || [];

  const quarters = [...new Set([...rows, ...own].map((r) => r.quarter))].sort();
  const byBrand = new Map();
  for (const row of rows) {
    if (!byBrand.has(row.brand)) byBrand.set(row.brand, new Map());
    byBrand.get(row.brand).set(row.quarter, Number(row.total_spend_000) || 0);
  }

  // Chart the biggest spenders only - beyond about eight brands a grouped bar
  // chart stops being readable.
  const ranked = [...byBrand.entries()]
    .map(([brand, series]) => ({
      brand,
      total: [...series.values()].reduce((a, b) => a + b, 0),
      series,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const series = ranked.map(({ brand, series: s }) => ({
    label: brand,
    values: quarters.map((q) => s.get(q) ?? 0),
    is_own_brand: false,
  }));

  if (own.length) {
    const ownMap = new Map(own.map((r) => [r.quarter, Number(r.total_spend_000) || 0]));
    const ownLabel = aggregated.scope?.brand || 'Own brand';
    // Own brand always appears, even if it isn't a top-eight spender - the
    // comparison is the whole point of the chart.
    const existing = series.find((s) => s.label.toLowerCase() === ownLabel.toLowerCase());
    if (existing) existing.is_own_brand = true;
    else series.push({ label: `${ownLabel} (own)`, values: quarters.map((q) => ownMap.get(q) ?? 0), is_own_brand: true });
  }

  return {
    title: 'Competitor spend by quarter',
    subtitle: scopeSubtitle(aggregated.scope),
    y_label: 'Spend (LKR 000)',
    categories: quarters,
    series,
  };
}

/** Horizontal bars: the programme shortlist, ranked, with recommended ones marked. */
function programmeRatingSeries(aggregated, recommendation) {
  const rows = (aggregated.programme_ratings || []).slice(0, 20);
  const recommended = new Set(
    plannedProgrammes(recommendation)
      .map((i) => `${(i.channel || '').toLowerCase()}|${(i.programme || '').toLowerCase()}`),
  );

  const items = rows.map((r) => {
    // MICOS reports "Avg. Ratings", surfaced as avg_rating by the aggregation.
    const value = r.avg_rating ?? r.trp ?? r.grp ?? 0;
    return {
      label: `${r.programme_name} (${r.channel_name})`,
      value: Number(value) || 0,
      metric: 'Avg. rating',
      programme_category: r.programme_category || null,
      target_audience: r.target_audience || null,
      observed_avg_cost: r.observed_avg_cost ?? null,
      cost_per_rating_point: r.cost_per_rating_point ?? null,
      recommended: recommended.has(
        `${(r.channel_name || '').toLowerCase()}|${(r.programme_name || '').toLowerCase()}`,
      ),
    };
  });
  items.sort((a, b) => b.value - a.value);

  return {
    title: 'Programme ratings for the target audience',
    subtitle: aggregated.scope?.audience_panel
      ? `Panel: ${aggregated.scope.audience_panel}`
      : 'All available audiences',
    x_label: 'Average rating',
    items,
  };
}

/**
 * Where the plan's spots sit across time belts, against competitor activity.
 *
 * The point a planner needs to see at a glance is whether the buy is stacked
 * into prime time - which is both the most expensive inventory and the most
 * contested - or spread across the day.
 */
function timeBeltSeries(aggregated, recommendation) {
  const observed = aggregated.time_belt_clutter || [];
  const planned = recommendation?.clutter?.by_belt || [];

  // Keep the observed order (busiest first) and append any belt the plan uses
  // that competitors do not.
  const labels = [...observed.map((o) => o.time_belt)];
  for (const p of planned) {
    if (p.time_belt && !labels.includes(p.time_belt)) labels.push(p.time_belt);
  }
  if (!labels.length) {
    return { title: 'Time-belt spread', categories: [], series: [], available: false };
  }

  const plannedByBelt = new Map(planned.map((p) => [p.time_belt, p.share_pct]));
  const observedByBelt = new Map(
    observed.map((o) => [o.time_belt, o.share_of_competitor_spots_pct]),
  );

  return {
    title: 'Time-belt spread: this plan vs competitor activity',
    subtitle: 'Share of spots in each belt. A plan concentrated in one belt repeats the same audience.',
    y_label: 'Share of spots (%)',
    categories: labels,
    available: true,
    series: [
      {
        label: 'This plan',
        values: labels.map((l) => plannedByBelt.get(l) ?? 0),
        is_plan: true,
      },
      {
        label: 'Competitor spots',
        values: labels.map((l) => observedByBelt.get(l) ?? 0),
        is_plan: false,
      },
    ],
  };
}

function scopeSubtitle(scope) {
  if (!scope) return '';
  const parts = [];
  if (scope.category) parts.push(`Category: ${scope.category}`);
  else if (scope.sector) parts.push(`Sector: ${scope.sector}`);
  if (scope.period_from && scope.period_to) parts.push(`${scope.period_from} to ${scope.period_to}`);
  return parts.join('  |  ');
}
