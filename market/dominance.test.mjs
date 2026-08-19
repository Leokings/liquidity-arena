import assert from 'node:assert/strict';
import test from 'node:test';

import { computeDominance, MINIMUM_TERRITORY_PCT } from './dominance.js';

function observations(overrides = {}) {
  return ['btc', 'eth', 'bnb', 'sol', 'xrp'].map((id, index) => ({
    id,
    returnPct: index - 2,
    momentumPct: overrides.momentum?.[index] ?? 0,
    volatilityPct: overrides.volatility?.[index] ?? 0,
  }));
}

test('territory is return-only, totals 100%, and reserves five percent per asset', () => {
  const scores = computeDominance(observations({
    momentum: [999, 500, 0, -500, -999],
    volatility: [900, 700, 500, 300, 100],
  }));
  assert.equal(scores.reduce((sum, score) => sum + score.dominancePct, 0), 100);
  assert.ok(scores.every((score) => score.dominancePct >= MINIMUM_TERRITORY_PCT));
  for (let index = 1; index < scores.length; index += 1) {
    assert.ok(scores[index].dominancePct > scores[index - 1].dominancePct);
  }
});

test('momentum and volatility cannot alter territory or HIGH/LOW rank', () => {
  const calm = computeDominance(observations());
  const turbulent = computeDominance(observations({
    momentum: [10_000, -8_000, 6_000, -4_000, 2_000],
    volatility: [1, 20, 3, 40, 5],
  }));
  assert.deepEqual(
    turbulent.map(({ dominancePct, rank, lowRank }) => ({ dominancePct, rank, lowRank })),
    calm.map(({ dominancePct, rank, lowRank }) => ({ dominancePct, rank, lowRank })),
  );
});

test('equal returns produce equal territory and tied competition ranks', () => {
  const equal = computeDominance(observations().map((entry) => ({ ...entry, returnPct: 0 })));
  assert.deepEqual(equal.map((entry) => entry.dominancePct), [20, 20, 20, 20, 20]);
  assert.deepEqual(equal.map((entry) => entry.rank), [1, 1, 1, 1, 1]);
  assert.deepEqual(equal.map((entry) => entry.lowRank), [1, 1, 1, 1, 1]);
});

test('invalid visible floors and negative volatility fail closed', () => {
  assert.throws(() => computeDominance(observations(), { minimumPct: 20 }), /positive distributable/);
  assert.throws(
    () => computeDominance(observations().map((entry, index) => ({ ...entry, volatilityPct: index ? 0 : -1 }))),
    /cannot be negative/,
  );
});
