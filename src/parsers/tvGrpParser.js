import {
  readWorkbook, sheetToGrid, detectHeader, dataRows, isTotalsRow, normaliseLabel, absorbSubHeader,
} from './sheet.js';
import { str, num, int, toDate } from '../util/coerce.js';
import { canonicalName } from '../util/normalise.js';
import { rowAsLabelledObject } from './tvChannelParser.js';

// ---------------------------------------------------------------------------
// TV_GrpDetails workbook parser (programme ratings).
//
// These arrive in two shapes and the parser handles both:
//
//   long  - one row per programme x audience, with a "Target Audience" column
//   wide  - one row per programme, with a merged audience banner across several
//           rating columns ("Females 15-40" over TVR | GRP). This is the common
//           layout and needs unpivoting into one row per audience.
//
// Long format is attempted first; if there's no audience column the sheet is
// treated as wide and the audience is read from the column headers.
// ---------------------------------------------------------------------------

const IDENTITY_FIELDS = {
  channel_name: ['channel', 'channel name', 'tv channel', 'station'],
  programme_name: ['programme', 'program', 'programme name', 'program name', 'show', 'title'],
  day_part: ['day part', 'daypart', 'time band', 'time belt', 'band', 'slot', 'time slot', 'time'],
  avg_duration_secs: ['avg duration', 'average duration', 'duration', 'dur secs', 'avg dur', 'duration secs'],
  period_start: ['period start', 'from', 'start date', 'week start', 'from date'],
  period_end: ['period end', 'to', 'end date', 'week end', 'to date'],
  period: ['period', 'month', 'week', 'date'],
};

const LONG_FIELDS = {
  ...IDENTITY_FIELDS,
  target_audience: ['target audience', 'audience', 'target', 'ta', 'demo', 'demographic'],
  grp: ['grp', 'grps', 'gross rating point', 'gross rating points'],
  trp: ['trp', 'trps', 'tvr', 'tvrs', 'rating', 'target rating point'],
};

const GRP_LABEL = /(^| )(grp|grps)( |$)/;
const TRP_LABEL = /(^| )(trp|trps|tvr|tvrs|rating)( |$)/;
// Either metric - used to recognise the sub-header row under an audience banner.
const METRIC_LABEL = /(^| )(grp|grps|trp|trps|tvr|tvrs|rating)( |$)/;

export async function parseGrpWorkbook(buffer, { sourceFile = null } = {}) {
  const wb = await readWorkbook(buffer);
  const ratings = [];
  const sheets = [];
  const warnings = [];

  wb.eachSheet((worksheet) => {
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return;
    const grid = sheetToGrid(worksheet);
    if (!grid.length) return;

    const sheetPeriod = findPeriodInBanner(grid);
    const long = detectHeader(grid, LONG_FIELDS, {
      required: ['programme_name', 'target_audience'],
    });

    let result;
    if (long && ('grp' in long.columns || 'trp' in long.columns)) {
      result = parseLong(grid, long, worksheet.name, sheetPeriod, sourceFile);
    } else {
      const wide = detectHeader(grid, IDENTITY_FIELDS, { required: ['programme_name'] });
      if (!wide) {
        sheets.push({ sheet: worksheet.name, parsed: 0, reason: 'no programme header found' });
        return;
      }
      result = parseWide(grid, wide, worksheet.name, sheetPeriod, sourceFile);
    }

    ratings.push(...result.rows);
    sheets.push({ sheet: worksheet.name, layout: result.layout, ...result.stats });
    warnings.push(...result.warnings);
  });

  if (!ratings.length) warnings.push('No programme rating rows were recognised in this workbook.');
  return { ratings: dedupe(ratings), sheets, warnings };
}

// --- long layout -----------------------------------------------------------

function parseLong(grid, header, sheetName, sheetPeriod, sourceFile) {
  const rows = [];
  const warnings = [];
  let skipped = 0;
  let lastChannel = null;

  for (const { record, rawRow } of dataRows(grid, header)) {
    if (isTotalsRow(record)) {
      skipped += 1;
      continue;
    }
    const programme = canonicalName(str(record.programme_name));
    // Channel is often written once and left blank for the rows beneath it.
    const channel = canonicalName(str(record.channel_name)) || lastChannel;
    if (channel) lastChannel = channel;
    if (!programme || !channel) {
      skipped += 1;
      continue;
    }

    const period = resolvePeriod(record, sheetPeriod);
    rows.push({
      channel_name: channel,
      programme_name: programme,
      day_part: str(record.day_part),
      target_audience: str(record.target_audience),
      grp: num(record.grp),
      trp: num(record.trp),
      avg_duration_secs: durationSecs(record.avg_duration_secs),
      period_start: period.start,
      period_end: period.end,
      raw: { sheet: sheetName, source_file: sourceFile, layout: 'long', cells: rowAsLabelledObject(rawRow, header) },
    });
  }

  return { layout: 'long', rows, warnings, stats: { parsed: rows.length, skipped, headerRow: header.headerRow + 1 } };
}

// --- wide layout -----------------------------------------------------------

/**
 * Columns not claimed as identity fields are rating columns. Their combined
 * header label carries both the audience and the metric, e.g.
 * "females 15 40 grp" -> audience "females 15 40", metric GRP. Columns for the
 * same audience are merged into one output row.
 */
function parseWide(grid, header, sheetName, sheetPeriod, sourceFile) {
  const warnings = [];
  // The audience banner and the GRP/TVR labels sit on separate rows; merge them
  // so each rating column carries both.
  absorbSubHeader(grid, header, METRIC_LABEL);
  const claimed = new Set(Object.values(header.columns));
  const ratingCols = [];

  header.labels.forEach((label, col) => {
    if (claimed.has(col) || !label) return;
    const isGrp = GRP_LABEL.test(label);
    const isTrp = TRP_LABEL.test(label);
    // Strip the metric word to leave the audience name behind.
    const audience = normaliseLabel(label.replace(/\b(grps?|trps?|tvrs?|rating)\b/g, '')).trim();
    if (!isGrp && !isTrp) return;
    ratingCols.push({ col, metric: isGrp ? 'grp' : 'trp', audience: audience || null });
  });

  if (!ratingCols.length) {
    return {
      layout: 'wide',
      rows: [],
      warnings: [`${sheetName}: found programme rows but no GRP/TRP columns to read.`],
      stats: { parsed: 0, skipped: 0, reason: 'no rating columns' },
    };
  }

  // Group rating columns by audience so GRP and TRP for one audience land on
  // the same output row rather than two half-populated ones.
  const byAudience = new Map();
  for (const rc of ratingCols) {
    const key = rc.audience || '';
    if (!byAudience.has(key)) byAudience.set(key, []);
    byAudience.get(key).push(rc);
  }

  const rows = [];
  let skipped = 0;
  let lastChannel = null;

  for (const { record, rawRow } of dataRows(grid, header)) {
    if (isTotalsRow(record)) {
      skipped += 1;
      continue;
    }
    const programme = canonicalName(str(record.programme_name));
    const channel = canonicalName(str(record.channel_name)) || lastChannel;
    if (channel) lastChannel = channel;
    if (!programme || !channel) {
      skipped += 1;
      continue;
    }

    const period = resolvePeriod(record, sheetPeriod);
    const dayPart = str(record.day_part);
    const duration = durationSecs(record.avg_duration_secs);

    for (const [audience, cols] of byAudience) {
      let grp = null;
      let trp = null;
      for (const { col, metric } of cols) {
        const value = num(rawRow[col]);
        if (value === null) continue;
        if (metric === 'grp') grp = value;
        else trp = value;
      }
      // A programme with no rating for this audience isn't a data point.
      if (grp === null && trp === null) continue;

      rows.push({
        channel_name: channel,
        programme_name: programme,
        day_part: dayPart,
        target_audience: audience ? titleiseAudience(audience) : null,
        grp,
        trp,
        avg_duration_secs: duration,
        period_start: period.start,
        period_end: period.end,
        raw: {
          sheet: sheetName,
          source_file: sourceFile,
          layout: 'wide',
          audience_column: audience || null,
          cells: rowAsLabelledObject(rawRow, header),
        },
      });
    }
  }

  return {
    layout: 'wide',
    rows,
    warnings,
    stats: {
      parsed: rows.length,
      skipped,
      headerRow: header.headerRow + 1,
      audiences: [...byAudience.keys()].map((a) => a || '(unlabelled)'),
    },
  };
}

// --- shared helpers --------------------------------------------------------

/**
 * Duration cells are sometimes real numbers of seconds, sometimes "00:30:00"
 * time values that ExcelJS hands back as a Date, sometimes "30s".
 */
function durationSecs(raw) {
  if (raw instanceof Date) {
    return raw.getUTCHours() * 3600 + raw.getUTCMinutes() * 60 + raw.getUTCSeconds();
  }
  const s = str(raw);
  if (s && /^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const parts = s.split(':').map(Number);
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  }
  return int(raw);
}

function resolvePeriod(record, sheetPeriod) {
  const start = toDate(record.period_start) || toDate(record.period, { snapToMonthStart: true });
  const end = toDate(record.period_end) || toDate(record.period);
  return {
    start: start || sheetPeriod.start,
    end: end || sheetPeriod.end || start || sheetPeriod.start,
  };
}

/**
 * TVR sheets usually state the survey window in a banner above the table
 * ("Period: 01 Jan 2024 to 31 Mar 2024") rather than in columns.
 */
function findPeriodInBanner(grid) {
  const empty = { start: null, end: null };
  const limit = Math.min(grid.length, 15);
  for (let r = 0; r < limit; r += 1) {
    const text = (grid[r] || []).map((c) => str(c)).filter(Boolean).join(' ');
    if (!text) continue;
    const m = text.match(
      /([0-9]{1,2}[-/\s][A-Za-z0-9]{2,9}[-/\s][0-9]{2,4}|[A-Za-z]{3,9}[-\s][0-9]{2,4})\s*(?:to|-|–|until|till)\s*([0-9]{1,2}[-/\s][A-Za-z0-9]{2,9}[-/\s][0-9]{2,4}|[A-Za-z]{3,9}[-\s][0-9]{2,4})/i,
    );
    if (m) {
      const start = toDate(m[1]);
      const end = toDate(m[2]);
      if (start || end) return { start, end: end || start };
    }
  }
  return empty;
}

function titleiseAudience(audience) {
  return audience
    .split(' ')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Collapse duplicates on the natural key within a single upload. */
function dedupe(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [
      row.channel_name.toLowerCase(),
      row.programme_name.toLowerCase(),
      row.day_part || '',
      row.target_audience || '',
      row.period_start || '',
      row.period_end || '',
    ].join('|');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    // Later rows fill gaps but don't overwrite a value already read.
    existing.grp ??= row.grp;
    existing.trp ??= row.trp;
    existing.avg_duration_secs ??= row.avg_duration_secs;
  }
  return [...byKey.values()];
}

export const GRP_LONG_FIELDS = LONG_FIELDS;
