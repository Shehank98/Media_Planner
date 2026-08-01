import ExcelJS from 'exceljs';

// Fixtures mirroring the real file layouts.
//
// The MICOS builders below reproduce the structure of the actual SRL MICOS
// dashboard exports: a "Target" sheet carrying the survey window and the custom
// target group, a "Sheet1" PivotTable scratch sheet that must be ignored, and
// code-named data sheets (A1/A2/A3/C1/"TV GRP") identified by header signature.
//
// The adex builder reproduces the real adex column wording ("Tv (000Rs)",
// "Tv Frq", "Press Ins", "Qua", "Product 2") plus the layout problems those
// files carry - banner rows, merged headers, spacers and totals rows.

/** The Target sheet every MICOS export starts with. */
function addTargetSheet(wb, { targetGroup = 'Meera 16-45', from = '2026-Jun-01', to = '2026-Jun-30' } = {}) {
  const ws = wb.addWorksheet('Target');
  ws.addRow(['SRL MICOS - EVALUATE']);
  ws.addRow(['The AI-driven TV Audience Measurement System']);
  ws.addRow(['TV - Dashboards Report']);
  ws.addRow(['Disclaimer: This file is provided solely for use by the duly licensed user.']);
  ws.addRow([]);
  ws.addRow(['Reporting From', 'Reporting To', null, 'Exported Date and Time', 'Exported By']);
  ws.addRow([from, to, null, '2026-07-20 11:06', 'planner@agency.lk']);
  ws.addRow([]);
  if (targetGroup) ws.addRow([`Custom TG: ${targetGroup}`]);
  ws.mergeCells('A1:E1');
  ws.mergeCells('A2:E2');
  return ws;
}

/** The PivotTable helper sheet that must never be ingested (it double-counts). */
function addPivotHelper(wb) {
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Channel', 'HIRU TV']);
  ws.addRow([]);
  ws.addRow(['Row Labels', 'Sum of Avg. Ratings']);
  ws.addRow(['PAATA KURULLO', 21.33]);
  ws.addRow(['AKURATA YANA WELAWE', 19.96]);
  return ws;
}

/** TV_ChannelDetails: sheet C1, top programmes. */
export async function micosChannelDetails(opts = {}) {
  const wb = new ExcelJS.Workbook();
  addTargetSheet(wb, opts);
  addPivotHelper(wb);

  const ws = wb.addWorksheet('C1');
  ws.addRow(['C1 - TV Top Programs']);
  ws.mergeCells('A1:J1');
  ws.addRow(['Rank', 'Data Set', 'Program Name', 'Category', 'Channel',
    'Avg. Ratings', 'Instances', 'Avg. Program Duration', 'Total Reach', 'Average Reach']);
  ws.addRow([1, 'Custom Target', 'PAATA KURULLO', 'TELEDRAMAS - SINHALA', 'HIRU TV', 21.33, 22, 27, 1074000, 662045]);
  ws.addRow([2, 'Custom Target', 'AKURATA YANA WELAWE', 'TELEDRAMAS - SINHALA', 'HIRU TV', 19.96, 22, 22, 1074000, 632136]);
  ws.addRow([3, 'Custom Target', 'SANGEETHE - SEASON 2', 'TELEDRAMAS - SINHALA', 'DERANA TV', 10.54, 22, 25, 985000, 540000]);
  ws.addRow([4, 'Custom Target', 'HIRU NEWS 6:55 PM', 'NEWS', 'HIRU TV', 14.24, 30, 50, 1074000, 564867]);
  return wb.xlsx.writeBuffer();
}

/** TV_GrpDetails variant one: sheets A1, A2, A3. */
export async function micosChannelDashboards(opts = {}) {
  const wb = new ExcelJS.Workbook();
  addTargetSheet(wb, opts);
  addPivotHelper(wb);

  const a1 = wb.addWorksheet('A1');
  a1.addRow(['A1 - Channel Summary']);
  a1.addRow(['Data Set', 'Channel', 'Share of Audience', 'Total Ratings',
    'Avg. Daily Minutes', 'Individual Reach', 'Individual Reach %']);
  a1.addRow(['Custom Target', 'HIRU TV', 28.04, 135847.2, 130.5, 1462000, 68.06]);
  a1.addRow(['Custom Target', 'DERANA TV', 19.81, 95966.99, 123.26, 1533000, 71.37]);

  const a2 = wb.addWorksheet('A2');
  a2.addRow(['A2 - Channel by Day of Week']);
  a2.addRow(['Data Set', 'Channel', 'Day of Week', 'Ratings', 'Reach', 'Reach %']);
  a2.addRow(['Custom Target', 'HIRU TV', 'Sunday', 16238.41, 1132000, 52.7]);
  a2.addRow(['Custom Target', 'HIRU TV', 'Monday', 20446.74, 1339000, 62.34]);
  a2.addRow(['Custom Target', 'HIRU TV', 'Tuesday', 23787.48, 1149000, 53.49]);
  a2.addRow(['Custom Target', 'DERANA TV', 'Tuesday', 15868.39, 1196000, 55.68]);

  const a3 = wb.addWorksheet('A3');
  a3.addRow(['A3 - Channel by Day Part']);
  a3.addRow(['Data Set', 'Channel', 'Days', 'Time of Day', 'Ratings', 'Reach', 'Reach %']);
  a3.addRow(['Custom Target', 'DERANA TV', 'Weekdays', 'Evening Peak (1900 - 2059)', 33292.55, 1400000, 65.2]);
  a3.addRow(['Custom Target', 'DERANA TV', 'Weekdays', 'Morning Off-Peak (0800 - 1059)', 2646.97, 521000, 24.26]);
  a3.addRow(['Custom Target', 'DERANA TV', 'Weekends', 'Evening Peak (1900 - 2059)', 11248.7, 1100000, 51.2]);
  return wb.xlsx.writeBuffer();
}

/** TV_GrpDetails variant two: the "TV GRP" spot-level sheet. */
export async function micosSpotGrp(opts = {}) {
  const wb = new ExcelJS.Workbook();
  // The real spot-level export omits the Custom TG line - the case that forces
  // the audience to be carried over from a sibling file in the same upload.
  addTargetSheet(wb, { targetGroup: null, ...opts });
  addPivotHelper(wb);

  const ws = wb.addWorksheet('TV GRP');
  ws.addRow(['TV GRP Details']);
  ws.addRow(['Time', 'Channel', 'Program Category', 'Program', 'Category', 'Sub Category',
    'Brand', 'Sub Brand', 'Company', 'Advertisement Type', 'Advertisement Name',
    'Duration', 'Not Rated', 'GRP', 'Reach']);
  ws.addRow(['2026-06-01 06:46', 'SWARNAVAHINI', 'NEWS', 'MULPITUWA', 'Shampoos/conditioners', '',
    'Sunsilk', '', 'Unilever Sri Lanka Limited', 'TC', 'SUNSILK - SOFT AND SMOOTH', 10, 'No', 0, 0]);
  ws.addRow(['2026-06-02 20:15', 'HIRU TV', 'TELEDRAMAS - SINHALA', 'PAATA KURULLO', 'Shampoos/conditioners', '',
    'Dove', '', 'Unilever Sri Lanka Limited', 'TC', 'DOVE - INTENSE REPAIR', 15, 'No', 25.18, 480000]);
  ws.addRow(['2026-06-03 20:20', 'HIRU TV', 'TELEDRAMAS - SINHALA', 'PAATA KURULLO', 'Shampoos/conditioners', '',
    'Sunsilk', '', 'Unilever Sri Lanka Limited', 'TC', 'SUNSILK - SOFT AND SMOOTH', 15, 'No', 21.09, 440000]);
  return wb.xlsx.writeBuffer();
}

/** Media watch spot log as tab-delimited text, the way it is usually exported. */
export function mediaWatchTsv() {
  const header = ['Product_Group', 'Advertiser', 'Product', 'Advt_Theme', 'Ads', 'Channel',
    'Program', 'Dd', 'Mn', 'Yr', 'Day', 'Prog_time', 'Advt_time', 'AdPos', 'TotAds',
    'BrkNo', 'PosinBrk', 'AdsinBrk', 'Lng', 'Dur', 'Cost'];
  const rows = [
    ['Telecom Services', 'Mobitel Lanka Ltd.', 'Mobitel Corporate', 'Fastest Network_2024', '1',
      'Radio - Neth  FM', 'Hathara Wate', '6', '2', '2025', 'Thu', '16:04', '16:23:39',
      '10', '81', '2', '8', '8', 'Sin', '15', '13,000'],
    ['Telecom Services', 'Mobitel Lanka Ltd.', 'Mobitel Corporate', 'Fastest Network_2024', '1',
      'Radio - Neth  FM', 'After School', '10', '2', '2025', 'Mon', '14:02', '14:22:18',
      '10', '76', '5', '3', '9', 'Sin', '15', '8,000'],
    ['Personal Care', 'Unilever Sri Lanka Limited', 'Sunsilk', 'Soft And Smooth', '1',
      'TV - HIRU TV', 'PAATA KURULLO', '3', '6', '2026', 'Wed', '20:00', '20:20:11',
      '4', '60', '2', '4', '9', 'Sin', '15', '145,000'],
  ];
  return Buffer.from([header, ...rows].map((r) => r.join('\t')).join('\n'), 'utf8');
}

/** Adex workbook using the real column wording, with the real layout problems. */
export async function adexWorkbook({ shuffled = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Adex');

  ws.addRow(['MONTHLY ADEX REPORT - CONFIDENTIAL']);
  ws.addRow(['Prepared by Research Dept']);
  ws.addRow([]);

  if (!shuffled) {
    // The real header wording, spread over two rows with merged medium banners.
    ws.addRow(['Month', 'Super Category', 'Product Group', 'Mother Brand', 'Advertiser', 'Brand',
      'Tv', null, null, 'Radio', null, null, 'Press', null,
      'Total(000)', 'FY', 'Month2', 'Qua', 'Sector', 'Category', 'Product 2']);
    ws.addRow([null, null, null, null, null, null,
      '(000Rs)', 'Frq', 'Dur(secs)', '(000Rs)', 'Frq', 'Dur(secs)', '(000Rs)', 'Ins',
      null, null, null, null, null, null, null]);
    ws.mergeCells('G4:I4');
    ws.mergeCells('J4:L4');
    ws.mergeCells('M4:N4');

    ws.addRow(['1/1/2021', 'Others', 'Corporate Advertising', 'Cavin Kare', 'Cavin Kare Lanka (Pvt) Ltd.',
      'Cavin Kare', '1,200.5', 45, 900, 300, 20, 600, '188', 1, 1688.5,
      '20-21', 'January', 'Q4', 'Other', 'Not Relavent', 'Cavin']);
    ws.addRow(['2/1/2021', 'Others', 'Corporate Advertising', 'Rival Group', 'Rival Lanka (Pvt) Ltd.',
      'Rival Brand', 2400, 80, 1600, 0, 0, 0, 500, 10, 2900,
      '20-21', 'February', 'Q4', 'Other', 'Not Relavent', 'Rival']);
    ws.addRow([]); // spacer a human left in
    ws.addRow(['3/1/2021', 'Others', 'Corporate Advertising', 'Cavin Kare', 'Cavin Kare Lanka (Pvt) Ltd.',
      'Cavin Kare', '(200)', 10, 200, 100, 5, 150, 50, 2, null,
      '20-21', 'March', 'Q4', 'Other', 'Not Relavent', 'Cavin']);
    ws.addRow(['Total', null, null, null, null, null, 3400.5, 135, 2700, 400, 25, 750, 738, 13, 4588.5]);
  } else {
    // Same data, different column order and wording.
    ws.addRow(['Brand', 'Advertiser', 'Category', 'Sector', 'Product', 'Period',
      'Tv (000Rs)', 'Tv Frq', 'Radio (000Rs)', 'Press (000Rs)', 'Total(000)']);
    ws.addRow(['Cavin Kare', 'Cavin Kare Lanka (Pvt) Ltd.', 'Not Relavent', 'Other', 'Cavin',
      '2021-04-01', 900, 30, 100, 40, 1040]);
    ws.addRow(['Rival Brand', 'Rival Lanka (Pvt) Ltd.', 'Not Relavent', 'Other', 'Rival',
      '2021-04-01', 1500, 55, 250, 90, 1840]);
  }
  return wb.xlsx.writeBuffer();
}

/** An aggregated payload shaped like buildAggregatedData's output. */
export const SAMPLE_AGGREGATED = {
  scope: {
    brand: 'Sunsilk', category: 'Shampoos/conditioners', sector: 'Personal Care',
    period_from: '2026-01-01', period_to: '2026-06-30',
    target_audience: 'Meera 16-45', audience_panel: 'Meera 16-45', audience_matched: true,
    language: 'Sinhala', quarters_covered: 6, budget_lkr_lakhs: 250,
  },
  competitor_spend_by_quarter: [
    { brand: 'Dove', quarter: '2026-Q2', tv_spend_000: 4200, radio_spend_000: 200, press_spend_000: 800, total_spend_000: 5200 },
    { brand: 'Dove', quarter: '2026-Q1', tv_spend_000: 3800, radio_spend_000: 150, press_spend_000: 600, total_spend_000: 4550 },
    { brand: 'Lifebuoy', quarter: '2026-Q2', tv_spend_000: 2100, radio_spend_000: 400, press_spend_000: 100, total_spend_000: 2600 },
  ],
  own_brand_trend: [
    { quarter: '2026-Q1', tv_spend_000: 1200, radio_spend_000: 300, press_spend_000: 150, total_spend_000: 1650 },
    { quarter: '2026-Q2', tv_spend_000: 1000, radio_spend_000: 100, press_spend_000: 50, total_spend_000: 1150 },
  ],
  category_totals_by_quarter: [
    { quarter: '2026-Q1', total_spend_000: 6200, active_brands: 3 },
    { quarter: '2026-Q2', total_spend_000: 8950, active_brands: 3 },
  ],
  programme_ratings: [
    { channel_name: 'HIRU TV', programme_name: 'PAATA KURULLO', programme_category: 'TELEDRAMAS - SINHALA',
      target_audience: 'Meera 16-45', avg_rating: 21.33, instances: 22, avg_duration_secs: 1620,
      observed_avg_cost: 145000, cost_per_rating_point: 6798 },
    { channel_name: 'HIRU TV', programme_name: 'AKURATA YANA WELAWE', programme_category: 'TELEDRAMAS - SINHALA',
      target_audience: 'Meera 16-45', avg_rating: 19.96, instances: 22, avg_duration_secs: 1320,
      observed_avg_cost: null, cost_per_rating_point: null },
    { channel_name: 'DERANA TV', programme_name: 'SANGEETHE - SEASON 2', programme_category: 'TELEDRAMAS - SINHALA',
      target_audience: 'Meera 16-45', avg_rating: 10.54, instances: 22, avg_duration_secs: 1500,
      observed_avg_cost: null, cost_per_rating_point: null },
  ],
  channel_performance: [
    { channel_name: 'HIRU TV', share_of_audience: 28.04, total_ratings: 135847.2, individual_reach_pct: 68.06 },
    { channel_name: 'DERANA TV', share_of_audience: 19.81, total_ratings: 95966.99, individual_reach_pct: 71.37 },
  ],
  best_days: [
    { channel_name: 'HIRU TV', day_of_week: 'Monday', ratings: 20446.74, reach_pct: 62.34, day_rank: 2 },
    { channel_name: 'HIRU TV', day_of_week: 'Tuesday', ratings: 23787.48, reach_pct: 53.49, day_rank: 1 },
    { channel_name: 'HIRU TV', day_of_week: 'Sunday', ratings: 16238.41, reach_pct: 52.7, day_rank: 3 },
    { channel_name: 'DERANA TV', day_of_week: 'Tuesday', ratings: 15868.39, reach_pct: 55.68, day_rank: 1 },
  ],
  best_dayparts: [
    { channel_name: 'HIRU TV', day_group: 'Weekdays', time_of_day: 'Evening Peak (1900 - 2059)', ratings: 33292.55, band_rank: 1 },
    { channel_name: 'DERANA TV', day_group: 'Weekdays', time_of_day: 'Evening Peak (1900 - 2059)', ratings: 21248.7, band_rank: 1 },
  ],
  programme_rates: [
    { medium: 'TV', channel_name: 'HIRU TV', programme_name: 'PAATA KURULLO', duration_secs: 15,
      spots_observed: 4, avg_cost: 145000, min_cost: 140000, max_cost: 150000, days_observed: ['Wed'] },
    { medium: 'Radio', channel_name: 'Neth FM', programme_name: 'Hathara Wate', duration_secs: 15,
      spots_observed: 2, avg_cost: 13000, min_cost: 13000, max_cost: 13000, days_observed: ['Thu'] },
  ],
  competitor_spot_pressure: [
    { channel_name: 'HIRU TV', programme_name: 'PAATA KURULLO', spots: 18, brands: 3,
      total_grp: 453.27, top_brands: ['Dove', 'Lifebuoy', 'Sunsilk'], own_brand_present: true },
    { channel_name: 'DERANA TV', programme_name: 'SANGEETHE - SEASON 2', spots: 44, brands: 5,
      total_grp: 554.43, top_brands: ['Dove', 'Lifebuoy'], own_brand_present: false },
  ],
  data_notes: [],
};

export const SAMPLE_BRIEF = {
  brand: 'Sunsilk',
  advertiser: 'Unilever Sri Lanka Limited',
  objective: 'Rebuild share of voice among Sinhala-speaking women',
  target_audience: 'Meera 16-45',
  language: 'Sinhala',
  territory: 'National',
  period_start: '2026-08-01',
  period_end: '2026-09-30',
  budget_lkr_lakhs: 250,
  medium_split: { tv: 70, radio: 20, press: 10 },
};
