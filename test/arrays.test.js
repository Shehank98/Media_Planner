import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushAll } from '../src/util/arrays.js';

test('pushAll appends without the spread stack-overflow ceiling', () => {
  // `target.push(...source)` throws "Maximum call stack size exceeded" well
  // before this size; a media watch or adex upload is routinely this large,
  // which is what turned an upload into a 500. pushAll must not have that limit.
  const target = [];
  const source = Array.from({ length: 200_000 }, (_, i) => i);
  assert.doesNotThrow(() => pushAll(target, source));
  assert.equal(target.length, 200_000);
  assert.equal(target[0], 0);
  assert.equal(target[199_999], 199_999);
});

test('pushAll onto a non-empty target keeps order', () => {
  const target = ['a', 'b'];
  pushAll(target, ['c', 'd']);
  assert.deepEqual(target, ['a', 'b', 'c', 'd']);
});

test('pushAll tolerates a null or empty source', () => {
  const target = [1];
  pushAll(target, null);
  pushAll(target, []);
  assert.deepEqual(target, [1]);
});
