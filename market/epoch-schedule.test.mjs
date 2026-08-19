import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EPOCH_PHASE,
  arenaEpochState,
  createEpoch,
  epochsForUtcDay,
  phaseCountdown,
  phaseForEpoch,
} from './epoch-schedule.js';

const E = Date.UTC(2026, 7, 19, 15, 0, 0);

test('one immutable UTC epoch exposes the exact 20/20/20 boundaries', () => {
  const epoch = createEpoch(E);
  assert.equal(epoch.epochId, 'UTC-20260819-1500');
  assert.equal(epoch.cycleStartMs, Date.UTC(2026, 7, 19, 14, 0));
  assert.equal(epoch.wagerOpenMs, Date.UTC(2026, 7, 19, 14, 20));
  assert.equal(epoch.wagerCloseMs, Date.UTC(2026, 7, 19, 14, 40));
  assert.equal(epoch.battleStartMs, epoch.wagerCloseMs);
  assert.equal(epoch.battleEndMs, E);
  assert.equal(epoch.evidenceAvailableMs, E + 120_000);
  assert.ok(Object.isFrozen(epoch));
  assert.throws(() => createEpoch(E + 1), /exact UTC hour/);
});

test('phase boundaries are half-open and change at the exact millisecond', () => {
  const epoch = createEpoch(E);
  const cases = [
    [epoch.cycleStartMs - 1, EPOCH_PHASE.UPCOMING],
    [epoch.cycleStartMs, EPOCH_PHASE.BUFFER],
    [epoch.wagerOpenMs - 1, EPOCH_PHASE.BUFFER],
    [epoch.wagerOpenMs, EPOCH_PHASE.WAGERING],
    [epoch.wagerCloseMs - 1, EPOCH_PHASE.WAGERING],
    [epoch.wagerCloseMs, EPOCH_PHASE.BATTLE_LIVE],
    [epoch.battleEndMs - 1, EPOCH_PHASE.BATTLE_LIVE],
    [epoch.battleEndMs, EPOCH_PHASE.EVIDENCE_GRACE],
    [epoch.evidenceAvailableMs - 1, EPOCH_PHASE.EVIDENCE_GRACE],
    [epoch.evidenceAvailableMs, EPOCH_PHASE.AWAITING_RESOLUTION],
  ];
  for (const [at, expected] of cases) assert.equal(phaseForEpoch(epoch, at), expected);
});

test('countdowns target the next exact transition without negative values', () => {
  const epoch = createEpoch(E);
  const wagering = phaseCountdown(epoch, epoch.wagerOpenMs);
  assert.equal(wagering.label, 'BATTLE STARTS');
  assert.equal(wagering.secondsRemaining, 20 * 60);
  const awaiting = phaseCountdown(epoch, epoch.evidenceAvailableMs);
  assert.equal(awaiting.transitionMs, null);
  assert.equal(awaiting.secondsRemaining, null);
});

test('ROUND retains the just-ended epoch until the exact battle-start reset', () => {
  const atHour = arenaEpochState(E);
  assert.equal(atHour.operationalPhase, EPOCH_PHASE.BUFFER);
  assert.equal(atHour.operationalEpoch.endMs, E + 3_600_000);
  assert.equal(atHour.displayEpoch.endMs, E);
  assert.equal(atHour.displayPhase, EPOCH_PHASE.EVIDENCE_GRACE);

  const wagering = arenaEpochState(E + (20 * 60_000));
  assert.equal(wagering.operationalPhase, EPOCH_PHASE.WAGERING);
  assert.equal(wagering.displayEpoch.endMs, E);
  assert.equal(wagering.displayPhase, EPOCH_PHASE.AWAITING_RESOLUTION);

  const beforeBattle = arenaEpochState(E + (40 * 60_000) - 1);
  assert.equal(beforeBattle.displayEpoch.endMs, E);
  const battleStart = arenaEpochState(E + (40 * 60_000));
  assert.equal(battleStart.operationalPhase, EPOCH_PHASE.BATTLE_LIVE);
  assert.equal(battleStart.displayEpoch.endMs, E + 3_600_000);
  assert.equal(battleStart.displayPhase, EPOCH_PHASE.BATTLE_LIVE);
});

test('each UTC day has exactly 24 stable non-overlapping epoch endings', () => {
  const epochs = epochsForUtcDay(Date.UTC(2026, 7, 19, 17, 45));
  assert.equal(epochs.length, 24);
  assert.equal(new Set(epochs.map((epoch) => epoch.epochId)).size, 24);
  assert.equal(epochs[0].endMs, Date.UTC(2026, 7, 19, 1));
  assert.equal(epochs.at(-1).endMs, Date.UTC(2026, 7, 20, 0));
  for (let index = 1; index < epochs.length; index += 1) {
    assert.equal(epochs[index].endMs - epochs[index - 1].endMs, 3_600_000);
  }
});
