import { createHash } from 'node:crypto';

import {
  KEEPER_JOURNAL_CHAIN_ID,
  KEEPER_JOURNAL_MAX_LEASE_SECONDS,
  KEEPER_JOURNAL_MAX_PAGE,
  KEEPER_JOURNAL_MIN_LEASE_SECONDS,
  KEEPER_JOURNAL_NETWORK,
} from './config.mjs';
import { KeeperJournalError } from './errors.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const OPERATION_ID = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const FENCING_TOKEN = /^[1-9]\d{0,18}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{15,199}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const FORBIDDEN_METADATA_KEY = /(?:authorization|credential|database.*url|keystore|mnemonic|password|passphrase|private.*key|secret|api.*key)/i;
const UINT256_MAX = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');
const BIGINT_MAX = BigInt('9223372036854775807');
const EPOCH_METHODS = new Set(['create_epoch', 'resolve_epoch', 'activate_timeout_refund']);
const PAYOUT_METHODS = new Set([
  'retry_prepare_payout', 'dispatch_payout', 'retry_payout',
  'confirm_payout', 'refresh_payout_withdrawal',
]);
const METHODS = new Set([...EPOCH_METHODS, ...PAYOUT_METHODS]);
const PAYOUT_ID = /^[0-9a-f]{64}$/;
const LIFECYCLE_STATUSES = new Set([
  'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED', 'FINALIZED',
]);
export const KEEPER_JOURNAL_TRANSITION_STATES = Object.freeze([
  'FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE',
  'STATE_SATISFIED_UNPROVEN', 'QUARANTINED',
]);
const TRANSITION_STATES = new Set(KEEPER_JOURNAL_TRANSITION_STATES);
const QUARANTINE_REASON_CODES = new Set([
  'RECEIPT_HASH_MISMATCH',
  'RECEIPT_CONTRACT_MISMATCH',
  'RECEIPT_METHOD_MISMATCH',
  'RECEIPT_ARGUMENTS_MISMATCH',
  'RECEIPT_IDENTITY_AMBIGUOUS',
]);
const RECOVERY_STATES = new Set([
  'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
]);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(message, code = 'KEEPER_JOURNAL_SCHEMA') {
  throw new KeeperJournalError(code, message, { statusCode: 400 });
}

function objectKeys(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => RESERVED_KEYS.has(key))) fail(`${label} has a forbidden field.`);
  return keys;
}

function exactObject(value, expectedKeys, label) {
  const actual = objectKeys(value, label).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected fields.`);
  }
}

function canonicalAddress(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!ADDRESS.test(String(value || '')) || normalized === `0x${'0'.repeat(40)}`) {
    fail(`${label} is invalid.`);
  }
  return normalized;
}

function canonicalHash(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!HASH.test(String(value || ''))) fail(`${label} is invalid.`);
  return normalized;
}

function canonicalDecimal(value, label, maximum) {
  const normalized = String(value ?? '');
  if (!DECIMAL.test(normalized)) fail(`${label} must be a canonical unsigned decimal string.`);
  const parsed = BigInt(normalized);
  if (parsed > maximum) fail(`${label} is out of range.`);
  return normalized;
}

function canonicalHolderId(value) {
  const normalized = String(value || '').toLowerCase();
  if (!UUID_V4.test(normalized)) fail('holderId must be a lowercase UUID v4.');
  return normalized;
}

function canonicalFencingToken(value) {
  const normalized = String(value ?? '');
  if (!FENCING_TOKEN.test(normalized) || BigInt(normalized) > BIGINT_MAX) {
    fail('fencingToken is invalid.');
  }
  return normalized;
}

function canonicalLeaseSeconds(value) {
  if (!Number.isSafeInteger(value)
      || value < KEEPER_JOURNAL_MIN_LEASE_SECONDS
      || value > KEEPER_JOURNAL_MAX_LEASE_SECONDS) {
    fail(`leaseSeconds must be between ${KEEPER_JOURNAL_MIN_LEASE_SECONDS} and ${KEEPER_JOURNAL_MAX_LEASE_SECONDS}.`);
  }
  return value;
}

function safeMetadata(value) {
  let nodes = 0;
  function visit(item, depth) {
    nodes += 1;
    if (depth > 8 || nodes > 256) fail('metadata is too complex.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item)) {
        fail('metadata contains an invalid string.');
      }
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) fail('metadata numbers must be safe integers.');
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 64) fail('metadata array is too large.');
      return item.map((entry) => visit(entry, depth + 1));
    }
    const keys = objectKeys(item, 'metadata');
    const result = Object.create(null);
    for (const key of keys.sort()) {
      if (key.length > 80 || FORBIDDEN_METADATA_KEY.test(key)) {
        fail('metadata contains a forbidden field.');
      }
      result[key] = visit(item[key], depth + 1);
    }
    return result;
  }
  const normalized = visit(value, 0);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    fail('metadata must be an object.');
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 8 * 1024) {
    fail('metadata is too large.');
  }
  return Object.freeze(normalized);
}

function exactTransitionMetadata(targetState, value, reasonCode) {
  const metadata = safeMetadata(value);
  const expectedKeys = Object.freeze({
    FINALIZED_SUCCESS: Object.freeze([
      'transactionHash', 'lifecycleStatus', 'receiptIdentityVerified', 'executionVerified',
    ]),
    FINALIZED_FAILURE: Object.freeze([
      'transactionHash', 'lifecycleStatus', 'receiptIdentityVerified',
      'executionVerified', 'executionSucceeded',
    ]),
    VERIFIED: Object.freeze([
      'transactionHash', 'postStateStatus', 'postStateVerified',
    ]),
    STATE_SATISFIED_UNPROVEN: Object.freeze([
      'postStateStatus', 'postStateVerified',
    ]),
    QUARANTINED: Object.freeze([
      'transactionHash', 'lifecycleStatus', 'receiptIdentityVerified', 'ambiguityCode',
    ]),
  })[targetState];
  exactObject(metadata, expectedKeys, 'metadata');

  if (targetState === 'FINALIZED_SUCCESS') {
    if (metadata.lifecycleStatus !== 'FINALIZED'
        || metadata.receiptIdentityVerified !== true
        || metadata.executionVerified !== true) {
      fail('FINALIZED_SUCCESS requires exact successful receipt evidence metadata.');
    }
    return Object.freeze({
      ...metadata,
      transactionHash: canonicalHash(metadata.transactionHash, 'metadata.transactionHash'),
    });
  }

  if (targetState === 'FINALIZED_FAILURE') {
    if (metadata.lifecycleStatus !== 'FINALIZED'
        || metadata.receiptIdentityVerified !== true
        || metadata.executionVerified !== true
        || metadata.executionSucceeded !== false) {
      fail('FINALIZED_FAILURE requires exact finalized failure receipt evidence metadata.');
    }
    return Object.freeze({
      ...metadata,
      transactionHash: canonicalHash(metadata.transactionHash, 'metadata.transactionHash'),
    });
  }

  if (targetState === 'QUARANTINED') {
    if (metadata.lifecycleStatus !== 'FINALIZED'
        || metadata.receiptIdentityVerified !== false
        || !QUARANTINE_REASON_CODES.has(reasonCode)
        || metadata.ambiguityCode !== reasonCode) {
      fail('QUARANTINED requires exact finalized receipt ambiguity evidence metadata.');
    }
    return Object.freeze({
      ...metadata,
      transactionHash: canonicalHash(metadata.transactionHash, 'metadata.transactionHash'),
    });
  }

  const postStateStatus = String(metadata.postStateStatus || '');
  if (!REASON_CODE.test(postStateStatus) || metadata.postStateVerified !== true) {
    fail(`${targetState} requires exact post-state evidence metadata.`);
  }
  if (targetState === 'VERIFIED') {
    return Object.freeze({
      ...metadata,
      transactionHash: canonicalHash(metadata.transactionHash, 'metadata.transactionHash'),
      postStateStatus,
    });
  }
  return Object.freeze({ ...metadata, postStateStatus });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function canonicalKeeperOperation(value) {
  exactObject(value, [
    'deploymentAlias', 'chainId', 'contractAddress', 'method',
    'args', 'valueAtto', 'subjectType', 'subjectId',
  ], 'operation');
  const deploymentAlias = String(value.deploymentAlias || '').toLowerCase();
  if (deploymentAlias !== 'v8') fail('deploymentAlias must be v8.');
  const chainId = String(value.chainId ?? '');
  if (chainId !== KEEPER_JOURNAL_CHAIN_ID) fail('chainId must be 4221.');
  const contractAddress = canonicalAddress(value.contractAddress, 'contractAddress');
  const method = String(value.method || '');
  if (!METHODS.has(method)) fail('method is invalid.');
  const subjectType = String(value.subjectType || '').toLowerCase();
  if (!['epoch', 'payout'].includes(subjectType)) fail('subjectType is invalid.');
  let subjectId;
  if (subjectType === 'epoch') {
    if (!EPOCH_METHODS.has(method)) fail('epoch subjects require an epoch method.');
    subjectId = canonicalDecimal(value.subjectId, 'subjectId', BIGINT_MAX);
    if (BigInt(subjectId) === 0n || BigInt(subjectId) % 3600n !== 0n) {
      fail('epoch subjectId must be an exact positive UTC hour.');
    }
  } else {
    if (!PAYOUT_METHODS.has(method)) fail('payout subjects require a payout method.');
    subjectId = String(value.subjectId || '');
    if (!PAYOUT_ID.test(subjectId)) fail('payout subjectId must be lowercase 64-hex without 0x.');
  }
  if (!Array.isArray(value.args) || value.args.length !== 1 || typeof value.args[0] !== 'string') {
    fail('args must contain exactly one canonical string argument.');
  }
  const args = Object.freeze([String(value.args[0])]);
  if (args[0] !== subjectId) fail('args[0] must equal subjectId.');
  const valueAtto = canonicalDecimal(value.valueAtto, 'valueAtto', UINT256_MAX);
  if (valueAtto !== '0') fail('Keeper journal operations must have valueAtto equal to 0.');
  const identity = Object.freeze({
    chainId,
    contractAddress,
    subjectType,
    subjectId,
    method,
    args,
    valueAtto,
  });
  const canonicalOperation = JSON.stringify(identity);
  const operationId = createHash('sha256').update(canonicalOperation, 'utf8').digest('hex');
  return Object.freeze({
    operationId,
    deploymentAlias,
    network: KEEPER_JOURNAL_NETWORK,
    ...identity,
    canonicalOperation,
  });
}

export function keeperAttemptOperationId(logicalOperationId, attemptNumber) {
  const logical = String(logicalOperationId || '').toLowerCase();
  if (!OPERATION_ID.test(logical)) fail('logicalOperationId is invalid.');
  const attempt = canonicalDecimal(attemptNumber, 'attemptNumber', BIGINT_MAX);
  if (BigInt(attempt) === 0n) fail('attemptNumber must be positive.');
  if (attempt === '1') return logical;
  return createHash('sha256').update(`${logical}:${attempt}`, 'utf8').digest('hex');
}

function leaseIdentity(value, expectedKeys) {
  exactObject(value, expectedKeys, 'Keeper journal request');
  return Object.freeze({
    holderId: canonicalHolderId(value.holderId),
    signerAddress: canonicalAddress(value.signerAddress, 'signerAddress'),
    fencingToken: canonicalFencingToken(value.fencingToken),
  });
}

export function parseKeeperJournalRequest(value) {
  objectKeys(value, 'Request body');
  const action = String(value.action || '').toUpperCase();
  if (action === 'HEALTH') {
    exactObject(value, ['action'], 'Keeper journal request');
    return Object.freeze({ action });
  }
  if (action === 'LEASE_ACQUIRE') {
    exactObject(value, ['action', 'holderId', 'signerAddress', 'leaseSeconds'], 'Keeper journal request');
    return Object.freeze({
      action,
      holderId: canonicalHolderId(value.holderId),
      signerAddress: canonicalAddress(value.signerAddress, 'signerAddress'),
      leaseSeconds: canonicalLeaseSeconds(value.leaseSeconds),
    });
  }
  if (action === 'LEASE_RENEW') {
    return Object.freeze({
      action,
      ...leaseIdentity(value, ['action', 'holderId', 'signerAddress', 'fencingToken', 'leaseSeconds']),
      leaseSeconds: canonicalLeaseSeconds(value.leaseSeconds),
    });
  }
  if (action === 'LEASE_RELEASE') {
    return Object.freeze({
      action,
      ...leaseIdentity(value, ['action', 'holderId', 'signerAddress', 'fencingToken']),
    });
  }
  if (action === 'PREPARE') {
    return Object.freeze({
      action,
      ...leaseIdentity(value, ['action', 'holderId', 'signerAddress', 'fencingToken', 'operation']),
      operation: canonicalKeeperOperation(value.operation),
    });
  }
  if (action === 'BIND_SUBMISSION') {
    const lease = leaseIdentity(value, [
      'action', 'holderId', 'signerAddress', 'fencingToken', 'operationId', 'transactionHash',
    ]);
    const operationId = String(value.operationId || '').toLowerCase();
    if (!OPERATION_ID.test(operationId)) fail('operationId is invalid.');
    return Object.freeze({
      action,
      ...lease,
      operationId,
      transactionHash: canonicalHash(value.transactionHash, 'transactionHash'),
    });
  }
  if (action === 'OBSERVE_LIFECYCLE') {
    const lease = leaseIdentity(value, [
      'action', 'holderId', 'signerAddress', 'fencingToken', 'operationId', 'lifecycleStatus',
    ]);
    const operationId = String(value.operationId || '').toLowerCase();
    const lifecycleStatus = String(value.lifecycleStatus || '').toUpperCase();
    if (!OPERATION_ID.test(operationId)) fail('operationId is invalid.');
    if (!LIFECYCLE_STATUSES.has(lifecycleStatus)) fail('lifecycleStatus is invalid.');
    return Object.freeze({ action, ...lease, operationId, lifecycleStatus });
  }
  if (action === 'TRANSITION') {
    const lease = leaseIdentity(value, [
      'action', 'holderId', 'signerAddress', 'fencingToken',
      'operationId', 'targetState', 'reasonCode', 'metadata',
    ]);
    const operationId = String(value.operationId || '').toLowerCase();
    const targetState = String(value.targetState || '').toUpperCase();
    if (!OPERATION_ID.test(operationId)) fail('operationId is invalid.');
    if (!TRANSITION_STATES.has(targetState)) fail('targetState is invalid.');
    const reasonCode = value.reasonCode === null ? null : String(value.reasonCode || '');
    if (reasonCode !== null && !REASON_CODE.test(reasonCode)) fail('reasonCode is invalid.');
    if (['FINALIZED_FAILURE', 'STATE_SATISFIED_UNPROVEN', 'QUARANTINED'].includes(targetState)
        && !reasonCode) {
      fail('reasonCode is required for this transition.');
    }
    const metadata = exactTransitionMetadata(targetState, value.metadata, reasonCode);
    return Object.freeze({
      action,
      ...lease,
      operationId,
      targetState,
      reasonCode,
      metadata,
    });
  }
  if (action === 'RECOVER') {
    const lease = leaseIdentity(value, [
      'action', 'holderId', 'signerAddress', 'fencingToken', 'cursor', 'limit',
    ]);
    if (value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 512)) {
      fail('cursor is invalid.');
    }
    if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > KEEPER_JOURNAL_MAX_PAGE) {
      fail(`limit must be between 1 and ${KEEPER_JOURNAL_MAX_PAGE}.`);
    }
    return Object.freeze({
      action,
      ...lease,
      cursor: decodeRecoveryCursor(value.cursor),
      limit: value.limit,
    });
  }
  fail('Unknown keeper journal action.');
}

export function normalizedIdempotencyKey(value) {
  const normalized = String(value || '');
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    fail('Idempotency-Key is invalid.', 'KEEPER_JOURNAL_IDEMPOTENCY_KEY');
  }
  return normalized;
}

export function requestFingerprint(request) {
  return createHash('sha256').update(stableJson(request), 'utf8').digest('hex');
}

export function idempotencyKeyHash(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex');
}

export function encodeRecoveryCursor(row) {
  const sourcePreparedAt = row.preparedAt ?? row.prepared_at;
  const date = sourcePreparedAt instanceof Date ? sourcePreparedAt : new Date(sourcePreparedAt);
  if (Number.isNaN(date.getTime())) fail('Recovery cursor source is invalid.');
  const preparedAt = date.toISOString();
  if (typeof sourcePreparedAt === 'string' && sourcePreparedAt !== preparedAt) {
    // Migration 002 stores the pagination key as timestamptz(3). Refuse to
    // silently discard precision if a repository implementation violates it.
    fail('Recovery cursor source has unsupported timestamp precision.');
  }
  const operationId = String((row.operationId ?? row.operation_id) || '');
  if (!OPERATION_ID.test(operationId)) fail('Recovery cursor source is invalid.');
  return Buffer.from(JSON.stringify({ preparedAt, operationId }), 'utf8').toString('base64url');
}

export function decodeRecoveryCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const source = Buffer.from(String(value), 'base64url').toString('utf8');
    const parsed = JSON.parse(source);
    exactObject(parsed, ['preparedAt', 'operationId'], 'cursor');
    const preparedAt = String(parsed.preparedAt || '');
    const operationId = String(parsed.operationId || '');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(preparedAt)
        || Number.isNaN(Date.parse(preparedAt)) || !OPERATION_ID.test(operationId)
        || source !== JSON.stringify({ preparedAt, operationId })) {
      fail('cursor is invalid.');
    }
    return Object.freeze({ preparedAt, operationId });
  } catch (error) {
    if (error instanceof KeeperJournalError) throw error;
    fail('cursor is invalid.');
  }
  return null;
}

export function publicKeeperOperation(row) {
  const state = String(row.state);
  if (!RECOVERY_STATES.has(state) && !['VERIFIED', 'FINALIZED_FAILURE'].includes(state)) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_DATABASE_SHAPE',
      'Keeper journal returned an invalid operation state.',
      { statusCode: 503 },
    );
  }
  const operationId = String(row.operation_id);
  const logicalOperationId = String(row.logical_operation_id);
  const attemptNumber = String(row.attempt_number);
  const retryOfOperationId = row.retry_of_operation_id === null
    ? null
    : String(row.retry_of_operation_id);
  let expectedOperationId;
  let expectedRetryOperationId = null;
  try {
    expectedOperationId = keeperAttemptOperationId(logicalOperationId, attemptNumber);
    if (attemptNumber !== '1') {
      expectedRetryOperationId = keeperAttemptOperationId(
        logicalOperationId,
        (BigInt(attemptNumber) - 1n).toString(),
      );
    }
  } catch (error) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_DATABASE_SHAPE',
      'Keeper journal returned invalid operation attempt identity.',
      { statusCode: 503, cause: error },
    );
  }
  if (operationId !== expectedOperationId || retryOfOperationId !== expectedRetryOperationId) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_DATABASE_SHAPE',
      'Keeper journal returned inconsistent operation attempt identity.',
      { statusCode: 503 },
    );
  }
  return Object.freeze({
    operationId,
    logicalOperationId,
    attemptNumber,
    retryOfOperationId,
    deploymentAlias: String(row.deployment_alias),
    network: String(row.network),
    chainId: String(row.chain_id),
    signerAddress: String(row.signer_address),
    contractAddress: String(row.contract_address),
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    method: String(row.method),
    args: Object.freeze([...(row.arguments || [])].map(String)),
    valueAtto: String(row.value_atto),
    state,
    transactionHash: row.transaction_hash === null ? null : String(row.transaction_hash),
    lifecycleStatus: row.lifecycle_status === null ? null : String(row.lifecycle_status),
    lifecycleObservedAt: row.lifecycle_observed_at || null,
    stateReasonCode: row.state_reason_code || null,
    quarantineReason: row.quarantine_reason || null,
    preparedAt: row.prepared_at,
    submittedAt: row.submitted_at || null,
    finalizedAt: row.finalized_at || null,
    verifiedAt: row.verified_at || null,
    updatedAt: row.updated_at,
    revision: String(row.revision),
  });
}
