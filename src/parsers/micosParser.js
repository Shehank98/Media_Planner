import { readWorkbook, sheetToGrid, detectHeader, dataRows, isTotalsRow } from './sheet.js';
import { str, num, int, toDate } from '../util/coerce.js';
import { canonicalName } from '../util/normalise.js';

// ---------------------------------------------------------------------------
// SRL MICOS "TV - Dashboards Report" parser.
//
// One export is five datasets, not one table, spread across sheets whose names
// are codes (A1, A2, A3, C1, "TV GRP") rather than descriptions. A "Target"
// sheet above them carries the survey window and the custom target group.
//
// Sheets are identified by their header signature rather than by name, because
// the same dashboard can be exported with different sheets present - the two
// TV_GrpDetails files supplied have entirely different contents from each
// other. Anything unrecognised is reported, not guessed at.
//
// Pivot helper sheets ("Sheet1") are ignored: they are Excel PivotTable output
// derived from the same numbers, so ingesting them would double-count.
// ---------------------------------------------------------------------------

const SHEET_SPECS = [
  {
    kind: 'programme_ratings', // C1 - TV Top Programs
    fields: {
      rank: ['rank'],
      data_set: ['data set'],
      programme_name: ['program name', 'programme name'],
      programme_category: ['category'],
      channel_name: ['channel'],
      avg_ratings: ['avg ratings', 'average ratings'],
      instances: ['instances'],
      avg_duration: ['avg program duration', 'average program duration', 'avg programme duration'],
      total_reach: ['total reach'],
      avg_reach: ['average reach', 'avg reach'],
    },
    required: ['programme_name', 'channel_name', 'avg_ratings'],
  },
  {
    kind: 'channel_performance', // A1
    fields: {
      data_set: ['data set'],
      channel_name: ['channel'],
      share_of_audience: ['share of audience'],
      total_ratings: ['total ratings'],
      avg_daily_minutes: ['avg daily minutes', 'average daily minutes'],
      individual_reach: ['individual reach'],
      individual_reach_pct: ['individual reach %'],
    },
    required: ['channel_name', 'share_of_audience'],
  },
  {
    kind: 'channel_day', // A2 - one row per day of week
    fields: {
      data_set: ['data set'],
      channel_name: ['channel'],
      day_of_week: ['day of week'],
      ratings: ['ratings'],
      reach: ['reach'],
      reach_pct: ['reach %'],
    },
    required: ['channel_name', 'day_of_week', 'ratings'],
  },
  {
    kind: 'channel_daypart', // A3 - Weekdays/Weekend x time band
    fields: {
      data_set: ['data set'],
      channel_name: ['channel'],
      day_group: ['days'],
      time_of_day: ['time of day'],
      ratings: ['ratings'],
      reach: ['reach'],
      reach_pct: ['reach %'],
    },
    required: ['channel_name', 'time_of_day', 'ratings'],
  },
  {
    kind: 'spot_grp', // "TV GRP" - one row per aired advertisement
    fields: {
      time: ['time'],
      channel_name: ['channel'],
      programme_category: ['program category', 'programme category'],
      programme_name: ['program', 'programme'],
      category: ['category'],
      sub_category: ['sub category'],
      brand: ['brand'],
      sub_brand: ['sub brand'],
      company: ['company'],
      ad_type: ['advertisement type'],
      ad_name: ['advertisement name'],
      duration: ['duration'],
      not_rated: ['not rated'],
      grp: ['grp'],
      reach: ['reach'],
    },
    required: ['time', 'channel_name', 'brand', 'grp'],
  },
];

/**
 * Parse a MICOS export.
 *
 * @returns {{meta, programmes, channelPerformance, channelDays, channelDayparts, spots, sheets, warnings}}
 */
export async function parseMicosWorkbook(buffer, { sourceFile = null } = {}) {
  const wb = await readWorkbook(buffer);
  const meta = readTargetSheet(wb, sourceFile);

  const out = {
    meta,
    programmes: [],
    channelPerformance: [],
    channelDays: [],
    channelDayparts: [],
    spots: [],
    sheets: [],
    warnings: [],
  };

  wb.eachSheet((worksheet) => {
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return;
    if (worksheet.name === 'Target') return;

    const grid = sheetToGrid(worksheet);
    if (!grid.length) return;

    const match = identifySheet(grid);
    if (!match) {
      // "Sheet1" is the PivotTable scratch sheet every export carries; saying
      // "unrecognised" for it every time would train people to ignore warnings.
      const known = /^sheet\d*$/i.test(worksheet.name);
      out.sheets.push({
        sheet: worksheet.name,
        kind: known ? 'pivot_helper (ignored)' : 'unrecognised',
        rows: 0,
      });
      if (!known) {
        out.warnings.push(
          `Sheet "${worksheet.name}" did not match any known MICOS layout and was skipped.`,
        );
      }
      return;
    }

    const { spec, header } = match;
    const rows = collect(grid, header, spec, meta, worksheet.name, sourceFile);
    out[BUCKET[spec.kind]].push(...rows);
    out.sheets.push({
      sheet: worksheet.name,
      kind: spec.kind,
      rows: rows.length,
      headerRow: header.headerRow + 1,
    });
  });

  if (!meta.target_audience) {
    out.warnings.push(
      'No "Custom TG" line was found on the Target sheet, so these ratings are not ' +
      'labelled with an audience. Confirm which target group this export covers.',
    );
  }
  if (!meta.period_start) {
    out.warnings.push('No reporting period was found on the Target sheet.');
  }
  return out;
}

const BUCKET = {
  programme_ratings: 'programmes',
  channel_performance: 'channelPerformance',
  channel_day: 'channelDays',
  channel_daypart: 'channelDayparts',
  spot_grp: 'spots',
};

/**
 * Identify a sheet by its header signature.
 *
 * A2 and A3 are near-identical apart from one column, so every spec is scored
 * and the best-fitting one wins rather than the first that merely qualifies.
 */
function identifySheet(grid) {
  let best = null;
  for (const spec of SHEET_SPECS) {
    const header = detectHeader(grid, spec.fields, { required: spec.required, scanRows: 12 });
    if (!header) continue;
    const matched = Object.keys(header.columns).length;
    const score = matched / Object.keys(spec.fields).length;
    if (!best || score > best.score || (score === best.score && matched > best.matched)) {
      best = { spec, header, score, matched };
    }
  }
  return best;
}

/** The Target sheet: survey window, custom target group, export provenance. */
function readTargetSheet(wb, sourceFile) {
  const meta = {
    source_file: sourceFile,
    target_audience: null,
    period_start: null,
    period_end: null,
    exported_at: null,
    exported_by: null,
  };
  const ws = wb.getWorksheet('Target');
  if (!ws) return meta;

  const grid = sheetToGrid(ws);
  for (let r = 0; r < grid.length; r += 1) {
    const cells = (grid[r] || []).map((c) => str(c)).filter(Boolean);
    // Merged banner cells repeat across the row; one copy is enough.
    const unique = [...new Set(cells)];

    for (const cell of unique) {
      // "Custom TG: Meera 16-45" - the audience every number in the file is for.
      const tg = cell.match(/^custom\s*(?:tg|target\s*group)\s*[:\-]\s*(.+)$/i);
      if (tg) meta.target_audience = tg[1].trim();
    }

    // The header row labels the values on the row beneath.
    if (unique.some((c) => /^reporting from$/i.test(c))) {
      const labels = (grid[r] || []).map((c) => str(c));
      const values = (grid[r + 1] || []).map((c) => str(c));
      for (let c = 0; c < labels.length; c += 1) {
        const label = (labels[c] || '').toLowerCase();
        const value = values[c];
        if (!value) continue;
        if (label === 'reporting from') meta.period_start = toDate(value);
        else if (label === 'reporting to') meta.period_end = toDate(value);
        else if (label.startsWith('exported date')) meta.exported_at = parseExportedAt(value);
        else if (label === 'exported by') meta.exported_by = value;
      }
    }
  }
  return meta;
}

function parseExportedAt(value) {
  // "2026-07-20 11:06" - no timezone in the file; treat as UTC rather than
  // silently adopting whatever the server happens to be set to.
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
}

// --- row builders ----------------------------------------------------------

function collect(grid, header, spec, meta, sheetName, sourceFile) {
  const rows = [];
  for (const { record } of dataRows(grid, header)) {
    if (isTotalsRow(record)) continue;
    const built = BUILDERS[spec.kind](record, meta, sheetName, sourceFile);
    if (built) rows.push(built);
  }
  return dedupe(rows, spec.kind);
}

/**
 * The audience label on a row.
 *
 * MICOS puts "Custom Target" in the Data Set column - a placeholder, not a
 * description. The Target sheet's "Custom TG: Meera 16-45" is the real
 * definition, so that wins whenever it is present.
 */
function audienceOf(record, meta) {
  const dataSet = str(record.data_set);
  if (meta.target_audience) return meta.target_audience;
  return dataSet && !/^custom target$/i.test(dataSet) ? dataSet : '';
}

const BUILDERS = {
  programme_ratings(record, meta) {
    const programme = canonicalName(str(record.programme_name));
    const channel = canonicalName(str(record.channel_name));
    if (!programme || !channel) return null;

    // MICOS reports programme duration in whole minutes.
    const durationMins = num(record.avg_duration);
    return {
      channel_name: channel,
      programme_name: programme,
      programme_category: str(record.programme_category),
      target_audience: audienceOf(record, meta),
      // "Avg. Ratings" is a TVR, not a GRP - keeping them in separate columns
      // stops a rating being read as gross rating points later.
      trp: num(record.avg_ratings),
      grp: null,
      instances: int(record.instances),
      avg_duration_secs: durationMins === null ? null : Math.round(durationMins * 60),
      total_reach: num(record.total_reach),
      avg_reach: num(record.avg_reach),
      rank: int(record.rank),
      day_part: null,
      period_start: meta.period_start,
      period_end: meta.period_end,
      raw: null,
    };
  },

  channel_performance(record, meta) {
    const channel = canonicalName(str(record.channel_name));
    if (!channel) return null;
    return {
      channel_name: channel,
      target_audience: audienceOf(record, meta),
      share_of_audience: num(record.share_of_audience),
      total_ratings: num(record.total_ratings),
      avg_daily_minutes: num(record.avg_daily_minutes),
      individual_reach: num(record.individual_reach),
      individual_reach_pct: num(record.individual_reach_pct),
      period_start: meta.period_start,
      period_end: meta.period_end,
    };
  },

  channel_day(record, meta) {
    const channel = canonicalName(str(record.channel_name));
    const day = str(record.day_of_week);
    if (!channel || !day) return null;
    return {
      channel_name: channel,
      target_audience: audienceOf(record, meta),
      day_of_week: day,
      day_group: '',
      time_of_day: '',
      ratings: num(record.ratings),
      reach: num(record.reach),
      reach_pct: num(record.reach_pct),
      period_start: meta.period_start,
      period_end: meta.period_end,
    };
  },

  channel_daypart(record, meta) {
    const channel = canonicalName(str(record.channel_name));
    const band = str(record.time_of_day);
    if (!channel || !band) return null;
    return {
      channel_name: channel,
      target_audience: audienceOf(record, meta),
      day_of_week: '',
      day_group: str(record.day_group) || '',
      time_of_day: band,
      ratings: num(record.ratings),
      reach: num(record.reach),
      reach_pct: num(record.reach_pct),
      period_start: meta.period_start,
      period_end: meta.period_end,
    };
  },

  spot_grp(record, meta) {
    const channel = canonicalName(str(record.channel_name));
    const airedAt = parseSpotTime(record.time);
    if (!channel || !airedAt) return null;
    return {
      aired_at: airedAt,
      channel_name: channel,
      programme_name: canonicalName(str(record.programme_name)) || '',
      programme_category: str(record.programme_category),
      category: str(record.category),
      sub_category: str(record.sub_category),
      brand: canonicalName(str(record.brand)) || '',
      sub_brand: str(record.sub_brand),
      company: str(record.company),
      ad_type: str(record.ad_type),
      ad_name: str(record.ad_name) || '',
      duration_secs: int(record.duration),
      not_rated: /^yes$/i.test(str(record.not_rated) || ''),
      grp: num(record.grp),
      reach: num(record.reach),
      target_audience: audienceOf(record, meta),
      period_start: meta.period_start,
      period_end: meta.period_end,
    };
  },
};

/** "2026-06-01 06:46" or a real Excel datetime. */
function parseSpotTime(raw) {
  if (raw instanceof Date) return raw.toISOString().slice(0, 19).replace('T', ' ');
  const s = str(raw);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}`;
  }
  // Excel serial with a fractional day.
  const n = num(raw);
  if (n !== null && n > 20_000 && n < 200_000) {
    const d = new Date(Math.round((n - 25569) * 86_400_000));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  }
  return null;
}

/** Collapse rows sharing a natural key within one upload. */
function dedupe(rows, kind) {
  const keyOf = {
    programme_ratings: (r) => `${r.channel_name}|${r.programme_name}|${r.target_audience}`,
    channel_performance: (r) => `${r.channel_name}|${r.target_audience}`,
    channel_day: (r) => `${r.channel_name}|${r.target_audience}|${r.day_of_week}`,
    channel_daypart: (r) => `${r.channel_name}|${r.target_audience}|${r.day_group}|${r.time_of_day}`,
    spot_grp: (r) =>
      `${r.aired_at}|${r.channel_name}|${r.brand}|${r.ad_name}|${r.duration_secs}|${r.target_audience}`,
  }[kind];

  const seen = new Map();
  for (const row of rows) seen.set(keyOf(row).toLowerCase(), row);
  return [...seen.values()];
}

export const MICOS_SHEET_KINDS = SHEET_SPECS.map((s) => s.kind);
