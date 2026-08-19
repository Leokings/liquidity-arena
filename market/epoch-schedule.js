const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const EVIDENCE_GRACE_MS = 120 * SECOND_MS;

export const EPOCH_PHASE = Object.freeze({
  UPCOMING: 'UPCOMING',
  BUFFER: 'BUFFER',
  WAGERING: 'WAGERING',
  BATTLE_LIVE: 'BATTLE_LIVE',
  EVIDENCE_GRACE: 'EVIDENCE_GRACE',
  AWAITING_RESOLUTION: 'AWAITING_RESOLUTION',
});

function timestampMs(value, label = 'timestamp') {
  if (value instanceof Date) value = value.getTime();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative epoch-millisecond integer`);
  }
  return number;
}

function exactHour(value, label = 'epoch end') {
  const timestamp = timestampMs(value, label);
  if (timestamp % HOUR_MS !== 0) throw new RangeError(`${label} must be an exact UTC hour`);
  return timestamp;
}

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

export function epochIdForEnd(epochEndMs) {
  const end = new Date(exactHour(epochEndMs));
  return `UTC-${end.getUTCFullYear()}${twoDigits(end.getUTCMonth() + 1)}${twoDigits(end.getUTCDate())}`
    + `-${twoDigits(end.getUTCHours())}00`;
}

export function createEpoch(epochEndMs) {
  const endMs = exactHour(epochEndMs);
  return Object.freeze({
    schema: 'epoch/v1',
    epochId: epochIdForEnd(endMs),
    endMs,
    cycleStartMs: endMs - HOUR_MS,
    wagerOpenMs: endMs - (40 * MINUTE_MS),
    wagerCloseMs: endMs - (20 * MINUTE_MS),
    battleStartMs: endMs - (20 * MINUTE_MS),
    battleEndMs: endMs,
    evidenceAvailableMs: endMs + EVIDENCE_GRACE_MS,
  });
}

export function phaseForEpoch(epochOrEnd, atMs = Date.now()) {
  const epoch = typeof epochOrEnd === 'object' && epochOrEnd !== null
    ? epochOrEnd
    : createEpoch(epochOrEnd);
  const now = timestampMs(atMs, 'phase timestamp');
  if (now < epoch.cycleStartMs) return EPOCH_PHASE.UPCOMING;
  if (now < epoch.wagerOpenMs) return EPOCH_PHASE.BUFFER;
  if (now < epoch.wagerCloseMs) return EPOCH_PHASE.WAGERING;
  if (now < epoch.battleEndMs) return EPOCH_PHASE.BATTLE_LIVE;
  if (now < epoch.evidenceAvailableMs) return EPOCH_PHASE.EVIDENCE_GRACE;
  return EPOCH_PHASE.AWAITING_RESOLUTION;
}

export function phaseCountdown(epochOrEnd, atMs = Date.now()) {
  const epoch = typeof epochOrEnd === 'object' && epochOrEnd !== null
    ? epochOrEnd
    : createEpoch(epochOrEnd);
  const now = timestampMs(atMs, 'countdown timestamp');
  const phase = phaseForEpoch(epoch, now);
  const transitions = {
    [EPOCH_PHASE.UPCOMING]: [epoch.cycleStartMs, 'BUFFER'],
    [EPOCH_PHASE.BUFFER]: [epoch.wagerOpenMs, 'WAGERING OPENS'],
    [EPOCH_PHASE.WAGERING]: [epoch.wagerCloseMs, 'BATTLE STARTS'],
    [EPOCH_PHASE.BATTLE_LIVE]: [epoch.battleEndMs, 'BATTLE ENDS'],
    [EPOCH_PHASE.EVIDENCE_GRACE]: [epoch.evidenceAvailableMs, 'EVIDENCE GRACE ENDS'],
    [EPOCH_PHASE.AWAITING_RESOLUTION]: [null, 'AWAITING RESOLUTION'],
  };
  const [transitionMs, label] = transitions[phase];
  return Object.freeze({
    phase,
    label,
    transitionMs,
    secondsRemaining: transitionMs === null ? null : Math.max(0, Math.ceil((transitionMs - now) / SECOND_MS)),
  });
}

/**
 * Return the concurrently relevant schedule at a wall-clock instant.
 *
 * The just-ended epoch stays on the ROUND map throughout BUFFER and WAGERING.
 * The map switches to the operational epoch exactly when BATTLE_LIVE starts,
 * so the visible territory reset cannot happen early. The operational epoch
 * and countdown remain available separately while wagers would be open.
 */
export function arenaEpochState(atMs = Date.now()) {
  const now = timestampMs(atMs);
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const previousEpoch = createEpoch(hourStart);
  const operationalEpoch = createEpoch(hourStart + HOUR_MS);
  const operationalCountdown = phaseCountdown(operationalEpoch, now);
  const displayEpoch = operationalCountdown.phase === EPOCH_PHASE.BATTLE_LIVE
    ? operationalEpoch
    : previousEpoch;
  const displayCountdown = phaseCountdown(displayEpoch, now);
  return Object.freeze({
    schema: 'arena-epoch-state/v1',
    nowMs: now,
    previousEpoch,
    operationalEpoch,
    operationalPhase: operationalCountdown.phase,
    operationalCountdown,
    displayEpoch,
    displayPhase: displayCountdown.phase,
    displayCountdown,
  });
}

export function epochsForUtcDay(day = Date.now()) {
  const value = timestampMs(day, 'UTC day timestamp');
  const date = new Date(value);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Object.freeze(Array.from({ length: 24 }, (_, index) => createEpoch(
    dayStart + ((index + 1) * HOUR_MS),
  )));
}

export {
  EVIDENCE_GRACE_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
};
