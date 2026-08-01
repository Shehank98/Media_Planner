import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseBriefPdf, parseBudget, parsePeriod, parseCommercialDurations,
} from '../src/parsers/briefParser.js';

let dir;
let pdfPath;
let parsed;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-brief-'));
  pdfPath = path.join(dir, 'brief.pdf');
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', ['test/make_brief_pdf.py', pdfPath]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
  parsed = await parseBriefPdf(await fs.readFile(pdfPath), { sourceFile: 'brief.pdf' });
});

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('brief parser reads label/value pairs from a side-by-side table', () => {
  assert.equal(parsed.fields.brand, 'Alpha Cola');
  assert.equal(parsed.fields.advertiser, 'Alpha Ltd');
  assert.equal(parsed.fields.language, 'Sinhala');
  assert.equal(parsed.fields.territory, 'National');
});

test('brief parser reads a value stacked under its label', () => {
  assert.equal(parsed.fields.target_audience, 'Females 15-40');
  assert.match(parsed.fields.objective, /Rebuild share of voice/);
});

test('brief parser reads the campaign period', () => {
  assert.equal(parsed.fields.period_start, '2024-04-01');
  assert.equal(parsed.fields.period_end, '2024-06-30');
});

test('brief parser normalises the budget to lakhs', () => {
  assert.equal(parsed.fields.budget_lkr_lakhs, 250);
});

test('brief parser reads the commercial lengths', () => {
  // A TV plan is built per copy length, so these drive the whole buy.
  assert.deepEqual(parsed.fields.commercial_durations, [10, 20, 30]);
});

test('brief parser reports which label matched each field', () => {
  assert.ok(parsed.confidence.brand, 'the planner can see what the parse keyed off');
  assert.equal(parsed.confidence.brand.rawValue, 'Alpha Cola');
});

test('parseBudget handles the unit words briefs actually use', () => {
  assert.equal(parseBudget('Rs. 250 Lakhs').value, 250);
  assert.equal(parseBudget('25 Mn').value, 250, '25 million rupees is 250 lakhs');
  assert.equal(parseBudget('2.5 crore').value, 250);
  assert.equal(parseBudget('LKR 25,000,000').value, 250);
});

test('parseBudget flags an ambiguous bare figure rather than guessing silently', () => {
  const big = parseBudget('25000000');
  assert.equal(big.value, 250);
  assert.match(big.unitNote, /no unit/, 'the assumption is surfaced for confirmation');

  const small = parseBudget('250');
  assert.equal(small.value, 250);
  assert.match(small.unitNote, /assumed lakhs/);
});

test('parsePeriod handles the date range formats seen on briefs', () => {
  assert.deepEqual(parsePeriod('01 April 2024 to 30 June 2024'), { start: '2024-04-01', end: '2024-06-30' });
  assert.deepEqual(parsePeriod('2024-04-01 - 2024-06-30'), { start: '2024-04-01', end: '2024-06-30' });
  assert.deepEqual(parsePeriod('1st April 2024 to 30th June 2024'), { start: '2024-04-01', end: '2024-06-30' });
});

test('parseCommercialDurations reads the forms briefs use', () => {
  assert.deepEqual(parseCommercialDurations(['Commercial length : 30 sec']), [30]);
  assert.deepEqual(parseCommercialDurations(['TVC 20s and a 10s cutdown']), [10, 20]);
  assert.deepEqual(parseCommercialDurations(['Copy lengths: 10/15/30']), [10, 15, 30]);
});

test('parseCommercialDurations does not read percentages or years as lengths', () => {
  // Once the unit is stripped, "18%" and "2026" are just digits - without a
  // plausibility bound they both become commercial lengths.
  assert.deepEqual(parseCommercialDurations(['VAT 18% applies in 2026']), []);
  assert.deepEqual(parseCommercialDurations(['Budget Rs. 25,00,000 over 60 days']), []);
});

test('brief parsing saves nothing by itself', () => {
  // Section 5 step 2 - the parse is a proposal for the planner to confirm.
  assert.ok(Array.isArray(parsed.warnings));
  assert.ok(parsed.lines.length > 0, 'the extracted text is returned for review');
});

// --- diagnosing a brief that yields nothing ---------------------------------

test('a scanned PDF is identified as having no text layer', async () => {
  // The most common real failure, and the one that looks identical to an
  // unfamiliar layout unless it is called out.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-scan-'));
  try {
    const pdfPath = path.join(dir, 'scan.pdf');
    await runPy(`
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
c = canvas.Canvas("${pdfPath}", pagesize=A4)
c.setFillColorRGB(0.85,0.85,0.85); c.rect(20*mm,100*mm,170*mm,150*mm,fill=1,stroke=0)
c.showPage(); c.save()`);

    const r = await parseBriefPdf(await fs.readFile(pdfPath), { sourceFile: 'scan.pdf' });
    assert.equal(r.extraction.has_text_layer, false);
    assert.equal(r.extraction.word_count, 0);
    assert.match(r.warnings[0], /no extractable text/i);
    assert.match(r.warnings[0], /scan/i, 'names the cause, not just the symptom');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an unfamiliar layout is distinguished from a scan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-labels-'));
  try {
    const pdfPath = path.join(dir, 'other.pdf');
    await runPy(`
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
c = canvas.Canvas("${pdfPath}", pagesize=A4)
t = c.beginText(25*mm, 260*mm); t.setFont("Helvetica", 11)
for line in ["QUARTERLY REVIEW DECK","","Some prose about last quarter's results that",
             "contains no brief labels at all but plenty of words to read,",
             "well past the threshold that would suggest a scanned page.",
             "More filler text follows here to push the word count up further."]:
    t.textLine(line)
c.drawText(t); c.showPage(); c.save()`);

    const r = await parseBriefPdf(await fs.readFile(pdfPath), { sourceFile: 'other.pdf' });
    assert.equal(r.extraction.has_text_layer, true, 'text was read');
    assert.equal(r.extraction.fields_matched, 0, 'but no labels matched');
    assert.match(r.warnings[0], /none of the expected labels/i);
    assert.ok(!/scan/i.test(r.warnings[0]), 'must not blame a scan when text was readable');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('brief parser reads an agency brief that uses different wording', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-agency-'));
  try {
    const pdfPath = path.join(dir, 'agency.pdf');
    await runPy(`
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
c = canvas.Canvas("${pdfPath}", pagesize=A4)
t = c.beginText(25*mm, 260*mm); t.setFont("Helvetica", 11)
for line in ["MEDIA REQUISITION FORM","",
  "Account          : Unilever Sri Lanka",
  "Product Line     : Sunsilk Shampoo",
  "Comms Task       : drive trial among young women in the Western province",
  "Who we are after : SEC AB Females, 18 to 34 years",
  "Money available  : Rs. 42,00,000",
  "On air           : 15 September through 31 October"]:
    t.textLine(line)
c.drawText(t); c.showPage(); c.save()`);

    const r = await parseBriefPdf(await fs.readFile(pdfPath), { sourceFile: 'agency.pdf' });
    assert.equal(r.fields.brand, 'Sunsilk Shampoo', '"Product Line" is a brand');
    assert.equal(r.fields.advertiser, 'Unilever Sri Lanka', '"Account" is the advertiser');
    assert.equal(r.fields.target_audience, 'SEC AB Females, 18 to 34 years');
    assert.match(r.fields.objective, /drive trial/);
    // "42,00,000" is lakh notation: 42 lakhs, not 4,200 thousand.
    assert.equal(r.fields.budget_lkr_lakhs, 42);
    assert.ok(r.fields.period_start, 'a year-less date range still resolves');
    assert.ok(
      r.warnings.some((w) => /gave no year/.test(w)),
      'the inferred year is flagged rather than passed off as read',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parsePeriod infers a forward-looking year when none is given', () => {
  const today = new Date('2026-08-01T00:00:00Z');
  // September is ahead of August, so this year.
  const soon = parsePeriod('15 September to 31 October', { today });
  assert.equal(soon.start, '2026-09-15');
  assert.equal(soon.end, '2026-10-31');
  assert.equal(soon.yearInferred, 2026);

  // February is well behind August: a brief means next February, not last.
  const next = parsePeriod('1 February to 28 February', { today });
  assert.equal(next.start, '2027-02-01');
});

test('parsePeriod handles a year-less range that crosses new year', () => {
  const today = new Date('2026-08-01T00:00:00Z');
  const period = parsePeriod('15 December to 20 January', { today });
  assert.equal(period.start, '2026-12-15');
  assert.equal(period.end, '2027-01-20', 'the end rolls into the following year');
});

/** Run a short reportlab snippet to build a fixture PDF. */
function runPy(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', ['-c', source]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}
