import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeHistoryCursor,
  normalizeDeploymentState,
  normalizeEpochState,
  parseHistorySyncBody,
  parsePublicHistoryQuery,
} from './schema.mjs';
import {
  TEST_EPOCH,
  testAssetCatalog,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testVenueCatalog,
} from './test-fixtures.mjs';

test('public history query is exact, bounded, keyset-cursor scoped, and rejects duplicates', () => {
  const cursor = encodeHistoryCursor({
    epochEndTimestamp: String(TEST_EPOCH),
    deploymentId: testDeployment().deploymentId,
  }, 'epochs', 'v7');
  const parsed = parsePublicHistoryQuery(
    new URL(`https://example.test/api/history?view=epochs&deployment=v7&limit=50&cursor=${cursor}`),
  );
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.cursor.epochEndTimestamp, String(TEST_EPOCH));
  assert.equal(parsed.cursor.deploymentFilter, 'v7');
  assert.throws(
    () => parsePublicHistoryQuery(new URL('https://example.test/api/history?limit=10&limit=20')),
    /unsupported or repeated/,
  );
  assert.throws(
    () => parsePublicHistoryQuery(new URL('https://example.test/api/history?limit=51')),
    /between 1 and 50/,
  );
  assert.throws(
    () => parsePublicHistoryQuery(new URL(`https://example.test/api/history?deployment=v6&cursor=${cursor}`)),
    /does not match/,
  );
});

test('sync request accepts selection only and rejects outcomes, oversize work, duplicates, and standalone children', () => {
  assert.equal(parseHistorySyncBody({}).maxEpochs, 10);
  const parsed = parseHistorySyncBody({
    deployments: ['v7'],
    maxEpochs: 10,
    proofs: [{ deployment: 'v7', hash: `0x${'a'.repeat(64)}`, kind: 'RESOLVE_EPOCH' }],
  });
  assert.deepEqual(parsed.deployments, ['v7']);
  assert.equal(parsed.maxEpochs, 10);
  assert.throws(() => parseHistorySyncBody({ winner: 'BTC' }), /unsupported field winner/);
  assert.throws(() => parseHistorySyncBody({ maxEpochs: 11 }), /between 1 and 10/);
  assert.throws(() => parseHistorySyncBody({ deployments: ['v7', 'v7'] }), /duplicates/);
  assert.throws(
    () => parseHistorySyncBody({ proofs: [{ deployment: 'v7', hash: `0x${'b'.repeat(64)}`, kind: 'TRANSFER_CHILD' }] }),
    /unsupported/,
  );
});

test('chain state normalizer preserves exact atto strings and recomputes vector median, winners, and digest', () => {
  const deployment = testDeployment();
  const normalizedDeployment = normalizeDeploymentState({
    deployment,
    config: testConfig(),
    assetCatalog: testAssetCatalog(),
    venueCatalog: testVenueCatalog(),
    epochCount: 1,
    manifest: { deploymentTransactionHash: null, sourceMetadata: { artifactMatched: false } },
  });
  assert.equal(normalizedDeployment.deploymentId, deployment.deploymentId);
  assert.equal(normalizedDeployment.contractAddress, deployment.addressKey);
  const epoch = normalizeEpochState({
    deployment,
    epoch: testDeterminedEpoch(),
    assets: testAssets(),
    syncedAt: '2026-08-19T18:00:00.000Z',
  });
  assert.equal(epoch.snapshot.assetVector.length, 5);
  assert.equal(epoch.snapshot.highWinnerAssetId, 'SOL');
  assert.equal(epoch.snapshot.lowWinnerAssetId, 'XRP');
  assert.equal(epoch.deploymentId, deployment.deploymentId);
  assert.equal(epoch.contractAddress, deployment.addressKey);
  assert.equal(epoch.sourceMetadata.contractAddress, deployment.addressKey);
  assert.equal(epoch.highObjective.payout_pool_atto, '198');

  const tamperedWinner = { ...testDeterminedEpoch(), high_winner_asset_id: 'BTC' };
  assert.throws(
    () => normalizeEpochState({ deployment, epoch: tamperedWinner, assets: testAssets(), syncedAt: 'x' }),
    /winners do not match/,
  );
  const tamperedVector = testAssets();
  tamperedVector[0] = { ...tamperedVector[0], return_ppb: 999 };
  assert.throws(
    () => normalizeEpochState({ deployment, epoch: testDeterminedEpoch(), assets: tamperedVector, syncedAt: 'x' }),
    /median return is inconsistent/,
  );
  assert.throws(
    () => normalizeEpochState({
      deployment,
      epoch: { ...testDeterminedEpoch(), resolution_digest: 'f'.repeat(64) },
      assets: testAssets(),
      syncedAt: 'x',
    }),
    /digest does not match/,
  );
  assert.throws(
    () => normalizeEpochState({
      deployment,
      epoch: { ...testDeterminedEpoch(), created_at_timestamp: TEST_EPOCH - 3599 },
      assets: testAssets(),
      syncedAt: 'x',
    }),
    /one-hour lead/,
  );
  assert.throws(
    () => normalizeEpochState({
      deployment,
      epoch: { ...testDeterminedEpoch(), resolved_at_timestamp: TEST_EPOCH + 60 },
      assets: testAssets(),
      syncedAt: 'x',
    }),
    /settlement window/,
  );
});
