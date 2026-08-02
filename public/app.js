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

const state = { briefId: null, planId: null, durations: [15, 20, 30] };

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
    if (tab.dataset.tab === 'data') loadFacets();
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
  box.append(
    el('span', { class: `dot ${ok ? 'ok' : 'bad'}` }),
    h.llm?.model || h.llm?.provider || 'llm unknown',
    h.report_worker?.ok ? ' · PDF ready' : ' · PDF worker unavailable',
  );
  setBanner(ok ? null : h.db?.error, h.db?.hint);
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

    out.append(el('h3', {}, 'Channels for this panel'));
    out.append(table(
      ['Channel', 'Share of audience', 'Reach %', 'Total ratings'],
      (d.channel_performance || []).slice(0, 8).map((c) => [
        c.channel_name, fmt(c.share_of_audience, 2), fmt(c.individual_reach_pct, 1),
        fmt(c.total_ratings),
      ]),
      [1, 2, 3],
    ));

    out.append(el('h3', {}, 'Top programmes'));
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
      out.append(table(['Channel', 'Best day', 'Ratings', 'Reach %'],
        bestDays.slice(0, 8).map((x) => [x.channel_name, x.day_of_week, fmt(x.ratings), fmt(x.reach_pct, 1)]),
        [2, 3]));
    }

    if ((d.time_belt_clutter || []).length) {
      out.append(el('h3', {}, 'How crowded each time belt already is'));
      out.append(table(
        ['Time belt', 'Competitor spots', 'Share', 'Busiest channels'],
        d.time_belt_clutter.slice(0, 9).map((b) => [
          b.time_belt, fmt(b.competitor_spots), `${fmt(b.share_of_competitor_spots_pct, 1)}%`,
          (b.busiest_channels || []).map((c) => `${c.channel} (${c.spots})`).join(', '),
        ]),
        [1, 2],
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
    $('#download-out').innerHTML = '';
    $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status.className = 'saved err';
    status.textContent = err.hint ? `${err.message} ${err.hint}` : err.message;
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
$('#pdf-btn').addEventListener('click', () =>
  downloadFile(`/api/plans/${state.planId}/report.pdf`, 'the PDF'));

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
      ` · ${fmt(b.total_spots)} spots`,
      b.uncosted_spots ? ` · ${fmt(b.uncosted_spots)} uncosted` : ''));
  }

  // Channel first, programmes beneath - the order a planner actually works in.
  for (const channel of r.channel_plan || []) {
    const head = el('div', { class: 'channel-head' },
      el('h3', {}, channel.channel),
      channel.share_of_audience
        ? el('span', { class: 'chip' }, `${fmt(channel.share_of_audience, 2)}% share`)
        : null);
    out.append(head);
    if (channel.why_this_channel) {
      out.append(el('div', { class: 'prose small-prose' }, channel.why_this_channel));
    }
    out.append(table(
      ['Programme', 'Day', 'Time band', 'Dur', 'Spots', 'TVR', 'Rate', 'Why'],
      (channel.programmes || []).map((p) => [
        p.in_source_data === false
          ? el('span', {}, p.programme, el('span', { class: 'flag' }, ' †'))
          : p.programme,
        p.day_pattern || '-',
        p.time_band || '-',
        p.duration_secs ? `${p.duration_secs}s` : '-',
        p.spots ?? '-',
        fmt(p.tvr, 2),
        p.rate_supported === false
          ? el('span', { class: 'flag' }, `${fmt(p.rate_lkr)} ‡`)
          : fmt(p.rate_lkr),
        p.rationale,
      ]),
      [3, 4, 5, 6],
    ));
  }

  const g = r.grounding || {};
  if (g.unmatched?.length) {
    out.append(el('div', { class: 'note' },
      `† ${g.unmatched.length} entry/entries could not be matched to the loaded data: ${g.unmatched.join('; ')}`));
  }
  if (g.unsupported_rates?.length) {
    out.append(el('div', { class: 'note' },
      `‡ ${g.unsupported_rates.length} rate(s) have no observed spot cost behind them.`));
  }

  // Clutter: the measured spread, not just what the rationale claims.
  const c = r.clutter || {};
  if (c.by_belt?.length) {
    out.append(el('h3', {}, 'Time-belt spread'));
    out.append(table(
      ['Time belt', 'Spots', 'Share of plan'],
      c.by_belt.map((x) => [x.time_belt, fmt(x.spots), `${fmt(x.share_pct, 1)}%`]),
      [1, 2],
    ));
    if (c.issues?.length) {
      for (const issue of c.issues) {
        out.append(el('div', { class: 'note' }, issue.detail));
      }
    } else {
      out.append(el('div', { class: 'note ok' },
        'No belt carries an unreasonable share of the buy.'));
    }
  }
  if (r.clutter_strategy) {
    out.append(el('h3', {}, 'How the buy is spread'));
    out.append(el('div', { class: 'prose' }, r.clutter_strategy));
  }

  // Schedule grid.
  if (r.schedule?.length) {
    const dates = [...new Set(r.schedule.flatMap((l) => Object.keys(l.spot_dates || {})))].sort();
    out.append(el('h3', {}, `Schedule · ${fmt(r.schedule_totals?.total_spots)} spots`));
    out.append(table(
      ['Channel', 'Programme', 'Day', 'Dur', 'Spots', ...dates.map((d) => d.slice(5))],
      r.schedule.map((l) => [
        l.channel_name, l.programme_name, l.day_pattern || '-',
        l.duration_secs ? `${l.duration_secs}s` : '-', l.spots,
        ...dates.map((d) => (l.spot_dates || {})[d] || ''),
      ]),
      [3, 4, ...dates.map((_, i) => i + 5)],
    ));
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

renderDurations();
loadHealth();
loadFacets();
buildSlots();
