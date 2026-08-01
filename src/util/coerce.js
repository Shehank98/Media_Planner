// Coercion helpers for spreadsheet values.
//
// Adex and TVR workbooks are hand-maintained, so a "number" column contains
// numbers, numbers-as-text, numbers with thousands separators, parenthesised
// negatives, "-" placeholders, and the occasional stray note. Everything that
// reads a cell goes through here so the tolerances are defined in one place.

const BLANK_TOKENS = new Set(['', '-', '--', 'n/a', 'na', 'nil', 'null', '#n/a', '#value!', '#ref!']);

/** ExcelJS returns rich objects for formulas, hyperlinks and rich text. Flatten to a scalar. */
export function cellValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'object') {
    // Formula cells: prefer the cached result over the formula text.
    if ('result' in raw) return cellValue(raw.result);
    if ('richText' in raw && Array.isArray(raw.richText)) {
      return raw.richText.map((t) => t.text).join('');
    }
    if ('text' in raw) return cellValue(raw.text);
    if ('hyperlink' in raw) return cellValue(raw.hyperlink);
    if ('error' in raw) return null;
    return null;
  }
  return raw;
}

/** Trimmed, whitespace-collapsed string, or null when the cell is meaningfully empty. */
export function str(raw) {
  const v = cellValue(raw);
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || BLANK_TOKENS.has(s.toLowerCase())) return null;
  return s;
}

/**
 * Numeric cell. Handles "1,234.5", "(890)" as -890, "Rs. 1200", "45%", and
 * returns null rather than NaN for anything genuinely non-numeric.
 */
export function num(raw) {
  const v = cellValue(raw);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;

  let s = String(v).trim();
  if (!s || BLANK_TOKENS.has(s.toLowerCase())) return null;

  const negatedByParens = /^\(.*\)$/.test(s);
  if (negatedByParens) s = s.slice(1, -1);

  const isPercent = s.endsWith('%');
  // Pull out the first numeric token rather than stripping non-numeric
  // characters: stripping leaves the dot in "Rs. 1,200" behind, which
  // parseFloat then reads as a decimal point and turns 1200 into 0.12.
  const match = s.replace(/%/g, '').match(/[-+]?\d[\d,]*(?:\.\d+)?|[-+]?\.\d+/);
  if (!match) return null;

  const n = Number.parseFloat(match[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const signed = negatedByParens ? -Math.abs(n) : n;
  return isPercent ? signed / 100 : signed;
}

/** Integer cell - rounds rather than truncating, since these are counts. */
export function int(raw) {
  const n = num(raw);
  return n === null ? null : Math.round(n);
}

export const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Month number from a month name, or null. */
export function monthNumber(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)] ?? null;
}

/**
 * Parse a date cell into a YYYY-MM-DD string.
 *
 * Adex "month" columns show up as real dates, as Excel serial numbers, and as
 * text like "Jan-24", "2024-01", "01/2024". Anything month-granular normalises
 * to the first of that month, which is what the (month, advertiser, brand,
 * product2) key assumes - otherwise the same month written two ways would
 * produce two rows.
 */
export function toDate(raw, { snapToMonthStart = false, monthFirst = false } = {}) {
  const v = cellValue(raw);
  if (v === null || v === undefined) return null;

  if (v instanceof Date) {
    const iso = fmt(v.getUTCFullYear(), v.getUTCMonth() + 1, snapToMonthStart ? 1 : v.getUTCDate());
    return iso;
  }

  if (typeof v === 'number') {
    // A bare year is ambiguous with an Excel serial (2024 is also 1905-07-18)
    // and carries no month, so refuse it rather than invent one. The row gets
    // skipped with a warning, which is recoverable; a silently wrong month is
    // not.
    if (Number.isInteger(v) && v >= 1900 && v <= 2100) return null;
    // Excel serial date: days since 1899-12-30 in the 1900 system.
    if (v > 0 && v < 200_000) {
      const ms = Math.round((v - 25569) * 86_400_000);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, snapToMonthStart ? 1 : d.getUTCDate());
      }
    }
    return null;
  }

  const s = String(v).trim();
  if (!s || BLANK_TOKENS.has(s.toLowerCase())) return null;

  // 2024-01-15 / 2024-01 / 2024/01/15
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/);
  if (m) return fmt(+m[1], +m[2], snapToMonthStart ? 1 : (m[3] ? +m[3] : 1));

  // 15-01-2024 / 15/01/2024.
  //
  // Genuinely ambiguous: day-first is the Sri Lankan convention, but the adex
  // exports are month-first ("2/1/2021" is February). Callers that can prove
  // which it is - the adex parser cross-checks against the Month2 name column -
  // pass monthFirst; otherwise day-first stands as the local default.
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const first = +m[1];
    const second = +m[2];
    // A value over 12 can only be the day, whatever the convention.
    const useMonthFirst = second > 12 ? true : first > 12 ? false : monthFirst;
    const month = useMonthFirst ? first : second;
    const day = useMonthFirst ? second : first;
    return fmt(+m[3], month, snapToMonthStart ? 1 : day);
  }

  // Jan-24 / Jan 2024 / January-2024
  m = s.match(/^([A-Za-z]{3,9})[-\s/]*(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) return fmt(expandYear(+m[2]), month, 1);
  }

  // 24-Jan / 2024-Jan
  m = s.match(/^(\d{2,4})[-\s/]*([A-Za-z]{3,9})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return fmt(expandYear(+m[1]), month, 1);
  }

  // 15 Jan 2024 / 15-January-2024
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) return fmt(expandYear(+m[3]), month, snapToMonthStart ? 1 : +m[1]);
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return fmt(
      parsed.getUTCFullYear(),
      parsed.getUTCMonth() + 1,
      snapToMonthStart ? 1 : parsed.getUTCDate(),
    );
  }
  return null;
}

function expandYear(y) {
  if (y >= 1000) return y;
  // Two-digit years: adex history doesn't reach back to the 1900s.
  return y >= 70 ? 1900 + y : 2000 + y;
}

function fmt(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const day = Number.isFinite(d) && d >= 1 && d <= 31 ? d : 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Calendar quarter label for a YYYY-MM-DD string, e.g. "2024-Q1". */
export function quarterOf(isoDate) {
  if (!isoDate) return null;
  const [y, m] = isoDate.split('-').map(Number);
  if (!y || !m) return null;
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}
