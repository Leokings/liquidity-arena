import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHistorySyncBody } from './schema.mjs';
import { createHistorySyncService } from './sync-service.mjs';
import {
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testPayout,
  testSchema,
} from './test-fixtures.mjs';

function repository() {
  const state = {
    deployments: [], epochs: [], payouts: [], runs: new Map(), payoutCursor: 0, projections: [],
  };
  return {
    configured: true,
    state,
    async claimRun({ keyHash, requestHash }) {
      const prior = state.runs.get(keyHash);
      if (prior && prior.requestHash !== requestHash) return { state: 'CONFLICT' };
      if (prior?.summary) return { state: 'REPLAY', summary: prior.summary };
      state.runs.set(keyHash, { requestHash });
      return { state: 'CLAIMED' };
    },
    async completeRun({ keyHash, summary }) { state.runs.get(keyHash).summary = summary; },
    async failRun() {},
    async upsertDeployment(value) { state.deployments.push(value); },
    async upsertEpoch(value) { state.epochs.push(value); },
    async upsertPayout(value) { state.payouts.push(value); },
    async getPayoutSyncCursor() { return { nextOffset: state.payoutCursor, observedTotal: 0 }; },
    async advancePayoutSyncCursor({ nextOffset }) { state.payoutCursor = nextOffset; },
    async projectVerifiedPayoutStageProofs({ payoutIds }) {
      state.projections.push([...payoutIds]);
      return payoutIds.length;
    },
    async getProof() { return null; },
    async hasEpoch() { return true; },
    async upsertProof() {},
  };
}

function chain() {
  const deployment = testDeployment();
  return {
    configuration: {
      network: 'testnet-bradbury', chainId: 4_221, deployments: [deployment],
    },
    async readDeployment() {
      return {
        deployment,
        config: testConfig(),
        schema: testSchema(),
        epochCount: 1,
        payoutCount: 1,
        epochs: [{ epoch: testDeterminedEpoch(), assets: testAssets() }],
        payouts: [testPayout()],
        payoutPage: { offset: 0, nextOffset: 0, total: 1 },
      };
    },
    async verifyProof() { throw new Error('no proof expected'); },
  };
}

test('sync projects only Bradbury V8 epochs and bounded payout stages', async () => {
  const store = repository();
  const service = createHistorySyncService({ repository: store, chain: chain(), now: () => 1_787_200_000_000 });
  const summary = await service.sync({
    request: parseHistorySyncBody({ deployments: ['v8'], includeKnownProofs: false }),
    idempotencyKey: 'v8-sync-1',
  });
  assert.equal(summary.network, 'testnet-bradbury');
  assert.equal(summary.chainId, 4_221);
  assert.equal(summary.deploymentsSynced, 1);
  assert.equal(summary.epochsSynced, 1);
  assert.equal(summary.payoutsSynced, 1);
  assert.equal(summary.payoutStageProofsProjected, 1);
  assert.equal(store.state.deployments[0].alias, 'v8');
  assert.equal(store.state.payouts[0].payoutId, 'a'.repeat(64));
  assert.deepEqual(store.state.projections, [['a'.repeat(64)]]);
});

test('sync idempotency rejects the same key with a different V8 request', async () => {
  const store = repository();
  const service = createHistorySyncService({ repository: store, chain: chain() });
  await service.sync({
    request: parseHistorySyncBody({ deployments: ['v8'], maxEpochs: 1, includeKnownProofs: false }),
    idempotencyKey: 'v8-sync-key',
  });
  await assert.rejects(
    () => service.sync({
      request: parseHistorySyncBody({ deployments: ['v8'], maxEpochs: 2, includeKnownProofs: false }),
      idempotencyKey: 'v8-sync-key',
    }),
    /different request/,
  );
});

test('successive sync runs persist and advance the payout backlog cursor', async () => {
  const store = repository();
  const source = chain();
  const offsets = [];
  source.readDeployment = async (_deploymentId, options) => {
    offsets.push(options.payoutOffset);
    const offset = options.payoutOffset;
    return {
      deployment: testDeployment(),
      config: testConfig(),
      schema: testSchema(),
      epochCount: 1,
      payoutCount: 60,
      epochs: [{ epoch: testDeterminedEpoch(), assets: testAssets() }],
      payouts: Array.from({ length: 25 }, (_, index) => testPayout({
        payout_id: (offset + index + 1).toString(16).padStart(64, '0'),
      })),
      payoutPage: { offset, nextOffset: offset + 25, total: 60 },
    };
  };
  const service = createHistorySyncService({ repository: store, chain: source });
  for (const key of ['backlog-1', 'backlog-2']) {
    await service.sync({
      request: parseHistorySyncBody({ deployments: ['v8'], maxEpochs: 1, includeKnownProofs: false }),
      idempotencyKey: key,
    });
  }
  assert.deepEqual(offsets, [0, 25]);
  assert.equal(store.state.payoutCursor, 50);
  assert.equal(store.state.payouts.length, 50);
});
