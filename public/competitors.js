/* Competitor analysis screen.
 *
 * Reuses the helpers defined in app.js ($ , el, api, fmt, showError) - both are
 * classic scripts, so the top-level bindings are shared. Charts are plain
 * HTML/CSS bars (no external library, so nothing to load and nothing blocked by
 * the CSP). The colour language is consistent with the rest of the tool:
 *   PT / your brand   orange   Non-PT / competitors   blue
 *   Value Addition    green    Spot                    amber
 */

const CA = {
  loaded: false,
  advertisers: [],
  myBrand: null,
  competitors: new Set(),
  last: null,
  metric: 'cost',   // 'cost' | 'ads' for the split charts
  themes: [],
  themesLoaded: false,
};

const CA_COLOR = {
  brand: '#C8734A', competitor: '#2C7FB8',
  pt: '#C8734A', nonpt: '#2C7FB8',
  va: '#2F7D4F', spot: '#C08A2E',
};

const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n))
  ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

// Lazy-load the advertiser list and theme map the first time the tab is opened.
document.querySelector('[data-tab="competitors"]').addEventListener('click', () => {
  if (!CA.loaded) loadAdvertisers();
  if (!CA.themesLoaded) loadThemes();
});

$('#ca-reload').addEventListener('click', loadAdvertisers);
$('#ca-search').addEventListener('input', renderAdvertiserList);
$('#ca-run').addEventListener('click', runAnalysis);
$('#ca-ai').addEventListener('click', runAiRead);
$('#ca-csv').addEventListener('click', exportCsv);
$('#th-reload').addEventListener('click', loadThemes);
$('#th-search').addEventListener('input', renderThemeList);

async function loadAdvertisers() {
  const list = $('#ca-list');
  list.innerHTML = 'Loading advertisers…';
  try {
    const q = new URLSearchParams();
    if ($('#ca-from').value) q.set('from', $('#ca-from').value);
    if ($('#ca-to').value) q.set('to', $('#ca-to').value);
    const r = await api(`/api/workflow/advertisers?${q}`);
    CA.advertisers = r.advertisers || [];
    CA.loaded = true;
    renderAdvertiserList();
  } catch (err) {
    showError(list, err);
  }
}

function renderAdvertiserList() {
  const list = $('#ca-list');
  const term = $('#ca-search').value.trim().toLowerCase();
  list.innerHTML = '';
  if (!CA.advertisers.length) {
    list.append(el('div', { class: 'note' }, 'No advertisers loaded. Upload media watch data on the Data tab first.'));
    return;
  }
  const shown = CA.advertisers
    .filter((a) => !term || a.advertiser.toLowerCase().includes(term))
    .slice(0, 60);
  for (const a of shown) {
    const isBrand = CA.myBrand === a.advertiser;
    const isComp = CA.competitors.has(a.advertiser);
    const row = el('div', { class: `ca-row${isBrand ? ' brand' : ''}${isComp ? ' comp' : ''}` },
      el('span', { class: 'ca-adname' }, a.advertiser),
      el('span', { class: 'ca-admeta' }, `${fmt(a.ads)} ads · LKR ${money(a.cost)}`),
      el('button', { class: 'ca-tag brand-tag', type: 'button' }, isBrand ? '★ My brand' : 'Set as my brand'),
      el('label', { class: 'ca-tag comp-tag' },
        el('input', { type: 'checkbox', ...(isComp ? { checked: 'checked' } : {}) }), 'Competitor'));

    row.querySelector('.brand-tag').addEventListener('click', () => {
      CA.myBrand = isBrand ? null : a.advertiser;
      CA.competitors.delete(a.advertiser);
      renderAdvertiserList();
      renderSelected();
    });
    row.querySelector('.comp-tag input').addEventListener('change', (e) => {
      if (e.target.checked) { CA.competitors.add(a.advertiser); if (CA.myBrand === a.advertiser) CA.myBrand = null; }
      else CA.competitors.delete(a.advertiser);
      renderAdvertiserList();
      renderSelected();
    });
    list.append(row);
  }
  renderSelected();
}

function renderSelected() {
  const box = $('#ca-selected');
  box.innerHTML = '';
  if (CA.myBrand) box.append(el('span', { class: 'ca-chip brand' }, `★ ${CA.myBrand}`));
  for (const c of CA.competitors) {
    const chip = el('span', { class: 'ca-chip comp' }, c, el('span', { class: 'x' }, '×'));
    chip.querySelector('.x').addEventListener('click', () => { CA.competitors.delete(c); renderAdvertiserList(); });
    box.append(chip);
  }
  $('#ca-run').disabled = !CA.myBrand || !CA.competitors.size;
}

// --- theme classification (Value Addition vs Spot) -------------------------

async function loadThemes() {
  const box = $('#th-list');
  box.innerHTML = 'Loading themes…';
  try {
    const r = await api('/api/workflow/themes');
    CA.themes = r.themes || [];
    CA.themesLoaded = true;
    renderThemeList();
  } catch (err) {
    showError(box, err);
  }
}

function renderThemeList() {
  const box = $('#th-list');
  const term = $('#th-search').value.trim().toLowerCase();
  box.innerHTML = '';
  if (!CA.themes.length) {
    box.append(el('div', { class: 'note' }, 'No themes yet. Upload media watch data on the Data tab first.'));
    return;
  }
  const shown = CA.themes.filter((t) => !term || t.advt_theme.toLowerCase().includes(term)).slice(0, 200);
  const vaCount = CA.themes.filter((t) => t.category === 'Value Addition').length;
  box.append(el('div', { class: 'th-summary' },
    `${CA.themes.length} themes · ${vaCount} marked value addition · the rest are spots`));
  for (const t of shown) {
    const isVA = t.category === 'Value Addition';
    const row = el('div', { class: 'th-row' },
      el('span', { class: 'th-name', title: t.advt_theme }, t.advt_theme),
      el('span', { class: 'th-count' }, `${fmt(t.spots)} ads`),
      el('div', { class: 'th-toggle' },
        el('button', { class: `th-opt${isVA ? ' on va' : ''}`, type: 'button', 'data-c': 'Value Addition' }, 'Value addition'),
        el('button', { class: `th-opt${!isVA ? ' on spot' : ''}`, type: 'button', 'data-c': 'Spot' }, 'Spot')));
    for (const btn of row.querySelectorAll('.th-opt')) {
      btn.addEventListener('click', () => setThemeCategory(t, btn.dataset.c));
    }
    box.append(row);
  }
}

async function setThemeCategory(theme, category) {
  if (theme.category === category) return;
  theme.category = category;   // optimistic
  renderThemeList();
  try {
    await api('/api/workflow/themes', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: theme.advt_theme, category }),
    });
    // The re-tag changed the underlying data, so refresh the analysis if shown.
    if (CA.last) runAnalysis();
  } catch (err) {
    showError($('#th-list'), err);
    loadThemes();
  }
}

async function runAnalysis() {
  const status = $('#ca-status');
  const out = $('#ca-out');
  const advertisers = [CA.myBrand, ...CA.competitors].filter(Boolean);
  status.className = 'saved';
  status.textContent = 'Crunching the monitored data…';
  $('#ca-run').disabled = true;
  try {
    const body = { advertisers };
    if ($('#ca-from').value) body.from = $('#ca-from').value;
    if ($('#ca-to').value) body.to = $('#ca-to').value;
    const r = await api('/api/workflow/competitor-analysis', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    CA.last = r;
    CA.aiLast = null;
    renderAnalysis(r);
    $('#ca-csv').hidden = false;
    $('#ca-ai').hidden = false;
    status.textContent = `${r.advertisers.length} advertisers · ${fmt(r.set_totals.ads)} ads · LKR ${money(r.set_totals.cost)}`;
  } catch (err) {
    showError(out, err);
    status.className = 'saved err';
    status.textContent = 'Could not run the analysis.';
  } finally {
    $('#ca-run').disabled = false;
  }
}

// --- AI decision read ------------------------------------------------------

async function runAiRead() {
  const status = $('#ca-status');
  const btn = $('#ca-ai');
  btn.disabled = true;
  status.className = 'saved';
  status.textContent = 'Asking the model for a read…';
  try {
    const body = { advertisers: [CA.myBrand, ...CA.competitors].filter(Boolean), myBrand: CA.myBrand };
    if ($('#ca-from').value) body.from = $('#ca-from').value;
    if ($('#ca-to').value) body.to = $('#ca-to').value;
    const r = await api('/api/workflow/competitor-analysis/insight', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    CA.aiLast = r;
    if (CA.last) renderAnalysis(CA.last);
    status.textContent = r.source === 'model' ? `AI read ready (${r.model_used || 'model'})` : 'AI read ready (offline summary)';
    const card = $('#ca-out .ca-ai');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status.className = 'saved err';
    status.textContent = err.hint ? `${err.message} ${err.hint}` : err.message;
  } finally {
    btn.disabled = false;
  }
}

/** The AI recommendation card - visibly distinct from observed data. */
function renderAiCard(a) {
  const card = el('div', { class: 'ca-ai' });
  card.append(el('div', { class: 'ca-ai-head' },
    el('span', { class: 'ca-ai-badge' }, 'AI'),
    el('span', { class: 'ca-ai-title' }, 'What to do about it'),
    el('span', { class: 'ca-ai-src' }, a.source === 'model' ? `Generated by ${a.model_used || 'the model'}` : 'Offline summary (no model configured)')));

  if (a.headline) card.append(el('div', { class: 'ca-ai-headline' }, a.headline));
  if (a.reasoning) card.append(el('p', { class: 'ca-ai-reason' }, a.reasoning));

  if ((a.recommendations || []).length) {
    card.append(el('div', { class: 'ca-ai-sub' }, 'Recommendations'));
    const ul = el('ul', { class: 'ca-ai-list' });
    for (const rec of a.recommendations) {
      ul.append(el('li', {}, el('b', {}, rec.action), rec.rationale ? el('span', { class: 'ca-ai-why' }, ` — ${rec.rationale}`) : null));
    }
    card.append(ul);
  }

  const cols = el('div', { class: 'ca-ai-cols' });
  if ((a.opportunities || []).length) cols.append(pointCol('Opportunities', a.opportunities, 'opp'));
  if ((a.threats || []).length) cols.append(pointCol('Threats', a.threats, 'thr'));
  if (cols.children.length) card.append(cols);

  if ((a.key_inputs || []).length) {
    const det = el('details', { class: 'ca-ai-inputs' }, el('summary', {}, 'Figures this read used'));
    const ul = el('ul', {});
    for (const k of a.key_inputs) ul.append(el('li', {}, k));
    det.append(ul);
    card.append(det);
  }
  card.append(el('div', { class: 'ca-ai-foot' }, 'AI interpretation of your monitored data. The charts and tables below are the observed figures.'));
  return card;
}

function pointCol(title, points, cls) {
  return el('div', { class: `ca-ai-col ${cls}` },
    el('div', { class: 'ca-ai-sub' }, title),
    el('ul', { class: 'ca-ai-list' }, ...points.map((p) => el('li', {}, p))));
}

// --- rendering -------------------------------------------------------------

function renderAnalysis(r) {
  const out = $('#ca-out');
  out.innerHTML = '';
  for (const n of r.data_notes || []) out.append(el('div', { class: 'note' }, n));

  const ads = [...r.advertisers];
  const colorFor = (a) => (a.advertiser === CA.myBrand ? CA_COLOR.brand : CA_COLOR.competitor);
  const brandBadge = (a) => (a.advertiser === CA.myBrand ? ' (you)' : '');
  const byMetric = CA.metric === 'ads';
  const val = (n) => (byMetric ? fmt(n) : `LKR ${money(n)}`);
  const pctAxis = { axisFmt: (v) => `${fmt(v, 0)}%` };

  // --- the AI read, if requested, then the computed written analysis ----
  if (CA.aiLast) out.append(renderAiCard(CA.aiLast));
  out.append(renderInsights(r));

  // Metric toggle for the split charts.
  const toggle = el('div', { class: 'ca-toggle' },
    el('span', {}, 'Split charts by:'),
    metricButton('cost', 'Cost'),
    metricButton('ads', 'Ad count'));
  out.append(toggle);

  const grid = el('div', { class: 'ca-charts' });

  grid.append(chartCard('Share of spend',
    barChart(ads.slice().sort((a, b) => b.cost - a.cost).map((a) => ({
      label: a.advertiser + brandBadge(a), value: a.share_of_spend_pct, color: colorFor(a),
      valueText: `${fmt(a.share_of_spend_pct, 1)}%`, hover: `LKR ${money(a.cost)}`,
    })), pctAxis),
    legend([['Your brand', CA_COLOR.brand], ['Competitor', CA_COLOR.competitor]])));

  grid.append(chartCard('Share of voice',
    barChart(ads.slice().sort((a, b) => b.ads - a.ads).map((a) => ({
      label: a.advertiser + brandBadge(a), value: a.share_of_voice_pct, color: colorFor(a),
      valueText: `${fmt(a.share_of_voice_pct, 1)}%`, hover: `${fmt(a.ads)} ads`,
    })), pctAxis),
    legend([['Your brand', CA_COLOR.brand], ['Competitor', CA_COLOR.competitor]])));

  const splitAxis = byMetric ? { axisFmt: (v) => fmt(v, 0), totalFmt: (v) => fmt(v, 0) }
    : { axisFmt: moneyShort, totalFmt: moneyShort };
  grid.append(chartCard(`Prime vs non-prime (${byMetric ? 'ads' : 'spend'})`,
    stackedChart(ads.map((a) => ({
      label: a.advertiser + brandBadge(a),
      segments: [
        { key: 'PT', value: byMetric ? a.pt.ads : a.pt.cost, color: CA_COLOR.pt, hover: `PT ${val(byMetric ? a.pt.ads : a.pt.cost)}` },
        { key: 'Non-PT', value: byMetric ? a.non_pt.ads : a.non_pt.cost, color: CA_COLOR.nonpt, hover: `Non-PT ${val(byMetric ? a.non_pt.ads : a.non_pt.cost)}` },
      ],
    })), splitAxis),
    legend([['Prime time', CA_COLOR.pt], ['Non-prime', CA_COLOR.nonpt]])));

  const anyVa = ads.some((a) => a.value_addition.ads > 0);
  grid.append(chartCard('Value additions vs spots (ads)',
    anyVa
      ? stackedChart(ads.map((a) => ({
        label: a.advertiser + brandBadge(a),
        segments: [
          { key: 'Value Addition', value: a.value_addition.ads, color: CA_COLOR.va, hover: `${fmt(a.value_addition.ads)} value additions` },
          { key: 'Spot', value: a.spot.ads, color: CA_COLOR.spot, hover: `${fmt(a.spot.ads)} spots` },
        ],
      })), { axisFmt: (v) => fmt(v, 0), totalFmt: (v) => fmt(v, 0) })
      : el('div', { class: 'note' }, 'No themes are marked as value additions yet. Use "Value additions vs spots" below to classify them.'),
    legend([['Value addition', CA_COLOR.va], ['Spot', CA_COLOR.spot]])));

  out.append(grid);

  // Channel and programme spend, visualised and coloured by advertiser.
  const advColors = assignAdvColors(ads);
  if ((r.by_channel || []).length) {
    out.append(chartCard('Where the money goes: top channels by spend',
      categorySpendChart(r.by_channel, 'channel_name', advColors, 14), advLegend(advColors)));
    out.append(chartCard('How wide each advertiser spreads (channels used)',
      spreadChart(r, advColors), advLegend(advColors)));
  }
  if ((r.by_program || []).length) {
    out.append(chartCard('Top programmes by spend',
      categorySpendChart(r.by_program, 'programme_name', advColors, 16), advLegend(advColors)));
  }

  // The full numbers, available but out of the way.
  const details = el('details', { class: 'ca-tables' }, el('summary', {}, 'Show the numbers'));
  details.append(el('h3', {}, 'Every advertiser'));
  details.append(table(
    ['Advertiser', 'Ads', 'Cost', 'SOV %', 'SOS %', 'Value add', 'Spot', 'PT ads', 'Non-PT ads'],
    ads.map((a) => [
      a.advertiser + brandBadge(a), fmt(a.ads), money(a.cost),
      fmt(a.share_of_voice_pct, 1), fmt(a.share_of_spend_pct, 1),
      fmt(a.value_addition.ads), fmt(a.spot.ads), fmt(a.pt.ads), fmt(a.non_pt.ads),
    ]),
    [1, 2, 3, 4, 5, 6, 7, 8],
  ));
  if ((r.by_channel || []).length) {
    details.append(el('h3', {}, 'By channel'));
    details.append(table(['Advertiser', 'Channel', 'Ads', 'Cost'],
      r.by_channel.map((x) => [x.advertiser, x.channel_name, fmt(x.ads), money(x.cost)]), [2, 3]));
  }
  if ((r.by_program || []).length) {
    details.append(el('h3', {}, 'By programme'));
    details.append(table(['Advertiser', 'Channel', 'Programme', 'Ads', 'Cost'],
      r.by_program.slice(0, 60).map((x) => [x.advertiser, x.channel_name, x.programme_name, fmt(x.ads), money(x.cost)]), [3, 4]));
  }
  out.append(details);
}

// --- chart primitives ------------------------------------------------------
//
// Horizontal bar charts with a shared x-axis and gridlines - a standard,
// readable analytics form rather than free-floating bars. Every chart draws
// gridlines at 0/25/50/75/100% of its scale with axis labels, so bar lengths
// are comparable against a real scale.

/** Compact money: 205.6M, 4.4M, 553K. Full value stays in the tooltip. */
function moneyShort(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

function chartCard(title, ...body) {
  return el('div', { class: 'ca-chart' }, el('div', { class: 'ca-chart-h' }, title), ...body);
}

function legend(pairs) {
  return el('div', { class: 'ca-legend' },
    ...pairs.map(([label, color]) => el('span', { class: 'ca-leg' },
      el('span', { class: 'ca-swatch', style: `background:${color}` }), label)));
}

/** The gridline layer and axis-label row shared by both chart types. */
function axisFrame(max, axisFmt) {
  const grid = el('div', { class: 'ca-grid' });
  const axis = el('div', { class: 'ca-axis' });
  for (const p of [0, 25, 50, 75, 100]) {
    grid.append(el('span', { style: `left:${p}%` }));
    axis.append(el('span', { style: `left:${p}%` }, axisFmt((max * p) / 100)));
  }
  return { grid, axis };
}

/** Single-value horizontal bars against a shared axis. */
function barChart(rows, { axisFmt = (v) => `${fmt(v)}` } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  const { grid, axis } = axisFrame(max, axisFmt);
  const plot = el('div', { class: 'ca-plot' }, grid);
  for (const r of rows) {
    plot.append(el('div', { class: 'ca-prow' },
      el('span', { class: 'lab', title: r.label }, r.label),
      el('div', { class: 'cell' }, el('div', {
        class: 'fl', title: `${r.label}: ${r.valueText}${r.hover ? ` (${r.hover})` : ''}`,
        style: `width:${Math.max(1, (r.value / max) * 100)}%;background:${r.color}`,
      })),
      el('span', { class: 'val' }, r.valueText)));
  }
  plot.append(axis);
  return plot;
}

/** Stacked horizontal bars against a shared axis, with inline share labels. */
function stackedChart(rows, { axisFmt = moneyShort, totalFmt = moneyShort } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.segments.reduce((a, s) => a + (s.value || 0), 0)));
  const { grid, axis } = axisFrame(max, axisFmt);
  const plot = el('div', { class: 'ca-plot' }, grid);
  for (const r of rows) {
    const total = r.segments.reduce((a, s) => a + (s.value || 0), 0);
    const stack = el('div', { class: 'stack', style: `width:${Math.max(2, (total / max) * 100)}%` });
    for (const s of r.segments.filter((x) => x.value > 0)) {
      const share = total ? Math.round((s.value / total) * 100) : 0;
      stack.append(el('div', {
        class: 'seg', title: `${r.label}: ${s.hover} (${share}%)`,
        style: `flex:${s.value};background:${s.color}`,
      }, share >= 14 ? el('span', { class: 'seglab' }, `${share}%`) : null));
    }
    plot.append(el('div', { class: 'ca-prow' },
      el('span', { class: 'lab', title: r.label }, r.label),
      el('div', { class: 'cell' }, stack),
      el('span', { class: 'val' }, totalFmt(total))));
  }
  plot.append(axis);
  return plot;
}

// Advertiser colours: your brand is always orange; competitors take blue then
// magenta in a stable (sorted) order, and any beyond fold into a neutral grey.
const ADV_PALETTE = ['#2C7FB8', '#B5468A'];
function assignAdvColors(advertisers) {
  const map = new Map();
  if (CA.myBrand) map.set(CA.myBrand, CA_COLOR.brand);
  advertisers.map((a) => a.advertiser).filter((n) => n !== CA.myBrand).sort()
    .forEach((n, i) => map.set(n, ADV_PALETTE[i] ?? '#8A93A0'));
  return map;
}

function advLegend(advColors) {
  return legend([...advColors.entries()].map(([n, c]) => [n === CA.myBrand ? `${n} (you)` : n, c]));
}

/** Top categories (channel or programme) by spend, stacked by advertiser. */
function categorySpendChart(rows, keyField, advColors, limit) {
  const byCat = new Map();
  for (const x of rows) {
    const k = x[keyField];
    const e = byCat.get(k) || { total: 0, segs: new Map() };
    e.total += x.cost;
    e.segs.set(x.advertiser, (e.segs.get(x.advertiser) || 0) + x.cost);
    byCat.set(k, e);
  }
  const catRows = [...byCat.entries()]
    .sort((a, b) => b[1].total - a[1].total).slice(0, limit)
    .map(([label, e]) => ({
      label,
      segments: [...e.segs.entries()].sort((a, b) => b[1] - a[1]).map(([adv, cost]) => ({
        key: adv, value: cost, color: advColors.get(adv) || '#8A93A0',
        hover: `${adv}: LKR ${money(cost)}`,
      })),
    }));
  return stackedChart(catRows, { axisFmt: moneyShort, totalFmt: moneyShort });
}

/** How many distinct channels each advertiser uses - spread vs concentration. */
function spreadChart(r, advColors) {
  const count = new Map();
  for (const x of r.by_channel) {
    if (!count.has(x.advertiser)) count.set(x.advertiser, new Set());
    count.get(x.advertiser).add(x.channel_name);
  }
  const rows = r.advertisers
    .map((a) => ({ adv: a.advertiser, n: count.get(a.advertiser)?.size || 0 }))
    .sort((a, b) => b.n - a.n)
    .map((x) => ({
      label: x.adv === CA.myBrand ? `${x.adv} (you)` : x.adv, value: x.n,
      color: advColors.get(x.adv) || '#8A93A0', valueText: `${x.n} channels`,
    }));
  return barChart(rows, { axisFmt: (v) => fmt(v, 0) });
}

/** A Cost / Ad-count toggle button for the split charts. */
function metricButton(metric, label) {
  const btn = el('button', { class: `ca-metric${CA.metric === metric ? ' on' : ''}`, type: 'button' }, label);
  btn.addEventListener('click', () => { CA.metric = metric; if (CA.last) renderAnalysis(CA.last); });
  return btn;
}

/**
 * The written analysis: turns the numbers into how each competitor behaves and
 * what it means for your brand, so the screen answers "so what", not just "how
 * much". Everything here is computed from the same figures shown in the charts.
 */
function renderInsights(r) {
  const set = r.advertisers;
  const brand = set.find((a) => a.advertiser === CA.myBrand);
  const card = el('div', { class: 'ca-analysis' }, el('h3', {}, 'What the data says'));
  if (!set.length || !brand) {
    card.append(el('p', {}, 'No monitored spots for this selection in the chosen period.'));
    return card;
  }

  const byCost = [...set].sort((a, b) => b.cost - a.cost);
  const leader = byCost[0];
  const brandRank = byCost.findIndex((a) => a.advertiser === brand.advertiser) + 1;
  const share = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const ptShare = (a) => share(a.pt.cost, a.pt.cost + a.non_pt.cost);
  const vaShare = (a) => share(a.value_addition.ads, a.ads);

  const chanByAdv = new Map();
  for (const x of r.by_channel) {
    if (!chanByAdv.has(x.advertiser)) chanByAdv.set(x.advertiser, []);
    chanByAdv.get(x.advertiser).push(x);
  }
  const topChan = (adv) => (chanByAdv.get(adv) || []).slice().sort((a, b) => b.cost - a.cost)[0];
  const topProg = (adv) => r.by_program.filter((x) => x.advertiser === adv).sort((a, b) => b.cost - a.cost)[0];

  const P = (...kids) => card.append(el('p', { class: 'ca-insight' }, ...kids));

  // Leadership / share of spend.
  if (leader.advertiser === brand.advertiser) {
    const next = byCost[1];
    P(`Your brand leads share of spend at ${fmt(brand.share_of_spend_pct, 1)}%`,
      next ? `, ahead of ${next.advertiser} at ${fmt(next.share_of_spend_pct, 1)}%. Hold that lead where it matters and watch the channels ${next.advertiser} is building.` : '. It is the only advertiser with monitored spend here.');
  } else {
    const gap = Math.round(leader.share_of_spend_pct - brand.share_of_spend_pct);
    P(`${leader.advertiser} leads with ${fmt(leader.share_of_spend_pct, 1)}% share of spend; your brand sits at ${fmt(brand.share_of_spend_pct, 1)}% (rank ${brandRank} of ${set.length}), about ${gap} points behind. To move share of voice toward share of market you would need to close that gap.`);
  }

  // Prime-time behaviour.
  const primeHeavy = [...set].filter((a) => a.pt.cost + a.non_pt.cost > 0)
    .sort((a, b) => ptShare(b) - ptShare(a))[0];
  if (primeHeavy) {
    P(`${primeHeavy.advertiser} is the most prime-time weighted, putting ${ptShare(primeHeavy)}% of its money into prime. Your brand runs ${ptShare(brand)}% in prime and ${100 - ptShare(brand)}% in non-prime` + (ptShare(brand) > 70 ? ' - heavy on the most expensive, most contested inventory; some non-prime weight would stretch reach for less.' : ptShare(brand) < 40 ? ' - light on prime, which is where the audience peaks in the evening.' : ', a reasonable prime / non-prime balance.'));
  }

  // Value additions.
  const vaLeader = [...set].sort((a, b) => vaShare(b) - vaShare(a))[0];
  if (vaLeader && vaShare(vaLeader) > 0) {
    P(`${vaLeader.advertiser} leans on value additions: ${vaShare(vaLeader)}% of its ads are sponsorships or integrations rather than plain spots. Your brand is at ${vaShare(brand)}%.` + (vaShare(brand) < vaShare(vaLeader) ? ' Value additions buy visibility a spot cannot, so this is worth matching on the properties that fit the brand.' : ''));
  } else {
    P('No advertiser here shows value additions yet. If sponsorships or integrations are in the data, classify those themes below so this split is real.');
  }

  // Channels and programmes.
  const lc = topChan(leader.advertiser);
  const bc = topChan(brand.advertiser);
  if (lc) {
    P(`${leader.advertiser} concentrates on ${lc.channel_name} (LKR ${money(lc.cost)} across ${fmt(lc.ads)} ads)` + (topProg(leader.advertiser) ? `, and leans hardest on ${topProg(leader.advertiser).programme_name}.` : '.') + (bc ? ` Your brand's heaviest channel is ${bc.channel_name}.` : ''));
  }

  // A concrete gap / opportunity.
  const brandChannels = new Set((chanByAdv.get(brand.advertiser) || []).map((c) => c.channel_name));
  const gapChan = r.by_channel
    .filter((x) => x.advertiser !== brand.advertiser && !brandChannels.has(x.channel_name))
    .sort((a, b) => b.cost - a.cost)[0];
  if (gapChan) {
    P(`Opportunity: ${gapChan.advertiser} is active on ${gapChan.channel_name} (LKR ${money(gapChan.cost)}) where your brand has no monitored presence. That is either a gap to cover or a deliberate space they own.`);
  }

  return card;
}

function exportCsv() {
  if (!CA.last) return;
  const rows = [['Advertiser', 'Ads', 'Cost', 'SOV_pct', 'SOS_pct', 'ValueAddition_ads', 'Spot_ads', 'PT_ads', 'PT_cost', 'NonPT_ads', 'NonPT_cost']];
  for (const a of CA.last.advertisers) {
    rows.push([a.advertiser, a.ads, a.cost, a.share_of_voice_pct, a.share_of_spend_pct,
      a.value_addition.ads, a.spot.ads, a.pt.ads, a.pt.cost, a.non_pt.ads, a.non_pt.cost]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'competitor-analysis.csv';
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
