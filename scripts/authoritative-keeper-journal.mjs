import {
  canonicalKeeperOperation,
  keeperAttemptOperationId,
} from '../keeper-journal/schema.mjs';
import { newKeeperJournalHolderId } from '../keeper-journal/client.mjs';

const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const OPERATION_ID = /^[0-9a-f]{64}$/;
const RECOVERABLE_STATES = new Set([
  'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED',
  'STATE_SATISFIED_UNPROVEN',
]);
const JOURNAL_STATES = new Set([
  ...RECOVERABLE_STATES, 'VERIFIED', 'FINALIZED_FAILURE', 'ABANDONED_PREHASH',
]);
const LIFECYCLE_STATUSES = new Set([
  'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED', 'FINALIZED',
]);
const SUCCESSFUL_EXECUTION = 'FINISHED_WITH_RETURN';
const FAILED_EXECUTION = 'FINISHED_WITH_ERROR';
export const DURABLE_PENDING_REASONS = Object.freeze([
  'OUTER_RECEIPT_PENDING',
  'OUTER_FINALITY_PENDING',
]);
export const INNER_STATUS_INDEXING_PENDING_REASON = 'INNER_STATUS_INDEXING_PENDING';
export const INNER_STATUS_LOOKUP_PENDING_REASON = 'INNER_STATUS_LOOKUP_PENDING';
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
  retry_prepare_payout: 'RETRY_PREPARE',
  dispatch_payout: 'DISPATCH',
  retry_payout: 'RETRY_PAYOUT',
  confirm_payout: 'CONFIRM',
  refresh_payout_withdrawal: 'REFRESH',
});

const ACTION_METHODS = Object.freeze(Object.fromEntries(
  Object.entries(METHOD_ACTIONS).map(([method, action]) => [action, method]),
));

export const KEEPER_JOURNAL_CHAIN_ID = '4221';
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

function exactDurablePendingHash(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!TRANSACTION_HASH.test(normalized) || normalized === `0x${'0'.repeat(64)}`) {
    fail('KEEPER_JOURNAL_SCHEMA', `${label} is not an exact nonzero hash.`);
  }
  return normalized;
}

function exactDurablePendingBlock(value, label) {
  const normalized = String(value ?? '');
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    fail('KEEPER_JOURNAL_SCHEMA', `${label} is not a canonical decimal block number.`);
  }
  return normalized;
}

export function validateDurablePendingOutcome(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Durable pending outcome is not an exact object.');
  }
  const pendingReason = String(value.pendingReason ?? '');
  if (!DURABLE_PENDING_REASONS.includes(pendingReason) || value.outcome !== 'PENDING') {
    fail('KEEPER_JOURNAL_SCHEMA', 'Durable pending outcome reason is not allowlisted.');
  }
  const expectedKeys = pendingReason === 'OUTER_RECEIPT_PENDING'
    ? ['outcome', 'outerTransactionHash', 'pendingReason']
    : [
      'finalizedHeadBlockNumber', 'outcome', 'outerTransactionHash', 'pendingReason',
      'receiptBlockHash', 'receiptBlockNumber',
    ];
  if (Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Durable pending outcome contains non-public or unknown fields.');
  }
  const outerTransactionHash = exactDurablePendingHash(
    value.outerTransactionHash,
    'durable pending outer transaction hash',
  );
  if (!operation || operation.state !== 'SIGNED' || operation.transactionHash !== null
      || String(operation.outerTransactionHash ?? '').toLowerCase() !== outerTransactionHash) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Durable pending outcome is not bound to the exact SIGNED row.');
  }
  if (pendingReason === 'OUTER_RECEIPT_PENDING') {
    return Object.freeze({ outcome: 'PENDING', pendingReason, outerTransactionHash });
  }
  const receiptBlockHash = exactDurablePendingHash(
    value.receiptBlockHash,
    'durable pending receipt block hash',
  );
  const receiptBlockNumber = exactDurablePendingBlock(
    value.receiptBlockNumber,
    'durable pending receipt block number',
  );
  const finalizedHeadBlockNumber = exactDurablePendingBlock(
    value.finalizedHeadBlockNumber,
    'durable pending finalized head block number',
  );
  if (BigInt(finalizedHeadBlockNumber) === 0n
      || BigInt(finalizedHeadBlockNumber) >= BigInt(receiptBlockNumber)) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Durable finality pending evidence is not below the receipt block.');
  }
  return Object.freeze({
    outcome: 'PENDING',
    pendingReason,
    outerTransactionHash,
    receiptBlockHash,
    receiptBlockNumber,
    finalizedHeadBlockNumber,
  });
}

function validateInnerStatusPendingOutcome(value, operation, expectedPendingReason) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [
        'finalizedHeadBlockNumber', 'outcome', 'outerTransactionHash', 'pendingReason',
        'receiptBlockHash', 'receiptBlockNumber', 'transactionHash',
      ].sort().join(',')) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Inner status pending outcome is not an exact public object.');
  }
  const transactionHash = exactDurablePendingHash(
    value.transactionHash,
    'inner status pending transaction hash',
  );
  const outerTransactionHash = exactDurablePendingHash(
    value.outerTransactionHash,
    'inner status pending outer transaction hash',
  );
  const receiptBlockHash = exactDurablePendingHash(
    value.receiptBlockHash,
    'inner status pending receipt block hash',
  );
  const receiptBlockNumber = exactDurablePendingBlock(
    value.receiptBlockNumber,
    'inner status pending receipt block number',
  );
  const finalizedHeadBlockNumber = exactDurablePendingBlock(
    value.finalizedHeadBlockNumber,
    'inner status pending finalized head block number',
  );
  const submissionEvidence = operation?.submissionEvidence;
  if (value.outcome !== 'PENDING'
      || value.pendingReason !== expectedPendingReason
      || !operation || operation.state !== 'SUBMITTED'
      || operation.lifecycleStatus !== 'UNKNOWN'
      || String(operation.transactionHash ?? '').toLowerCase() !== transactionHash
      || String(operation.outerTransactionHash ?? '').toLowerCase() !== outerTransactionHash
      || !submissionEvidence || typeof submissionEvidence !== 'object'
      || submissionEvidence.transactionHash !== transactionHash
      || submissionEvidence.outerTransactionHash !== outerTransactionHash
      || submissionEvidence.receiptBlockHash !== receiptBlockHash
      || submissionEvidence.receiptBlockNumber !== receiptBlockNumber
      || submissionEvidence.finalizedHeadBlockNumber !== finalizedHeadBlockNumber
      || submissionEvidence.receiptIdentityVerified !== true
      || BigInt(finalizedHeadBlockNumber) === 0n
      || BigInt(finalizedHeadBlockNumber) < BigInt(receiptBlockNumber)) {
    fail(
      'KEEPER_JOURNAL_SCHEMA',
      'Inner status pending outcome is not bound to an exact finalized SUBMITTED row.',
    );
  }
  return Object.freeze({
    outcome: 'PENDING',
    pendingReason: expectedPendingReason,
    transactionHash,
    outerTransactionHash,
    receiptBlockHash,
    receiptBlockNumber,
    finalizedHeadBlockNumber,
  });
}

export function validateInnerIndexingPendingOutcome(value, operation) {
  return validateInnerStatusPendingOutcome(
    value,
    operation,
    INNER_STATUS_INDEXING_PENDING_REASON,
  );
}

export function validateInnerLookupPendingOutcome(value, operation) {
  return validateInnerStatusPendingOutcome(
    value,
    operation,
    INNER_STATUS_LOOKUP_PENDING_REASON,
  );
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
    subjectType: operation.subjectType,
    subjectId: operation.subjectId,
    method: operation.method,
    args: operation.args,
    valueAtto: operation.valueAtto,
  };
}

export function keeperOperationForAction({ deploymentAlias, contractAddress, action }) {
  const type = String(action?.type || '').toUpperCase();
  const method = ACTION_METHODS[type] || '';
  if (!method) fail('KEEPER_JOURNAL_ACTION', `Unsupported keeper action ${type || '(missing)'}.`);
  const subjectType = ['CREATE', 'RESOLVE', 'TIMEOUT'].includes(type) ? 'epoch' : 'payout';
  const subjectId = subjectType === 'epoch'
    ? String(action.epochEndTimestamp ?? '')
    : String(action.payoutId ?? '');
  const canonical = canonicalKeeperOperation({
    deploymentAlias,
    chainId: KEEPER_JOURNAL_CHAIN_ID,
    contractAddress,
    subjectType,
    subjectId,
    method,
    args: [subjectId],
    valueAtto: '0',
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
  if (operation.subjectType === 'payout') {
    return Object.freeze({ type, payoutId: operation.subjectId });
  }
  const epochEndTimestamp = Number(operation.subjectId);
  if (!Number.isSafeInteger(epochEndTimestamp)) fail('KEEPER_JOURNAL_SCHEMA', 'Recovered epoch timestamp is not a safe integer.');
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
      || operation.network !== 'bradbury'
      || signerAddress !== operation.signerAddress
      || !JOURNAL_STATES.has(operation.state)
      || (operation.lifecycleStatus !== null
        && !LIFECYCLE_STATUSES.has(operation.lifecycleStatus))
      || (operation.state !== 'QUARANTINED' && operation.quarantineReason !== null)
      || (['FINALIZED_SUCCESS', 'VERIFIED'].includes(operation.state)
        && operation.stateReasonCode !== null)) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation identity is not canonical.');
  }
  if (operation.transactionHash !== null
      && !TRANSACTION_HASH.test(String(operation.transactionHash || ''))) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation transaction hash is malformed.');
  }
  if (operation.signedTransactionEvidence?.rawTransaction !== undefined
      || (operation.state === 'SIGNED' && (
        operation.transactionHash !== null
        || operation.signedTransactionEvidence === null
        || operation.outerTransactionHash === null
        || operation.outerSenderNonce === null
        || operation.signedEvidenceSha256 === null
        || operation.signedAt === null
        || operation.submissionEvidence !== null
      ))
      || (operation.submissionProtocol === 'BRADBURY_DURABLE_RAW_V1'
        && operation.transactionHash !== null && operation.submissionEvidence === null)) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered durable signed identity is malformed.');
  }
  if (['SUBMITTED', 'FINALIZED_SUCCESS'].includes(operation.state)
      && operation.transactionHash === null) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered submitted operation has no transaction hash.');
  }
  const acceptanceEvidence = operation.acceptanceEvidence;
  const prehashEvidence = operation.prehashAbandonmentEvidence;
  if ((RECOVERABLE_STATES.has(operation.state) && ![0, 1].includes(operation.pipelineSlot))
      || (operation.handoffPredecessorOperationId !== null
        && !OPERATION_ID.test(String(operation.handoffPredecessorOperationId || '')))
      || ((operation.acceptedAt === null) !== (acceptanceEvidence === null))
      || ((operation.acceptanceRevalidatedAt === null) !== (acceptanceEvidence === null))
      || (acceptanceEvidence !== null && (
        !acceptanceEvidence || typeof acceptanceEvidence !== 'object'
        || Array.isArray(acceptanceEvidence)
        || Object.keys(acceptanceEvidence).length !== 10
        || acceptanceEvidence.transactionHash !== operation.transactionHash
        || acceptanceEvidence.contractAddress !== operation.contractAddress
        || acceptanceEvidence.recipient !== operation.contractAddress
        || acceptanceEvidence.method !== operation.method
        || !Array.isArray(acceptanceEvidence.arguments)
        || acceptanceEvidence.arguments.length !== operation.args.length
        || acceptanceEvidence.arguments.some((entry, index) => entry !== operation.args[index])
        || acceptanceEvidence.lifecycleStatus !== 'ACCEPTED'
        || acceptanceEvidence.txExecutionResultName !== 'FINISHED_WITH_RETURN'
        || acceptanceEvidence.receiptIdentityVerified !== true
        || acceptanceEvidence.executionVerified !== true
        || acceptanceEvidence.executionSucceeded !== true
        || Number.isNaN(Date.parse(operation.acceptedAt))
        || Number.isNaN(Date.parse(operation.acceptanceRevalidatedAt))
        || Date.parse(operation.acceptanceRevalidatedAt) < Date.parse(operation.acceptedAt)
      ))) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation handoff evidence is malformed.');
  }
  if ((operation.prehashAbandonedAt === null) !== (prehashEvidence === null)
      || (operation.state === 'ABANDONED_PREHASH' && (
        operation.transactionHash !== null
        || operation.prehashAbandonedAt === null
        || !['DEFINITE_LOCAL_PRESPAWN_FAILURE', 'AUDITED_NO_BROADCAST']
          .includes(operation.stateReasonCode)
      ))
      || (operation.state !== 'ABANDONED_PREHASH'
        && operation.prehashAbandonedAt !== null)) {
    fail('KEEPER_JOURNAL_SCHEMA', 'Recovered operation pre-hash evidence is malformed.');
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
        || health?.network !== 'bradbury'
        || health?.chainId !== KEEPER_JOURNAL_CHAIN_ID
        || health?.configuration?.databaseConfigured !== true
        || health?.configuration?.authenticationConfigured !== true
        || health?.configuration?.signerConfigured !== true
        || health?.database?.configured !== true
        || health?.database?.ready !== true
        || health?.database?.schemaVersion !== 10) {
      fail(
        'KEEPER_JOURNAL_NOT_READY',
        'The authoritative keeper journal is not ready on schema version 10; no lease or write is permitted.',
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
        idempotencyKey: key(`prepare-${operation.method}-${operation.subjectId}`),
      });
    },
    async bindSigned(operationId, evidence) {
      return client.bindSigned({
        lease: requireLease(),
        operationId,
        evidence,
        idempotencyKey: key(`bind-signed-${operationId}`),
      });
    },
    async loadSigned(operationId) {
      return client.loadSigned({
        lease: requireLease(),
        operationId,
        idempotencyKey: key(`load-signed-${operationId}`),
      });
    },
    async loadOperation(operationId) {
      return client.loadOperation({
        lease: requireLease(),
        operationId,
        idempotencyKey: key(`load-operation-${operationId}`),
      });
    },
    async bind(operationId, transactionHash, submissionEvidence) {
      return client.bindSubmission({
        lease: requireLease(),
        operationId,
        transactionHash,
        submissionEvidence,
        idempotencyKey: key(`bind-${operationId}`),
      });
    },
    async bindOuterOutcome(operationId, outerOutcomeEvidence) {
      return client.bindOuterOutcome({
        lease: requireLease(),
        operationId,
        outerOutcomeEvidence,
        idempotencyKey: key(`bind-outer-outcome-${operationId}`),
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
    async accept(operationId, acceptanceEvidence) {
      return client.acceptHandoff({
        lease: requireLease(),
        operationId,
        acceptanceEvidence,
        idempotencyKey: key(`accept-${operationId}`),
      });
    },
    async abandonPrehash(operationId, reasonCode, evidence) {
      return client.abandonPrehash({
        lease: requireLease(),
        operationId,
        reasonCode,
        evidence,
        idempotencyKey: key(`abandon-prehash-${operationId}-${reasonCode}`),
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
    subjectType: operation.subjectType,
    subjectId: operation.subjectId,
    transactionHash: operation.transactionHash,
    state: operation.state,
    lifecycleStatus: operation.lifecycleStatus,
    reason,
    ...details,
  });
}

function innerStatusPendingOutcome(operation, pendingReason) {
  const evidence = operation?.submissionEvidence;
  const validate = pendingReason === INNER_STATUS_LOOKUP_PENDING_REASON
    ? validateInnerLookupPendingOutcome
    : validateInnerIndexingPendingOutcome;
  return validate({
    outcome: 'PENDING',
    pendingReason,
    transactionHash: operation?.transactionHash,
    outerTransactionHash: operation?.outerTransactionHash,
    receiptBlockHash: evidence?.receiptBlockHash,
    receiptBlockNumber: evidence?.receiptBlockNumber,
    finalizedHeadBlockNumber: evidence?.finalizedHeadBlockNumber,
  }, operation);
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
  validateAcceptedReceipt,
  verifyPostState,
  sleep,
  lifecycleAttempts,
  lifecycleIntervalMs,
  receiptPolicy,
  submissionBoundThisInvocation: sourceSubmissionBoundThisInvocation = false,
  deadlineAtMs = Number.POSITIVE_INFINITY,
  clockMs = Date.now,
  logger = () => {},
}) {
  let operation = validateRecoveredKeeperOperation(source);
  let submissionBoundThisInvocation = sourceSubmissionBoundThisInvocation === true;
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
  if (operation.state === 'PREPARED') {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, 'PREPARED_WITHOUT_DURABLE_HASH'),
    });
  }
  if (operation.state === 'SIGNED') {
    if (typeof operator?.broadcastSignedWrite !== 'function') {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, 'SIGNED_REPLAY_UNAVAILABLE'),
      });
    }
    try {
      const replay = await operator.broadcastSignedWrite(operation, session);
      if (!replay || typeof replay !== 'object') {
        fail('KEEPER_JOURNAL_SCHEMA', 'Durable signed replay returned an invalid outcome.');
      }
      if (replay.outcome === 'SUBMITTED') {
        if (!replay.submissionEvidence || typeof replay.submissionEvidence !== 'object'
            || replay.transactionHash === undefined
            || replay.submissionEvidence.transactionHash !== replay.transactionHash) {
          fail('KEEPER_JOURNAL_SCHEMA', 'Durable signed replay returned invalid submission evidence.');
        }
        const bound = await session.bind(
          operation.operationId,
          replay.transactionHash,
          replay.submissionEvidence,
        );
        operation = validateRecoveredKeeperOperation(bound?.operation || bound);
        if (operation.state !== 'SUBMITTED'
            || operation.transactionHash !== String(replay.transactionHash).toLowerCase()
            || operation.lifecycleStatus !== 'UNKNOWN'
            || operation.submissionEvidence?.transactionHash !== operation.transactionHash) {
          fail(
            'KEEPER_JOURNAL_SCHEMA',
            'Durable signed replay bind did not return the exact UNKNOWN SUBMITTED row.',
          );
        }
        submissionBoundThisInvocation = true;
      } else if (replay.outcome === 'PENDING') {
        const durablePending = validateDurablePendingOutcome(replay, operation);
        const {
          outcome: _outcome,
          pendingReason,
          ...publicEvidence
        } = durablePending;
        logger({
          event: 'KEEPER_DURABLE_OUTER_PENDING',
          operationId: operation.operationId,
          logicalOperationId: operation.logicalOperationId,
          method: operation.method,
          subjectType: operation.subjectType,
          subjectId: operation.subjectId,
          reason: pendingReason,
          ...publicEvidence,
        });
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, pendingReason, publicEvidence),
        });
      } else if (replay.outcome === 'OUTER_FAILURE') {
        if (!replay.outerFailureEvidence || typeof replay.outerFailureEvidence !== 'object') {
          fail('KEEPER_JOURNAL_SCHEMA', 'Durable signed replay returned invalid outer failure evidence.');
        }
        const bound = await session.bindOuterOutcome(
          operation.operationId,
          replay.outerFailureEvidence,
        );
        operation = validateRecoveredKeeperOperation(bound?.operation || bound);
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'OUTER_RECEIPT_REVERTED'),
        });
      } else if (replay.outcome === 'OUTER_AMBIGUOUS') {
        if (!replay.outerAmbiguityEvidence
            || typeof replay.outerAmbiguityEvidence !== 'object') {
          fail('KEEPER_JOURNAL_SCHEMA', 'Durable signed replay returned invalid outer ambiguity evidence.');
        }
        const bound = await session.bindOuterOutcome(
          operation.operationId,
          replay.outerAmbiguityEvidence,
        );
        operation = validateRecoveredKeeperOperation(bound?.operation || bound);
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'),
        });
      } else {
        fail('KEEPER_JOURNAL_SCHEMA', 'Durable signed replay returned an unknown outcome.');
      }
    } catch (error) {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, 'SIGNED_REPLAY_PENDING', {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
  if (operation.transactionHash === null) {
    return Object.freeze({
      verified: false,
      operation,
      pending: pending(operation, `JOURNAL_${operation.state}_WITHOUT_INNER_HASH`),
    });
  }
  if (operation.state === 'QUARANTINED') {
    const genericIdentityQuarantine = operation.quarantineReason === RECEIPT_AMBIGUITY_CODES.OTHER
      && operation.stateReasonCode === RECEIPT_AMBIGUITY_CODES.OTHER
      && operation.lifecycleStatus === 'FINALIZED'
      && operation.transactionHash !== null;
    if (!genericIdentityQuarantine) {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, 'JOURNAL_QUARANTINED'),
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
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, ambiguityCode),
      });
    }
    if (receipt.txExecutionResultName !== SUCCESSFUL_EXECUTION) {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, 'FINALIZED_EXECUTION_FAILED'),
      });
    }
    try {
      validateReceipt(receipt, operation);
    } catch {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(operation, RECEIPT_AMBIGUITY_CODES.OTHER),
      });
    }
    const transitioned = await session.transition(operation.operationId, 'FINALIZED_SUCCESS', {
      metadata: {
        transactionHash: operation.transactionHash,
        lifecycleStatus: 'FINALIZED',
        receiptIdentityVerified: true,
        executionVerified: true,
      },
    });
    operation = validateRecoveredKeeperOperation(transitioned?.operation);
    if (operation.state !== 'FINALIZED_SUCCESS'
        || operation.stateReasonCode !== null
        || operation.quarantineReason !== null) {
      fail(
        'KEEPER_JOURNAL_TRANSITION_CONFLICT',
        'Corrected receipt evidence did not clear the generic identity quarantine.',
      );
    }
  }

  if (operation.state === 'STATE_SATISFIED_UNPROVEN') {
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
        if (attempt === 1 && submissionBoundThisInvocation) {
          const deferred = innerStatusPendingOutcome(
            operation,
            INNER_STATUS_LOOKUP_PENDING_REASON,
          );
          const {
            outcome: _outcome,
            pendingReason,
            transactionHash: _transactionHash,
            ...publicEvidence
          } = deferred;
          logger({
            event: 'KEEPER_INNER_STATUS_LOOKUP_PENDING',
            operationId: operation.operationId,
            logicalOperationId: operation.logicalOperationId,
            transactionHash: operation.transactionHash,
            method: operation.method,
            subjectType: operation.subjectType,
            subjectId: operation.subjectId,
            reason: pendingReason,
            ...publicEvidence,
          });
          return Object.freeze({
            verified: false,
            operation,
            pending: pending(operation, pendingReason, publicEvidence),
          });
        }
        if (attempt < attempts) {
          await sleep(lifecycleIntervalMs);
          continue;
        }
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'LIFECYCLE_STATUS_UNAVAILABLE', {
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      if (attempt === 1 && lifecycleStatus === 'UNKNOWN'
          && submissionBoundThisInvocation) {
        const deferred = innerStatusPendingOutcome(
          operation,
          INNER_STATUS_INDEXING_PENDING_REASON,
        );
        const {
          outcome: _outcome,
          pendingReason,
          transactionHash: _transactionHash,
          ...publicEvidence
        } = deferred;
        logger({
          event: 'KEEPER_INNER_STATUS_INDEXING_PENDING',
          operationId: operation.operationId,
          logicalOperationId: operation.logicalOperationId,
          transactionHash: operation.transactionHash,
          method: operation.method,
          subjectType: operation.subjectType,
          subjectId: operation.subjectId,
          reason: pendingReason,
          ...publicEvidence,
        });
        return Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, pendingReason, publicEvidence),
        });
      }
      if (lifecycleStatus !== operation.lifecycleStatus) {
        const observed = await session.observe(operation.operationId, lifecycleStatus);
        operation = validateRecoveredKeeperOperation(observed?.operation || operation);
      }
      if (lifecycleStatus === 'ACCEPTED') {
        try {
          const receipt = await operator.getAcceptedReceipt(operation.transactionHash);
          validateAcceptedReceipt(receipt, operation);
          const acceptanceEvidence = Object.freeze({
            transactionHash: operation.transactionHash,
            contractAddress: operation.contractAddress,
            recipient: operation.contractAddress,
            method: operation.method,
            arguments: Object.freeze([...operation.args]),
            lifecycleStatus: 'ACCEPTED',
            txExecutionResultName: 'FINISHED_WITH_RETURN',
            receiptIdentityVerified: true,
            executionVerified: true,
            executionSucceeded: true,
          });
          const accepted = await session.accept(operation.operationId, acceptanceEvidence);
          operation = validateRecoveredKeeperOperation(accepted?.operation || operation);
          if (operation.state !== 'SUBMITTED'
              || operation.lifecycleStatus !== 'ACCEPTED'
              || operation.acceptedAt === null
              || operation.acceptanceEvidence?.transactionHash !== operation.transactionHash) {
            fail(
              'KEEPER_JOURNAL_ACCEPTANCE_CONFLICT',
              'Successful ACCEPTED receipt evidence was not durably persisted.',
            );
          }
          return Object.freeze({
            verified: false,
            accepted: true,
            action,
            operation,
            acceptanceEvidence,
          });
        } catch (error) {
          if (attempt < attempts) {
            await sleep(lifecycleIntervalMs);
            continue;
          }
          return Object.freeze({
            verified: false,
            operation,
            pending: pending(operation, 'ACCEPTED_RECEIPT_UNPROVEN', {
              message: error instanceof Error ? error.message : String(error),
            }),
          });
        }
      }
      if (lifecycleStatus === 'FINALIZED') break;
      if (attempt < attempts) await sleep(lifecycleIntervalMs);
    }
    if (lifecycleStatus !== 'FINALIZED') {
      return Object.freeze({
        verified: false,
        operation,
        pending: pending(
          operation,
          lifecycleStatus === 'UNKNOWN' ? 'LIFECYCLE_UNKNOWN' : 'LIFECYCLE_NONFINAL',
        ),
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
    subjectType: operation.subjectType,
    subjectId: operation.subjectId,
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
  if (operations.length > 2
      || new Set(operations.map((operation) => operation.pipelineSlot)).size
        !== operations.length) {
    fail(
      'KEEPER_JOURNAL_PIPELINE_SHAPE',
      'Keeper recovery exceeded the two-slot authoritative pipeline.',
    );
  }
  let orderedOperations = operations;
  if (operations.length === 2) {
    if (operations[1].handoffPredecessorOperationId === operations[0].operationId) {
      orderedOperations = operations;
    } else if (operations[0].handoffPredecessorOperationId === operations[1].operationId) {
      orderedOperations = Object.freeze([operations[1], operations[0]]);
    } else {
      fail(
        'KEEPER_JOURNAL_PIPELINE_SHAPE',
        'Keeper recovery returned an invalid ACCEPTED-handoff lineage.',
      );
    }
  }
  const recovered = [];
  const accepted = [];
  const pendingOperations = [];
  const reconciliationByOperationId = new Map();
  for (const operation of orderedOperations) {
    if (operation.state === 'SIGNED' && operation.handoffPredecessorOperationId !== null) {
      const predecessorId = operation.handoffPredecessorOperationId;
      const predecessorResult = reconciliationByOperationId.get(predecessorId);
      let predecessorAuthorized = predecessorResult?.verified === true
        || predecessorResult?.accepted === true;
      let predecessorState = predecessorResult?.operation?.state || null;
      let predecessorError = null;
      if (!predecessorResult) {
        try {
          const loaded = await options.session.loadOperation(predecessorId);
          const predecessor = validateRecoveredKeeperOperation(loaded?.operation || loaded);
          predecessorState = predecessor.state;
          predecessorAuthorized = predecessor.state === 'VERIFIED';
        } catch (error) {
          predecessorError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!predecessorAuthorized) {
        const blockedResult = Object.freeze({
          verified: false,
          operation,
          pending: pending(operation, 'SIGNED_PREDECESSOR_NOT_REVALIDATED', {
            handoffPredecessorOperationId: predecessorId,
            predecessorState,
            ...(predecessorError === null ? {} : { message: predecessorError }),
          }),
        });
        reconciliationByOperationId.set(operation.operationId, blockedResult);
        pendingOperations.push(blockedResult.pending);
        continue;
      }
    }
    const result = await reconcileAuthoritativeOperation({
      ...options,
      lifecycleAttempts: options.recoveryLifecycleAttempts ?? 1,
      operation,
    });
    reconciliationByOperationId.set(operation.operationId, result);
    if (result.verified) recovered.push(Object.freeze({
      ...result.action,
      operationId: operation.operationId,
      transactionHash: operation.transactionHash,
      status: result.postState?.status,
    }));
    else if (result.accepted) accepted.push(Object.freeze({
      ...result.action,
      operationId: operation.operationId,
      logicalOperationId: operation.logicalOperationId,
      subjectType: operation.subjectType,
      subjectId: operation.subjectId,
      transactionHash: operation.transactionHash,
      pipelineSlot: operation.pipelineSlot,
      acceptedAt: result.operation.acceptedAt,
      acceptanceRevalidatedAt: result.operation.acceptanceRevalidatedAt,
      operation: result.operation,
    }));
    else pendingOperations.push(result.pending);
  }
  const outstanding = [...accepted, ...pendingOperations];
  return Object.freeze({
    recovered: Object.freeze(recovered),
    accepted: Object.freeze(accepted),
    pending: Object.freeze(pendingOperations),
    outstandingLogicalOperationIds: Object.freeze([
      ...new Set(outstanding.map((operation) => operation.logicalOperationId)),
    ]),
    outstandingSubjects: Object.freeze([
      ...new Set(outstanding.map((operation) => `${operation.subjectType}:${operation.subjectId}`)),
    ]),
    blocked: pendingOperations.length > 0,
  });
}
