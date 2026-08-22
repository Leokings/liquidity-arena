import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicalKeeperOperation,
  decodeRecoveryCursor,
  encodeRecoveryCursor,
  keeperAttemptOperationId,
  normalizedIdempotencyKey,
  parseKeeperJournalRequest,
} from '../keeper-journal/schema.mjs';

const SIGNER_MIXED = '0x12BA664A1EC9CA78B070D103C6A69E20673F4B51';
const CONTRACT_MIXED = '0xB2AE59AE641F571726AE81E30080F8C2192B15EF';
const HOLDER = '123e4567-e89b-42d3-a456-426614174000';
const EPOCH = '1800014400';
const TRANSACTION_HASH = `0x${'a'.repeat(64)}`;

function operation(overrides = {}) {
  return {
    deploymentAlias: 'v8',
    chainId: '4221',
    contractAddress: CONTRACT_MIXED,
    subjectType: 'epoch',
    subjectId: EPOCH,
    method: 'resolve_epoch',
    args: [EPOCH],
    valueAtto: '0',
    ...overrides,
  };
}

test('operation identity is deterministic SHA-256 of exact canonical chain call identity', () => {
  const canonical = canonicalKeeperOperation(operation());
  assert.equal(canonical.contractAddress, CONTRACT_MIXED.toLowerCase());
  assert.equal(canonical.chainId, '4221');
  assert.equal(canonical.network, 'bradbury');
  assert.equal(canonical.subjectType, 'epoch');
  assert.equal(canonical.subjectId, EPOCH);
  assert.equal(canonical.valueAtto, '0');
  assert.equal(
    canonical.operationId,
    createHash('sha256').update(canonical.canonicalOperation, 'utf8').digest('hex'),
  );
  assert.equal(canonical.operationId, canonicalKeeperOperation(operation({
    contractAddress: CONTRACT_MIXED.toLowerCase(),
  })).operationId);
  assert.notEqual(canonical.operationId, canonicalKeeperOperation(operation({
    method: 'activate_timeout_refund',
  })).operationId);
});

test('attempt identity preserves the logical ID for attempt one and hashes every retry', () => {
  const logicalOperationId = canonicalKeeperOperation(operation()).operationId;
  assert.equal(keeperAttemptOperationId(logicalOperationId, '1'), logicalOperationId);
  assert.equal(
    keeperAttemptOperationId(logicalOperationId, '2'),
    createHash('sha256').update(`${logicalOperationId}:2`, 'utf8').digest('hex'),
  );
  assert.notEqual(
    keeperAttemptOperationId(logicalOperationId, '2'),
    keeperAttemptOperationId(logicalOperationId, '3'),
  );
  assert.throws(() => keeperAttemptOperationId(logicalOperationId, '0'), /positive/);
});

test('payout operations bind one lowercase payout ID on Bradbury without an epoch field', () => {
  const payoutId = 'b'.repeat(64);
  const canonical = canonicalKeeperOperation({
    deploymentAlias: 'v8',
    chainId: '4221',
    contractAddress: CONTRACT_MIXED,
    subjectType: 'payout',
    subjectId: payoutId,
    method: 'dispatch_payout',
    args: [payoutId],
    valueAtto: '0',
  });
  assert.equal(canonical.network, 'bradbury');
  assert.equal(canonical.subjectType, 'payout');
  assert.equal(canonical.subjectId, payoutId);
  assert.equal(Object.hasOwn(canonical, 'epochEndTimestamp'), false);
  assert.throws(
    () => canonicalKeeperOperation({
      deploymentAlias: 'v8',
      chainId: '4221',
      contractAddress: CONTRACT_MIXED,
      subjectType: 'payout',
      subjectId: payoutId.toUpperCase(),
      method: 'dispatch_payout',
      args: [payoutId.toUpperCase()],
      valueAtto: '0',
    }),
    /lowercase 64-hex/,
  );
});

test('journal request canonicalizes RPC address casing and binds signer plus fencing token', () => {
  const request = parseKeeperJournalRequest({
    action: 'PREPARE',
    holderId: HOLDER,
    signerAddress: SIGNER_MIXED,
    fencingToken: '7',
    operation: operation(),
  });
  assert.equal(request.signerAddress, SIGNER_MIXED.toLowerCase());
  assert.equal(request.operation.contractAddress, CONTRACT_MIXED.toLowerCase());
  assert.match(request.operation.operationId, /^[0-9a-f]{64}$/);
});

test('journal schema fails closed for payable calls, legacy deployments, and secret metadata', () => {
  assert.throws(
    () => canonicalKeeperOperation(operation({ valueAtto: '1' })),
    /valueAtto equal to 0/,
  );
  assert.throws(
    () => canonicalKeeperOperation(operation({ deploymentAlias: 'v7' })),
    /deploymentAlias must be v8/,
  );
  assert.throws(
    () => parseKeeperJournalRequest({
      action: 'TRANSITION',
      holderId: HOLDER,
      signerAddress: SIGNER_MIXED,
      fencingToken: '7',
      operationId: 'a'.repeat(64),
      targetState: 'FINALIZED_SUCCESS',
      reasonCode: null,
      metadata: { privateKey: 'must-never-be-stored' },
    }),
    /forbidden field/,
  );
  assert.throws(
    () => parseKeeperJournalRequest({
      action: 'TRANSITION',
      holderId: HOLDER,
      signerAddress: SIGNER_MIXED,
      fencingToken: '7',
      operationId: 'a'.repeat(64),
      targetState: 'FINALIZED_SUCCESS',
      reasonCode: null,
      metadata: {},
    }),
    /unexpected fields|receipt evidence metadata/,
  );

  const successfulReceipt = {
    transactionHash: TRANSACTION_HASH,
    lifecycleStatus: 'FINALIZED',
    receiptIdentityVerified: true,
    executionVerified: true,
  };
  for (const extra of [
    { KEEPER_JOURNAL_SECRET: 'must-never-be-stored' },
    { keeperPassword: 'must-never-be-stored' },
    { keystorePassword: 'must-never-be-stored' },
    { apiKey: 'must-never-be-stored' },
    { authorizationHeader: 'must-never-be-stored' },
    { databaseUrlPrimary: 'must-never-be-stored' },
    { details: { apiKey: 'must-never-be-stored' } },
  ]) {
    assert.throws(
      () => parseKeeperJournalRequest({
        action: 'TRANSITION',
        holderId: HOLDER,
        signerAddress: SIGNER_MIXED,
        fencingToken: '7',
        operationId: 'a'.repeat(64),
        targetState: 'FINALIZED_SUCCESS',
        reasonCode: null,
        metadata: { ...successfulReceipt, ...extra },
      }),
      /forbidden field|unexpected fields/,
    );
  }

  assert.throws(
    () => parseKeeperJournalRequest({
      action: 'TRANSITION',
      holderId: HOLDER,
      signerAddress: SIGNER_MIXED,
      fencingToken: '7',
      operationId: 'a'.repeat(64),
      targetState: 'FINALIZED_FAILURE',
      reasonCode: 'ARBITRARY_FAILURE',
      metadata: {},
    }),
    /unexpected fields|failure receipt evidence/,
  );
  const finalizedFailure = parseKeeperJournalRequest({
    action: 'TRANSITION',
    holderId: HOLDER,
    signerAddress: SIGNER_MIXED,
    fencingToken: '7',
    operationId: 'a'.repeat(64),
    targetState: 'FINALIZED_FAILURE',
    reasonCode: 'FINALIZED_EXECUTION_FAILED',
    metadata: {
      transactionHash: TRANSACTION_HASH.toUpperCase().replace('0X', '0x'),
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: true,
      executionVerified: true,
      executionSucceeded: false,
    },
  });
  assert.equal(finalizedFailure.metadata.transactionHash, TRANSACTION_HASH);

  const quarantined = parseKeeperJournalRequest({
    action: 'TRANSITION',
    holderId: HOLDER,
    signerAddress: SIGNER_MIXED,
    fencingToken: '7',
    operationId: 'a'.repeat(64),
    targetState: 'QUARANTINED',
    reasonCode: 'RECEIPT_METHOD_MISMATCH',
    metadata: {
      transactionHash: TRANSACTION_HASH,
      lifecycleStatus: 'FINALIZED',
      receiptIdentityVerified: false,
      ambiguityCode: 'RECEIPT_METHOD_MISMATCH',
    },
  });
  assert.equal(quarantined.metadata.ambiguityCode, quarantined.reasonCode);
  assert.throws(
    () => parseKeeperJournalRequest({
      ...quarantined,
      metadata: { ...quarantined.metadata, ambiguityCode: 'RECEIPT_HASH_MISMATCH' },
    }),
    /receipt ambiguity evidence/,
  );
});

test('request schemas reject unknown fields and require bounded idempotency keys', () => {
  assert.throws(
    () => parseKeeperJournalRequest({ action: 'HEALTH', secret: 'no' }),
    /unexpected fields/,
  );
  assert.throws(() => normalizedIdempotencyKey('short'), /Idempotency-Key/);
  assert.equal(normalizedIdempotencyKey('keeper:test:00000001'), 'keeper:test:00000001');
});

test('recovery cursors are canonical, opaque, and round-trip immutable keyset fields', () => {
  const cursor = encodeRecoveryCursor({
    operationId: 'a'.repeat(64),
    preparedAt: '2026-08-20T00:00:00.000Z',
  });
  assert.deepEqual(decodeRecoveryCursor(cursor), {
    operationId: 'a'.repeat(64),
    preparedAt: '2026-08-20T00:00:00.000Z',
  });
  const duplicate = Buffer.from(
    `{"preparedAt":"2026-08-20T00:00:00.000Z","operationId":"${'a'.repeat(64)}","operationId":"${'a'.repeat(64)}"}`,
  ).toString('base64url');
  assert.throws(() => decodeRecoveryCursor(duplicate), /cursor is invalid/);
  assert.throws(
    () => encodeRecoveryCursor({
      operationId: 'a'.repeat(64),
      preparedAt: '2026-08-20T00:00:00.000456Z',
    }),
    /unsupported timestamp precision/,
  );
});
