import {
  canonicalKeeperOperation,
  keeperAttemptOperationId,
} from '../keeper-journal/schema.mjs';
import { newKeeperJournalHolderId } from '../keeper-journal/client.mjs';

const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const OPERATION_ID = /^[0-9a-f]{64}$/;
const RECOVERABLE_STATES = new Set([
  'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
]);
const JOURNAL_STATES = new Set([...RECOVERABLE_STATES, 'VERIFIED', 'FINALIZED_FAILURE']);
const LIFECYCLE_STATUSES = new Set([
  'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED', 'FINALIZED',
]);
const SUCCESSFUL_EXECUTION = 'FINISHED_WITH_RETURN';
const FAILED_EXECUTION = 'FINISHED_WITH_ERROR';
const RECEIPT_AMBIGUITY_CODES = Object.freeze({
  HASH: 'RECEIPT_HASH_MISMATCH',
  CONTRACT: 'RECEIPT_CONTRACT_MISMATCH',
  METHOD: 'RECEIPT_METHOD_MISMATCH',
  ARGUMENTS: 'RECEIPT_ARGUMENTS_MISMATCH',
  OTHER: 'RECEIPT_IDENTITY_AMBIGUOUS',
});
const METHOD_ACTIONS = Object.freeze({
  create_epoch: 'CREATE',
  resolve_epoch: 'RESOLVE',
  activate_timeout_refund: 'TIMEOUT',
});

export const KEEPER_JOURNAL_CHAIN_ID = '61999';
export const KEEPER_JOURNAL_LEASE_SECONDS = 900;
export const KEEPER_JOURNAL_HEARTBEAT_MS = 240_000;

export class AuthoritativeKeeperJournalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuthoritativeKeeperJournalError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new AuthoritativeKeeperJournalError(code, message, details);
}

function exactAddress(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized) || /^0x0{40}$/.test(normalized)) {
    fail('KEEPER_JOURNAL_SCHEMA', `${label} is not an exact nonzero address.`);
  }
  return normalized;
}

function idempotencyLabel(value) {
  return String(value || 'request').replace(/[^A-Za-z0-9._:/-]/g, '-').slice(0, 72);
}

function operationInput(operation) {
  return {
    deploymentAlias: operation.deploymentAlias,
    chainId: operation.chainId,
    contractAddress: operation.contractAddress,
    method: operation.method,
    args: operation.args,
    valueAtto: operation.valueAtto,
    epochEndTimestamp: operation.epochEndTimestamp,
  };
}

export function keeperOperationForAction({ deploymentAlias, contractAddress, action }) {
  const type = String(action?.type || '').toUpperCase();
  const method = type === 'CREATE'
    ? 'create_epoch'
    : (type === 'RESOLVE' ? 'resolve_epoch' : (type === 'TIMEOUT'
      ? 'activate_timeout_refund'
      : ''));
  if (!method) fail('KEEPER_JOURNAL_ACTION', `Unsupported keeper action ${type || '(missing)'}.`);
  const epochEndTimestamp = String(action.epochEndTimestamp ?? '');
  const canonical = canonicalKeeperOperation({
    deploymentAlias,
    chainId: KEEPER_JOURNAL_CHAIN_ID,
    contractAddress,
    method,
    args: [epochEndTimestamp],
    valueAtto: '0',
    epochEndTimestamp,
  });
  return Object.freeze({
    operationId: canonical.operationId,
    logicalOperationId: canonical.operationId,
    operation: Object.freeze(operationInput(canonical)),
    call: Object.freeze({ method, args: canonical.args }),
  });
}

export function keeperActionForOperation(operation) {
  const type = METHOD_ACTIONS[String(operation?.method || '')];
  if (!type) fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation has an unsupported method.');
  const epochEndTimestamp = Number(operation.epochEndTimestamp);
  if (!Number.isSafeInteger(epochEndTimestamp)) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered epoch timestamp is not a safe integer.');
  }
  return Object.freeze({
    type,
    epochEndTimestamp,
  });
}

export function validateRecoveredKeeperOperation(operation) {
  if (!operation || typeof operation !== 'object') {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation is malformed.');
  }
  const canonical = canonicalKeeperOperation(operationInput(operation));
  const signerAddress = exactAddress(operation.signerAddress, 'recovered signerAddress');
  const operationId = String(operation.operationId || '');
  const logicalOperationId = String(operation.logicalOperationId || '');
  const attemptNumber = String(operation.attemptNumber || '');
  const retryOfOperationId = operation.retryOfOperationId === null
    ? null
    : String(operation.retryOfOperationId || '');
  let expectedOperationId;
  let expectedRetryOfOperationId = null;
  try {
    expectedOperationId = keeperAttemptOperationId(logicalOperationId, attemptNumber);
    if (attemptNumber !== '1') {
      expectedRetryOfOperationId = keeperAttemptOperationId(
        logicalOperationId,
        (BigInt(attemptNumber) - 1n).toString(),
      );
    }
  } catch {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation attempt identity is malformed.');
  }
  if (!OPERATION_ID.test(String(operation.operationId || ''))
      || !OPERATION_ID.test(logicalOperationId)
      || !/^[1-9]\d{0,18}$/.test(attemptNumber)
      || (retryOfOperationId !== null && !OPERATION_ID.test(retryOfOperationId))
      || logicalOperationId !== canonical.operationId
      || operationId !== expectedOperationId
      || retryOfOperationId !== expectedRetryOfOperationId
      || operation.network !== 'studionet'
      || signerAddress !== operation.signerAddress
      || !JOURNAL_STATES.has(operation.state)
      || (operation.lifecycleStatus !== null
        && !LIFECYCLE_STATUSES.has(operation.lifecycleStatus))) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation identity is not canonical.');
  }
  if (operation.transactionHash !== null
      && !TRANSACTION_HASH.test(String(operation.transactionHash || ''))) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation transaction hash is malformed.');
  }
  if (['SUBMITTED', 'FINALIZED_SUCCESS'].includes(operation.state)
      && operation.transactionHash === null) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered submitted operation has no transaction hash.');
  }
  return Object.freeze({ ...operation, args: canonical.args });
}

export function createAuthoritativeKeeperSession({
  client,
  signerAddress,
  holderId = newKeeperJournalHolderId(),
  leaseSeconds = KEEPER_JOURNAL_LEASE_SECONDS,
  heartbeatMs = KEEPER_JOURNAL_HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = () => {},
} = {}) {
  if (!client) fail('KEEPER_JOURNAL_REQUIRED', 'The authoritative keeper journal client is required.');
  const signer = exactAddress(signerAddress, 'signerAddress');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 900) {
    fail('KEEPER_JOURNAL_LEASE', 'Keeper journal lease duration is invalid.');
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 300_000) {
    fail('KEEPER_JOURNAL_LEASE', 'Keeper journal heartbeat must run at least every five minutes.');
  }

  let lease = null;
  let requestSequence = 0;
  let renewalSequence = Promise.resolve();
  let heartbeatError = null;

  const key = (label) => {
    requestSequence += 1;
    return `keeper:${holderId}:${String(requestSequence).padStart(6, '0')}:${idempotencyLabel(label)}`;
  };

  const requireLease = () => {
    if (heartbeatError) {
      throw new AuthoritativeKeeperJournalError(
        'KEEPER_JOURNAL_LEASE_LOST',
        'The fenced keeper lease heartbeat failed; no journal mutation or write is permitted.',
        { cause: heartbeatError },
      );
    }
    if (!lease) fail('KEEPER_JOURNAL_LEASE', 'The keeper signer lease is not active.');
    return lease;
  };

  async function acquire() {
    if (typeof client.health !== 'function') {
      fail('KEEPER_JOURNAL_REQUIRED', 'The authoritative keeper journal health check is required.');
    }
    const health = await client.health();
    if (health?.status !== 'ready'
        || health?.service !== 'liquidity-arena-keeper-journal'
        || health?.ready !== true
        || health?.network !== 'studionet'
        || health?.chainId !== KEEPER_JOURNAL_CHAIN_ID
        || health?.configuration?.databaseConfigured !== true
        || health?.configuration?.authenticationConfigured !== true
        || health?.configuration?.signerConfigured !== true
        || health?.database?.configured !== true
        || health?.database?.ready !== true
        || health?.database?.schemaVersion !== 3) {
      fail(
        'KEEPER_JOURNAL_NOT_READY',
        'The authoritative keeper journal is not ready on schema version 3; no lease or write is permitted.',
      );
    }
    const response = await client.acquireLease({
      holderId,
      signerAddress: signer,
      leaseSeconds,
      idempotencyKey: key('lease-acquire'),
    });
    lease = response?.lease;
    if (!lease || lease.holderId !== holderId || lease.signerAddress !== signer
        || !/^[1-9]\d{0,18}$/.test(String(lease.fencingToken || ''))) {
      fail('KEEPER_JOURNAL_SCHEMA', 'Keeper journal returned an invalid signer lease.');
    }
    return lease;
  }

  async function renew() {
    const active = requireLease();
    const response = await client.renewLease({
      lease: active,
      leaseSeconds,
      idempotencyKey: key('lease-renew'),
    });
    const renewed = response?.lease;
    if (!renewed || renewed.holderId !== active.holderId
        || renewed.signerAddress !== active.signerAddress
        || String(renewed.fencingToken) !== String(active.fencingToken)) {
      fail('KEEPER_JOURNAL_SCHEMA', 'Keeper journal returned a mismatched renewed lease.');
    }
    lease = renewed;
    return lease;
  }

  function scheduleRenewal() {
    renewalSequence = renewalSequence.then(async () => {
      if (heartbeatError) return;
      try {
        await renew();
        logger({ event: 'KEEPER_JOURNAL_LEASE_RENEWED', fencingToken: lease.fencingToken });
      } catch (error) {
        heartbeatError = error;
      }
    });
  }

  async function withHeartbeat(task) {
    if (typeof task !== 'function') fail('KEEPER_JOURNAL_ARGUMENT', 'Heartbeat task is required.');
    heartbeatError = null;
    await renew();
    const timer = setIntervalImpl(scheduleRenewal, heartbeatMs);
    timer?.unref?.();
    let result;
    let taskError;
    try {
      result = await task();
    } catch (error) {
      taskError = error;
    } finally {
      clearIntervalImpl(timer);
      await renewalSequence;
    }
    if (heartbeatError) {
      throw new AuthoritativeKeeperJournalError(
        'KEEPER_JOURNAL_LEASE_LOST',
        'The fenced keeper lease could not be renewed; no further writes are permitted.',
        { cause: heartbeatError, taskError },
      );
    }
    if (taskError) throw taskError;
    return result;
  }

  return Object.freeze({
    get holderId() { return holderId; },
    get signerAddress() { return signer; },
    get lease() { return lease; },
    acquire,
    renew,
    withHeartbeat,
    async release() {
      if (!lease) return;
      const active = lease;
      await client.releaseLease({ lease: active, idempotencyKey: key('lease-release') });
      lease = null;
    },
    async recoverAll({ limit = 50 } = {}) {
      const operations = [];
      const operationIds = new Set();
      const cursors = new Set();
      let cursor = null;
      for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
        const response = await client.recover({
          lease: requireLease(),
          cursor,
          limit,
          idempotencyKey: key(`recover-${pageIndex}`),
        });
        if (!Array.isArray(response?.operations) || !response?.page
            || response.page.limit !== limit || response.operations.length > limit) {
          fail('KEEPER_JOURNAL_SCHEMA', 'Keeper journal recovery page is malformed.');
        }
        for (const rawOperation of response.operations) {
          const operation = validateRecoveredKeeperOperation(rawOperation);
          if (!RECOVERABLE_STATES.has(operation.state)) {
            fail('KEEPER_JOURNAL_SCHEMA', 'Keeper recovery returned a terminal operation.');
          }
          if (operationIds.has(operation.operationId)) {
            fail('KEEPER_JOURNAL_SCHEMA', 'Keeper journal recovery returned a duplicate operation.');
          }
          operationIds.add(operation.operationId);
          operations.push(operation);
        }
        const next = response.page.nextCursor;
        if (next === null) return Object.freeze(operations);
        if (typeof next !== 'string' || next === '' || cursors.has(next)) {
          fail('KEEPER_JOURNAL_SCHEMA', 'Keeper journal recovery cursor is malformed.');
        }
        cursors.add(next);
        cursor = next;
      }
      fail('KEEPER_JOURNAL_SCHEMA', 'Keeper journal recovery exceeded its page bound.');
    },
    async prepare(operation) {
      return client.prepareOperation({
        lease: requireLease(),
        operation,
        idempotencyKey: key(`prepare-${operation.method}-${operation.epochEndTimestamp}`),
      });
    },
    async bind(operationId, transactionHash) {
      return client.bindSubmission({
        lease: requireLease(),
        operationId,
        transactionHash,
        idempotencyKey: key(`bind-${operationId}`),
      });
    },
    async observe(operationId, lifecycleStatus) {
      return client.observeLifecycle({
        lease: requireLease(),
        operationId,
        lifecycleStatus,
        idempotencyKey: key(`observe-${operationId}-${lifecycleStatus}`),
      });
    },
    async transition(operationId, targetState, { reasonCode = null, metadata = {} } = {}) {
      return client.transition({
        lease: requireLease(),
        operationId,
        targetState,
        reasonCode,
        metadata,
        idempotencyKey: key(`transition-${operationId}-${targetState}`),
      });
    },
  });
}

function pending(operation, reason, details = {}) {
  return Object.freeze({
    operationId: operation.operationId,
    logicalOperationId: operation.logicalOperationId,
    attemptNumber: operation.attemptNumber,
    retryOfOperationId: operation.retryOfOperationId,
    deploymentAlias: operation.deploymentAlias,
    method: operation.method,
    epochEndTimestamp: Number(operation.epochEndTimestamp),
    transactionHash: operation.transactionHash,
    state: operation.state,
    lifecycleStatus: operation.lifecycleStatus,
    reason,
    ...details,
  });
}

function sameScope(operation, { deploymentAlias, contractAddress, signerAddress }) {
  return operation.deploymentAlias === deploymentAlias
    && operation.contractAddress === contractAddress.toLowerCase()
    && operation.signerAddress === signerAddress.toLowerCase();
}

function receiptAmbiguityCode(receipt, operation) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return RECEIPT_AMBIGUITY_CODES.OTHER;
  }
  if (String(receipt.transactionHash || '').toLowerCase() !== operation.transactionHash) {
    return RECEIPT_AMBIGUITY_CODES.HASH;
  }
  if (receipt.statusName !== 'FINALIZED') return RECEIPT_AMBIGUITY_CODES.OTHER;

  const recipient = String(receipt.recipient || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) return RECEIPT_AMBIGUITY_CODES.OTHER;
  if (recipient !== operation.contractAddress) return RECEIPT_AMBIGUITY_CODES.CONTRACT;

  const decoded = receipt.txDataDecoded;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || decoded.type !== 'call' || !decoded.callData
      || typeof decoded.callData !== 'object' || Array.isArray(decoded.callData)) {
    return RECEIPT_AMBIGUITY_CODES.OTHER;
  }
  if (typeof decoded.callData.method !== 'string' || decoded.callData.method === '') {
    return RECEIPT_AMBIGUITY_CODES.OTHER;
  }
  if (decoded.callData.method !== operation.method) return RECEIPT_AMBIGUITY_CODES.METHOD;
  if (!Array.isArray(decoded.callData.args)) return RECEIPT_AMBIGUITY_CODES.OTHER;
  if (decoded.callData.args.length !== operation.args.length
      || decoded.callData.args.some((value, index) => String(value) !== operation.args[index])) {
    return RECEIPT_AMBIGUITY_CODES.ARGUMENTS;
  }
  if (![SUCCESSFUL_EXECUTION, FAILED_EXECUTION].includes(receipt.txExecutionResultName)) {
    return RECEIPT_AMBIGUITY_CODES.OTHER;
  }
  return null;
}

async function quarantineReceiptAmbiguity(session, operation, ambiguityCode) {
  const transitioned = await session.transition(operation.operationId, 'QUARANTINED', {
    reasonCode: ambiguityCode,
    metadata: {
      transactionHash: operation.transactionHash,
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: false,
      ambiguityCode,
    },
  });
  const quarantined = validateRecoveredKeeperOperation(transitioned?.operation || {
    ...operation,
    state: 'QUARANTINED',
    quarantineReason: ambiguityCode,
  });
  return Object.freeze({
    verified: false,
    operation: quarantined,
    pending: pending(quarantined, ambiguityCode),
  });
}

export async function reconcileAuthoritativeOperation({
  session,
  operation: source,
  deploymentAlias,
  contractAddress,
  operator,
  validateReceipt,
  verifyPostState,
  sleep,
  lifecycleAttempts,
  lifecycleIntervalMs,
  receiptPolicy,
  deadlineAtMs = Number.POSITIVE_INFINITY,
  clockMs = Date.now,
  logger = () => {},
}) {
  let operation = validateRecoveredKeeperOperation(source);
  if (!sameScope(operation, {
    deploymentAlias,
    contractAddress,
    signerAddress: session.signerAddress,
  })) {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, 'FOREIGN_NONTERMINAL_OPERATION'),
    });
  }
  const action = keeperActionForOperation(operation);
  if (operation.state === 'PREPARED' || operation.transactionHash === null) {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, 'PREPARED_WITHOUT_DURABLE_HASH'),
    });
  }
  if (operation.state === 'QUARANTINED' || operation.state === 'STATE_SATISFIED_UNPROVEN') {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, `JOURNAL_${operation.state}`),
    });
  }

  if (operation.state === 'SUBMITTED') {
    const attempts = Math.max(1, Number(lifecycleAttempts) || 1);
    let lifecycleStatus = operation.lifecycleStatus;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (clockMs() >= deadlineAtMs) {
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'RUN_DEADLINE'),
        });
      }
      try {
        lifecycleStatus = await operator.getTransactionStatus(operation.transactionHash);
      } catch (error) {
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'LIFECYCLE_STATUS_UNAVAILABLE', {
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      if (lifecycleStatus !== operation.lifecycleStatus) {
        const observed = await session.observe(operation.operationId, lifecycleStatus);
        operation = validateRecoveredKeeperOperation(observed?.operation || operation);
      }
      if (lifecycleStatus === 'FINALIZED') break;
      if (lifecycleStatus === 'UNKNOWN') {
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'LIFECYCLE_UNKNOWN'),
        });
      }
      if (attempt < attempts) await sleep(lifecycleIntervalMs);
    }
    if (lifecycleStatus !== 'FINALIZED') {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, 'LIFECYCLE_NONFINAL'),
      });
    }

    let receipt;
    try {
      receipt = await operator.waitFinalized(operation.transactionHash, receiptPolicy);
    } catch (error) {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, 'FINALIZED_RECEIPT_NOT_INDEXED', {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
    const ambiguityCode = receiptAmbiguityCode(receipt, operation);
    if (ambiguityCode) {
      return quarantineReceiptAmbiguity(session, operation, ambiguityCode);
    }
    if (receipt.txExecutionResultName === FAILED_EXECUTION) {
      const transitioned = await session.transition(operation.operationId, 'FINALIZED_FAILURE', {
        reasonCode: 'FINALIZED_EXECUTION_FAILED',
        metadata: {
          transactionHash: operation.transactionHash,
          lifecycleStatus: 'FINALIZED',
          receiptIdentityVerified: true,
          executionVerified: true,
          executionSucceeded: false,
        },
      });
      const failed = validateRecoveredKeeperOperation(transitioned?.operation || {
        ...operation,
        state: 'FINALIZED_FAILURE',
        stateReasonCode: 'FINALIZED_EXECUTION_FAILED',
      });
      return Object.freeze({
        verified: false,
        operation: failed,
        pending: pending(failed, 'FINALIZED_EXECUTION_FAILED'),
      });
    }
    try {
      validateReceipt(receipt, operation);
    } catch {
      // The structural comparison above isolates the specific identity
      // mismatches. Any remaining validator disagreement is still ambiguity,
      // never successful execution evidence.
      return quarantineReceiptAmbiguity(
        session,
        operation,
        RECEIPT_AMBIGUITY_CODES.OTHER,
      );
    }
    const transitioned = await session.transition(operation.operationId, 'FINALIZED_SUCCESS', {
      metadata: {
        transactionHash: operation.transactionHash,
        lifecycleStatus: 'FINALIZED',
        receiptIdentityVerified: true,
        executionVerified: true,
      },
    });
    operation = validateRecoveredKeeperOperation(transitioned?.operation || {
      ...operation,
      state: 'FINALIZED_SUCCESS',
    });
  }

  if (operation.state !== 'FINALIZED_SUCCESS') {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, `JOURNAL_${operation.state}`),
    });
  }

  let postState;
  try {
    postState = await verifyPostState(action, operation);
  } catch (error) {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, 'POST_STATE_NOT_VISIBLE', {
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  }
  const verified = await session.transition(operation.operationId, 'VERIFIED', {
    metadata: {
      transactionHash: operation.transactionHash,
      postStateStatus: String(postState?.status || ''),
      postStateVerified: true,
    },
  });
  logger({
    event: 'KEEPER_JOURNAL_OPERATION_VERIFIED',
    deploymentAlias,
    operationId: operation.operationId,
    logicalOperationId: operation.logicalOperationId,
    attemptNumber: operation.attemptNumber,
    retryOfOperationId: operation.retryOfOperationId,
    transactionHash: operation.transactionHash,
    method: operation.method,
    epochEndTimestamp: Number(operation.epochEndTimestamp),
  });
  return Object.freeze({
    verified: true,
    action,
    operation: verified?.operation || { ...operation, state: 'VERIFIED' },
    postState,
  });
}

export async function recoverAuthoritativeOperations(options) {
  const operations = await options.session.recoverAll();
  const recovered = [];
  const pendingOperations = [];
  for (const operation of operations) {
    const result = await reconcileAuthoritativeOperation({ ...options, operation });
    if (result.verified) recovered.push(Object.freeze({
      ...result.action,
      operationId: operation.operationId,
      transactionHash: operation.transactionHash,
      status: result.postState?.status,
    }));
    else pendingOperations.push(result.pending);
  }
  return Object.freeze({
    recovered: Object.freeze(recovered),
    pending: Object.freeze(pendingOperations),
    blocked: pendingOperations.length > 0,
  });
}
