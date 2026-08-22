import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  KeeperJournalClientError,
  createKeeperJournalClient,
  runPreparedKeeperBroadcast,
} from '../keeper-journal/client.mjs';
import { createKeeperJournalHandler } from '../keeper-journal/http.mjs';
import { canonicalKeeperOperation, keeperAttemptOperationId } from '../keeper-journal/schema.mjs';

const SECRET = 'k'.repeat(32);
const SIGNER = '0x12ba664a1ec9ca78b070d103c6a69e20673f4b51';
const HOLDER = '123e4567-e89b-42d3-a456-426614174000';

function request({ method = 'POST', headers = {}, body = '' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = '/api/keeper-journal';
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; this.writableEnded = true; },
  };
}

function handler(service) {
  return createKeeperJournalHandler({
    service,
    environment: {
      KEEPER_JOURNAL_SECRET: SECRET,
      KEEPER_JOURNAL_SIGNER_ADDRESS: SIGNER,
      HISTORY_INGEST_SECRET: 'h'.repeat(32),
    },
    clientKey: () => 'test',
  });
}

function headers(overrides = {}) {
  return {
    authorization: `Bearer ${SECRET}`,
    'content-type': 'application/json; charset=utf-8',
    'idempotency-key': 'keeper:test:00000001',
    ...overrides,
  };
}

test('keeper journal uses a separate bearer secret and never accepts the history credential', async () => {
  let calls = 0;
  const endpoint = handler({ async execute() { calls += 1; return { status: 'ok' }; } });
  const res = response();
  await endpoint(request({
    headers: headers({ authorization: `Bearer ${'h'.repeat(32)}` }),
    body: JSON.stringify({ action: 'HEALTH' }),
  }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).code, 'KEEPER_JOURNAL_UNAUTHORIZED');
  assert.equal(calls, 0);
  assert.doesNotMatch(res.body, new RegExp(SECRET));

  const sharedCredentialEndpoint = createKeeperJournalHandler({
    service: { async execute() { calls += 1; } },
    environment: {
      KEEPER_JOURNAL_SECRET: SECRET,
      KEEPER_JOURNAL_SIGNER_ADDRESS: SIGNER,
      HISTORY_INGEST_SECRET: SECRET,
    },
    clientKey: () => 'test',
  });
  const sharedCredentialResponse = response();
  await sharedCredentialEndpoint(request({
    headers: headers(),
    body: JSON.stringify({ action: 'HEALTH' }),
  }), sharedCredentialResponse);
  assert.equal(sharedCredentialResponse.statusCode, 503);
  assert.equal(JSON.parse(sharedCredentialResponse.body).code, 'KEEPER_JOURNAL_UNCONFIGURED');
  assert.equal(calls, 0);
});

test('health is authenticated but does not require an idempotency key', async () => {
  const endpoint = handler({
    async execute({ request: parsed, idempotencyKey }) {
      assert.equal(parsed.action, 'HEALTH');
      assert.equal(idempotencyKey, null);
      return {
        status: 'ready', service: 'liquidity-arena-keeper-journal', ready: true,
        network: 'bradbury', chainId: '4221', configuration: {}, database: {},
      };
    },
  });
  const res = response();
  await endpoint(request({
    headers: headers({ 'idempotency-key': undefined }),
    body: JSON.stringify({ action: 'HEALTH' }),
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ready, true);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('client readiness requires the exact Bradbury version 5 journal schema', async () => {
  const ready = {
    status: 'ready',
    service: 'liquidity-arena-keeper-journal',
    ready: true,
    network: 'bradbury',
    chainId: '4221',
    configuration: {
      databaseConfigured: true,
      authenticationConfigured: true,
      signerConfigured: true,
    },
    database: { configured: true, ready: true, schemaVersion: 5 },
  };
  const client = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify(ready), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal((await client.health()).database.schemaVersion, 5);

  const staleClient = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({
      ...ready,
      database: { configured: true, ready: true, schemaVersion: 4 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    staleClient.health(),
    (error) => error.code === 'KEEPER_JOURNAL_RESPONSE_SHAPE',
  );
});

test('strict body parsing rejects duplicate and prototype keys before service execution', async () => {
  let calls = 0;
  const endpoint = handler({ async execute() { calls += 1; } });
  for (const body of [
    '{"action":"HEALTH","action":"HEALTH"}',
    '{"action":"HEALTH","__proto__":{}}',
  ]) {
    const res = response();
    await endpoint(request({ headers: headers(), body }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'KEEPER_JOURNAL_JSON');
  }
  assert.equal(calls, 0);
});

test('non-health mutations require a bounded idempotency key', async () => {
  const endpoint = handler({ async execute() { throw new Error('must not execute'); } });
  const res = response();
  await endpoint(request({
    headers: headers({ 'idempotency-key': undefined }),
    body: JSON.stringify({
      action: 'LEASE_ACQUIRE', holderId: HOLDER, signerAddress: SIGNER, leaseSeconds: 900,
    }),
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'KEEPER_JOURNAL_IDEMPOTENCY_KEY');
});

test('outage before PREPARE acknowledgment causes zero broadcasts', async () => {
  let broadcasts = 0;
  const unavailable = new KeeperJournalClientError(
    'KEEPER_JOURNAL_CLIENT_NETWORK',
    'Keeper journal request failed.',
  );
  await assert.rejects(
    runPreparedKeeperBroadcast({
      client: { async prepareOperation() { throw unavailable; } },
      lease: {},
      operation: {},
      idempotencyKey: 'keeper:test:prepare1',
      broadcast() { broadcasts += 1; },
    }),
    (error) => error === unavailable,
  );
  assert.equal(broadcasts, 0);
});

test('client keeps its timeout active while reading a stalled response body', async () => {
  const client = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    timeoutMs: 1_000,
    fetchImpl: async (_url, options) => {
      let streamController;
      const stream = new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode('{"status":"ready"'));
        },
      });
      options.signal.addEventListener('abort', () => streamController.error(new Error('aborted')));
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(
    client.health(),
    (error) => error.code === 'KEEPER_JOURNAL_CLIENT_TIMEOUT',
  );
});

test('client validates successful response shapes instead of trusting arbitrary JSON', async () => {
  const client = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', lease: { fencingToken: '1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    client.acquireLease({
      holderId: HOLDER,
      signerAddress: SIGNER,
      leaseSeconds: 900,
      idempotencyKey: 'keeper:test:00000002',
    }),
    (error) => error.code === 'KEEPER_JOURNAL_RESPONSE_SHAPE',
  );
});

test('PREPARE response can authorize only the exact newly fenced operation', async () => {
  const requestedOperation = {
    deploymentAlias: 'v8', chainId: '4221',
    contractAddress: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef', method: 'resolve_epoch',
    subjectType: 'epoch', subjectId: '1800014400',
    args: ['1800014400'], valueAtto: '0',
  };
  const logicalOperationId = canonicalKeeperOperation(requestedOperation).operationId;
  const operation = {
    operationId: logicalOperationId,
    logicalOperationId,
    attemptNumber: '1',
    retryOfOperationId: null,
    deploymentAlias: 'v8',
    network: 'bradbury',
    chainId: '4221',
    signerAddress: SIGNER,
    contractAddress: '0xb2ae59ae641f571726ae81e30080f8c2192b15ef',
    subjectType: 'epoch',
    subjectId: '1800014400',
    method: 'resolve_epoch',
    args: ['1800014400'],
    valueAtto: '0',
    state: 'PREPARED',
    transactionHash: null,
    lifecycleStatus: null,
    lifecycleObservedAt: null,
    stateReasonCode: null,
    quarantineReason: null,
    preparedAt: '2026-08-20T00:00:00.000Z',
    submittedAt: null,
    finalizedAt: null,
    verifiedAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
    revision: '1',
  };
  let authorization;
  const client = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({
        status: 'ok', action: 'PREPARE', operation, canBroadcast: true, inserted: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.prepareOperation({
    lease: { holderId: HOLDER, signerAddress: SIGNER, fencingToken: '1' },
    operation: requestedOperation,
    idempotencyKey: 'keeper:test:00000003',
  });
  assert.equal(result.canBroadcast, true);
  assert.equal(result.operation.operationId, operation.operationId);
  assert.equal(authorization, `Bearer ${SECRET}`);

  const retryOperation = {
    ...operation,
    operationId: keeperAttemptOperationId(logicalOperationId, '2'),
    attemptNumber: '2',
    retryOfOperationId: logicalOperationId,
  };
  const retryClient = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'ok', action: 'PREPARE', operation: retryOperation, canBroadcast: true, inserted: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const retry = await retryClient.prepareOperation({
    lease: { holderId: HOLDER, signerAddress: SIGNER, fencingToken: '1' },
    operation: requestedOperation,
    idempotencyKey: 'keeper:test:00000003b',
  });
  assert.equal(retry.operation.logicalOperationId, logicalOperationId);
  assert.equal(retry.operation.attemptNumber, '2');
  assert.equal(retry.operation.retryOfOperationId, operation.operationId);

  const changedCallClient = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'ok',
      action: 'PREPARE',
      operation: { ...operation, method: 'activate_timeout_refund' },
      canBroadcast: true,
      inserted: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    changedCallClient.prepareOperation({
      lease: { holderId: HOLDER, signerAddress: SIGNER, fencingToken: '1' },
      operation: requestedOperation,
      idempotencyKey: 'keeper:test:00000004',
    }),
    (error) => error.code === 'KEEPER_JOURNAL_RESPONSE_IDENTITY',
  );

  const submitted = {
    ...operation,
    state: 'SUBMITTED',
    transactionHash: `0x${'b'.repeat(64)}`,
    lifecycleStatus: 'PENDING',
    lifecycleObservedAt: '2026-08-20T00:00:01.000Z',
    submittedAt: '2026-08-20T00:00:01.000Z',
    updatedAt: '2026-08-20T00:00:01.000Z',
    revision: '2',
  };
  const falseAuthorizationClient = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'ok', action: 'PREPARE', operation: submitted, canBroadcast: true, inserted: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    falseAuthorizationClient.prepareOperation({
      lease: { holderId: HOLDER, signerAddress: SIGNER, fencingToken: '1' },
      operation: requestedOperation,
      idempotencyKey: 'keeper:test:00000005',
    }),
    (error) => error.code === 'KEEPER_JOURNAL_RESPONSE_AUTHORIZATION',
  );

  const repeatedPreparedClient = createKeeperJournalClient({
    endpoint: 'https://example.test/api/keeper-journal',
    secret: SECRET,
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'ok', action: 'PREPARE', operation, canBroadcast: true, inserted: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    repeatedPreparedClient.prepareOperation({
      lease: { holderId: HOLDER, signerAddress: SIGNER, fencingToken: '1' },
      operation: requestedOperation,
      idempotencyKey: 'keeper:test:00000005b',
    }),
    (error) => error.code === 'KEEPER_JOURNAL_RESPONSE_AUTHORIZATION',
  );

  let broadcasts = 0;
  await assert.rejects(
    runPreparedKeeperBroadcast({
      client: {
        async prepareOperation() {
          return { operation: submitted, canBroadcast: true, inserted: false };
        },
      },
      lease: { holderId: HOLDER, signerAddress: SIGNER, fencingToken: '1' },
      operation: requestedOperation,
      idempotencyKey: 'keeper:test:00000006',
      broadcast() { broadcasts += 1; },
    }),
    (error) => error.code === 'KEEPER_JOURNAL_RESPONSE_AUTHORIZATION',
  );
  assert.equal(broadcasts, 0);
});
