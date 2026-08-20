import { MARKET_ASSETS, createMarketFrame } from './index.js';
import { arenaEpochState } from './epoch-schedule.js';
import { PROTOCOL_V6, PROTOCOL_V7 } from './deployment-registry.js';

const TERMINAL_ROUND_STATUSES = new Set(['RESOLVED', 'UNDETERMINED', 'TIMED_OUT']);
const PPB_PER_PERCENT = 10_000_000;

function exactEpochEndSeconds(value, label) {
  const epochEnd = Number(value);
  if (!Number.isSafeInteger(epochEnd) || epochEnd <= 0 || epochEnd % 3_600 !== 0) {
    throw new RangeError(`${label} must be a positive exact-hour Unix timestamp.`);
  }
  return epochEnd;
}

/**
 * Select the independently useful arena epochs at a wall-clock instant.
 *
 * The action epoch is where wagers/claims are read and written. The display
 * epoch is the ROUND scoreboard held on screen through BUFFER and WAGERING.
 * An explicit historical epoch intentionally targets both roles so its claim
 * controls and finalized visualization describe the same on-chain record.
 */
export function selectRoundTargets({
  nowMs = Date.now(),
  explicitEpochEndTimestamp = null,
} = {}) {
  const schedule = arenaEpochState(nowMs);
  if (explicitEpochEndTimestamp !== null) {
    const explicit = exactEpochEndSeconds(explicitEpochEndTimestamp, 'explicit epoch');
    return Object.freeze({
      schedule,
      explicit: true,
      actionEpochEndTimestamp: explicit,
      displayEpochEndTimestamp: explicit,
    });
  }
  return Object.freeze({
    schedule,
    explicit: false,
    actionEpochEndTimestamp: Math.floor(schedule.operationalEpoch.battleEndMs / 1_000),
    displayEpochEndTimestamp: Math.floor(schedule.displayEpoch.battleEndMs / 1_000),
  });
}

export function isTerminalRound(round) {
  return Boolean(round && TERMINAL_ROUND_STATUSES.has(String(round.status || '').toUpperCase()));
}

export function roundMatchesDisplayTarget(round, targets) {
  return Boolean(
    round
    && targets
    && Number(round.epochEndTimestamp) === Number(targets.displayEpochEndTimestamp),
  );
}

function normalizedFinalVector(round, assetRecords) {
  if (!round?.epoch || round.epoch.resultStatus !== 'DETERMINED' || !isTerminalRound(round)) {
    return null;
  }
  if (!Array.isArray(assetRecords) || assetRecords.length !== MARKET_ASSETS.length) {
    throw new RangeError('A finalized ROUND map requires all five arena asset records.');
  }

  const byContractId = new Map();
  for (const record of assetRecords) {
    const assetId = String(record?.assetId || '').trim().toUpperCase();
    const returnPpb = Number(record?.returnPpb);
    if (!MARKET_ASSETS.some((asset) => asset.contractId === assetId)) {
      throw new RangeError(`Unsupported finalized asset record: ${assetId || 'empty'}.`);
    }
    if (byContractId.has(assetId)) throw new RangeError(`Duplicate finalized asset record: ${assetId}.`);
    if (!Number.isSafeInteger(returnPpb)) {
      throw new TypeError(`${assetId}.returnPpb must be a safe integer.`);
    }
    byContractId.set(assetId, returnPpb);
  }
  if (MARKET_ASSETS.some((asset) => !byContractId.has(asset.contractId))) {
    throw new RangeError('The finalized arena return vector is incomplete.');
  }

  const returns = MARKET_ASSETS.map((asset) => ({
    assetId: asset.contractId,
    returnPpb: byContractId.get(asset.contractId),
  }));
  const highReturnPpb = Math.max(...returns.map((entry) => entry.returnPpb));
  const lowReturnPpb = Math.min(...returns.map((entry) => entry.returnPpb));
  const highIds = returns.filter((entry) => entry.returnPpb === highReturnPpb).map((entry) => entry.assetId);
  const lowIds = returns.filter((entry) => entry.returnPpb === lowReturnPpb).map((entry) => entry.assetId);
  const highWinnerAssetId = highIds.length === 1 ? highIds[0] : 'TIE';
  const lowWinnerAssetId = lowIds.length === 1 ? lowIds[0] : 'TIE';

  for (const [actual, expected, label] of [
    [round.epoch.highWinnerAssetId, highWinnerAssetId, 'HIGH winner'],
    [round.epoch.lowWinnerAssetId, lowWinnerAssetId, 'LOW winner'],
    [round.epoch.highWinnerReturnPpb, highReturnPpb, 'HIGH return'],
    [round.epoch.lowWinnerReturnPpb, lowReturnPpb, 'LOW return'],
  ]) {
    if (actual !== expected) throw new Error(`Finalized arena ${label} disagrees with its asset vector.`);
  }

  return Object.freeze({
    returns: Object.freeze(returns.map(Object.freeze)),
    byContractId,
    highWinnerAssetId,
    highReturnPpb,
    lowWinnerAssetId,
    lowReturnPpb,
  });
}

/**
 * Returns true only when a cached finalized vector is complete and still
 * agrees with a freshly-read terminal epoch. Callers can then reuse the
 * immutable five-asset return records without suppressing the epoch read
 * that detects an unexpected settlement change.
 */
export function hasVerifiedFinalizedRoundVector(round, assetRecords) {
  try {
    return normalizedFinalVector(round, assetRecords) !== null;
  } catch {
    return false;
  }
}

export function canReuseFinalizedRoundVector(cachedRound, cachedAssetRecords, freshRound) {
  return Number(cachedRound?.epochEndTimestamp) === Number(freshRound?.epochEndTimestamp)
    && hasVerifiedFinalizedRoundVector(freshRound, cachedAssetRecords);
}

/**
 * Rebuild only a ROUND frame from the selected deployment's FINALIZED return vector.
 * Prices remain live display quotes, momentum still controls flow, and
 * volatility still controls turbulence; settlement returns alone control
 * territory and HIGH/LOW rank. Rolling context frames are returned unchanged.
 */
export function reconcileFinalizedRoundFrame(frame, round, assetRecords) {
  if (!frame || frame.schema !== 'market-frame/v1') {
    throw new TypeError('frame must be a MarketFrame.');
  }
  if (frame.window !== 'ROUND') return frame;
  const vector = normalizedFinalVector(round, assetRecords);
  if (!vector) return frame;
  const protocolVersion = String(round.protocolVersion || '').trim().toUpperCase();
  if (protocolVersion !== PROTOCOL_V6 && protocolVersion !== PROTOCOL_V7) {
    throw new Error('Finalized ROUND protocol is not allowlisted.');
  }
  const deploymentAlias = String(round.deploymentAlias || '').trim().toLowerCase();
  if (!['v6', 'v7'].includes(deploymentAlias)) {
    throw new Error('Finalized ROUND deployment alias is not allowlisted.');
  }
  const contractAddress = String(round.contractAddress || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress) || /^0x0{40}$/i.test(contractAddress)) {
    throw new Error('Finalized ROUND contract address is invalid.');
  }

  const observations = frame.assets.map((asset) => {
    const contractId = MARKET_ASSETS.find((candidate) => candidate.id === asset.id)?.contractId;
    if (!contractId || !vector.byContractId.has(contractId)) {
      throw new RangeError(`ROUND frame asset ${asset.id} is not in the arena basket.`);
    }
    return {
      id: asset.id,
      price: asset.price,
      returnPct: vector.byContractId.get(contractId) / PPB_PER_PERCENT,
      momentumPct: asset.momentumPct,
      volatilityPct: asset.volatilityPct,
      updatedAt: asset.updatedAt,
      stale: asset.stale,
      marketSession: asset.marketSession,
      carriedForward: asset.carriedForward,
      freshness: asset.freshness,
      sourceTimestampUs: asset.sourceTimestampUs,
      feedUpdateTimestampUs: asset.feedUpdateTimestampUs,
      round: asset.round,
    };
  });
  const market = frame.market || {};
  const rebuilt = createMarketFrame({
    timestamp: frame.timestamp,
    elapsedMs: frame.elapsedMs,
    sequence: frame.sequence,
    window: frame.window,
    source: market.source,
    status: market.status,
    quality: market.quality,
    transport: market.transport,
    streamConnected: market.streamConnected,
    sourceTimestampUs: market.sourceTimestampUs,
    channel: market.channel,
    displayCadenceMs: market.displayCadenceMs,
    observations,
    previousFrame: frame,
    epochState: frame.epoch || null,
  });
  const settlement = Object.freeze({
    finalized: true,
    source: `GENLAYER_${deploymentAlias.toUpperCase()}_FIVE_VENUE_MEDIAN`,
    protocolVersion,
    deploymentAlias,
    contractAddress,
    epochEndTimestamp: round.epochEndTimestamp,
    venueCount: round.venueCount,
    highWinnerAssetId: vector.highWinnerAssetId,
    highReturnPpb: vector.highReturnPpb,
    lowWinnerAssetId: vector.lowWinnerAssetId,
    lowReturnPpb: vector.lowReturnPpb,
  });
  return Object.freeze({ ...rebuilt, settlement });
}

export { PPB_PER_PERCENT };
