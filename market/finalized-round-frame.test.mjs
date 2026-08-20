import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MARKET_ASSETS, createMarketFrame } from './index.js';
import {
  canReuseFinalizedDisplayRound,
  canReuseFinalizedRoundVector,
  hasVerifiedFinalizedRoundVector,
  reconcileFinalizedRoundFrame,
  roundMatchesDisplayTarget,
  selectRoundTargets,
} from './finalized-round-frame.js';

const HOUR = 3_600_000;

function sourceFrame(window = 'ROUND') {
  return createMarketFrame({
    timestamp: Date.UTC(2026, 7, 19, 15, 30),
    elapsedMs: 0,
    sequence: 7,
    window,
    source: 'Binance Spot',
    status: 'live',
    quality: 'verified',
    transport: 'websocket',
    streamConnected: true,
    observations: MARKET_ASSETS.map((asset, index) => ({
      id: asset.id,
      price: asset.demo.startPrice,
      returnPct: 20 - index,
      momentumPct: (index - 2) / 10,
      volatilityPct: 0.1 + (index / 100),
    })),
  });
}

function finalRound(overrides = {}) {
  return {
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    deploymentAlias: 'v6',
    contractAddress: `0x${'6'.repeat(40)}`,
    objective: 'HIGH',
    status: 'RESOLVED',
    epochEndTimestamp: 1_787_155_200,
    venueCount: 5,
    epoch: {
      resultStatus: 'DETERMINED',
      highWinnerAssetId: 'ETH',
      highWinnerReturnPpb: 32_000_000,
      lowWinnerAssetId: 'XRP',
      lowWinnerReturnPpb: -19_000_000,
    },
    ...overrides,
  };
}

const finalAssets = Object.freeze([
  { assetId: 'BTC', returnPpb: 12_000_000 },
  { assetId: 'ETH', returnPpb: 32_000_000 },
  { assetId: 'BNB', returnPpb: 4_000_000 },
  { assetId: 'SOL', returnPpb: -7_000_000 },
  { assetId: 'XRP', returnPpb: -19_000_000 },
]);

test('round target selection keeps the previous scoreboard through wagering', () => {
  const nowMs = Date.UTC(2026, 7, 19, 15, 25);
  const targets = selectRoundTargets({ nowMs });
  assert.equal(targets.actionEpochEndTimestamp, Date.UTC(2026, 7, 19, 16) / 1_000);
  assert.equal(targets.displayEpochEndTimestamp, Date.UTC(2026, 7, 19, 15) / 1_000);
  assert.equal(targets.explicit, false);
});

test('round target selection moves the scoreboard at the exact battle start', () => {
  const battleStart = Date.UTC(2026, 7, 19, 16) - (20 * 60_000);
  const before = selectRoundTargets({ nowMs: battleStart - 1 });
  const at = selectRoundTargets({ nowMs: battleStart });
  assert.equal(before.displayEpochEndTimestamp, Date.UTC(2026, 7, 19, 15) / 1_000);
  assert.equal(at.displayEpochEndTimestamp, Date.UTC(2026, 7, 19, 16) / 1_000);
  assert.equal(roundMatchesDisplayTarget(
    { epochEndTimestamp: before.displayEpochEndTimestamp },
    at,
  ), false);
  assert.equal(roundMatchesDisplayTarget(
    { epochEndTimestamp: at.displayEpochEndTimestamp },
    at,
  ), true);
});

test('explicit historical epoch targets both actions and visualization', () => {
  const explicit = Date.UTC(2026, 7, 18, 9) / 1_000;
  const targets = selectRoundTargets({
    nowMs: Date.UTC(2026, 7, 19, 15, 25),
    explicitEpochEndTimestamp: explicit,
  });
  assert.equal(targets.actionEpochEndTimestamp, explicit);
  assert.equal(targets.displayEpochEndTimestamp, explicit);
  assert.equal(targets.explicit, true);
  assert.throws(() => selectRoundTargets({ explicitEpochEndTimestamp: explicit + 1 }), /exact-hour/);
});

test('finalized V6 vector replaces ROUND returns, leaders and territory only', () => {
  const frame = sourceFrame();
  const reconciled = reconcileFinalizedRoundFrame(frame, finalRound(), finalAssets);
  assert.notEqual(reconciled, frame);
  assert.equal(reconciled.settlement.finalized, true);
  assert.equal(reconciled.settlement.highWinnerAssetId, 'ETH');
  assert.equal(reconciled.settlement.lowWinnerAssetId, 'XRP');
  assert.deepEqual(reconciled.returnLeaders.high, ['eth']);
  assert.deepEqual(reconciled.returnLeaders.low, ['xrp']);
  assert.equal(reconciled.assets.find((asset) => asset.id === 'eth').returnPct, 3.2);
  assert.equal(reconciled.assets.find((asset) => asset.id === 'xrp').returnPct, -1.9);
  assert.equal(reconciled.leader.id, 'eth');
  assert.equal(reconciled.totalDominancePct, 100);
  assert.ok(reconciled.assets.find((asset) => asset.id === 'eth').dominancePct
    > reconciled.assets.find((asset) => asset.id === 'btc').dominancePct);
  for (const asset of reconciled.assets) {
    const original = frame.assets.find((candidate) => candidate.id === asset.id);
    assert.equal(asset.momentumPct, original.momentumPct);
    assert.equal(asset.volatilityPct, original.volatilityPct);
    assert.equal(asset.visual.flow, original.visual.flow);
    assert.equal(asset.visual.turbulence, original.visual.turbulence);
  }
});

test('same epoch can render a contract-qualified V7 settlement without being labeled V6', () => {
  const frame = sourceFrame();
  const round = finalRound({
    protocolVersion: 'LIQUIDITY_ARENA_V7',
    deploymentAlias: 'v7',
    contractAddress: `0x${'7'.repeat(40)}`,
  });
  const result = reconcileFinalizedRoundFrame(frame, round, finalAssets);
  assert.equal(result.settlement.source, 'GENLAYER_V7_FIVE_VENUE_MEDIAN');
  assert.equal(result.settlement.protocolVersion, 'LIQUIDITY_ARENA_V7');
  assert.equal(result.settlement.contractAddress, `0x${'7'.repeat(40)}`);
  assert.throws(
    () => reconcileFinalizedRoundFrame(frame, { ...round, deploymentAlias: 'arbitrary' }, finalAssets),
    /not allowlisted/,
  );
});

test('rolling context never receives hourly settlement returns', () => {
  const frame = sourceFrame('4H');
  assert.equal(reconcileFinalizedRoundFrame(frame, finalRound(), finalAssets), frame);
});

test('finalized reconstruction rejects incomplete or internally inconsistent vectors', () => {
  const frame = sourceFrame();
  assert.throws(
    () => reconcileFinalizedRoundFrame(frame, finalRound(), finalAssets.slice(0, 4)),
    /all five/,
  );
  assert.throws(
    () => reconcileFinalizedRoundFrame(
      frame,
      finalRound({ epoch: { ...finalRound().epoch, highWinnerAssetId: 'BTC' } }),
      finalAssets,
    ),
    /HIGH winner disagrees/,
  );
});

test('only a complete vector that agrees with the fresh terminal epoch is reusable', () => {
  const round = finalRound();
  assert.equal(hasVerifiedFinalizedRoundVector(round, finalAssets), true);
  assert.equal(canReuseFinalizedRoundVector(round, finalAssets, round), true);
  assert.equal(canReuseFinalizedRoundVector(
    round,
    finalAssets,
    finalRound({ epochEndTimestamp: round.epochEndTimestamp + 3_600 }),
  ), false);
  assert.equal(hasVerifiedFinalizedRoundVector(round, finalAssets.slice(0, 4)), false);
  assert.equal(hasVerifiedFinalizedRoundVector(
    finalRound({ epoch: { ...round.epoch, highWinnerAssetId: 'BTC' } }),
    finalAssets,
  ), false);
  assert.equal(hasVerifiedFinalizedRoundVector(
    finalRound({ status: 'OPEN' }),
    finalAssets,
  ), false);
});

test('a complete terminal display round is reusable only for the same view identity', () => {
  const round = finalRound();
  const target = {
    epochEndTimestamp: round.epochEndTimestamp,
    objective: round.objective,
    deploymentAlias: round.deploymentAlias,
    protocolVersion: round.protocolVersion,
    contractAddress: round.contractAddress,
  };
  assert.equal(canReuseFinalizedDisplayRound(round, finalAssets, target), true);
  assert.equal(canReuseFinalizedDisplayRound(round, finalAssets.slice(0, 4), target), false);
  assert.equal(canReuseFinalizedDisplayRound(round, finalAssets, {
    ...target,
    epochEndTimestamp: target.epochEndTimestamp + 3_600,
  }), false);
  assert.equal(canReuseFinalizedDisplayRound(round, finalAssets, {
    ...target,
    objective: 'LOW',
  }), false);
});
