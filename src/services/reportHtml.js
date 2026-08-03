// ---------------------------------------------------------------------------
// A self-contained, print-ready HTML report for a plan.
//
// The PDF worker needs Python with matplotlib and reportlab, which is not
// installed on every host - so this is the export path that always works: a
// styled HTML page the browser prints to PDF (the print stylesheet hides the
// button and sets page margins). Pure Node, built from the same stored plan the
// Excel export uses, so the two never disagree.
// ---------------------------------------------------------------------------

const esc = (v) => (v === null || v === undefined ? '' : String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;'));

const money = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))
  ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const dp = (v, d = 2) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))
  ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

/**
 * Render the plan as a standalone HTML document.
 *
 * @param {Object} args
 * @param {Object} args.brief
 * @param {Object} args.plan       plan_recommendations row (chart_data, recommended_lineup, …)
 * @param {Array}  args.schedule   plan_schedule rows
 * @returns {string} a complete HTML document
 */
export function buildReportHtml({ brief = {}, plan = {}, schedule = [] }) {
  const chart = plan.chart_data || {};
  const channelPlan = plan.recommended_lineup || [];
  const budget = chart.budget || {};
  const totals = chart.schedule_totals || {};
  const dates = [...new Set(schedule.flatMap((l) => Object.keys(l.spot_dates || {})))].sort();
  const perChannel = chart.per_channel || [];
  const title = `${brief.brand || 'Media plan'} — recommended plan`;

  const header = `
    <header class="cover">
      <div class="brandline">${esc(brief.advertiser || '')}</div>
      <h1>${esc(brief.brand || 'Media plan')}</h1>
      <div class="sub">${esc(brief.objective || 'Recommended TV plan')}</div>
      <div class="meta">
        ${metaChip('Audience', brief.target_audience)}
        ${metaChip('Period', period(brief))}
        ${metaChip('Budget', brief.budget_lkr_lakhs ? `LKR ${dp(brief.budget_lkr_lakhs, 2)} lakhs` : null)}
        ${metaChip('Confidence', plan.confidence)}
        ${metaChip('Prepared', new Date().toISOString().slice(0, 10))}
      </div>
    </header>`;

  const grpNote = totals.total_grp
    ? ` · ${dp(totals.total_grp, 1)} GRPs${totals.weight_band && totals.weight_band !== 'none' ? ` (${esc(totals.weight_band)} weight)` : ''}`
    : '';
  const budgetBlock = budget.budget_lakhs !== null && budget.budget_lakhs !== undefined
    ? `<div class="budget ${budget.over_budget ? 'over' : 'ok'}">
         <b>LKR ${dp(budget.total_cost_lakhs, 2)} lakhs</b> of ${dp(budget.budget_lakhs, 2)} lakhs
         (${dp(budget.utilisation_pct, 1)}%) · ${money(budget.total_spots ?? totals.total_spots)} spots${grpNote}
       </div>`
    : `<div class="budget ok"><b>${money(totals.total_spots)} spots</b>${grpNote} · budget not stated</div>`;

  const strategy = section('Strategy', plan.overall_rationale)
    + section('Against competitors', plan.competitor_analysis || chart.competitor_analysis)
    + section('How the buy is spread', chart.clutter_strategy);

  const perChannelBlock = perChannel.length
    ? `<h2>By channel</h2>${perChannel.map((p) =>
      `<p><b>${esc(p.channel_name)}:</b> ${esc(p.note)}</p>`).join('')}`
    : channelPlan.map(channelCard).join('');

  const scheduleBlock = schedule.length ? `
    <h2>Schedule</h2>
    <div class="scroll">
      <table class="grid">
        <thead><tr>
          <th>Channel</th><th>Programme</th><th>Day</th><th>Time</th><th>Dur</th>
          <th class="num">TVR</th><th class="num">Spots</th><th class="num">Cost</th>
          ${dates.map((d) => `<th class="num tiny">${d.slice(5)}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${schedule.map((l) => `<tr>
            <td>${esc(l.channel_name)}</td><td>${esc(l.programme_name)}</td>
            <td>${esc(l.day_pattern || '-')}</td><td>${esc(l.time_band || '-')}</td>
            <td>${l.duration_secs ? `${l.duration_secs}s` : '-'}</td>
            <td class="num">${dp(l.tvr, 2)}</td><td class="num">${money(l.spots)}</td>
            <td class="num">${l.cost_lkr === null || l.cost_lkr === undefined ? '-' : money(l.cost_lkr)}</td>
            ${dates.map((d) => `<td class="num tiny">${(l.spot_dates || {})[d] || ''}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const caveats = plan.gaps_or_caveats
    ? `<h2>Notes & caveats</h2><p class="caveat">${esc(plan.gaps_or_caveats).replace(/\n+/g, '<br>')}</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body>
  <button class="printbtn" onclick="window.print()">Save as PDF / Print</button>
  ${header}
  ${budgetBlock}
  ${strategy}
  ${perChannelBlock}
  ${scheduleBlock}
  ${caveats}
  <footer>Generated by the Media Planning &amp; Analysis Assistant · ${new Date().toISOString().slice(0, 10)}</footer>
</body></html>`;
}

function channelCard(channel) {
  const programmes = channel.programmes || [];
  const rows = programmes.map((p) => `<tr>
      <td>${esc(p.programme || p.programme_name)}</td>
      <td>${esc(p.day_pattern || '-')}</td>
      <td>${esc(p.time_band || '-')}</td>
      <td>${p.duration_secs ? `${p.duration_secs}s` : '-'}</td>
      <td class="num">${money(p.spots)}</td>
      <td class="num">${dp(p.tvr, 2)}</td>
      <td class="num">${p.rate_lkr === null || p.rate_lkr === undefined ? '-' : money(p.rate_lkr)}</td>
    </tr>`).join('');
  return `
    <div class="channel">
      <h3>${esc(channel.channel || channel.channel_name)}${channel.share_of_audience
        ? ` <span class="pill">${dp(channel.share_of_audience, 2)}% share</span>` : ''}</h3>
      ${channel.why_this_channel ? `<p class="why">${esc(channel.why_this_channel)}</p>` : ''}
      <div class="scroll"><table>
        <thead><tr><th>Programme</th><th>Day</th><th>Time band</th><th>Dur</th>
          <th class="num">Spots</th><th class="num">TVR</th><th class="num">Rate</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

function section(heading, body) {
  const text = (body || '').trim();
  if (!text) return '';
  return `<h2>${esc(heading)}</h2><p>${esc(text).replace(/\n+/g, '<br>')}</p>`;
}

function metaChip(label, value) {
  if (!value) return '';
  return `<span class="chip"><span>${esc(label)}</span>${esc(value)}</span>`;
}

function period(brief) {
  if (brief.period_start && brief.period_end) return `${brief.period_start} → ${brief.period_end}`;
  if (brief.period_start) return `from ${brief.period_start}`;
  return null;
}

const STYLE = `
  :root { --ink:#23272e; --muted:#6b7280; --line:#e2e6ea; --accent:#c8734a; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); margin: 0; padding: 32px 40px 60px; max-width: 1000px; }
  h1 { font-size: 30px; margin: 2px 0 4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted);
    margin: 26px 0 6px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  h3 { font-size: 17px; margin: 0 0 4px; }
  p { margin: 6px 0; }
  .cover { border-bottom: 3px solid var(--accent); padding-bottom: 14px; }
  .brandline { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .sub { color: #45505c; font-size: 15px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .chip { background: #f2f4f6; border-radius: 16px; padding: 4px 12px; font-size: 12.5px; }
  .chip span { color: var(--muted); margin-right: 5px; }
  .budget { margin: 16px 0; padding: 11px 15px; border-radius: 7px; font-size: 14px;
    background: #f2f8f4; color: #2f5c3f; }
  .budget.over { background: #fdf2f1; color: #7d3a33; }
  .budget b { font-size: 17px; }
  .channel { margin: 14px 0; padding: 12px 14px; border: 1px solid var(--line);
    border-radius: 8px; break-inside: avoid; }
  .channel .why { color: #45505c; font-size: 13px; }
  .pill { font-size: 12px; color: var(--accent); font-weight: 600; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12.5px; }
  th { background: var(--ink); color: #fff; text-align: left; font-weight: 600; font-size: 11.5px; }
  th, td { padding: 6px 8px; border: 1px solid var(--line); }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .tiny { font-size: 10.5px; padding: 4px 5px; }
  .caveat { color: #7d3a33; font-size: 13px; }
  footer { margin-top: 30px; color: var(--muted); font-size: 11px; }
  .printbtn { position: fixed; top: 16px; right: 16px; background: var(--accent); color: #fff;
    border: none; border-radius: 6px; padding: 9px 15px; font-size: 13px; font-weight: 600;
    cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  @media print {
    body { padding: 0; max-width: none; }
    .printbtn { display: none; }
    h2 { break-after: avoid; }
    .channel, table { break-inside: avoid; }
    @page { margin: 14mm; }
  }`;
