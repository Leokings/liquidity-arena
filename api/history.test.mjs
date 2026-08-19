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

test('Vercel retains the deployment manifests required by history sync', async () => {
  const ignore = await readFile(new URL('../.vercelignore', import.meta.url), 'utf8');
  const rules = ignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(rules.includes('deployments/'), false);
  assert.equal(rules.includes('deployments/*.json'), false);
});

test('public history endpoint uses keyset pagination and never exposes repository internals', async () => {
  const repository = {
    configured: true,
    async listEpochs(query) {
      assert.equal(query.limit, 1);
      return [
        { deploymentId: `studionet:0x${'7'.repeat(40)}`, deploymentAlias: 'v7', epochEndTimestamp: '200' },
        { deploymentId: `studionet:0x${'6'.repeat(40)}`, deploymentAlias: 'v6', epochEndTimestamp: '100' },
      ];
    },
  };
  const handler = createPublicHistoryHandler({ repository });
  const res = response();
  await handler(request({ url: '/api/history?view=epochs&limit=1' }), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.items.length, 1);
  assert.ok(payload.page.nextCursor);
  assert.equal(Object.hasOwn(payload, 'database'), false);

  const invalid = response();
  await handler(request({ url: '/api/history?sql=select' }), invalid);
  assert.equal(invalid.statusCode, 400);
});

test('history sync authenticates before service work and rejects duplicate JSON keys', async () => {
  const secret = 's'.repeat(32);
  let calls = 0;
  const service = {
    async sync() {
      calls += 1;
      return { status: 'ok', epochsSynced: 0 };
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
    body: '{"deployments":["v7"],"maxEpochs":1,"includeKnownProofs":false}',
  }), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(calls, 1);
});

test('history rate limiter is bounded and health explicitly reports unconfigured state', async () => {
  let timestamp = 0;
  const limiter = createHistoryRateLimiter({ limit: 2, windowMs: 1000, now: () => timestamp });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  timestamp = 1000;
  assert.equal(limiter.allow('a'), true);

  const handler = createHistoryHealthHandler({
    repository: { configured: false, health: async () => { throw new Error('must not run'); } },
    environment: {},
  });
  const res = response();
  await handler(request({ method: 'GET', url: '/api/history-health' }), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.status, 'unconfigured');
  assert.equal(payload.configuration.databaseConfigured, false);
});

test('strict JSON parser rejects duplicate members and unsafe integer literals', () => {
  assert.throws(() => new StrictJsonParser('{"a":1,"a":2}').document(), /strict JSON/);
  assert.throws(() => new StrictJsonParser('{"a":9007199254740993}').document(), /strict JSON/);
  assert.deepEqual(new StrictJsonParser('{"a":[true,false,null]}').document(), { a: [true, false, null] });
});
