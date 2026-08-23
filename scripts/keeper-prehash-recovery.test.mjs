import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { Interface } from 'ethers';

import {
  assertResolvableEpochPostState,
  BRADBURY_CONSENSUS_ADDRESS,
  BRADBURY_RECOVERY_RPC_URL,
  createBradburyRecoveryRpc,
  NEW_TRANSACTION_TOPIC,
  readBradburyRecoveryEpoch,
  verifyAuditedPrehashChainEvidence,
} from './keeper-prehash-recovery.mjs';

const OPERATION = 'a'.repeat(64);
const SIGNER = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const OUTER_HASH = `0x${'4'.repeat(64)}`;
const INNER_HASH = `0x${'5'.repeat(64)}`;
const REFERENCE_BLOCK_HASH = `0x${'6'.repeat(64)}`;
const START_TIME_SECONDS = 1_800_000_000;
const iface = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);

function hash(number) {
  return `0x${number.toString(16).padStart(64, '0')}`;
}

function block(number, transactions = []) {
  return {
    number: `0x${number.toString(16)}`,
    hash: number === 5 ? REFERENCE_BLOCK_HASH : hash(number),
    timestamp: `0x${(START_TIME_SECONDS + number).toString(16)}`,
    transactions,
  };
}

function fixture() {
  const evidence = {
    evidenceVersion: 'BRADBURY_KEEPER_EVM_SCAN_V1',
    runId: '32599800265',
    failedAt: '2027-01-15T10:00:11.000Z',
    failureCode: 'ACTION_FAILURES',
    failureMessage: '1 V8 keeper action(s) failed',
    lowerLevelErrorRetained: false,
    transactionHashObserved: false,
    network: 'bradbury',
    chainId: '4221',
    signerAddress: SIGNER,
    operationId: OPERATION,
    logicalOperationId: OPERATION,
    contractAddress: TARGET,
    method: 'resolve_epoch',
    arguments: ['1787432400'],
    subjectType: 'epoch',
    subjectId: '1787432400',
    preparedAt: '2027-01-15T10:00:10.000Z',
    scanStartBlock: '10',
    scanEndBlock: '12',
    scanStartTimestamp: new Date((START_TIME_SECONDS + 10) * 1_000).toISOString(),
    scanEndTimestamp: new Date((START_TIME_SECONDS + 12) * 1_000).toISOString(),
    matchingOuterTransactions: '0',
    nonceAtStart: '73',
    nonceAtEnd: '73',
    latestNonce: '73',
    pendingNonce: '73',
    referenceEventTransactionId: INNER_HASH,
    referenceOuterTransactionHash: OUTER_HASH,
    referenceOuterNonce: '72',
    referenceOuterBlock: '5',
    referenceOuterSender: SIGNER,
    referenceConsensusRecipient: BRADBURY_CONSENSUS_ADDRESS,
    referenceCallSender: SIGNER,
    referenceCallRecipient: TARGET,
    queryResultSha256: '7'.repeat(64),
    postStateStatus: 'TARGET_STATE_UNCHANGED',
    postStateVerified: true,
    auditedAt: '2027-01-15T12:00:00.000Z',
  };
  const input = iface.encodeFunctionData('addTransaction', [SIGNER, TARGET, 5n, 3n, '0x1234', 0n]);
  const transaction = {
    hash: OUTER_HASH,
    from: SIGNER,
    to: BRADBURY_CONSENSUS_ADDRESS,
    nonce: '0x48',
    blockNumber: '0x5',
    blockHash: REFERENCE_BLOCK_HASH,
    input,
  };
  const receipt = {
    transactionHash: OUTER_HASH,
    status: '0x1',
    blockNumber: '0x5',
    blockHash: REFERENCE_BLOCK_HASH,
    logs: [{
      address: BRADBURY_CONSENSUS_ADDRESS,
      topics: [NEW_TRANSACTION_TOPIC, INNER_HASH, hash(8), hash(9)],
      data: '0x',
      transactionHash: OUTER_HASH,
      blockHash: REFERENCE_BLOCK_HASH,
    }],
  };
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push([method, structuredClone(params)]);
    if (method === 'eth_chainId') return '0x107d';
    if (method === 'eth_getTransactionCount') return '0x49';
    if (method === 'eth_getTransactionByHash') return structuredClone(transaction);
    if (method === 'eth_getTransactionReceipt') return structuredClone(receipt);
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return block(20);
      const number = Number(BigInt(params[0]));
      return block(number);
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  return { evidence, transaction, receipt, calls, rpcCall };
}

test('audited recovery chain proof verifies the inclusive scan, boundary nonce, and reference mapping', async () => {
  const value = fixture();
  const result = await verifyAuditedPrehashChainEvidence({
    evidence: value.evidence,
    operationId: OPERATION,
    signerAddress: SIGNER,
    rpcCall: value.rpcCall,
  });
  assert.equal(result.chainId, '4221');
  assert.deepEqual(
    value.calls.filter(([method, params]) => (
      method === 'eth_getBlockByNumber' && params[1] === true
    )).slice(0, 3)
      .map(([, params]) => params),
    [['0xa', true], ['0xb', true], ['0xc', true]],
  );
  assert.ok(value.calls.some(([method, params]) => (
    method === 'eth_getTransactionCount' && params[1] === '0x9'
  )));
  const finalizedIndex = value.calls.findIndex(([method, params]) => (
    method === 'eth_getBlockByNumber' && params[0] === 'finalized'
  ));
  const scanIndex = value.calls.findIndex(([method, params]) => (
    method === 'eth_getBlockByNumber' && params[1] === true
  ));
  assert.ok(finalizedIndex >= 0 && finalizedIndex < scanIndex);
});

test('live target attestation accepts only the exact unchanged resolvable epoch', () => {
  const evidence = fixture().evidence;
  const epoch = {
    epoch_id: evidence.subjectId,
    epoch_end_timestamp: Number(evidence.subjectId),
    status: 'OPEN',
    result_status: 'PENDING',
    resolution_digest: '',
    phase: 'RESOLVABLE',
    high: { settlement_mode: 'PENDING' },
    low: { settlement_mode: 'PENDING' },
  };
  assert.equal(assertResolvableEpochPostState(epoch, evidence).phase, 'RESOLVABLE');
  for (const invalid of [
    { ...epoch, status: 'RESOLVED' },
    { ...epoch, phase: 'OPEN' },
    { ...epoch, high: { settlement_mode: 'PARIMUTUEL' } },
    { ...epoch, resolution_digest: 'changed' },
  ]) assert.throws(() => assertResolvableEpochPostState(invalid, evidence), /OPEN\/RESOLVABLE/);
});

test('live target read kills and rejects a stalled credential-free GenLayer call', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => { killed += 1; return true; };
  await assert.rejects(
    readBradburyRecoveryEpoch({
      contractAddress: TARGET,
      subjectId: '1787432400',
      invocation: { executable: 'genlayer-test', prefixArgs: [] },
      spawnImpl: () => child,
      timeoutMs: 5,
    }),
    /timed out/,
  );
  assert.equal(killed, 1);
});

test('operation identity mismatch fails before the first RPC', async () => {
  const value = fixture();
  await assert.rejects(
    verifyAuditedPrehashChainEvidence({
      evidence: value.evidence,
      operationId: 'b'.repeat(64),
      signerAddress: SIGNER,
      rpcCall: value.rpcCall,
    }),
    /operationId/,
  );
  assert.equal(value.calls.length, 0);
});

test('Bradbury RPC transport is fixed to the reviewed HTTPS endpoint', async () => {
  let observed;
  const rpc = createBradburyRecoveryRpc({
    fetchImpl: async (url, request) => {
      observed = { url, request };
      const body = JSON.parse(request.body);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x107d' }) };
    },
  });
  assert.equal(await rpc('eth_chainId', []), '0x107d');
  assert.equal(observed.url, BRADBURY_RECOVERY_RPC_URL);
  assert.equal(new URL(observed.url).protocol, 'https:');
});

test('Bradbury RPC transport aborts a hung request at its bounded timeout', async () => {
  const rpc = createBradburyRecoveryRpc({
    timeoutMs: 5,
    fetchImpl: async (url, request) => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    }),
  });
  await assert.rejects(rpc('eth_chainId', []), /timed out/);
});

test('Bradbury RPC transport keeps the abort deadline active while reading the body', async () => {
  const rpc = createBradburyRecoveryRpc({
    timeoutMs: 5,
    fetchImpl: async (url, request) => ({
      ok: true,
      text: async () => new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      }),
    }),
  });
  await assert.rejects(rpc('eth_chainId', []), /timed out/);
});

test('audited recovery fails closed for adversarial chain evidence mismatches', async (context) => {
  const cases = [
    ['wrong chain', (value) => async (method, params) => (
      method === 'eth_chainId' ? '0x1' : value.rpcCall(method, params)
    ), /chainId/],
    ['scan timestamp mismatch', (value) => {
      value.evidence.scanStartTimestamp = '2027-01-01T00:00:00.000Z';
    }, /timestamps/],
    ['keeper transaction inside scan', (value) => async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0xb' && params[1] === true) {
        return block(11, [{ from: SIGNER }]);
      }
      return value.rpcCall(method, params);
    }, /outer transaction exists/],
    ['boundary nonce mismatch', (value) => async (method, params) => (
      method === 'eth_getTransactionCount' && params[1] === '0x9'
        ? '0x48' : value.rpcCall(method, params)
    ), /boundary nonce/],
    ['reference outer sender mismatch', (value) => {
      value.transaction.from = OTHER;
    }, /outer transaction/],
    ['reference call recipient mismatch', (value) => {
      value.transaction.input = iface.encodeFunctionData(
        'addTransaction', [SIGNER, OTHER, 5n, 3n, '0x1234', 0n],
      );
    }, /addTransaction sender or recipient/],
    ['failed reference receipt', (value) => {
      value.receipt.status = '0x0';
    }, /successful receipt/],
    ['wrong NewTransaction inner id', (value) => {
      value.receipt.logs[0].topics[1] = hash(99);
    }, /topic1/],
    ['reference is not finalized', (value) => async (method, params) => (
      method === 'eth_getBlockByNumber' && params[0] === 'finalized'
        ? block(4) : value.rpcCall(method, params)
    ), /not finalized/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await context.test(name, async () => {
      const value = fixture();
      const replacement = mutate(value);
      await assert.rejects(
        verifyAuditedPrehashChainEvidence({
          evidence: value.evidence,
          operationId: OPERATION,
          signerAddress: SIGNER,
          rpcCall: typeof replacement === 'function' ? replacement : value.rpcCall,
        }),
        pattern,
      );
    });
  }
});

test('audited scan range is bounded before RPC', async () => {
  const value = fixture();
  value.evidence.scanEndBlock = '2011';
  await assert.rejects(
    verifyAuditedPrehashChainEvidence({
      evidence: value.evidence,
      operationId: OPERATION,
      signerAddress: SIGNER,
      rpcCall: value.rpcCall,
    }),
    /range/,
  );
  assert.equal(value.calls.length, 0);
});
