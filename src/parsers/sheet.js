import ExcelJS from 'exceljs';
import { cellValue, str } from '../util/coerce.js';

// ---------------------------------------------------------------------------
// Generic spreadsheet introspection.
//
// The adex and TVR workbooks are hand-maintained: title banners above the
// table, merged group headers ("TV" spanning Spend/Freq/Duration) with the real
// labels on the row below, blank spacer rows, and columns that move between
// months. So nothing here assumes a fixed column order. Each parser declares
// the fields it wants plus the header wordings it has seen, and this module
// finds the header row and maps field -> column index.
// ---------------------------------------------------------------------------

/** Load a workbook from an in-memory buffer. Never touches disk. */
export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/**
 * Flatten a worksheet into a dense 2D array of scalars.
 *
 * Merged cells are the reason this exists: ExcelJS stores the value only on the
 * top-left master cell and leaves the rest of the range null, so a merged
 * header like "TV" spanning three columns would look like one label and two
 * blanks. Reading through `cell.master` spreads the value across the whole
 * range, which is what header detection needs.
 */
export function sheetToGrid(worksheet, { maxRows = 200_000 } = {}) {
  const rowCount = Math.min(worksheet.rowCount || 0, maxRows);
  const colCount = worksheet.columnCount || 0;
  const grid = [];
  for (let r = 1; r <= rowCount; r += 1) {
    const row = worksheet.getRow(r);
    const out = new Array(colCount).fill(null);
    for (let c = 1; c <= colCount; c += 1) {
      const cell = row.getCell(c);
      // `master` is the cell itself when not merged, so this is safe for all cells.
      const source = cell.isMerged && cell.master ? cell.master : cell;
      out[c - 1] = cellValue(source.value);
    }
    grid.push(out);
  }
  return grid;
}

/** Lowercase alphanumeric form used for all header comparisons. */
export function normaliseLabel(value) {
  const s = str(value);
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

function labelMatches(label, synonym) {
  if (!label) return 0;
  const target = normaliseLabel(synonym);
  if (!target) return 0;
  if (label === target) return 3; // exact
  // Whole-word containment: "tv spend 000" contains "tv spend".
  const re = new RegExp(`(^| )${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  if (re.test(label)) return 2;
  // Loose substring, but only for targets long enough to be meaningful. A
  // short one matches almost anything - "q" for quarter hits "tv frq", which
  // silently files a frequency count as the quarter label.
  if (target.length >= 4 && label.includes(target)) return 1;
  return 0;
}

/**
 * Build the effective header label for each column from one or more header
 * rows. Two-tier headers combine as "parent child" ("tv spend 000"), and a
 * repeated parent (the merged-cell spill) is not duplicated into the child.
 */
function combineHeaderRows(grid, rowIdxs, colCount) {
  const labels = new Array(colCount).fill('');
  for (let c = 0; c < colCount; c += 1) {
    const parts = [];
    for (const r of rowIdxs) {
      const piece = normaliseLabel(grid[r]?.[c]);
      if (piece && !parts.includes(piece)) parts.push(piece);
    }
    labels[c] = parts.join(' ').trim();
  }
  return labels;
}

/**
 * Locate the header row(s) and map declared fields to column indexes.
 *
 * @param {Array<Array<any>>} grid       from sheetToGrid()
 * @param {Object} fields                field name -> array of header synonyms
 * @param {Object} [opts]
 * @param {string[]} [opts.required]     fields that must be found for a row to qualify
 * @param {number} [opts.scanRows]       how far down to look for the header
 * @returns {{headerRow:number, lastHeaderRow:number, columns:Object, labels:string[], score:number}|null}
 */
export function detectHeader(grid, fields, opts = {}) {
  const { required = [], scanRows = 40 } = opts;
  const colCount = grid.reduce((m, row) => Math.max(m, row.length), 0);
  if (!colCount) return null;

  const limit = Math.min(grid.length, scanRows);
  let best = null;

  for (let r = 0; r < limit; r += 1) {
    // Try a single-row header, then a two-row header (merged group + sub-label),
    // then three rows for the worst of the banner layouts.
    for (const span of [1, 2, 3]) {
      if (r + span > grid.length) continue;
      const rowIdxs = Array.from({ length: span }, (_, i) => r + i);
      const labels = combineHeaderRows(grid, rowIdxs, colCount);
      if (labels.every((l) => !l)) continue;

      const candidate = mapFields(labels, fields);
      const found = Object.keys(candidate.columns);
      if (!found.length) continue;
      if (required.length && !required.every((f) => f in candidate.columns)) continue;

      // Prefer more fields matched and stronger matches; break ties toward the
      // shallower header (fewer rows consumed, higher on the sheet).
      const score = candidate.score + found.length * 2 - span * 0.5 - r * 0.01;
      if (!best || score > best.score) {
        best = {
          headerRow: r,
          lastHeaderRow: r + span - 1,
          columns: candidate.columns,
          labels,
          score,
        };
      }
    }
  }
  return best;
}

/** Greedy best-match assignment of fields to columns; a column is used once. */
function mapFields(labels, fields) {
  const scored = [];
  for (const [field, synonyms] of Object.entries(fields)) {
    for (let c = 0; c < labels.length; c += 1) {
      let bestForCell = 0;
      for (const syn of synonyms) {
        const s = labelMatches(labels[c], syn);
        if (s > bestForCell) bestForCell = s;
      }
      if (bestForCell > 0) scored.push({ field, col: c, strength: bestForCell });
    }
  }
  // Strongest matches win first, so an exact "brand" beats a loose "mother brand".
  scored.sort((a, b) => b.strength - a.strength || a.col - b.col);

  const columns = {};
  const takenCols = new Set();
  let score = 0;
  for (const { field, col, strength } of scored) {
    if (field in columns || takenCols.has(col)) continue;
    columns[field] = col;
    takenCols.add(col);
    score += strength;
  }
  return { columns, score };
}

/**
 * Pull a metric sub-header row into the detected header.
 *
 * detectHeader() prefers the shallowest header that maps the declared fields,
 * which is right for identity columns but loses the row beneath in the wide
 * TVR layout:
 *
 *     Channel | Programme | Time Band | Duration | Females 15-40 | Males 15-40
 *             |           |           |          | GRP    | TVR  | GRP  | TVR
 *
 * The identity fields all resolve on the first row, so the second never gets
 * read and the rating columns end up labelled with the audience alone. This
 * merges that row into the unclaimed columns, giving "females 15 40 grp".
 *
 * @param {RegExp} test  matched against the sub-row labels to confirm it is one
 * @returns {boolean} whether a sub-header was absorbed
 */
export function absorbSubHeader(grid, header, test) {
  const next = header.lastHeaderRow + 1;
  if (next >= grid.length) return false;

  const claimed = new Set(Object.values(header.columns));
  const subLabels = [];
  let matches = 0;

  for (let c = 0; c < header.labels.length; c += 1) {
    if (claimed.has(c)) {
      subLabels[c] = '';
      continue;
    }
    const label = normaliseLabel(grid[next]?.[c]);
    subLabels[c] = label;
    if (label && test.test(label)) matches += 1;
  }

  if (matches < 2) return false; // one stray word isn't a header row

  for (let c = 0; c < header.labels.length; c += 1) {
    if (!subLabels[c]) continue;
    header.labels[c] = `${header.labels[c]} ${subLabels[c]}`.trim();
  }
  header.lastHeaderRow = next;
  return true;
}

/**
 * Iterate data rows below the header, yielding a field-keyed object per row.
 * Stops after a run of blank rows so trailing notes and totals blocks don't get
 * read as data.
 */
export function* dataRows(grid, header, { blankRunToStop = 25 } = {}) {
  const entries = Object.entries(header.columns);
  let blankRun = 0;

  for (let r = header.lastHeaderRow + 1; r < grid.length; r += 1) {
    const row = grid[r];
    const record = {};
    let populated = 0;
    for (const [field, col] of entries) {
      const v = cellValue(row?.[col]);
      record[field] = v;
      if (v !== null && v !== undefined && String(v).trim() !== '') populated += 1;
    }

    if (populated === 0) {
      blankRun += 1;
      if (blankRun >= blankRunToStop) return;
      continue;
    }
    blankRun = 0;
    yield { rowNumber: r + 1, record, rawRow: row };
  }
}

/** True for summary rows ("Total", "Grand Total", "Sub Total") that must not be ingested. */
export function isTotalsRow(record) {
  for (const value of Object.values(record)) {
    const s = str(value);
    if (!s) continue;
    if (/^(grand\s+)?(sub[\s-]?)?total\b/i.test(s)) return true;
  }
  return false;
}
