import assert from 'node:assert/strict';
import test from 'node:test';

import { createBradburyHistoryChain } from './chain.mjs';
import {
  TEST_EPOCH,
  TEST_OWNER,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testPayout,
  testSchema,
} from './test-fixtures.mjs';

function configuration() {
  return {
    network: 'testnet-bradbury',
    keeperNetwork: 'bradbury',
    chainId: 4_221,
    rpcUrl: 'https://rpc-bradbury.genlayer.com/',
    deployments: [testDeployment()],
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function readClient() {
  return {
    async getContractSchema() { return testSchema(); },
    async readContract({ functionName, args }) {
      if (functionName === 'get_config') return testConfig();
      if (functionName === 'get_epoch_page') {
        const offset = Number(args[0]);
        return { offset, next_offset: 1, total: 1, epoch_ids: [TEST_EPOCH] };
      }
      if (functionName === 'get_payout_page') {
        const offset = Number(args[0]);
        return { offset, next_offset: 1, total: 1, payouts: [testPayout()] };
      }
      if (functionName === 'get_epoch') return testDeterminedEpoch();
      if (functionName === 'get_epoch_asset') {
        return testAssets().find((asset) => asset.asset_id === args[1]);
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    async waitForTransactionReceipt() {
      return {
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        txDataDecoded: {
          type: 'call',
          callData: { method: 'claim', args: [String(TEST_EPOCH), 'HIGH'] },
        },
      };
    },
  };
}

test('Bradbury chain reader uses V8 pages and returns epoch plus payout state', async () => {
  const chain = createBradburyHistoryChain({
    configuration: configuration(),
    createClientImpl: readClient,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_chainId');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x107d' });
    },
  });
  const state = await chain.readDeployment(testDeployment().deploymentId, { maxEpochs: 10, startOffset: 0 });
  assert.equal(state.epochCount, 1);
  assert.equal(state.payoutCount, 1);
  assert.equal(state.epochs[0].assets.length, 5);
  assert.equal(state.payouts[0].payout_id, 'a'.repeat(64));
  assert.deepEqual(state.payoutPage, { offset: 0, nextOffset: 0, total: 1 });
  assert.deepEqual(state.schema, testSchema());
});

test('Bradbury payout pages rotate durably instead of starving payouts outside the newest 25', async () => {
  const total = 60;
  const payoutOffsets = [];
  const client = readClient();
  client.readContract = async ({ functionName, args }) => {
    if (functionName === 'get_config') return testConfig();
    if (functionName === 'get_epoch_page') {
      const offset = Number(args[0]);
      return { offset, next_offset: 1, total: 1, epoch_ids: [TEST_EPOCH] };
    }
    if (functionName === 'get_payout_page') {
      const offset = Number(args[0]);
      const limit = Number(args[1]);
      payoutOffsets.push(offset);
      return {
        offset,
        next_offset: offset + Math.min(limit, total - offset),
        total,
        payouts: Array.from(
          { length: Math.min(limit, total - offset) },
          (_, index) => testPayout({ payout_id: (offset + index + 1).toString(16).padStart(64, '0') }),
        ),
      };
    }
    if (functionName === 'get_epoch') return testDeterminedEpoch();
    if (functionName === 'get_epoch_asset') return testAssets().find((asset) => asset.asset_id === args[1]);
    throw new Error(`unexpected read ${functionName}`);
  };
  const history = createBradburyHistoryChain({
    configuration: configuration(),
    createClientImpl: () => client,
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x107d' }),
  });
  const middle = await history.readDeployment(testDeployment().deploymentId, {
    maxEpochs: 1, startOffset: 0, payoutOffset: 25,
  });
  assert.equal(middle.payouts.length, 25);
  assert.deepEqual(middle.payoutPage, { offset: 25, nextOffset: 50, total });
  const tail = await history.readDeployment(testDeployment().deploymentId, {
    maxEpochs: 1, startOffset: 0, payoutOffset: middle.payoutPage.nextOffset,
  });
  assert.equal(tail.payouts.length, 10);
  assert.deepEqual(tail.payoutPage, { offset: 50, nextOffset: 0, total });
  assert.deepEqual(payoutOffsets, [0, 25, 0, 50]);
});

test('proof verifier records V8 claim as a request and never as credited legacy delivery', async () => {
  const hash = `0x${'b'.repeat(64)}`;
  const deployment = testDeployment();
  const chain = createBradburyHistoryChain({
    configuration: configuration(),
    createClientImpl: readClient,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'eth_chainId') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x107d' });
      assert.equal(request.method, 'eth_getTransactionByHash');
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          hash,
          status: 'FINALIZED',
          recipient: deployment.addressKey,
          sender: TEST_OWNER,
          type: 2,
          value: 0,
        },
      });
    },
  });
  const proof = await chain.verifyProof({
    deploymentId: deployment.deploymentId,
    hash,
    assertedKind: 'CLAIM_REQUEST',
    expectedDeploymentHash: null,
  });
  assert.equal(proof.proofKind, 'CLAIM_REQUEST');
  assert.equal(proof.valueCredited, null);
  assert.deepEqual(proof.childTransactionHashes, []);
  assert.equal(proof.proofMetadata.authority, 'GENLAYER_BRADBURY_RPC');
});

test('chain identity rejects any non-Bradbury endpoint result', async () => {
  const chain = createBradburyHistoryChain({
    configuration: configuration(),
    createClientImpl: readClient,
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' }),
  });
  await assert.rejects(
    () => chain.readDeployment(testDeployment().deploymentId, { maxEpochs: 1, startOffset: 0 }),
    /not Bradbury/,
  );
});
