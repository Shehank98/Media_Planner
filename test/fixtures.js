import ExcelJS from 'exceljs';

// Synthetic workbooks that reproduce the layout problems the spec calls out:
// title banners above the table, merged group headers with sub-labels on the
// row below, blank spacer rows, totals rows, and columns in a different order
// from one file to the next.
//
// Replace these with the real TV_ChannelDetails / TV_GrpDetails files when they
// are available - the assertions should hold unchanged.

export async function adexWorkbook({ shuffled = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Adex');

  // Banner rows a human put there, above the actual table.
  ws.addRow(['MONTHLY ADEX REPORT - CONFIDENTIAL']);
  ws.addRow(['Prepared by Research Dept']);
  ws.addRow([]);

  if (!shuffled) {
    // Two-tier header: merged medium banner over Spend / Freq / Duration.
    ws.addRow(['Month', 'Sector', 'Category', 'Advertiser', 'Brand', 'Product2',
      'TV', null, null, 'Radio', null, null, 'Press', null, 'Total (000)']);
    ws.addRow([null, null, null, null, null, null,
      'Spend (000)', 'Freq', 'Dur Secs',
      'Spend (000)', 'Freq', 'Dur Secs',
      'Spend (000)', 'Ins', null]);
    ws.mergeCells('G4:I4');
    ws.mergeCells('J4:L4');
    ws.mergeCells('M4:N4');

    ws.addRow(['Jan-24', 'FMCG', 'Beverages', 'Alpha Ltd', 'Alpha Cola', 'Regular',
      '1,200.5', 45, 900, 300, 20, 600, '150.25', 4, 1650.75]);
    ws.addRow(['Jan-24', 'FMCG', 'Beverages', 'Beta PLC', 'Beta Fizz', 'Diet',
      2400, 80, 1600, 0, 0, 0, 500, 10, 2900]);
    ws.addRow([]); // spacer a human left in
    ws.addRow(['Feb-24', 'FMCG', 'Beverages', 'Alpha Ltd', 'Alpha Cola', 'Regular',
      '(200)', 10, 200, 100, 5, 150, 50, 2, null]); // parenthesised negative, derived total
    ws.addRow(['Feb-24', 'FMCG', 'Beverages', 'Beta PLC', 'Beta Fizz', 'Diet',
      1800, 60, 1200, 200, 8, 240, 300, 6, 2300]);
    ws.addRow(['Total', null, null, null, null, null, 5200, 195, 3900, 600, 33, 990, 1000, 22, 6850]);
  } else {
    // Same data, different column order and wording - the case that breaks any
    // parser assuming a fixed layout.
    ws.addRow(['Brand', 'Advertiser', 'Category', 'Sector', 'Product', 'Period',
      'TV Spend 000', 'TV Freq', 'Radio Spend 000', 'Press Spend 000', 'Total 000']);
    ws.addRow(['Alpha Cola', 'Alpha Ltd', 'Beverages', 'FMCG', 'Regular', '2024-03-01',
      900, 30, 100, 40, 1040]);
    ws.addRow(['Beta Fizz', 'Beta PLC', 'Beverages', 'FMCG', 'Diet', '2024-03-01',
      1500, 55, 250, 90, 1840]);
  }

  return wb.xlsx.writeBuffer();
}

export async function channelWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Channel Details');
  ws.addRow(['TV CHANNEL MASTER']);
  ws.addRow([]);
  ws.addRow(['Channel Name', 'Language', 'Genre', 'Coverage', 'Rate Card Ref', 'Notes']);
  ws.addRow(['TV Derana', 'Sinhala', 'General Entertainment', 'National', 'RC-2024-01', 'Strong in Western province']);
  ws.addRow(['Sirasa TV', 'Sinhala', 'General Entertainment', 'National', 'RC-2024-02', null]);
  ws.addRow(['Shakthi TV', 'Tamil', 'General Entertainment', 'North & East', 'RC-2024-03', null]);
  ws.addRow(['News First', 'English', 'News', 'National', 'RC-2024-04', null]);
  return wb.xlsx.writeBuffer();
}

/** Wide layout: audience banners merged across TVR/GRP column pairs. */
export async function grpWorkbookWide() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('GRP Details');
  ws.addRow(['PROGRAMME RATINGS']);
  ws.addRow(['Period: 01 Jan 2024 to 31 Mar 2024']);
  ws.addRow([]);
  ws.addRow(['Channel', 'Programme', 'Time Band', 'Duration',
    'Females 15-40', null, 'Males 15-40', null]);
  ws.addRow([null, null, null, null, 'GRP', 'TVR', 'GRP', 'TVR']);
  ws.mergeCells('E4:F4');
  ws.mergeCells('G4:H4');

  ws.addRow(['TV Derana', 'Derana News', 'Prime Time', '00:30:00', 12.5, 4.2, 9.8, 3.1]);
  ws.addRow([null, 'Teledrama Hour', 'Prime Time', 1800, 18.2, 6.1, 7.4, 2.5]); // channel carried down
  ws.addRow(['Sirasa TV', 'Sirasa News', 'Prime Time', 1500, 10.1, 3.4, 11.2, 3.9]);
  ws.addRow(['Shakthi TV', 'Tamil Cinema', 'Weekend', 3600, 6.4, 2.1, 8.9, 2.8]);
  ws.addRow(['Grand Total', null, null, null, 47.2, 15.8, 37.3, 12.3]);
  return wb.xlsx.writeBuffer();
}

/** Long layout: one row per programme x audience. */
export async function grpWorkbookLong() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ratings');
  ws.addRow(['Channel', 'Programme', 'Day Part', 'Target Audience', 'GRP', 'TRP',
    'Period Start', 'Period End']);
  ws.addRow(['TV Derana', 'Derana News', 'Prime Time', 'Females 15-40', 12.5, 4.2, '2024-01-01', '2024-03-31']);
  ws.addRow(['TV Derana', 'Derana News', 'Prime Time', 'Males 15-40', 9.8, 3.1, '2024-01-01', '2024-03-31']);
  ws.addRow(['Sirasa TV', 'Sirasa News', 'Prime Time', 'Females 15-40', 10.1, 3.4, '2024-01-01', '2024-03-31']);
  return wb.xlsx.writeBuffer();
}

export const SAMPLE_AGGREGATED = {
  scope: {
    brand: 'Alpha Cola', category: 'Beverages', sector: 'FMCG',
    period_from: '2023-01-01', period_to: '2024-03-31',
    target_audience: 'Females 15-40', language: 'Sinhala', quarters_covered: 6,
  },
  competitor_spend_by_quarter: [
    { brand: 'Beta Fizz', quarter: '2024-Q1', tv_spend_000: 4200, radio_spend_000: 200, press_spend_000: 800, total_spend_000: 5200 },
    { brand: 'Beta Fizz', quarter: '2023-Q4', tv_spend_000: 3800, radio_spend_000: 150, press_spend_000: 600, total_spend_000: 4550 },
    { brand: 'Gamma Drink', quarter: '2024-Q1', tv_spend_000: 2100, radio_spend_000: 400, press_spend_000: 100, total_spend_000: 2600 },
  ],
  own_brand_trend: [
    { quarter: '2023-Q4', tv_spend_000: 1200, radio_spend_000: 300, press_spend_000: 150, total_spend_000: 1650 },
    { quarter: '2024-Q1', tv_spend_000: 1000, radio_spend_000: 100, press_spend_000: 50, total_spend_000: 1150 },
  ],
  category_totals_by_quarter: [
    { quarter: '2023-Q4', total_spend_000: 6200, active_brands: 3 },
    { quarter: '2024-Q1', total_spend_000: 8950, active_brands: 3 },
  ],
  programme_ratings: [
    { channel_name: 'TV Derana', programme_name: 'Teledrama Hour', day_part: 'Prime Time', target_audience: 'Females 15-40', grp: 18.2, trp: 6.1, language: 'Sinhala' },
    { channel_name: 'TV Derana', programme_name: 'Derana News', day_part: 'Prime Time', target_audience: 'Females 15-40', grp: 12.5, trp: 4.2, language: 'Sinhala' },
    { channel_name: 'Sirasa TV', programme_name: 'Sirasa News', day_part: 'Prime Time', target_audience: 'Females 15-40', grp: 10.1, trp: 3.4, language: 'Sinhala' },
  ],
  channels: [
    { channel_name: 'TV Derana', language: 'Sinhala', category: 'General Entertainment', avg_rating: 15.35 },
    { channel_name: 'Sirasa TV', language: 'Sinhala', category: 'General Entertainment', avg_rating: 10.1 },
  ],
  data_notes: [],
};

export const SAMPLE_BRIEF = {
  brand: 'Alpha Cola',
  advertiser: 'Alpha Ltd',
  objective: 'Rebuild share of voice ahead of the April season',
  target_audience: 'Females 15-40',
  language: 'Sinhala',
  territory: 'National',
  period_start: '2024-04-01',
  period_end: '2024-06-30',
  budget_lkr_lakhs: 250,
  medium_split: { tv: 70, radio: 20, press: 10 },
};
