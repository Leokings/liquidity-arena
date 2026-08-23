import assert from 'node:assert/strict';
import test from 'node:test';

import { createNeonKeeperJournalRepository } from '../keeper-journal/repository.mjs';
import { keeperAttemptOperationId } from '../keeper-journal/schema.mjs';

const SIGNER = '0x12ba664a1ec9ca78b070d103c6a69e20673f4b51';
const HOLDER = '123e4567-e89b-42d3-a456-426614174000';
const OPERATION_ID = 'a'.repeat(64);
const HASH = `0x${'b'.repeat(64)}`;

function operationRow(overrides = {}) {
  const operationId = overrides.operation_id || OPERATION_ID;
  return {
    operation_id: operationId,
    logical_operation_id: overrides.logical_operation_id || operationId,
    attempt_number: overrides.attempt_number || '1',
    retry_of_operation_id: overrides.retry_of_operation_id || null,
    deployment_alias: 'v8',
    network: 'bradbury',
    chain_id: '4221',
    signer_address: SIGNER,
    contract_address: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef',
    method: 'resolve_epoch',
    arguments: ['1800014400'],
    value_atto: '0',
    epoch_end_timestamp: '1800014400',
    subject_type: 'epoch',
    subject_id: '1800014400',
    state: 'SUBMITTED',
    transaction_hash: HASH,
    lifecycle_status: 'UNKNOWN',
    lifecycle_observed_at: null,
    pipeline_slot: 0,
    handoff_predecessor_operation_id: null,
    accepted_at: null,
    acceptance_revalidated_at: null,
    acceptance_metadata: null,
    state_reason_code: null,
    quarantine_reason: null,
    prepared_at: '2026-08-20T00:00:00.000Z',
    submitted_at: '2026-08-20T00:00:01.000Z',
    finalized_at: null,
    verified_at: null,
    updated_at: '2026-08-20T00:00:01.000Z',
    revision: '2',
    ...overrides,
  };
}

function acceptedEvidence(row = operationRow()) {
  return {
    transactionHash: row.transaction_hash,
    contractAddress: row.contract_address,
    recipient: row.contract_address,
    method: row.method,
    arguments: [...row.arguments],
    lifecycleStatus: 'ACCEPTED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    receiptIdentityVerified: true,
    executionVerified: true,
    executionSucceeded: true,
  };
}

function fixture(responses) {
  const calls = [];
  const repository = createNeonKeeperJournalRepository({
    environment: { DATABASE_URL: 'postgresql://user:password@example.invalid/db' },
    importDriver: async () => ({
      neon() {
        return {
          async query(sql, params, options) {
            calls.push({ sql, params, options });
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return typeof response === 'function' ? response({ sql, params, options }) : response;
          },
        };
      },
    }),
  });
  return { repository, calls };
}

function assertBradburyV8Isolation(sql) {
  assert.match(sql, /deployment_alias = 'v8'/);
  assert.match(sql, /network = 'bradbury'/);
  assert.match(sql, /chain_id = 4221/);
}

function healthySchemaRow(overrides = {}) {
  return {
    leases_exists: true,
    operations_exists: true,
    requests_exists: true,
    conflicts_exists: true,
    request_action_constraint_valid: true,
    guard_function_exists: true,
    guard_trigger_exists: true,
    logical_attempt_key_exists: true,
    pipeline_slot_index_exists: true,
    attention_subject_index_exists: true,
    handoff_predecessor_index_exists: true,
    attention_index_exists: true,
    legacy_unresolved_index_absent: true,
    accepted_guard_function_exists: true,
    accepted_guard_trigger_exists: true,
    attempt_columns_exist: true,
    subject_columns_exist: true,
    accepted_handoff_columns_exist: true,
    accepted_handoff_constraints_exist: true,
    prehash_abandonment_columns_exist: true,
    prehash_abandonment_constraints_exist: true,
    base_migration_valid: true,
    attempt_migration_valid: true,
    v4_migration_valid: true,
    v5_migration_valid: true,
    v6_migration_valid: true,
    migration_valid: true,
    no_unknown_migrations: true,
    ...overrides,
  };
}

test('health requires the exact version 7 pre-hash abandonment schema and its prerequisites', async () => {
  const { repository, calls } = fixture([[healthySchemaRow()]]);
  assert.deepEqual(await repository.health(), { configured: true, ready: true, schemaVersion: 7 });
  assert.match(calls[0].sql, /version = 2[\s\S]*version = 3[\s\S]*version = 4[\s\S]*version = 5[\s\S]*version = 6[\s\S]*version = 7/);
  assert.match(calls[0].sql, /logical_operation_id/);
  assert.match(calls[0].sql, /arena_keeper_operations_logical_attempt_key/);
  assert.match(calls[0].sql, /subject_type[\s\S]*subject_id/);
  assert.match(calls[0].sql, /accepted_at[\s\S]*acceptance_revalidated_at[\s\S]*acceptance_metadata/);
  assert.match(calls[0].sql, /arena_keeper_journal_requests_request_action_check[\s\S]*ABANDON_PREHASH/);
  assert.match(calls[0].sql, /prehash_abandoned_at[\s\S]*prehash_abandonment_metadata/);
  assert.match(calls[0].sql, /NOT EXISTS \([\s\S]*version > 7/);
  assert.equal(calls[0].params.length, 6);
});

test('health rejects an otherwise valid database with a migration newer than V7', async () => {
  const { repository } = fixture([[healthySchemaRow({ no_unknown_migrations: false })]]);
  assert.deepEqual(await repository.health(), { configured: true, ready: false, schemaVersion: null });
});

test('health fails closed when any accepted handoff column is missing', async () => {
  const { repository } = fixture([[
    healthySchemaRow({ accepted_handoff_columns_exist: false }),
  ]]);
  assert.deepEqual(await repository.health(), {
    configured: true,
    ready: false,
    schemaVersion: null,
  });
});

test('health fails closed when ACCEPT_HANDOFF is absent from the request-action constraint', async () => {
  const { repository } = fixture([[
    healthySchemaRow({ request_action_constraint_valid: false }),
  ]]);
  assert.deepEqual(await repository.health(), {
    configured: true,
    ready: false,
    schemaVersion: null,
  });
});

test('lease acquire increments the global fence and adopts every attention record', async () => {
  const { repository, calls } = fixture([{
    holder_id: HOLDER,
    signer_address: SIGNER,
    fencing_token: '9',
    lease_expires_at: '2026-08-20T00:15:00.000Z',
    newly_acquired: true,
  }].map((row) => [row]));
  const result = await repository.acquireLease({
    holderId: HOLDER, signerAddress: SIGNER, leaseSeconds: 900,
  });
  assert.equal(result.fencingToken, '9');
  assert.equal(result.newlyAcquired, true);
  assert.match(calls[0].sql, /fencing_token = arena_keeper_signer_leases\.fencing_token \+ 1/);
  assert.match(calls[0].sql, /fenced_operations AS/);
  assert.match(calls[0].sql, /STATE_SATISFIED_UNPROVEN/);
  assertBradburyV8Isolation(calls[0].sql);
  assert.equal(calls[0].options.fetchOptions.signal instanceof AbortSignal, true);
});

test('stale lease renewals are rejected by holder, signer, and monotonic fencing token', async () => {
  const { repository, calls } = fixture([[]]);
  await assert.rejects(
    repository.renewLease({
      holderId: HOLDER, signerAddress: SIGNER, fencingToken: '8', leaseSeconds: 900,
    }),
    (error) => error.code === 'KEEPER_JOURNAL_FENCE_REJECTED',
  );
  assert.match(calls[0].sql, /holder_id = \$3::uuid/);
  assert.match(calls[0].sql, /fencing_token = \$4::bigint/);
  assert.match(calls[0].sql, /lease_expires_at > now\(\)/);
});

test('ACCEPT_HANDOFF atomically persists exact row-bound successful receipt evidence', async () => {
  const base = operationRow({ lifecycle_status: 'ACCEPTED' });
  const evidence = acceptedEvidence(base);
  const accepted = operationRow({
    lifecycle_status: 'ACCEPTED',
    lifecycle_observed_at: '2026-08-20T00:01:30.000Z',
    accepted_at: '2026-08-20T00:01:00.000Z',
    acceptance_revalidated_at: '2026-08-20T00:01:30.000Z',
    acceptance_metadata: evidence,
  });
  const { repository, calls } = fixture([[
    {
      lease_valid: true,
      operation_exists: true,
      attempt_frozen: false,
      operation: accepted,
    },
  ]]);
  const result = await repository.acceptHandoff({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    operationId: OPERATION_ID,
    acceptanceEvidence: evidence,
  });
  assert.equal(result.lifecycleStatus, 'ACCEPTED');
  assert.equal(result.acceptedAt, '2026-08-20T00:01:00.000Z');
  assert.equal(result.acceptanceRevalidatedAt, '2026-08-20T00:01:30.000Z');
  assert.deepEqual(result.acceptanceEvidence, evidence);
  assert.match(calls[0].sql, /accepted_at = COALESCE\(target\.accepted_at, clock_timestamp\(\)\)/);
  assert.match(calls[0].sql, /acceptance_revalidated_at = clock_timestamp\(\)/);
  assert.match(calls[0].sql, /target\.state = 'SUBMITTED'/);
  for (const field of [
    'transactionHash', 'contractAddress', 'recipient', 'method', 'arguments',
    'ACCEPTED', 'FINISHED_WITH_RETURN', 'receiptIdentityVerified',
    'executionVerified', 'executionSucceeded',
  ]) assert.match(calls[0].sql, new RegExp(field));
  assert.equal(calls[0].params[5], JSON.stringify(evidence));
  assertBradburyV8Isolation(calls[0].sql);
});

test('ABANDON_PREHASH terminalizes only a hashless PREPARED row under exact evidence', async () => {
  const evidence = {
    evidenceVersion: 'LOCAL_PRESPAWN_FAILURE_V1',
    broadcastAttempted: false,
    transactionHashObserved: false,
    failureCode: 'GENLAYER_PROCESS_NOT_STARTED',
    failureMessage: 'GenLayer process could not be started.',
    lowerLevelErrorRetained: true,
    operationId: OPERATION_ID,
    logicalOperationId: OPERATION_ID,
    contractAddress: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef',
    method: 'resolve_epoch',
    arguments: ['1800014400'],
    subjectType: 'epoch',
    subjectId: '1800014400',
    preparedAt: '2026-08-20T00:00:00.000Z',
  };
  const abandoned = operationRow({
    state: 'ABANDONED_PREHASH',
    transaction_hash: null,
    lifecycle_status: null,
    pipeline_slot: 0,
    submitted_at: null,
    prehash_abandoned_at: '2026-08-20T00:00:02.000Z',
    prehash_abandonment_metadata: evidence,
    state_reason_code: 'DEFINITE_LOCAL_PRESPAWN_FAILURE',
  });
  const { repository, calls } = fixture([[
    {
      lease_valid: true,
      operation_exists: true,
      attempt_frozen: false,
      operation: abandoned,
    },
  ]]);
  const result = await repository.abandonPrehash({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    operationId: OPERATION_ID,
    reasonCode: 'DEFINITE_LOCAL_PRESPAWN_FAILURE',
    evidence,
  });
  assert.equal(result.state, 'ABANDONED_PREHASH');
  assert.equal(result.transactionHash, null);
  assert.deepEqual(result.prehashAbandonmentEvidence, evidence);
  assert.match(calls[0].sql, /target\.state = 'PREPARED'/);
  assert.match(calls[0].sql, /target\.transaction_hash IS NULL/);
  assert.match(calls[0].sql, /broadcastAttempted.*false/);
  assert.match(calls[0].sql, /'operationId' = target\.operation_id/);
  assert.match(calls[0].sql, /'logicalOperationId' = target\.logical_operation_id/);
  assert.match(calls[0].sql, /'method' = target\.method/);
  assert.match(calls[0].sql, /'arguments' = target\.arguments/);
  assert.match(calls[0].sql, /'preparedAt'\)::timestamptz = target\.prepared_at/);
  assert.match(calls[0].sql, /matchingOuterTransactions.*'0'/);
  assertBradburyV8Isolation(calls[0].sql);
});

test('hash conflict response is quarantined without overwriting the immutable stored hash', async () => {
  const row = operationRow({
    state: 'QUARANTINED',
    quarantine_reason: 'SUBMISSION_HASH_CONFLICT',
  });
  const { repository, calls } = fixture([{
    lease_valid: true,
    operation_exists: true,
    hash_conflict: true,
    operation: row,
  }].map((value) => [value]));
  await assert.rejects(
    repository.bindSubmission({
      holderId: HOLDER,
      signerAddress: SIGNER,
      fencingToken: '9',
      operationId: OPERATION_ID,
      transactionHash: `0x${'c'.repeat(64)}`,
    }),
    (error) => error.code === 'KEEPER_JOURNAL_HASH_CONFLICT',
  );
  assert.match(calls[0].sql, /ELSE target\.transaction_hash/);
  assert.match(calls[0].sql, /SUBMISSION_HASH_CONFLICT/);
  assert.match(calls[0].sql, /arena_keeper_operation_conflicts/);
  assertBradburyV8Isolation(calls[0].sql);
});

test('transition query permits VERIFIED only from FINALIZED_SUCCESS or idempotent VERIFIED', async () => {
  const row = operationRow({
    state: 'VERIFIED', lifecycle_status: 'FINALIZED',
    finalized_at: '2026-08-20T00:02:00.000Z',
    verified_at: '2026-08-20T00:02:01.000Z',
  });
  const { repository, calls } = fixture([[{
    lease_valid: true, operation_exists: true, operation: row,
  }]]);
  const result = await repository.transition({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    operationId: OPERATION_ID,
    targetState: 'VERIFIED',
    reasonCode: null,
    metadata: { transactionHash: HASH, postStateStatus: 'RESOLVED', postStateVerified: true },
  });
  assert.equal(result.state, 'VERIFIED');
  assert.deepEqual(calls[0].params.at(-1), ['FINALIZED_SUCCESS', 'VERIFIED']);
  assert.match(calls[0].sql, /target\.state = ANY\(\$9::text\[\]\)/);
  assert.match(calls[0].sql, /postStateVerified/);
  assert.match(calls[0].sql, /SELECT count\(\*\) FROM jsonb_object_keys\(\$8::jsonb\)/);
  assert.match(calls[0].sql, /target\.metadata_key_count = 3/);
  assert.doesNotMatch(calls[0].sql, /jsonb_object_length/);
  assert.match(calls[0].sql, /executionSucceeded/);
  assert.match(calls[0].sql, /RECEIPT_IDENTITY_AMBIGUOUS/);
  assert.match(calls[0].sql, /quarantine_reason = CASE/);
  assertBradburyV8Isolation(calls[0].sql);
});

test('transition query clears only an exact generic identity quarantine after successful receipt proof', async () => {
  const row = operationRow({
    state: 'FINALIZED_SUCCESS',
    lifecycle_status: 'FINALIZED',
    state_reason_code: null,
    quarantine_reason: null,
    finalized_at: '2026-08-20T00:02:00.000Z',
  });
  const { repository, calls } = fixture([[{
    lease_valid: true, operation_exists: true, attempt_frozen: false, operation: row,
  }]]);
  const result = await repository.transition({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    operationId: OPERATION_ID,
    targetState: 'FINALIZED_SUCCESS',
    reasonCode: null,
    metadata: {
      transactionHash: HASH,
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: true,
      executionVerified: true,
    },
  });
  assert.equal(result.state, 'FINALIZED_SUCCESS');
  assert.deepEqual(calls[0].params.at(-1), ['SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED']);
  assert.match(calls[0].sql, /target\.state = 'QUARANTINED'[\s\S]*\$6 = 'FINALIZED_SUCCESS'[\s\S]*THEN NULL/);
  assert.match(
    calls[0].sql,
    /target\.quarantine_reason = 'RECEIPT_IDENTITY_AMBIGUOUS'[\s\S]*target\.state_reason_code = 'RECEIPT_IDENTITY_AMBIGUOUS'/,
  );
  assert.match(calls[0].sql, /receiptIdentityVerified[\s\S]*executionVerified/);
});

test('recovery query is keyset-paginated and asks for only limit plus one rows', async () => {
  const rows = [
    operationRow({ operation_id: 'a'.repeat(64) }),
    operationRow({ operation_id: 'b'.repeat(64), prepared_at: '2026-08-20T00:00:02.000Z' }),
    operationRow({ operation_id: 'c'.repeat(64), prepared_at: '2026-08-20T00:00:03.000Z' }),
  ];
  const { repository, calls } = fixture([rows]);
  const result = await repository.recover({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    cursor: { preparedAt: '2026-08-19T23:59:00.000Z', operationId: '0'.repeat(64) },
    limit: 2,
  });
  assert.equal(result.length, 3);
  assert.equal(calls[0].params.at(-1), 3);
  assert.match(calls[0].sql, /\(operation\.prepared_at, operation\.operation_id\) >/);
  assert.match(calls[0].sql, /ORDER BY operation\.prepared_at, operation\.operation_id/);
  assertBradburyV8Isolation(calls[0].sql);
});

test('database constraints hard-bound the two-slot pipeline and same-subject admission', async () => {
  const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
  const { repository, calls } = fixture([duplicate]);
  await assert.rejects(
    repository.prepare({
      holderId: HOLDER,
      signerAddress: SIGNER,
      fencingToken: '9',
      operation: {
        operationId: OPERATION_ID,
        deploymentAlias: 'v8',
        contractAddress: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef',
        subjectType: 'epoch',
        subjectId: '1800014400',
        method: 'resolve_epoch',
        args: ['1800014400'],
        valueAtto: '0',
        canonicalOperation: '{}',
      },
    }),
    (error) => error.code === 'KEEPER_JOURNAL_UNRESOLVED_OPERATION',
  );
  assert.match(calls[0].sql, /generate_series\(0, 1\)/);
  assert.match(calls[0].sql, /\(SELECT count\(\*\) FROM attention\) < 2/);
  assert.match(calls[0].sql, /duplicate_subject/);
  assert.match(calls[0].sql, /handoff_predecessor_operation_id/);
  assert.match(calls[0].sql, /acceptance_revalidated_at >= now\(\) - interval '2 minutes'/);
  assertBradburyV8Isolation(calls[0].sql);
});

test('PREPARE grants one-shot broadcast authorization only to the inserted attempt', async () => {
  const prepared = operationRow({
    state: 'PREPARED',
    transaction_hash: null,
    lifecycle_status: null,
    submitted_at: null,
    prepared_fencing_token: '9',
    inserted_now: false,
    prepared_at: '2026-08-20T00:00:00.000+00:00',
    updated_at: '2026-08-20T00:00:00.000+00:00',
  });
  const { repository } = fixture([[{
    lease_valid: true,
    operation_exists: true,
    unresolved_blocked: true,
    operation: prepared,
  }]]);
  const result = await repository.prepare({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    operation: {
      operationId: OPERATION_ID,
      deploymentAlias: 'v8',
      contractAddress: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef',
      subjectType: 'epoch',
      subjectId: '1800014400',
      method: 'resolve_epoch',
      args: ['1800014400'],
      valueAtto: '0',
      canonicalOperation: '{}',
    },
  });
  assert.equal(result.inserted, false);
  assert.equal(result.canBroadcast, false);
  assert.equal(result.operation.preparedAt, '2026-08-20T00:00:00.000Z');
  assert.equal(result.operation.updatedAt, '2026-08-20T00:00:00.000Z');
});

test('PREPARE appends after finalized failure, pre-hash abandonment, or verified repeatable retry only', async () => {
  const retryOperationId = keeperAttemptOperationId(OPERATION_ID, '2');
  const preparedRetry = operationRow({
    operation_id: retryOperationId,
    logical_operation_id: OPERATION_ID,
    attempt_number: '2',
    retry_of_operation_id: OPERATION_ID,
    state: 'PREPARED',
    transaction_hash: null,
    lifecycle_status: null,
    submitted_at: null,
    prepared_fencing_token: '9',
    inserted_now: true,
  });
  const { repository, calls } = fixture([[{
    lease_valid: true,
    operation_exists: true,
    unresolved_blocked: false,
    audited_retry_nonce: '73',
    operation: preparedRetry,
  }]]);
  const result = await repository.prepare({
    holderId: HOLDER,
    signerAddress: SIGNER,
    fencingToken: '9',
    operation: {
      operationId: OPERATION_ID,
      deploymentAlias: 'v8',
      contractAddress: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef',
      subjectType: 'epoch',
      subjectId: '1800014400',
      method: 'resolve_epoch',
      args: ['1800014400'],
      valueAtto: '0',
      canonicalOperation: '{}',
    },
  });
  assert.equal(result.operation.logicalOperationId, OPERATION_ID);
  assert.equal(result.operation.operationId, retryOperationId);
  assert.equal(result.operation.attemptNumber, '2');
  assert.equal(result.operation.retryOfOperationId, OPERATION_ID);
  assert.equal(result.inserted, true);
  assert.equal(result.canBroadcast, true);
  assert.equal(result.auditedRetryNonce, '73');
  assert.match(calls[0].sql, /exact_latest\.state = 'FINALIZED_FAILURE'/);
  assert.match(calls[0].sql, /exact_latest\.state = 'ABANDONED_PREHASH'[\s\S]*exact_latest\.attempt_number = 1/);
  assert.match(calls[0].sql, /exact_latest\.state = 'VERIFIED'/);
  assert.match(calls[0].sql, /exact_latest\.method IN \('retry_prepare_payout', 'retry_payout'\)/);
  assert.match(calls[0].sql, /sha256\(convert_to/);
  assert.match(calls[0].sql, /exact_latest\.state NOT IN \('FINALIZED_FAILURE', 'ABANDONED_PREHASH'\)/);
  assert.match(calls[0].sql, /prehash_abandonment_metadata ->> 'nonceAtStart'/);
});

test('a delayed parent quarantine is rejected after its retry attempt exists', async () => {
  const { repository, calls } = fixture([[
    {
      lease_valid: true,
      operation_exists: true,
      attempt_frozen: true,
      operation: null,
    },
  ]]);
  await assert.rejects(
    repository.transition({
      holderId: HOLDER,
      signerAddress: SIGNER,
      fencingToken: '9',
      operationId: OPERATION_ID,
      targetState: 'QUARANTINED',
      reasonCode: 'RECEIPT_HASH_MISMATCH',
      metadata: {
        transactionHash: HASH,
        lifecycleStatus: 'FINALIZED',
        receiptIdentityVerified: false,
        ambiguityCode: 'RECEIPT_HASH_MISMATCH',
      },
    }),
    (error) => error.code === 'KEEPER_JOURNAL_ATTEMPT_FROZEN',
  );
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[0].sql, /later\.attempt_number > operation\.attempt_number/);
  assert.equal(calls[0].params.at(-1).includes('FINALIZED_FAILURE'), false);
  assert.equal(calls[0].params.at(-1).includes('VERIFIED'), false);
});
