import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKET_ASSETS,
  MARKET_ASSET_IDS,
  allocatePercentages,
  calculateMarketMetrics,
  computeDominance,
  createMarketFrame,
  deriveMarketEvents,
  createSyntheticMarketHistory,
  SyntheticMarketDriver,
} from './index.js';

const expectedIds = ['btc', 'eth', 'bnb', 'sol', 'xrp'];
const expectedSymbols = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT'];
const expectedContractIds = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];

function observations(overrides = {}) {
  return MARKET_ASSETS.map((asset, index) => ({
    id: asset.id,
    price: asset.demo.startPrice,
    returnPct: index * 0.1,
    momentumPct: index * 0.05,
    volatilityPct: 0.1 + (index * 0.01),
    ...(overrides[asset.id] || {}),
  }));
}

test('canonical basket contains the five requested instruments in stable order', () => {
  assert.deepEqual(MARKET_ASSET_IDS, expectedIds);
  assert.deepEqual(MARKET_ASSETS.map((asset) => asset.symbol), expectedSymbols);
  assert.deepEqual(MARKET_ASSETS.map((asset) => asset.contractId), expectedContractIds);
  assert.equal(new Set(MARKET_ASSET_IDS).size, MARKET_ASSET_IDS.length);
  assert.ok(MARKET_ASSETS.every((asset) => asset.symbol === `${asset.base}/${asset.quote}`));
  assert.ok(MARKET_ASSETS.every((asset) => asset.unit.includes(asset.quote)));
  assert.ok(MARKET_ASSETS.every((asset) => Object.isFrozen(asset.visual)));
});

test('market metrics are percentage-based and invariant to absolute price scale', () => {
  const options = { returnLookback: 3, momentumLookback: 1, volatilityLookback: 3 };
  const first = calculateMarketMetrics([100, 102, 101, 105], options);
  const scaled = calculateMarketMetrics([2.5, 2.55, 2.525, 2.625], options);
  assert.deepEqual(first, scaled);
  assert.equal(first.returnPct, 5);
  assert.ok(Math.abs(first.momentumPct - 3.96039604) < 1e-8);
  assert.ok(first.volatilityPct > 0);
});

test('largest-remainder allocation is stable and closes at exactly 100%', () => {
  assert.deepEqual(allocatePercentages([0, 0, 0]), [33.34, 33.33, 33.33]);
  const allocated = allocatePercentages([1, 2, 3, 4, 5, 6]);
  assert.equal(Math.round(allocated.reduce((sum, value) => sum + value, 0) * 100), 10_000);
  assert.deepEqual(allocated, allocatePercentages([1, 2, 3, 4, 5, 6]));
});

test('dominance rewards relative return without comparing raw prices or momentum', () => {
  const result = computeDominance([
    { id: 'btc', returnPct: 2, momentumPct: 1.2, volatilityPct: 0.3 },
    { id: 'eth', returnPct: 0.2, momentumPct: 0.1, volatilityPct: 0.3 },
    { id: 'bnb', returnPct: -1.5, momentumPct: -0.9, volatilityPct: 0.3 },
  ]);
  const byId = Object.fromEntries(result.map((item) => [item.id, item]));
  assert.equal(byId.btc.rank, 1);
  assert.equal(byId.bnb.rank, 3);
  assert.ok(byId.btc.dominancePct > byId.eth.dominancePct);
  assert.ok(byId.eth.dominancePct > byId.bnb.dominancePct);
  assert.equal(Math.round(result.reduce((sum, item) => sum + item.dominancePct, 0) * 100), 10_000);
});

test('flat metrics produce a balanced deterministic arena', () => {
  const result = computeDominance(expectedIds.map((id) => ({ id })));
  assert.deepEqual(result.map((item) => item.dominancePct), [20, 20, 20, 20, 20]);
  assert.deepEqual(result.map((item) => item.rank), [1, 1, 1, 1, 1]);
});

test('ROUND demo territory resets at battle start while context windows remain rolling', () => {
  const exactHour = Date.UTC(2026, 7, 19, 15);
  const startAt = exactHour - (70 * 60_000);
  const round = createSyntheticMarketHistory({
    seed: 'round-reset-boundary',
    pointCount: 91,
    intervalMs: 60_000,
    startAt,
    window: 'ROUND',
    shocks: [],
  });
  const context = createSyntheticMarketHistory({
    seed: 'round-reset-boundary',
    pointCount: 91,
    intervalMs: 60_000,
    startAt,
    window: '1H',
    shocks: [],
  });
  const beforeIndex = (exactHour - (20 * 60_000) - 60_000 - startAt) / 60_000;
  const resetIndex = beforeIndex + 1;
  const before = round.frames[beforeIndex];
  const reset = round.frames[resetIndex];
  assert.notEqual(before.epoch.displayEpoch.epochId, reset.epoch.displayEpoch.epochId);
  assert.equal(reset.epoch.displayPhase, 'BATTLE_LIVE');
  assert.ok(reset.assets.every((asset) => asset.returnPct === 0));
  assert.ok(reset.assets.every((asset) => asset.dominancePct === 20));
  assert.ok(context.frames[resetIndex].assets.some((asset) => asset.returnPct !== 0));
  assert.equal('epoch' in context.frames[resetIndex], false);
});

test('ROUND demo rejects non-minute sampling that cannot represent canonical boundaries', () => {
  assert.throws(() => createSyntheticMarketHistory({ window: 'ROUND', intervalMs: 30_000 }), /one-minute/);
});

test('MarketFrame exposes continuous circular geometry and exact dominance', () => {
  const frame = createMarketFrame({
    timestamp: 1_800_000_000_000,
    sequence: 7,
    elapsedMs: 420_000,
    source: 'test',
    observations: observations({ btc: { returnPct: 2, momentumPct: 1 } }),
  });
  assert.equal(frame.schema, 'market-frame/v1');
  assert.deepEqual(frame.assets.map((asset) => asset.id), expectedIds);
  assert.equal(frame.totalDominancePct, 100);
  assert.equal(frame.leader.id, 'btc');
  assert.equal(frame.market.fresh, true);
  for (let index = 1; index < frame.assets.length; index += 1) {
    assert.ok(Math.abs(frame.assets[index - 1].visual.endAngle - frame.assets[index].visual.startAngle) < 1e-7);
  }
  const totalArc = frame.assets.reduce((sum, asset) => sum + asset.visual.arcRadians, 0);
  assert.ok(Math.abs(totalArc - (Math.PI * 2)) < 1e-6);
});

test('MarketFrame preserves stream quality and genuine observation freshness metadata', () => {
  const sourceTimestampUs = '1800000000200000';
  const feedUpdateTimestampUs = '1800000000100000';
  const frame = createMarketFrame({
    timestamp: 1_800_000_000_200,
    source: 'binance-spot',
    status: 'mixed',
    quality: 'exchange-stream',
    transport: 'sse',
    streamConnected: true,
    sourceTimestampUs,
    displayCadenceMs: 200,
    observations: observations({
      btc: {
        updatedAt: 1_800_000_000_100,
        sourceTimestampUs,
        feedUpdateTimestampUs,
        marketSession: 'closed',
        carriedForward: true,
        freshness: 'carried-forward',
      },
      eth: {
        updatedAt: 1_800_000_000_200,
        sourceTimestampUs,
        feedUpdateTimestampUs: sourceTimestampUs,
        marketSession: 'regular',
        freshness: 'live',
      },
    }),
  });
  const btc = frame.assets.find((asset) => asset.id === 'btc');
  assert.equal(btc.marketSession, 'closed');
  assert.equal(btc.carriedForward, true);
  assert.equal(btc.sourceTimestampUs, sourceTimestampUs);
  assert.equal(btc.feedUpdateTimestampUs, feedUpdateTimestampUs);
  assert.equal(btc.freshness, 'carried-forward');
  assert.equal(btc.updatedAt, 1_800_000_000_100);
  assert.equal(frame.market.status, 'mixed');
  assert.equal(frame.market.quality, 'exchange-stream');
  assert.equal(frame.market.transport, 'sse');
  assert.equal(frame.market.streamConnected, true);
  assert.equal(frame.market.sourceTimestampUs, sourceTimestampUs);
  assert.equal(frame.market.displayCadenceMs, 200);
  assert.deepEqual(frame.market.carriedForwardAssetIds, ['btc']);
  assert.deepEqual(frame.market.closedAssetIds, ['btc']);
  assert.equal(frame.market.allCarriedForwardOrClosed, false);
  assert.equal(frame.market.fresh, true);
});

test('MarketFrame distinguishes an expected closed market from a stale feed', () => {
  const closed = createMarketFrame({
    timestamp: 1_800_000_000_000,
    source: 'binance-spot',
    status: 'closed',
    quality: 'exchange-stream',
    observations: observations(Object.fromEntries(expectedIds.map((id) => [id, {
      marketSession: 'closed',
      carriedForward: true,
      updatedAt: 1_799_990_000_000,
    }]))),
  });
  assert.equal(closed.market.allCarriedForwardOrClosed, true);
  assert.equal(closed.market.fresh, true);
  assert.deepEqual(closed.market.carriedForwardAssetIds, expectedIds);

  const stale = createMarketFrame({
    timestamp: 1_800_000_000_000,
    source: 'binance-spot',
    status: 'open',
    quality: 'degraded',
    observations: observations({ btc: { stale: true, marketSession: 'regular' } }),
  });
  assert.equal(stale.market.allCarriedForwardOrClosed, false);
  assert.equal(stale.market.fresh, false);
  assert.deepEqual(stale.market.staleAssetIds, ['btc']);
});

test('successive MarketFrames expose territory deltas without changing sector order', () => {
  const first = createMarketFrame({ timestamp: 1_800_000_000_000, observations: observations() });
  const second = createMarketFrame({
    timestamp: 1_800_000_060_000,
    sequence: 1,
    elapsedMs: 60_000,
    previousFrame: first,
    observations: observations({ btc: { returnPct: 3, momentumPct: 2 } }),
  });
  assert.deepEqual(second.assets.map((asset) => asset.id), first.assets.map((asset) => asset.id));
  assert.ok(second.assets.find((asset) => asset.id === 'btc').deltaDominancePct > 0);
  assert.ok(second.assets.find((asset) => asset.id === 'btc').visual.pulse > 0);
});

test('momentum changes flow only and volatility changes turbulence only', () => {
  const uniform = Object.fromEntries(expectedIds.map((id) => [id, {
    returnPct: 0,
    momentumPct: 0,
    volatilityPct: 0.1,
  }]));
  const baseline = createMarketFrame({
    timestamp: 1_800_000_000_000,
    observations: observations(uniform),
  });
  const momentum = createMarketFrame({
    timestamp: 1_800_000_001_000,
    observations: observations({ ...uniform, btc: { returnPct: 0, momentumPct: 5, volatilityPct: 0.1 } }),
  });
  const volatile = createMarketFrame({
    timestamp: 1_800_000_002_000,
    observations: observations({ ...uniform, btc: { returnPct: 0, momentumPct: 0, volatilityPct: 5 } }),
  });
  const asset = (frame, id = 'btc') => frame.assets.find((entry) => entry.id === id);

  assert.deepEqual(momentum.dominance, baseline.dominance);
  assert.deepEqual(volatile.dominance, baseline.dominance);
  assert.notEqual(asset(momentum).visual.flow, asset(baseline).visual.flow);
  assert.equal(asset(momentum).visual.turbulence, asset(baseline).visual.turbulence);
  assert.equal(asset(momentum).visual.radius, asset(baseline).visual.radius);
  assert.notEqual(asset(volatile).visual.turbulence, asset(baseline).visual.turbulence);
  assert.equal(asset(volatile).visual.flow, asset(baseline).visual.flow);
  assert.equal(asset(volatile).visual.radius, asset(baseline).visual.radius);
});

test('event derivation detects leader changes, breakouts and dominance shockwaves', () => {
  const first = createMarketFrame({
    timestamp: 1_800_000_000_000,
    observations: observations({ btc: { returnPct: 2, momentumPct: 0.2 } }),
  });
  const second = createMarketFrame({
    timestamp: 1_800_000_060_000,
    sequence: 1,
    elapsedMs: 60_000,
    previousFrame: first,
    observations: observations({
      btc: { returnPct: -2, momentumPct: -1.2 },
      eth: { returnPct: 4, momentumPct: 2, volatilityPct: 0.7 },
    }),
  });
  const events = deriveMarketEvents(first, second, {
    dominanceShiftPct: 1,
    breakoutMomentumPct: 0.5,
    volatilitySpikePct: 0.2,
    volatilityMultiplier: 1.2,
  });
  assert.ok(events.some((event) => event.kind === 'leader_change' && event.assetId === 'eth'));
  assert.ok(events.some((event) => event.kind === 'breakout' && event.assetId === 'eth'));
  assert.ok(events.some((event) => event.kind === 'shockwave'));
  assert.ok(events.every((event) => event.schema === 'market-event/v1'));
});

test('synthetic history is deterministic, serializable and always totals 100%', () => {
  const options = {
    seed: 'test-seed',
    pointCount: 72,
    intervalMs: 30_000,
    startAt: '2026-02-01T00:00:00.000Z',
  };
  const first = createSyntheticMarketHistory(options);
  const repeated = createSyntheticMarketHistory(options);
  const different = createSyntheticMarketHistory({ ...options, seed: 'different-seed' });
  assert.deepEqual(repeated, first);
  assert.notDeepEqual(different.frames[20], first.frames[20]);
  assert.equal(first.frames.length, 72);
  assert.ok(first.events.length > 1);
  assert.equal(first.events[0].kind, 'session_start');
  assert.ok(first.frames.every((frame) => frame.totalDominancePct === 100));
  assert.ok(first.frames.every((frame) => frame.assets.every((asset) => asset.price > 0)));
  assert.doesNotThrow(() => JSON.stringify(first));
});

test('synthetic driver replays frames/events, honours pause, speed and completion', () => {
  const history = createSyntheticMarketHistory({ seed: 'driver', pointCount: 4 });
  const frames = [];
  const events = [];
  const driver = new SyntheticMarketDriver({
    history,
    onFrame: (frame) => frames.push(frame.sequence),
    onEvent: (event) => events.push(event.kind),
    autoStart: false,
    loop: false,
  });
  driver.tick();
  assert.deepEqual(frames, [0]);
  assert.deepEqual(events, ['session_start']);
  driver.setPaused(true);
  assert.equal(driver.tick(), null);
  assert.deepEqual(frames, [0]);
  driver.setPaused(false);
  driver.setSpeed(2);
  driver.tick();
  assert.deepEqual(frames, [0, 1, 2]);
  driver.tick();
  assert.deepEqual(frames, [0, 1, 2, 3]);
  assert.equal(driver.finished, true);
  driver.destroy();
});

test('invalid prices, duplicate ids and negative volatility fail loudly', () => {
  assert.throws(() => calculateMarketMetrics([100, 0]), /positive finite/);
  assert.throws(() => computeDominance([{ id: 'btc' }, { id: 'btc' }]), /duplicate/);
  assert.throws(() => computeDominance([{ id: 'btc', volatilityPct: -1 }]), /cannot be negative/);
  assert.throws(() => createMarketFrame({ observations: observations({ btc: { price: 0 } }) }), /greater than zero/);
  assert.throws(() => createMarketFrame({
    observations: observations({ btc: { sourceTimestampUs: 'not-a-timestamp' } }),
  }), /sourceTimestampUs/);
});
