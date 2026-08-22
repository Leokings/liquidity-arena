import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  StrictJsonParser,
  createHistoryHealthHandler,
  createHistoryRateLimiter,
  createHistorySyncHandler,
  createPublicHistoryHandler,
} from '../history/http.mjs';
import { TEST_EPOCH, TEST_PAYOUT_ID, testDeployment } from '../history/test-fixtures.mjs';
import { v8Environment } from '../server/v8-test-fixtures.test-helper.mjs';

function request({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  Object.defineProperty(req, 'body', {
    get() { throw new Error('the Vercel parsed-body helper must stay lazy'); },
  });
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

test('Vercel ships the finalized active Bradbury V8 deployment manifest', async () => {
  const ignore = await readFile(new URL('../.vercelignore', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../deployments/bradbury-v8.json', import.meta.url), 'utf8'));
  const rules = ignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(rules.includes('deployments/'), false);
  assert.equal(rules.includes('deployments/*.json'), false);
  assert.equal(manifest.deploymentAlias, 'v8');
  assert.equal(manifest.network, 'testnet-bradbury');
  assert.equal(manifest.chainId, 4_221);
  assert.equal(manifest.contractAddress, '0x06b643f94003e51c6dc47e89524e7fd045630549');
  assert.equal(manifest.deploymentStatus, 'FINALIZED');
  assert.equal(
    manifest.deploymentTransactionHash,
    '0xe024e26a5d439858a6505b7f704d778c56ae9b1ccbf95e08f629fff9c762de64',
  );
  assert.equal(
    manifest.factoryBindingTransactionHash,
    '0x72a0ce9d8dc5961292381d536910d9d39f703c26c5f8619e48972500df502717',
  );
  assert.equal(manifest.active, true);
  assert.equal(
    manifest.sourceSha256,
    '1e7545f8f0fd121d64f3565675ac8f541d0ba8274abbde60db0dd02d7d777db5',
  );
});

test('public history exposes only active V8 epochs and rejects every legacy selector', async () => {
  const deployment = testDeployment();
  const repository = {
    configured: true,
    async listEpochs(query) {
      assert.equal(query.deployment, 'v8');
      assert.equal(query.limit, 1);
      return [
        {
          deploymentId: deployment.deploymentId,
          deploymentAlias: 'v8',
          epochEndTimestamp: String(TEST_EPOCH),
        },
        {
          deploymentId: deployment.deploymentId,
          deploymentAlias: 'v8',
          epochEndTimestamp: String(TEST_EPOCH - 3_600),
        },
      ];
    },
  };
  const handler = createPublicHistoryHandler({ repository });
  const res = response();
  await handler(request({ url: '/api/history?view=epochs&deployment=v8&limit=1' }), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.deployment, 'v8');
  assert.equal(payload.items.length, 1);
  assert.ok(payload.page.nextCursor);
  assert.equal(Object.hasOwn(payload, 'database'), false);

  for (const selector of ['v6', 'v7']) {
    const invalid = response();
    await handler(request({ url: `/api/history?deployment=${selector}` }), invalid);
    assert.equal(invalid.statusCode, 400);
  }
  const rawSql = response();
  await handler(request({ url: '/api/history?sql=select' }), rawSql);
  assert.equal(rawSql.statusCode, 400);
});

test('public payout history paginates by Bradbury deployment plus payout ID and exposes stage proofs', async () => {
  const deployment = testDeployment();
  const newer = {
    deploymentId: deployment.deploymentId,
    deploymentAlias: 'v8',
    payoutId: TEST_PAYOUT_ID,
    createdAtTimestamp: String(TEST_EPOCH + 200),
    state: 'FUNDED_IN_ESCROW',
    stageProofs: [
      { stage: 'PREPARING', domain: 'GENLAYER', transactionHash: `0x${'1'.repeat(64)}` },
      { stage: 'FUNDED_IN_ESCROW', domain: 'EVM', transactionHash: `0x${'2'.repeat(64)}` },
    ],
  };
  const older = {
    ...newer,
    payoutId: '9'.repeat(64),
    createdAtTimestamp: String(TEST_EPOCH + 100),
  };
  let calls = 0;
  const repository = {
    configured: true,
    async listPayouts(query) {
      calls += 1;
      assert.equal(query.deployment, 'v8');
      assert.equal(query.limit, 1);
      if (calls === 1) {
        assert.equal(query.cursor, null);
        return [newer, older];
      }
      assert.equal(query.cursor.deploymentId, deployment.deploymentId);
      assert.equal(query.cursor.payoutId, TEST_PAYOUT_ID);
      return [older];
    },
  };
  const handler = createPublicHistoryHandler({ repository });
  const first = response();
  await handler(request({ url: '/api/history?view=payouts&limit=1' }), first);
  assert.equal(first.statusCode, 200);
  const firstPayload = JSON.parse(first.body);
  assert.equal(firstPayload.dataScope, 'V8_PAYOUT_STAGES');
  assert.equal(firstPayload.items[0].state, 'FUNDED_IN_ESCROW');
  assert.deepEqual(firstPayload.items[0].stageProofs.map((proof) => proof.domain), ['GENLAYER', 'EVM']);
  assert.ok(firstPayload.page.nextCursor);

  const second = response();
  await handler(request({
    url: `/api/history?view=payouts&limit=1&cursor=${firstPayload.page.nextCursor}`,
  }), second);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).items[0].payoutId, older.payoutId);
  assert.equal(calls, 2);
});

test('public V8 proof view records claim as a request without legacy transfer-child liability', async () => {
  const deployment = testDeployment();
  const claimRequest = {
    transactionHash: `0x${'3'.repeat(64)}`,
    deploymentId: deployment.deploymentId,
    deploymentAlias: 'v8',
    epochEndTimestamp: String(TEST_EPOCH),
    kind: 'CLAIM_REQUEST',
    method: 'claim',
    status: 'FINALIZED',
    valueAtto: '0',
    valueCredited: null,
    parentTransactionHash: null,
    childTransactionHashes: [],
    verifiedAt: '2026-08-22T00:00:00.000Z',
  };
  const repository = {
    configured: true,
    async listProofs(query) {
      assert.equal(query.deployment, 'v8');
      return [claimRequest];
    },
  };
  const handler = createPublicHistoryHandler({ repository });
  const res = response();
  await handler(request({ url: '/api/history?view=proofs&limit=1' }), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.items[0].kind, 'CLAIM_REQUEST');
  assert.equal(payload.items[0].valueCredited, null);
  assert.deepEqual(payload.items[0].childTransactionHashes, []);
});

test('history sync authenticates before service work and accepts only the V8 alias', async () => {
  const secret = 's'.repeat(32);
  let calls = 0;
  const service = {
    async sync({ request: parsed }) {
      calls += 1;
      assert.deepEqual(parsed.deployments, ['v8']);
      return { status: 'ok', deployments: ['v8'], epochsSynced: 0, payoutsSynced: 0 };
    },
  };
  const handler = createHistorySyncHandler({
    service,
    environment: { HISTORY_INGEST_SECRET: secret },
    rateLimiter: { allow: () => true },
  });
  const unauthorized = response();
  await handler(request({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'history-0001' },
    body: '{}',
  }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls, 0);

  const duplicate = response();
  await handler(request({
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'idempotency-key': 'history-0002',
    },
    body: '{"maxEpochs":1,"maxEpochs":2}',
  }), duplicate);
  assert.equal(duplicate.statusCode, 400);
  assert.equal(calls, 0);

  const accepted = response();
  await handler(request({
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'idempotency-key': 'history-0003',
    },
    body: '{"deployments":["v8"],"maxEpochs":1,"includeKnownProofs":false}',
  }), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls, 1);

  const legacy = response();
  await handler(request({
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      'idempotency-key': 'history-0004',
    },
    body: '{"deployments":["v7"]}',
  }), legacy);
  assert.equal(legacy.statusCode, 400);
  assert.equal(calls, 1);
});

test('history health requires exact Bradbury V8 configuration and schema-v5 integrity', async () => {
  const integrity = {
    checked: true,
    ready: false,
    journalSchemaVersion: 5,
    activeDeploymentCount: 1,
    activeV8Count: 1,
    activeLegacyCount: 0,
    verifiedV8TerminalOperationCount: 2,
    verifiedV8PayoutOperationCount: 3,
    missingDurableEpochCount: 0,
    staleDurableEpochCount: 0,
    missingDeterminedSnapshotCount: 0,
    missingDurablePayoutCount: 1,
    staleDurablePayoutCount: 0,
    countLimit: 10_000,
    countsCapped: false,
  };
  const repository = {
    configured: true,
    async health() {
      return { configured: true, ready: false, schemaVersion: 5, integrity };
    },
  };
  const environment = v8Environment({
    DATABASE_URL: 'postgresql://ignored.invalid/database',
    HISTORY_INGEST_SECRET: 's'.repeat(32),
  });
  const handler = createHistoryHealthHandler({ repository, environment });
  const res = response();
  await handler(request({ method: 'GET', url: '/api/history-health' }), res);
  assert.equal(res.statusCode, 503);
  const payload = JSON.parse(res.body);
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.configuration.chainConfigured, true);
  assert.equal(payload.database.schemaVersion, 5);
  assert.deepEqual(payload.database.integrity, integrity);

  const legacyEnvironment = {
    ...environment,
    VITE_GENLAYER_NETWORK: 'studionet',
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7',
  };
  const unconfigured = response();
  await createHistoryHealthHandler({ repository, environment: legacyEnvironment })(
    request({ method: 'GET', url: '/api/history-health' }),
    unconfigured,
  );
  assert.equal(unconfigured.statusCode, 200);
  assert.equal(JSON.parse(unconfigured.body).status, 'unconfigured');
});

test('history rate limiter is bounded and strict JSON rejects duplicate or unsafe members', () => {
  let timestamp = 0;
  const limiter = createHistoryRateLimiter({ limit: 2, windowMs: 1000, now: () => timestamp });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  timestamp = 1000;
  assert.equal(limiter.allow('a'), true);
  assert.throws(() => new StrictJsonParser('{"a":1,"a":2}').document(), /strict JSON/);
  assert.throws(() => new StrictJsonParser('{"a":9007199254740993}').document(), /strict JSON/);
  assert.deepEqual(new StrictJsonParser('{"a":[true,false,null]}').document(), { a: [true, false, null] });
});
