/* Media Planning & Analysis Assistant - front end.
 *
 * Plain ES modules against the same JSON API the CLI uses; no build step and no
 * framework, so this stays deployable as static files next to the server.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const state = {
  briefId: null, planId: null, durations: [15, 20, 30],
  analysis: null, picks: [], selectedChannels: new Set(),
};

const DAY_PATTERNS = ['Mon - Fri', 'Sat - Sun', 'Daily', 'Mon - Wed', 'Thu - Sat'];

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
    err.body = body;
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

function table(headers, rows, numericCols = []) {
  return el('div', { class: 'scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h, i) =>
      el('th', { class: numericCols.includes(i) ? 'num' : null }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) =>
      el('td', { class: numericCols.includes(i) ? 'num' : null }, c ?? '-')))))));
}

// --- tabs ------------------------------------------------------------------

for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.tab')) {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    }
    for (const panel of $$('.panel')) {
      panel.hidden = panel.id !== `panel-${tab.dataset.tab}`;
    }
    if (tab.dataset.tab === 'settings') { loadSettings(); loadArchive(); }
    if (tab.dataset.tab === 'data') { loadFacets(); loadMediaWatchSources(); }
  });
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
  const pdfReady = Boolean(h.report_worker?.ok);
  box.append(
    el('span', { class: `dot ${ok ? 'ok' : 'bad'}` }),
    h.llm?.model || h.llm?.provider || 'llm unknown',
    pdfReady ? ' · PDF ready' : ' · Excel export (no PDF worker)',
  );
  setBanner(ok ? null : h.db?.error, h.db?.hint);

  // Only offer the PDF when the Python worker is actually installed. On a host
  // without matplotlib/reportlab the download would 500 and save a JSON error,
  // so hide it and let the Python-free Excel export be the deliverable.
  const pdfBtn = $('#pdf-btn');
  if (pdfBtn) pdfBtn.hidden = !pdfReady;
}

// --- upload slots ----------------------------------------------------------

async function buildSlots() {
  const box = $('#dataset-slots');
  try {
    const { datasets } = await api('/api/uploads/datasets');
    box.innerHTML = '';
    for (const ds of datasets) {
      const input = el('input', { type: 'file', id: `slot-${ds.key}`, name: ds.key });
      const label = el('small', { class: 'slot-file' }, ds.retained ? 'kept permanently' : 'cleared after the report');
      input.addEventListener('change', () => {
        label.textContent = input.files.length
          ? [...input.files].map((f) => f.name).join(', ')
          : (ds.retained ? 'kept permanently' : 'cleared after the report');
      });
      const drop = el('label', { class: 'drop slot', for: `slot-${ds.key}` },
        input, el('span', {}, ds.label), label);
      for (const type of ['dragenter', 'dragover']) {
        drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
      }
      for (const type of ['dragleave', 'drop']) {
        drop.addEventListener(type, () => drop.classList.remove('over'));
      }
      box.append(drop);
    }
  } catch (err) {
    showError(box, err);
  }
}

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#upload-result');
  const body = new FormData();
  let count = 0;
  for (const input of $$('#dataset-slots input[type=file]')) {
    for (const file of input.files) { body.append(input.name, file); count += 1; }
  }
  if (!count) return notes(out, ['Choose at least one file.'], 'note err');

  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = 'Parsing…';
  out.innerHTML = '';

  try {
    const r = await api('/api/uploads/tv', { method: 'POST', body });
    out.innerHTML = '';

    const p = r.persisted;
    // Only report the datasets this upload actually contained - listing five
    // zeroes for a single adex file reads as failure.
    const loaded = [
      [p.programmes, 'programmes'],
      [p.dayparts, 'day/day-part rows'],
      [p.spots, 'competitor spots'],
      [p.media_watch_spots, 'media watch spots'],
      [p.adex_rows, 'adex rows'],
    ].filter(([n]) => n).map(([n, label]) => `${fmt(n)} ${label}`);
    out.append(el('div', { class: 'note ok' },
      `Loaded ${loaded.join(', ') || 'nothing new'}`
      + (p.channels ? ` across ${fmt(p.channels)} channels` : '') + '.'
      + (r.target_audience ? ` Audience panel: ${r.target_audience}.` : '')));

    out.append(table(
      ['File', 'Slot', 'Read as', 'Rows'],
      r.files.map((f) => [
        f.file,
        f.slot || '(auto)',
        f.kind === 'unrecognised' ? el('span', { class: 'flag' }, f.kind) : f.kind,
        Object.entries(f.rows || {}).filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${fmt(v)}`).join(', ') || '-',
      ]),
    ));

    if (r.archive?.skipped) {
      out.append(el('div', { class: 'note' },
        `Not archived to Drive: ${r.archive.skipped}`,
        r.archive.hint ? el('div', { class: 'hintline' }, r.archive.hint) : null));
    } else if (r.archive?.archived) {
      out.append(el('div', { class: 'note ok' },
        `${r.archive.archived} file(s) archived to Drive for this run.`));
    }

    for (const w of [...(r.warnings || []), ...r.files.flatMap((f) => f.warnings || [])]) {
      out.append(el('div', { class: 'note' }, w));
    }
    await loadFacets();
    await loadMediaWatchSources();
  } catch (err) {
    showError(out, err);
    if (err.body?.files) {
      out.append(table(
        ['File', 'Read as', 'Sheets inspected'],
        err.body.files.map((f) => [
          f.file, f.kind,
          (f.sheets || []).map((s) => `${s.sheet}: ${s.kind || s.reason || ''}`).join('; ') || '-',
        ]),
      ));
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Upload & parse';
  }
});

// --- media watch sheets ----------------------------------------------------

async function loadMediaWatchSources() {
  const box = $('#mw-sources');
  try {
    const { sources } = await api('/api/uploads/media-watch/sources');
    box.innerHTML = '';
    if (!sources.length) {
      box.append(el('div', { class: 'note' }, 'No media watch sheets loaded yet.'));
      return;
    }
    for (const s of sources) {
      const row = el('div', { class: 'mw-row' },
        el('div', { class: 'mw-main' },
          el('span', { class: 'mw-name' }, s.source_file),
          el('span', { class: 'mw-meta' },
            `${fmt(s.spots)} spots · ${fmt(s.channels)} channels`
            + (s.total_cost ? ` · LKR ${fmt(s.total_cost)}` : '')
            + (s.first_aired ? ` · ${String(s.first_aired).slice(0, 10)} to ${String(s.last_aired).slice(0, 10)}` : ''))),
        el('button', { class: 'ghost small-btn', type: 'button' }, 'Delete'));
      row.querySelector('button').addEventListener('click', () => deleteMediaWatchSource(s.source_file, row));
      box.append(row);
    }
  } catch (err) {
    showError(box, err);
  }
}

async function deleteMediaWatchSource(source, row) {
  if (!window.confirm(`Delete "${source}" and all its rows from the system?`)) return;
  const btn = row.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const r = await api(`/api/uploads/media-watch/source?source=${encodeURIComponent(source)}`, {
      method: 'DELETE',
    });
    row.replaceWith(el('div', { class: 'note ok' }, `Removed ${fmt(r.deleted)} rows from "${source}".`));
    await loadFacets();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Delete';
    showError($('#mw-sources'), err);
  }
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

// --- commercial durations --------------------------------------------------

const COMMON_DURATIONS = [5, 10, 15, 20, 30, 45, 60];

function renderDurations() {
  const box = $('#duration-chips');
  box.innerHTML = '';
  const all = [...new Set([...COMMON_DURATIONS, ...state.durations])].sort((a, b) => a - b);
  for (const secs of all) {
    const on = state.durations.includes(secs);
    const chip = el('button', {
      type: 'button',
      class: `dur-chip ${on ? 'on' : ''}`,
      'aria-pressed': String(on),
    }, `${secs}s`);
    chip.addEventListener('click', () => {
      state.durations = on
        ? state.durations.filter((d) => d !== secs)
        : [...state.durations, secs].sort((a, b) => a - b);
      renderDurations();
    });
    box.append(chip);
  }
}

$('#add-duration').addEventListener('click', () => {
  const input = $('#brief-form').duration_custom;
  const secs = Math.round(Number(input.value));
  if (!Number.isFinite(secs) || secs < 5 || secs > 120) return;
  if (!state.durations.includes(secs)) state.durations = [...state.durations, secs].sort((a, b) => a - b);
  input.value = '';
  renderDurations();
});

// --- brief save ------------------------------------------------------------

$('#brief-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const saved = $('#brief-saved');

  if (!state.durations.length) {
    saved.className = 'saved err';
    saved.textContent = 'Pick at least one commercial length.';
    return;
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
    commercial_durations: state.durations,
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
    // A fresh brief starts a fresh exploration.
    state.analysis = null;
    state.picks = [];
    state.selectedChannels = new Set();
    state.planId = null;
    $('#programmes-card').hidden = true;
    $('#result-card').hidden = true;
    $('#channels-next').hidden = true;
    $('#ai-plan-btn').hidden = true;
    $('#ai-plan-hint').hidden = true;
    $('#explore-out').innerHTML = '';
    $('#programmes-out').innerHTML = '';
    saved.textContent = `Saved as brief #${brief.id}`;
    $('#explore-card').hidden = false;
    $('#explore-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    saved.className = 'saved err';
    saved.textContent = err.hint ? `${err.message} ${err.hint}` : err.message;
  }
});

// --- step 2: analyze and pick channels -------------------------------------

$('#analyze-btn').addEventListener('click', async () => {
  const status = $('#analyze-status');
  const button = $('#analyze-btn');
  button.disabled = true;
  status.className = 'saved';
  status.textContent = 'Reading the audience, channels and competitor activity…';
  try {
    const r = await api(`/api/explore/${state.briefId}/analyze`);
    state.analysis = r;
    state.selectedChannels = new Set();
    renderChannels(r);
    $('#ai-plan-btn').hidden = false;
    $('#ai-plan-hint').hidden = false;
    status.textContent = `${r.channels.length} channels · panel: ${r.audience.panel || 'all audiences'}`;
  } catch (err) {
    showError($('#explore-out'), err);
    status.className = 'saved err';
    status.textContent = 'Could not analyze.';
  } finally {
    button.disabled = false;
  }
});

/** The ranked channel mix, each with its competitor read and a select box. */
function renderChannels(r) {
  const out = $('#explore-out');
  out.innerHTML = '';
  for (const note of r.data_notes || []) out.append(el('div', { class: 'note' }, note));

  out.append(el('h3', {}, 'Best channel mix · ranked by share of audience'));
  for (const ch of r.channels) out.append(renderChannelRow(ch));
  syncChannelsNext();
}

function renderChannelRow(ch) {
  const c = ch.competitor || {};
  const card = el('div', { class: `explore-channel${ch.is_top5 ? ' top5' : ''}` });

  const check = el('input', { type: 'checkbox', class: 'ch-check' });
  check.checked = state.selectedChannels.has(ch.channel_name);
  check.addEventListener('change', () => {
    if (check.checked) state.selectedChannels.add(ch.channel_name);
    else state.selectedChannels.delete(ch.channel_name);
    card.classList.toggle('picked', check.checked);
    syncChannelsNext();
  });
  card.classList.toggle('picked', check.checked);

  card.append(el('label', { class: 'channel-head channel-pick' },
    check,
    el('h4', {}, `#${ch.rank} ${ch.channel_name}`),
    ch.share_of_audience !== null ? el('span', { class: 'chip' }, `${fmt(ch.share_of_audience, 2)}% share`) : null,
    ch.individual_reach_pct !== null ? el('span', { class: 'chip' }, `${fmt(ch.individual_reach_pct, 1)}% reach`) : null,
    ch.best_day ? el('span', { class: 'chip' }, `best day: ${ch.best_day.day}`) : null,
  ));

  const comp = el('div', { class: 'competitor-read' });
  comp.append(el('div', { class: 'cr-row' },
    el('b', {}, 'Competitors here: '),
    `${fmt(c.grp_share_pct, 1)}% of GRP · ${fmt(c.spots)} spots · ${fmt(c.brands)} brands`
    + (c.observed_spend_lkr ? ` · LKR ${fmt(c.observed_spend_lkr)} observed spend` : '')));
  if ((c.top_brands || []).length) {
    comp.append(el('div', { class: 'cr-row' }, el('b', {}, 'Top brands: '),
      c.top_brands.map((b) => `${b.brand} (${fmt(b.grp, 1)} GRP)`).join(', ')));
  }
  if ((c.top_belts || []).length) {
    comp.append(el('div', { class: 'cr-row' }, el('b', {}, 'Favoured belts: '),
      c.top_belts.map((b) => `${b.belt} (${fmt(b.spots)})`).join(' · ')));
  }
  if ((c.top_days || []).length) {
    comp.append(el('div', { class: 'cr-row' }, el('b', {}, 'Favoured days: '),
      c.top_days.map((d) => `${d.day} (${fmt(d.spots)})`).join(' · ')));
  }
  card.append(comp);
  return card;
}

/** Enable "Next" only once at least one channel is taken. */
function syncChannelsNext() {
  const next = $('#channels-next');
  const n = state.selectedChannels.size;
  next.hidden = n === 0;
  next.textContent = `Next: choose programmes (${n} channel${n === 1 ? '' : 's'}) →`;
}

$('#channels-next').addEventListener('click', () => {
  renderProgrammes();
  $('#programmes-card').hidden = false;
  $('#programmes-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#channels-back').addEventListener('click', () => {
  $('#programmes-card').hidden = true;
  $('#explore-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// --- AI recommends the whole plan ------------------------------------------

$('#ai-plan-btn').addEventListener('click', async () => {
  const status = $('#analyze-status');
  const button = $('#ai-plan-btn');
  const chosen = [...state.selectedChannels];
  button.disabled = true;
  status.className = 'saved';
  status.textContent = chosen.length
    ? `AI is planning across ${chosen.length} chosen channel(s) — this can take a moment…`
    : 'AI is choosing the channel mix and plotting the plan — this can take a moment…';
  try {
    const r = await api(`/api/plans/generate/${state.briefId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chosen.length ? { channels: chosen } : {}),
    });
    state.planId = r.plan_id;
    status.textContent = `AI plan #${r.plan_id} ready`;
    renderAiPlan(r);
    $('#result-card').hidden = false;
    $('#download-out').innerHTML = '';
    $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status.className = 'saved err';
    status.textContent = err.hint ? `${err.message} — ${err.hint}` : err.message;
  } finally {
    button.disabled = false;
  }
});

/** The AI's channel-first plan: mix, programmes, strategy and dated schedule. */
function renderAiPlan(r) {
  const out = $('#plan-out');
  out.innerHTML = '';

  out.append(el('div', { class: 'actions' },
    el('span', { class: `badge ${r.confidence}` }, `confidence: ${r.confidence}`),
    r.meta?.model_used ? el('span', { class: 'chip' }, r.meta.model_used) : null));

  const b = r.budget || {};
  if (b.budget_lakhs !== null && b.budget_lakhs !== undefined) {
    out.append(el('div', { class: `budget ${b.over_budget ? 'over' : ''}` },
      el('b', {}, `LKR ${fmt(b.total_cost_lakhs, 2)} lakhs`),
      ` of ${fmt(b.budget_lakhs, 2)} lakhs (${fmt(b.utilisation_pct, 1)}%)`,
      ` · ${fmt(b.total_spots)} spots`,
      b.uncosted_spots ? ` · ${fmt(b.uncosted_spots)} uncosted` : ''));
  }

  if (r.overall_rationale) {
    out.append(el('h3', {}, 'Strategy'));
    out.append(el('div', { class: 'prose' }, r.overall_rationale));
  }

  for (const channel of r.channel_plan || []) {
    out.append(el('div', { class: 'channel-head' },
      el('h4', {}, channel.channel),
      channel.share_of_audience ? el('span', { class: 'chip' }, `${fmt(channel.share_of_audience, 2)}% share`) : null));
    if (channel.why_this_channel) out.append(el('div', { class: 'prose small-prose' }, channel.why_this_channel));
    out.append(table(
      ['Programme', 'Day', 'Time band', 'Dur', 'Spots', 'TVR', 'Rate', 'Why'],
      (channel.programmes || []).map((p) => [
        p.in_source_data === false ? el('span', {}, p.programme, el('span', { class: 'flag' }, ' †')) : p.programme,
        p.day_pattern || '-', p.time_band || '-', p.duration_secs ? `${p.duration_secs}s` : '-',
        p.spots ?? '-', fmt(p.tvr, 2),
        p.rate_supported === false ? el('span', { class: 'flag' }, `${fmt(p.rate_lkr)} ‡`) : fmt(p.rate_lkr),
        p.rationale || '',
      ]),
      [3, 4, 5, 6],
    ));
  }

  if (r.competitor_analysis) {
    out.append(el('h3', {}, 'Against competitors'));
    out.append(el('div', { class: 'prose' }, r.competitor_analysis));
  }

  const c = r.clutter || {};
  if (c.by_belt?.length) {
    out.append(el('h3', {}, 'Time-belt spread'));
    out.append(table(['Time belt', 'Spots', 'Share of plan'],
      c.by_belt.map((x) => [x.time_belt, fmt(x.spots), `${fmt(x.share_pct, 1)}%`]), [1, 2]));
    if (c.issues?.length) for (const i of c.issues) out.append(el('div', { class: 'note' }, i.detail));
    else out.append(el('div', { class: 'note ok' }, 'No belt carries an unreasonable share of the buy.'));
  }
  if (r.clutter_strategy) out.append(el('div', { class: 'prose' }, r.clutter_strategy));

  renderScheduleGrid(out, r);

  if (r.gaps_or_caveats) {
    out.append(el('h3', {}, 'Notes & caveats'));
    out.append(el('div', { class: 'prose' }, r.gaps_or_caveats));
  }
}

// --- step 3: programme basket for the chosen channels ----------------------

/** For each chosen channel: strongest day, top programmes, competitor read. */
function renderProgrammes() {
  const out = $('#programmes-out');
  out.innerHTML = '';
  const chosen = (state.analysis?.channels || []).filter((ch) => state.selectedChannels.has(ch.channel_name));

  for (const ch of chosen) {
    const card = el('div', { class: 'explore-channel top5' });
    card.append(el('div', { class: 'channel-head' },
      el('h4', {}, ch.channel_name),
      ch.best_day ? el('span', { class: 'chip' }, `strongest day: ${ch.best_day.day} (${fmt(ch.best_day.ratings, 1)})`) : null,
      ch.competitor?.grp_share_pct ? el('span', { class: 'chip' }, `competitors ${fmt(ch.competitor.grp_share_pct, 1)}% GRP`) : null,
    ));

    const list = el('div', { class: 'programme-picker' });
    for (const p of ch.programmes || []) {
      const cp = p.competitor || {};
      const added = state.picks.some((x) => x.channel_name === ch.channel_name && x.programme_name === p.programme_name);
      const btn = el('button', { class: `ghost small-btn${added ? ' added' : ''}`, type: 'button' }, added ? 'Added' : 'Add');
      const row = el('div', { class: 'pp-row' },
        el('div', { class: 'pp-main' },
          el('span', { class: 'pp-name' }, p.programme_name),
          el('span', { class: 'pp-meta' },
            `TVR ${fmt(p.tvr, 2)} · `
            + (p.avg_cost_30s === null ? 'no 30s cost data' : `30s rate LKR ${fmt(p.avg_cost_30s)}`)
            + (cp.spots ? ` · competitors ${fmt(cp.total_grp, 1)} GRP / ${fmt(cp.spots)} spots`
              + (cp.top_brands?.length ? ` (${cp.top_brands.slice(0, 3).join(', ')})` : '') : ' · no competitor spots'))),
        btn);
      btn.addEventListener('click', () => { addPick(ch.channel_name, p); });
      list.append(row);
    }
    card.append(list);
    out.append(card);
  }

  // Who is already buying the programmes across the chosen channels.
  const pressure = chosen.flatMap((ch) => (ch.programmes || [])
    .filter((p) => (p.competitor?.spots || 0) > 0)
    .map((p) => ({ channel: ch.channel_name, programme: p.programme_name, ...p.competitor })));
  pressure.sort((a, b) => (b.total_grp || 0) - (a.total_grp || 0));
  if (pressure.length) {
    out.append(el('h3', {}, 'Who is already buying these programmes'));
    out.append(table(
      ['Channel', 'Programme', 'Competitor GRP', 'Spots', 'Brands', 'Top brands'],
      pressure.slice(0, 15).map((x) => [
        x.channel, x.programme, fmt(x.total_grp, 2), fmt(x.spots), fmt(x.brands),
        (x.top_brands || []).slice(0, 4).join(', '),
      ]),
      [2, 3, 4],
    ));
  }

  renderPicks();
}

// --- explore: picks tray ---------------------------------------------------

function addPick(channelName, programme) {
  const exists = state.picks.some(
    (p) => p.channel_name === channelName && p.programme_name === programme.programme_name,
  );
  if (exists) return;
  state.picks.push({
    channel_name: channelName,
    programme_name: programme.programme_name,
    tvr: programme.tvr,
    avg_cost_30s: programme.avg_cost_30s,
    cost_per_sec: programme.cost_per_sec,
    duration_secs: state.durations[state.durations.length - 1] || 30,
    spots: 4,
    day_pattern: 'Mon - Fri',
  });
  refreshProgrammeState();
}

function removePick(i) {
  state.picks.splice(i, 1);
  refreshProgrammeState();
}

/** Re-render the programme lists (so "Add" flips to "Added") and the tray. */
function refreshProgrammeState() {
  if (!$('#programmes-card').hidden) renderProgrammes();
  else renderPicks();
}

/** The editable tray of selected programmes, grouped by channel. */
function renderPicks() {
  const out = $('#picks-out');
  out.innerHTML = '';
  if (!state.picks.length) {
    out.append(el('div', { class: 'note' }, 'No programmes picked yet. Add programmes from the channels above.'));
    $('#build-btn').disabled = true;
    return;
  }
  $('#build-btn').disabled = false;

  const head = ['Channel', 'Programme', 'TVR', 'Length', 'Spots', 'Day pattern', 'Est. cost', ''];
  const rows = state.picks.map((pick, i) => {
    const perSec = pick.cost_per_sec;
    const lenSelect = el('select', { class: 'pick-input' },
      ...state.durations.map((d) => el('option', { value: d, ...(d === pick.duration_secs ? { selected: 'selected' } : {}) }, `${d}s`)));
    lenSelect.addEventListener('change', () => { pick.duration_secs = Number(lenSelect.value); renderPicks(); });

    const spotsInput = el('input', { class: 'pick-input', type: 'number', min: '0', max: '200', value: pick.spots });
    spotsInput.addEventListener('change', () => { pick.spots = Math.max(0, Math.round(Number(spotsInput.value) || 0)); renderPicks(); });

    const daySelect = el('select', { class: 'pick-input' },
      ...DAY_PATTERNS.map((d) => el('option', { value: d, ...(d === pick.day_pattern ? { selected: 'selected' } : {}) }, d)));
    daySelect.addEventListener('change', () => { pick.day_pattern = daySelect.value; });

    const est = perSec !== null && perSec !== undefined
      ? `LKR ${fmt(Math.round(perSec * pick.duration_secs * pick.spots))}` : '-';

    const remove = el('button', { class: 'ghost small-btn', type: 'button' }, 'Remove');
    remove.addEventListener('click', () => removePick(i));

    return [pick.channel_name, pick.programme_name, fmt(pick.tvr, 2), lenSelect, spotsInput, daySelect, est, remove];
  });
  out.append(table(head, rows, [2, 4, 6]));
}

// --- explore: build schedule -----------------------------------------------

$('#build-btn').addEventListener('click', async () => {
  const status = $('#build-status');
  const button = $('#build-btn');
  if (!state.picks.length) return;
  button.disabled = true;
  status.className = 'saved';
  status.textContent = 'Placing spots on dates, costing and checking clutter…';
  try {
    const r = await api(`/api/explore/${state.briefId}/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ picks: state.picks, channels: state.analysis?.channels || [] }),
    });
    state.planId = r.plan_id;
    status.textContent = `Schedule #${r.plan_id} · ${fmt(r.schedule_totals?.total_spots)} spots`;
    renderSchedule(r);
    $('#result-card').hidden = false;
    $('#download-out').innerHTML = '';
    $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError($('#plan-out'), err);
    $('#result-card').hidden = false;
    status.className = 'saved err';
    status.textContent = 'Could not build the schedule.';
  } finally {
    button.disabled = false;
  }
});

/**
 * Download a generated file, showing the server's error instead of saving it.
 *
 * A plain <a download> to an endpoint that fails saves the JSON error body to
 * disk - which is exactly the "it downloads as JSON" symptom when the PDF
 * worker is unavailable. Fetching first lets us check the content type and
 * surface the reason.
 */
async function downloadFile(url, buttonLabel) {
  const out = $('#download-out');
  out.innerHTML = '';
  const note = el('div', { class: 'note' }, `Preparing ${buttonLabel}…`);
  out.append(note);
  try {
    const res = await fetch(url);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('application/json')) {
      // The endpoint failed and returned an explanation rather than a file.
      let body = {};
      try { body = await res.json(); } catch { /* non-JSON error */ }
      const err = new Error(body.error || `Export failed (${res.status})`);
      err.hint = body.hint || (url.endsWith('.pdf')
        ? 'The PDF worker needs Python with matplotlib and reportlab. Use "Export schedule '
          + '(Excel)" instead, which needs neither.'
        : null);
      throw err;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const name = disposition.match(/filename="?([^"]+)"?/)?.[1]
      || url.split('/').pop().split('?')[0];

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    out.innerHTML = '';
  } catch (err) {
    showError(out, err);
  }
}

$('#xlsx-btn').addEventListener('click', () =>
  downloadFile(`/api/plans/${state.planId}/schedule.xlsx`, 'the Excel schedule'));

// The dependable "PDF": open the print-ready HTML report and let the browser
// save it as PDF - no Python worker involved.
$('#report-btn').addEventListener('click', () => {
  if (!state.planId) return;
  window.open(`/api/plans/${state.planId}/report.html`, '_blank', 'noopener');
});

$('#pdf-btn').addEventListener('click', () =>
  downloadFile(`/api/plans/${state.planId}/report.pdf`, 'the PDF'));

/** The built schedule: dated grid, clutter read, and the model's explanation. */
function renderSchedule(r) {
  const out = $('#plan-out');
  out.innerHTML = '';
  const ex = r.explanation || {};

  out.append(el('div', { class: 'actions' },
    el('span', { class: `badge ${r.confidence}` }, `confidence: ${r.confidence}`),
    el('span', { class: 'chip' }, ex.source === 'model' ? (ex.model_used || 'model') : 'deterministic explanation')));

  const b = r.budget || {};
  if (b.budget_lakhs !== null && b.budget_lakhs !== undefined) {
    out.append(el('div', { class: `budget ${b.over_budget ? 'over' : ''}` },
      el('b', {}, `LKR ${fmt(b.total_cost_lakhs, 2)} lakhs`),
      `of ${fmt(b.budget_lakhs, 2)} lakhs budget (${fmt(b.utilisation_pct, 1)}%)`,
      ` · ${fmt(b.total_spots)} spots`,
      b.uncosted_spots ? ` · ${fmt(b.uncosted_spots)} uncosted` : ''));
  }

  // The strategic explanation.
  if (ex.overall_rationale) {
    out.append(el('h3', {}, 'Why this schedule'));
    out.append(el('div', { class: 'prose' }, ex.overall_rationale));
  }
  if ((ex.per_channel || []).length) {
    out.append(el('h3', {}, 'By channel'));
    for (const pc of ex.per_channel) {
      out.append(el('div', { class: 'prose small-prose' }, el('b', {}, `${pc.channel_name}: `), pc.note));
    }
  }
  if (ex.competitor_analysis) {
    out.append(el('h3', {}, 'Against competitors'));
    out.append(el('div', { class: 'prose' }, ex.competitor_analysis));
  }

  // Clutter: the measured spread across time belts.
  const c = r.clutter || {};
  if (c.by_belt?.length) {
    out.append(el('h3', {}, 'Time-belt spread'));
    out.append(table(
      ['Time belt', 'Spots', 'Share of plan'],
      c.by_belt.map((x) => [x.time_belt, fmt(x.spots), `${fmt(x.share_pct, 1)}%`]),
      [1, 2],
    ));
    if (c.issues?.length) {
      for (const issue of c.issues) out.append(el('div', { class: 'note' }, issue.detail));
    } else {
      out.append(el('div', { class: 'note ok' }, 'No belt carries an unreasonable share of the buy.'));
    }
  }
  if (ex.clutter_strategy) {
    out.append(el('div', { class: 'prose' }, ex.clutter_strategy));
  }

  renderScheduleGrid(out, r);

  if ((r.warnings || []).length) {
    out.append(el('h3', {}, 'Notes'));
    for (const w of r.warnings) out.append(el('div', { class: 'note' }, w));
  }
}

/** The dated spot grid, shared by the manual build and the AI plan. */
function renderScheduleGrid(out, r) {
  if (!r.schedule?.length) return;
  const dates = (r.dates && r.dates.length)
    ? r.dates
    : [...new Set(r.schedule.flatMap((l) => Object.keys(l.spot_dates || {})))].sort();
  const t = r.schedule_totals || {};
  const grpNote = t.total_grp
    ? ` · ${fmt(t.total_grp, 1)} GRPs${t.weight_band && t.weight_band !== 'none' ? ` (${t.weight_band} weight)` : ''}`
    : '';
  out.append(el('h3', {}, `Schedule · ${fmt(t.total_spots)} spots${grpNote}`));
  out.append(table(
    ['Channel', 'Programme', 'Day', 'Time', 'Dur', 'TVR', 'Spots', 'Cost', ...dates.map((d) => d.slice(5))],
    r.schedule.map((l) => [
      l.channel_name, l.programme_name, l.day_pattern || '-',
      l.time_band || '-', l.duration_secs ? `${l.duration_secs}s` : '-',
      fmt(l.tvr, 2), l.spots,
      l.cost_lkr === null || l.cost_lkr === undefined ? '-' : fmt(l.cost_lkr),
      ...dates.map((d) => (l.spot_dates || {})[d] || ''),
    ]),
    [4, 5, 6, 7, ...dates.map((_, i) => i + 8)],
  ));
}

// --- settings --------------------------------------------------------------

async function loadSettings() {
  const out = $('#settings-out');
  try {
    const s = await api('/api/settings');
    const form = $('#drive-form');
    form.adex_folder.value = s.drive.adex_folder_url || s.drive.adex_folder_id || '';
    form.archive_enabled.checked = s.drive.archive_enabled !== false;

    // The client id is not secret, so it round-trips; secrets never come back,
    // and their placeholder says whether one is stored.
    form.oauth_client_id.value = s.drive.oauth_client_id || '';
    form.oauth_client_secret.placeholder = s.drive.oauth_configured ? '•••• saved' : 'GOCSPX-…';
    form.oauth_refresh_token.placeholder = s.drive.oauth_configured ? '•••• saved' : '1//0…';
    form.service_account_json.placeholder = s.drive.credentials_configured
      ? '•••• a service-account key is saved — paste a new one to replace it'
      : '{"type":"service_account","client_email":"…","private_key":"…"}';

    // The chip in the header says at a glance which auth is live.
    const chip = $('#auth-mode-chip');
    chip.textContent = { oauth: 'OAuth (user)', service_account: 'Service account' }[s.drive.auth_mode]
      || 'not configured';
    chip.className = `chip ${s.drive.auth_mode ? 'chip-ok' : ''}`;

    out.innerHTML = '';
    out.append(el('div', { class: s.drive.auth_mode ? 'note ok' : 'note' }, s.drive.share_note));
    if (s.drive.auth_mode === 'service_account' && s.drive.adex_folder_source === 'environment') {
      out.append(el('div', { class: 'note' },
        'The adex folder currently comes from an environment variable. Saving here overrides it.'));
    }
  } catch (err) {
    showError(out, err);
  }
}

$('#drive-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const saved = $('#settings-saved');
  saved.className = 'saved';
  saved.textContent = 'Saving…';
  try {
    await api('/api/settings/drive', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        adex_folder: form.adex_folder.value.trim(),
        oauth_client_id: form.oauth_client_id.value.trim(),
        // Empty means "leave the stored secret alone", not "delete it".
        ...(form.oauth_client_secret.value.trim()
          ? { oauth_client_secret: form.oauth_client_secret.value.trim() } : {}),
        ...(form.oauth_refresh_token.value.trim()
          ? { oauth_refresh_token: form.oauth_refresh_token.value.trim() } : {}),
        ...(form.service_account_json.value.trim()
          ? { service_account_json: form.service_account_json.value.trim() } : {}),
        archive_enabled: form.archive_enabled.checked,
      }),
    });
    // Don't leave secrets sitting in the inputs after they're saved.
    form.oauth_client_secret.value = '';
    form.oauth_refresh_token.value = '';
    form.service_account_json.value = '';
    saved.textContent = 'Saved';
    await loadSettings();
  } catch (err) {
    saved.className = 'saved err';
    saved.textContent = err.message;
  }
});

$('#test-drive').addEventListener('click', async () => {
  const out = $('#settings-out');
  out.innerHTML = 'Testing…';
  try {
    const r = await api('/api/settings/drive/test', { method: 'POST' });
    out.innerHTML = '';
    if (r.auth_mode === 'oauth') {
      out.append(el('div', { class: 'note ok' },
        `Signed in via OAuth${r.account_email ? ` as ${r.account_email}` : ''}. `
        + 'Write access confirmed — archiving will work.',
        r.note ? el('div', { class: 'hintline' }, r.note) : null));
    } else {
      out.append(el('div', { class: 'note ok' },
        `Connected as ${r.service_account_email}. Folder "${r.folder_name}" contains `
        + `${r.spreadsheets_found} spreadsheet(s).`
        + (r.newest ? ` Newest: ${r.newest}.` : '')));
    }
  } catch (err) {
    out.innerHTML = '';
    const box = el('div', { class: 'note err' }, err.message);
    const who = err.body?.account_email || err.body?.service_account_email;
    if (who) box.append(el('div', { class: 'hintline' }, who));
    if (err.body?.hint) box.append(el('div', { class: 'hintline' }, err.body.hint));
    out.append(box);
  }
});

async function loadArchive() {
  const out = $('#archive-out');
  try {
    const a = await api('/api/uploads/archive');
    out.innerHTML = '';
    const t = a.totals || {};
    out.append(el('div', { class: 'facets' },
      el('span', { class: 'chip' }, 'Pending purge ', el('b', {}, fmt(t.pending))),
      el('span', { class: 'chip' }, 'Kept (adex) ', el('b', {}, fmt(t.kept))),
      el('span', { class: 'chip' }, 'Purged ', el('b', {}, fmt(t.purged)))));

    if (a.files?.length) {
      out.append(table(
        ['File', 'Dataset', 'Status', 'Uploaded'],
        a.files.slice(0, 25).map((f) => [
          f.file_name, f.dataset,
          f.error ? el('span', { class: 'flag' }, f.error)
            : f.purged_at ? 'purged' : (f.keep ? 'kept' : 'in Drive'),
          new Date(f.created_at).toLocaleString(),
        ]),
      ));
    } else {
      out.append(el('div', { class: 'note' }, 'Nothing has been archived yet.'));
    }
  } catch (err) {
    showError(out, err);
  }
}

$('#purge-archive').addEventListener('click', async () => {
  const out = $('#archive-out');
  try {
    const r = await api('/api/uploads/archive/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await loadArchive();
    out.prepend(el('div', { class: 'note ok' },
      `Purged ${r.purged} file(s); ${r.kept} adex file(s) kept.`
      + (r.failed ? ` ${r.failed} could not be removed.` : '')));
  } catch (err) {
    showError(out, err);
  }
});

$('#refresh-facets').addEventListener('click', loadFacets);
$('#refresh-mw').addEventListener('click', loadMediaWatchSources);

renderDurations();
loadHealth();
loadFacets();
loadMediaWatchSources();
buildSlots();
