import { createHash, randomUUID } from 'node:crypto';

import { StrictKeeperJsonParser } from './http.mjs';
import {
  canonicalKeeperOperation,
  keeperPrehashEvidenceDigest,
  keeperAttemptOperationId,
  normalizedIdempotencyKey,
} from './schema.mjs';
import { normalizeDurableSignedEvidence } from './signed-transaction.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024;
const SUBMISSION_EVIDENCE_KEYS = Object.freeze([
  'transactionHash', 'outerTransactionHash', 'receiptBlockHash',
  'receiptBlockNumber', 'finalizedHeadBlockNumber', 'eventTopic', 'logIndex',
  'eventActivator', 'receiptIdentityVerified', 'evidenceSha256',
]);

export class KeeperJournalClientError extends Error {
  constructor(code, message, { statusCode = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'KeeperJournalClientError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validatedEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_CLIENT_CONFIG',
      'Keeper journal endpoint is invalid.',
    );
  }
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !loopback) || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_CLIENT_CONFIG',
      'Keeper journal endpoint must be an HTTPS URL without credentials, query, or fragment.',
    );
  }
  return parsed.toString();
}

function validatedSecret(value) {
  const secret = String(value || '');
  if (secret !== secret.trim() || secret.length < 32 || secret.length > 1024 || /[\r\n]/.test(secret)) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_CLIENT_CONFIG',
      'Keeper journal secret is invalid.',
    );
  }
  return secret;
}

function leaseFields(lease) {
  if (!lease || typeof lease !== 'object') {
    throw new KeeperJournalClientError('KEEPER_JOURNAL_CLIENT_SCHEMA', 'An explicit lease is required.');
  }
  return Object.freeze({
    holderId: String(lease.holderId || ''),
    signerAddress: String(lease.signerAddress || ''),
    fencingToken: String(lease.fencingToken || ''),
  });
}

async function readBoundedResponse(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SIZE',
      'Keeper journal response is too large.',
      { statusCode: response.status },
    );
  }
  const chunks = [];
  let total = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new KeeperJournalClientError(
            'KEEPER_JOURNAL_RESPONSE_SIZE',
            'Keeper journal response is too large.',
            { statusCode: response.status },
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) {
      throw new KeeperJournalClientError(
        'KEEPER_JOURNAL_RESPONSE_SIZE',
        'Keeper journal response is too large.',
        { statusCode: response.status },
      );
    }
    chunks.push(bytes);
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  try {
    return new StrictKeeperJsonParser(source).document();
  } catch (error) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_JSON',
      'Keeper journal returned an invalid JSON response.',
      { statusCode: response.status, cause: error },
    );
  }
}

function responseObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SHAPE',
      `Keeper journal returned an invalid ${label}.`,
    );
  }
  return value;
}

function exactResponseKeys(value, keys, label) {
  responseObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SHAPE',
      `Keeper journal returned an invalid ${label}.`,
    );
  }
}

function sameExactScalarRecord(left, right, keys) {
  if (left === null || right === null
      || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) || Array.isArray(right)) {
    return false;
  }
  const expectedKeys = [...keys].sort();
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === expectedKeys.length
    && rightKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => leftKeys[index] === key && rightKeys[index] === key)
    && expectedKeys.every((key) => left[key] === right[key]);
}

function validatedLease(value, acquire) {
  exactResponseKeys(
    value,
    acquire
      ? ['holderId', 'signerAddress', 'fencingToken', 'expiresAt', 'newlyAcquired']
      : ['holderId', 'signerAddress', 'fencingToken', 'expiresAt'],
    'lease',
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.holderId)
      || !/^0x[0-9a-f]{40}$/.test(value.signerAddress)
      || !/^[1-9]\d{0,18}$/.test(value.fencingToken)
      || typeof value.expiresAt !== 'string'
      || Number.isNaN(Date.parse(value.expiresAt))
      || (acquire && typeof value.newlyAcquired !== 'boolean')) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SHAPE',
      'Keeper journal returned an invalid lease.',
    );
  }
  return Object.freeze({ ...value });
}

function validatedOperation(value) {
  const keys = [
    'operationId', 'logicalOperationId', 'attemptNumber', 'retryOfOperationId',
    'deploymentAlias', 'network', 'chainId', 'signerAddress',
    'contractAddress', 'subjectType', 'subjectId', 'method', 'args', 'valueAtto',
    'state', 'submissionProtocol', 'outerTransactionHash', 'outerSenderNonce',
    'signedEvidenceSha256', 'signedAt', 'signedTransactionEvidence',
    'outerReceiptObservedAt', 'submissionEvidence', 'outerOutcomeEvidence',
    'transactionHash', 'lifecycleStatus', 'lifecycleObservedAt',
    'pipelineSlot', 'handoffPredecessorOperationId', 'acceptedAt',
    'acceptanceRevalidatedAt', 'acceptanceEvidence',
    'prehashAbandonedAt', 'prehashAbandonmentEvidence',
    'stateReasonCode', 'quarantineReason', 'preparedAt', 'submittedAt',
    'finalizedAt', 'verifiedAt', 'updatedAt', 'revision',
  ];
  exactResponseKeys(value, keys, 'operation');
  const states = new Set([
    'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED',
    'FINALIZED_FAILURE', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
    'ABANDONED_PREHASH',
  ]);
  const timestamp = (entry) => typeof entry === 'string' && !Number.isNaN(Date.parse(entry));
  const canonicalTimestamp = (entry) => timestamp(entry)
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry)
    && new Date(entry).toISOString() === entry;
  const canonicalUnsigned = (entry) => typeof entry === 'string'
    && /^(?:0|[1-9]\d*)$/.test(entry);
  const nullableTimestamp = (entry) => entry === null || timestamp(entry);
  const lifecycleStatuses = new Set([
    'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED', 'FINALIZED',
  ]);
  const reasonCode = (entry) => entry === null || /^[A-Z][A-Z0-9_]{0,79}$/.test(entry);
  const acceptanceEvidence = value.acceptanceEvidence;
  const prehashAbandonmentEvidence = value.prehashAbandonmentEvidence;
  const signedTransactionEvidence = value.signedTransactionEvidence;
  const submissionEvidence = value.submissionEvidence;
  const outerOutcomeEvidence = value.outerOutcomeEvidence;
  const exactKeys = (candidate, expected) => candidate && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && Object.keys(candidate).sort().length === expected.length
    && [...expected].sort().every((key, index) => key === Object.keys(candidate).sort()[index]);
  const validSignedEvidence = signedTransactionEvidence === null || (
    exactKeys(signedTransactionEvidence, [
      'protocolVersion', 'outerTransactionHash', 'outerNonce', 'chainId',
      'signerAddress', 'consensusAddress', 'contractAddress', 'method',
      'arguments', 'valueAtto', 'gasLimit', 'gasPriceWei', 'validUntil',
      'calldataSha256',
    ])
    && signedTransactionEvidence.protocolVersion === 'BRADBURY_DURABLE_RAW_V1'
    && signedTransactionEvidence.outerTransactionHash === value.outerTransactionHash
    && signedTransactionEvidence.outerNonce === value.outerSenderNonce
    && signedTransactionEvidence.chainId === value.chainId
    && signedTransactionEvidence.signerAddress === value.signerAddress
    && signedTransactionEvidence.consensusAddress
      === '0x0112bf6e83497965a5fdd6dad1e447a6e004271d'
    && signedTransactionEvidence.contractAddress === value.contractAddress
    && signedTransactionEvidence.method === value.method
    && JSON.stringify(signedTransactionEvidence.arguments) === JSON.stringify(value.args)
    && signedTransactionEvidence.valueAtto === value.valueAtto
    && canonicalUnsigned(signedTransactionEvidence.gasLimit)
    && canonicalUnsigned(signedTransactionEvidence.gasPriceWei)
    && canonicalUnsigned(signedTransactionEvidence.validUntil)
    && /^[0-9a-f]{64}$/.test(signedTransactionEvidence.calldataSha256)
  );
  const validSubmissionEvidence = submissionEvidence === null || (
    exactKeys(submissionEvidence, SUBMISSION_EVIDENCE_KEYS)
    && submissionEvidence.transactionHash === value.transactionHash
    && submissionEvidence.outerTransactionHash === value.outerTransactionHash
    && /^0x[0-9a-f]{64}$/.test(submissionEvidence.receiptBlockHash)
    && canonicalUnsigned(submissionEvidence.receiptBlockNumber)
    && canonicalUnsigned(submissionEvidence.finalizedHeadBlockNumber)
    && BigInt(submissionEvidence.receiptBlockNumber)
      <= BigInt(submissionEvidence.finalizedHeadBlockNumber)
    && submissionEvidence.eventTopic
      === '0xdab9102861c7483a187584d6371d88316f005af507982ccf95c110879f3ed5a5'
    && canonicalUnsigned(submissionEvidence.logIndex)
    && /^0x[0-9a-f]{40}$/.test(submissionEvidence.eventActivator)
    && !/^0x0{40}$/.test(submissionEvidence.eventActivator)
    && submissionEvidence.receiptIdentityVerified === true
    && submissionEvidence.evidenceSha256 === value.signedEvidenceSha256
  );
  const validOuterFailureEvidence = outerOutcomeEvidence !== null
    && value.state === 'FINALIZED_FAILURE'
    && value.stateReasonCode === 'OUTER_RECEIPT_REVERTED'
    && exactKeys(outerOutcomeEvidence, [
      'outerTransactionHash', 'receiptBlockHash', 'receiptBlockNumber',
      'finalizedHeadBlockNumber', 'receiptStatus', 'receiptCanonical',
      'newTransactionEventCount', 'failureCode', 'evidenceSha256',
    ])
    && outerOutcomeEvidence.outerTransactionHash === value.outerTransactionHash
    && /^0x[0-9a-f]{64}$/.test(outerOutcomeEvidence.receiptBlockHash)
    && canonicalUnsigned(outerOutcomeEvidence.receiptBlockNumber)
    && canonicalUnsigned(outerOutcomeEvidence.finalizedHeadBlockNumber)
    && BigInt(outerOutcomeEvidence.receiptBlockNumber)
      <= BigInt(outerOutcomeEvidence.finalizedHeadBlockNumber)
    && outerOutcomeEvidence.receiptStatus === '0'
    && outerOutcomeEvidence.receiptCanonical === true
    && outerOutcomeEvidence.newTransactionEventCount === '0'
    && outerOutcomeEvidence.failureCode === 'OUTER_RECEIPT_REVERTED'
    && outerOutcomeEvidence.evidenceSha256 === value.signedEvidenceSha256;
  const validOuterAmbiguityEvidence = outerOutcomeEvidence !== null
    && value.state === 'QUARANTINED'
    && value.stateReasonCode === 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
    && value.quarantineReason === 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
    && exactKeys(outerOutcomeEvidence, [
      'outerTransactionHash', 'receiptBlockHash', 'receiptBlockNumber',
      'finalizedHeadBlockNumber', 'receiptStatus', 'receiptCanonical',
      'newTransactionEventCount', 'receiptIdentityVerified', 'ambiguityCode',
      'evidenceSha256',
    ])
    && outerOutcomeEvidence.outerTransactionHash === value.outerTransactionHash
    && /^0x[0-9a-f]{64}$/.test(outerOutcomeEvidence.receiptBlockHash)
    && canonicalUnsigned(outerOutcomeEvidence.receiptBlockNumber)
    && canonicalUnsigned(outerOutcomeEvidence.finalizedHeadBlockNumber)
    && BigInt(outerOutcomeEvidence.receiptBlockNumber)
      <= BigInt(outerOutcomeEvidence.finalizedHeadBlockNumber)
    && outerOutcomeEvidence.receiptStatus === '1'
    && outerOutcomeEvidence.receiptCanonical === true
    && canonicalUnsigned(outerOutcomeEvidence.newTransactionEventCount)
    && outerOutcomeEvidence.receiptIdentityVerified === false
    && outerOutcomeEvidence.ambiguityCode === 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
    && outerOutcomeEvidence.evidenceSha256 === value.signedEvidenceSha256;
  const validOuterOutcomeEvidence = outerOutcomeEvidence === null
    || validOuterFailureEvidence || validOuterAmbiguityEvidence;
  const prehashKeys = prehashAbandonmentEvidence && typeof prehashAbandonmentEvidence === 'object'
    && !Array.isArray(prehashAbandonmentEvidence)
    ? Object.keys(prehashAbandonmentEvidence).sort()
    : [];
  const exactPrehashKeys = (expected) => prehashKeys.length === expected.length
    && [...expected].sort().every((key, index) => key === prehashKeys[index]);
  const automaticPrehashEvidence = value.stateReasonCode === 'DEFINITE_LOCAL_PRESPAWN_FAILURE'
    && exactPrehashKeys([
      'evidenceVersion', 'broadcastAttempted', 'transactionHashObserved',
      'failureCode', 'failureMessage', 'lowerLevelErrorRetained',
      'operationId', 'logicalOperationId', 'contractAddress', 'method', 'arguments',
      'subjectType', 'subjectId', 'preparedAt',
    ])
    && prehashAbandonmentEvidence.evidenceVersion === 'LOCAL_PRESPAWN_FAILURE_V1'
    && prehashAbandonmentEvidence.broadcastAttempted === false
    && prehashAbandonmentEvidence.transactionHashObserved === false
    && prehashAbandonmentEvidence.lowerLevelErrorRetained === true
    && prehashAbandonmentEvidence.operationId === value.operationId
    && prehashAbandonmentEvidence.logicalOperationId === value.logicalOperationId
    && prehashAbandonmentEvidence.contractAddress === value.contractAddress
    && prehashAbandonmentEvidence.method === value.method
    && JSON.stringify(prehashAbandonmentEvidence.arguments) === JSON.stringify(value.args)
    && prehashAbandonmentEvidence.subjectType === value.subjectType
    && prehashAbandonmentEvidence.subjectId === value.subjectId
    && prehashAbandonmentEvidence.preparedAt === value.preparedAt
    && canonicalTimestamp(prehashAbandonmentEvidence.preparedAt)
    && /^[A-Z][A-Z0-9_]{0,79}$/.test(prehashAbandonmentEvidence.failureCode)
    && typeof prehashAbandonmentEvidence.failureMessage === 'string'
    && prehashAbandonmentEvidence.failureMessage.length >= 1
    && prehashAbandonmentEvidence.failureMessage.length <= 256;
  const auditedPrehashEvidence = value.stateReasonCode === 'AUDITED_NO_BROADCAST'
    && exactPrehashKeys([
      'evidenceVersion', 'runId', 'failedAt', 'failureCode', 'failureMessage',
      'lowerLevelErrorRetained', 'transactionHashObserved', 'network', 'chainId',
      'signerAddress', 'scanStartBlock', 'scanEndBlock', 'scanStartTimestamp',
      'operationId', 'logicalOperationId', 'contractAddress', 'method', 'arguments',
      'subjectType', 'subjectId', 'preparedAt',
      'scanEndTimestamp', 'matchingOuterTransactions', 'nonceAtStart', 'nonceAtEnd',
      'latestNonce', 'pendingNonce', 'referenceEventTransactionId',
      'referenceOuterTransactionHash', 'referenceOuterNonce', 'referenceOuterBlock',
      'referenceOuterSender', 'referenceConsensusRecipient', 'referenceCallSender',
      'referenceCallRecipient', 'queryResultSha256', 'postStateStatus',
      'postStateVerified', 'auditedAt',
    ])
    && prehashAbandonmentEvidence.evidenceVersion === 'BRADBURY_KEEPER_EVM_SCAN_V1'
    && prehashAbandonmentEvidence.network === 'bradbury'
    && prehashAbandonmentEvidence.chainId === '4221'
    && ['create_epoch', 'resolve_epoch'].includes(prehashAbandonmentEvidence.method)
    && prehashAbandonmentEvidence.subjectType === 'epoch'
    && prehashAbandonmentEvidence.signerAddress === value.signerAddress
    && prehashAbandonmentEvidence.operationId === value.operationId
    && prehashAbandonmentEvidence.logicalOperationId === value.logicalOperationId
    && prehashAbandonmentEvidence.contractAddress === value.contractAddress
    && prehashAbandonmentEvidence.method === value.method
    && JSON.stringify(prehashAbandonmentEvidence.arguments) === JSON.stringify(value.args)
    && prehashAbandonmentEvidence.subjectType === value.subjectType
    && prehashAbandonmentEvidence.subjectId === value.subjectId
    && prehashAbandonmentEvidence.preparedAt === value.preparedAt
    && prehashAbandonmentEvidence.referenceOuterSender === value.signerAddress
    && prehashAbandonmentEvidence.referenceCallSender === value.signerAddress
    && prehashAbandonmentEvidence.referenceCallRecipient === value.contractAddress
    && prehashAbandonmentEvidence.referenceConsensusRecipient
      === '0x0112bf6e83497965a5fdd6dad1e447a6e004271d'
    && prehashAbandonmentEvidence.matchingOuterTransactions === '0'
    && prehashAbandonmentEvidence.nonceAtStart === prehashAbandonmentEvidence.nonceAtEnd
    && prehashAbandonmentEvidence.nonceAtStart === prehashAbandonmentEvidence.latestNonce
    && prehashAbandonmentEvidence.nonceAtStart === prehashAbandonmentEvidence.pendingNonce
    && typeof prehashAbandonmentEvidence.runId === 'string'
    && /^[1-9]\d*$/.test(prehashAbandonmentEvidence.runId)
    && canonicalUnsigned(prehashAbandonmentEvidence.scanStartBlock)
    && canonicalUnsigned(prehashAbandonmentEvidence.scanEndBlock)
    && BigInt(prehashAbandonmentEvidence.scanStartBlock)
      <= BigInt(prehashAbandonmentEvidence.scanEndBlock)
    && canonicalUnsigned(prehashAbandonmentEvidence.referenceOuterBlock)
    && canonicalUnsigned(prehashAbandonmentEvidence.referenceOuterNonce)
    && canonicalUnsigned(prehashAbandonmentEvidence.nonceAtStart)
    && canonicalUnsigned(prehashAbandonmentEvidence.nonceAtEnd)
    && canonicalUnsigned(prehashAbandonmentEvidence.latestNonce)
    && canonicalUnsigned(prehashAbandonmentEvidence.pendingNonce)
    && BigInt(prehashAbandonmentEvidence.referenceOuterNonce) + 1n
      === BigInt(prehashAbandonmentEvidence.nonceAtStart)
    && canonicalTimestamp(prehashAbandonmentEvidence.preparedAt)
    && canonicalTimestamp(prehashAbandonmentEvidence.failedAt)
    && canonicalTimestamp(prehashAbandonmentEvidence.scanStartTimestamp)
    && canonicalTimestamp(prehashAbandonmentEvidence.scanEndTimestamp)
    && canonicalTimestamp(prehashAbandonmentEvidence.auditedAt)
    && prehashAbandonmentEvidence.scanStartTimestamp <= prehashAbandonmentEvidence.failedAt
    && prehashAbandonmentEvidence.scanStartTimestamp <= prehashAbandonmentEvidence.preparedAt
    && prehashAbandonmentEvidence.preparedAt <= prehashAbandonmentEvidence.failedAt
    && prehashAbandonmentEvidence.failedAt <= prehashAbandonmentEvidence.scanEndTimestamp
    && prehashAbandonmentEvidence.scanEndTimestamp <= prehashAbandonmentEvidence.auditedAt
    && prehashAbandonmentEvidence.postStateStatus === (
      prehashAbandonmentEvidence.method === 'create_epoch'
        ? 'EPOCH_UNKNOWN' : 'TARGET_STATE_UNCHANGED'
    )
    && prehashAbandonmentEvidence.postStateVerified === true
    && prehashAbandonmentEvidence.transactionHashObserved === false
    && prehashAbandonmentEvidence.lowerLevelErrorRetained === false
    && /^0x[0-9a-f]{64}$/.test(prehashAbandonmentEvidence.referenceEventTransactionId)
    && /^0x[0-9a-f]{64}$/.test(prehashAbandonmentEvidence.referenceOuterTransactionHash)
    && /^[0-9a-f]{64}$/.test(prehashAbandonmentEvidence.queryResultSha256)
    && /^[A-Z][A-Z0-9_]{0,79}$/.test(prehashAbandonmentEvidence.failureCode)
    && typeof prehashAbandonmentEvidence.failureMessage === 'string'
    && prehashAbandonmentEvidence.failureMessage.length >= 1
    && prehashAbandonmentEvidence.failureMessage.length <= 256
    && keeperPrehashEvidenceDigest(prehashAbandonmentEvidence)
      === prehashAbandonmentEvidence.queryResultSha256;
  const validPrehashEvidence = prehashAbandonmentEvidence === null
    || automaticPrehashEvidence || auditedPrehashEvidence;
  const validAcceptanceEvidence = acceptanceEvidence === null || (
    acceptanceEvidence && typeof acceptanceEvidence === 'object'
    && !Array.isArray(acceptanceEvidence)
    && Object.keys(acceptanceEvidence).length === 10
    && acceptanceEvidence.transactionHash === value.transactionHash
    && acceptanceEvidence.contractAddress === value.contractAddress
    && acceptanceEvidence.recipient === value.contractAddress
    && acceptanceEvidence.method === value.method
    && Array.isArray(acceptanceEvidence.arguments)
    && acceptanceEvidence.arguments.length === value.args.length
    && acceptanceEvidence.arguments.every((entry, index) => entry === value.args[index])
    && acceptanceEvidence.lifecycleStatus === 'ACCEPTED'
    && acceptanceEvidence.txExecutionResultName === 'FINISHED_WITH_RETURN'
    && acceptanceEvidence.receiptIdentityVerified === true
    && acceptanceEvidence.executionVerified === true
    && acceptanceEvidence.executionSucceeded === true
  );
  if (!/^[0-9a-f]{64}$/.test(value.operationId)
      || !/^[0-9a-f]{64}$/.test(value.logicalOperationId)
      || !/^[1-9]\d{0,18}$/.test(value.attemptNumber)
      || (value.retryOfOperationId !== null && !/^[0-9a-f]{64}$/.test(value.retryOfOperationId))
      || value.deploymentAlias !== 'v8'
      || value.network !== 'bradbury'
      || value.chainId !== '4221'
      || !/^0x[0-9a-f]{40}$/.test(value.signerAddress)
      || !/^0x[0-9a-f]{40}$/.test(value.contractAddress)
      || !['epoch', 'payout'].includes(value.subjectType)
      || typeof value.subjectId !== 'string'
      || ![
        'create_epoch', 'resolve_epoch', 'activate_timeout_refund',
        'retry_prepare_payout', 'dispatch_payout', 'retry_payout',
        'confirm_payout', 'refresh_payout_withdrawal',
      ].includes(value.method)
      || !Array.isArray(value.args) || value.args.length !== 1 || typeof value.args[0] !== 'string'
      || value.args[0] !== value.subjectId
      || value.valueAtto !== '0'
      || !states.has(value.state)
      || ![null, 'BRADBURY_DURABLE_RAW_V1'].includes(value.submissionProtocol)
      || (value.outerTransactionHash !== null
        && !/^0x[0-9a-f]{64}$/.test(value.outerTransactionHash))
      || (value.outerSenderNonce !== null && !canonicalUnsigned(value.outerSenderNonce))
      || (value.signedEvidenceSha256 !== null
        && !/^[0-9a-f]{64}$/.test(value.signedEvidenceSha256))
      || !nullableTimestamp(value.signedAt)
      || !nullableTimestamp(value.outerReceiptObservedAt)
      || !validSignedEvidence
      || !validSubmissionEvidence
      || !validOuterOutcomeEvidence
      || ([value.outerTransactionHash, value.outerSenderNonce,
        value.signedEvidenceSha256, value.signedAt, signedTransactionEvidence]
        .some((entry) => entry !== null)
        && [value.outerTransactionHash, value.outerSenderNonce,
          value.signedEvidenceSha256, value.signedAt, signedTransactionEvidence]
          .some((entry) => entry === null))
      || ([
        value.outerReceiptObservedAt === null
          && submissionEvidence === null && outerOutcomeEvidence === null,
        value.outerReceiptObservedAt !== null
          && submissionEvidence !== null && outerOutcomeEvidence === null,
        value.outerReceiptObservedAt !== null
          && submissionEvidence === null && outerOutcomeEvidence !== null,
      ].filter(Boolean).length !== 1)
      || (signedTransactionEvidence !== null
        && value.submissionProtocol !== 'BRADBURY_DURABLE_RAW_V1')
      || ((submissionEvidence !== null || outerOutcomeEvidence !== null)
        && signedTransactionEvidence === null)
      || (value.state === 'SIGNED' && (
        signedTransactionEvidence === null
        || submissionEvidence !== null
        || outerOutcomeEvidence !== null
        || value.transactionHash !== null
      ))
      || (value.submissionProtocol === 'BRADBURY_DURABLE_RAW_V1'
        && value.transactionHash !== null && submissionEvidence === null)
      || (value.transactionHash !== null && !/^0x[0-9a-f]{64}$/.test(value.transactionHash))
      || (value.lifecycleStatus !== null && !lifecycleStatuses.has(value.lifecycleStatus))
      || (value.pipelineSlot !== null && ![0, 1].includes(value.pipelineSlot))
      || (['PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED',
        'STATE_SATISFIED_UNPROVEN'].includes(value.state) && value.pipelineSlot === null)
      || (value.handoffPredecessorOperationId !== null
        && !/^[0-9a-f]{64}$/.test(value.handoffPredecessorOperationId))
      || !nullableTimestamp(value.acceptedAt)
      || !nullableTimestamp(value.acceptanceRevalidatedAt)
      || ((value.acceptedAt === null) !== (acceptanceEvidence === null))
      || ((value.acceptanceRevalidatedAt === null) !== (acceptanceEvidence === null))
      || (value.acceptedAt !== null
        && Date.parse(value.acceptanceRevalidatedAt) < Date.parse(value.acceptedAt))
      || !validAcceptanceEvidence
      || !nullableTimestamp(value.prehashAbandonedAt)
      || ((value.prehashAbandonedAt === null) !== (prehashAbandonmentEvidence === null))
      || !validPrehashEvidence
      || (value.state === 'ABANDONED_PREHASH' && (
        value.transactionHash !== null
        || signedTransactionEvidence !== null
        || value.prehashAbandonedAt === null
        || !['DEFINITE_LOCAL_PRESPAWN_FAILURE', 'AUDITED_NO_BROADCAST']
          .includes(value.stateReasonCode)
      ))
      || (value.state !== 'ABANDONED_PREHASH' && value.prehashAbandonedAt !== null)
      || !reasonCode(value.stateReasonCode)
      || !reasonCode(value.quarantineReason)
      || !/^[1-9]\d*$/.test(value.revision)
      || !timestamp(value.preparedAt)
      || !nullableTimestamp(value.submittedAt)
      || !nullableTimestamp(value.lifecycleObservedAt)
      || !nullableTimestamp(value.finalizedAt)
      || !nullableTimestamp(value.verifiedAt)
      || !timestamp(value.updatedAt)
      || ((value.transactionHash === null) !== (value.submittedAt === null))
      || (value.state === 'PREPARED' && value.transactionHash !== null)
      || (['SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED'].includes(value.state)
          && value.transactionHash === null)
      || (value.state === 'FINALIZED_FAILURE' && value.transactionHash === null
        && !validOuterFailureEvidence)
      || (['FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE'].includes(value.state)
          && (value.lifecycleStatus !== 'FINALIZED' || value.finalizedAt === null))
      || (value.state === 'VERIFIED' && value.verifiedAt === null)
      || (value.state === 'QUARANTINED' && value.quarantineReason === null)
      || (value.state !== 'QUARANTINED' && value.quarantineReason !== null)
      || (['FINALIZED_SUCCESS', 'VERIFIED'].includes(value.state)
          && value.stateReasonCode !== null)) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SHAPE',
      'Keeper journal returned an invalid operation.',
    );
  }
  let canonical;
  let expectedOperationId;
  let expectedRetryOperationId = null;
  try {
    canonical = canonicalKeeperOperation({
      deploymentAlias: value.deploymentAlias,
      chainId: value.chainId,
      contractAddress: value.contractAddress,
      subjectType: value.subjectType,
      subjectId: value.subjectId,
      method: value.method,
      args: value.args,
      valueAtto: value.valueAtto,
    });
    expectedOperationId = keeperAttemptOperationId(value.logicalOperationId, value.attemptNumber);
    if (value.attemptNumber !== '1') {
      expectedRetryOperationId = keeperAttemptOperationId(
        value.logicalOperationId,
        (BigInt(value.attemptNumber) - 1n).toString(),
      );
    }
  } catch (error) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SHAPE',
      'Keeper journal returned an invalid operation.',
      { cause: error },
    );
  }
  if (canonical.operationId !== value.logicalOperationId
      || value.operationId !== expectedOperationId
      || value.retryOfOperationId !== expectedRetryOperationId) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_IDENTITY',
      'Keeper journal operation attempt identity does not match its canonical call.',
    );
  }
  const canonicalTime = (entry) => entry === null ? null : new Date(entry).toISOString();
  return Object.freeze({
    ...value,
    args: Object.freeze([...value.args]),
    signedTransactionEvidence: signedTransactionEvidence === null
      ? null
      : Object.freeze({
        ...signedTransactionEvidence,
        arguments: Object.freeze([...signedTransactionEvidence.arguments]),
      }),
    submissionEvidence: submissionEvidence === null
      ? null
      : Object.freeze({ ...submissionEvidence }),
    outerOutcomeEvidence: outerOutcomeEvidence === null
      ? null
      : Object.freeze({ ...outerOutcomeEvidence }),
    signedAt: canonicalTime(value.signedAt),
    outerReceiptObservedAt: canonicalTime(value.outerReceiptObservedAt),
    lifecycleObservedAt: canonicalTime(value.lifecycleObservedAt),
    acceptedAt: canonicalTime(value.acceptedAt),
    acceptanceRevalidatedAt: canonicalTime(value.acceptanceRevalidatedAt),
    prehashAbandonedAt: canonicalTime(value.prehashAbandonedAt),
    preparedAt: canonicalTime(value.preparedAt),
    submittedAt: canonicalTime(value.submittedAt),
    finalizedAt: canonicalTime(value.finalizedAt),
    verifiedAt: canonicalTime(value.verifiedAt),
    updatedAt: canonicalTime(value.updatedAt),
  });
}

function assertPreparedResponseIdentity(result, requested, lease) {
  const operation = result.operation;
  if (operation.logicalOperationId !== requested.operationId
      || operation.deploymentAlias !== requested.deploymentAlias
      || operation.chainId !== requested.chainId
      || operation.contractAddress !== requested.contractAddress
      || operation.subjectType !== requested.subjectType
      || operation.subjectId !== requested.subjectId
      || operation.method !== requested.method
      || operation.valueAtto !== requested.valueAtto
      || operation.args.length !== requested.args.length
      || operation.args.some((argument, index) => argument !== requested.args[index])
      || operation.signerAddress !== lease.signerAddress.toLowerCase()) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_IDENTITY',
      'Keeper journal prepare response identity does not match the request.',
    );
  }
  if (result.canSign === true
      && (result.inserted !== true
          || operation.state !== 'PREPARED'
          || operation.transactionHash !== null
          || operation.signedTransactionEvidence !== null)) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_AUTHORIZATION',
      'Keeper journal returned an invalid broadcast authorization.',
    );
  }
}

function validatedSuccess(action, payload) {
  if (action === 'HEALTH') {
    exactResponseKeys(payload, [
      'status', 'service', 'ready', 'network', 'chainId', 'configuration', 'database',
    ], 'health response');
    exactResponseKeys(payload.configuration, [
      'databaseConfigured', 'authenticationConfigured', 'signerConfigured',
    ], 'health configuration');
    exactResponseKeys(payload.database, [
      'configured', 'ready', 'schemaVersion',
    ], 'health database');
    const configurationReady = payload.configuration.databaseConfigured === true
      && payload.configuration.authenticationConfigured === true
      && payload.configuration.signerConfigured === true;
    const databaseReady = payload.database.configured === true
      && payload.database.ready === true
      && payload.database.schemaVersion === 10;
    if (!['ready', 'degraded'].includes(payload.status)
        || payload.service !== 'liquidity-arena-keeper-journal'
        || typeof payload.ready !== 'boolean'
        || payload.network !== 'bradbury'
        || payload.chainId !== '4221'
        || typeof payload.configuration.databaseConfigured !== 'boolean'
        || typeof payload.configuration.authenticationConfigured !== 'boolean'
        || typeof payload.configuration.signerConfigured !== 'boolean'
        || typeof payload.database.configured !== 'boolean'
        || typeof payload.database.ready !== 'boolean'
      || ![null, 10].includes(payload.database.schemaVersion)
        || (payload.ready === true
          ? payload.status !== 'ready' || !configurationReady || !databaseReady
          : payload.status !== 'degraded')) {
      throw new KeeperJournalClientError(
        'KEEPER_JOURNAL_RESPONSE_SHAPE',
        'Keeper journal returned an invalid health response.',
      );
    }
    return Object.freeze(payload);
  }
  if (action === 'LEASE_ACQUIRE' || action === 'LEASE_RENEW') {
    exactResponseKeys(payload, ['status', 'action', 'lease'], 'lease response');
    if (payload.status !== 'ok' || payload.action !== action) {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid lease response.');
    }
    return Object.freeze({ ...payload, lease: validatedLease(payload.lease, action === 'LEASE_ACQUIRE') });
  }
  if (action === 'LEASE_RELEASE') {
    exactResponseKeys(payload, ['status', 'action', 'released', 'fencingToken'], 'release response');
    if (payload.status !== 'ok' || payload.action !== action || payload.released !== true
        || !/^[1-9]\d{0,18}$/.test(payload.fencingToken)) {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid release response.');
    }
    return Object.freeze(payload);
  }
  if (action === 'PREPARE') {
    exactResponseKeys(payload, [
      'status', 'action', 'operation', 'canSign', 'inserted', 'auditedRetryNonce',
    ], 'prepare response');
    if (payload.status !== 'ok' || payload.action !== action
        || typeof payload.canSign !== 'boolean' || typeof payload.inserted !== 'boolean'
        || (payload.auditedRetryNonce !== null
          && (typeof payload.auditedRetryNonce !== 'string'
            || !/^(?:0|[1-9]\d*)$/.test(payload.auditedRetryNonce)
            || payload.canSign !== true || payload.inserted !== true))) {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid prepare response.');
    }
    const operation = validatedOperation(payload.operation);
    if (payload.auditedRetryNonce !== null && operation.attemptNumber !== '2') {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid audited retry nonce.');
    }
    return Object.freeze({ ...payload, operation });
  }
  if (['BIND_SIGNED', 'BIND_SUBMISSION', 'BIND_OUTER_OUTCOME', 'LOAD_OPERATION', 'TRANSITION',
    'OBSERVE_LIFECYCLE', 'ACCEPT_HANDOFF',
    'ABANDON_PREHASH'].includes(action)) {
    const keys = action === 'OBSERVE_LIFECYCLE'
      ? ['status', 'action', 'operation', 'receiptIdentityVerified']
      : ['status', 'action', 'operation'];
    exactResponseKeys(payload, keys, 'operation response');
    if (payload.status !== 'ok' || payload.action !== action
        || (action === 'OBSERVE_LIFECYCLE' && payload.receiptIdentityVerified !== false)) {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid operation response.');
    }
    return Object.freeze({ ...payload, operation: validatedOperation(payload.operation) });
  }
  if (action === 'LOAD_SIGNED') {
    exactResponseKeys(payload, [
      'status', 'action', 'operationId', 'fencingToken', 'evidence',
    ], 'private signed transaction response');
    let evidence;
    try {
      evidence = normalizeDurableSignedEvidence(payload.evidence);
    } catch (error) {
      throw new KeeperJournalClientError(
        'KEEPER_JOURNAL_RESPONSE_SHAPE',
        'Keeper journal returned invalid private signed transaction evidence.',
        { cause: error },
      );
    }
    if (payload.status !== 'ok' || payload.action !== action
        || !/^[0-9a-f]{64}$/.test(payload.operationId)
        || !/^[1-9]\d{0,18}$/.test(payload.fencingToken)) {
      throw new KeeperJournalClientError(
        'KEEPER_JOURNAL_RESPONSE_SHAPE',
        'Keeper journal returned an invalid private signed transaction response.',
      );
    }
    return Object.freeze({ ...payload, evidence });
  }
  if (action === 'RECOVER') {
    exactResponseKeys(payload, ['status', 'action', 'operations', 'page'], 'recovery response');
    exactResponseKeys(payload.page, ['limit', 'nextCursor'], 'recovery page');
    if (payload.status !== 'ok' || payload.action !== action || !Array.isArray(payload.operations)
        || !Number.isSafeInteger(payload.page.limit)
        || (payload.page.nextCursor !== null && typeof payload.page.nextCursor !== 'string')) {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid recovery response.');
    }
    return Object.freeze({
      ...payload,
      operations: Object.freeze(payload.operations.map(validatedOperation)),
      page: Object.freeze({ ...payload.page }),
    });
  }
  throw new KeeperJournalClientError(
    'KEEPER_JOURNAL_RESPONSE_SHAPE',
    'Keeper journal returned an unexpected response.',
  );
}

function operationBody(value) {
  const operation = canonicalKeeperOperation(value);
  return Object.freeze({
    deploymentAlias: operation.deploymentAlias,
    chainId: operation.chainId,
    contractAddress: operation.contractAddress,
    subjectType: operation.subjectType,
    subjectId: operation.subjectId,
    method: operation.method,
    args: operation.args,
    valueAtto: operation.valueAtto,
  });
}

export function newKeeperJournalHolderId() {
  return randomUUID();
}

export function createKeeperJournalClient({
  endpoint,
  secret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
} = {}) {
  const target = validatedEndpoint(endpoint);
  const bearerSecret = validatedSecret(secret);
  if (typeof fetchImpl !== 'function') {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_CLIENT_CONFIG',
      'Keeper journal fetch implementation is unavailable.',
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_CLIENT_CONFIG',
      'Keeper journal timeout must be between 1000 and 30000 milliseconds.',
    );
  }

  async function post(body, idempotencyKey = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      authorization: `Bearer ${bearerSecret}`,
      'content-type': 'application/json; charset=utf-8',
    };
    if (idempotencyKey !== null) headers['idempotency-key'] = normalizedIdempotencyKey(idempotencyKey);
    let response;
    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const payload = await readBoundedResponse(response);
      if (!response.ok && !(body.action === 'HEALTH' && response.status === 503)) {
        throw new KeeperJournalClientError(
          typeof payload?.code === 'string' ? payload.code : 'KEEPER_JOURNAL_CLIENT_HTTP',
          typeof payload?.error === 'string' ? payload.error : 'Keeper journal request was rejected.',
          { statusCode: response.status },
        );
      }
      return validatedSuccess(body.action, payload);
    } catch (error) {
      if (error instanceof KeeperJournalClientError) throw error;
      throw new KeeperJournalClientError(
        controller.signal.aborted ? 'KEEPER_JOURNAL_CLIENT_TIMEOUT' : 'KEEPER_JOURNAL_CLIENT_NETWORK',
        controller.signal.aborted
          ? 'Keeper journal request timed out.'
          : 'Keeper journal request failed.',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    health() {
      return post({ action: 'HEALTH' });
    },

    async acquireLease({ holderId, signerAddress, leaseSeconds = 900, idempotencyKey }) {
      const result = await post({
        action: 'LEASE_ACQUIRE', holderId, signerAddress, leaseSeconds,
      }, idempotencyKey);
      if (result.lease.holderId !== String(holderId).toLowerCase()
          || result.lease.signerAddress !== String(signerAddress).toLowerCase()) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal lease response identity does not match the request.');
      }
      return result;
    },

    async renewLease({ lease, leaseSeconds = 900, idempotencyKey }) {
      const identity = leaseFields(lease);
      const result = await post({
        action: 'LEASE_RENEW', ...identity, leaseSeconds,
      }, idempotencyKey);
      if (result.lease.holderId !== identity.holderId.toLowerCase()
          || result.lease.signerAddress !== identity.signerAddress.toLowerCase()
          || result.lease.fencingToken !== identity.fencingToken) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal renewal response identity does not match the lease.');
      }
      return result;
    },

    async releaseLease({ lease, idempotencyKey }) {
      const identity = leaseFields(lease);
      const result = await post({ action: 'LEASE_RELEASE', ...identity }, idempotencyKey);
      if (result.fencingToken !== identity.fencingToken) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal release response identity does not match the lease.');
      }
      return result;
    },

    async prepareOperation({ lease, operation, idempotencyKey }) {
      const identity = leaseFields(lease);
      const normalized = canonicalKeeperOperation(operation);
      const result = await post({
        action: 'PREPARE', ...identity, operation: operationBody(operation),
      }, idempotencyKey);
      assertPreparedResponseIdentity(result, normalized, identity);
      return result;
    },

    async bindSigned({ lease, operationId, evidence: evidenceValue, idempotencyKey }) {
      let evidence;
      try {
        evidence = normalizeDurableSignedEvidence(evidenceValue);
      } catch (error) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_CLIENT_SCHEMA',
          'Signed transaction evidence is invalid.',
          { cause: error },
        );
      }
      const result = await post({
        action: 'BIND_SIGNED',
        ...leaseFields(lease),
        operationId,
        evidence,
      }, idempotencyKey);
      const digest = createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.state !== 'SIGNED'
          || result.operation.outerTransactionHash !== evidence.outerTransactionHash
          || result.operation.outerSenderNonce !== evidence.outerNonce
          || result.operation.signedEvidenceSha256 !== digest
          || result.operation.signedTransactionEvidence?.rawTransaction !== undefined) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_RESPONSE_IDENTITY',
          'Keeper journal signed persistence acknowledgement does not match the request.',
        );
      }
      return result;
    },

    async loadSigned({ lease, operationId, idempotencyKey }) {
      const identity = leaseFields(lease);
      const result = await post({
        action: 'LOAD_SIGNED',
        ...identity,
        operationId,
      }, idempotencyKey);
      if (result.operationId !== String(operationId).toLowerCase()
          || result.fencingToken !== identity.fencingToken
          || result.evidence.signerAddress !== identity.signerAddress.toLowerCase()) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_RESPONSE_IDENTITY',
          'Keeper journal private signed transaction response does not match the active fence.',
        );
      }
      return result;
    },

    async loadOperation({ lease, operationId, idempotencyKey }) {
      const result = await post({
        action: 'LOAD_OPERATION',
        ...leaseFields(lease),
        operationId,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_RESPONSE_IDENTITY',
          'Keeper journal operation response does not match the request.',
        );
      }
      return result;
    },

    async bindSubmission({
      lease, operationId, transactionHash, submissionEvidence, idempotencyKey,
    }) {
      const result = await post({
        action: 'BIND_SUBMISSION',
        ...leaseFields(lease),
        operationId,
        transactionHash,
        submissionEvidence,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.transactionHash !== String(transactionHash).toLowerCase()
          || !sameExactScalarRecord(
            result.operation.submissionEvidence,
            submissionEvidence,
            SUBMISSION_EVIDENCE_KEYS,
          )) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal submission response identity does not match the request.');
      }
      return result;
    },

    async bindOuterOutcome({
      lease, operationId, outerOutcomeEvidence, idempotencyKey,
    }) {
      const result = await post({
        action: 'BIND_OUTER_OUTCOME',
        ...leaseFields(lease),
        operationId,
        outerOutcomeEvidence,
      }, idempotencyKey);
      const expectedState = outerOutcomeEvidence?.receiptStatus === '0'
        ? 'FINALIZED_FAILURE' : 'QUARANTINED';
      const expectedReason = outerOutcomeEvidence?.receiptStatus === '0'
        ? 'OUTER_RECEIPT_REVERTED' : 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS';
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.state !== expectedState
          || result.operation.transactionHash !== null
          || result.operation.stateReasonCode !== expectedReason
          || (expectedState === 'QUARANTINED'
            && result.operation.quarantineReason !== expectedReason)
          || JSON.stringify(result.operation.outerOutcomeEvidence)
            !== JSON.stringify(outerOutcomeEvidence)) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_RESPONSE_IDENTITY',
          'Keeper journal outer outcome response identity does not match the request.',
        );
      }
      return result;
    },

    async observeLifecycle({ lease, operationId, lifecycleStatus, idempotencyKey }) {
      const result = await post({
        action: 'OBSERVE_LIFECYCLE',
        ...leaseFields(lease),
        operationId,
        lifecycleStatus,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.lifecycleStatus !== String(lifecycleStatus).toUpperCase()) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal lifecycle response identity does not match the request.');
      }
      return result;
    },

    async acceptHandoff({ lease, operationId, acceptanceEvidence, idempotencyKey }) {
      const result = await post({
        action: 'ACCEPT_HANDOFF',
        ...leaseFields(lease),
        operationId,
        acceptanceEvidence,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.lifecycleStatus !== 'ACCEPTED'
          || result.operation.acceptedAt === null
          || result.operation.acceptanceEvidence?.transactionHash
            !== String(acceptanceEvidence?.transactionHash || '').toLowerCase()) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_RESPONSE_IDENTITY',
          'Keeper journal ACCEPTED handoff response identity does not match the request.',
        );
      }
      return result;
    },

    async abandonPrehash({ lease, operationId, reasonCode, evidence, idempotencyKey }) {
      const result = await post({
        action: 'ABANDON_PREHASH',
        ...leaseFields(lease),
        operationId,
        reasonCode,
        evidence,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.state !== 'ABANDONED_PREHASH'
          || result.operation.stateReasonCode !== String(reasonCode || '')) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_RESPONSE_IDENTITY',
          'Keeper journal pre-hash abandonment response identity does not match the request.',
        );
      }
      return result;
    },

    async transition({ lease, operationId, targetState, reasonCode = null, metadata = {}, idempotencyKey }) {
      if (['OUTER_RECEIPT_REVERTED', 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS']
        .includes(reasonCode)) {
        throw new KeeperJournalClientError(
          'KEEPER_JOURNAL_CLIENT_SCHEMA',
          'Outer receipt outcome reasons require BIND_OUTER_OUTCOME.',
        );
      }
      const result = await post({
        action: 'TRANSITION',
        ...leaseFields(lease),
        operationId,
        targetState,
        reasonCode,
        metadata,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.state !== String(targetState).toUpperCase()) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal transition response identity does not match the request.');
      }
      return result;
    },

    async recover({ lease, cursor = null, limit = 50, idempotencyKey }) {
      const identity = leaseFields(lease);
      const result = await post({
        action: 'RECOVER', ...identity, cursor, limit,
      }, idempotencyKey);
      if (result.page.limit !== limit
          || result.operations.some((operation) => operation.signerAddress !== identity.signerAddress.toLowerCase())) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal recovery response contains another signer.');
      }
      return result;
    },
  });
}

export function createKeeperJournalClientFromEnvironment(environment = process.env, options = {}) {
  return createKeeperJournalClient({
    endpoint: environment.KEEPER_JOURNAL_URL,
    secret: environment.KEEPER_JOURNAL_SECRET,
    ...options,
  });
}

export async function runPreparedKeeperBroadcast({
  client: _client,
  lease: _lease,
  operation: _operation,
  idempotencyKey: _idempotencyKey,
  broadcast: _broadcast,
}) {
  throw new KeeperJournalClientError(
    'KEEPER_JOURNAL_DURABLE_SIGNING_REQUIRED',
    'Direct PREPARED broadcast is disabled; sign, BIND_SIGNED, then replay the exact durable bytes.',
    { statusCode: 409 },
  );
}
