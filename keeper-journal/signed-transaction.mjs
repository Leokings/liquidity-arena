import { createHash } from 'node:crypto';

import {
  Interface,
  Transaction,
  decodeRlp,
  getBytes,
  keccak256,
} from 'ethers';
import { abi as genlayerAbi } from 'genlayer-js';

export const DURABLE_SIGNING_PROTOCOL = 'BRADBURY_DURABLE_RAW_V1';
export const BRADBURY_CHAIN_ID = 4_221n;
export const BRADBURY_CONSENSUS_ADDRESS = '0x0112bf6e83497965a5fdd6dad1e447a6e004271d';
export const BRADBURY_INITIAL_VALIDATORS = 5n;
export const BRADBURY_MAX_ROTATIONS = 3n;
// Keep the complete authenticated journal request below its 16 KiB transport
// ceiling, including the duplicated decoded evidence and request identity.
export const MAX_DURABLE_RAW_TRANSACTION_BYTES = 4 * 1024;
export const MAX_KEEPER_WRITE_GAS = 5_000_000n;
export const MAX_KEEPER_WRITE_GAS_PRICE_WEI = 1_000_000_000n;
export const MAX_KEEPER_WRITE_COST_ATTO = 5_000_000_000_000_000n;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const METHOD = /^[a-z][a-z0-9_]{0,79}$/;
const RAW_TRANSACTION = /^0x[0-9a-f]+$/;
const OPERATION_ID = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const EPOCH_METHODS = new Set([
  'create_epoch', 'resolve_epoch', 'activate_timeout_refund',
]);
const PAYOUT_METHODS = new Set([
  'retry_prepare_payout', 'dispatch_payout', 'retry_payout',
  'confirm_payout', 'refresh_payout_withdrawal',
]);

const ADD_TRANSACTION_V6 = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);

const EVIDENCE_KEYS = Object.freeze([
  'arguments',
  'calldataSha256',
  'chainId',
  'consensusAddress',
  'contractAddress',
  'gasLimit',
  'gasPriceWei',
  'method',
  'outerNonce',
  'outerTransactionHash',
  'protocolVersion',
  'rawTransaction',
  'signerAddress',
  'validUntil',
  'valueAtto',
]);
const REDACTED_EVIDENCE_KEYS = Object.freeze(
  EVIDENCE_KEYS.filter((key) => key !== 'rawTransaction'),
);

function refuse(message) {
  throw new Error(`Durable Bradbury transaction refused: ${message}`);
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    refuse(`${label} has unexpected fields`);
  }
}

function address(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!ADDRESS.test(normalized) || normalized === `0x${'0'.repeat(40)}`) {
    refuse(`${label} is not a canonical nonzero address`);
  }
  return normalized;
}

function hash(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!HASH.test(normalized)) refuse(`${label} is not a canonical hash`);
  return normalized;
}

function decimal(value, label) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    refuse(`${label} is not a canonical unsigned decimal string`);
  }
  return value;
}

function normalizeArgument(value, label) {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  refuse(`${label} is not a supported keeper argument`);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactTimestamp(value, label) {
  const normalized = String(value ?? '');
  if (!TIMESTAMP.test(normalized)
      || Number.isNaN(Date.parse(normalized))
      || new Date(normalized).toISOString() !== normalized) {
    refuse(`${label} is not an exact millisecond UTC timestamp`);
  }
  return normalized;
}

function canonicalJournalOperation(operation) {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    refuse('keeper operation must be an object');
  }
  const deploymentAlias = String(operation.deploymentAlias ?? '');
  const network = String(operation.network ?? '');
  const chainId = decimal(operation.chainId, 'operation chainId');
  const signerAddress = address(operation.signerAddress, 'operation signerAddress');
  const contractAddress = address(operation.contractAddress, 'operation contractAddress');
  const subjectType = String(operation.subjectType ?? '');
  const subjectId = String(operation.subjectId ?? '');
  const method = String(operation.method ?? '');
  const args = Array.isArray(operation.args)
    ? operation.args.map((entry, index) => normalizeArgument(entry, `operation args[${index}]`))
    : refuse('operation args must be an array');
  const valueAtto = decimal(operation.valueAtto, 'operation valueAtto');
  if (deploymentAlias !== 'v8' || network !== 'bradbury'
      || chainId !== BRADBURY_CHAIN_ID.toString() || valueAtto !== '0'
      || !['epoch', 'payout'].includes(subjectType)
      || !METHOD.test(method) || args.length !== 1 || args[0] !== subjectId
      || (subjectType === 'epoch' && !EPOCH_METHODS.has(method))
      || (subjectType === 'payout' && !PAYOUT_METHODS.has(method))) {
    refuse('keeper operation scope or logical call identity is invalid');
  }
  if (subjectType === 'epoch') {
    if (!DECIMAL.test(subjectId) || BigInt(subjectId) <= 0n || BigInt(subjectId) % 3_600n !== 0n) {
      refuse('keeper epoch subject identity is invalid');
    }
  } else if (!/^[0-9a-f]{64}$/.test(subjectId)) {
    refuse('keeper payout subject identity is invalid');
  }
  const logicalMaterial = {
    chainId,
    contractAddress,
    subjectType,
    subjectId,
    method,
    args,
    valueAtto,
  };
  const logicalOperationId = sha256Hex(JSON.stringify(logicalMaterial));
  const attemptNumber = decimal(operation.attemptNumber, 'operation attemptNumber');
  if (BigInt(attemptNumber) === 0n) refuse('operation attemptNumber must be positive');
  const expectedAttemptId = attemptNumber === '1'
    ? logicalOperationId
    : sha256Hex(`${logicalOperationId}:${attemptNumber}`);
  const operationId = String(operation.operationId ?? '').toLowerCase();
  const statedLogicalId = String(operation.logicalOperationId ?? '').toLowerCase();
  const retryOfOperationId = operation.retryOfOperationId === null
    ? null
    : String(operation.retryOfOperationId ?? '').toLowerCase();
  const previousAttempt = (BigInt(attemptNumber) - 1n).toString();
  const expectedRetryId = attemptNumber === '1'
    ? null
    : (previousAttempt === '1'
      ? logicalOperationId
      : sha256Hex(`${logicalOperationId}:${previousAttempt}`));
  if (!OPERATION_ID.test(operationId) || !OPERATION_ID.test(statedLogicalId)
      || operationId !== expectedAttemptId || statedLogicalId !== logicalOperationId
      || retryOfOperationId !== expectedRetryId) {
    refuse('keeper operation attempt or logical operation identity is invalid');
  }
  return Object.freeze({
    operationId,
    logicalOperationId,
    attemptNumber,
    deploymentAlias,
    network,
    chainId,
    signerAddress,
    contractAddress,
    subjectType,
    subjectId,
    method,
    arguments: Object.freeze(args),
    valueAtto,
  });
}

export function normalizeDurableJournalOperation(operation) {
  return canonicalJournalOperation(operation);
}

function decodedCall(value) {
  let decoded;
  try {
    decoded = genlayerAbi.calldata.decode(getBytes(value));
  } catch {
    refuse('inner GenLayer calldata cannot be decoded');
  }
  if (!(decoded instanceof Map)
      || decoded.size !== 2
      || !decoded.has('method')
      || !decoded.has('args')) {
    refuse('inner GenLayer calldata does not have the exact method/args shape');
  }
  let canonical;
  try {
    canonical = Buffer.from(genlayerAbi.calldata.encode(decoded));
  } catch {
    refuse('inner GenLayer calldata cannot be canonically re-encoded');
  }
  if (!canonical.equals(Buffer.from(String(value).slice(2), 'hex'))) {
    refuse('inner GenLayer calldata is not canonical');
  }
  const method = String(decoded.get('method') ?? '');
  const args = decoded.get('args');
  if (!METHOD.test(method) || !Array.isArray(args)) {
    refuse('inner GenLayer call identity is invalid');
  }
  return Object.freeze({
    method,
    arguments: Object.freeze(args.map((entry, index) => normalizeArgument(
      entry,
      `inner GenLayer argument ${index}`,
    ))),
  });
}

/**
 * Decode and independently verify the exact signed Bradbury outer envelope.
 * The returned object is the only evidence shape accepted by the keeper
 * journal. It contains no private key or keystore material; the raw bytes are
 * already signed and can only submit this exact call at this exact nonce.
 */
export function inspectDurableSignedTransaction(rawValue) {
  const rawTransaction = String(rawValue ?? '').toLowerCase();
  if (!RAW_TRANSACTION.test(rawTransaction)
      || rawTransaction.length % 2 !== 0
      || (rawTransaction.length - 2) / 2 > MAX_DURABLE_RAW_TRANSACTION_BYTES) {
    refuse('raw transaction is malformed or too large');
  }

  let transaction;
  try {
    transaction = Transaction.from(rawTransaction);
  } catch {
    refuse('raw transaction cannot be decoded');
  }
  const outerTransactionHash = hash(transaction.hash, 'outer transaction hash');
  if (!transaction.signature
      || keccak256(rawTransaction).toLowerCase() !== outerTransactionHash
      || transaction.type !== 0
      || transaction.chainId !== BRADBURY_CHAIN_ID
      || transaction.value !== 0n
      || transaction.gasPrice === null
      || transaction.gasPrice <= 0n
      || transaction.gasLimit <= 0n) {
    refuse('signed envelope is not the exact Bradbury legacy transaction shape');
  }
  if (transaction.gasLimit > MAX_KEEPER_WRITE_GAS
      || transaction.gasPrice > MAX_KEEPER_WRITE_GAS_PRICE_WEI
      || transaction.gasLimit * transaction.gasPrice > MAX_KEEPER_WRITE_COST_ATTO) {
    refuse('signed envelope exceeds the keeper gas or cost ceiling');
  }

  const signerAddress = address(transaction.from, 'outer signer');
  const consensusAddress = address(transaction.to, 'outer recipient');
  if (consensusAddress !== BRADBURY_CONSENSUS_ADDRESS) {
    refuse('outer recipient is not the Bradbury consensus contract');
  }

  let outer;
  try {
    outer = ADD_TRANSACTION_V6.parseTransaction({ data: transaction.data });
  } catch {
    refuse('outer calldata is not addTransaction v6');
  }
  if (!outer || outer.name !== 'addTransaction' || outer.fragment.inputs.length !== 6) {
    refuse('outer calldata is not addTransaction v6');
  }
  const canonicalOuter = ADD_TRANSACTION_V6.encodeFunctionData(
    outer.fragment,
    Array.from(outer.args),
  ).toLowerCase();
  if (canonicalOuter !== transaction.data.toLowerCase()) {
    refuse('outer addTransaction calldata is not canonical');
  }

  const callSender = address(outer.args[0], 'addTransaction sender');
  const contractAddress = address(outer.args[1], 'addTransaction recipient');
  if (callSender !== signerAddress
      || BigInt(outer.args[2]) !== BRADBURY_INITIAL_VALIDATORS
      || BigInt(outer.args[3]) !== BRADBURY_MAX_ROTATIONS) {
    refuse('addTransaction identity or validator policy drifted');
  }
  const transactionData = String(outer.args[4]).toLowerCase();
  let inner;
  try {
    inner = decodeRlp(transactionData);
  } catch {
    refuse('inner consensus transaction is not canonical RLP');
  }
  if (!Array.isArray(inner)
      || inner.length !== 2
      || typeof inner[0] !== 'string'
      || String(inner[1]).toLowerCase() !== '0x00') {
    refuse('inner consensus transaction is not an exact full-consensus call');
  }
  const call = decodedCall(String(inner[0]).toLowerCase());

  return Object.freeze({
    protocolVersion: DURABLE_SIGNING_PROTOCOL,
    rawTransaction,
    outerTransactionHash,
    outerNonce: String(transaction.nonce),
    chainId: BRADBURY_CHAIN_ID.toString(),
    signerAddress,
    consensusAddress,
    contractAddress,
    method: call.method,
    arguments: call.arguments,
    valueAtto: transaction.value.toString(),
    gasLimit: transaction.gasLimit.toString(),
    gasPriceWei: transaction.gasPrice.toString(),
    validUntil: BigInt(outer.args[5]).toString(),
    calldataSha256: sha256Hex(Buffer.from(transaction.data.slice(2), 'hex')),
  });
}

export function normalizeDurableSignedEvidence(value) {
  exactObject(value, EVIDENCE_KEYS, 'signed transaction evidence');
  const inspected = inspectDurableSignedTransaction(value.rawTransaction);
  const normalized = {
    ...inspected,
    protocolVersion: String(value.protocolVersion ?? ''),
    outerTransactionHash: hash(value.outerTransactionHash, 'outerTransactionHash'),
    outerNonce: decimal(value.outerNonce, 'outerNonce'),
    chainId: decimal(value.chainId, 'chainId'),
    signerAddress: address(value.signerAddress, 'signerAddress'),
    consensusAddress: address(value.consensusAddress, 'consensusAddress'),
    contractAddress: address(value.contractAddress, 'contractAddress'),
    method: String(value.method ?? ''),
    arguments: Object.freeze(Array.isArray(value.arguments)
      ? value.arguments.map((entry, index) => normalizeArgument(entry, `arguments[${index}]`))
      : refuse('arguments must be an array')),
    valueAtto: decimal(value.valueAtto, 'valueAtto'),
    gasLimit: decimal(value.gasLimit, 'gasLimit'),
    gasPriceWei: decimal(value.gasPriceWei, 'gasPriceWei'),
    validUntil: decimal(value.validUntil, 'validUntil'),
    calldataSha256: String(value.calldataSha256 ?? '').toLowerCase(),
  };
  if (normalized.protocolVersion !== DURABLE_SIGNING_PROTOCOL
      || !/^[0-9a-f]{64}$/.test(normalized.calldataSha256)) {
    refuse('signed transaction evidence version or calldata digest is invalid');
  }
  for (const key of EVIDENCE_KEYS) {
    if (key === 'arguments') {
      if (JSON.stringify(normalized.arguments) !== JSON.stringify(inspected.arguments)) {
        refuse('signed transaction evidence arguments do not match the raw bytes');
      }
    } else if (normalized[key] !== inspected[key]) {
      refuse(`signed transaction evidence ${key} does not match the raw bytes`);
    }
  }
  return Object.freeze(normalized);
}

export function durableSignedEvidenceSha256(value) {
  return sha256Hex(JSON.stringify(normalizeDurableSignedEvidence(value)));
}

export function redactDurableSignedEvidence(value) {
  const evidence = normalizeDurableSignedEvidence(value);
  return Object.freeze(Object.fromEntries(
    REDACTED_EVIDENCE_KEYS.map((key) => [key, evidence[key]]),
  ));
}

export function normalizeRedactedDurableSignedEvidence(value) {
  exactObject(value, REDACTED_EVIDENCE_KEYS, 'redacted signed transaction evidence');
  const normalized = Object.freeze({
    protocolVersion: String(value.protocolVersion ?? ''),
    outerTransactionHash: hash(value.outerTransactionHash, 'outerTransactionHash'),
    outerNonce: decimal(value.outerNonce, 'outerNonce'),
    chainId: decimal(value.chainId, 'chainId'),
    signerAddress: address(value.signerAddress, 'signerAddress'),
    consensusAddress: address(value.consensusAddress, 'consensusAddress'),
    contractAddress: address(value.contractAddress, 'contractAddress'),
    method: String(value.method ?? ''),
    arguments: Object.freeze(Array.isArray(value.arguments)
      ? value.arguments.map((entry, index) => normalizeArgument(entry, `arguments[${index}]`))
      : refuse('arguments must be an array')),
    valueAtto: decimal(value.valueAtto, 'valueAtto'),
    gasLimit: decimal(value.gasLimit, 'gasLimit'),
    gasPriceWei: decimal(value.gasPriceWei, 'gasPriceWei'),
    validUntil: decimal(value.validUntil, 'validUntil'),
    calldataSha256: String(value.calldataSha256 ?? '').toLowerCase(),
  });
  if (normalized.protocolVersion !== DURABLE_SIGNING_PROTOCOL
      || normalized.chainId !== BRADBURY_CHAIN_ID.toString()
      || normalized.consensusAddress !== BRADBURY_CONSENSUS_ADDRESS
      || normalized.valueAtto !== '0'
      || !METHOD.test(normalized.method)
      || !/^[0-9a-f]{64}$/.test(normalized.calldataSha256)) {
    refuse('redacted signed transaction evidence is invalid');
  }
  return normalized;
}

export function assertSignedEvidenceMatchesOperation(evidenceValue, operation) {
  const evidence = normalizeDurableSignedEvidence(evidenceValue);
  const expectedSigner = address(operation?.signerAddress, 'operation signerAddress');
  const expectedContract = address(operation?.contractAddress, 'operation contractAddress');
  const expectedMethod = String(operation?.method ?? '');
  const expectedArguments = Array.isArray(operation?.args)
    ? operation.args.map((entry, index) => normalizeArgument(entry, `operation args[${index}]`))
    : refuse('operation args must be an array');
  if (evidence.signerAddress !== expectedSigner
      || evidence.contractAddress !== expectedContract
      || evidence.method !== expectedMethod
      || JSON.stringify(evidence.arguments) !== JSON.stringify(expectedArguments)) {
    refuse('signed transaction evidence does not match the keeper operation');
  }
  return evidence;
}

export function assertDurableSignedJournalOperation(evidenceValue, operation) {
  const evidence = normalizeDurableSignedEvidence(evidenceValue);
  const identity = canonicalJournalOperation(operation);
  if (evidence.chainId !== identity.chainId
      || evidence.signerAddress !== identity.signerAddress
      || evidence.contractAddress !== identity.contractAddress
      || evidence.method !== identity.method
      || evidence.valueAtto !== identity.valueAtto
      || JSON.stringify(evidence.arguments) !== JSON.stringify(identity.arguments)) {
    refuse('signed transaction evidence does not match the exact journal operation');
  }
  return Object.freeze({ evidence, identity });
}

export function assertPersistedDurableSignedOperation(operation, evidenceValue) {
  const { evidence, identity } = assertDurableSignedJournalOperation(evidenceValue, operation);
  const redacted = normalizeRedactedDurableSignedEvidence(
    operation?.signedTransactionEvidence,
  );
  const expectedRedacted = redactDurableSignedEvidence(evidence);
  const evidenceSha256 = durableSignedEvidenceSha256(evidence);
  const revision = decimal(operation?.revision, 'operation revision');
  if (BigInt(revision) === 0n
      || operation.state !== 'SIGNED'
      || operation.transactionHash !== null
      || operation.submissionProtocol !== DURABLE_SIGNING_PROTOCOL
      || operation.outerTransactionHash !== evidence.outerTransactionHash
      || operation.outerSenderNonce !== evidence.outerNonce
      || operation.signedEvidenceSha256 !== evidenceSha256
      || operation.outerReceiptObservedAt !== null
      || operation.submissionEvidence !== null
      || operation.outerOutcomeEvidence !== null
      || REDACTED_EVIDENCE_KEYS.some((key) => (
        key === 'arguments'
          ? JSON.stringify(redacted.arguments) !== JSON.stringify(expectedRedacted.arguments)
          : redacted[key] !== expectedRedacted[key]
      ))) {
    refuse('journal acknowledgement does not prove the exact persisted signed transaction');
  }
  const preparedAt = exactTimestamp(operation.preparedAt, 'operation preparedAt');
  const signedAt = exactTimestamp(operation.signedAt, 'operation signedAt');
  if (Date.parse(signedAt) < Date.parse(preparedAt)) {
    refuse('operation signedAt precedes preparedAt');
  }
  return Object.freeze({ evidence, identity, evidenceSha256, revision, signedAt });
}
