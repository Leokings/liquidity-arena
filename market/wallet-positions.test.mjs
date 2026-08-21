import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeWalletPositionPage,
  walletClaimTarget,
  walletPositionPageWindow,
  walletPositionPresentation,
} from './wallet-positions.js';

const EPOCH = 1_787_205_600;
const ACCOUNT = '0x63038a310a46ac61a59c1bc5ead5fe41040ef38e';
const DEPLOYMENT = Object.freeze({
  alias: 'v7',
  address: '0xb2ae59aE641f571726Ae81E30080f8c2192b15EF',
  protocolVersion: 'LIQUIDITY_ARENA_V7',
});

function refundPosition(objective, positionIndex) {
  return {
    account: ACCOUNT,
    amount_atto: '1000000000000000000',
    choice_asset_id: 'XRP',
    claimed: false,
    claimed_atto: 0,
    eligible: true,
    epoch_end_timestamp: EPOCH,
    includes_rounding_remainder: false,
    objective,
    position_index: positionIndex,
    settlement_mode: 'REFUND_UNBACKED_WINNER',
    stake_atto: '1000000000000000000',
  };
}

test('two same-epoch objective refunds load in one bounded wallet-position page', () => {
  const request = walletPositionPageWindow({ total: 2, loaded: 0 });
  assert.deepEqual(request, {
    total: 2,
    loaded: 0,
    remaining: 2,
    limit: 2,
    offset: 0,
  });

  const positions = normalizeWalletPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ], DEPLOYMENT);
  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map(({ objective }) => objective), ['HIGH', 'LOW']);
  assert.ok(positions.every(({ epochEndTimestamp }) => epochEndTimestamp === EPOCH));
  assert.ok(positions.every(({ eligible, amountAtto }) => eligible && amountAtto === 10n ** 18n));
  assert.ok(positions.every(({ deploymentAlias }) => deploymentAlias === 'v7'));
});

test('HIGH and LOW refund rows retain distinct deep links and exact claim targets', () => {
  const positions = normalizeWalletPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ], DEPLOYMENT);
  const presentations = positions.map((position) => walletPositionPresentation(
    position,
    DEPLOYMENT,
    'https://liquidity-arena.vercel.app/?deployment=v7&contract=forbidden&feed=demo',
  ));

  for (const presentation of presentations) {
    const url = new URL(presentation.href);
    assert.equal(url.searchParams.get('contract'), null);
    assert.equal(url.searchParams.get('feed'), 'live');
    assert.equal(url.searchParams.get('deployment'), 'v7');
    assert.equal(url.searchParams.get('epoch'), String(EPOCH));
    assert.equal(presentation.status, 'REFUND READY');
    assert.equal(presentation.actionText, 'OPEN & CLAIM');
  }

  assert.equal(new URL(presentations[0].href).searchParams.get('objective'), 'highest');
  assert.deepEqual(presentations[0].claimTarget, { epochEndTimestamp: EPOCH, objective: 'HIGH' });
  assert.equal(new URL(presentations[1].href).searchParams.get('objective'), 'lowest');
  assert.deepEqual(presentations[1].claimTarget, { epochEndTimestamp: EPOCH, objective: 'LOW' });

  assert.deepEqual(walletClaimTarget(positions[0]), presentations[0].claimTarget);
  assert.deepEqual(walletClaimTarget(positions[1]), presentations[1].claimTarget);
  assert.notDeepEqual(presentations[0].claimTarget, presentations[1].claimTarget);
});
