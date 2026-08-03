import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourOf, daypartForTime, categoryForTheme } from '../src/services/workflow/classify.js';

test('hourOf reads the hour from clock strings', () => {
  assert.equal(hourOf('20:05'), 20);
  assert.equal(hourOf('06:00:00'), 6);
  assert.equal(hourOf('9:30'), 9);
  assert.equal(hourOf(''), null);
  assert.equal(hourOf('n/a'), null);
  assert.equal(hourOf(null), null);
});

test('daypart split follows the brief: PT 18-24, Non-PT 06-18', () => {
  assert.equal(daypartForTime('20:05'), 'PT');
  assert.equal(daypartForTime('18:00'), 'PT');
  assert.equal(daypartForTime('23:59'), 'PT');
  assert.equal(daypartForTime('06:00'), 'Non-PT');
  assert.equal(daypartForTime('17:59'), 'Non-PT');
  assert.equal(daypartForTime('12:30'), 'Non-PT');
  // 00:00-06:00 falls outside the PT window, so Non-PT by default.
  assert.equal(daypartForTime('02:00'), 'Non-PT');
  assert.equal(daypartForTime('bad'), null);
});

test('the PT boundary is configurable', () => {
  // Move PT earlier to 17:00.
  assert.equal(daypartForTime('17:30', { ptStartHour: 17 }), 'PT');
  // A window that wraps past midnight (18:00-02:00) still reads as one block.
  assert.equal(daypartForTime('01:00', { ptStartHour: 18, ptEndHour: 2 }), 'PT');
  assert.equal(daypartForTime('03:00', { ptStartHour: 18, ptEndHour: 2 }), 'Non-PT');
});

test('category comes from the map and defaults to Spot', () => {
  const map = new Map([['sangeethe sponsorship', 'Value Addition'], ['15s spot', 'Spot']]);
  assert.equal(categoryForTheme('Sangeethe Sponsorship', map), 'Value Addition');
  assert.equal(categoryForTheme('15s Spot', map), 'Spot');
  // Unmapped themes are treated as plain spots, never dropped.
  assert.equal(categoryForTheme('Some New Theme', map), 'Spot');
  assert.equal(categoryForTheme('', map), 'Spot');
});
