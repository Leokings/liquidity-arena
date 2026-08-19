import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAttoToGen, parseGenToAtto } from './gen-units.js';

test('parses canonical GEN decimal strings into exact attoGEN bigints', () => {
  assert.equal(parseGenToAtto('0'), 0n);
  assert.equal(parseGenToAtto('1'), 1_000_000_000_000_000_000n);
  assert.equal(parseGenToAtto('1.23'), 1_230_000_000_000_000_000n);
  assert.equal(parseGenToAtto('1.230000000000000001'), 1_230_000_000_000_000_001n);
  assert.equal(parseGenToAtto('0.000000000000000001'), 1n);
  assert.equal(parseGenToAtto('42.000000000000000000'), 42_000_000_000_000_000_000n);
});

test('can require a strictly positive GEN amount', () => {
  assert.throws(() => parseGenToAtto('0', { rejectZero: true }), /greater than zero/);
  assert.throws(() => parseGenToAtto('0.000', { rejectZero: true }), /greater than zero/);
  assert.equal(parseGenToAtto('0.000000000000000001', { rejectZero: true }), 1n);
});

test('rejects ambiguous, signed, exponential, and non-string GEN input', () => {
  for (const invalid of [
    '', ' ', ' 1', '1 ', '+1', '-1', '1e3', '1E3', '1,000', '.5', '1.',
    '01', '00.1', '1_000', 'NaN', 'Infinity',
  ]) {
    assert.throws(() => parseGenToAtto(invalid), /GEN amount/);
  }
  for (const invalid of [1, 1n, null, undefined, {}, []]) {
    assert.throws(() => parseGenToAtto(invalid), /decimal string/);
  }
  assert.throws(() => parseGenToAtto('1', { rejectZero: 'yes' }), /boolean/);
});

test('rejects GEN precision beyond 18 decimals', () => {
  assert.throws(
    () => parseGenToAtto('0.0000000000000000001'),
    /more than 18 decimal places/,
  );
});

test('formats attoGEN as an exact canonical decimal by default', () => {
  assert.equal(formatAttoToGen(0n), '0');
  assert.equal(formatAttoToGen(1n), '0.000000000000000001');
  assert.equal(formatAttoToGen(1_000_000_000_000_000_000n), '1');
  assert.equal(formatAttoToGen(1_230_000_000_000_000_000n), '1.23');
  assert.equal(formatAttoToGen(42_000_000_000_000_000_001n), '42.000000000000000001');
});

test('supports bounded display precision with deterministic half-up rounding', () => {
  const amount = 1_234_567_890_000_000_000n;
  assert.equal(formatAttoToGen(amount, { maximumFractionDigits: 4 }), '1.2346');
  assert.equal(formatAttoToGen(amount, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }), '1.2346');
  assert.equal(formatAttoToGen(1_200_000_000_000_000_000n, {
    minimumFractionDigits: 4,
  }), '1.2000');
  assert.equal(formatAttoToGen(1_999_000_000_000_000_000n, {
    maximumFractionDigits: 2,
  }), '2');
  assert.equal(formatAttoToGen(500_000_000_000_000_000n, {
    maximumFractionDigits: 0,
  }), '1');
});

test('rejects unsafe attoGEN values and formatting options', () => {
  assert.throws(() => formatAttoToGen('1'), /bigint/);
  assert.throws(() => formatAttoToGen(1), /bigint/);
  assert.throws(() => formatAttoToGen(-1n), /cannot be negative/);
  assert.throws(() => formatAttoToGen(1n, null), /options must be an object/);
  assert.throws(() => formatAttoToGen(1n, { maximumFractionDigits: 19 }), /integer from 0 to 18/);
  assert.throws(() => formatAttoToGen(1n, { minimumFractionDigits: 3.5 }), /integer from 0 to 18/);
  assert.throws(
    () => formatAttoToGen(1n, { minimumFractionDigits: 3, maximumFractionDigits: 2 }),
    /cannot exceed/,
  );
});

test('exact formatting round-trips through the strict parser', () => {
  for (const atto of [
    0n,
    1n,
    100_000_000_000_000_000n,
    1_000_000_000_000_000_001n,
    123_456_789_012_345_678_901_234_567_890n,
  ]) {
    assert.equal(parseGenToAtto(formatAttoToGen(atto)), atto);
  }
});
