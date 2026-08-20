import assert from 'node:assert/strict';
import test from 'node:test';

import { KeeperJournalError } from '../keeper-journal/errors.mjs';
import { keeperAttemptOperationId, parseKeeperJournalRequest } from '../keeper-journal/schema.mjs';
import { createKeeperJournalService } from '../keeper-journal/service.mjs';

const SIGNER = '0x12ba664a1ec9ca78b070d103c6a69e20673f4b51';
const CONTRACT = '0xb2ae59ae641f571726ae81e30080f8c2192b15ef';
const HOLDER_A = '123e4567-e89b-42d3-a456-426614174000';
const HOLDER_B = '123e4567-e89b-42d3-b456-426614174001';
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const ENVIRONMENT = {
  DATABASE_URL: 'postgresql://example.invalid/db',
  KEEPER_JOURNAL_SECRET: 's'.repeat(32),
  KEEPER_JOURNAL_SIGNER_ADDRESS: SIGNER,
};

function journalError(code, message = code, statusCode = 409) {
  return new KeeperJournalError(code, message, { statusCode });
}

class MemoryRepository {
  constructor() {
    this.requests = new Map();
    this.operations = new Map();
    this.token = 0n;
    this.lease = null;
    this.clock = Date.parse('2026-08-20T00:00:00.000Z');
  }

  instant() {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  async health() {
    return { configured: true, ready: true, schemaVersion: 3 };
  }

  async claimRequest({ keyHash, requestHash, action }) {
    const previous = this.requests.get(keyHash);
    if (previous && (previous.requestHash !== requestHash || previous.action !== action)) {
      throw journalError('KEEPER_JOURNAL_IDEMPOTENCY_CONFLICT');
    }
    this.requests.set(keyHash, { requestHash, action });
  }

  assertLease(input) {
    if (!this.lease?.active
        || this.lease.holderId !== input.holderId
        || this.lease.signerAddress !== input.signerAddress
        || this.lease.fencingToken !== input.fencingToken) {
      throw journalError('KEEPER_JOURNAL_FENCE_REJECTED');
    }
  }

  expire() {
    if (this.lease) this.lease.active = false;
  }

  async acquireLease(input) {
    if (this.lease?.active && this.lease.holderId !== input.holderId) {
      throw journalError('KEEPER_JOURNAL_LEASE_BUSY');
    }
    if (this.lease?.active) return { ...this.lease, expiresAt: this.instant(), newlyAcquired: false };
    this.token += 1n;
    this.lease = {
      holderId: input.holderId,
      signerAddress: input.signerAddress,
      fencingToken: String(this.token),
      active: true,
    };
    for (const record of this.operations.values()) record.lastFence = String(this.token);
    return {
      holderId: input.holderId,
      signerAddress: input.signerAddress,
      fencingToken: String(this.token),
      expiresAt: this.instant(),
      newlyAcquired: true,
    };
  }

  async renewLease(input) {
    this.assertLease(input);
    return { ...this.lease, expiresAt: this.instant() };
  }

  async releaseLease(input) {
    this.assertLease(input);
    this.lease.active = false;
    return { released: true, fencingToken: input.fencingToken };
  }

  public(record) {
    const { preparedFence, lastFence, finalityMetadata, verificationMetadata, ...operation } = record;
    return { ...operation };
  }

  laterAttempt(record) {
    return [...this.operations.values()].find((candidate) => (
      candidate.logicalOperationId === record.logicalOperationId
      && BigInt(candidate.attemptNumber) > BigInt(record.attemptNumber)
    ));
  }

  async prepare(input) {
    this.assertLease(input);
    const logicalOperationId = input.operation.operationId;
    const attempts = [...this.operations.values()]
      .filter((candidate) => candidate.logicalOperationId === logicalOperationId)
      .sort((left, right) => Number(BigInt(right.attemptNumber) - BigInt(left.attemptNumber)));
    let record = attempts[0] || null;
    if (!record || record.state === 'FINALIZED_FAILURE') {
      const blocker = [...this.operations.values()].find((candidate) => [
        'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED',
      ].includes(candidate.state));
      if (blocker) throw journalError('KEEPER_JOURNAL_UNRESOLVED_OPERATION');
      const timestamp = this.instant();
      const attemptNumber = record ? String(BigInt(record.attemptNumber) + 1n) : '1';
      const retryOfOperationId = record?.operationId || null;
      record = {
        operationId: keeperAttemptOperationId(logicalOperationId, attemptNumber),
        logicalOperationId,
        attemptNumber,
        retryOfOperationId,
        deploymentAlias: input.operation.deploymentAlias,
        network: 'studionet',
        chainId: '61999',
        signerAddress: input.signerAddress,
        contractAddress: input.operation.contractAddress,
        method: input.operation.method,
        args: [...input.operation.args],
        valueAtto: input.operation.valueAtto,
        epochEndTimestamp: input.operation.epochEndTimestamp,
        state: 'PREPARED',
        transactionHash: null,
        lifecycleStatus: null,
        lifecycleObservedAt: null,
        stateReasonCode: null,
        quarantineReason: null,
        preparedAt: timestamp,
        submittedAt: null,
        finalizedAt: null,
        verifiedAt: null,
        updatedAt: timestamp,
        revision: '1',
        preparedFence: input.fencingToken,
        lastFence: input.fencingToken,
      };
      this.operations.set(record.operationId, record);
      return { operation: this.public(record), canBroadcast: true, inserted: true };
    }
    return {
      operation: this.public(record),
      canBroadcast: false,
      inserted: false,
    };
  }

  async bindSubmission(input) {
    this.assertLease(input);
    const record = this.operations.get(input.operationId);
    if (!record) throw journalError('KEEPER_JOURNAL_OPERATION_NOT_FOUND', 'not found', 404);
    if (this.laterAttempt(record)) throw journalError('KEEPER_JOURNAL_ATTEMPT_FROZEN');
    if (record.transactionHash && record.transactionHash !== input.transactionHash) {
      record.state = 'QUARANTINED';
      record.quarantineReason = 'SUBMISSION_HASH_CONFLICT';
      record.lastFence = input.fencingToken;
      throw journalError('KEEPER_JOURNAL_HASH_CONFLICT');
    }
    if (!record.transactionHash) {
      record.transactionHash = input.transactionHash;
      record.state = 'SUBMITTED';
      record.lifecycleStatus = 'UNKNOWN';
      record.submittedAt = this.instant();
    }
    record.lastFence = input.fencingToken;
    record.updatedAt = this.instant();
    record.revision = String(BigInt(record.revision) + 1n);
    return this.public(record);
  }

  async observeLifecycle(input) {
    this.assertLease(input);
    const record = this.operations.get(input.operationId);
    if (!record?.transactionHash) throw journalError('KEEPER_JOURNAL_LIFECYCLE_CONFLICT');
    if (this.laterAttempt(record)) throw journalError('KEEPER_JOURNAL_ATTEMPT_FROZEN');
    if (record.lifecycleStatus === 'FINALIZED' && input.lifecycleStatus !== 'FINALIZED') {
      throw journalError('KEEPER_JOURNAL_LIFECYCLE_CONFLICT');
    }
    record.lifecycleStatus = input.lifecycleStatus;
    record.lifecycleObservedAt = this.instant();
    record.updatedAt = this.instant();
    return this.public(record);
  }

  async transition(input) {
    this.assertLease(input);
    const record = this.operations.get(input.operationId);
    if (!record) throw journalError('KEEPER_JOURNAL_OPERATION_NOT_FOUND', 'not found', 404);
    if (this.laterAttempt(record)) throw journalError('KEEPER_JOURNAL_ATTEMPT_FROZEN');
    const allowed = {
      FINALIZED_SUCCESS: ['SUBMITTED', 'FINALIZED_SUCCESS'],
      VERIFIED: ['FINALIZED_SUCCESS', 'VERIFIED'],
      FINALIZED_FAILURE: ['SUBMITTED', 'FINALIZED_FAILURE'],
      STATE_SATISFIED_UNPROVEN: ['PREPARED', 'SUBMITTED', 'STATE_SATISFIED_UNPROVEN'],
      QUARANTINED: [
        'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
        'STATE_SATISFIED_UNPROVEN', 'QUARANTINED',
      ],
    }[input.targetState];
    if (!allowed.includes(record.state)) throw journalError('KEEPER_JOURNAL_TRANSITION_CONFLICT');
    record.state = input.targetState;
    record.stateReasonCode = input.reasonCode;
    if (['FINALIZED_SUCCESS', 'FINALIZED_FAILURE'].includes(input.targetState)) {
      record.lifecycleStatus = 'FINALIZED';
      record.finalizedAt ||= this.instant();
      record.finalityMetadata = { ...input.metadata };
    }
    if (input.targetState === 'VERIFIED') record.verifiedAt ||= this.instant();
    record.updatedAt = this.instant();
    record.revision = String(BigInt(record.revision) + 1n);
    return this.public(record);
  }

  async recover(input) {
    this.assertLease(input);
    const recoverable = [...this.operations.values()]
      .filter((record) => [
        'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
      ].includes(record.state))
      .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt)
        || left.operationId.localeCompare(right.operationId))
      .filter((record) => !input.cursor
        || record.preparedAt > input.cursor.preparedAt
        || (record.preparedAt === input.cursor.preparedAt
          && record.operationId > input.cursor.operationId));
    return recoverable.slice(0, input.limit + 1).map((record) => this.public(record));
  }
}

function service(repository = new MemoryRepository()) {
  return {
    repository,
    service: createKeeperJournalService({ repository, environment: ENVIRONMENT }),
  };
}

function operation(epoch = '1800014400', method = 'resolve_epoch') {
  return {
    deploymentAlias: 'v7', chainId: '61999', contractAddress: CONTRACT,
    method, args: [epoch], valueAtto: '0', epochEndTimestamp: epoch,
  };
}

async function execute(instance, body, suffix) {
  return instance.execute({
    request: parseKeeperJournalRequest(body),
    idempotencyKey: `keeper:test:${String(suffix).padStart(8, '0')}`,
  });
}

async function acquire(instance, holderId, suffix) {
  return execute(instance, {
    action: 'LEASE_ACQUIRE', holderId, signerAddress: SIGNER, leaseSeconds: 900,
  }, suffix);
}

function leaseBody(lease) {
  return {
    holderId: lease.holderId,
    signerAddress: lease.signerAddress,
    fencingToken: lease.fencingToken,
  };
}

test('a replacement lease fences stale runners and never reauthorizes an old PREPARED broadcast', async () => {
  const fixture = service();
  const first = (await acquire(fixture.service, HOLDER_A, 1)).lease;
  const prepared = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(first), operation: operation(),
  }, 2);
  assert.equal(prepared.canBroadcast, true);

  fixture.repository.expire();
  const second = (await acquire(fixture.service, HOLDER_B, 3)).lease;
  assert.equal(second.fencingToken, '2');
  await assert.rejects(
    execute(fixture.service, {
      action: 'RECOVER', ...leaseBody(first), cursor: null, limit: 50,
    }, 4),
    (error) => error.code === 'KEEPER_JOURNAL_FENCE_REJECTED',
  );
  const replay = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(second), operation: operation(),
  }, 5);
  assert.equal(replay.canBroadcast, false);
  assert.equal(replay.operation.state, 'PREPARED');
});

test('a second submission hash quarantines the immutable first hash', async () => {
  const fixture = service();
  const lease = (await acquire(fixture.service, HOLDER_A, 10)).lease;
  const prepared = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 11);
  await execute(fixture.service, {
    action: 'BIND_SUBMISSION', ...leaseBody(lease),
    operationId: prepared.operation.operationId, transactionHash: HASH_A,
  }, 12);
  await assert.rejects(
    execute(fixture.service, {
      action: 'BIND_SUBMISSION', ...leaseBody(lease),
      operationId: prepared.operation.operationId, transactionHash: HASH_B,
    }, 13),
    (error) => error.code === 'KEEPER_JOURNAL_HASH_CONFLICT',
  );
  const recovery = await execute(fixture.service, {
    action: 'RECOVER', ...leaseBody(lease), cursor: null, limit: 50,
  }, 14);
  assert.equal(recovery.operations[0].state, 'QUARANTINED');
  assert.equal(recovery.operations[0].transactionHash, HASH_A);
});

test('a finalized failed call creates one deterministic append-only retry attempt', async () => {
  const fixture = service();
  const lease = (await acquire(fixture.service, HOLDER_A, 15)).lease;
  const first = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 16);
  await execute(fixture.service, {
    action: 'BIND_SUBMISSION', ...leaseBody(lease),
    operationId: first.operation.operationId, transactionHash: HASH_A,
  }, 17);
  await execute(fixture.service, {
    action: 'TRANSITION', ...leaseBody(lease), operationId: first.operation.operationId,
    targetState: 'FINALIZED_FAILURE', reasonCode: 'FINALIZED_EXECUTION_FAILED',
    metadata: {
      transactionHash: HASH_A,
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: true,
      executionVerified: true,
      executionSucceeded: false,
    },
  }, 18);
  const retry = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 19);
  assert.equal(retry.canBroadcast, true);
  assert.equal(retry.inserted, true);
  assert.equal(retry.operation.logicalOperationId, first.operation.logicalOperationId);
  assert.equal(retry.operation.attemptNumber, '2');
  assert.equal(retry.operation.retryOfOperationId, first.operation.operationId);
  assert.equal(
    retry.operation.operationId,
    keeperAttemptOperationId(first.operation.logicalOperationId, '2'),
  );
  assert.notEqual(retry.operation.operationId, first.operation.operationId);

  const repeated = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 20);
  assert.equal(repeated.canBroadcast, false);
  assert.equal(repeated.inserted, false);
  assert.equal(repeated.operation.operationId, retry.operation.operationId);
});

test('a retry freezes its finalized-failure parent and remains the sole unresolved attempt', async () => {
  const fixture = service();
  const lease = (await acquire(fixture.service, HOLDER_A, 50)).lease;
  const first = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 51);
  await execute(fixture.service, {
    action: 'BIND_SUBMISSION', ...leaseBody(lease),
    operationId: first.operation.operationId, transactionHash: HASH_A,
  }, 52);
  await execute(fixture.service, {
    action: 'TRANSITION', ...leaseBody(lease), operationId: first.operation.operationId,
    targetState: 'FINALIZED_FAILURE', reasonCode: 'FINALIZED_EXECUTION_FAILED',
    metadata: {
      transactionHash: HASH_A,
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: true,
      executionVerified: true,
      executionSucceeded: false,
    },
  }, 53);
  const parentBeforeRetry = structuredClone(fixture.repository.operations.get(first.operation.operationId));
  const retry = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 54);

  await assert.rejects(
    execute(fixture.service, {
      action: 'TRANSITION', ...leaseBody(lease), operationId: first.operation.operationId,
      targetState: 'QUARANTINED', reasonCode: 'RECEIPT_HASH_MISMATCH',
      metadata: {
        transactionHash: HASH_A,
        lifecycleStatus: 'FINALIZED',
        receiptIdentityVerified: false,
        ambiguityCode: 'RECEIPT_HASH_MISMATCH',
      },
    }, 55),
    (error) => error.code === 'KEEPER_JOURNAL_ATTEMPT_FROZEN',
  );

  assert.deepEqual(
    fixture.repository.operations.get(first.operation.operationId),
    parentBeforeRetry,
    'the failed parent hash and exact evidence remain immutable',
  );
  const recovery = await execute(fixture.service, {
    action: 'RECOVER', ...leaseBody(lease), cursor: null, limit: 50,
  }, 56);
  assert.deepEqual(recovery.operations.map((entry) => entry.operationId), [retry.operation.operationId]);
  assert.equal(recovery.operations[0].state, 'PREPARED');
});

test('a quarantined attempt blocks every second quarantine for the signer', async () => {
  const fixture = service();
  const lease = (await acquire(fixture.service, HOLDER_A, 60)).lease;
  const first = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 61);
  await execute(fixture.service, {
    action: 'BIND_SUBMISSION', ...leaseBody(lease),
    operationId: first.operation.operationId, transactionHash: HASH_A,
  }, 62);
  await assert.rejects(
    execute(fixture.service, {
      action: 'BIND_SUBMISSION', ...leaseBody(lease),
      operationId: first.operation.operationId, transactionHash: HASH_B,
    }, 63),
    (error) => error.code === 'KEEPER_JOURNAL_HASH_CONFLICT',
  );
  await assert.rejects(
    execute(fixture.service, {
      action: 'PREPARE', ...leaseBody(lease), operation: operation('1800018000'),
    }, 64),
    (error) => error.code === 'KEEPER_JOURNAL_UNRESOLVED_OPERATION',
  );
  const quarantines = [...fixture.repository.operations.values()]
    .filter((entry) => entry.state === 'QUARANTINED');
  assert.equal(quarantines.length, 1);
});

test('lightweight FINALIZED remains SUBMITTED until receipt success then post-state verification', async () => {
  const fixture = service();
  const lease = (await acquire(fixture.service, HOLDER_A, 20)).lease;
  const prepared = await execute(fixture.service, {
    action: 'PREPARE', ...leaseBody(lease), operation: operation(),
  }, 21);
  await execute(fixture.service, {
    action: 'BIND_SUBMISSION', ...leaseBody(lease),
    operationId: prepared.operation.operationId, transactionHash: HASH_A,
  }, 22);
  const observed = await execute(fixture.service, {
    action: 'OBSERVE_LIFECYCLE', ...leaseBody(lease),
    operationId: prepared.operation.operationId, lifecycleStatus: 'FINALIZED',
  }, 23);
  assert.equal(observed.operation.lifecycleStatus, 'FINALIZED');
  assert.equal(observed.operation.state, 'SUBMITTED');
  assert.equal(observed.receiptIdentityVerified, false);

  await assert.rejects(
    execute(fixture.service, {
      action: 'TRANSITION', ...leaseBody(lease), operationId: prepared.operation.operationId,
      targetState: 'VERIFIED', reasonCode: null,
      metadata: { transactionHash: HASH_A, postStateStatus: 'RESOLVED', postStateVerified: true },
    }, 24),
    (error) => error.code === 'KEEPER_JOURNAL_TRANSITION_CONFLICT',
  );
  const finalized = await execute(fixture.service, {
    action: 'TRANSITION', ...leaseBody(lease), operationId: prepared.operation.operationId,
    targetState: 'FINALIZED_SUCCESS', reasonCode: null,
    metadata: {
      transactionHash: HASH_A,
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: true,
      executionVerified: true,
    },
  }, 25);
  assert.equal(finalized.operation.state, 'FINALIZED_SUCCESS');
  const verified = await execute(fixture.service, {
    action: 'TRANSITION', ...leaseBody(lease), operationId: prepared.operation.operationId,
    targetState: 'VERIFIED', reasonCode: null,
    metadata: { transactionHash: HASH_A, postStateStatus: 'RESOLVED', postStateVerified: true },
  }, 26);
  assert.equal(verified.operation.state, 'VERIFIED');
});

test('recovery uses bounded keyset pagination across attention records', async () => {
  const fixture = service();
  const lease = (await acquire(fixture.service, HOLDER_A, 30)).lease;
  for (const [index, epoch] of ['1800014400', '1800018000', '1800021600'].entries()) {
    const prepared = await execute(fixture.service, {
      action: 'PREPARE', ...leaseBody(lease), operation: operation(epoch),
    }, 31 + index * 2);
    await execute(fixture.service, {
      action: 'TRANSITION', ...leaseBody(lease), operationId: prepared.operation.operationId,
      targetState: 'STATE_SATISFIED_UNPROVEN', reasonCode: 'POST_STATE_ALREADY_SATISFIED',
      metadata: { postStateStatus: 'RESOLVED', postStateVerified: true },
    }, 32 + index * 2);
  }
  const first = await execute(fixture.service, {
    action: 'RECOVER', ...leaseBody(lease), cursor: null, limit: 2,
  }, 40);
  assert.equal(first.operations.length, 2);
  assert.equal(typeof first.page.nextCursor, 'string');
  const second = await execute(fixture.service, {
    action: 'RECOVER', ...leaseBody(lease), cursor: first.page.nextCursor, limit: 2,
  }, 41);
  assert.equal(second.operations.length, 1);
  assert.equal(second.page.nextCursor, null);
  assert.notEqual(second.operations[0].operationId, first.operations[1].operationId);
});

test('same idempotency key cannot authorize a different mutation body', async () => {
  const fixture = service();
  const request = parseKeeperJournalRequest({
    action: 'LEASE_ACQUIRE', holderId: HOLDER_A, signerAddress: SIGNER, leaseSeconds: 900,
  });
  await fixture.service.execute({ request, idempotencyKey: 'keeper:test:idempotent' });
  const changed = parseKeeperJournalRequest({
    action: 'LEASE_ACQUIRE', holderId: HOLDER_A, signerAddress: SIGNER, leaseSeconds: 600,
  });
  await assert.rejects(
    fixture.service.execute({ request: changed, idempotencyKey: 'keeper:test:idempotent' }),
    (error) => error.code === 'KEEPER_JOURNAL_IDEMPOTENCY_CONFLICT',
  );
});

test('database outage while claiming PREPARE cannot reach the preparation mutation', async () => {
  let prepareCalls = 0;
  const repository = {
    async claimRequest() {
      throw new KeeperJournalError(
        'KEEPER_JOURNAL_DATABASE_UNAVAILABLE',
        'database unavailable',
        { statusCode: 503 },
      );
    },
    async prepare() { prepareCalls += 1; },
  };
  const instance = createKeeperJournalService({ repository, environment: ENVIRONMENT });
  await assert.rejects(
    execute(instance, {
      action: 'PREPARE',
      holderId: HOLDER_A,
      signerAddress: SIGNER,
      fencingToken: '1',
      operation: operation(),
    }, 99),
    (error) => error.code === 'KEEPER_JOURNAL_DATABASE_UNAVAILABLE',
  );
  assert.equal(prepareCalls, 0);
});
