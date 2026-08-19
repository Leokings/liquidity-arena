import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHistorySyncBody } from './schema.mjs';
import { createHistorySyncService } from './sync-service.mjs';
import {
  testAssetCatalog,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testVenueCatalog,
} from './test-fixtures.mjs';

function fakeRepository() {
  const state = {
    run: null,
    deployments: [],
    epochs: [],
    proofs: [],
  };
  return {
    configured: true,
    state,
    async claimRun({ keyHash, requestHash }) {
      if (state.run?.requestHash !== requestHash && state.run) return { state: 'CONFLICT' };
      if (state.run?.summary) return { state: 'REPLAY', summary: state.run.summary };
      state.run = { keyHash, requestHash };
      return { state: 'CLAIMED' };
    },
    async completeRun({ summary }) { state.run.summary = summary; },
    async failRun() {},
    async upsertDeployment(value) { state.deployments.push(value); },
    async upsertEpoch(value) { state.epochs.push(value); },
    async getProof(hash) { return state.proofs.find((item) => item.transactionHash === hash) || null; },
    async hasEpoch(deploymentId, epoch) {
      return state.epochs.some((item) => item.deploymentId === deploymentId && item.epochEndTimestamp === epoch);
    },
    async upsertProof(value) { state.proofs.push(value); },
  };
}

function fakeChain({ verifyProof } = {}) {
  const deployment = testDeployment();
  return {
    configuration: {
      network: 'studionet',
      chainId: 61999,
      deployments: [deployment],
    },
    async readDeployment(deploymentId, options) {
      assert.equal(deploymentId, deployment.deploymentId);
      assert.ok(options.maxEpochs <= 10);
      return {
        deployment,
        config: testConfig(),
        assetCatalog: testAssetCatalog(),
        venueCatalog: testVenueCatalog(),
        epochCount: 1,
        epochs: [{ epoch: testDeterminedEpoch(), assets: testAssets() }],
      };
    },
    verifyProof: verifyProof || (async () => { throw new Error('proof should not run'); }),
  };
}

test('sync derives canonical deployment, objectives, pools, and exact five-asset snapshot only from chain reads', async () => {
  const repository = fakeRepository();
  const service = createHistorySyncService({ repository, chain: fakeChain(), now: () => 1_787_163_000_000 });
  const request = parseHistorySyncBody({ deployments: ['v7'], maxEpochs: 10, includeKnownProofs: false });
  const first = await service.sync({ request, idempotencyKey: 'history-sync:test-0001' });
  assert.equal(first.deploymentsSynced, 1);
  assert.equal(first.epochsSynced, 1);
  assert.equal(first.snapshotsSynced, 1);
  assert.equal(repository.state.epochs[0].snapshot.assetVector.length, 5);
  assert.equal(repository.state.epochs[0].highObjective.payout_pool_atto, '198');
  const replay = await service.sync({ request, idempotencyKey: 'history-sync:test-0001' });
  assert.equal(replay.replayed, true);
  assert.equal(repository.state.epochs.length, 1);
});

test('sync rejects same idempotency key with a different canonical request', async () => {
  const repository = fakeRepository();
  const service = createHistorySyncService({ repository, chain: fakeChain(), now: () => 1_787_163_000_000 });
  await service.sync({
    request: parseHistorySyncBody({ deployments: ['v7'], maxEpochs: 1, includeKnownProofs: false }),
    idempotencyKey: 'history-sync:test-0002',
  });
  await assert.rejects(
    () => service.sync({
      request: parseHistorySyncBody({ deployments: ['v7'], maxEpochs: 2, includeKnownProofs: false }),
      idempotencyKey: 'history-sync:test-0002',
    }),
    (error) => error.code === 'HISTORY_IDEMPOTENCY_CONFLICT',
  );
});

test('sync refuses a proof whose chain-derived identity differs from the asserted kind', async () => {
  const repository = fakeRepository();
  const hash = `0x${'a'.repeat(64)}`;
  const deployment = testDeployment();
  const chain = fakeChain({
    verifyProof: async () => ({
      transactionHash: hash,
      deploymentId: deployment.deploymentId,
      deploymentAlias: 'v7',
      epochEndTimestamp: null,
      proofKind: 'WAGER',
      executionResult: 'FINISHED_WITH_RETURN',
    }),
  });
  const service = createHistorySyncService({ repository, chain, now: () => 1_787_163_000_000 });
  await assert.rejects(
    () => service.sync({
      request: parseHistorySyncBody({
        deployments: ['v7'],
        maxEpochs: 1,
        includeKnownProofs: false,
        proofs: [{ deployment: 'v7', hash, kind: 'RESOLVE_EPOCH' }],
      }),
      idempotencyKey: 'history-sync:test-0003',
    }),
    (error) => error.code === 'HISTORY_PROOF_IDENTITY',
  );
  assert.equal(repository.state.proofs.length, 0);
});
