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
};

const CA_COLOR = {
  brand: '#C8734A', competitor: '#2C7FB8',
  pt: '#C8734A', nonpt: '#2C7FB8',
  va: '#2F7D4F', spot: '#C08A2E',
};

const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n))
  ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));

// Lazy-load the advertiser list the first time the tab is opened.
document.querySelector('[data-tab="competitors"]').addEventListener('click', () => {
  if (!CA.loaded) loadAdvertisers();
});

$('#ca-reload').addEventListener('click', loadAdvertisers);
$('#ca-search').addEventListener('input', renderAdvertiserList);
$('#ca-run').addEventListener('click', runAnalysis);
$('#ca-csv').addEventListener('click', exportCsv);

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
    renderAnalysis(r);
    $('#ca-csv').hidden = false;
    status.textContent = `${r.advertisers.length} advertisers · ${fmt(r.set_totals.ads)} ads · LKR ${money(r.set_totals.cost)}`;
  } catch (err) {
    showError(out, err);
    status.className = 'saved err';
    status.textContent = 'Could not run the analysis.';
  } finally {
    $('#ca-run').disabled = false;
  }
}

// --- rendering -------------------------------------------------------------

function renderAnalysis(r) {
  const out = $('#ca-out');
  out.innerHTML = '';
  for (const n of r.data_notes || []) out.append(el('div', { class: 'note' }, n));

  const ads = [...r.advertisers];
  const colorFor = (a) => (a.advertiser === CA.myBrand ? CA_COLOR.brand : CA_COLOR.competitor);
  const brandBadge = (a) => (a.advertiser === CA.myBrand ? ' ★' : '');

  // Share of spend and share of voice, side by side.
  const grid = el('div', { class: 'ca-charts' });
  grid.append(chartCard('Share of spend (monitored cost)',
    barChart(ads.slice().sort((a, b) => b.cost - a.cost).map((a) => ({
      label: a.advertiser + brandBadge(a), pct: a.share_of_spend_pct, color: colorFor(a),
      valueText: `${fmt(a.share_of_spend_pct, 1)}%`, hover: `LKR ${money(a.cost)}`,
    }))),
    legend([['Your brand', CA_COLOR.brand], ['Competitor', CA_COLOR.competitor]])));

  grid.append(chartCard('Share of voice (ad count)',
    barChart(ads.slice().sort((a, b) => b.ads - a.ads).map((a) => ({
      label: a.advertiser + brandBadge(a), pct: a.share_of_voice_pct, color: colorFor(a),
      valueText: `${fmt(a.share_of_voice_pct, 1)}%`, hover: `${fmt(a.ads)} ads`,
    }))),
    legend([['Your brand', CA_COLOR.brand], ['Competitor', CA_COLOR.competitor]])));

  // Prime vs non prime (by cost), stacked per advertiser.
  grid.append(chartCard('Prime vs non-prime spend',
    stackedChart(ads.map((a) => ({
      label: a.advertiser + brandBadge(a),
      segments: [
        { key: 'PT', value: a.pt.cost, color: CA_COLOR.pt, hover: `PT LKR ${money(a.pt.cost)} · ${fmt(a.pt.ads)} ads` },
        { key: 'Non-PT', value: a.non_pt.cost, color: CA_COLOR.nonpt, hover: `Non-PT LKR ${money(a.non_pt.cost)} · ${fmt(a.non_pt.ads)} ads` },
      ],
    }))),
    legend([['Prime time', CA_COLOR.pt], ['Non-prime', CA_COLOR.nonpt]])));

  // Value addition vs spot (by ad count), stacked per advertiser.
  grid.append(chartCard('Value additions vs spots (ads)',
    stackedChart(ads.map((a) => ({
      label: a.advertiser + brandBadge(a),
      segments: [
        { key: 'Value Addition', value: a.value_addition.ads, color: CA_COLOR.va, hover: `${fmt(a.value_addition.ads)} value additions` },
        { key: 'Spot', value: a.spot.ads, color: CA_COLOR.spot, hover: `${fmt(a.spot.ads)} spots` },
      ],
    }))),
    legend([['Value addition', CA_COLOR.va], ['Spot', CA_COLOR.spot]])));

  out.append(grid);

  // The numbers behind the charts.
  out.append(el('h3', {}, 'Every advertiser, in numbers'));
  out.append(table(
    ['Advertiser', 'Ads', 'Cost', 'SOV %', 'SOS %', 'Value add', 'Spot', 'PT ads', 'Non-PT ads'],
    ads.map((a) => [
      a.advertiser + brandBadge(a), fmt(a.ads), money(a.cost),
      fmt(a.share_of_voice_pct, 1), fmt(a.share_of_spend_pct, 1),
      fmt(a.value_addition.ads), fmt(a.spot.ads), fmt(a.pt.ads), fmt(a.non_pt.ads),
    ]),
    [1, 2, 3, 4, 5, 6, 7, 8],
  ));

  // By channel and by programme.
  if ((r.by_channel || []).length) {
    out.append(el('h3', {}, 'By channel'));
    out.append(table(['Advertiser', 'Channel', 'Ads', 'Cost'],
      r.by_channel.map((x) => [x.advertiser, x.channel_name, fmt(x.ads), money(x.cost)]), [2, 3]));
  }
  if ((r.by_program || []).length) {
    out.append(el('h3', {}, 'By programme'));
    out.append(table(['Advertiser', 'Channel', 'Programme', 'Ads', 'Cost'],
      r.by_program.slice(0, 40).map((x) => [x.advertiser, x.channel_name, x.programme_name, fmt(x.ads), money(x.cost)]), [3, 4]));
  }
}

// --- chart primitives (HTML/CSS bars) --------------------------------------

function chartCard(title, ...body) {
  return el('div', { class: 'ca-chart' }, el('h4', {}, title), ...body);
}

function legend(pairs) {
  return el('div', { class: 'ca-legend' },
    ...pairs.map(([label, color]) => el('span', { class: 'ca-leg' },
      el('span', { class: 'ca-swatch', style: `background:${color}` }), label)));
}

/** Horizontal bars scaled to the largest value; pct drives the width. */
function barChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.pct || 0));
  return el('div', { class: 'ca-bars' },
    ...rows.map((r) => el('div', { class: 'ca-barrow' },
      el('span', { class: 'ca-barlabel', title: r.label }, r.label),
      el('div', { class: 'ca-track' },
        el('div', {
          class: 'ca-fill', title: `${r.label}: ${r.valueText}${r.hover ? ` (${r.hover})` : ''}`,
          style: `width:${Math.max(1, (r.pct / max) * 100)}%;background:${r.color}`,
        })),
      el('span', { class: 'ca-barval' }, r.valueText))));
}

/** Stacked bars: every row normalised to the widest total so shares compare. */
function stackedChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.segments.reduce((a, s) => a + (s.value || 0), 0)));
  return el('div', { class: 'ca-bars' },
    ...rows.map((r) => {
      const total = r.segments.reduce((a, s) => a + (s.value || 0), 0);
      return el('div', { class: 'ca-barrow' },
        el('span', { class: 'ca-barlabel', title: r.label }, r.label),
        el('div', { class: 'ca-track ca-stack', style: `width:${Math.max(2, (total / max) * 100)}%` },
          ...r.segments.filter((s) => s.value > 0).map((s) => el('div', {
            class: 'ca-seg', title: `${r.label}: ${s.hover}`,
            style: `flex:${s.value};background:${s.color}`,
          }))),
        el('span', { class: 'ca-barval' }, money(total)));
    }));
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
