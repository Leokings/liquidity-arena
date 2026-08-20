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

test('scheduled history projection stays within the StudioNet read quota', async () => {
  const workflow = await readFile(new URL('../.github/workflows/studionet-v7-keeper.yml', import.meta.url), 'utf8');
  assert.match(
    workflow,
    /history-sync\.mjs --deployment v7 --deployment v6 --max-epochs 2 --no-known-proofs --idempotency-key "history-sync:\$\{\{ github\.run_id \}\}"/,
  );
  assert.doesNotMatch(workflow, /history-sync\.mjs[^\r\n]*--max-epochs 10/);
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

test('public proof view paginates the live V7 fee parent without claiming treasury child credit', async () => {
  const feeParent = '0x3df8d942bd9c5d699ee0d7816761ec5fd6264108d3a3e8bf3486c2c4f4fbb01f';
  const treasuryChild = '0x566082ceef10482356f7aeac310098b7ece8f9c0a7e054eb1db718623602470e';
  const deploymentId = `studionet:0x${'7'.repeat(40)}`;
  const feeProof = {
    transactionHash: feeParent,
    deploymentId,
    deploymentAlias: 'v7',
    epochEndTimestamp: null,
    kind: 'FEE_WITHDRAWAL',
    method: 'withdraw_accrued_fees',
    status: 'FINALIZED',
    valueAtto: '0',
    valueCredited: null,
    parentTransactionHash: null,
    childTransactionHashes: [],
    verifiedAt: '2026-08-19T22:42:37.000Z',
  };
  const olderProof = {
    ...feeProof,
    transactionHash: `0x${'2'.repeat(64)}`,
    epochEndTimestamp: '1787166000',
    kind: 'RESOLVE_EPOCH',
    method: 'resolve_epoch',
  };
  let calls = 0;
  const repository = {
    configured: true,
    async listProofs(query) {
      calls += 1;
      assert.equal(query.view, 'proofs');
      assert.equal(query.deployment, 'v7');
      assert.equal(query.limit, 1);
      if (calls === 1) {
        assert.equal(query.cursor, null);
        return [feeProof, olderProof];
      }
      assert.equal(query.cursor.transactionHash, feeParent);
      return [olderProof];
    },
  };
  const handler = createPublicHistoryHandler({ repository });
  const first = response();
  await handler(request({ url: '/api/history?view=proofs&deployment=v7&limit=1' }), first);
  assert.equal(first.statusCode, 200);
  const firstPayload = JSON.parse(first.body);
  assert.equal(firstPayload.dataScope, 'VERIFIED_TRANSACTION_PROOFS');
  assert.equal(firstPayload.view, 'proofs');
  assert.equal(firstPayload.deployment, 'v7');
  assert.equal(firstPayload.items[0].transactionHash, feeParent);
  assert.equal(firstPayload.items[0].epochEndTimestamp, null);
  assert.equal(firstPayload.items[0].valueCredited, null);
  assert.deepEqual(firstPayload.items[0].childTransactionHashes, []);
  assert.equal(firstPayload.items[0].childTransactionHashes.includes(treasuryChild), false);
  assert.ok(firstPayload.page.nextCursor);

  const second = response();
  await handler(request({
    url: `/api/history?view=proofs&deployment=v7&limit=1&cursor=${firstPayload.page.nextCursor}`,
  }), second);
  assert.equal(second.statusCode, 200);
  const secondPayload = JSON.parse(second.body);
  assert.equal(secondPayload.items[0].transactionHash, olderProof.transactionHash);
  assert.equal(secondPayload.page.nextCursor, null);

  const missingDeployment = response();
  await handler(request({ url: '/api/history?view=proofs' }), missingDeployment);
  assert.equal(missingDeployment.statusCode, 400);
  assert.equal(calls, 2);
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
