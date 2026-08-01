/* Media Planning & Analysis Assistant - front end.
 *
 * Plain ES modules against the same JSON API the CLI uses; no build step and no
 * framework, so this stays deployable as static files next to the server.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const state = { briefId: null, planId: null };

const fmt = (n, dp = 0) =>
  n === null || n === undefined || n === '' || Number.isNaN(Number(n))
    ? '-'
    : Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; }
  if (!res.ok) {
    // The server explains dependency failures in the body ("PGSSL must be
    // true", "the schema has not been applied"). Throwing away that body and
    // reporting the status code alone is how a fixable problem turns into a
    // mystery, so the hint is carried through to whatever renders the error.
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.hint = body.hint || null;
    err.dependency = body.dependency || null;
    throw err;
  }
  return body;
}

/** Render an error with its remediation hint, when the server supplied one. */
function showError(container, err) {
  container.innerHTML = '';
  const box = el('div', { class: 'note err' }, err.message);
  if (err.hint) box.append(el('div', { class: 'hintline' }, err.hint));
  container.append(box);
}

/**
 * Banner for a failed dependency, pinned above the page.
 *
 * When the database is unreachable every section fails at once; one clear
 * explanation at the top beats the same error repeated in four places.
 */
function setBanner(message, hint) {
  let banner = $('#banner');
  if (!message) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = el('div', { id: 'banner', class: 'banner' });
    document.querySelector('main').prepend(banner);
  }
  banner.innerHTML = '';
  banner.append(el('strong', {}, 'The app cannot reach its database. '), message);
  if (hint) banner.append(el('div', { class: 'hintline' }, hint));
}

function notes(container, items, kind = 'note') {
  container.innerHTML = '';
  for (const item of items.filter(Boolean)) container.append(el('div', { class: kind }, item));
}

// --- health ----------------------------------------------------------------

async function loadHealth() {
  const box = $('#status');
  box.innerHTML = '';

  // /health answers 503 when a dependency is down, and the body is the whole
  // point of the call - so read it rather than treating the status as a
  // failure to fetch.
  let h;
  try {
    const res = await fetch('/health');
    h = await res.json();
  } catch (err) {
    box.append(el('span', { class: 'dot bad' }), 'server unreachable');
    setBanner(`The server did not respond (${err.message}).`,
      'Check the service is running and that you are on the right URL.');
    return;
  }

  const ok = Boolean(h.ok && h.db?.ok);
  box.append(
    el('span', { class: `dot ${ok ? 'ok' : 'bad'}` }),
    h.llm?.model || h.llm?.provider || 'llm unknown',
    h.report_worker?.ok ? ' · PDF ready' : ' · PDF worker unavailable',
  );

  setBanner(ok ? null : h.db?.error, h.db?.hint);
}

// --- facets ----------------------------------------------------------------

async function loadFacets() {
  const box = $('#facets');
  try {
    const f = await api('/api/facets');
    const r = f.ratings || {};
    box.innerHTML = '';
    const chips = [
      ['Programmes', r.programmeRows],
      ['Day-part rows', r.daypartRows],
      ['Competitor spots', r.spotRows],
      ['Media watch spots', r.mediaWatchRows],
      ['Channels', f.tv?.channelCount],
      ['Adex rows', f.adex?.rowCount],
    ];
    for (const [label, value] of chips) {
      box.append(el('span', { class: 'chip' }, `${label} `, el('b', {}, fmt(value))));
    }
    if (r.periodStart) {
      box.append(el('span', { class: 'chip' }, 'Survey ', el('b', {}, `${r.periodStart} → ${r.periodEnd}`)));
    }
    // Offer the loaded audience panels as brief suggestions - the panel name is
    // what the ratings are actually keyed on.
    const list = $('#audience-list');
    list.innerHTML = '';
    for (const a of r.audiences || []) list.append(el('option', { value: a }));
    if ((r.audiences || []).length && !$('#brief-form').target_audience.value) {
      $('#brief-form').target_audience.value = r.audiences[0];
    }
  } catch (err) {
    // The banner already carries the explanation when the database is the
    // cause; repeating it here would just be noise.
    if (err.dependency === 'database') box.innerHTML = '';
    else showError(box, err);
  }
}

// --- uploads ---------------------------------------------------------------

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#tv-files');
  const out = $('#upload-result');
  if (!input.files.length) return notes(out, ['Choose at least one file.'], 'note err');

  const body = new FormData();
  for (const file of input.files) body.append('files', file);

  const button = e.target.querySelector('button');
  button.disabled = true;
  button.textContent = 'Parsing…';
  out.innerHTML = '';

  try {
    const r = await api('/api/uploads/tv', { method: 'POST', body });
    out.innerHTML = '';

    const p = r.persisted;
    out.append(el('div', { class: 'note ok' },
      `Loaded ${fmt(p.programmes)} programmes, ${fmt(p.dayparts)} day/day-part rows, ` +
      `${fmt(p.spots)} competitor spots, ${fmt(p.media_watch_spots)} media watch spots ` +
      `across ${fmt(p.channels)} channels.` +
      (r.target_audience ? ` Audience panel: ${r.target_audience}.` : '')));

    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'File'), el('th', {}, 'Read as'), el('th', {}, 'Rows'))),
      el('tbody', {}, r.files.map((f) => el('tr', {},
        el('td', {}, f.file),
        el('td', {}, f.kind === 'unrecognised' ? el('span', { class: 'flag' }, f.kind) : f.kind),
        el('td', {}, Object.entries(f.rows || {}).filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${fmt(v)}`).join(', ') || '-')))));
    out.append(el('div', { class: 'scroll' }, table));

    const allWarnings = [...(r.warnings || []), ...r.files.flatMap((f) => f.warnings || [])];
    for (const w of allWarnings) out.append(el('div', { class: 'note' }, w));

    await loadFacets();
  } catch (err) {
    showError(out, err);
  } finally {
    button.disabled = false;
    button.textContent = 'Upload & parse';
  }
});

// --- brief parse -----------------------------------------------------------

$('#brief-upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#brief-file');
  const out = $('#brief-warnings');
  if (!input.files.length) return notes(out, ['Choose a brief PDF first.'], 'note err');

  const body = new FormData();
  body.append('file', input.files[0]);
  const button = e.target.querySelector('button');
  button.disabled = true;
  button.textContent = 'Parsing…';

  try {
    const r = await api('/api/briefs/parse', { method: 'POST', body });
    const form = $('#brief-form');
    const f = r.fields;
    for (const key of ['brand', 'advertiser', 'objective', 'target_audience',
      'language', 'territory', 'budget_lkr_lakhs', 'period_start', 'period_end']) {
      if (f[key] !== null && f[key] !== undefined) form[key].value = f[key];
    }
    if (f.medium_split) {
      for (const key of ['tv', 'radio', 'press']) {
        if (f.medium_split[key] !== undefined) form[key].value = f.medium_split[key];
      }
    }
    notes(out, [
      'Fields below were read from the PDF and saved nowhere yet — check each one before saving.',
      ...(r.warnings || []),
    ]);
    if (!r.warnings?.length) out.firstChild.className = 'note ok';
  } catch (err) {
    showError(out, err);
  } finally {
    button.disabled = false;
    button.textContent = 'Parse PDF';
  }
});

// --- brief save ------------------------------------------------------------

$('#brief-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const saved = $('#brief-saved');
  const split = {};
  for (const key of ['tv', 'radio', 'press']) {
    const v = form[key].value;
    if (v !== '') split[key] = Number(v);
  }

  const payload = {
    brand: form.brand.value.trim(),
    advertiser: form.advertiser.value.trim() || null,
    objective: form.objective.value.trim() || null,
    target_audience: form.target_audience.value.trim() || null,
    language: form.language.value.trim() || null,
    territory: form.territory.value.trim() || null,
    budget_lkr_lakhs: form.budget_lkr_lakhs.value === '' ? null : Number(form.budget_lkr_lakhs.value),
    period_start: form.period_start.value || null,
    period_end: form.period_end.value || null,
    medium_split: Object.keys(split).length ? split : null,
  };

  saved.className = 'saved';
  saved.textContent = 'Saving…';
  try {
    const brief = await api('/api/briefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.briefId = brief.id;
    saved.textContent = `Saved as brief #${brief.id}`;
    $('#plan-card').hidden = false;
    $('#plan-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    saved.className = 'saved err';
    saved.textContent = err.hint ? `${err.message} ${err.hint}` : err.message;
  }
});

// --- preview ---------------------------------------------------------------

$('#preview-btn').addEventListener('click', async () => {
  const out = $('#preview-out');
  out.innerHTML = 'Loading…';
  try {
    const r = await api(`/api/plans/preview/${state.briefId}`);
    const d = r.aggregated;
    out.innerHTML = '';

    for (const note of d.data_notes || []) out.append(el('div', { class: 'note' }, note));

    out.append(el('h3', {}, 'Top programmes for the panel'));
    out.append(table(
      ['Channel', 'Programme', 'Rating', 'Airings', 'Avg cost', 'Cost/point'],
      (d.programme_ratings || []).slice(0, 10).map((p) => [
        p.channel_name, p.programme_name, fmt(p.avg_rating, 2), fmt(p.instances),
        fmt(p.observed_avg_cost), fmt(p.cost_per_rating_point),
      ]),
      [2, 3, 4, 5],
    ));

    const bestDays = (d.best_days || []).filter((x) => x.day_rank === 1);
    if (bestDays.length) {
      out.append(el('h3', {}, 'Strongest day per channel'));
      out.append(table(
        ['Channel', 'Best day', 'Ratings', 'Reach %'],
        bestDays.slice(0, 8).map((x) => [x.channel_name, x.day_of_week, fmt(x.ratings), fmt(x.reach_pct, 1)]),
        [2, 3],
      ));
    }

    const bestBands = (d.best_dayparts || []).filter((x) => x.band_rank === 1);
    if (bestBands.length) {
      out.append(el('h3', {}, 'Strongest day-part per channel'));
      out.append(table(
        ['Channel', 'Days', 'Time band', 'Ratings'],
        bestBands.slice(0, 8).map((x) => [x.channel_name, x.day_group, x.time_of_day, fmt(x.ratings)]),
        [3],
      ));
    }

    if ((d.competitor_spot_pressure || []).length) {
      out.append(el('h3', {}, 'Who is already buying these programmes'));
      out.append(table(
        ['Channel', 'Programme', 'Spots', 'Total GRP', 'Brands'],
        d.competitor_spot_pressure.slice(0, 8).map((x) => [
          x.channel_name, x.programme_name, fmt(x.spots), fmt(x.total_grp, 2),
          (x.top_brands || []).slice(0, 4).join(', '),
        ]),
        [2, 3],
      ));
    }
  } catch (err) {
    showError(out, err);
  }
});

function table(headers, rows, numericCols = []) {
  return el('div', { class: 'scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h, i) =>
      el('th', { class: numericCols.includes(i) ? 'num' : null }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) =>
      el('td', { class: numericCols.includes(i) ? 'num' : null }, c ?? '-')))))));
}

// --- generate --------------------------------------------------------------

$('#generate-btn').addEventListener('click', async () => {
  const status = $('#plan-status');
  const button = $('#generate-btn');
  button.disabled = true;
  status.className = 'saved';
  status.textContent = 'Calling the model — this can take a while on CPU…';

  try {
    const r = await api(`/api/plans/generate/${state.briefId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    state.planId = r.plan_id;
    status.textContent = `Plan #${r.plan_id} generated in ${(r.meta.elapsed_ms / 1000).toFixed(1)}s`;
    renderPlan(r);
    $('#result-card').hidden = false;
    $('#pdf-link').href = `/api/plans/${r.plan_id}/report.pdf`;
    $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status.className = 'saved err';
    status.textContent = err.hint ? `${err.message} ${err.hint}` : err.message;
  } finally {
    button.disabled = false;
  }
});

function renderPlan(r) {
  const out = $('#plan-out');
  out.innerHTML = '';

  out.append(el('div', { class: 'actions' },
    el('span', { class: `badge ${r.confidence}` }, `confidence: ${r.confidence}`),
    el('span', { class: 'chip' }, r.meta.model_used)));

  const b = r.budget || {};
  if (b.budget_lakhs !== null && b.budget_lakhs !== undefined) {
    out.append(el('div', { class: `budget ${b.over_budget ? 'over' : ''}` },
      el('b', {}, `LKR ${fmt(b.total_cost_lakhs, 2)} lakhs`),
      `of ${fmt(b.budget_lakhs, 2)} lakhs budget (${fmt(b.utilisation_pct, 1)}%)`,
      b.uncosted_lines ? ` · ${b.uncosted_lines} line(s) uncosted` : ''));
  }

  out.append(el('h3', {}, 'Lineup'));
  const rows = (r.recommended_lineup || []).map((i) => {
    const programme = i.in_source_data === false
      ? el('span', {}, i.programme, el('span', { class: 'flag' }, ' †'))
      : i.programme;
    const cost = i.est_cost_lkr === null ? '-' : fmt(i.est_cost_lkr);
    return [
      i.channel, programme, i.day || '-', i.day_part || '-',
      i.spot_duration_secs ? `${i.spot_duration_secs}s` : '-',
      i.spots ?? '-', fmt(i.rating, 2),
      i.cost_supported === false ? el('span', { class: 'flag' }, `${cost} ‡`) : cost,
      i.rationale,
    ];
  });
  out.append(table(
    ['Channel', 'Programme', 'Day', 'Day part', 'Dur', 'Spots', 'Rating', 'Est. cost', 'Why'],
    rows, [4, 5, 6, 7],
  ));

  const g = r.grounding || {};
  if (g.unmatched?.length) {
    out.append(el('div', { class: 'note' },
      `† ${g.unmatched.length} entry/entries could not be matched to the loaded data: ${g.unmatched.join('; ')}`));
  }
  if (g.unsupported_costs?.length) {
    out.append(el('div', { class: 'note' },
      `‡ ${g.unsupported_costs.length} cost(s) have no observed spot rate behind them.`));
  }

  out.append(el('h3', {}, 'Rationale'));
  out.append(el('div', { class: 'prose' }, r.overall_rationale || '-'));
  out.append(el('h3', {}, 'Competitor analysis'));
  out.append(el('div', { class: 'prose' }, r.competitor_analysis || '-'));
  if (r.budget_fit) {
    out.append(el('h3', {}, 'Budget fit'));
    out.append(el('div', { class: 'prose' }, r.budget_fit));
  }
  out.append(el('h3', {}, 'Gaps & caveats'));
  out.append(el('div', { class: 'prose' }, r.gaps_or_caveats || 'None reported.'));
}

// --- drag & drop, file labels ----------------------------------------------

for (const [inputId, labelId] of [['tv-files', 'tv-files-label'], ['brief-file', 'brief-file-label']]) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  const drop = input.closest('.drop');
  const original = label.textContent;

  input.addEventListener('change', () => {
    label.textContent = input.files.length
      ? [...input.files].map((f) => f.name).join(', ')
      : original;
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }
}

$('#refresh-facets').addEventListener('click', loadFacets);

loadHealth();
loadFacets();
