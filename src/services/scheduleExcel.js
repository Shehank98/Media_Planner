import ExcelJS from 'exceljs';

// ---------------------------------------------------------------------------
// Export the plan schedule as an .xlsx in the agency recon-schedule layout.
//
// This is pure Node (ExcelJS, already a dependency), so unlike the PDF it needs
// no Python and works anywhere the app runs - which is why it is the reliable
// export path. The layout mirrors the "Sample Schedule" template: a header
// block, one row per channel/programme/day-pattern line, a dated spot grid on
// the right, and channel subtotals.
// ---------------------------------------------------------------------------

const INK = 'FF23272E';
const BAND = 'FFF4F6F8';
const RULE = 'FFDDE1E6';
const ACCENT = 'FFC8734A';

const FIXED_COLUMNS = [
  { key: 'channel', header: 'Channel', width: 18 },
  { key: 'programme', header: 'Programme', width: 26 },
  { key: 'day', header: 'Day', width: 12 },
  { key: 'time', header: 'Time', width: 14 },
  { key: 'dur', header: 'Dur', width: 6 },
  { key: 'tvr', header: 'TVR', width: 8 },
  { key: 'spots', header: 'Spots', width: 7 },
  { key: 'rate', header: 'Rate (LKR)', width: 13 },
  { key: 'cost', header: 'Cost (LKR)', width: 14 },
];

/**
 * Build the workbook.
 *
 * @param {Object} args
 * @param {Object} args.brief     for the header block
 * @param {Array}  args.schedule  stored plan_schedule rows
 * @param {Object} args.totals    schedule_totals stored on the plan
 * @param {Object} args.plan      for the scheme/confidence line
 * @returns {Promise<Buffer>}
 */
export async function buildScheduleWorkbook({ brief = {}, schedule = [], totals = {}, plan = {} }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Media Planning & Analysis Assistant';
  wb.created = new Date();
  const ws = wb.addWorksheet('Schedule', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 6 }],
  });

  const dates = [...new Set(schedule.flatMap((l) => Object.keys(l.spot_dates || {})))].sort();
  const totalCols = FIXED_COLUMNS.length + dates.length;

  // --- header block --------------------------------------------------------
  const headerRows = [
    ['Client', brief.advertiser || '-'],
    ['Brand', brief.brand || '-'],
    ['Campaign', brief.objective || '-'],
    ['Period', formatPeriod(brief)],
    ['Prepared', new Date().toISOString().slice(0, 10)],
  ];
  headerRows.forEach((pair, i) => {
    const row = ws.getRow(i + 1);
    row.getCell(1).value = pair[0];
    row.getCell(1).font = { bold: true, color: { argb: INK } };
    row.getCell(2).value = pair[1];
    // Merge the value across a few columns so long objectives fit.
    ws.mergeCells(i + 1, 2, i + 1, Math.min(8, totalCols));
  });

  // --- column headers (row 6) ---------------------------------------------
  const headerRowIdx = headerRows.length + 1;
  const headerRow = ws.getRow(headerRowIdx);
  FIXED_COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    ws.getColumn(i + 1).width = col.width;
  });
  dates.forEach((d, i) => {
    const cell = headerRow.getCell(FIXED_COLUMNS.length + i + 1);
    // Two-line header: weekday over day-of-month, as the agency template does.
    cell.value = `${weekdayLetter(d)}\n${d.slice(8)}`;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getColumn(FIXED_COLUMNS.length + i + 1).width = 4.5;
  });
  styleHeaderRow(headerRow, totalCols);

  // --- data rows, grouped by channel --------------------------------------
  let r = headerRowIdx + 1;
  const byChannel = groupByChannel(schedule);

  for (const [channelName, lines] of byChannel) {
    for (const line of lines) {
      const row = ws.getRow(r);
      row.getCell(1).value = channelName;
      row.getCell(2).value = line.programme_name || '-';
      row.getCell(3).value = line.day_pattern || '-';
      row.getCell(4).value = timeLabel(line);
      row.getCell(5).value = line.duration_secs ? `${line.duration_secs}s` : '-';
      row.getCell(6).value = numOrDash(line.tvr);
      row.getCell(7).value = line.spots ?? 0;
      row.getCell(8).value = numOrDash(line.rate_lkr);
      row.getCell(9).value = numOrDash(line.cost_lkr);

      const grid = line.spot_dates || {};
      dates.forEach((d, i) => {
        const cell = row.getCell(FIXED_COLUMNS.length + i + 1);
        const n = grid[d];
        if (n) {
          cell.value = n;
          cell.alignment = { horizontal: 'center' };
        }
      });

      styleDataRow(row, totalCols, r % 2 === 0);
      r += 1;
    }

    // Channel subtotal.
    const sub = (totals.channels || []).find((c) => c.channel_name === channelName);
    const subRow = ws.getRow(r);
    subRow.getCell(1).value = `${channelName} — total`;
    subRow.getCell(7).value = sub?.spots ?? lines.reduce((a, l) => a + (l.spots || 0), 0);
    subRow.getCell(9).value = sub?.cost_lkr ?? null;
    styleSubtotalRow(subRow, totalCols);
    r += 1;
  }

  // --- grand total ---------------------------------------------------------
  const grand = ws.getRow(r);
  grand.getCell(1).value = 'CAMPAIGN TOTAL';
  grand.getCell(7).value = totals.total_spots ?? schedule.reduce((a, l) => a + (l.spots || 0), 0);
  grand.getCell(9).value = totals.total_cost_lkr ?? null;
  styleSubtotalRow(grand, totalCols, true);
  r += 2;

  // --- notes ---------------------------------------------------------------
  const noteRow = ws.getRow(r);
  noteRow.getCell(1).value = plan.budget_fit
    || 'Rates shown are observed spot costs from media watch where available.';
  ws.mergeCells(r, 1, r, Math.min(9, totalCols));
  noteRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' }, size: 9 };

  // Number formatting for the money and rating columns.
  ws.getColumn(6).numFmt = '0.00';
  ws.getColumn(8).numFmt = '#,##0';
  ws.getColumn(9).numFmt = '#,##0';

  return wb.xlsx.writeBuffer();
}

// --- helpers ---------------------------------------------------------------

function groupByChannel(schedule) {
  const map = new Map();
  for (const line of schedule) {
    const key = line.channel_name || '-';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(line);
  }
  return map;
}

function timeLabel(line) {
  if (line.time_start && line.time_end) return `${line.time_start}–${line.time_end}`;
  return line.time_band || '-';
}

function numOrDash(v) {
  return v === null || v === undefined ? null : Number(v);
}

function formatPeriod(brief) {
  if (brief.period_start && brief.period_end) return `${brief.period_start} to ${brief.period_end}`;
  if (brief.period_start) return `From ${brief.period_start}`;
  return 'Not stated';
}

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
function weekdayLetter(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAY_LETTERS[d.getUTCDay()];
}

function styleHeaderRow(row, totalCols) {
  for (let c = 1; c <= totalCols; c += 1) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
    cell.border = thin();
    if (!cell.alignment) cell.alignment = { vertical: 'middle' };
  }
  row.height = 26;
}

function styleDataRow(row, totalCols, banded) {
  for (let c = 1; c <= totalCols; c += 1) {
    const cell = row.getCell(c);
    cell.border = thin();
    cell.font = cell.font || { size: 9 };
    if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
  }
}

function styleSubtotalRow(row, totalCols, grand = false) {
  for (let c = 1; c <= totalCols; c += 1) {
    const cell = row.getCell(c);
    cell.border = thin();
    cell.font = { bold: true, color: { argb: grand ? 'FFFFFFFF' : INK }, size: 9 };
    cell.fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: grand ? ACCENT : 'FFEEF1F4' },
    };
  }
}

function thin() {
  const side = { style: 'thin', color: { argb: RULE } };
  return { top: side, bottom: side, left: side, right: side };
}
