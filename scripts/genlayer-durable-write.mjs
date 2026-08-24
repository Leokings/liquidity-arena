import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  id as ethersId,
} from 'ethers';
import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';

import {
  BRADBURY_CHAIN_ID,
  BRADBURY_CONSENSUS_ADDRESS,
  MAX_KEEPER_WRITE_COST_ATTO,
  MAX_KEEPER_WRITE_GAS,
  MAX_KEEPER_WRITE_GAS_PRICE_WEI,
  assertDurableSignedJournalOperation,
  assertPersistedDurableSignedOperation,
  inspectDurableSignedTransaction,
  normalizeDurableJournalOperation,
} from '../keeper-journal/signed-transaction.mjs';
import { GENLAYER_BRADBURY_RPC_URL } from './genlayer-command.mjs';

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const DEFAULT_ACCOUNT_NAME = 'liquidity-arena-v8-keeper';
const DEFAULT_RECEIPT_ATTEMPTS = 90;
const DEFAULT_RECEIPT_INTERVAL_MS = 2_000;
const DEFAULT_RPC_TIMEOUT_MS = 12_000;
const MIN_VALIDITY_MARGIN_SECONDS = 300n;
const SIGNED_VALIDITY_SECONDS = 24n * 60n * 60n;
const MIN_INITIAL_VALIDITY_SECONDS = 23n * 60n * 60n;
const MAX_KEEPER_KEYSTORE_BYTES = 64 * 1024;
const NEW_TRANSACTION_TOPIC = ethersId('NewTransaction(bytes32,address,address)').toLowerCase();
const PRIVATE_SIGNED_WRITES = new WeakMap();
const ADD_TRANSACTION_V6 = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);

export class DurableGenlayerWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DurableGenlayerWriteError';
    this.code = code;
    Object.assign(this, details);
  }
}

class SignedEnvelopeCaptured extends Error {
  constructor(evidence) {
    super('Signed Bradbury envelope captured before broadcast.');
    this.name = 'SignedEnvelopeCaptured';
    Object.defineProperty(this, 'evidence', { value: evidence, enumerable: false });
  }
}

function refuse(code, message, details = {}) {
  throw new DurableGenlayerWriteError(code, message, details);
}

function address(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!ADDRESS.test(normalized) || normalized === `0x${'0'.repeat(40)}`) {
    refuse('DURABLE_WRITE_IDENTITY', `${label} is invalid`);
  }
  return normalized;
}

function hash(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!HASH.test(normalized)) refuse('DURABLE_WRITE_IDENTITY', `${label} is invalid`);
  return normalized;
}

function quantity(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && QUANTITY.test(value)) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  refuse('DURABLE_WRITE_QUANTITY', `${label} is invalid`);
}

function hexQuantity(value) {
  return `0x${value.toString(16)}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function boundedRpc(provider, method, args, {
  rpcTimeoutMs,
  deadlineAtMs,
  clockMs,
}) {
  const remaining = deadlineAtMs - clockMs();
  if (!(remaining > 0)) {
    refuse('DURABLE_WRITE_DEADLINE', `Bradbury RPC deadline expired before ${method}`);
  }
  const timeoutMs = Math.max(1, Math.min(rpcTimeoutMs, remaining));
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.send(method, args)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DurableGenlayerWriteError(
          'DURABLE_WRITE_RPC_TIMEOUT',
          `Bradbury RPC ${method} exceeded its bounded timeout`,
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withBoundedSdkTransport(task, { rpcTimeoutMs, deadlineAtMs, clockMs }) {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') {
    refuse('DURABLE_WRITE_CLIENT', 'bounded GenLayer HTTP transport is unavailable');
  }
  const boundedFetch = (input, init = {}) => {
    const remaining = deadlineAtMs - clockMs();
    if (!(remaining > 0)) {
      throw new DurableGenlayerWriteError(
        'DURABLE_WRITE_DEADLINE',
        'GenLayer SDK transport deadline expired',
      );
    }
    const timeoutMs = Math.max(1, Math.min(rpcTimeoutMs, remaining));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return originalFetch(input, { ...init, signal });
  };
  globalThis.fetch = boundedFetch;
  try {
    return await task();
  } finally {
    const changed = globalThis.fetch !== boundedFetch;
    globalThis.fetch = originalFetch;
    if (changed) {
      refuse('DURABLE_WRITE_CLIENT', 'global fetch changed during the bounded SDK call');
    }
  }
}

function callArgument(value) {
  const normalized = String(value);
  if (/^(?:0|[1-9]\d*)$/.test(normalized)) {
    const parsed = BigInt(normalized);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed;
  }
  return normalized;
}

function exactGas(request) {
  const values = [request?.gas, request?.gasLimit]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => quantity(value, 'transaction gas'));
  if (values.length === 0 || values.some((value) => value !== values[0])) {
    refuse('DURABLE_WRITE_GAS', 'SDK transaction gas is missing or conflicting');
  }
  return values[0];
}

export function resolveKeeperKeystorePath(environment = process.env) {
  const configured = String(environment.GENLAYER_KEEPER_KEYSTORE_PATH || '').trim();
  return configured || resolve(
    homedir(),
    '.genlayer',
    'keystores',
    `${DEFAULT_ACCOUNT_NAME}.json`,
  );
}

async function loadKeeperWallet({
  keystorePath,
  password,
  expectedSigner,
  readFileImpl,
  statImpl,
  walletLoader,
}) {
  if (typeof password !== 'string' || password.length === 0) {
    refuse('DURABLE_WRITE_KEYSTORE', 'GENLAYER_KEYSTORE_PASSWORD is required');
  }
  let file;
  try {
    file = await statImpl(keystorePath);
  } catch {
    refuse('DURABLE_WRITE_KEYSTORE', 'encrypted keeper keystore metadata could not be read');
  }
  if (!file || typeof file.isFile !== 'function' || file.isFile() !== true
      || !Number.isSafeInteger(file.size) || file.size < 2
      || file.size > MAX_KEEPER_KEYSTORE_BYTES) {
    refuse('DURABLE_WRITE_KEYSTORE', 'keeper keystore must be a bounded regular file');
  }
  let encrypted;
  try {
    encrypted = await readFileImpl(keystorePath, 'utf8');
  } catch {
    refuse('DURABLE_WRITE_KEYSTORE', 'encrypted keeper keystore could not be read');
  }
  if (typeof encrypted !== 'string'
      || Buffer.byteLength(encrypted, 'utf8') !== file.size
      || file.size > MAX_KEEPER_KEYSTORE_BYTES) {
    refuse('DURABLE_WRITE_KEYSTORE', 'keeper keystore changed while it was being read');
  }
  let parsed;
  try {
    parsed = JSON.parse(encrypted);
  } catch {
    refuse('DURABLE_WRITE_KEYSTORE', 'keeper keystore is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || (!parsed.crypto && !parsed.Crypto)) {
    refuse('DURABLE_WRITE_KEYSTORE', 'keeper account is not an encrypted Web3 keystore');
  }
  let wallet;
  try {
    wallet = await walletLoader(encrypted, password);
  } catch {
    refuse('DURABLE_WRITE_KEYSTORE', 'keeper keystore could not be decrypted');
  }
  if (address(wallet?.address, 'decrypted keeper address') !== expectedSigner) {
    refuse('DURABLE_WRITE_KEYSTORE', 'decrypted keeper address does not match the configured signer');
  }
  return wallet;
}

async function freshSigningPreflight({
  provider,
  request,
  expectedSigner,
  rpcPolicy,
  nowSeconds,
}) {
  const to = address(request?.to, 'SDK transaction recipient');
  if (to !== BRADBURY_CONSENSUS_ADDRESS) {
    refuse('DURABLE_WRITE_IDENTITY', 'SDK transaction recipient is not Bradbury consensus');
  }
  const sdkData = String(request?.data ?? '').toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(sdkData) || sdkData.length % 2 !== 0) {
    refuse('DURABLE_WRITE_IDENTITY', 'SDK transaction calldata is malformed');
  }
  const value = quantity(request?.value ?? 0n, 'SDK transaction value');
  if (value !== 0n) refuse('DURABLE_WRITE_IDENTITY', 'keeper writes must have zero outer value');

  let parsed;
  try {
    parsed = ADD_TRANSACTION_V6.parseTransaction({ data: sdkData });
  } catch {
    refuse('DURABLE_WRITE_IDENTITY', 'SDK request is not exact addTransaction v6');
  }
  if (!parsed || parsed.name !== 'addTransaction' || parsed.args.length !== 6
      || ADD_TRANSACTION_V6.encodeFunctionData(parsed.fragment, [...parsed.args]).toLowerCase()
        !== sdkData) {
    refuse('DURABLE_WRITE_IDENTITY', 'SDK addTransaction v6 request is not canonical');
  }
  let latestBlock;
  try {
    latestBlock = await boundedRpc(
      provider,
      'eth_getBlockByNumber',
      ['latest', false],
      rpcPolicy,
    );
  } catch {
    refuse('DURABLE_WRITE_VALIDITY', 'latest Bradbury block is unavailable before signing');
  }
  if (!latestBlock || typeof latestBlock !== 'object') {
    refuse('DURABLE_WRITE_VALIDITY', 'latest Bradbury block is invalid before signing');
  }
  const chainTime = quantity(latestBlock.timestamp, 'latest Bradbury block timestamp');
  const localTime = quantity(nowSeconds(), 'local signing timestamp');
  const validityBase = chainTime > localTime ? chainTime : localTime;
  const validUntil = validityBase + SIGNED_VALIDITY_SECONDS;
  const data = ADD_TRANSACTION_V6.encodeFunctionData(
    parsed.fragment,
    [...parsed.args.slice(0, 5), validUntil],
  ).toLowerCase();
  const validUntilSlotStart = 2 + 8 + (5 * 64);
  const validUntilSlotEnd = validUntilSlotStart + 64;
  if (sdkData.slice(0, validUntilSlotStart) !== data.slice(0, validUntilSlotStart)
      || sdkData.slice(validUntilSlotEnd) !== data.slice(validUntilSlotEnd)) {
    refuse('DURABLE_WRITE_VALIDITY', 'validity rewrite changed addTransaction call material');
  }

  let estimateRaw;
  try {
    estimateRaw = await boundedRpc(provider, 'eth_estimateGas', [{
      from: expectedSigner,
      to,
      data,
      value: '0x0',
    }], rpcPolicy);
  } catch {
    refuse(
      'DURABLE_WRITE_ESTIMATE',
      'independent Bradbury gas estimation failed; the SDK 200000 fallback is prohibited',
      { broadcastAttempted: false },
    );
  }
  const estimate = quantity(estimateRaw, 'independent gas estimate');
  const sdkGasLimit = exactGas(request);
  const gasLimit = sdkGasLimit > estimate ? sdkGasLimit : estimate;
  if (estimate <= 0n || estimate > MAX_KEEPER_WRITE_GAS
      || sdkGasLimit <= 0n || sdkGasLimit === 200_000n || sdkGasLimit > MAX_KEEPER_WRITE_GAS
      || gasLimit > MAX_KEEPER_WRITE_GAS) {
    refuse('DURABLE_WRITE_ESTIMATE', 'SDK gas fallback or keeper gas ceiling is unsafe', {
      broadcastAttempted: false,
    });
  }

  let latestRaw;
  let pendingRaw;
  let balanceRaw;
  try {
    [latestRaw, pendingRaw, balanceRaw] = await Promise.all([
      boundedRpc(provider, 'eth_getTransactionCount', [expectedSigner, 'latest'], rpcPolicy),
      boundedRpc(provider, 'eth_getTransactionCount', [expectedSigner, 'pending'], rpcPolicy),
      boundedRpc(provider, 'eth_getBalance', [expectedSigner, 'pending'], rpcPolicy),
    ]);
  } catch {
    refuse('DURABLE_WRITE_ACCOUNT', 'Bradbury nonce and pending balance could not be verified', {
      broadcastAttempted: false,
    });
  }
  const latest = quantity(latestRaw, 'latest signer nonce');
  const pending = quantity(pendingRaw, 'pending signer nonce');
  const requestedNonce = quantity(request?.nonce, 'SDK transaction nonce');
  const balance = quantity(balanceRaw, 'pending signer balance');
  const gasPrice = quantity(request?.gasPrice, 'SDK transaction gas price');
  const maximumCost = gasLimit * gasPrice;
  if (latest !== pending || requestedNonce !== pending) {
    refuse('DURABLE_WRITE_NONCE', 'keeper signer nonce is not quiescent and exact', {
      broadcastAttempted: false,
    });
  }
  if (gasPrice <= 0n || gasPrice > MAX_KEEPER_WRITE_GAS_PRICE_WEI
      || maximumCost > MAX_KEEPER_WRITE_COST_ATTO || balance < maximumCost) {
    refuse('DURABLE_WRITE_COST', 'keeper write exceeds the gas-price/cost cap or balance', {
      broadcastAttempted: false,
    });
  }
  return Object.freeze({
    gasLimit,
    gasPrice,
    nonce: pending,
    data,
    validityBase,
    validUntil,
  });
}

/**
 * Build and sign the exact GenLayer write without returning the signature to
 * genlayer-js. The local account throws from signTransaction after capturing
 * the bytes, which proves no sendRawTransaction call can occur before the
 * caller durably records them.
 */
export async function createDurableSignedGenlayerWrite({
  operation,
  password,
  keystorePath = resolveKeeperKeystorePath(),
  rpcUrl = GENLAYER_BRADBURY_RPC_URL,
  readFileImpl = readFile,
  statImpl = stat,
  walletLoader = Wallet.fromEncryptedJson,
  provider = new JsonRpcProvider(rpcUrl, Number(BRADBURY_CHAIN_ID)),
  clientFactory = createClient,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  deadlineAtMs = Date.now() + 60_000,
  clockMs = Date.now,
  beforeSign,
} = {}) {
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 250 || rpcTimeoutMs > 30_000
      || typeof deadlineAtMs !== 'number' || Number.isNaN(deadlineAtMs)
      || typeof clockMs !== 'function' || typeof beforeSign !== 'function') {
    refuse('DURABLE_WRITE_POLICY', 'signing RPC timeout or deadline policy is invalid');
  }
  const rpcPolicy = Object.freeze({ rpcTimeoutMs, deadlineAtMs, clockMs });
  const journalIdentity = normalizeDurableJournalOperation(operation);
  const signerAddress = journalIdentity.signerAddress;
  const recipient = journalIdentity.contractAddress;
  const method = journalIdentity.method;
  const canonicalArgs = [...journalIdentity.arguments];
  let walletSignAttempted = false;
  const wallet = await loadKeeperWallet({
    keystorePath,
    password,
    expectedSigner: signerAddress,
    readFileImpl,
    statImpl,
    walletLoader,
  });

  let signCalls = 0;
  const account = {
    address: signerAddress,
    type: 'local',
    async signTransaction(request) {
      signCalls += 1;
      if (signCalls !== 1) {
        refuse('DURABLE_WRITE_MULTIPLE_SIGNATURES', 'one keeper action attempted more than one signature', {
          broadcastAttempted: false,
        });
      }
      const preflight = await freshSigningPreflight({
        provider,
        request,
        expectedSigner: signerAddress,
        rpcPolicy,
        nowSeconds,
      });
      await beforeSign();
      walletSignAttempted = true;
      let raw;
      try {
        raw = await wallet.signTransaction({
          to: request.to,
          data: preflight.data,
          type: 0,
          nonce: Number(preflight.nonce),
          value: 0n,
          gasLimit: preflight.gasLimit,
          gasPrice: preflight.gasPrice,
          chainId: Number(BRADBURY_CHAIN_ID),
        });
      } catch {
        refuse('DURABLE_WRITE_SIGN', 'keeper transaction could not be signed', {
          broadcastAttempted: false,
          walletSignAttempted: true,
        });
      }
      const evidence = inspectDurableSignedTransaction(raw);
      assertDurableSignedJournalOperation(evidence, operation);
      const now = BigInt(nowSeconds());
      const validUntil = BigInt(evidence.validUntil);
      if (now < 0n || validUntil !== preflight.validUntil
          || validUntil < now + MIN_INITIAL_VALIDITY_SECONDS
          || validUntil < preflight.validityBase + MIN_INITIAL_VALIDITY_SECONDS
          || validUntil > preflight.validityBase + SIGNED_VALIDITY_SECONDS) {
        refuse('DURABLE_WRITE_VALIDITY', 'keeper transaction validity window is not the pinned 24-hour window', {
          broadcastAttempted: false,
        });
      }
      throw new SignedEnvelopeCaptured(evidence);
    },
  };

  const client = clientFactory({ chain: testnetBradbury, endpoint: rpcUrl, account });
  if (typeof client?.initializeConsensusSmartContract !== 'function'
      || typeof client?.writeContract !== 'function') {
    refuse('DURABLE_WRITE_CLIENT', 'pinned GenLayer client is missing required write methods', {
      broadcastAttempted: false,
    });
  }
  const invokeSdk = async () => {
    await client.initializeConsensusSmartContract();
    return client.writeContract({
      address: recipient,
      functionName: method,
      args: canonicalArgs.map(callArgument),
      value: 0n,
    });
  };
  try {
    if (clientFactory === createClient) {
      await withBoundedSdkTransport(invokeSdk, rpcPolicy);
    } else {
      await invokeSdk();
    }
  } catch (error) {
    if (error instanceof SignedEnvelopeCaptured) {
      const evidence = error.evidence;
      const handle = Object.freeze({
        protocolVersion: evidence.protocolVersion,
        outerTransactionHash: evidence.outerTransactionHash,
        outerNonce: evidence.outerNonce,
        signerAddress: evidence.signerAddress,
        contractAddress: evidence.contractAddress,
        method: evidence.method,
      });
      PRIVATE_SIGNED_WRITES.set(handle, {
        evidence,
        persisted: null,
        consumed: false,
      });
      return handle;
    }
    if (error instanceof DurableGenlayerWriteError) {
      if (error.walletSignAttempted === undefined) {
        error.walletSignAttempted = walletSignAttempted;
      }
      throw error;
    }
    refuse('DURABLE_WRITE_BUILD', 'GenLayer could not build the keeper signing request', {
      broadcastAttempted: false,
      walletSignAttempted,
    });
  }
  refuse(
    'DURABLE_WRITE_BROADCAST_BOUNDARY',
    'GenLayer write returned without the pre-broadcast capture boundary',
    { broadcastAttempted: false, walletSignAttempted },
  );
}

function exactObjectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('DURABLE_WRITE_JOURNAL', `${label} is malformed`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    refuse('DURABLE_WRITE_JOURNAL', `${label} has unexpected fields`);
  }
}

/**
 * Persist a newly-created private signing capsule. The signed bytes never
 * leave this function except in the authenticated BIND_SIGNED request, and
 * the capsule is not authorized to broadcast unless the exact public journal
 * acknowledgement proves that those bytes were committed.
 */
export async function persistDurableSignedGenlayerWrite({
  signedWrite,
  operation,
  journalSession,
} = {}) {
  const privateWrite = PRIVATE_SIGNED_WRITES.get(signedWrite);
  if (!privateWrite || privateWrite.consumed) {
    refuse('DURABLE_WRITE_CAPABILITY', 'signed write capability is invalid or consumed');
  }
  if (privateWrite.persisted !== null) {
    refuse('DURABLE_WRITE_CAPABILITY', 'signed write capability was already persisted');
  }
  assertDurableSignedJournalOperation(privateWrite.evidence, operation);
  if (operation?.state !== 'PREPARED' || operation?.transactionHash !== null
      || operation?.signedTransactionEvidence !== null
      || operation?.outerTransactionHash !== null) {
    refuse('DURABLE_WRITE_JOURNAL', 'only an exact unsigned PREPARED operation can be bound');
  }
  if (!journalSession || typeof journalSession.bindSigned !== 'function') {
    refuse('DURABLE_WRITE_JOURNAL', 'authenticated BIND_SIGNED is unavailable');
  }
  const response = await journalSession.bindSigned(
    operation.operationId,
    privateWrite.evidence,
  );
  exactObjectKeys(response, ['status', 'action', 'operation'], 'BIND_SIGNED response');
  if (response.status !== 'ok' || response.action !== 'BIND_SIGNED') {
    refuse('DURABLE_WRITE_JOURNAL', 'BIND_SIGNED acknowledgement is invalid');
  }
  const persisted = assertPersistedDurableSignedOperation(
    response.operation,
    privateWrite.evidence,
  );
  privateWrite.persisted = Object.freeze({
    operationId: persisted.identity.operationId,
    revision: persisted.revision,
    evidenceSha256: persisted.evidenceSha256,
    signedAt: persisted.signedAt,
  });
  // The journal is now the sole source of broadcastable bytes. Clear the
  // process-local copy so even the initial path must perform fenced
  // LOAD_SIGNED immediately before any send attempt.
  privateWrite.evidence = null;
  privateWrite.consumed = true;
  return response.operation;
}

function receiptInnerTransaction(receipt, evidence) {
  const receiptBlockHash = hash(receipt?.blockHash, 'outer receipt block hash');
  const receiptBlockNumber = quantity(receipt?.blockNumber, 'outer receipt block number');
  if (receiptBlockHash === `0x${'0'.repeat(64)}`) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer receipt block hash is zero');
  }
  if (!receipt || typeof receipt !== 'object'
      || hash(receipt.transactionHash, 'outer receipt transaction hash')
        !== evidence.outerTransactionHash
      || String(receipt.status ?? '').toLowerCase() !== '0x1'
      || !Array.isArray(receipt.logs)) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer Bradbury receipt is missing, reverted, or mismatched');
  }
  const supported = [];
  const topicAddress = (value, label) => {
    if (!/^0x0{24}[0-9a-f]{40}$/.test(value)) {
      refuse('DURABLE_WRITE_RECEIPT', `${label} is not a canonical padded address topic`);
    }
    return address(`0x${value.slice(-40)}`, label);
  };
  for (const [logIndex, rawLog] of receipt.logs.entries()) {
    if (!rawLog || typeof rawLog !== 'object'
        || String(rawLog.address ?? '').toLowerCase() !== BRADBURY_CONSENSUS_ADDRESS
        || !Array.isArray(rawLog.topics) || rawLog.topics.length === 0) continue;
    const topics = rawLog.topics.map((entry, index) => hash(entry, `receipt topic ${index}`));
    if (topics[0] === NEW_TRANSACTION_TOPIC) {
      if (topics.length !== 4
          || String(rawLog.data ?? '').toLowerCase() !== '0x'
          || topics[1] === `0x${'0'.repeat(64)}`
          || topicAddress(topics[2], 'NewTransaction recipient') !== evidence.contractAddress
          || topicAddress(topics[3], 'NewTransaction activator') === `0x${'0'.repeat(40)}`
          || hash(rawLog.transactionHash, 'consensus event transaction hash')
            !== evidence.outerTransactionHash
          || hash(rawLog.blockHash, 'consensus event block hash') !== receiptBlockHash
          || quantity(rawLog.blockNumber, 'consensus event block number') !== receiptBlockNumber
          || rawLog.logIndex === undefined
          || rawLog.removed !== false) {
        refuse('DURABLE_WRITE_RECEIPT', 'NewTransaction event identity is invalid');
      }
      supported.push(Object.freeze({
        transactionHash: topics[1],
        eventTopic: NEW_TRANSACTION_TOPIC,
        eventActivator: topicAddress(topics[3], 'NewTransaction activator'),
        logIndex: quantity(rawLog.logIndex, `consensus event log index ${logIndex}`).toString(),
      }));
    }
  }
  if (supported.length !== 1) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer receipt must contain exactly one consensus transaction event');
  }
  return supported[0];
}

function exactOuterReceiptStatus(receipt, evidence) {
  if (!receipt || typeof receipt !== 'object'
      || hash(receipt.transactionHash, 'outer receipt transaction hash')
        !== evidence.outerTransactionHash
      || !['0x0', '0x1'].includes(String(receipt.status ?? '').toLowerCase())
      || !Array.isArray(receipt.logs)) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer Bradbury receipt identity or status is invalid');
  }
  return String(receipt.status).toLowerCase() === '0x1' ? '1' : '0';
}

function newTransactionEventCount(receipt) {
  return String(receipt.logs.filter((log) => (
    log && typeof log === 'object'
      && Array.isArray(log.topics)
      && String(log.topics[0] ?? '').toLowerCase() === NEW_TRANSACTION_TOPIC
  )).length);
}

function assertExactOuterTransaction(transaction, evidence) {
  let signed;
  try {
    signed = Transaction.from(evidence.rawTransaction);
  } catch {
    refuse('DURABLE_WRITE_RECEIPT', 'persisted signed transaction cannot be decoded');
  }
  if (!transaction || typeof transaction !== 'object'
      || hash(transaction.hash, 'outer transaction hash') !== evidence.outerTransactionHash
      || address(transaction.from, 'outer transaction sender') !== evidence.signerAddress
      || address(transaction.to, 'outer transaction recipient') !== evidence.consensusAddress
      || quantity(transaction.chainId, 'outer transaction chain id') !== BRADBURY_CHAIN_ID
      || quantity(transaction.nonce, 'outer transaction nonce').toString() !== evidence.outerNonce
      || quantity(transaction.type, 'outer transaction type') !== 0n
      || quantity(transaction.value, 'outer transaction value') !== BigInt(evidence.valueAtto)
      || quantity(transaction.gas ?? transaction.gasLimit, 'outer transaction gas')
        !== signed.gasLimit
      || quantity(transaction.gasPrice, 'outer transaction gas price') !== signed.gasPrice
      || String(transaction.input ?? transaction.data ?? '').toLowerCase()
        !== signed.data.toLowerCase()) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer transaction identity does not match signed bytes');
  }
  return transaction;
}

async function assertCanonicalOuterReceipt(provider, receipt, evidence, rpcPolicy) {
  const blockNumber = quantity(receipt.blockNumber, 'outer receipt block number');
  const blockHash = hash(receipt.blockHash, 'outer receipt block hash');
  if (blockHash === `0x${'0'.repeat(64)}`) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer receipt block hash is zero');
  }
  const receiptTransactionIndex = quantity(
    receipt.transactionIndex,
    'outer receipt transaction index',
  );
  let transaction;
  let block;
  try {
    [transaction, block] = await Promise.all([
      boundedRpc(
        provider,
        'eth_getTransactionByHash',
        [evidence.outerTransactionHash],
        rpcPolicy,
      ),
      boundedRpc(
        provider,
        'eth_getBlockByNumber',
        [hexQuantity(blockNumber), false],
        rpcPolicy,
      ),
    ]);
  } catch {
    refuse('DURABLE_WRITE_RECEIPT', 'outer transaction or canonical block is unavailable');
  }
  assertExactOuterTransaction(transaction, evidence);
  if (quantity(transaction.blockNumber, 'outer transaction block number') !== blockNumber
      || hash(transaction.blockHash, 'outer transaction block hash') !== blockHash
      || quantity(transaction.transactionIndex, 'outer transaction index')
        !== receiptTransactionIndex) {
    refuse('DURABLE_WRITE_RECEIPT', 'canonical outer transaction identity does not match signed bytes');
  }
  if (!block || typeof block !== 'object'
      || quantity(block.number, 'canonical block number') !== blockNumber
      || hash(block.hash, 'canonical block hash') !== blockHash
      || !Array.isArray(block.transactions)
      || receiptTransactionIndex > BigInt(Number.MAX_SAFE_INTEGER)
      || typeof block.transactions[Number(receiptTransactionIndex)] !== 'string'
      || hash(
        block.transactions[Number(receiptTransactionIndex)],
        'canonical block transaction hash',
      ) !== evidence.outerTransactionHash
      || block.transactions.filter(
        (entry) => String(entry).toLowerCase() === evidence.outerTransactionHash,
      ).length !== 1) {
    refuse('DURABLE_WRITE_RECEIPT', 'outer receipt is not included in the canonical requested block');
  }
  return Object.freeze({ blockNumber: blockNumber.toString(), blockHash });
}

async function assertReplayValidityMargin(provider, evidence, clockSeconds, rpcPolicy) {
  let latestBlock;
  try {
    latestBlock = await boundedRpc(
      provider,
      'eth_getBlockByNumber',
      ['latest', false],
      rpcPolicy,
    );
  } catch {
    refuse('DURABLE_WRITE_VALIDITY', 'latest Bradbury block time is unavailable');
  }
  if (!latestBlock || typeof latestBlock !== 'object') {
    refuse('DURABLE_WRITE_VALIDITY', 'latest Bradbury block response is invalid');
  }
  const chainTime = quantity(latestBlock.timestamp, 'latest Bradbury block timestamp');
  const localTime = BigInt(clockSeconds());
  if (localTime < 0n) refuse('DURABLE_WRITE_VALIDITY', 'local replay time is invalid');
  const current = chainTime > localTime ? chainTime : localTime;
  if (BigInt(evidence.validUntil) <= current + MIN_VALIDITY_MARGIN_SECONDS) {
    refuse(
      'DURABLE_WRITE_EXPIRED',
      'persisted signed transaction lacks the required five-minute validity margin',
    );
  }
}

async function assertFinalizedCanonicalReceipt({
  provider,
  evidence,
  receipt,
  canonicalOuter,
  rpcPolicy,
}) {
  let finalizedHead;
  try {
    finalizedHead = await boundedRpc(
      provider,
      'eth_getBlockByNumber',
      ['finalized', false],
      rpcPolicy,
    );
  } catch {
    refuse('DURABLE_WRITE_FINALITY', 'finalized Bradbury EVM head is unavailable');
  }
  if (!finalizedHead || typeof finalizedHead !== 'object') {
    refuse('DURABLE_WRITE_FINALITY', 'finalized Bradbury EVM head is invalid');
  }
  const finalizedHeadBlockNumber = quantity(
    finalizedHead.number,
    'finalized Bradbury EVM head number',
  );
  if (hash(finalizedHead.hash, 'finalized Bradbury EVM head hash')
      === `0x${'0'.repeat(64)}`) {
    refuse('DURABLE_WRITE_FINALITY', 'finalized Bradbury EVM head hash is zero');
  }
  if (finalizedHeadBlockNumber < BigInt(canonicalOuter.blockNumber)) {
    refuse('DURABLE_WRITE_FINALITY', 'outer receipt block is not finalized on Bradbury EVM');
  }

  // Re-read the exact receipt, outer transaction, and block after observing a
  // sufficiently advanced finalized head. This closes the reorg window before
  // the journal irreversibly binds the inner transaction id.
  const revalidatedReceipt = await getOuterReceipt(provider, evidence, {
    attempts: 1,
    intervalMs: 0,
    sleep: async () => {},
    rpcPolicy,
  });
  if (!revalidatedReceipt) {
    refuse('DURABLE_WRITE_FINALITY', 'finalized outer receipt disappeared during revalidation');
  }
  const revalidatedOuter = await assertCanonicalOuterReceipt(
    provider,
    revalidatedReceipt,
    evidence,
    rpcPolicy,
  );
  if (hash(receipt.blockHash, 'initial outer receipt block hash') !== revalidatedOuter.blockHash
      || quantity(receipt.blockNumber, 'initial outer receipt block number').toString()
        !== revalidatedOuter.blockNumber
      || JSON.stringify(canonicalOuter) !== JSON.stringify(revalidatedOuter)
      || hash(receipt.transactionHash, 'initial outer receipt transaction hash')
        !== hash(revalidatedReceipt.transactionHash, 'revalidated outer receipt transaction hash')
      || String(receipt.status ?? '').toLowerCase()
        !== String(revalidatedReceipt.status ?? '').toLowerCase()
      || JSON.stringify(receipt.logs) !== JSON.stringify(revalidatedReceipt.logs)) {
    refuse('DURABLE_WRITE_FINALITY', 'finalized outer receipt identity changed during revalidation');
  }
  return Object.freeze({
    finalizedHeadBlockNumber: finalizedHeadBlockNumber.toString(),
    canonicalOuter: revalidatedOuter,
    receipt: revalidatedReceipt,
  });
}

async function getOuterReceipt(provider, evidence, {
  attempts,
  intervalMs,
  sleep,
  rpcPolicy,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (rpcPolicy.deadlineAtMs - rpcPolicy.clockMs() <= 0) {
      refuse('DURABLE_WRITE_DEADLINE', 'receipt polling exceeded the keeper deadline');
    }
    let receipt;
    try {
      receipt = await boundedRpc(
        provider,
        'eth_getTransactionReceipt',
        [evidence.outerTransactionHash],
        rpcPolicy,
      );
    } catch {
      receipt = null;
    }
    if (receipt) return receipt;
    if (attempt + 1 < attempts) {
      const remaining = rpcPolicy.deadlineAtMs - rpcPolicy.clockMs();
      if (remaining <= intervalMs) {
        refuse('DURABLE_WRITE_DEADLINE', 'receipt polling cannot sleep past the keeper deadline');
      }
      await sleep(intervalMs);
    }
  }
  return null;
}

/**
 * Broadcast or recover an exact journal-persisted signed transaction. Every
 * path renews the lease and performs authenticated LOAD_SIGNED; this API
 * intentionally has no arbitrary `evidence` or private-capsule argument.
 */
export async function broadcastDurableSignedGenlayerWrite({
  operation,
  journalSession,
  rpcUrl = GENLAYER_BRADBURY_RPC_URL,
  provider = new JsonRpcProvider(rpcUrl, Number(BRADBURY_CHAIN_ID)),
  receiptAttempts = DEFAULT_RECEIPT_ATTEMPTS,
  receiptIntervalMs = DEFAULT_RECEIPT_INTERVAL_MS,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  clockSeconds = () => Math.floor(Date.now() / 1_000),
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  deadlineAtMs = Date.now() + 4 * 60_000,
  clockMs = Date.now,
} = {}) {
  if (!journalSession || typeof journalSession.renew !== 'function'
      || typeof journalSession.loadSigned !== 'function') {
    refuse('DURABLE_WRITE_JOURNAL', 'broadcast requires renewed authenticated LOAD_SIGNED');
  }
  const loadPersistedEvidence = async () => {
    await journalSession.renew();
    const response = await journalSession.loadSigned(operation?.operationId);
    exactObjectKeys(
      response,
      ['status', 'action', 'operationId', 'fencingToken', 'evidence'],
      'LOAD_SIGNED response',
    );
    const activeFencingToken = String(journalSession.lease?.fencingToken ?? '');
    if (response.status !== 'ok' || response.action !== 'LOAD_SIGNED'
        || response.operationId !== operation?.operationId
        || !/^[1-9]\d*$/.test(String(response.fencingToken ?? ''))
        || String(response.fencingToken) !== activeFencingToken) {
      refuse('DURABLE_WRITE_JOURNAL', 'LOAD_SIGNED response is not bound to the active fenced lease');
    }
    return assertPersistedDurableSignedOperation(operation, response.evidence).evidence;
  };
  let evidence = await loadPersistedEvidence();
  if (!Number.isSafeInteger(receiptAttempts) || receiptAttempts < 1 || receiptAttempts > 600
      || !Number.isSafeInteger(receiptIntervalMs) || receiptIntervalMs < 0 || receiptIntervalMs > 60_000
      || !Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 250 || rpcTimeoutMs > 30_000
      || typeof deadlineAtMs !== 'number' || Number.isNaN(deadlineAtMs)
      || typeof clockMs !== 'function') {
    refuse('DURABLE_WRITE_POLICY', 'outer receipt polling policy is invalid');
  }
  const rpcPolicy = Object.freeze({ rpcTimeoutMs, deadlineAtMs, clockMs });
  let exactOuterObserved = false;
  let broadcastHashMismatch = false;
  let receipt = await getOuterReceipt(provider, evidence, {
    attempts: 1,
    intervalMs: 0,
    sleep,
    rpcPolicy,
  });
  if (!receipt) {
    let transaction;
    try {
      transaction = await boundedRpc(
        provider,
        'eth_getTransactionByHash',
        [evidence.outerTransactionHash],
        rpcPolicy,
      );
    } catch {
      transaction = null;
    }
    if (transaction) assertExactOuterTransaction(transaction, evidence);
    exactOuterObserved = transaction !== null;
    if (!transaction) {
      await assertReplayValidityMargin(provider, evidence, clockSeconds, rpcPolicy);
      const reloadedEvidence = await loadPersistedEvidence();
      if (sha256(JSON.stringify(reloadedEvidence)) !== sha256(JSON.stringify(evidence))
          || reloadedEvidence.outerTransactionHash !== evidence.outerTransactionHash) {
        refuse('DURABLE_WRITE_JOURNAL', 'persisted signed evidence changed before broadcast');
      }
      evidence = reloadedEvidence;
      try {
        const returnedHash = await boundedRpc(
          provider,
          'eth_sendRawTransaction',
          [evidence.rawTransaction],
          rpcPolicy,
        );
        broadcastHashMismatch = String(returnedHash ?? '').toLowerCase()
          !== evidence.outerTransactionHash;
      } catch {
        // A timeout, "already known", or nonce race is resolved only through
        // the deterministic outer hash below. Never construct another tx.
      }
    }
    receipt = await getOuterReceipt(provider, evidence, {
      attempts: receiptAttempts,
      intervalMs: receiptIntervalMs,
      sleep,
      rpcPolicy,
    });
  }
  if (!receipt) {
    let exactTransaction;
    try {
      exactTransaction = await boundedRpc(
        provider,
        'eth_getTransactionByHash',
        [evidence.outerTransactionHash],
        rpcPolicy,
      );
    } catch {
      exactTransaction = null;
    }
    if (exactTransaction) assertExactOuterTransaction(exactTransaction, evidence);
    exactOuterObserved ||= exactTransaction !== null;
    let latest;
    let pending;
    try {
      [latest, pending] = await Promise.all([
        boundedRpc(
          provider,
          'eth_getTransactionCount',
          [evidence.signerAddress, 'latest'],
          rpcPolicy,
        ),
        boundedRpc(
          provider,
          'eth_getTransactionCount',
          [evidence.signerAddress, 'pending'],
          rpcPolicy,
        ),
      ]);
    } catch {
      refuse('DURABLE_WRITE_PENDING', 'exact signed transaction has no receipt and nonce state is unavailable');
    }
    const nonce = BigInt(evidence.outerNonce);
    if (broadcastHashMismatch) {
      refuse(
        'DURABLE_WRITE_BROADCAST_HASH_MISMATCH',
        'Bradbury returned a different hash and the exact persisted outer receipt is absent',
      );
    }
    if (!exactOuterObserved && (quantity(latest, 'latest nonce after replay') > nonce
        || quantity(pending, 'pending nonce after replay') > nonce)) {
      refuse('DURABLE_WRITE_NONCE_CONSUMED', 'signed nonce was consumed without the exact outer receipt');
    }
    refuse('DURABLE_WRITE_PENDING', 'exact signed transaction is still pending without a receipt');
  }
  const canonicalOuter = await assertCanonicalOuterReceipt(
    provider,
    receipt,
    evidence,
    rpcPolicy,
  );
  const receiptStatus = exactOuterReceiptStatus(receipt, evidence);
  const finalized = await assertFinalizedCanonicalReceipt({
    provider,
    evidence,
    receipt,
    canonicalOuter,
    rpcPolicy,
  });
  const finalizedReceiptStatus = exactOuterReceiptStatus(finalized.receipt, evidence);
  if (receiptStatus !== finalizedReceiptStatus) {
    refuse('DURABLE_WRITE_FINALITY', 'outer receipt status changed during finality revalidation');
  }
  const signedEvidenceSha256 = sha256(JSON.stringify(evidence));
  if (receiptStatus === '0') {
    if (finalized.receipt.logs.length !== 0) {
      refuse('DURABLE_WRITE_RECEIPT', 'reverted outer receipt unexpectedly contains logs');
    }
    return Object.freeze({
      outcome: 'OUTER_FAILURE',
      outerFailureEvidence: Object.freeze({
        outerTransactionHash: evidence.outerTransactionHash,
        receiptBlockHash: finalized.canonicalOuter.blockHash,
        receiptBlockNumber: finalized.canonicalOuter.blockNumber,
        finalizedHeadBlockNumber: finalized.finalizedHeadBlockNumber,
        receiptStatus: '0',
        receiptCanonical: true,
        newTransactionEventCount: '0',
        failureCode: 'OUTER_RECEIPT_REVERTED',
        evidenceSha256: signedEvidenceSha256,
      }),
    });
  }
  let consensusEvent;
  try {
    consensusEvent = receiptInnerTransaction(finalized.receipt, evidence);
  } catch (error) {
    if (!(error instanceof DurableGenlayerWriteError)) throw error;
    return Object.freeze({
      outcome: 'OUTER_AMBIGUOUS',
      outerAmbiguityEvidence: Object.freeze({
        outerTransactionHash: evidence.outerTransactionHash,
        receiptBlockHash: finalized.canonicalOuter.blockHash,
        receiptBlockNumber: finalized.canonicalOuter.blockNumber,
        finalizedHeadBlockNumber: finalized.finalizedHeadBlockNumber,
        receiptStatus: '1',
        receiptCanonical: true,
        newTransactionEventCount: newTransactionEventCount(finalized.receipt),
        receiptIdentityVerified: false,
        ambiguityCode: 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS',
        evidenceSha256: signedEvidenceSha256,
      }),
    });
  }
  const submissionEvidence = Object.freeze({
    transactionHash: consensusEvent.transactionHash,
    outerTransactionHash: evidence.outerTransactionHash,
    receiptBlockHash: finalized.canonicalOuter.blockHash,
    receiptBlockNumber: finalized.canonicalOuter.blockNumber,
    finalizedHeadBlockNumber: finalized.finalizedHeadBlockNumber,
    eventTopic: consensusEvent.eventTopic,
    eventActivator: consensusEvent.eventActivator,
    logIndex: consensusEvent.logIndex,
    receiptIdentityVerified: true,
    evidenceSha256: signedEvidenceSha256,
  });
  return Object.freeze({
    outcome: 'SUBMITTED',
    transactionHash: consensusEvent.transactionHash,
    submissionEvidence,
  });
}
