import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearWalletClaimIntentHref,
  normalizeWalletPositionPage,
  reconcileWalletPositionSnapshot,
  WalletPositionRetryError,
  walletClaimTarget,
  walletClaimIntentFromHref,
  walletClaimSummary,
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

function rawPositionPage(positions, {
  account = ACCOUNT,
  offset = 0,
  nextOffset = offset + positions.length,
  total = nextOffset,
} = {}) {
  return {
    account,
    offset,
    next_offset: nextOffset,
    total,
    positions,
  };
}

function normalizedPositions(positions, page = {}) {
  return normalizeWalletPositionPage(rawPositionPage(positions, page), DEPLOYMENT).positions;
}

function assertRetryError(callback, code, { refreshNewest = true } = {}) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof WalletPositionRetryError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, true);
    assert.equal(error.refreshNewest, refreshNewest);
    return true;
  });
}

test('wallet-position pages preserve a frozen verified envelope and row indices', () => {
  const page = normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ]), DEPLOYMENT, {
    account: `0x${ACCOUNT.slice(2).toUpperCase()}`,
    offset: 0,
    limit: 50,
    expectedTotal: 2,
  });

  assert.deepEqual({
    account: page.account,
    offset: page.offset,
    nextOffset: page.nextOffset,
    total: page.total,
  }, {
    account: ACCOUNT,
    offset: 0,
    nextOffset: 2,
    total: 2,
  });
  assert.deepEqual(page.positions.map(({ positionIndex }) => positionIndex), [1, 0]);
  assert.ok(Object.isFrozen(page));
  assert.ok(Object.isFrozen(page.positions));
  assert.ok(page.positions.every(Object.isFrozen));
});

test('wallet-position page validation exposes bounded retry signals for inconsistent reads', () => {
  const otherAccount = '0x1111111111111111111111111111111111111111';
  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
  ], { account: otherAccount }), DEPLOYMENT, { account: ACCOUNT }),
  'WALLET_POSITION_PAGE_ACCOUNT_MISMATCH');

  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 1),
  ], { offset: 1, total: 2 }), DEPLOYMENT, { offset: 0 }),
  'WALLET_POSITION_PAGE_OFFSET_MISMATCH');

  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ], { nextOffset: 1, total: 2 }), DEPLOYMENT), 'WALLET_POSITION_PAGE_CURSOR_MISMATCH');

  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 0),
  ]), DEPLOYMENT), 'WALLET_POSITION_PAGE_DUPLICATE');

  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 2),
  ]), DEPLOYMENT), 'WALLET_POSITION_PAGE_INDEX_MISMATCH');

  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
  ]), DEPLOYMENT, { offset: 0, limit: 2, expectedTotal: 2 }),
  'WALLET_POSITION_PAGE_TOTAL_MISMATCH');

  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
  ], { total: 2 }), DEPLOYMENT, { offset: 0, limit: 2, expectedTotal: 2 }),
  'WALLET_POSITION_PAGE_LIMIT_MISMATCH');
});

test('an insert between the count and page reads requests a newest-page retry', () => {
  assertRetryError(() => normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 1),
    refundPosition('HIGH', 2),
  ], { offset: 1, total: 3 }), DEPLOYMENT, {
    account: ACCOUNT,
    offset: 1,
    limit: 2,
    expectedTotal: 2,
  }), 'WALLET_POSITION_PAGE_TOTAL_MISMATCH');
});

test('two same-epoch objective refunds load in one bounded wallet-position page', () => {
  const request = walletPositionPageWindow({ total: 2, loaded: 0 });
  assert.deepEqual(request, {
    total: 2,
    loaded: 0,
    remaining: 2,
    limit: 2,
    offset: 0,
  });

  const positions = normalizedPositions([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ]);
  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map(({ objective }) => objective), ['HIGH', 'LOW']);
  assert.ok(positions.every(({ epochEndTimestamp }) => epochEndTimestamp === EPOCH));
  assert.ok(positions.every(({ eligible, amountAtto }) => eligible && amountAtto === 10n ** 18n));
  assert.ok(positions.every(({ deploymentAlias }) => deploymentAlias === 'v7'));
});

test('HIGH and LOW refund rows retain distinct deep links and exact claim targets', () => {
  const positions = normalizedPositions([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ]);
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
    assert.equal(url.searchParams.get('claim'), '1');
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

test('claim intent survives a reload for exact HIGH and LOW routes and rejects ambiguous routes', () => {
  for (const [objectiveParam, objective] of [['highest', 'HIGH'], ['lowest', 'LOW']]) {
    assert.deepEqual(walletClaimIntentFromHref(
      `https://liquidity-arena.vercel.app/?deployment=v7&feed=live&epoch=${EPOCH}&objective=${objectiveParam}&claim=1`,
    ), {
      deploymentAlias: 'v7',
      epochEndTimestamp: EPOCH,
      objective,
    });
  }
  assert.equal(walletClaimIntentFromHref(
    `https://liquidity-arena.vercel.app/?deployment=v7&epoch=${EPOCH}&objective=highest`,
  ), null);
  assert.equal(walletClaimIntentFromHref(
    `https://liquidity-arena.vercel.app/?deployment=v7&epoch=${EPOCH + 1}&objective=highest&claim=1`,
  ), null);
  assert.equal(walletClaimIntentFromHref(
    `https://liquidity-arena.vercel.app/?deployment=v7&epoch=${EPOCH}&objective=sideways&claim=1`,
  ), null);
});

test('closing a claim intent preserves the selected deployment, epoch, and objective route', () => {
  const before = `https://liquidity-arena.vercel.app/?feed=live&deployment=v7&epoch=${EPOCH}&objective=lowest&claim=1`;
  const after = new URL(clearWalletClaimIntentHref(before));
  assert.equal(after.searchParams.get('claim'), null);
  assert.equal(after.searchParams.get('deployment'), 'v7');
  assert.equal(after.searchParams.get('epoch'), String(EPOCH));
  assert.equal(after.searchParams.get('objective'), 'lowest');
});

test('claim summary aggregates only eligible unclaimed amounts across HIGH and LOW', () => {
  const positions = normalizedPositions([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
    { ...refundPosition('HIGH', 2), eligible: false, amount_atto: '0' },
    { ...refundPosition('LOW', 3), claimed: true, claimed_atto: '1000000000000000000' },
  ]);
  const summary = walletClaimSummary(positions);
  assert.equal(summary.count, 2);
  assert.equal(summary.amountAtto, 2n * 10n ** 18n);
  assert.equal(summary.refundCount, 2);
  assert.equal(summary.payoutCount, 0);
  assert.deepEqual(summary.positions.map(({ objective }) => objective), ['HIGH', 'LOW']);
});

test('an already claimed eligible row never advertises another claim intent', () => {
  const [position] = normalizedPositions([{
    ...refundPosition('HIGH', 0),
    claimed: true,
    claimed_atto: '1000000000000000000',
  }]);
  const presentation = walletPositionPresentation(
    position,
    DEPLOYMENT,
    'https://liquidity-arena.vercel.app/?deployment=v7&claim=1',
  );
  assert.equal(presentation.status, 'CLAIMED');
  assert.equal(presentation.actionText, 'OPEN EPOCH');
  assert.equal(new URL(presentation.href).searchParams.get('claim'), null);
});

test('a cross-deployment claim explains that reconnecting is required', () => {
  const [position] = normalizedPositions([refundPosition('HIGH', 0)]);
  const presentation = walletPositionPresentation(
    position,
    DEPLOYMENT,
    'https://liquidity-arena.vercel.app/?deployment=v6',
  );
  assert.equal(presentation.actionText, 'OPEN V7 & RECONNECT TO CLAIM');
  assert.equal(new URL(presentation.href).searchParams.get('deployment'), 'v7');
});

test('a failed deployment refresh keeps its last verified positions and count', () => {
  const positions = normalizedPositions([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ]);
  const snapshot = reconcileWalletPositionSnapshot({
    previousPositions: positions,
    previousCount: 2,
    error: new Error('temporary StudioNet failure'),
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.count, 2);
  assert.deepEqual(snapshot.positions, positions);
  assert.match(snapshot.error, /temporary StudioNet failure/);
});

test('a successful retry replaces stale rows while append keeps bounded older rows', () => {
  const currentPage = normalizeWalletPositionPage(rawPositionPage(
    [refundPosition('HIGH', 1)],
    { offset: 1, total: 2 },
  ), DEPLOYMENT);
  const olderPage = normalizeWalletPositionPage(rawPositionPage(
    [refundPosition('LOW', 0)],
    { offset: 0, total: 2 },
  ), DEPLOYMENT);
  const appended = reconcileWalletPositionSnapshot({
    previousPositions: currentPage.positions,
    previousCount: 2,
    nextPage: olderPage,
    observedCount: 2,
    append: true,
  });
  assert.equal(appended.stale, false);
  assert.deepEqual(appended.positions.map(({ objective }) => objective), ['HIGH', 'LOW']);
  const refreshedPage = normalizeWalletPositionPage(rawPositionPage([
    refundPosition('HIGH', 0),
  ]), DEPLOYMENT);
  const refreshed = reconcileWalletPositionSnapshot({
    previousPositions: appended.positions,
    previousCount: 2,
    nextPage: refreshedPage,
    observedCount: 1,
  });
  assert.equal(refreshed.count, 1);
  assert.deepEqual(refreshed.positions.map(({ objective }) => objective), ['HIGH']);
});

test('count growth during append signals a newest-page refresh instead of concatenating', () => {
  const previousPage = normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
    refundPosition('HIGH', 1),
  ]), DEPLOYMENT);
  const racedPage = normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 0),
  ], { total: 3 }), DEPLOYMENT);

  assertRetryError(() => reconcileWalletPositionSnapshot({
    previousPositions: previousPage.positions,
    previousCount: 2,
    nextPage: racedPage,
    observedCount: 3,
    append: true,
  }), 'WALLET_POSITION_COUNT_CHANGED');
});

test('an overlapping boundary position is rejected rather than duplicated', () => {
  const previousPage = normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 2),
    refundPosition('HIGH', 3),
  ], { offset: 2, total: 4 }), DEPLOYMENT);
  const overlappingPage = normalizeWalletPositionPage(rawPositionPage([
    refundPosition('LOW', 2),
  ], { offset: 2, total: 4 }), DEPLOYMENT);

  assertRetryError(() => reconcileWalletPositionSnapshot({
    previousPositions: previousPage.positions,
    previousCount: 4,
    nextPage: overlappingPage,
    observedCount: 4,
    append: true,
  }), 'WALLET_POSITION_PAGE_OVERLAP');
});
