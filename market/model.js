import { MARKET_ASSETS, resolveMarketAssets } from './assets.js';
import { calculateMarketMetrics, computeDominance } from './dominance.js';
import { EPOCH_PHASE, MINUTE_MS, arenaEpochState } from './epoch-schedule.js';

const TAU = Math.PI * 2;
const DEFAULT_START_ANGLE = -Math.PI / 2;
const DEFAULT_START_AT = Date.UTC(2026, 0, 5, 8, 0, 0);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 8) => Number(value.toFixed(digits));

/**
 * @typedef {Object} MarketAssetFrame
 * @property {string} id Stable asset id.
 * @property {string} symbol Human-readable market symbol.
 * @property {number} price Latest positive quote.
 * @property {number} returnPct Percentage change over the configured window.
 * @property {number} momentumPct Shorter-term percentage change.
 * @property {number} volatilityPct Standard deviation of interval returns.
 * @property {number} dominancePct Exact allocated share of the 100% arena.
 * @property {number} deltaDominancePct Change from the prior frame.
 * @property {number} rank Cross-sectional strength rank (1 is strongest).
 * @property {'rising'|'falling'|'steady'} trend Directional render hint.
 * @property {string|null} marketSession Source market-session classification.
 * @property {boolean} carriedForward Whether the quote was carried from an earlier update.
 * @property {string} [sourceTimestampUs] Source packet timestamp in microseconds.
 * @property {Object} visual Circular-sector geometry and liquid motion hints.
 */

/**
 * Framework-agnostic frame consumed by a circular renderer.
 *
 * @typedef {Object} MarketFrame
 * @property {'market-frame/v1'} schema
 * @property {number} sequence Monotonic frame number.
 * @property {number} timestamp Unix epoch milliseconds.
 * @property {number} elapsedMs Time since the history/session began.
 * @property {string} window Metric window label, e.g. `1H`.
 * @property {MarketAssetFrame[]} assets Stable-order circular territories.
 * @property {Record<string, number>} dominance Asset id to percentage mapping.
 * @property {number} totalDominancePct Always 100 at configured precision.
 * @property {Object} leader Current strongest territory.
 * @property {Object} market Source, quality and freshness metadata.
 */

/**
 * Discrete render/cinematic event derived from MarketFrames.
 *
 * @typedef {Object} MarketEvent
 * @property {'market-event/v1'} schema
 * @property {string} id Deterministic event id.
 * @property {string} kind `session_start`, `leader_change`, `shockwave`,
 * `breakout`, or `volatility_spike`.
 * @property {number} frameSequence Frame where the event occurred.
 * @property {number} timestamp Unix epoch milliseconds.
 * @property {string|null} assetId Primary affected asset.
 * @property {'up'|'down'|'neutral'} direction
 * @property {'low'|'medium'|'high'} severity
 * @property {string} title Short UI-safe event title.
 * @property {Object} data Numeric details; safe to inspect or serialize.
 */

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

function timestampOf(value, label = 'timestamp') {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') value = Date.parse(value);
  const timestamp = finiteNumber(value, label);
  if (timestamp < 0) throw new RangeError(`${label} cannot be negative`);
  return timestamp;
}

function optionalTimestampUs(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe non-negative integer`);
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new TypeError(`${label} must be a non-negative integer`);
  return text;
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function observationsById(observations) {
  if (Array.isArray(observations)) {
    const entries = observations.map((observation, index) => {
      if (!observation || typeof observation.id !== 'string') {
        throw new TypeError(`observations[${index}].id must be a string`);
      }
      return [observation.id, observation];
    });
    const result = new Map(entries);
    if (result.size !== entries.length) throw new RangeError('observations contain duplicate asset ids');
    return result;
  }
  if (observations && typeof observations === 'object') {
    return new Map(Object.entries(observations).map(([id, observation]) => [id, { id, ...observation }]));
  }
  throw new TypeError('observations must be an array or object keyed by asset id');
}

function eventId(frame, kind, assetId, ordinal) {
  return `${frame.timestamp}:${frame.sequence}:${kind}:${assetId || 'market'}:${ordinal}`;
}

function severityFor(value, medium, high) {
  const magnitude = Math.abs(value);
  if (magnitude >= high) return 'high';
  if (magnitude >= medium) return 'medium';
  return 'low';
}

/** Build one immutable MarketFrame from same-timestamp asset observations. */
export function createMarketFrame({
  timestamp = Date.now(),
  elapsedMs = 0,
  sequence = 0,
  window = '1H',
  source = 'unknown',
  status = 'open',
  quality = source === 'synthetic' ? 'simulated' : 'unverified',
  transport = null,
  streamConnected = null,
  sourceTimestampUs = null,
  channel = null,
  displayCadenceMs = null,
  observations,
  assets = MARKET_ASSETS,
  previousFrame = null,
  scoring,
  startAngle = DEFAULT_START_ANGLE,
  epochState = null,
} = {}) {
  const at = timestampOf(timestamp);
  const elapsed = finiteNumber(elapsedMs, 'elapsedMs');
  if (elapsed < 0) throw new RangeError('elapsedMs cannot be negative');
  positiveInteger(sequence, 'sequence', { allowZero: true });
  if (typeof window !== 'string' || window.length === 0) throw new TypeError('window must be a non-empty string');
  const arenaStart = finiteNumber(startAngle, 'startAngle');
  const frameSourceTimestampUs = optionalTimestampUs(sourceTimestampUs, 'sourceTimestampUs');
  const frameTransport = optionalString(transport, 'transport');
  const frameChannel = optionalString(channel, 'channel');
  const cadence = displayCadenceMs === null || displayCadenceMs === undefined
    ? null
    : finiteNumber(displayCadenceMs, 'displayCadenceMs');
  if (cadence !== null && cadence <= 0) throw new RangeError('displayCadenceMs must be greater than zero');
  if (streamConnected !== null && streamConnected !== undefined && typeof streamConnected !== 'boolean') {
    throw new TypeError('streamConnected must be a boolean');
  }
  const resolvedAssets = resolveMarketAssets(assets);
  const byId = observationsById(observations);
  const previousById = new Map((previousFrame?.assets || []).map((asset) => [asset.id, asset]));

  const normalized = resolvedAssets.map((asset) => {
    const observation = byId.get(asset.id);
    if (!observation) throw new RangeError(`missing observation for asset: ${asset.id}`);
    const price = finiteNumber(observation.price, `${asset.id}.price`);
    if (price <= 0) throw new RangeError(`${asset.id}.price must be greater than zero`);
    const volatilityPct = finiteNumber(observation.volatilityPct ?? 0, `${asset.id}.volatilityPct`);
    if (volatilityPct < 0) throw new RangeError(`${asset.id}.volatilityPct cannot be negative`);
    const observationSourceTimestampUs = optionalTimestampUs(
      observation.sourceTimestampUs,
      `${asset.id}.sourceTimestampUs`,
    );
    const feedUpdateTimestampUs = optionalTimestampUs(
      observation.feedUpdateTimestampUs,
      `${asset.id}.feedUpdateTimestampUs`,
    );
    const feedUpdatedAt = feedUpdateTimestampUs === null
      ? at
      : Number(BigInt(feedUpdateTimestampUs) / 1000n);
    const marketSession = optionalString(observation.marketSession, `${asset.id}.marketSession`);
    const freshness = optionalString(observation.freshness, `${asset.id}.freshness`);
    const roundObservation = observation.round === undefined || observation.round === null
      ? null
      : observation.round;
    if (roundObservation !== null && (typeof roundObservation !== 'object' || Array.isArray(roundObservation))) {
      throw new TypeError(`${asset.id}.round must be an object`);
    }
    return {
      ...observation,
      id: asset.id,
      price,
      returnPct: finiteNumber(observation.returnPct ?? 0, `${asset.id}.returnPct`),
      momentumPct: finiteNumber(observation.momentumPct ?? 0, `${asset.id}.momentumPct`),
      volatilityPct,
      updatedAt: timestampOf(observation.updatedAt ?? feedUpdatedAt, `${asset.id}.updatedAt`),
      stale: observation.stale === true,
      marketSession,
      carriedForward: observation.carriedForward === true,
      freshness,
      sourceTimestampUs: observationSourceTimestampUs,
      feedUpdateTimestampUs,
      round: roundObservation,
    };
  });

  const scores = computeDominance(normalized, scoring);
  const scoreById = new Map(scores.map((score) => [score.id, score]));
  const meanDominance = 100 / resolvedAssets.length;
  let cursor = arenaStart;

  const frameAssets = resolvedAssets.map((asset, index) => {
    const observation = normalized[index];
    const score = scoreById.get(asset.id);
    const previous = previousById.get(asset.id);
    const arcRadians = index === resolvedAssets.length - 1
      ? (arenaStart + TAU) - cursor
      : TAU * (score.dominancePct / 100);
    const endAngle = cursor + arcRadians;
    const momentumDirection = observation.momentumPct > 0.005
      ? 'rising'
      : observation.momentumPct < -0.005 ? 'falling' : 'steady';
    const deltaDominancePct = score.dominancePct - (previous?.dominancePct ?? score.dominancePct);
    const relativeTerritory = score.dominancePct / meanDominance;
    const visualMeta = asset.visual || {};
    const visual = Object.freeze({
      startAngle: round(cursor),
      endAngle: round(endAngle),
      midAngle: round(cursor + (arcRadians / 2)),
      arcRadians: round(arcRadians),
      radius: round(clamp(0.72 + (relativeTerritory * 0.28), 0.76, 1.14), 4),
      turbulence: round(clamp(0.42 + (score.components.volatility * 0.16), 0.08, 0.96), 4),
      flow: round(Math.tanh(observation.momentumPct / 0.45), 4),
      pulse: round(clamp(Math.abs(deltaDominancePct) / 4, 0, 1), 4),
      viscosity: finiteNumber(visualMeta.viscosity ?? 0.5, `${asset.id}.visual.viscosity`),
      primary: visualMeta.primary || '#8aa0b5',
      secondary: visualMeta.secondary || '#d5e0ea',
      shadow: visualMeta.shadow || '#293746',
      material: visualMeta.material || 'liquid',
    });
    cursor = endAngle;

    return Object.freeze({
      id: asset.id,
      symbol: asset.symbol || asset.id.toUpperCase(),
      ticker: asset.ticker || asset.id.toUpperCase(),
      name: asset.name || asset.id,
      shortName: asset.shortName || asset.name || asset.id,
      assetClass: asset.assetClass || 'other',
      unit: asset.unit || '',
      priceDecimals: Number.isInteger(asset.priceDecimals) ? asset.priceDecimals : 2,
      price: observation.price,
      returnPct: observation.returnPct,
      momentumPct: observation.momentumPct,
      volatilityPct: observation.volatilityPct,
      dominancePct: score.dominancePct,
      deltaDominancePct: round(deltaDominancePct, 4),
      compositeScore: score.compositeScore,
      normalizedStrength: score.normalizedStrength,
      components: score.components,
      rank: score.rank,
      lowRank: score.lowRank,
      trend: momentumDirection,
      stale: observation.stale,
      updatedAt: observation.updatedAt,
      marketSession: observation.marketSession,
      carriedForward: observation.carriedForward,
      ...(observation.freshness === null ? {} : { freshness: observation.freshness }),
      ...(observation.sourceTimestampUs === null ? {} : { sourceTimestampUs: observation.sourceTimestampUs }),
      ...(observation.feedUpdateTimestampUs === null ? {} : { feedUpdateTimestampUs: observation.feedUpdateTimestampUs }),
      ...(observation.round === null ? {} : { round: Object.freeze({ ...observation.round }) }),
      visual,
    });
  });

  const ranked = [...frameAssets].sort((a, b) => (a.rank - b.rank) || a.id.localeCompare(b.id));
  const leader = ranked[0];
  const highReturn = Math.max(...frameAssets.map((asset) => asset.returnPct));
  const lowReturn = Math.min(...frameAssets.map((asset) => asset.returnPct));
  const returnLeaders = Object.freeze({
    high: Object.freeze(frameAssets.filter((asset) => asset.returnPct === highReturn).map((asset) => asset.id)),
    low: Object.freeze(frameAssets.filter((asset) => asset.returnPct === lowReturn).map((asset) => asset.id)),
    highReturnPct: highReturn,
    lowReturnPct: lowReturn,
  });
  const resolvedEpochState = epochState ?? (window === 'ROUND' ? arenaEpochState(at) : null);
  if (resolvedEpochState !== null
    && (!resolvedEpochState || resolvedEpochState.schema !== 'arena-epoch-state/v1')) {
    throw new TypeError('epochState must be an arena-epoch-state/v1 object');
  }
  const dominance = Object.freeze(Object.fromEntries(frameAssets.map((asset) => [asset.id, asset.dominancePct])));
  const totalDominancePct = round(frameAssets.reduce((sum, asset) => sum + asset.dominancePct, 0), 6);
  const staleAssetIds = Object.freeze(frameAssets.filter((asset) => asset.stale).map((asset) => asset.id));
  const carriedForwardAssetIds = Object.freeze(frameAssets.filter((asset) => asset.carriedForward).map((asset) => asset.id));
  const closedAssetIds = Object.freeze(frameAssets
    .filter((asset) => asset.marketSession?.toLowerCase() === 'closed')
    .map((asset) => asset.id));
  const allCarriedForwardOrClosed = frameAssets.length > 0 && frameAssets.every((asset) => (
    asset.carriedForward || asset.marketSession?.toLowerCase() === 'closed'
  ));

  return Object.freeze({
    schema: 'market-frame/v1',
    sequence,
    timestamp: at,
    elapsedMs: elapsed,
    window,
    assets: Object.freeze(frameAssets),
    dominance,
    totalDominancePct,
    returnLeaders,
    ...(resolvedEpochState === null ? {} : { epoch: resolvedEpochState }),
    leader: Object.freeze({
      id: leader.id,
      symbol: leader.symbol,
      dominancePct: leader.dominancePct,
      marginPct: round(leader.dominancePct - (ranked[1]?.dominancePct ?? 0), 4),
    }),
    market: Object.freeze({
      source,
      status,
      quality,
      synthetic: source === 'synthetic',
      staleAssetIds,
      carriedForwardAssetIds,
      closedAssetIds,
      allCarriedForwardOrClosed,
      fresh: staleAssetIds.length === 0,
      ...(frameTransport === null ? {} : { transport: frameTransport }),
      ...(streamConnected === null || streamConnected === undefined ? {} : { streamConnected }),
      ...(frameSourceTimestampUs === null ? {} : { sourceTimestampUs: frameSourceTimestampUs }),
      ...(frameChannel === null ? {} : { channel: frameChannel }),
      ...(cadence === null ? {} : { displayCadenceMs: cadence }),
    }),
  });
}

/** Derive discrete MarketEvents by comparing two consecutive frames. */
export function deriveMarketEvents(previousFrame, frame, {
  dominanceShiftPct = 2.5,
  breakoutMomentumPct = 0.55,
  volatilitySpikePct = 0.16,
  volatilityMultiplier = 1.6,
} = {}) {
  if (!frame || frame.schema !== 'market-frame/v1') throw new TypeError('frame must be a MarketFrame');
  const thresholds = {
    dominanceShiftPct: finiteNumber(dominanceShiftPct, 'dominanceShiftPct'),
    breakoutMomentumPct: finiteNumber(breakoutMomentumPct, 'breakoutMomentumPct'),
    volatilitySpikePct: finiteNumber(volatilitySpikePct, 'volatilitySpikePct'),
    volatilityMultiplier: finiteNumber(volatilityMultiplier, 'volatilityMultiplier'),
  };
  if (Object.values(thresholds).some((value) => value < 0)) throw new RangeError('event thresholds cannot be negative');

  const events = [];
  const add = (kind, assetId, direction, severity, title, data = {}) => {
    events.push(Object.freeze({
      schema: 'market-event/v1',
      id: eventId(frame, kind, assetId, events.length),
      kind,
      frameSequence: frame.sequence,
      timestamp: frame.timestamp,
      elapsedMs: frame.elapsedMs,
      assetId,
      direction,
      severity,
      title,
      data: Object.freeze({ ...data }),
    }));
  };

  if (!previousFrame) {
    add('session_start', frame.leader.id, 'neutral', 'low', 'Market arena opened', {
      leaderId: frame.leader.id,
      dominancePct: frame.leader.dominancePct,
    });
    return Object.freeze(events);
  }
  if (previousFrame.schema !== 'market-frame/v1') throw new TypeError('previousFrame must be a MarketFrame');

  const previousById = new Map(previousFrame.assets.map((asset) => [asset.id, asset]));
  if (previousFrame.leader.id !== frame.leader.id) {
    add('leader_change', frame.leader.id, 'up', 'high', `${frame.leader.symbol} takes the lead`, {
      fromAssetId: previousFrame.leader.id,
      toAssetId: frame.leader.id,
      dominancePct: frame.leader.dominancePct,
      marginPct: frame.leader.marginPct,
    });
  }

  for (const asset of frame.assets) {
    const previous = previousById.get(asset.id);
    if (!previous) continue;
    const dominanceDelta = asset.dominancePct - previous.dominancePct;
    if (Math.abs(dominanceDelta) >= thresholds.dominanceShiftPct) {
      const direction = dominanceDelta > 0 ? 'up' : 'down';
      add('shockwave', asset.id, direction, severityFor(dominanceDelta, 3.5, 6),
        `${asset.symbol} territory ${direction === 'up' ? 'surges' : 'recedes'}`, {
          fromDominancePct: previous.dominancePct,
          toDominancePct: asset.dominancePct,
          deltaDominancePct: round(dominanceDelta, 4),
        });
    }

    const wasBreakout = Math.abs(previous.momentumPct) >= thresholds.breakoutMomentumPct;
    const isBreakout = Math.abs(asset.momentumPct) >= thresholds.breakoutMomentumPct;
    if (!wasBreakout && isBreakout) {
      const direction = asset.momentumPct > 0 ? 'up' : 'down';
      add('breakout', asset.id, direction, severityFor(asset.momentumPct, 0.8, 1.35),
        `${asset.symbol} ${direction === 'up' ? 'breaks higher' : 'breaks lower'}`, {
          momentumPct: asset.momentumPct,
          returnPct: asset.returnPct,
        });
    }

    const priorVolatility = Math.max(previous.volatilityPct, 1e-9);
    if (
      asset.volatilityPct >= thresholds.volatilitySpikePct
      && asset.volatilityPct >= priorVolatility * thresholds.volatilityMultiplier
    ) {
      add('volatility_spike', asset.id, 'neutral', severityFor(asset.volatilityPct, 0.3, 0.55),
        `${asset.symbol} turbulence spikes`, {
          fromVolatilityPct: previous.volatilityPct,
          toVolatilityPct: asset.volatilityPct,
          multiplier: round(asset.volatilityPct / priorVolatility, 4),
        });
    }
  }
  return Object.freeze(events);
}

function hashSeed(seed) {
  const input = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  // Box-Muller with a protected lower bound so log(0) is impossible.
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

function defaultShockSchedule(pointCount) {
  if (pointCount < 8) return [];
  const at = (fraction) => clamp(Math.round((pointCount - 1) * fraction), 2, pointCount - 1);
  return [
    { index: at(0.22), impulses: { btc: 0.008, eth: 0.012, bnb: 0.006, sol: 0.016, xrp: 0.009 } },
    { index: at(0.48), impulses: { btc: -0.009, eth: -0.013, bnb: -0.006, sol: -0.018, xrp: -0.011 } },
    { index: at(0.72), impulses: { btc: 0.006, eth: 0.009, bnb: 0.004, sol: 0.014, xrp: 0.012 } },
  ];
}

function validateShocks(shocks, pointCount, assetIds) {
  if (!Array.isArray(shocks)) throw new TypeError('shocks must be an array');
  const knownIds = new Set(assetIds);
  return shocks.map((shock, index) => {
    if (!shock || typeof shock !== 'object') throw new TypeError(`shocks[${index}] must be an object`);
    positiveInteger(shock.index, `shocks[${index}].index`, { allowZero: true });
    if (shock.index >= pointCount) throw new RangeError(`shocks[${index}].index is outside the history`);
    if (!shock.impulses || typeof shock.impulses !== 'object') {
      throw new TypeError(`shocks[${index}].impulses must be an object`);
    }
    const impulses = {};
    for (const [assetId, impulse] of Object.entries(shock.impulses)) {
      if (!knownIds.has(assetId)) throw new RangeError(`shock references unknown asset: ${assetId}`);
      impulses[assetId] = finiteNumber(impulse, `shocks[${index}].impulses.${assetId}`);
    }
    return { index: shock.index, impulses };
  });
}

/**
 * Generate deterministic, offline demo frames and events.
 *
 * Synthetic anchors are illustrative and are never presented as live prices.
 * The same seed and options always yield byte-for-byte equivalent data.
 */
export function createSyntheticMarketHistory({
  seed = 'liquidity-arena-v1',
  pointCount = 180,
  points,
  intervalMs = 60_000,
  startAt = DEFAULT_START_AT,
  window = '1H',
  assets = MARKET_ASSETS,
  returnLookback = 24,
  momentumLookback = 6,
  volatilityLookback = 18,
  scoring,
  eventThresholds,
  shocks,
} = {}) {
  const count = points ?? pointCount;
  positiveInteger(count, 'pointCount');
  positiveInteger(intervalMs, 'intervalMs');
  const startTimestamp = timestampOf(startAt, 'startAt');
  if (window === 'ROUND' && intervalMs !== MINUTE_MS) {
    throw new RangeError('ROUND demo history requires exact one-minute observations');
  }
  const resolvedAssets = resolveMarketAssets(assets);
  const assetIds = resolvedAssets.map((asset) => asset.id);
  const shockSchedule = validateShocks(shocks ?? defaultShockSchedule(count), count, assetIds);
  const shocksByIndex = new Map();
  for (const shock of shockSchedule) {
    const current = shocksByIndex.get(shock.index) || {};
    for (const [assetId, impulse] of Object.entries(shock.impulses)) {
      current[assetId] = (current[assetId] || 0) + impulse;
    }
    shocksByIndex.set(shock.index, current);
  }

  const random = mulberry32(hashSeed(seed));
  const priceHistory = new Map();
  for (const [index, asset] of resolvedAssets.entries()) {
    const startPrice = finiteNumber(asset.demo?.startPrice ?? (100 + (index * 10)), `${asset.id}.demo.startPrice`);
    if (startPrice <= 0) throw new RangeError(`${asset.id}.demo.startPrice must be positive`);
    priceHistory.set(asset.id, [startPrice]);
  }

  const frames = [];
  const events = [];
  let previousFrame = null;

  for (let sequence = 0; sequence < count; sequence += 1) {
    if (sequence > 0) {
      const macro = gaussian(random) * 0.00042;
      const quoteMarket = gaussian(random) * 0.00026;
      const impulses = shocksByIndex.get(sequence) || {};
      for (const [assetIndex, asset] of resolvedAssets.entries()) {
        const history = priceHistory.get(asset.id);
        const previousPrice = history[history.length - 1];
        const volatility = finiteNumber(asset.demo?.volatility ?? 0.001, `${asset.id}.demo.volatility`);
        const beta = finiteNumber(asset.demo?.macroBeta ?? 0, `${asset.id}.demo.macroBeta`);
        const phase = finiteNumber(asset.demo?.phase ?? assetIndex, `${asset.id}.demo.phase`);
        const cycle = Math.sin((sequence / 13) + phase) * volatility * 0.16;
        const slowCycle = Math.cos((sequence / 31) + (phase * 0.7)) * volatility * 0.08;
        const idiosyncratic = gaussian(random) * volatility;
        const quoteMarketEffect = quoteMarket * 0.12;
        const logReturn = (macro * beta) + quoteMarketEffect + cycle + slowCycle + idiosyncratic + (impulses[asset.id] || 0);
        history.push(round(previousPrice * Math.exp(logReturn), asset.priceDecimals ?? 6));
      }
    }

    const timestamp = startTimestamp + (sequence * intervalMs);
    const epochState = window === 'ROUND' ? arenaEpochState(timestamp) : null;
    const observations = resolvedAssets.map((asset) => {
      const prices = priceHistory.get(asset.id);
      const rolling = calculateMarketMetrics(prices, { returnLookback, momentumLookback, volatilityLookback });
      if (window === 'ROUND') {
        const epoch = epochState.displayEpoch;
        const baselineIndex = (epoch.battleStartMs - startTimestamp) / intervalMs;
        const endpointIndex = ((epoch.battleEndMs - MINUTE_MS) - startTimestamp) / intervalMs;
        const hasBaseline = Number.isInteger(baselineIndex) && baselineIndex >= 0 && baselineIndex < prices.length;
        const battleLive = epochState.displayPhase === EPOCH_PHASE.BATTLE_LIVE;
        const completed = [EPOCH_PHASE.EVIDENCE_GRACE, EPOCH_PHASE.AWAITING_RESOLUTION]
          .includes(epochState.displayPhase);
        const hasEndpoint = Number.isInteger(endpointIndex) && endpointIndex >= 0 && endpointIndex < prices.length;
        const targetIndex = battleLive ? prices.length - 1 : (completed && hasEndpoint ? endpointIndex : null);
        const evidenceStatus = !hasBaseline
          ? 'BASELINE_UNAVAILABLE'
          : battleLive
            ? 'LIVE_ESTIMATE'
            : completed && hasEndpoint
              ? 'COMPLETED_CANDLE_PROVISIONAL'
              : 'AWAITING_END_CANDLE';
        const returnPct = hasBaseline && targetIndex !== null
          ? ((prices[targetIndex] / prices[baselineIndex]) - 1) * 100
          : 0;
        return {
          id: asset.id,
          price: targetIndex === null ? prices.at(-1) : prices[targetIndex],
          ...rolling,
          returnPct,
          round: {
            epochId: epoch.epochId,
            phase: epochState.displayPhase,
            operationalPhase: epochState.operationalPhase,
            battleStartMs: epoch.battleStartMs,
            battleEndMs: epoch.battleEndMs,
            baselineOpenTimeMs: hasBaseline ? epoch.battleStartMs : null,
            baselinePrice: hasBaseline ? prices[baselineIndex] : null,
            endpointOpenTimeMs: completed && hasEndpoint ? epoch.battleEndMs - MINUTE_MS : null,
            endpointPrice: completed && hasEndpoint ? prices[endpointIndex] : null,
            evidenceStatus,
            provisional: true,
          },
          updatedAt: timestamp,
        };
      }
      return {
        id: asset.id,
        price: prices[prices.length - 1],
        ...rolling,
        updatedAt: timestamp,
      };
    });
    const frame = createMarketFrame({
      timestamp,
      elapsedMs: sequence * intervalMs,
      sequence,
      window,
      source: 'synthetic',
      status: 'open',
      quality: 'simulated',
      observations,
      assets: resolvedAssets,
      previousFrame,
      scoring,
      epochState,
    });
    frames.push(frame);
    events.push(...deriveMarketEvents(previousFrame, frame, eventThresholds));
    previousFrame = frame;
  }

  return Object.freeze({
    frames: Object.freeze(frames),
    events: Object.freeze(events),
    meta: Object.freeze({
      source: 'synthetic',
      simulated: true,
      seed: String(seed),
      pointCount: count,
      intervalMs,
      startAt: startTimestamp,
      endAt: startTimestamp + ((count - 1) * intervalMs),
      window,
      assetIds: Object.freeze(assetIds),
      metricLookbacks: Object.freeze({ return: returnLookback, momentum: momentumLookback, volatility: volatilityLookback }),
      disclaimer: 'Synthetic demonstration data — not a live market quote.',
    }),
  });
}

/**
 * Small playback adapter matching the app's callback-driver style. It replays a
 * precomputed deterministic history and never performs network I/O.
 */
export class SyntheticMarketDriver {
  constructor({
    onFrame = () => {},
    onEvent = () => {},
    history,
    tickMs = 500,
    speed = 1,
    loop = true,
    autoStart = true,
    ...historyOptions
  } = {}) {
    if (typeof onFrame !== 'function' || typeof onEvent !== 'function') {
      throw new TypeError('onFrame and onEvent must be functions');
    }
    positiveInteger(tickMs, 'tickMs');
    this.onFrame = onFrame;
    this.onEvent = onEvent;
    this.history = history || createSyntheticMarketHistory(historyOptions);
    if (!Array.isArray(this.history.frames) || !Array.isArray(this.history.events) || this.history.frames.length === 0) {
      throw new TypeError('history must contain non-empty frames and an events array');
    }
    this.tickMs = tickMs;
    this.loop = Boolean(loop);
    this.speed = 1;
    this.setSpeed(speed);
    this.paused = false;
    this.finished = false;
    this.index = -1;
    this._stepCredit = 0;
    this._timer = null;
    this._eventsByFrame = new Map();
    for (const event of this.history.events) {
      const list = this._eventsByFrame.get(event.frameSequence) || [];
      list.push(event);
      this._eventsByFrame.set(event.frameSequence, list);
    }
    if (autoStart) this.start();
  }

  start() {
    if (this._timer || this.finished) return this;
    this._timer = setInterval(() => this.tick(), this.tickMs);
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  destroy() {
    this.stop();
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
  }

  setSpeed(speed) {
    const value = finiteNumber(speed, 'speed');
    if (value <= 0) throw new RangeError('speed must be greater than zero');
    this.speed = value;
  }

  reset() {
    this.index = -1;
    this._stepCredit = 0;
    this.finished = false;
    return this;
  }

  seek(index, { emit = true } = {}) {
    positiveInteger(index, 'index', { allowZero: true });
    if (index >= this.history.frames.length) throw new RangeError('seek index is outside the history');
    this.index = index;
    this._stepCredit = 0;
    this.finished = false;
    if (emit) this._emitIndex(index);
    return this.history.frames[index];
  }

  _emitIndex(index) {
    const frame = this.history.frames[index];
    this.onFrame(frame);
    for (const event of this._eventsByFrame.get(frame.sequence) || []) this.onEvent(event);
  }

  tick() {
    if (this.paused || this.finished) return null;
    this._stepCredit += this.speed;
    let latest = null;
    while (this._stepCredit >= 1 && !this.finished) {
      this._stepCredit -= 1;
      let nextIndex = this.index + 1;
      if (nextIndex >= this.history.frames.length) {
        if (!this.loop) {
          this.finished = true;
          this.stop();
          break;
        }
        nextIndex = 0;
      }
      this.index = nextIndex;
      this._emitIndex(nextIndex);
      latest = this.history.frames[nextIndex];
    }
    return latest;
  }
}
