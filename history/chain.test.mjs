import assert from 'node:assert/strict';
import test from 'node:test';

import { createStudioNetHistoryChain } from './chain.mjs';
import {
  TEST_EPOCH,
  TEST_OWNER,
  testAssetCatalog,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testVenueCatalog,
} from './test-fixtures.mjs';

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function configuration() {
  return {
    network: 'studionet',
    chainId: 61999,
    rpcUrl: 'https://studio.example.invalid/api',
    deployments: [testDeployment()],
  };
}

test('StudioNet chain reader verifies 0xf22f and reads only allowlisted deployment state', async () => {
  const deployment = testDeployment();
  const calls = [];
  const client = {
    async readContract({ address, functionName, args }) {
      assert.equal(address, deployment.address);
      calls.push({ functionName, args });
      if (functionName === 'get_config') return testConfig();
      if (functionName === 'get_asset_catalog') return testAssetCatalog();
      if (functionName === 'get_venue_catalog') return testVenueCatalog();
      if (functionName === 'get_epoch_count') return 1;
      if (functionName === 'get_epoch_page') return { offset: 0, next_offset: 1, total: 1, epoch_ids: [String(TEST_EPOCH)] };
      if (functionName === 'get_epoch') return { ...testDeterminedEpoch(), result_status: 'PENDING' };
      throw new Error(`unexpected ${functionName}`);
    },
  };
  const chain = createStudioNetHistoryChain({
    configuration: configuration(),
    createClientImpl: () => client,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'eth_chainId');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' });
    },
  });
  const result = await chain.readDeployment(`studionet:${deployment.address}`, { maxEpochs: 1, startOffset: null });
  assert.equal(result.deployment.address, deployment.address);
  assert.equal(result.deployment.addressKey, deployment.address.toLowerCase());
  assert.equal(result.deployment.deploymentId, `studionet:${deployment.address.toLowerCase()}`);
  assert.equal(result.epochCount, 1);
  assert.equal(result.epochs.length, 1);
  assert.equal(calls.some((call) => call.functionName === 'get_epoch_asset'), false);
  await assert.rejects(
    () => chain.readDeployment(`studionet:0x${'9'.repeat(40)}`, { maxEpochs: 1, startOffset: null }),
    /not allowlisted/,
  );
});

test('scheduled history reads the latest resolvable epoch instead of the pre-seeded future tail', async () => {
  const deployment = testDeployment();
  const ids = [
    TEST_EPOCH + 10_800,
    TEST_EPOCH + 3_600,
    TEST_EPOCH,
    TEST_EPOCH + 7_200,
  ];
  const epochReads = [];
  const client = {
    async readContract({ functionName, args }) {
      if (functionName === 'get_config') return testConfig();
      if (functionName === 'get_asset_catalog') return testAssetCatalog();
      if (functionName === 'get_venue_catalog') return testVenueCatalog();
      if (functionName === 'get_epoch_count') return ids.length;
      if (functionName === 'get_epoch_page') {
        assert.deepEqual(args, [0, ids.length]);
        return { offset: 0, next_offset: ids.length, total: ids.length, epoch_ids: ids.map(String) };
      }
      if (functionName === 'get_epoch') {
        epochReads.push(Number(args[0]));
        return { ...testDeterminedEpoch(), result_status: 'PENDING' };
      }
      throw new Error(`unexpected ${functionName}`);
    },
  };
  const chain = createStudioNetHistoryChain({
    configuration: configuration(),
    createClientImpl: () => client,
    now: () => (TEST_EPOCH + 7_200 + 121) * 1_000,
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' }),
  });

  const result = await chain.readDeployment(deployment.deploymentId, { maxEpochs: 2, startOffset: null });

  assert.deepEqual(epochReads, [TEST_EPOCH + 3_600, TEST_EPOCH + 7_200]);
  assert.equal(result.offset, 1);
  assert.equal(result.epochs.length, 2);
});

test('two determined scheduled epochs stay below StudioNet thirty-call quota', async () => {
  const deployments = [testDeployment('v7'), testDeployment('v6')];
  let networkReads = 0;
  let contractReads = 0;
  const client = {
    async readContract({ address, functionName, args }) {
      contractReads += 1;
      const alias = address === deployments[0].address ? 'v7' : 'v6';
      if (functionName === 'get_config') return testConfig(alias);
      if (functionName === 'get_asset_catalog') return testAssetCatalog();
      if (functionName === 'get_venue_catalog') return testVenueCatalog();
      if (functionName === 'get_epoch_count') return 1;
      if (functionName === 'get_epoch_page') {
        return { offset: 0, next_offset: 1, total: 1, epoch_ids: [String(TEST_EPOCH)] };
      }
      if (functionName === 'get_epoch') return testDeterminedEpoch();
      if (functionName === 'get_epoch_asset') {
        return testAssets().find((asset) => asset.asset_id === args[1]);
      }
      throw new Error(`unexpected ${functionName}`);
    },
  };
  const chain = createStudioNetHistoryChain({
    configuration: {
      ...configuration(),
      deployments,
    },
    createClientImpl: () => client,
    now: () => (TEST_EPOCH + 121) * 1_000,
    fetchImpl: async () => {
      networkReads += 1;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' });
    },
  });

  for (const deployment of deployments) {
    const result = await chain.readDeployment(deployment.deploymentId, { maxEpochs: 1, startOffset: null });
    assert.equal(result.epochs.length, 1);
    assert.equal(result.epochs[0].assets.length, 5);
  }

  assert.equal(networkReads + contractReads, 23);
  assert.ok(networkReads + contractReads < 30);
});

test('proof verifier derives kind from finalized decoded call and rejects caller-selected mismatch', async () => {
  const deployment = testDeployment();
  const hash = `0x${'a'.repeat(64)}`;
  const raw = {
    hash,
    status: 'FINALIZED',
    // StudioNet proof responses normalize addresses even though readContract
    // requires the configured mixed-case address.
    recipient: deployment.addressKey,
    sender: TEST_OWNER,
    type: 2,
    value: 0,
  };
  const client = {
    async waitForTransactionReceipt() {
      return {
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        txDataDecoded: {
          type: 'call',
          callData: { method: 'resolve_epoch', args: [String(TEST_EPOCH)] },
        },
      };
    },
  };
  const chain = createStudioNetHistoryChain({
    configuration: configuration(),
    createClientImpl: () => client,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'eth_chainId') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' });
      assert.equal(request.method, 'eth_getTransactionByHash');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: raw });
    },
  });
  await assert.rejects(
    () => chain.verifyProof({
      deploymentId: `studionet:${deployment.address}`,
      hash,
      assertedKind: 'WAGER',
      expectedDeploymentHash: null,
    }),
    /does not match the finalized decoded chain method/,
  );
  const proof = await chain.verifyProof({
    deploymentId: `studionet:${deployment.address}`,
    hash,
    assertedKind: 'RESOLVE_EPOCH',
    expectedDeploymentHash: null,
  });
  assert.equal(proof.proofKind, 'RESOLVE_EPOCH');
  assert.equal(proof.deploymentId, deployment.deploymentId);
  assert.equal(proof.recipientAddress, deployment.addressKey);
  assert.equal(proof.epochEndTimestamp, String(TEST_EPOCH));
  assert.equal(proof.proofMetadata.independentOracle, false);
});

test('proof verifier recognizes the deployed enter and withdraw_accrued_fees ABI methods', async () => {
  const deployment = testDeployment();
  const cases = [
    {
      hash: `0x${'d'.repeat(64)}`,
      method: 'enter',
      args: [String(TEST_EPOCH), 'HIGH', 'BTC'],
      assertedKind: 'WAGER',
      value: '10000000000000000',
      expectedEpoch: String(TEST_EPOCH),
    },
    {
      hash: `0x${'e'.repeat(64)}`,
      method: 'withdraw_accrued_fees',
      args: ['1000000000000000'],
      assertedKind: 'FEE_WITHDRAWAL',
      value: 0,
      expectedEpoch: null,
    },
  ];
  for (const proofCase of cases) {
    const raw = {
      hash: proofCase.hash,
      status: 'FINALIZED',
      recipient: deployment.addressKey,
      sender: TEST_OWNER,
      type: 2,
      value: proofCase.value,
    };
    const chain = createStudioNetHistoryChain({
      configuration: configuration(),
      createClientImpl: () => ({
        async waitForTransactionReceipt() {
          return {
            statusName: 'FINALIZED',
            txExecutionResultName: 'FINISHED_WITH_RETURN',
            txDataDecoded: {
              type: 'call',
              callData: { method: proofCase.method, args: proofCase.args },
            },
          };
        },
      }),
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        if (request.method === 'eth_chainId') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' });
        assert.equal(request.method, 'eth_getTransactionByHash');
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: raw });
      },
    });
    const proof = await chain.verifyProof({
      deploymentId: `studionet:${deployment.address}`,
      hash: proofCase.hash,
      assertedKind: proofCase.assertedKind,
      expectedDeploymentHash: null,
    });
    assert.equal(proof.method, proofCase.method);
    assert.equal(proof.proofKind, proofCase.assertedKind);
    assert.equal(proof.epochEndTimestamp, proofCase.expectedEpoch);
  }
});

test('claim proof is accepted only after deriving one finalized credited child from its parent', async () => {
  const deployment = testDeployment();
  const parentHash = `0x${'b'.repeat(64)}`;
  const childHash = `0x${'c'.repeat(64)}`;
  const amount = '198000000000000000';
  const parent = {
    hash: parentHash,
    tx_id: parentHash,
    status: 'FINALIZED',
    recipient: deployment.addressKey,
    sender: TEST_OWNER,
    from_address: TEST_OWNER,
    type: 2,
    value: 0,
    messages: [{
      messageType: '0',
      recipient: TEST_OWNER,
      value: amount,
      data: '',
      onAcceptance: false,
    }],
    triggered_transactions: [childHash],
  };
  const child = {
    hash: childHash,
    tx_id: childHash,
    status: 'FINALIZED',
    to_address: TEST_OWNER,
    recipient: TEST_OWNER,
    sender: deployment.addressKey,
    from_address: deployment.addressKey,
    origin_address: deployment.addressKey,
    value: amount,
    type: 0,
    triggered_by: parentHash,
    triggered_on: 'finalized',
    value_credited: true,
  };
  const client = {
    async waitForTransactionReceipt({ hash }) {
      if (hash === childHash) return { statusName: 'FINALIZED' };
      return {
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        txDataDecoded: {
          type: 'call',
          callData: { method: 'claim', args: [String(TEST_EPOCH), 'LOW'] },
        },
      };
    },
  };
  let tamperChild = false;
  const chain = createStudioNetHistoryChain({
    configuration: configuration(),
    createClientImpl: () => client,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'eth_chainId') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xf22f' });
      const hash = request.params[0];
      const result = hash === parentHash ? parent : { ...child, value_credited: tamperChild ? false : true };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result });
    },
  });
  const proof = await chain.verifyProof({
    deploymentId: `studionet:${deployment.address}`,
    hash: parentHash,
    assertedKind: 'CLAIM',
    expectedDeploymentHash: null,
  });
  assert.deepEqual(proof.childTransactionHashes, [childHash]);
  assert.equal(proof.valueAtto, amount);
  assert.equal(proof.valueCredited, true);
  tamperChild = true;
  await assert.rejects(
    () => chain.verifyProof({
      deploymentId: `studionet:${deployment.address}`,
      hash: parentHash,
      assertedKind: 'CLAIM',
      expectedDeploymentHash: null,
    }),
    /did not credit its exact value/,
  );
});
