import { test } from 'node:test';
import assert from 'node:assert/strict';
import { str, num, int, toDate, quarterOf } from '../src/util/coerce.js';

test('num handles the formats hand-maintained sheets actually contain', () => {
  assert.equal(num(1234.5), 1234.5);
  assert.equal(num('1,234.5'), 1234.5);
  assert.equal(num('(890)'), -890, 'parenthesised figures are negative');
  assert.equal(num('Rs. 1,200'), 1200);
  assert.equal(num('45%'), 0.45);
  assert.equal(num('-'), null, 'a dash placeholder is not zero');
  assert.equal(num('n/a'), null);
  assert.equal(num(''), null);
  assert.equal(num('not a number'), null);
  assert.equal(num(null), null);
});

test('num unwraps ExcelJS formula and rich-text cells', () => {
  assert.equal(num({ formula: 'SUM(A1:A2)', result: 42 }), 42);
  assert.equal(str({ richText: [{ text: 'TV ' }, { text: 'Derana' }] }), 'TV Derana');
  assert.equal(num({ error: '#DIV/0!' }), null);
});

test('int rounds rather than truncating', () => {
  assert.equal(int('45.6'), 46);
  assert.equal(int(45.4), 45);
  assert.equal(int('-'), null);
});

test('str collapses whitespace and treats placeholders as empty', () => {
  assert.equal(str('  TV   Derana  '), 'TV Derana');
  assert.equal(str('#N/A'), null);
  assert.equal(str('   '), null);
});

test('toDate reads every month format seen in adex exports', () => {
  assert.equal(toDate('2024-01-15'), '2024-01-15');
  assert.equal(toDate('Jan-24', { snapToMonthStart: true }), '2024-01-01');
  assert.equal(toDate('January 2024'), '2024-01-01');
  assert.equal(toDate('15/01/2024'), '2024-01-15', 'day-first, the local convention');
  assert.equal(toDate('15 Jan 2024'), '2024-01-15');
  assert.equal(toDate('2024-01'), '2024-01-01');
});

test('toDate converts Excel serial numbers', () => {
  // 45292 is 2024-01-01 in the 1900 date system.
  assert.equal(toDate(45292), '2024-01-01');
});

test('toDate refuses a bare year rather than inventing a month', () => {
  assert.equal(toDate(2024), null);
});

test('snapToMonthStart normalises a month so the natural key is stable', () => {
  // The same month written two ways must produce one key, not two rows.
  assert.equal(toDate('15/01/2024', { snapToMonthStart: true }), '2024-01-01');
  assert.equal(toDate('Jan-24', { snapToMonthStart: true }), '2024-01-01');
});

test('quarterOf labels calendar quarters', () => {
  assert.equal(quarterOf('2024-01-01'), '2024-Q1');
  assert.equal(quarterOf('2024-06-30'), '2024-Q2');
  assert.equal(quarterOf('2024-12-01'), '2024-Q4');
  assert.equal(quarterOf(null), null);
});
