import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  Interface,
  Transaction,
  Wallet,
  id as ethersId,
  zeroPadValue,
} from 'ethers';
import { abi as genlayerAbi, createClient } from 'genlayer-js';

import {
  BRADBURY_CONSENSUS_ADDRESS,
  DURABLE_SIGNING_PROTOCOL,
  durableSignedEvidenceSha256,
  inspectDurableSignedTransaction,
  redactDurableSignedEvidence,
} from '../keeper-journal/signed-transaction.mjs';
import { canonicalKeeperOperation } from '../keeper-journal/schema.mjs';
import {
  broadcastDurableSignedGenlayerWrite,
  createDurableSignedGenlayerWrite,
  persistDurableSignedGenlayerWrite,
} from './genlayer-durable-write.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const INNER_HASH = `0x${'a'.repeat(64)}`;
const BLOCK_HASH = `0x${'b'.repeat(64)}`;
const FINALIZED_HASH = `0x${'c'.repeat(64)}`;
const ACTIVATOR = '0x3b940a5b4a762583453d9e9cf0981be0426a8e79';
const PREPARED_AT = '2026-08-24T08:00:00.000Z';
const SIGNED_AT = '2026-08-24T08:00:01.000Z';
const KEYSTORE = JSON.stringify({ crypto: {} });
const ADD_TRANSACTION = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);

function provider(responses = {}) {
  const calls = [];
  return {
    calls,
    async send(method, args) {
      calls.push({ method, args: structuredClone(args) });
      const value = responses[method];
      if (typeof value === 'function') return value(args, calls);
      if (Array.isArray(value)) {
        if (value.length === 0) throw new Error(`exhausted ${method}`);
        const next = value.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected RPC ${method}`);
      return value;
    },
  };
}

function preparedOperation(signerAddress) {
  const canonical = canonicalKeeperOperation({
    deploymentAlias: 'v8',
    chainId: '4221',
    contractAddress: CONTRACT,
    subjectType: 'epoch',
    subjectId: '1787554800',
    method: 'create_epoch',
    args: ['1787554800'],
    valueAtto: '0',
  });
  return Object.freeze({
    operationId: canonical.operationId,
    logicalOperationId: canonical.operationId,
    attemptNumber: '1',
    retryOfOperationId: null,
    deploymentAlias: 'v8',
    network: 'bradbury',
    chainId: '4221',
    signerAddress: signerAddress.toLowerCase(),
    contractAddress: CONTRACT,
    subjectType: 'epoch',
    subjectId: '1787554800',
    method: 'create_epoch',
    args: Object.freeze(['1787554800']),
    valueAtto: '0',
    state: 'PREPARED',
    transactionHash: null,
    submissionProtocol: null,
    outerTransactionHash: null,
    outerSenderNonce: null,
    signedEvidenceSha256: null,
    signedAt: null,
    signedTransactionEvidence: null,
    outerReceiptObservedAt: null,
    submissionEvidence: null,
    outerOutcomeEvidence: null,
    preparedAt: PREPARED_AT,
    revision: '1',
  });
}

function signedOperation(operation, evidence) {
  return Object.freeze({
    ...operation,
    state: 'SIGNED',
    submissionProtocol: DURABLE_SIGNING_PROTOCOL,
    outerTransactionHash: evidence.outerTransactionHash,
    outerSenderNonce: evidence.outerNonce,
    signedEvidenceSha256: durableSignedEvidenceSha256(evidence),
    signedAt: SIGNED_AT,
    signedTransactionEvidence: redactDurableSignedEvidence(evidence),
    revision: '2',
  });
}

function signingRequest(signerAddress, method = 'create_epoch', args = [1787554800]) {
  const calldata = genlayerAbi.calldata.encode(
    genlayerAbi.calldata.makeCalldataObject(method, args, undefined),
  );
  const transactionData = genlayerAbi.transactions.serialize([calldata, false]);
  return {
    to: BRADBURY_CONSENSUS_ADDRESS,
    data: ADD_TRANSACTION.encodeFunctionData('addTransaction', [
      signerAddress,
      CONTRACT,
      5,
      3,
      transactionData,
      3_700,
    ]),
    type: 'legacy',
    nonce: 7,
    value: 0n,
    gas: 900_000n,
    gasPrice: 200_000_000n,
    chainId: 4_221,
  };
}

function signingProvider(estimate = '0xc3500') {
  return provider({
    eth_getBlockByNumber: { number: '0x20', hash: FINALIZED_HASH, timestamp: '0x5a' },
    eth_estimateGas: estimate,
    eth_getTransactionCount: ['0x7', '0x7'],
    eth_getBalance: '0xde0b6b3a7640000',
  });
}

function journalFor(operation) {
  let evidence = null;
  let persistedOperation = null;
  let renewCalls = 0;
  const session = {
    lease: Object.freeze({ fencingToken: '7' }),
    get evidence() { return evidence; },
    get operation() { return persistedOperation; },
    get renewCalls() { return renewCalls; },
    async renew() { renewCalls += 1; return this.lease; },
    async bindSigned(operationId, value) {
      assert.equal(operationId, operation.operationId);
      evidence = value;
      persistedOperation = signedOperation(operation, value);
      return Object.freeze({
        status: 'ok',
        action: 'BIND_SIGNED',
        operation: persistedOperation,
      });
    },
    async loadSigned(operationId) {
      assert.equal(operationId, operation.operationId);
      assert.ok(evidence, 'test journal must contain signed evidence');
      return Object.freeze({
        status: 'ok',
        action: 'LOAD_SIGNED',
        operationId,
        fencingToken: '7',
        evidence,
      });
    },
  };
  return session;
}

async function signedFixture({
  clientFactory,
  wallet = Wallet.createRandom(),
  rpc = signingProvider(),
  beforeSign = async () => {},
  nowSeconds = () => 100,
} = {}) {
  const operation = preparedOperation(wallet.address);
  let writeReturned = false;
  const selectedFactory = clientFactory || (({ account }) => ({
    async initializeConsensusSmartContract() {},
    async writeContract() {
      await account.signTransaction(signingRequest(wallet.address));
      writeReturned = true;
    },
  }));
  const signedWrite = await createDurableSignedGenlayerWrite({
    operation,
    password: 'test-only-password',
    keystorePath: 'ignored-test-keystore.json',
    readFileImpl: async () => KEYSTORE,
    statImpl: async () => ({ size: Buffer.byteLength(KEYSTORE), isFile: () => true }),
    walletLoader: async () => wallet,
    provider: rpc,
    clientFactory: selectedFactory,
    nowSeconds,
    beforeSign,
  });
  assert.equal(writeReturned, false, 'the SDK must never regain control after signing');
  const journalSession = journalFor(operation);
  const persistedOperation = await persistDurableSignedGenlayerWrite({
    signedWrite,
    operation,
    journalSession,
  });
  return {
    evidence: journalSession.evidence,
    journalSession,
    operation,
    persistedOperation,
    rpc,
    signedWrite,
    wallet,
  };
}

function newTransactionReceipt(evidence, overrides = {}) {
  const topicAddress = (value) => zeroPadValue(value, 32).toLowerCase();
  return {
    transactionHash: evidence.outerTransactionHash,
    transactionIndex: '0x0',
    status: '0x1',
    blockHash: BLOCK_HASH,
    blockNumber: '0x1234',
    logs: [{
      address: BRADBURY_CONSENSUS_ADDRESS,
      topics: [
        ethersId('NewTransaction(bytes32,address,address)').toLowerCase(),
        INNER_HASH,
        topicAddress(evidence.contractAddress),
        topicAddress(ACTIVATOR),
      ],
      data: '0x',
      removed: false,
      transactionHash: evidence.outerTransactionHash,
      blockHash: BLOCK_HASH,
      blockNumber: '0x1234',
      logIndex: '0x0',
    }],
    ...overrides,
  };
}

function canonicalOuterTransaction(evidence) {
  const signed = Transaction.from(evidence.rawTransaction);
  return {
    hash: evidence.outerTransactionHash,
    from: evidence.signerAddress,
    to: evidence.consensusAddress,
    chainId: '0x107d',
    nonce: `0x${BigInt(evidence.outerNonce).toString(16)}`,
    type: '0x0',
    value: '0x0',
    gas: `0x${signed.gasLimit.toString(16)}`,
    gasPrice: `0x${signed.gasPrice.toString(16)}`,
    input: signed.data,
    blockHash: BLOCK_HASH,
    blockNumber: '0x1234',
    transactionIndex: '0x0',
  };
}

function canonicalBlock(evidence) {
  return {
    hash: BLOCK_HASH,
    number: '0x1234',
    timestamp: '0x64',
    transactions: [evidence.outerTransactionHash],
  };
}

function replayProvider(evidence, {
  receiptInitially = false,
  exactTransactionInitially = false,
  sendResult = evidence.outerTransactionHash,
  receiptOverride,
  finalizedNumber = '0x1235',
  finalizedOverride,
} = {}) {
  const receipt = receiptOverride || newTransactionReceipt(evidence);
  let receiptCalls = 0;
  let transactionCalls = 0;
  return provider({
    eth_getTransactionReceipt: () => {
      receiptCalls += 1;
      if (receiptInitially) return receipt;
      if (receiptCalls === 1) return null;
      return receipt;
    },
    eth_getTransactionByHash: () => {
      transactionCalls += 1;
      if (!receiptInitially && !exactTransactionInitially && transactionCalls === 1) return null;
      return canonicalOuterTransaction(evidence);
    },
    eth_getBlockByNumber: ([tag]) => {
      if (tag === 'latest') return { number: '0x1233', hash: FINALIZED_HASH, timestamp: '0x64' };
      if (tag === 'finalized') return finalizedOverride === undefined
        ? { number: finalizedNumber, hash: FINALIZED_HASH, timestamp: '0x65' }
        : finalizedOverride;
      return canonicalBlock(evidence);
    },
    eth_sendRawTransaction: sendResult,
    eth_getTransactionCount: ['0x7', '0x8'],
  });
}

async function replay(fixture, rpc, overrides = {}) {
  return broadcastDurableSignedGenlayerWrite({
    operation: fixture.persistedOperation,
    journalSession: fixture.journalSession,
    provider: rpc,
    receiptAttempts: 2,
    receiptIntervalMs: 0,
    sleep: async () => {},
    clockSeconds: () => 100,
    ...overrides,
  });
}

function admissionError(retryAfterMs = 1937) {
  return Object.assign(new Error('could not coalesce error'), {
    code: 'UNKNOWN_ERROR',
    info: { error: {
      code: -32005,
      message: `server returned an error response: error code -32005: transaction gas rate limit exceeded: node is at capacity, retry in ~${retryAfterMs}ms, data: {"retryAfterMs":${retryAfterMs}}`,
    } },
  });
}

function admissionProvider(evidence, { succeedAt = 2, error = admissionError(), nonce = '0x7' } = {}) {
  let broadcasts = 0;
  return provider({
    eth_getTransactionReceipt: () => broadcasts >= succeedAt ? newTransactionReceipt(evidence) : null,
    eth_getTransactionByHash: () => broadcasts >= succeedAt ? canonicalOuterTransaction(evidence) : null,
    eth_getBlockByNumber: ([tag]) => tag === 'latest'
      ? { number: '0x1233', hash: FINALIZED_HASH, timestamp: '0x64' }
      : tag === 'finalized'
        ? { number: '0x1235', hash: FINALIZED_HASH, timestamp: '0x65' }
        : canonicalBlock(evidence),
    eth_getTransactionCount: nonce,
    eth_sendRawTransaction: () => {
      broadcasts += 1;
      if (broadcasts < succeedAt) throw error;
      return evidence.outerTransactionHash;
    },
  });
}

test('Bradbury admission throttling retries the identical durable bytes after the requested backoff', async () => {
  const fixture = await signedFixture();
  const rpc = admissionProvider(fixture.evidence);
  const delays = [];
  const result = await replay(fixture, rpc, { sleep: async (milliseconds) => delays.push(milliseconds) });
  assert.equal(result.outcome, 'SUBMITTED');
  assert.equal(result.transactionHash, INNER_HASH);
  assert.deepEqual(delays, [2187]);
  const broadcasts = rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction');
  assert.equal(broadcasts.length, 2);
  assert.ok(broadcasts.every(({ args }) => args[0] === fixture.evidence.rawTransaction));
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_getTransactionCount').length, 2);
});

test('admission retries are bounded and preserve the sanitized RPC rejection on exhaustion', async () => {
  const fixture = await signedFixture();
  const rpc = admissionProvider(fixture.evidence, { succeedAt: Number.POSITIVE_INFINITY });
  const delays = [];
  await assert.rejects(replay(fixture, rpc, { sleep: async (ms) => delays.push(ms) }), (error) => {
    assert.equal(error.code, 'DURABLE_WRITE_PENDING');
    assert.equal(error.broadcastFailure.rpcCode, -32005);
    assert.match(error.broadcastFailure.message, /node is at capacity/);
    assert.doesNotMatch(JSON.stringify(error), new RegExp(fixture.evidence.rawTransaction));
    return true;
  });
  assert.deepEqual(delays, [2187, 2187]);
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 3);
});

test('admission retry refuses an unexpectedly consumed nonce before resending', async () => {
  const fixture = await signedFixture();
  const rpc = admissionProvider(fixture.evidence, { nonce: '0x8' });
  await assert.rejects(replay(fixture, rpc), { code: 'DURABLE_WRITE_NONCE_CONSUMED' });
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
});

test('admission retry reconciles a receipt appearing during backoff without another broadcast', async () => {
  const fixture = await signedFixture();
  let visible = false;
  const rpc = admissionProvider(fixture.evidence, { succeedAt: Number.POSITIVE_INFINITY });
  const originalSend = rpc.send.bind(rpc);
  rpc.send = async (method, args) => {
    if (visible && method === 'eth_getTransactionReceipt') return newTransactionReceipt(fixture.evidence);
    if (visible && method === 'eth_getTransactionByHash') return canonicalOuterTransaction(fixture.evidence);
    return originalSend(method, args);
  };
  const result = await replay(fixture, rpc, { sleep: async () => { visible = true; } });
  assert.equal(result.outcome, 'SUBMITTED');
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
});

test('unknown broadcast errors and malformed throttle hints never authorize another send', async () => {
  const fixture = await signedFixture();
  for (const error of [
    Object.assign(new Error('timeout'), { code: 'TIMEOUT' }),
    admissionError(-1),
    admissionError(60_000),
    Object.assign(admissionError(), { info: { error: { code: -32000, message: admissionError().info.error.message } } }),
    Object.assign(admissionError(), { info: { error: { code: -32005, message: 'different capacity error' } } }),
  ]) {
    const rpc = admissionProvider(fixture.evidence, { succeedAt: Number.POSITIVE_INFINITY, error });
    await assert.rejects(replay(fixture, rpc), { code: 'DURABLE_WRITE_PENDING' });
    assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
  }
});

test('admission backoff cannot outlive the bounded RPC deadline', async () => {
  const fixture = await signedFixture();
  const rpc = admissionProvider(fixture.evidence);
  const delays = [];
  await assert.rejects(replay(fixture, rpc, {
    clockMs: () => 0,
    deadlineAtMs: 1000,
    sleep: async (ms) => delays.push(ms),
  }), { code: 'DURABLE_WRITE_DEADLINE' });
  assert.deepEqual(delays, []);
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
});

test('admission retry must renew and reload the exact active journal fence before resending', async () => {
  const fixture = await signedFixture();
  const rpc = admissionProvider(fixture.evidence);
  const load = fixture.journalSession.loadSigned.bind(fixture.journalSession);
  let loads = 0;
  fixture.journalSession.loadSigned = async (...args) => {
    const response = await load(...args);
    loads += 1;
    return loads === 3 ? { ...response, fencingToken: '8' } : response;
  };
  await assert.rejects(replay(fixture, rpc), { code: 'DURABLE_WRITE_JOURNAL' });
  assert.equal(loads, 3);
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
});

test('admission retry refuses an envelope whose validity margin expires during backoff', async () => {
  const fixture = await signedFixture();
  const rpc = admissionProvider(fixture.evidence);
  let now = 100;
  await assert.rejects(replay(fixture, rpc, {
    clockSeconds: () => now,
    sleep: async () => { now = 86400; },
  }), { code: 'DURABLE_WRITE_EXPIRED' });
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
});

test('durable signer rewrites to exact 24-hour validity and persists before exposing bytes', async () => {
  let beforeSignCalls = 0;
  const fixture = await signedFixture({ beforeSign: async () => { beforeSignCalls += 1; } });
  const { evidence } = fixture;
  assert.equal(beforeSignCalls, 1);
  assert.equal(evidence.signerAddress, fixture.wallet.address.toLowerCase());
  assert.equal(evidence.contractAddress, CONTRACT);
  assert.equal(evidence.method, 'create_epoch');
  assert.deepEqual(evidence.arguments, ['1787554800']);
  assert.equal(evidence.outerNonce, '7');
  assert.equal(evidence.valueAtto, '0');
  assert.equal(evidence.validUntil, String(100 + (24 * 60 * 60)));
  assert.equal(inspectDurableSignedTransaction(evidence.rawTransaction).outerTransactionHash,
    evidence.outerTransactionHash);
  const estimatedData = fixture.rpc.calls.find(
    ({ method }) => method === 'eth_estimateGas',
  ).args[0].data;
  assert.equal(estimatedData, Transaction.from(evidence.rawTransaction).data);
  assert.equal(Object.values(fixture.signedWrite).includes(evidence.rawTransaction), false);
});

test('durable signer rejects a lease-renewal delay that consumes the 23-hour initial margin', async () => {
  let currentTime = 100;
  await assert.rejects(signedFixture({
    nowSeconds: () => currentTime,
    beforeSign: async () => { currentTime += 3_601; },
  }), (error) => (
    error.code === 'DURABLE_WRITE_VALIDITY'
      && error.walletSignAttempted === true
      && error.broadcastAttempted === false
  ));
});

test('durable signer uses the larger fresh estimate but rejects the SDK 200000 fallback', async () => {
  const wallet = Wallet.createRandom();
  const operation = preparedOperation(wallet.address);
  let walletSignCalls = 0;
  await assert.rejects(createDurableSignedGenlayerWrite({
    operation,
    password: 'test-only-password',
    keystorePath: 'ignored',
    readFileImpl: async () => KEYSTORE,
    statImpl: async () => ({ size: Buffer.byteLength(KEYSTORE), isFile: () => true }),
    walletLoader: async () => ({
      address: wallet.address,
      async signTransaction() { walletSignCalls += 1; },
    }),
    provider: signingProvider('0x30d40'),
    clientFactory: ({ account }) => ({
      async initializeConsensusSmartContract() {},
      async writeContract() {
        await account.signTransaction({ ...signingRequest(wallet.address), gas: 200_000n });
      },
    }),
    nowSeconds: () => 100,
    beforeSign: async () => {},
  }), (error) => error.code === 'DURABLE_WRITE_ESTIMATE');
  assert.equal(walletSignCalls, 0);

  const higherEstimate = await signedFixture({ rpc: signingProvider('0xdbba1') });
  assert.equal(higherEstimate.evidence.gasLimit, '900001');
});

test('durable signer rejects a non-regular or oversized keystore before decrypting', async () => {
  const wallet = Wallet.createRandom();
  let decrypted = false;
  await assert.rejects(createDurableSignedGenlayerWrite({
    operation: preparedOperation(wallet.address),
    password: 'test-only-password',
    keystorePath: 'ignored',
    statImpl: async () => ({ size: 65 * 1024, isFile: () => false }),
    walletLoader: async () => { decrypted = true; return wallet; },
    beforeSign: async () => {},
  }), (error) => error.code === 'DURABLE_WRITE_KEYSTORE');
  assert.equal(decrypted, false);
});

test('signer fails closed on SDK fallback/re-entry and wallet signs only once', async () => {
  const wallet = Wallet.createRandom();
  let walletSignCalls = 0;
  await assert.rejects(createDurableSignedGenlayerWrite({
    operation: preparedOperation(wallet.address),
    password: 'test-only-password',
    keystorePath: 'ignored',
    readFileImpl: async () => KEYSTORE,
    statImpl: async () => ({ size: Buffer.byteLength(KEYSTORE), isFile: () => true }),
    walletLoader: async () => ({
      address: wallet.address,
      async signTransaction(request) {
        walletSignCalls += 1;
        return wallet.signTransaction(request);
      },
    }),
    provider: signingProvider(),
    clientFactory: ({ account }) => ({
      async initializeConsensusSmartContract() {},
      async writeContract() {
        try {
          await account.signTransaction(signingRequest(wallet.address));
        } catch {
          await account.signTransaction(signingRequest(wallet.address));
        }
      },
    }),
    nowSeconds: () => 100,
    beforeSign: async () => {},
  }), (error) => error.code === 'DURABLE_WRITE_MULTIPLE_SIGNATURES');
  assert.equal(walletSignCalls, 1);
});

test('crash after BIND_SIGNED recovers only through renewed fenced LOAD_SIGNED', async () => {
  const fixture = await signedFixture();
  const rpc = replayProvider(fixture.evidence);
  const result = await replay(fixture, rpc);
  assert.equal(result.outcome, 'SUBMITTED');
  assert.equal(result.transactionHash, INNER_HASH);
  assert.equal(result.submissionEvidence.finalizedHeadBlockNumber, '4661');
  assert.equal(fixture.journalSession.renewCalls, 2, 'load and immediate pre-send reload renew');
  const sends = rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args[0], fixture.evidence.rawTransaction);
});

test('crash after send recovers exact receipt without a duplicate broadcast', async () => {
  const fixture = await signedFixture();
  const rpc = replayProvider(fixture.evidence, { receiptInitially: true });
  const result = await replay(fixture, rpc);
  assert.equal(result.transactionHash, INNER_HASH);
  assert.equal(rpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false);
});

test('returned hash mismatch is ambiguous and reconciled only by persisted outer hash', async () => {
  const fixture = await signedFixture();
  const rpc = replayProvider(fixture.evidence, { sendResult: `0x${'d'.repeat(64)}` });
  const result = await replay(fixture, rpc);
  assert.equal(result.transactionHash, INNER_HASH);
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_sendRawTransaction').length, 1);
  assert.equal(rpc.calls.filter(({ method }) => method === 'eth_getTransactionReceipt')
    .every(({ args }) => args[0] === fixture.evidence.outerTransactionHash), true);
});

test('returned hash mismatch is never swallowed when the persisted outer hash is absent', async () => {
  const fixture = await signedFixture();
  const rpc = provider({
    eth_getTransactionReceipt: null,
    eth_getTransactionByHash: null,
    eth_getBlockByNumber: { number: '0x1233', hash: FINALIZED_HASH, timestamp: '0x64' },
    eth_sendRawTransaction: `0x${'d'.repeat(64)}`,
    eth_getTransactionCount: ['0x7', '0x7'],
  });
  await assert.rejects(
    replay(fixture, rpc, { receiptAttempts: 1 }),
    (error) => error.code === 'DURABLE_WRITE_BROADCAST_HASH_MISMATCH',
  );
});

test('truthy outer transaction query with mismatched identity fails closed without sending', async () => {
  const fixture = await signedFixture();
  const wrong = canonicalOuterTransaction(fixture.evidence);
  wrong.input = '0x01';
  const rpc = provider({
    eth_getTransactionReceipt: null,
    eth_getTransactionByHash: wrong,
  });
  await assert.rejects(
    replay(fixture, rpc, { receiptAttempts: 1 }),
    (error) => error.code === 'DURABLE_WRITE_RECEIPT',
  );
  assert.equal(rpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false);
});

test('exact pending outer transaction suppresses rebroadcast and is not mislabeled nonce-consumed', async () => {
  const fixture = await signedFixture();
  const rpc = replayProvider(fixture.evidence, { exactTransactionInitially: true });
  const result = await replay(fixture, rpc);
  assert.equal(result.transactionHash, INNER_HASH);
  assert.equal(rpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false);
});

test('exact outer transaction without a receipt returns public pending without rebroadcast', async () => {
  const fixture = await signedFixture();
  const rpc = provider({
    eth_getTransactionReceipt: null,
    eth_getTransactionByHash: canonicalOuterTransaction(fixture.evidence),
    eth_getTransactionCount: ['0x7', '0x8'],
  });
  const result = await replay(fixture, rpc, { receiptAttempts: 1 });
  assert.deepEqual(result, {
    outcome: 'PENDING',
    pendingReason: 'OUTER_RECEIPT_PENDING',
    outerTransactionHash: fixture.evidence.outerTransactionHash,
  });
  assert.equal(rpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false);
  assert.equal(JSON.stringify(result).includes(fixture.evidence.rawTransaction), false);
});

test('unavailable receipt or exact-transaction lookups never become healthy pending', async () => {
  const fixture = await signedFixture();
  for (const rpc of [
    provider({
      eth_getTransactionReceipt: new Error('receipt RPC unavailable'),
    }),
    provider({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: new Error('transaction RPC unavailable'),
    }),
  ]) {
    await assert.rejects(
      replay(fixture, rpc, { receiptAttempts: 1 }),
      (error) => error.code === 'DURABLE_WRITE_RECEIPT',
    );
    assert.equal(rpc.calls.some(({ method }) => method === 'eth_sendRawTransaction'), false);
  }
});

test('canonical status-one receipt below a valid finalized head returns public finality pending', async () => {
  const fixture = await signedFixture();
  const result = await replay(fixture, replayProvider(fixture.evidence, {
    receiptInitially: true,
    finalizedNumber: '0x1233',
  }));
  assert.deepEqual(result, {
    outcome: 'PENDING',
    pendingReason: 'OUTER_FINALITY_PENDING',
    outerTransactionHash: fixture.evidence.outerTransactionHash,
    receiptBlockHash: BLOCK_HASH,
    receiptBlockNumber: '4660',
    finalizedHeadBlockNumber: '4659',
  });
  assert.equal(JSON.stringify(result).includes(fixture.evidence.rawTransaction), false);
});

test('a malformed status-one receipt below the finalized head remains a hard identity failure', async () => {
  const fixture = await signedFixture();
  const wrongRecipient = newTransactionReceipt(fixture.evidence);
  wrongRecipient.logs[0].topics[2] = zeroPadValue(
    '0x2222222222222222222222222222222222222222',
    32,
  ).toLowerCase();
  await assert.rejects(
    replay(fixture, replayProvider(fixture.evidence, {
      receiptInitially: true,
      receiptOverride: wrongRecipient,
      finalizedNumber: '0x1233',
    })),
    (error) => error.code === 'DURABLE_WRITE_RECEIPT',
  );
});

test('invalid or unavailable finalized heads and finalized revalidation drift remain hard failures', async () => {
  const fixture = await signedFixture();
  for (const finalizedOverride of [
    null,
    { number: '0x0', hash: FINALIZED_HASH, timestamp: '0x65' },
    { number: '0x1233', hash: `0x${'0'.repeat(64)}`, timestamp: '0x65' },
  ]) {
    await assert.rejects(
      replay(fixture, replayProvider(fixture.evidence, {
        receiptInitially: true,
        finalizedOverride,
      })),
      (error) => error.code === 'DURABLE_WRITE_FINALITY',
    );
  }

  const initialReceipt = newTransactionReceipt(fixture.evidence);
  const changedReceipt = structuredClone(initialReceipt);
  changedReceipt.logs[0].data = '0x01';
  const rpc = provider({
    eth_getTransactionReceipt: [initialReceipt, changedReceipt],
    eth_getTransactionByHash: canonicalOuterTransaction(fixture.evidence),
    eth_getBlockByNumber: ([tag]) => (
      tag === 'finalized'
        ? { number: '0x1235', hash: FINALIZED_HASH, timestamp: '0x65' }
        : canonicalBlock(fixture.evidence)
    ),
  });
  await assert.rejects(
    replay(fixture, rpc),
    (error) => error.code === 'DURABLE_WRITE_FINALITY',
  );
});

test('durable replay quarantines ambiguous finalized events', async () => {
  const fixture = await signedFixture();

  const wrongRecipient = newTransactionReceipt(fixture.evidence);
  wrongRecipient.logs[0].topics[2] = zeroPadValue(
    '0x2222222222222222222222222222222222222222',
    32,
  ).toLowerCase();
  const wrongOutcome = await replay(fixture, replayProvider(fixture.evidence, {
      receiptInitially: true,
      receiptOverride: wrongRecipient,
    }));
  assert.equal(wrongOutcome.outcome, 'OUTER_AMBIGUOUS');
  assert.equal(wrongOutcome.outerAmbiguityEvidence.newTransactionEventCount, '1');

  const zeroInner = newTransactionReceipt(fixture.evidence);
  zeroInner.logs[0].topics[1] = `0x${'0'.repeat(64)}`;
  const zeroOutcome = await replay(fixture, replayProvider(fixture.evidence, {
      receiptInitially: true,
      receiptOverride: zeroInner,
    }));
  assert.equal(zeroOutcome.outcome, 'OUTER_AMBIGUOUS');
});

test('finalized reverted outer transaction returns exact retryable failure evidence', async () => {
  const fixture = await signedFixture();
  const reverted = newTransactionReceipt(fixture.evidence, { status: '0x0', logs: [] });
  const result = await replay(fixture, replayProvider(fixture.evidence, {
    receiptInitially: true,
    receiptOverride: reverted,
  }));
  assert.equal(result.outcome, 'OUTER_FAILURE');
  assert.deepEqual(Object.keys(result.outerFailureEvidence).sort(), [
    'evidenceSha256',
    'failureCode',
    'finalizedHeadBlockNumber',
    'newTransactionEventCount',
    'outerTransactionHash',
    'receiptBlockHash',
    'receiptBlockNumber',
    'receiptCanonical',
    'receiptStatus',
  ].sort());
  assert.equal(result.outerFailureEvidence.receiptStatus, '0');
});

test('broadcaster rejects arbitrary in-memory evidence without LOAD_SIGNED', async () => {
  const fixture = await signedFixture();
  await assert.rejects(broadcastDurableSignedGenlayerWrite({
    operation: fixture.persistedOperation,
    evidence: fixture.evidence,
    provider: replayProvider(fixture.evidence, { receiptInitially: true }),
  }), (error) => error.code === 'DURABLE_WRITE_JOURNAL');
});

test('pinned genlayer-js 1.1.8 transport calls the signer once and never sends raw', {
  concurrency: false,
}, async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../node_modules/genlayer-js/package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(packageJson.version, '1.1.8');
  const wallet = Wallet.createRandom();
  const methods = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let walletSignCalls = 0;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(init.body);
    methods.push(request.method);
    const results = {
      eth_getTransactionCount: '0x7',
      eth_estimateGas: '0xdbba0',
      eth_gasPrice: '0xbebc200',
    };
    if (request.method === 'eth_sendRawTransaction') {
      throw new Error('SDK crossed the pre-broadcast boundary');
    }
    if (!(request.method in results)) throw new Error(`unexpected SDK RPC ${request.method}`);
    return { json: async () => ({ jsonrpc: '2.0', id: request.id, result: results[request.method] }) };
  };
  console.warn = () => {};
  try {
    const operation = preparedOperation(wallet.address);
    const handle = await createDurableSignedGenlayerWrite({
      operation,
      password: 'test-only-password',
      keystorePath: 'ignored',
      readFileImpl: async () => KEYSTORE,
      statImpl: async () => ({ size: Buffer.byteLength(KEYSTORE), isFile: () => true }),
      walletLoader: async () => ({
        address: wallet.address,
        async signTransaction(request) {
          walletSignCalls += 1;
          return wallet.signTransaction(request);
        },
      }),
      provider: signingProvider(),
      clientFactory: createClient,
      rpcUrl: 'https://sdk-characterization.invalid',
      nowSeconds: () => 100,
      beforeSign: async () => {},
    });
    assert.ok(handle);
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
  }
  assert.equal(walletSignCalls, 1);
  assert.equal(methods.filter((method) => method === 'eth_sendRawTransaction').length, 0);
});
