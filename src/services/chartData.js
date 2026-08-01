// ---------------------------------------------------------------------------
// Chart data derivation (Section 5 step 6, feeding Section 6's charts).
//
// Computed in Node from the aggregates and the recommendation, then stored on
// plan_recommendations.chart_data. The Python report worker only draws what it
// is handed - it does no querying and no analysis of its own, so the numbers in
// the PDF are exactly the numbers that were audited into Postgres.
// ---------------------------------------------------------------------------

const MEDIUM_LABELS = { tv: 'TV', radio: 'Radio', press: 'Press', digital: 'Digital', outdoor: 'Outdoor' };

export function buildChartData(aggregated, recommendation, brief) {
  return {
    competitor_spend: competitorSpendSeries(aggregated),
    programme_ratings: programmeRatingSeries(aggregated, recommendation),
    medium_split: mediumSplitSeries(aggregated, brief),
    generated_at: new Date().toISOString(),
  };
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
    (recommendation?.recommended_lineup || [])
      .map((i) => `${(i.channel || '').toLowerCase()}|${(i.programme || '').toLowerCase()}`),
  );

  const items = rows.map((r) => {
    const value = r.grp ?? r.trp ?? 0;
    return {
      label: `${r.programme_name} (${r.channel_name})`,
      value: Number(value) || 0,
      metric: r.grp != null ? 'GRP' : 'TRP',
      day_part: r.day_part || null,
      target_audience: r.target_audience || null,
      recommended: recommended.has(
        `${(r.channel_name || '').toLowerCase()}|${(r.programme_name || '').toLowerCase()}`,
      ),
    };
  });
  items.sort((a, b) => b.value - a.value);

  return {
    title: 'Programme ratings for the target audience',
    subtitle: aggregated.scope?.target_audience
      ? `Target audience: ${aggregated.scope.target_audience}`
      : 'All available audiences',
    x_label: 'GRP / TRP',
    items,
  };
}

/**
 * Donut comparison of medium allocation.
 *
 * The brief's own split is one ring. The second ring is the category's actual
 * TV/radio/press mix from adex over the analysis window - what the competitive
 * set really does. The Section 7 JSON shape carries no medium-split field, so
 * this benchmark is the honest data-backed comparator rather than a number
 * invented on the model's behalf; a planner reads the two rings together to see
 * whether the brief's split is in line with the category.
 */
function mediumSplitSeries(aggregated, brief) {
  const briefSplit = normaliseSplit(brief?.medium_split);

  const totals = { tv: 0, radio: 0, press: 0 };
  for (const row of aggregated.competitor_spend_by_quarter || []) {
    totals.tv += Number(row.tv_spend_000) || 0;
    totals.radio += Number(row.radio_spend_000) || 0;
    totals.press += Number(row.press_spend_000) || 0;
  }
  const grandTotal = totals.tv + totals.radio + totals.press;
  const benchmark = grandTotal > 0
    ? Object.entries(totals)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({ label: MEDIUM_LABELS[k] || k, value: +((v / grandTotal) * 100).toFixed(1) }))
    : [];

  return {
    title: 'Medium split: brief vs category benchmark',
    brief: {
      label: 'Brief budget split',
      slices: briefSplit,
      available: briefSplit.length > 0,
    },
    benchmark: {
      label: 'Category actual (adex)',
      slices: benchmark,
      available: benchmark.length > 0,
      note: benchmark.length
        ? 'Share of category TV/radio/press spend over the analysis window.'
        : 'No category spend available to benchmark against.',
    },
    budget_lkr_lakhs: brief?.budget_lkr_lakhs ?? null,
  };
}

function normaliseSplit(split) {
  if (!split || typeof split !== 'object') return [];
  return Object.entries(split)
    .filter(([k, v]) => !k.startsWith('_') && Number.isFinite(Number(v)) && Number(v) > 0)
    .map(([k, v]) => ({ label: MEDIUM_LABELS[k.toLowerCase()] || k, value: Number(v) }));
}

function scopeSubtitle(scope) {
  if (!scope) return '';
  const parts = [];
  if (scope.category) parts.push(`Category: ${scope.category}`);
  else if (scope.sector) parts.push(`Sector: ${scope.sector}`);
  if (scope.period_from && scope.period_to) parts.push(`${scope.period_from} to ${scope.period_to}`);
  return parts.join('  |  ');
}
