import { readWorkbook, sheetToGrid, detectHeader, dataRows, isTotalsRow } from './sheet.js';
import { str, num, int } from '../util/coerce.js';
import { canonicalName } from '../util/normalise.js';
import { pushAll } from '../util/arrays.js';

// ---------------------------------------------------------------------------
// Media watch spot log parser.
//
// One row per aired advertisement, with what it cost. This is the only source
// of rate information in the system, so it is what turns a programme shortlist
// into a costed plan: channel + programme + duration -> observed rate.
//
// Accepts .xlsx and delimited text (.csv/.tsv), because this feed is routinely
// pasted or exported as text rather than as a workbook.
// ---------------------------------------------------------------------------

const FIELDS = {
  product_group: ['product group', 'product_group', 'productgroup'],
  advertiser: ['advertiser'],
  product: ['product'],
  advt_theme: ['advt theme', 'advt_theme', 'theme', 'advertisement theme'],
  ads: ['ads'],
  channel_name: ['channel'],
  programme_name: ['program', 'programme', 'program name'],
  dd: ['dd', 'day of month'],
  mn: ['mn', 'month'],
  yr: ['yr', 'year'],
  day_of_week: ['day'],
  prog_time: ['prog time', 'prog_time', 'programme time'],
  advt_time: ['advt time', 'advt_time', 'advertisement time'],
  ad_pos: ['adpos', 'ad pos', 'ad position'],
  tot_ads: ['totads', 'tot ads', 'total ads'],
  brk_no: ['brkno', 'brk no', 'break no'],
  pos_in_brk: ['posinbrk', 'pos in brk', 'position in break'],
  ads_in_brk: ['adsinbrk', 'ads in brk', 'ads in break'],
  language: ['lng', 'language', 'lang'],
  duration: ['dur', 'duration', 'dur secs'],
  cost: ['cost', 'rate', 'value'],
};

const REQUIRED = ['channel_name', 'cost'];

// Channel labels carry their medium as a prefix: "Radio - Neth FM", "TV - Hiru".
const MEDIUM_PREFIX = /^\s*(tv|television|radio|press|print|newspaper)\s*[-–:]\s*/i;

const LANGUAGES = {
  sin: 'Sinhala', sinhala: 'Sinhala',
  tam: 'Tamil', tamil: 'Tamil',
  eng: 'English', english: 'English',
};

export async function parseMediaWatch(buffer, { sourceFile = null } = {}) {
  const isText = looksLikeText(buffer, sourceFile);
  const grid = isText ? textToGrid(buffer) : null;

  if (isText) {
    const header = detectHeader(grid, FIELDS, { required: REQUIRED });
    if (!header) {
      return {
        spots: [],
        sheets: [{ sheet: sourceFile || 'text', rows: 0, reason: 'no media watch header found' }],
        warnings: ['Could not find a media watch header row (needs at least Channel and Cost).'],
      };
    }
    const spots = build(grid, header, sourceFile, sourceFile || 'text');
    return {
      spots,
      sheets: [{ sheet: sourceFile || 'text', rows: spots.length, headerRow: header.headerRow + 1 }],
      warnings: [],
    };
  }

  const wb = await readWorkbook(buffer);
  const spots = [];
  const sheets = [];
  const warnings = [];

  wb.eachSheet((worksheet) => {
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return;
    const sheetGrid = sheetToGrid(worksheet);
    if (!sheetGrid.length) return;

    const header = detectHeader(sheetGrid, FIELDS, { required: REQUIRED });
    if (!header) {
      sheets.push({ sheet: worksheet.name, rows: 0, reason: 'no media watch header found' });
      return;
    }
    const rows = build(sheetGrid, header, sourceFile, worksheet.name);
    pushAll(spots, rows);
    sheets.push({ sheet: worksheet.name, rows: rows.length, headerRow: header.headerRow + 1 });
  });

  if (!spots.length) warnings.push('No media watch spot rows were recognised.');
  return { spots: dedupe(spots), sheets, warnings };
}

function build(grid, header, sourceFile, sheetName) {
  const rows = [];
  for (const { record } of dataRows(grid, header)) {
    if (isTotalsRow(record)) continue;
    const built = buildSpot(record, sourceFile, sheetName);
    if (built) rows.push(built);
  }
  return dedupe(rows);
}

function buildSpot(record, sourceFile, sheetName) {
  const rawChannel = str(record.channel_name);
  if (!rawChannel) return null;

  const airedOn = buildDate(record);
  if (!airedOn) return null;

  const mediumMatch = rawChannel.match(MEDIUM_PREFIX);
  const medium = mediumMatch ? normaliseMedium(mediumMatch[1]) : 'TV';
  // Strip the medium prefix so the channel joins against MICOS channel names.
  const channel = canonicalName(rawChannel.replace(MEDIUM_PREFIX, '')) || rawChannel;

  const lang = (str(record.language) || '').toLowerCase();

  return {
    medium,
    channel_name: channel,
    programme_name: canonicalName(str(record.programme_name)) || '',
    aired_on: airedOn,
    day_of_week: str(record.day_of_week),
    prog_time: str(record.prog_time),
    // Part of the natural key: two spots for one product in one programme on
    // one day are distinguished by the time they aired.
    advt_time: str(record.advt_time) || '',
    product_group: str(record.product_group),
    advertiser: str(record.advertiser),
    product: str(record.product),
    advt_theme: str(record.advt_theme),
    ad_pos: int(record.ad_pos),
    tot_ads: int(record.tot_ads),
    brk_no: int(record.brk_no),
    pos_in_brk: int(record.pos_in_brk),
    ads_in_brk: int(record.ads_in_brk),
    language: LANGUAGES[lang] || str(record.language),
    duration_secs: int(record.duration),
    cost: num(record.cost),
    source_file: sourceFile ? `${sourceFile}#${sheetName}` : sheetName,
  };
}

/** The date arrives split across Dd / Mn / Yr columns. */
function buildDate(record) {
  const d = int(record.dd);
  const m = int(record.mn);
  const y = int(record.yr);
  if (!d || !m || !y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = y < 100 ? 2000 + y : y;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normaliseMedium(token) {
  const t = token.toLowerCase();
  if (t.startsWith('radio')) return 'Radio';
  if (t.startsWith('press') || t.startsWith('print') || t.startsWith('news')) return 'Press';
  return 'TV';
}

/** Sniff whether the upload is delimited text rather than a workbook. */
function looksLikeText(buffer, sourceFile) {
  if (sourceFile && /\.(csv|tsv|txt)$/i.test(sourceFile)) return true;
  if (sourceFile && /\.(xlsx|xlsm|xls)$/i.test(sourceFile)) return false;
  // xlsx is a zip: "PK".
  return !(buffer[0] === 0x50 && buffer[1] === 0x4b);
}

/** Parse delimited text into the same grid shape sheetToGrid produces. */
function textToGrid(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];

  // Tab-delimited is the usual export; fall back to comma.
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  return lines.map((line) => splitLine(line, delimiter));
}

/** Split one delimited line, honouring double-quoted fields. */
function splitLine(line, delimiter) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; }
        else inQuotes = false;
      } else current += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(current.trim()); current = ''; }
    else current += ch;
  }
  out.push(current.trim());
  return out;
}

function dedupe(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = [
      row.channel_name, row.programme_name, row.aired_on, row.advt_time,
      row.product || '', row.duration_secs ?? '',
    ].join('|').toLowerCase();
    seen.set(key, row);
  }
  return [...seen.values()];
}

export const MEDIA_WATCH_FIELDS = FIELDS;
