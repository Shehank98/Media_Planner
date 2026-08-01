import { readWorkbook, sheetToGrid, detectHeader, dataRows, isTotalsRow } from './sheet.js';
import { str } from '../util/coerce.js';
import { canonicalName } from '../util/normalise.js';

// ---------------------------------------------------------------------------
// TV_ChannelDetails workbook parser (channel master data).
//
// These sheets carry a title banner, merged section headers and free-text notes
// columns whose wording changes between revisions, so columns are resolved by
// synonym rather than position. Everything on the row - mapped or not - is kept
// in `raw` so a column we didn't anticipate isn't lost.
// ---------------------------------------------------------------------------

const FIELDS = {
  channel_name: ['channel', 'channel name', 'tv channel', 'station', 'channel/station'],
  language: ['language', 'lang', 'medium language'],
  category: ['category', 'genre', 'channel category', 'channel type', 'type'],
  reach_notes: ['reach', 'reach notes', 'coverage', 'remarks', 'notes', 'comments', 'reach %'],
  rate_card_ref: ['rate card', 'rate card ref', 'ratecard', 'rate', 'card ref', 'tariff', 'rate ref'],
};

const REQUIRED = ['channel_name'];

export async function parseChannelWorkbook(buffer, { sourceFile = null } = {}) {
  const wb = await readWorkbook(buffer);
  const channels = [];
  const sheets = [];
  const warnings = [];
  const seen = new Set();

  wb.eachSheet((worksheet) => {
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return;
    const grid = sheetToGrid(worksheet);
    if (!grid.length) return;

    const header = detectHeader(grid, FIELDS, { required: REQUIRED });
    if (!header) {
      sheets.push({ sheet: worksheet.name, parsed: 0, reason: 'no channel header found' });
      return;
    }

    let parsed = 0;
    let skipped = 0;
    for (const { record, rawRow } of dataRows(grid, header)) {
      if (isTotalsRow(record)) {
        skipped += 1;
        continue;
      }
      const channelName = canonicalName(str(record.channel_name));
      if (!channelName) {
        skipped += 1;
        continue;
      }
      // Within one upload the last mention of a channel wins.
      const key = channelName.toLowerCase();
      if (seen.has(key)) {
        const idx = channels.findIndex((c) => c.channel_name.toLowerCase() === key);
        channels[idx] = buildChannel(channelName, record, rawRow, header, worksheet.name, sourceFile);
        continue;
      }
      seen.add(key);
      channels.push(buildChannel(channelName, record, rawRow, header, worksheet.name, sourceFile));
      parsed += 1;
    }

    sheets.push({
      sheet: worksheet.name,
      parsed,
      skipped,
      headerRow: header.headerRow + 1,
      mappedColumns: Object.keys(header.columns),
    });
  });

  if (!channels.length) warnings.push('No channel rows were recognised in this workbook.');
  return { channels, sheets, warnings };
}

function buildChannel(channelName, record, rawRow, header, sheetName, sourceFile) {
  return {
    channel_name: channelName,
    language: str(record.language),
    category: str(record.category),
    reach_notes: str(record.reach_notes),
    rate_card_ref: str(record.rate_card_ref),
    raw: {
      sheet: sheetName,
      source_file: sourceFile,
      // Full row keyed by its header label - preserves columns we didn't map.
      cells: rowAsLabelledObject(rawRow, header),
    },
  };
}

/** Zip a raw row against the detected header labels, dropping empty cells. */
export function rowAsLabelledObject(rawRow, header) {
  const out = {};
  for (let c = 0; c < (rawRow?.length || 0); c += 1) {
    const label = header.labels[c];
    const value = str(rawRow[c]);
    if (!label || value === null) continue;
    out[label] = value;
  }
  return out;
}

export const CHANNEL_FIELDS = FIELDS;
