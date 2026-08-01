import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, toDate } from '../util/coerce.js';

// ---------------------------------------------------------------------------
// Campaign brief (PDF) field extraction.
//
// Brief PDFs are messy multi-table layouts - label/value pairs sit side by side
// in table cells, sometimes stacked vertically, with inconsistent labels. There
// is no reliable structure to lean on, so this extracts positioned text, groups
// it into visual rows and then into table cells, and looks for label -> value
// pairs in the same cell, the next cell along, and the row below.
//
// Section 5 is explicit that the output is a *proposal*: nothing here is saved
// until the user confirms it in the UI. Every field therefore reports what it
// found and where, so a planner can see what to correct.
// ---------------------------------------------------------------------------

let pdfjs = null;
let standardFontDataUrl = null;
let cMapUrl = null;

async function getPdfjs() {
  if (!pdfjs) {
    // The legacy build is the one that runs under plain Node without a DOM.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // standard_fonts/ and cmaps/ sit at the package root, not under legacy/,
    // and under Node they must be filesystem paths: pdfjs reads them with fs,
    // whereas a file:// URL goes down the fetch path and fails. Getting this
    // wrong leaves the extractor guessing glyph widths, and the cell
    // segmentation below depends on those widths being right.
    const entry = fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
    const pkgRoot = path.resolve(path.dirname(entry), '..', '..');
    standardFontDataUrl = `${path.join(pkgRoot, 'standard_fonts')}${path.sep}`;
    cMapUrl = `${path.join(pkgRoot, 'cmaps')}${path.sep}`;
  }
  return pdfjs;
}

// Horizontal gap, in PDF user units, that separates one table cell from the
// next. Inter-word spacing sits near 2-3 units at typical brief font sizes;
// table cell padding is comfortably wider.
const CELL_GAP = 7;

/**
 * Extract text grouped into visual lines, each split into table cells.
 *
 * Cells matter as much as lines: in a two-column brief layout a single visual
 * row reads "Brand | Alpha Cola | Advertiser | Alpha Ltd", and without the cell
 * boundaries the value for "Brand" swallows the rest of the row.
 */
export async function extractPdfLines(buffer) {
  const { getDocument } = await getPdfjs();
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
    // Briefs from Sinhala/Tamil systems can use non-Latin encodings.
    cMapUrl,
    cMapPacked: true,
    // No network fetches for fonts/cmaps, and no worker thread in Node.
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  const lines = [];
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();

      // Bucket items by y, since a table row's cells share a baseline.
      const rows = new Map();
      for (const item of content.items) {
        const text = (item.str || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // Round y to absorb sub-pixel baseline drift within a row.
        const key = Math.round(item.transform[5] / 3);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push({
          text,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width || 0,
        });
      }

      const pageLines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0]) // top of page first
        .map(([, items]) => {
          items.sort((a, b) => a.x - b.x);
          const cells = groupIntoCells(items);
          return {
            page: p,
            y: items[0].y,
            cells,
            // Double space marks the cell boundary in the flattened text.
            text: cells.join('  '),
          };
        })
        .filter((line) => line.cells.length);

      lines.push(...pageLines);
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}

/** Merge adjacent text items into cells, splitting on wide horizontal gaps. */
function groupIntoCells(items) {
  const cells = [];
  let current = '';
  let cursor = null;

  for (const item of items) {
    if (cursor !== null && item.x - cursor > CELL_GAP) {
      if (current.trim()) cells.push(current.trim());
      current = item.text;
    } else {
      current = current ? `${current} ${item.text}` : item.text;
    }
    cursor = item.x + item.width;
  }
  if (current.trim()) cells.push(current.trim());
  return cells.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Label wordings seen on real briefs. First match wins, so order matters:
// more specific labels come before the ones they'd be a substring of.
const LABELS = {
  brand: ['brand name', 'brand', 'product brand', 'product line', 'product', 'sku'],
  advertiser: ['advertiser', 'client name', 'client', 'company', 'account', 'account name'],
  objective: [
    'campaign objective', 'communication objective', 'comms objective', 'comms task',
    'objective', 'objectives', 'campaign goal', 'purpose', 'brief objective', 'task',
    'what we need to do', 'background and objective',
  ],
  target_audience: [
    'target audience', 'target group', 'target consumer', 'audience', 'tg', 'target market',
    'demographic', 'demographics', 'who we are after', 'who we are talking to', 'consumer',
    'core target', 'primary target',
  ],
  budget_lkr_lakhs: [
    'budget', 'total budget', 'campaign budget', 'budget lkr', 'investment', 'media budget',
    'money available', 'budget available', 'spend', 'total spend', 'net budget', 'gross budget',
  ],
  language: ['language', 'languages', 'medium language'],
  territory: ['territory', 'territories', 'region', 'coverage', 'market', 'geography', 'footprint'],
  campaign_period: [
    'campaign period', 'period', 'duration', 'campaign duration', 'flight', 'flight dates',
    'timeline', 'campaign dates', 'on air', 'on air dates', 'burst', 'burst period',
    'activity period', 'when',
  ],
};

const MEDIUM_KEYS = {
  tv: ['tv', 'television'],
  radio: ['radio'],
  press: ['press', 'print', 'newspaper', 'newspapers'],
  digital: ['digital', 'online', 'social'],
  outdoor: ['outdoor', 'ooh', 'billboard'],
};

/**
 * Parse a brief PDF into proposed field values.
 *
 * @returns {{fields: Object, confidence: Object, lines: string[], warnings: string[]}}
 */
export async function parseBriefPdf(buffer, { sourceFile = null } = {}) {
  const lines = await extractPdfLines(buffer);
  const texts = lines.map((l) => l.text);
  const warnings = [];
  const cellLines = lines.map((l) => l.cells);

  const fields = {
    brand: null,
    advertiser: null,
    objective: null,
    target_audience: null,
    budget_lkr_lakhs: null,
    language: null,
    territory: null,
    period_start: null,
    period_end: null,
    medium_split: null,
    source_file: sourceFile,
  };
  const found = {};

  for (const [field, labels] of Object.entries(LABELS)) {
    const hit = findLabelledValue(cellLines, labels);
    if (!hit) continue;
    found[field] = { label: hit.label, line: hit.lineIndex, rawValue: hit.value };

    if (field === 'campaign_period') {
      const period = parsePeriod(hit.value);
      fields.period_start = period.start;
      fields.period_end = period.end;
      if (!period.start) {
        warnings.push(`Could not read dates from campaign period: "${hit.value}"`);
      } else if (period.yearInferred) {
        warnings.push(
          `Campaign period "${hit.value}" gave no year; ${period.yearInferred} was assumed. `
          + 'Confirm this.',
        );
      }
    } else if (field === 'budget_lkr_lakhs') {
      const budget = parseBudget(hit.value);
      fields.budget_lkr_lakhs = budget.value;
      if (budget.unitNote) warnings.push(budget.unitNote);
    } else {
      fields[field] = hit.value || null;
    }
  }

  fields.medium_split = parseMediumSplit(texts);
  if (!fields.medium_split) {
    warnings.push('No medium split found in the brief - confirm the TV/radio/press split manually.');
  }

  // A period sometimes appears as a bare date range with no label at all.
  if (!fields.period_start) {
    for (const t of texts) {
      const period = parsePeriod(t);
      if (period.start && period.end) {
        fields.period_start = period.start;
        fields.period_end = period.end;
        found.campaign_period = { label: '(unlabelled date range)', rawValue: t };
        break;
      }
    }
  }

  // Diagnose a wholesale failure rather than listing every field separately.
  // "Could not find brand / objective / audience / budget" four times over says
  // nothing about why, and the two causes need completely different responses.
  const wordCount = texts.join(' ').split(/\s+/).filter(Boolean).length;
  const diagnosis = diagnose(texts, wordCount, Object.keys(found).length);
  if (diagnosis) {
    warnings.unshift(diagnosis);
  } else {
    for (const key of ['brand', 'objective', 'target_audience', 'budget_lkr_lakhs']) {
      if (fields[key] === null) {
        warnings.push(`Could not find "${key}" in the brief - please fill it in before saving.`);
      }
    }
  }

  return {
    fields,
    confidence: found,
    lines: texts,
    warnings,
    // Enough for someone to tell "the PDF is an image" from "my labels differ"
    // without having to open the file alongside.
    extraction: {
      pages: lines.length ? Math.max(...lines.map((l) => l.page)) : 0,
      text_lines: texts.length,
      word_count: wordCount,
      fields_matched: Object.keys(found).length,
      has_text_layer: wordCount > 0,
    },
  };
}

/**
 * Why did this brief yield nothing?
 *
 * A scanned brief and an unfamiliar layout both produce an empty form, but one
 * needs OCR and the other needs a label added to LABELS. Telling them apart is
 * the difference between a two-minute fix and an afternoon.
 */
function diagnose(texts, wordCount, matchedCount) {
  if (!texts.length || wordCount === 0) {
    return 'This PDF contains no extractable text - it is almost certainly a scan or an '
      + 'exported image. Nothing can be read from it automatically; either supply a '
      + 'text-based PDF (print/export to PDF rather than scanning) or fill the form in by hand.';
  }
  if (wordCount < 25) {
    return `Only ${wordCount} words could be extracted from this PDF, which is far less than a `
      + 'brief should contain. It may be mostly images, or text stored as outlines. Fill the '
      + 'form in by hand, or supply a text-based PDF.';
  }
  if (matchedCount === 0) {
    return `Text was read from this PDF (${wordCount} words) but none of the expected labels `
      + '- Brand, Objective, Target Audience, Budget, Campaign Period - were found. The brief '
      + 'likely uses different wording. Fill the form in by hand; the extracted text is '
      + 'returned in "extracted_lines" if you want to check what it actually says.';
  }
  return null;
}

/**
 * Find the value for one of `labels`, searching cell by cell.
 *
 * Three layouts have to work, and all three appear in real briefs:
 *   "Brand: Alpha Cola"            value in the same cell, after the colon
 *   | Brand | Alpha Cola |         value in the next cell along
 *   | Brand |                      value in the first cell of the row below
 *   | Alpha Cola |
 *
 * The cell boundary is what stops the value running on into the next
 * label/value pair on a two-column row.
 */
function findLabelledValue(cellLines, labels) {
  for (const label of labels) {
    const re = new RegExp(`^${escape(label)}\\s*[:\\-–]?\\s*(.*)$`, 'i');

    for (let i = 0; i < cellLines.length; i += 1) {
      const cells = cellLines[i];
      for (let c = 0; c < cells.length; c += 1) {
        const m = cells[c].match(re);
        if (!m) continue;

        // Same cell, after the label: "Brand: Alpha Cola".
        const inline = cleanValue(m[1]);
        if (inline && !isLabelText(inline)) {
          return { label, value: inline, lineIndex: i };
        }

        // Next cell along the same row.
        const next = cleanValue(cells[c + 1] || '');
        if (next && !isLabelText(next)) {
          return { label, value: next, lineIndex: i };
        }

        // Label alone on its row: the value sits directly beneath it.
        const below = cleanValue((cellLines[i + 1] || [])[0] || '');
        if (below && !isLabelText(below)) {
          return { label, value: below, lineIndex: i + 1 };
        }
      }
    }
  }
  return null;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanValue(s) {
  const out = String(s || '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:\-–|]+|[\s:|]+$/g, '')
    .trim();
  return out.length ? out : null;
}

/**
 * True when a cell is itself a field label rather than a value.
 *
 * Guards the stacked layout: with "Campaign Objective" on one row and "Target
 * Audience" two rows down, the objective's value must not be read as the next
 * label.
 */
function isLabelText(s) {
  const lower = s.toLowerCase().replace(/[:\-–]\s*$/, '').trim();
  return Object.values(LABELS).flat().some((l) => lower === l);
}

const DATE_TOKEN =
  '\\d{1,2}(?:st|nd|rd|th)?[\\s./-]*[A-Za-z]{3,9}[\\s./-]*\\d{2,4}' +
  '|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}' +
  '|\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4}' +
  '|[A-Za-z]{3,9}[\\s-]+\\d{4}';

// Briefs routinely omit the year - "15 September to 31 October" is unambiguous
// to a planner reading it in August and useless to a parser. Matched
// separately so the inferred year can be flagged rather than passed off as read.
const DATE_NO_YEAR =
  '\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}|[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?';

const SEPARATOR = '(?:to|until|till|through|-|–|—)';

export function parsePeriod(value, { today = new Date() } = {}) {
  if (!value) return { start: null, end: null };
  const text = String(value);

  const ranged = text.match(
    new RegExp(`(${DATE_TOKEN})\\s*${SEPARATOR}\\s*(${DATE_TOKEN})`, 'i'),
  );
  if (ranged) {
    return {
      start: toDate(stripOrdinals(ranged[1]), { snapToMonthStart: false }),
      end: toDate(stripOrdinals(ranged[2]), { snapToMonthStart: false }),
    };
  }

  // Year-less range: infer one, and say so.
  const bare = text.match(new RegExp(`(${DATE_NO_YEAR})\\s*${SEPARATOR}\\s*(${DATE_NO_YEAR})`, 'i'));
  if (bare) {
    const year = inferYear(bare[1], today);
    if (year) {
      const start = toDate(`${stripOrdinals(bare[1])} ${year}`);
      // A range that runs backwards has crossed a year boundary
      // ("15 December to 20 January").
      let end = toDate(`${stripOrdinals(bare[2])} ${year}`);
      if (start && end && end < start) end = toDate(`${stripOrdinals(bare[2])} ${year + 1}`);
      if (start) return { start, end, yearInferred: year };
    }
  }

  const single = text.match(new RegExp(`(${DATE_TOKEN})`, 'i'));
  if (single) {
    const d = toDate(stripOrdinals(single[1]));
    return { start: d, end: null };
  }
  return { start: null, end: null };
}

/**
 * Pick the year for a date written without one.
 *
 * Briefs are forward-looking, so a month already well past is next year's
 * campaign rather than a retrospective. Two months of slack covers a brief
 * written just after the flight started.
 */
function inferYear(dateText, today) {
  const year = today.getUTCFullYear();
  const candidate = toDate(`${stripOrdinals(dateText)} ${year}`);
  if (!candidate) return null;

  const monthsBehind =
    (today.getUTCFullYear() - Number(candidate.slice(0, 4))) * 12
    + (today.getUTCMonth() + 1 - Number(candidate.slice(5, 7)));
  return monthsBehind > 2 ? year + 1 : year;
}

function stripOrdinals(s) {
  return s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
}

/**
 * Budget, normalised to LKR lakhs (the schema's unit).
 *
 * Briefs quote budgets as "Rs. 25 Lakhs", "LKR 2,500,000", "25 Mn". Getting
 * this wrong by 10^5 would silently wreck every budget-fit judgement the model
 * makes, so an ambiguous bare number is reported rather than assumed.
 */
export function parseBudget(value) {
  if (!value) return { value: null, unitNote: null };
  const s = String(value).toLowerCase();
  const n = num(s);
  if (n === null) return { value: null, unitNote: null };

  if (/\b(lakh|lakhs|lac|lacs)\b/.test(s)) return { value: n, unitNote: null };
  if (/\b(crore|crores|cr)\b/.test(s)) return { value: n * 100, unitNote: null };
  if (/\b(mn|million|m)\b/.test(s)) return { value: n * 10, unitNote: null };
  if (/\b(bn|billion)\b/.test(s)) return { value: n * 10_000, unitNote: null };

  // A bare figure in the millions is almost certainly rupees, not lakhs.
  if (n >= 100_000) {
    return {
      value: n / 100_000,
      unitNote: `Budget "${value}" had no unit; read as LKR ${n.toLocaleString()} = ${(n / 100_000).toFixed(2)} lakhs. Confirm this.`,
    };
  }
  return {
    value: n,
    unitNote: `Budget "${value}" had no unit; assumed lakhs. Confirm this.`,
  };
}

/**
 * Medium split, as percentages keyed by medium.
 *
 * Accepts "TV 60% Radio 25% Press 15%" on one line and the same thing spread
 * down a small table. Percentages are kept as given - if they don't total 100
 * that's flagged rather than silently rescaled, because it usually means the
 * parse missed a row.
 */
export function parseMediumSplit(texts) {
  const split = {};
  for (const line of texts) {
    for (const [key, aliases] of Object.entries(MEDIUM_KEYS)) {
      if (key in split) continue;
      for (const alias of aliases) {
        const m = line.match(new RegExp(`\\b${escape(alias)}\\b[^0-9%]{0,20}(\\d{1,3}(?:\\.\\d+)?)\\s*%`, 'i'));
        if (m) {
          split[key] = Number.parseFloat(m[1]);
          break;
        }
      }
    }
  }
  if (!Object.keys(split).length) return null;

  const total = Object.values(split).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 100) > 1) split._note = `Percentages total ${total}, not 100 - verify.`;
  return split;
}
