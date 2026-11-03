import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, MAX_CASES, MAX_STORAGE_BYTES, emptyCase, parseProgress, encodeProgress, caseStars, updateProgress, mergeProgress } from '../frontend/arcade-progress.ts';

const seed = 'seed:lost-note';
const job = 'job:6d18b3f942ea45698c972d6763ce3383';
const found = { bugFound: true, targetMet: false, fixedChecked: false, bestMoves: 5 };
const perfect = { bugFound: true, targetMet: true, fixedChecked: true, bestMoves: 3 };
const wrap = cases => JSON.stringify({ version: 1, cases });

test('first run and malformed or unsupported storage are empty', () => {
  assert.equal(STORAGE_KEY, 'bugarcade:progress:v1');
  for (const raw of [null, '', '{', 'null', '[]', 'true', '{"version":2,"cases":{}}', '{"version":"1","cases":{}}', '{"version":1}', '{"version":1,"cases":{},"extra":true}']) {
    assert.deepEqual(parseProgress(raw), {});
  }
});

test('storage roundtrip keeps separate seed and job milestones', () => {
  const record = { [seed]: perfect, [job]: found, 'seed:cleanup': emptyCase };
  assert.deepEqual(parseProgress(encodeProgress(record)), record);
  assert.equal(caseStars(perfect), 3);
  assert.equal(caseStars(found), 1);
  assert.equal(caseStars(emptyCase), 0);
});

test('unknown keys and prototype-shaped keys cannot enter progress', () => {
  const raw = `{"version":1,"cases":{"__proto__":{"polluted":true},"constructor":${JSON.stringify(perfect)},"prototype":${JSON.stringify(perfect)},"seed:unknown":${JSON.stringify(perfect)},"job:not-a-job":${JSON.stringify(perfect)},"${seed}":${JSON.stringify(found)}}}`;
  assert.deepEqual(parseProgress(raw), { [seed]: found });
  assert.equal({}.polluted, undefined);
  for (const key of ['__proto__', 'constructor', 'prototype', 'seed:unknown', 'job:6D18B3F942EA45698C972D6763CE3383']) {
    const original = {};
    assert.equal(updateProgress(original, key, { type: 'bug', moves: 3, target: 3 }), original);
  }
});

test('inconsistent achievements and weakened record shapes are discarded per case', () => {
  const invalid = [
    null, [], {}, true,
    { ...perfect, bugFound: false },
    { ...emptyCase, bestMoves: 1 },
    { ...perfect, bestMoves: null },
    { ...perfect, bestMoves: 0 },
    { ...perfect, bestMoves: 1.5 },
    { ...perfect, bestMoves: 1001 },
    { ...perfect, bestMoves: 13 },
    { ...perfect, fixedChecked: 1 },
    { ...perfect, targetMet: 'true' },
    { ...perfect, extra: 'not supported' },
  ];
  for (const value of invalid) {
    assert.deepEqual(parseProgress(wrap({ [seed]: value, 'seed:search': found })), { 'seed:search': found });
    assert.equal(caseStars(value), 0);
  }
});

test('storage is bounded by both UTF-8 bytes and entry count', () => {
  assert.deepEqual(parseProgress(' '.repeat(MAX_STORAGE_BYTES + 1)), {});
  assert.deepEqual(parseProgress(wrap({ ['😀'.repeat(20000)]: perfect })), {});
  const cases = {};
  for (let index = 0; index <= MAX_CASES; index++) cases[`job:${index.toString(16).padStart(32, '0')}`] = found;
  assert.deepEqual(parseProgress(wrap(cases)), {});
  delete cases[`job:${MAX_CASES.toString(16).padStart(32, '0')}`];
  assert.equal(Object.keys(parseProgress(wrap(cases))).length, MAX_CASES);
});

test('fixed replay before a player bug earns nothing', () => {
  const original = {};
  assert.equal(updateProgress(original, seed, { type: 'fixed' }), original);
  assert.deepEqual(original, {});
});

test('manual bug earns discovery, target is independent, fix earns its own star', () => {
  const original = {};
  const first = updateProgress(original, seed, { type: 'bug', moves: 5, target: 3 });
  assert.deepEqual(first, { [seed]: found });
  assert.deepEqual(original, {});
  const fixed = updateProgress(first, seed, { type: 'fixed' });
  assert.equal(caseStars(fixed[seed]), 2);
  assert.equal(fixed[seed].fixedChecked, true);
  const target = updateProgress(fixed, seed, { type: 'bug', moves: 3, target: 3 });
  assert.deepEqual(target[seed], perfect);
  assert.equal(caseStars(target[seed]), 3);
});

test('best moves only improves; duplicate or slower outcomes preserve identity', () => {
  const original = { [seed]: perfect };
  Object.freeze(original[seed]); Object.freeze(original);
  assert.equal(updateProgress(original, seed, { type: 'bug', moves: 5, target: 3 }), original);
  assert.equal(updateProgress(original, seed, { type: 'bug', moves: 3, target: 3 }), original);
  assert.equal(updateProgress(original, seed, { type: 'fixed' }), original);
  const better = updateProgress(original, seed, { type: 'bug', moves: 2, target: 3 });
  assert.equal(better[seed].bestMoves, 2);
  assert.equal(better[seed].targetMet, true);
  assert.equal(better[seed].fixedChecked, true);
  assert.equal(original[seed].bestMoves, 3);
});

test('invalid events cannot award or alter milestones', () => {
  const original = { [seed]: found };
  const accessor = {};
  Object.defineProperty(accessor, 'type', { enumerable: true, get() { throw new Error('must not execute'); } });
  const invalid = [null, {}, [], { type: 'other' }, { type: 'fixed', extra: true },
    accessor,
    ...[0, -1, 1.2, 1001, Infinity, NaN, '3', null].map(moves => ({ type: 'bug', moves, target: 3 })),
    ...[0, -1, 1.2, 13, Infinity, NaN, '3', null].map(target => ({ type: 'bug', moves: 3, target })),
  ];
  for (const event of invalid) assert.equal(updateProgress(original, seed, event), original);
});

test('codec and merge reject nonplain records and accessor values without invoking them', () => {
  class Fake { constructor() { this[seed] = perfect; } }
  assert.deepEqual(parseProgress(encodeProgress(new Fake())), {});
  const accessor = {};
  Object.defineProperty(accessor, seed, { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.deepEqual(parseProgress(encodeProgress(accessor)), {});
  const nested = { ...perfect };
  Object.defineProperty(nested, 'bestMoves', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.deepEqual(parseProgress(encodeProgress({ [seed]: nested })), {});
  assert.deepEqual(mergeProgress(new Fake(), { [job]: found }), { [job]: found });
});

test('merge preserves independent updates and converges in either order', () => {
  const left = { [seed]: { ...found, fixedChecked: true }, [job]: found };
  const right = { [seed]: { ...found, bestMoves: 3, targetMet: true }, 'seed:cleanup': found };
  const merged = mergeProgress(left, right);
  assert.deepEqual(merged[seed], perfect);
  assert.deepEqual(merged[job], found);
  assert.deepEqual(merged['seed:cleanup'], found);
  assert.deepEqual(merged, mergeProgress(right, left));
  assert.equal(mergeProgress(merged, left), merged);
  assert.equal(mergeProgress(merged, merged), merged);
  assert.equal(mergeProgress(merged, {}), merged);
  assert.equal(left[seed].bestMoves, 5);
  assert.equal(right[seed].fixedChecked, false);
});

test('bounded merges retain arcade cases and select custom jobs deterministically', () => {
  const left = {}, right = {};
  for (let index = 0; index < MAX_CASES; index++) {
    left[`job:${index.toString(16).padStart(32, '0')}`] = found;
    right[`job:${(index + MAX_CASES).toString(16).padStart(32, '0')}`] = found;
  }
  right[seed] = perfect;
  delete right[`job:${(MAX_CASES * 2 - 1).toString(16).padStart(32, '0')}`];
  const merged = mergeProgress(left, right);
  assert.equal(Object.keys(merged).length, MAX_CASES);
  assert.deepEqual(merged[seed], perfect);
  assert.deepEqual(merged, mergeProgress(right, left));
  assert.deepEqual(parseProgress(encodeProgress(merged)), merged);
});
