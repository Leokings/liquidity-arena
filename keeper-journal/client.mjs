import { randomUUID } from 'node:crypto';

import { StrictKeeperJsonParser } from './http.mjs';
import {
  canonicalKeeperOperation,
  keeperAttemptOperationId,
  normalizedIdempotencyKey,
} from './schema.mjs';

const MAX_RESPONSE_BYTES = 64 * 1024;

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
    'contractAddress', 'method', 'args', 'valueAtto', 'epochEndTimestamp',
    'state', 'transactionHash', 'lifecycleStatus', 'lifecycleObservedAt',
    'stateReasonCode', 'quarantineReason', 'preparedAt', 'submittedAt',
    'finalizedAt', 'verifiedAt', 'updatedAt', 'revision',
  ];
  exactResponseKeys(value, keys, 'operation');
  const states = new Set([
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED',
    'FINALIZED_FAILURE', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
  ]);
  const timestamp = (entry) => typeof entry === 'string' && !Number.isNaN(Date.parse(entry));
  const nullableTimestamp = (entry) => entry === null || timestamp(entry);
  const lifecycleStatuses = new Set([
    'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED', 'FINALIZED',
  ]);
  const reasonCode = (entry) => entry === null || /^[A-Z][A-Z0-9_]{0,79}$/.test(entry);
  if (!/^[0-9a-f]{64}$/.test(value.operationId)
      || !/^[0-9a-f]{64}$/.test(value.logicalOperationId)
      || !/^[1-9]\d{0,18}$/.test(value.attemptNumber)
      || (value.retryOfOperationId !== null && !/^[0-9a-f]{64}$/.test(value.retryOfOperationId))
      || !['v6', 'v7'].includes(value.deploymentAlias)
      || value.network !== 'studionet'
      || value.chainId !== '61999'
      || !/^0x[0-9a-f]{40}$/.test(value.signerAddress)
      || !/^0x[0-9a-f]{40}$/.test(value.contractAddress)
      || !['create_epoch', 'resolve_epoch', 'activate_timeout_refund'].includes(value.method)
      || !Array.isArray(value.args) || value.args.length !== 1 || typeof value.args[0] !== 'string'
      || value.args[0] !== value.epochEndTimestamp
      || value.valueAtto !== '0'
      || !states.has(value.state)
      || (value.transactionHash !== null && !/^0x[0-9a-f]{64}$/.test(value.transactionHash))
      || (value.lifecycleStatus !== null && !lifecycleStatuses.has(value.lifecycleStatus))
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
      || (['SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE'].includes(value.state)
          && value.transactionHash === null)
      || (['FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE'].includes(value.state)
          && (value.lifecycleStatus !== 'FINALIZED' || value.finalizedAt === null))
      || (value.state === 'VERIFIED' && value.verifiedAt === null)
      || (value.state === 'QUARANTINED' && value.quarantineReason === null)) {
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
      method: value.method,
      args: value.args,
      valueAtto: value.valueAtto,
      epochEndTimestamp: value.epochEndTimestamp,
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
  return Object.freeze({ ...value, args: Object.freeze([...value.args]) });
}

function assertPreparedResponseIdentity(result, requested, lease) {
  const operation = result.operation;
  if (operation.logicalOperationId !== requested.operationId
      || operation.deploymentAlias !== requested.deploymentAlias
      || operation.chainId !== requested.chainId
      || operation.contractAddress !== requested.contractAddress
      || operation.method !== requested.method
      || operation.valueAtto !== requested.valueAtto
      || operation.epochEndTimestamp !== requested.epochEndTimestamp
      || operation.args.length !== requested.args.length
      || operation.args.some((argument, index) => argument !== requested.args[index])
      || operation.signerAddress !== lease.signerAddress.toLowerCase()) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_IDENTITY',
      'Keeper journal prepare response identity does not match the request.',
    );
  }
  if (result.canBroadcast === true
      && (result.inserted !== true
          || operation.state !== 'PREPARED'
          || operation.transactionHash !== null)) {
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
      && payload.database.schemaVersion === 3;
    if (!['ready', 'degraded'].includes(payload.status)
        || payload.service !== 'liquidity-arena-keeper-journal'
        || typeof payload.ready !== 'boolean'
        || payload.network !== 'studionet'
        || payload.chainId !== '61999'
        || typeof payload.configuration.databaseConfigured !== 'boolean'
        || typeof payload.configuration.authenticationConfigured !== 'boolean'
        || typeof payload.configuration.signerConfigured !== 'boolean'
        || typeof payload.database.configured !== 'boolean'
        || typeof payload.database.ready !== 'boolean'
        || ![null, 3].includes(payload.database.schemaVersion)
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
    exactResponseKeys(payload, ['status', 'action', 'operation', 'canBroadcast', 'inserted'], 'prepare response');
    if (payload.status !== 'ok' || payload.action !== action
        || typeof payload.canBroadcast !== 'boolean' || typeof payload.inserted !== 'boolean') {
      throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_SHAPE', 'Keeper journal returned an invalid prepare response.');
    }
    return Object.freeze({ ...payload, operation: validatedOperation(payload.operation) });
  }
  if (['BIND_SUBMISSION', 'TRANSITION', 'OBSERVE_LIFECYCLE'].includes(action)) {
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
    method: operation.method,
    args: operation.args,
    valueAtto: operation.valueAtto,
    epochEndTimestamp: operation.epochEndTimestamp,
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
    timer.unref?.();
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

    async bindSubmission({ lease, operationId, transactionHash, idempotencyKey }) {
      const result = await post({
        action: 'BIND_SUBMISSION',
        ...leaseFields(lease),
        operationId,
        transactionHash,
      }, idempotencyKey);
      if (result.operation.operationId !== String(operationId).toLowerCase()
          || result.operation.transactionHash !== String(transactionHash).toLowerCase()) {
        throw new KeeperJournalClientError('KEEPER_JOURNAL_RESPONSE_IDENTITY', 'Keeper journal submission response identity does not match the request.');
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

    async transition({ lease, operationId, targetState, reasonCode = null, metadata = {}, idempotencyKey }) {
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
  client,
  lease,
  operation,
  idempotencyKey,
  broadcast,
}) {
  if (typeof broadcast !== 'function') {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_CLIENT_SCHEMA',
      'Keeper broadcast function is required.',
    );
  }
  const prepared = await client.prepareOperation({ lease, operation, idempotencyKey });
  const normalized = canonicalKeeperOperation(operation);
  const identity = leaseFields(lease);
  if (prepared === null || typeof prepared !== 'object'
      || typeof prepared.canBroadcast !== 'boolean'
      || typeof prepared.inserted !== 'boolean') {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_RESPONSE_SHAPE',
      'Keeper journal returned an invalid prepare response.',
    );
  }
  const validated = Object.freeze({
    ...prepared,
    operation: validatedOperation(prepared.operation),
  });
  assertPreparedResponseIdentity(validated, normalized, identity);
  if (validated.canBroadcast !== true) {
    throw new KeeperJournalClientError(
      'KEEPER_JOURNAL_BROADCAST_BLOCKED',
      'Keeper operation is not a newly authorized broadcast for this fencing token.',
      { statusCode: 409 },
    );
  }
  return broadcast(validated.operation);
}
