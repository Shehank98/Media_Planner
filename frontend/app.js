"use strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return n;
};
const money = (v) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const num = (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return p.toString();
};
const selected = (sel) => Array.from($(sel).selectedOptions).map((o) => o.value);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.blob();
}

let toastTimer;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.background = isErr ? "#b5342b" : "#16293f";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function fillSelect(sel, items, { keepAll } = {}) {
  const node = $(sel);
  const first = keepAll ? node.querySelector("option") : null;
  node.innerHTML = "";
  if (first) node.append(first);
  items.forEach((it) => node.append(el("option", { value: it }, it)));
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
$$(".nav-item").forEach((btn) =>
  btn.addEventListener("click", () => {
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $$(".tab").forEach((t) => (t.hidden = t.id !== tab));
    onTabShow(tab);
  })
);

const loaded = {};
function onTabShow(tab) {
  if (loaded[tab]) return;
  loaded[tab] = true;
  if (tab === "market") initMarket();
  if (tab === "tab1") initTab1();
  if (tab === "tab2") initTab2();
  if (tab === "tab3") initTab3();
  if (tab === "ratecards") initRateCards();
  if (tab === "data") initData();
  if (tab === "settings") initSettings();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
(async function health() {
  try {
    const h = await api("/api/health");
    $("#health-dot").classList.add("ok");
    $("#health-text").textContent = h.gemini_configured ? "Online · Gemini ready" : "Online · no Gemini key";
  } catch (_) {
    $("#health-dot").classList.add("bad");
    $("#health-text").textContent = "API offline";
  }
})();

// ---------------------------------------------------------------------------
// Shared: KPI tiles + AI analysis block
// ---------------------------------------------------------------------------
function kpiTile(label, value, sub, accent) {
  const t = el("div", { class: "kpi" + (accent ? " accent" : "") });
  t.append(el("div", { class: "kpi-label" }, label));
  t.append(el("div", { class: "kpi-value" }, value));
  if (sub) t.append(el("div", { class: "kpi-sub" }, sub));
  return t;
}

function renderOverviewKpis(boxSel, ov) {
  const box = $(boxSel);
  box.innerHTML = "";
  const range = ov.date_from ? `${ov.date_from} → ${ov.date_to}` : "no dates";
  box.append(kpiTile("Total market spend", money(ov.total_spend), range, true));
  box.append(kpiTile("Advertisers", num(ov.advertisers, 0), `${num(ov.spots,0)} paid spots`));
  box.append(kpiTile("Channels", num(ov.channels, 0), `${num(ov.categories,0)} categories`));
  if (ov.top_category) box.append(kpiTile("Top category", ov.top_category.name, money(ov.top_category.spend)));
  if (ov.top_advertiser) box.append(kpiTile("Top advertiser", ov.top_advertiser.name, money(ov.top_advertiser.spend)));
  box.append(kpiTile("Bonus value (V/A)", `${num(ov.va_spots,0)} spots`, `${num(ov.va_seconds,0)}s free airtime`));
}

// Render an AI analysis card that reads the pre-computed figures.
async function renderAiRead(boxSel, productGroups) {
  const box = $(boxSel);
  box.hidden = false;
  box.className = "card ai-card";
  box.innerHTML = '<div class="ai-head"><span class="ai-badge">AI market read</span></div><div class="ai-body"><span class="spinner"></span> Reading the numbers…</div>';
  try {
    const r = await api("/api/market/ai-read", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_groups: productGroups || null }),
    });
    box.querySelector(".ai-body").textContent = r.analysis;
  } catch (e) {
    box.querySelector(".ai-body").innerHTML = `<span class="status err">${e.message}</span>`;
  }
}

// ---------------------------------------------------------------------------
// MARKET OVERVIEW
// ---------------------------------------------------------------------------
async function initMarket() {
  const box = $("#mkt-results");
  box.innerHTML = '<div class="card"><span class="spinner"></span> Loading market…</div>';
  try {
    const ov = await api("/api/market/overview");
    renderOverviewKpis("#mkt-kpis", ov);
    box.innerHTML = "";

    box.append(chartCard("Monthly spend by medium", "/api/market/charts/trend.png"));
    box.append(dualCard(
      chartFragment("Top categories by spend", "/api/market/charts/top-categories.png"),
      chartFragment("Share of Voice over time", "/api/market/charts/sov.png")
    ));
    box.append(chartCard("Advertiser spend heatmap (by month)", "/api/market/charts/heatmap.png"));
    box.append(chartCard("Biggest movers", "/api/market/charts/growth.png"));

    // movement tables
    const g = await api("/api/market/growth");
    if (g.gainers.length || g.losers.length || g.new_entrants.length) {
      box.append(movementCard(g));
    }
    renderAiRead("#mkt-ai", null);
  } catch (e) {
    box.innerHTML = `<div class="card status err">${e.message}</div>`;
  }
}

function movementCard(g) {
  const card = el("div", { class: "card" });
  const grid = el("div", { class: "grid-2" });
  const gain = el("div");
  gain.append(el("div", { class: "section-title" }, "Gainers (2nd half vs 1st)"));
  gain.append(tableFragment("", ["Advertiser", "Before", "After", "Δ Spend"],
    g.gainers.map((c) => [c.advertiser, money(c.before), money(c.after), "+" + money(c.delta)])));
  const lose = el("div");
  lose.append(el("div", { class: "section-title" }, "Decliners"));
  lose.append(tableFragment("", ["Advertiser", "Before", "After", "Δ Spend"],
    g.losers.map((c) => [c.advertiser, money(c.before), money(c.after), money(c.delta)])));
  grid.append(gain, lose);
  card.append(grid);
  if (g.new_entrants.length) {
    card.append(el("div", { class: "section-title", style: "margin-top:16px" }, "New entrants (2nd half only)"));
    card.append(tableFragment("", ["Advertiser", "Spend"], g.new_entrants.map((n) => [n.advertiser, money(n.spend)])));
  }
  return card;
}

// ---------------------------------------------------------------------------
// TAB 1 - Category / Pitch
// ---------------------------------------------------------------------------
async function initTab1() {
  try {
    const groups = await api("/api/tab1/product-groups");
    fillSelect("#t1-groups", groups);
  } catch (e) { toast(e.message, true); }

  $("#t1-groups").addEventListener("change", async () => {
    const pgs = selected("#t1-groups");
    const advs = await api("/api/tab1/advertisers?" + qs({ product_groups: pgs }));
    fillSelect("#t1-advertisers", advs);
  });

  $("#t1-run").addEventListener("click", runTab1);
  $("#t1-ask").addEventListener("click", askTab1);
  $("#t1-report").addEventListener("click", () => {
    const m = $("#t1-report-menu");
    m.hidden = !m.hidden;
  });
  $$("#t1-report-menu button").forEach((b) =>
    b.addEventListener("click", () => exportReport(b.dataset.fmt))
  );
}

async function runTab1() {
  const pgs = selected("#t1-groups");
  const advs = selected("#t1-advertisers");
  if (!pgs.length) return toast("Pick at least one product group", true);
  const box = $("#t1-results");
  box.innerHTML = '<div class="card"><span class="spinner"></span> Computing…</div>';
  const query = qs({ product_groups: pgs, advertisers: advs });
  const pgQuery = qs({ product_groups: pgs });

  try {
    const [ov, ms, top, sos, va] = await Promise.all([
      api("/api/market/overview?" + pgQuery),
      api("/api/tab1/medium-split?" + query),
      api("/api/tab1/top-advertisers?" + pgQuery),
      api("/api/tab1/sos?" + qs({ product_groups: pgs, medium: "TV" })),
      api("/api/tab1/value-addition?" + query),
    ]);
    renderOverviewKpis("#t1-kpis", ov);
    box.innerHTML = "";

    box.append(chartCard("Spend trend", "/api/tab1/charts/trend.png?" + query));
    box.append(dualCard(
      chartFragment("Medium split", "/api/tab1/charts/medium-split.png?" + query),
      tableFragment("Medium split", ["Medium", "Spend", "Spots"], ms.map((m) => [m.medium, money(m.spend), m.spots]))
    ));
    box.append(dualCard(
      chartFragment("Top 5 SOS — TV", "/api/tab1/charts/sos.png?" + qs({ product_groups: pgs, medium: "TV" })),
      tableFragment("Share of Spend (TV)", ["Advertiser", "Spend", "Share %"], sos.map((s) => [s.advertiser, money(s.spend), num(s.share_pct) + "%"]))
    ));
    box.append(chartCard("Share of Voice over time", "/api/market/charts/sov.png?" + pgQuery));
    box.append(dualCard(
      chartFragment("Top advertisers", "/api/tab1/charts/top-advertisers.png?" + pgQuery),
      tableFragment("Top advertisers", ["Advertiser", "Spend", "Spots"], top.map((t) => [t.advertiser, money(t.spend), t.spots]))
    ));
    box.append(chartCard("Advertiser spend heatmap (by month)", "/api/market/charts/heatmap.png?" + pgQuery));
    box.append(chartCard("Biggest movers", "/api/market/charts/growth.png?" + pgQuery));

    const g = await api("/api/market/growth?" + pgQuery);
    if (g.gainers.length || g.losers.length || g.new_entrants.length) box.append(movementCard(g));

    const vaCard = el("div", { class: "card" });
    vaCard.append(el("div", { class: "section-title" }, "Bonus value received (V/A — excluded from spend)"));
    vaCard.append(el("p", { class: "muted" }, `${va.va_spots} value-addition spots · ${num(va.va_seconds, 0)} seconds of bonus airtime.`));
    box.append(vaCard);

    // Competitor view when a single lead advertiser is chosen
    if (advs.length === 1) {
      const comp = await api("/api/tab1/competitor?" + qs({ product_groups: pgs, lead_advertiser: advs[0] }));
      box.append(competitorCard(comp));
    }

    renderAiRead("#t1-ai", pgs);
  } catch (e) {
    box.innerHTML = `<div class="card status err">${e.message}</div>`;
  }
}

function competitorCard(comp) {
  const card = el("div", { class: "card" });
  card.append(el("div", { class: "section-title" }, `Competitor view — ${comp.lead.advertiser}`));
  const rows = [[comp.lead.advertiser + " (lead)", money(comp.lead.spend)]].concat(
    comp.competitors.map((c) => [c.advertiser, money(c.spend)])
  );
  card.append(tableFragment("", ["Advertiser", "Total spend"], rows));
  return card;
}

async function askTab1() {
  const q = $("#t1-q").value.trim();
  if (!q) return;
  const ans = $("#t1-answer");
  ans.innerHTML = '<span class="spinner"></span> Thinking…';
  try {
    const r = await api("/api/tab1/narrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, product_groups: selected("#t1-groups"), advertisers: selected("#t1-advertisers") }),
    });
    ans.textContent = r.narrative;
  } catch (e) { ans.innerHTML = `<span class="status err">${e.message}</span>`; }
}

async function exportReport(fmt) {
  $("#t1-report-menu").hidden = true;
  const pgs = selected("#t1-groups");
  if (!pgs.length) return toast("Pick a product group first", true);
  const advs = selected("#t1-advertisers");
  toast("Generating report…");
  try {
    const res = await fetch("/api/tab1/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_groups: pgs, lead_advertiser: advs[0] || null, format: fmt }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    downloadBlob(await res.blob(), fmt === "docx" ? "pitch-report.docx" : "pitch-report.pdf");
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------------------
// TAB 2 - Basket & CPRP
// ---------------------------------------------------------------------------
const basket = [];
async function initTab2() {
  try { fillSelect("#t2-channel", await api("/api/tab2/channels"), { keepAll: true }); }
  catch (e) { toast(e.message, true); }
  $("#t2-run").addEventListener("click", runTab2);
  $("#t2-export").addEventListener("click", exportBasket);
}

async function runTab2() {
  const channel = $("#t2-channel").value;
  const slot = $("#t2-slot").value;
  const metric = $("#t2-metric").value;
  const box = $("#t2-results");
  box.innerHTML = '<div class="card"><span class="spinner"></span> Computing CPRP…</div>';
  try {
    const rows = await api("/api/tab2/best-programmes?" + qs({ channel, slot, metric, limit: 40 }));
    box.innerHTML = "";
    box.append(chartCard("CPRP by Programme", "/api/tab2/cprp-chart.png?" + qs({ channel, slot, limit: 15 })));

    const card = el("div", { class: "card" });
    card.append(el("div", { class: "section-title" }, "Programmes — TVR & CPRP"));
    const head = ["+", "Channel", "Programme", "Slot", "Avg TVR", "Reach %", "30s Rate", "Raw Rate", "CPRP", "Rate source"];
    const table = el("table");
    table.append(el("tr", {}, ...head.map((h) => el("th", { class: ["Avg TVR", "Reach %", "30s Rate", "Raw Rate", "CPRP"].includes(h) ? "num" : "" }, h))));
    rows.forEach((r) => {
      const cb = el("input", { type: "checkbox", onchange: (e) => toggleBasket(e.target.checked, r) });
      const dur = r.rate_duration_secs ? ` (${r.rate_duration_secs}s)` : "";
      table.append(el("tr", {},
        el("td", {}, cb),
        el("td", {}, r.channel || "—"),
        el("td", {}, r.programme || "—"),
        el("td", {}, slotPill(r.slot)),
        el("td", { class: "num" }, num(r.avg_tvr, 2)),
        el("td", { class: "num" }, num(r.avg_reach_pct, 1)),
        el("td", { class: "num" }, money(r.rate_30s_equivalent)),
        el("td", { class: "num" }, r.raw_rate == null ? "—" : money(r.raw_rate) + dur),
        el("td", { class: "num" }, r.cprp == null ? "—" : num(r.cprp)),
        el("td", {}, el("span", { class: "muted" }, r.rate_source || "no rate"))
      ));
    });
    card.append(table);
    box.append(card);
  } catch (e) { box.innerHTML = `<div class="card status err">${e.message}</div>`; }
}

function toggleBasket(on, row) {
  const key = row.channel + "||" + row.programme;
  const idx = basket.findIndex((b) => b.channel + "||" + b.programme === key);
  if (on && idx < 0) basket.push({ channel: row.channel, programme: row.programme });
  if (!on && idx >= 0) basket.splice(idx, 1);
  renderBasket();
}

async function renderBasket() {
  const card = $("#t2-basket-card");
  const box = $("#t2-basket");
  if (!basket.length) { card.hidden = true; return; }
  card.hidden = false;
  box.innerHTML = '<span class="spinner"></span>';
  try {
    const r = await api("/api/tab2/basket", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: basket }),
    });
    box.innerHTML = "";
    box.append(tableFragment("", ["Channel", "Programme", "Slot", "TVR", "Reach", "30s Rate", "CPRP"],
      r.lines.map((l) => [l.channel, l.programme, l.slot || "—", num(l.tvr, 2), money(l.reach), money(l.rate_30s_equivalent), num(l.cprp)])
    ));
    const t = r.totals;
    box.append(el("p", { class: "section-title" },
      `Basket: TVR ${num(t.total_tvr, 1)} · Reach ${money(t.total_reach)} · Cost ${money(t.total_cost)} · Blended CPRP ${num(t.blended_cprp)}`));
    $("#t2-export").hidden = false;
  } catch (e) { box.innerHTML = `<span class="status err">${e.message}</span>`; }
}

async function exportBasket() {
  const res = await fetch("/api/tab2/basket/export.csv", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selections: basket }),
  });
  downloadBlob(await res.blob(), "basket.csv");
}

// ---------------------------------------------------------------------------
// TAB 3 - Channel View
// ---------------------------------------------------------------------------
async function initTab3() {
  try { fillSelect("#t3-channel", await api("/api/tab3/channels")); }
  catch (e) { toast(e.message, true); }
  $("#t3-run").addEventListener("click", runTab3);
}

async function runTab3() {
  const channel = $("#t3-channel").value;
  if (!channel) return;
  const box = $("#t3-results");
  box.innerHTML = '<div class="card"><span class="spinner"></span> Loading…</div>';
  try {
    const data = await api("/api/tab3/overview?" + qs({ channel }));
    box.innerHTML = "";
    box.append(dualCard(
      chartFragment("Top Advertisers", "/api/tab3/charts/advertisers.png?" + qs({ channel })),
      tableFragment("Advertisers on channel", ["Advertiser", "Category", "Spend", "Spots"],
        data.advertisers.map((a) => [a.advertiser, a.product_group || "—", money(a.spend), a.spots]))
    ));
    box.append(dualCard(
      chartFragment("Top Programmes", "/api/tab3/charts/programmes.png?" + qs({ channel })),
      tableFragment("Programmes on channel", ["Programme", "Spend", "Spots"],
        data.programmes.map((p) => [p.programme, money(p.spend), p.spots]))
    ));
  } catch (e) { box.innerHTML = `<div class="card status err">${e.message}</div>`; }
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------
function slotPill(slot) {
  if (!slot) return el("span", { class: "muted" }, "—");
  return el("span", { class: "pill " + (slot === "PT" ? "pt" : "npt") }, slot === "PT" ? "Prime" : "Non-Prime");
}
function chartFragment(title, src) {
  const f = document.createDocumentFragment();
  if (title) f.append(el("div", { class: "section-title" }, title));
  f.append(el("img", { class: "chart-img", src, loading: "lazy", alt: title }));
  return f;
}
function chartCard(title, src) {
  const card = el("div", { class: "card" });
  card.append(chartFragment(title, src));
  return card;
}
function tableFragment(title, headers, rows) {
  const f = document.createDocumentFragment();
  if (title) f.append(el("div", { class: "section-title" }, title));
  const table = el("table");
  const numCols = headers.map((h) => /spend|share|tvr|reach|rate|cprp|spots|cost/i.test(h));
  table.append(el("tr", {}, ...headers.map((h, i) => el("th", { class: numCols[i] ? "num" : "" }, h))));
  rows.forEach((r) => table.append(el("tr", {}, ...r.map((c, i) => el("td", { class: numCols[i] ? "num" : "" }, String(c))))));
  f.append(table);
  return f;
}
function dualCard(a, b) {
  const card = el("div", { class: "card" });
  const grid = el("div", { class: "grid-2" });
  const left = el("div"); left.append(a);
  const right = el("div"); right.append(b);
  grid.append(left, right);
  card.append(grid);
  return card;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Async upload + polling (shared)
// ---------------------------------------------------------------------------
async function uploadAndPoll(kind, fileInput, statusEl, onReview) {
  const file = $(fileInput).files[0];
  if (!file) return toast("Choose a file first", true);
  const s = $(statusEl);
  s.className = "status"; s.innerHTML = '<span class="spinner"></span> Uploading…';
  const fd = new FormData(); fd.append("file", file);
  try {
    const { job_id } = await api(`/api/uploads/${kind}`, { method: "POST", body: fd });
    s.innerHTML = '<span class="spinner"></span> Parsing in background…';
    const review = await pollJob(job_id);
    s.className = "status ok"; s.textContent = "Parsed — review below before saving.";
    onReview(job_id, review);
  } catch (e) { s.className = "status err"; s.textContent = e.message; }
}

async function pollJob(jobId) {
  for (let i = 0; i < 120; i++) {
    const st = await api(`/api/jobs/${jobId}`);
    if (st.status === "failed") throw new Error(st.error || "parse failed");
    if (st.status === "awaiting_review") return api(`/api/jobs/${jobId}/review`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for parse");
}

async function confirmJob(jobId, body) {
  return api(`/api/jobs/${jobId}/confirm`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

// ---------------------------------------------------------------------------
// RATE CARDS
// ---------------------------------------------------------------------------
function initRateCards() {
  $("#rc-upload").addEventListener("click", () =>
    uploadAndPoll("rate_card", "#rc-file", "#rc-status", renderRateCardReview));
  loadRateCardBatches();
}

let rcStaged = null, rcJobId = null;
function renderRateCardReview(jobId, review) {
  rcJobId = jobId;
  rcStaged = review.payload;
  const box = $("#rc-review");
  box.innerHTML = "";
  review.payload.forEach((block, bi) => {
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "section-title" }, `${block.channel} — ${block.row_count} rows`));

    // Editable effective date + duration
    const controls = el("div", { class: "ask-row" });
    const dateInput = el("input", { type: "date", value: block.effective_date || "", oninput: (e) => (rcStaged[bi].effective_date = e.target.value) });
    const dateFlag = block.effective_date_method === "failed"
      ? el("span", { class: "pill warn" }, "date not parsed — enter manually")
      : el("span", { class: "pill given" }, "date: " + block.effective_date_method);
    controls.append(el("label", {}, "Effective date"), dateInput, dateFlag);

    if (block.duration_needs_input) {
      const durInput = el("input", { type: "number", placeholder: "spot secs (e.g. 30)", oninput: (e) => applyDuration(bi, Number(e.target.value)) });
      controls.append(el("span", { class: "pill warn" }, "duration not stated — specify"), durInput);
    } else {
      controls.append(el("span", { class: "pill given" }, `duration: ${block.rate_duration_secs}s`));
    }
    card.append(controls);

    // Rows preview (first 12)
    const table = el("table");
    table.append(el("tr", {}, ...["Programme", "PT/NPT", "Src", "Days", "Start", "Rack", "30s eq"].map((h) => el("th", {}, h))));
    block.rows.slice(0, 12).forEach((r) => {
      table.append(el("tr", {},
        el("td", {}, r.programme || "—"),
        el("td", {}, r.prime_non_prime || "(infer)"),
        el("td", {}, el("span", { class: "pill " + (r.prime_non_prime_source === "given" ? "given" : "inferred") }, r.prime_non_prime_source)),
        el("td", {}, r.days_label || "—"),
        el("td", {}, r.start_time || "—"),
        el("td", { class: "num" }, money(r.rack_rate)),
        el("td", { class: "num" }, r.rate_30s_equivalent == null ? "—" : money(r.rate_30s_equivalent))
      ));
    });
    if (block.rows.length > 12) card.append(el("p", { class: "muted" }, `…and ${block.rows.length - 12} more rows`));
    card.append(table);
    box.append(card);
  });

  const save = el("button", { class: "btn primary", onclick: saveRateCards }, "Confirm & Save all channels");
  box.append(el("div", { class: "card" }, save));
}

function applyDuration(bi, secs) {
  if (!secs) return;
  rcStaged[bi].rate_duration_secs = secs;
  rcStaged[bi].rows.forEach((r) => {
    r.rate_duration_secs = secs;
    if (r.rack_rate != null) r.rate_30s_equivalent = Math.round(r.rack_rate * (30 / secs) * 100) / 100;
  });
}

async function saveRateCards() {
  try {
    const r = await confirmJob(rcJobId, { blocks: rcStaged });
    toast(`Saved ${r.rows} rate rows`);
    $("#rc-review").innerHTML = "";
    loadRateCardBatches();
  } catch (e) { toast(e.message, true); }
}

async function loadRateCardBatches() {
  const box = $("#rc-batches");
  try {
    const batches = await api("/api/rate-cards/batches");
    box.innerHTML = "";
    if (!batches.length) { box.innerHTML = '<p class="muted">No rate cards stored yet.</p>'; return; }
    batches.forEach((b) => box.append(batchRow(b, `${(b.channels || []).join(", ")}`, () => deleteRateCardBatch(b.batch_id))));
  } catch (e) { box.innerHTML = `<span class="status err">${e.message}</span>`; }
}

async function deleteRateCardBatch(id) {
  if (!confirm("Delete this rate card batch?")) return;
  await api("/api/rate-cards/batches/" + id, { method: "DELETE" });
  toast("Deleted"); loadRateCardBatches();
}

// ---------------------------------------------------------------------------
// DATA & UPLOADS (adex/media-watch spend + TVR ratings - two separate datasets)
// ---------------------------------------------------------------------------
function initData() {
  $("#adex-upload").addEventListener("click", () =>
    uploadAndPoll("adex", "#adex-file", "#adex-status", (id, r) => renderGenericReview("adex", id, r, "#adex-review", loadAdexBatches)));
  $("#mw-upload").addEventListener("click", () =>
    uploadAndPoll("tvr", "#mw-file", "#mw-status", (id, r) => renderGenericReview("tvr", id, r, "#mw-review", loadMwBatches)));
  loadAdexBatches(); loadMwBatches();
}

function renderGenericReview(kind, jobId, review, boxSel, reload) {
  const box = $(boxSel);
  const s = review.summary;
  box.innerHTML = "";
  const card = el("div", { class: "card" });
  card.append(el("div", { class: "section-title" }, "Review"));
  const facts = el("ul");
  facts.append(el("li", {}, `Rows parsed: ${s.row_count}`));
  if (kind === "adex") {
    facts.append(el("li", {}, `Paid (Com) rows: ${s.com_rows} · Com spend: ${money(s.com_spend_total)}`));
    facts.append(el("li", {}, `V/A (bonus) rows excluded from spend: ${s.va_rows}`));
  }
  card.append(facts);
  if (s.header_mismatch) {
    card.append(el("p", { class: "pill warn" }, "Header mismatch: " + (s.missing_required || []).join(", ")));
    card.append(el("p", { class: "muted" }, "Missing required columns — confirm the sheet is correct before saving."));
  }
  card.append(el("button", { class: "btn primary", onclick: async () => {
    try { const r = await confirmJob(jobId, {}); toast(`Saved ${r.rows} rows`); box.innerHTML = ""; reload(); }
    catch (e) { toast(e.message, true); }
  } }, "Confirm & Save"));
  box.append(card);
}

async function loadAdexBatches() { await loadBatches("/api/tab1/batches", "#adex-batches", "adex"); }
async function loadMwBatches() { await loadBatches("/api/tab2/batches", "#mw-batches", "tvr"); }

async function loadBatches(url, boxSel, kind) {
  const box = $(boxSel);
  try {
    const batches = await api(url);
    box.innerHTML = "";
    if (!batches.length) { box.innerHTML = '<p class="muted">None yet.</p>'; return; }
    batches.forEach((b) => box.append(batchRow(b, `${b.row_count} rows`, async () => {
      if (!confirm("Delete this batch?")) return;
      await api(`${url}/${b.batch_id}`, { method: "DELETE" });
      toast("Deleted"); loadBatches(url, boxSel, kind);
    })));
  } catch (e) { box.innerHTML = `<span class="status err">${e.message}</span>`; }
}

function batchRow(b, detail, onDelete) {
  const row = el("div", { class: "ask-row", style: "justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0" });
  const left = el("div");
  left.append(el("div", {}, b.filename));
  left.append(el("div", { class: "muted" }, `${detail} · ${(b.uploaded_at || "").slice(0, 16).replace("T", " ")}`));
  row.append(left, el("button", { class: "btn small danger", onclick: onDelete }, "Delete"));
  return row;
}

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
async function loadSettingsValues() {
  try {
    const s = await api("/api/settings");
    $("#prime-start").value = s.prime_start || "18:00";
    $("#prime-end").value = s.prime_end || "22:00";
    $("#analysis-text").value = s.analysis_guide || "";
    $("#template-text").value = s.template_guide || "";
  } catch (e) { toast(e.message, true); }
}

async function initSettings() {
  await loadSettingsValues();

  $("#prime-save").addEventListener("click", async () => {
    try {
      await api("/api/settings/prime-window", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: $("#prime-start").value, end: $("#prime-end").value }),
      });
      toast("Prime window saved");
    } catch (e) { toast(e.message, true); }
  });

  const saveGuide = async (kind, textSel, statusSel) => {
    try {
      const r = await api(`/api/settings/${kind}-guide`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: $(textSel).value }),
      });
      $(statusSel).className = "status ok";
      $(statusSel).textContent = "Saved (" + (r.analysis_chars ?? r.template_chars) + " chars).";
    } catch (e) { toast(e.message, true); }
  };
  const uploadGuide = async (kind, fileSel) => {
    const f = $(fileSel).files[0];
    if (!f) return toast("Choose a file", true);
    const fd = new FormData(); fd.append("file", f);
    try { await api(`/api/settings/${kind}-guide/upload`, { method: "POST", body: fd }); toast("Uploaded"); loadSettingsValues(); }
    catch (e) { toast(e.message, true); }
  };

  $("#analysis-save").addEventListener("click", () => saveGuide("analysis", "#analysis-text", "#analysis-status"));
  $("#template-save").addEventListener("click", () => saveGuide("template", "#template-text", "#template-status"));
  $("#analysis-upload").addEventListener("click", () => uploadGuide("analysis", "#analysis-file"));
  $("#template-upload").addEventListener("click", () => uploadGuide("template", "#template-file"));
}

// Init default tab
onTabShow("market");
