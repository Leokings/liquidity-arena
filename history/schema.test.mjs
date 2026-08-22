import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeHistoryCursor,
  normalizeDeploymentState,
  normalizeEpochState,
  normalizePayoutState,
  parseHistorySyncBody,
  parsePublicHistoryQuery,
} from './schema.mjs';
import {
  TEST_EPOCH,
  TEST_PAYOUT_ID,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testPayout,
  testSchema,
} from './test-fixtures.mjs';

test('public history accepts only V8 and has payout-stage keyset cursors', () => {
  const deployment = testDeployment();
  const cursor = encodeHistoryCursor({
    createdAtTimestamp: String(TEST_EPOCH + 200),
    deploymentId: deployment.deploymentId,
    payoutId: TEST_PAYOUT_ID,
  }, 'payouts', 'v8');
  const parsed = parsePublicHistoryQuery(
    new URL(`https://example.test/api/history?view=payouts&limit=50&cursor=${cursor}`),
  );
  assert.equal(parsed.deployment, 'v8');
  assert.equal(parsed.cursor.payoutId, TEST_PAYOUT_ID);
  assert.throws(() => parsePublicHistoryQuery(new URL('https://x.test/api/history?deployment=v7')), /must be v8/);
  assert.throws(() => parsePublicHistoryQuery(new URL('https://x.test/api/history?limit=51')), /between 1 and 50/);
});

test('sync selection and proof assertions accept only V8 payout semantics', () => {
  const parsed = parseHistorySyncBody({
    deployments: ['v8'],
    proofs: [{ deployment: 'v8', hash: `0x${'b'.repeat(64)}`, kind: 'CLAIM_REQUEST' }],
  });
  assert.deepEqual(parsed.deployments, ['v8']);
  assert.equal(parsed.proofs[0].kind, 'CLAIM_REQUEST');
  assert.throws(() => parseHistorySyncBody({ deployments: ['v7'] }), /must be v8/);
  assert.throws(
    () => parseHistorySyncBody({ proofs: [{ deployment: 'v8', hash: `0x${'b'.repeat(64)}`, kind: 'CLAIM' }] }),
    /unsupported/,
  );
});

test('V8 chain state normalizer requires exact schema/config and preserves epoch digest', () => {
  const deployment = testDeployment();
  const normalized = normalizeDeploymentState({
    deployment,
    config: testConfig(),
    schema: testSchema(),
    epochCount: 1,
    payoutCount: 1,
    manifest: { deploymentTransactionHash: null, sourceMetadata: { artifactMatched: false } },
  });
  assert.equal(normalized.network, 'testnet-bradbury');
  assert.equal(normalized.chainId, 4_221);
  assert.equal(normalized.contractSchemaSha256, 'c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4');
  assert.equal(normalized.payoutCount, 1);
  assert.throws(
    () => normalizeDeploymentState({
      deployment, config: testConfig({ new_risk_enabled: false }), schema: testSchema(), epochCount: 0,
    }),
    /release-exact/,
  );
  const epoch = normalizeEpochState({
    deployment,
    epoch: testDeterminedEpoch(),
    assets: testAssets(),
    syncedAt: '2026-08-22T00:00:00.000Z',
  });
  assert.equal(epoch.snapshot.highWinnerAssetId, 'SOL');
  assert.equal(epoch.finalityMetadata.network, 'testnet-bradbury');
  assert.throws(
    () => normalizeEpochState({
      deployment,
      epoch: { ...testDeterminedEpoch(), status: 'UNDETERMINED', result_status: 'UNDETERMINED' },
      assets: [],
      syncedAt: 'x',
    }),
    /unsupported value/,
  );
});

test('payout normalizer enforces lowercase ID and monotonic stage invariants', () => {
  const deployment = testDeployment();
  const payout = normalizePayoutState({ deployment, payout: testPayout(), syncedAt: 'x' });
  assert.equal(payout.payoutId, TEST_PAYOUT_ID);
  assert.equal(payout.vaultAddress, null);
  assert.equal(payout.walletKey, `${TEST_EPOCH}|HIGH|${payout.recipientAddress}`);
  assert.equal(payout.stakeAtto, '100');
  assert.equal(payout.settlementMode, 'PARIMUTUEL');
  assert.equal(payout.includesRoundingRemainder, false);
  assert.throws(
    () => normalizePayoutState({ deployment, payout: testPayout({ payout_id: `0x${TEST_PAYOUT_ID}` }), syncedAt: 'x' }),
    /lowercase 64-hex without 0x/,
  );
  assert.throws(
    () => normalizePayoutState({ deployment, payout: testPayout({ state: 'FUNDED_IN_ESCROW' }), syncedAt: 'x' }),
    /stage timestamps/,
  );
  assert.throws(
    () => normalizePayoutState({ deployment, payout: testPayout({ wallet_key: 'forged' }), syncedAt: 'x' }),
    /wallet and settlement identity/,
  );
  assert.throws(
    () => normalizePayoutState({
      deployment,
      payout: testPayout({ settlement_mode: 'REFUND_TIE', includes_rounding_remainder: true }),
      syncedAt: 'x',
    }),
    /wallet and settlement identity/,
  );
});

test('fee payouts preserve the V8 fee-withdrawal identity without wallet liability fields', () => {
  const deployment = testDeployment();
  const payout = normalizePayoutState({
    deployment,
    payout: testPayout({
      kind: 'FEE',
      recipient: deployment.expectations.treasury,
      epoch_end_timestamp: 0,
      objective: '',
      wallet_key: '',
      stake_atto: '0',
      settlement_mode: 'FEE_WITHDRAWAL',
      includes_rounding_remainder: false,
    }),
    syncedAt: 'x',
  });
  assert.equal(payout.epochEndTimestamp, null);
  assert.equal(payout.walletKey, '');
  assert.equal(payout.stakeAtto, '0');
  assert.equal(payout.settlementMode, 'FEE_WITHDRAWAL');
  assert.throws(
    () => normalizePayoutState({
      deployment,
      payout: testPayout({
        kind: 'FEE', epoch_end_timestamp: 0, objective: '', wallet_key: '', stake_atto: '0',
        settlement_mode: 'FEE_WITHDRAWAL', includes_rounding_remainder: true,
      }),
      syncedAt: 'x',
    }),
    /wallet and settlement identity/,
  );
});
