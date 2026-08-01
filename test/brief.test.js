import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseBriefPdf, parseBudget, parsePeriod, parseMediumSplit } from '../src/parsers/briefParser.js';

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

test('brief parser reads a medium split laid out as a table', () => {
  assert.deepEqual(parsed.fields.medium_split, { tv: 70, radio: 20, press: 10 });
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

test('parseMediumSplit flags percentages that do not total 100', () => {
  const split = parseMediumSplit(['TV 60%', 'Radio 20%', 'Press 5%']);
  assert.equal(split.tv, 60);
  assert.match(split._note, /total 85/, 'a short total usually means a missed row');
});

test('parseMediumSplit returns null when the brief states no split', () => {
  assert.equal(parseMediumSplit(['no percentages here']), null);
});

test('brief parsing saves nothing by itself', () => {
  // Section 5 step 2 - the parse is a proposal for the planner to confirm.
  assert.ok(Array.isArray(parsed.warnings));
  assert.ok(parsed.lines.length > 0, 'the extracted text is returned for review');
});
