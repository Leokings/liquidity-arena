import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createGenLayerRpcProxyMiddleware,
  genLayerRpcProxyPlugin,
  normalizeJsonRpcIds,
  restoreJsonRpcIds,
} from './genlayer-rpc-proxy.js';
import { createClientIpResolver } from '../server/app.mjs';

function responseRecorder() {
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  return {
    statusCode: 0,
    headers: {},
    body: '',
    finished,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') {
      this.body = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      finish();
    },
  };
}

async function invoke(middleware, {
  body = '',
  headers = {},
  method = 'POST',
  remoteAddress = '203.0.113.1',
  url = '/genlayer-rpc',
} = {}) {
  const req = Readable.from(body === null ? [] : [body]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  const res = responseRecorder();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  if (!nextCalled) await res.finished;
  return { res, nextCalled };
}

test('normalizes a string request ID to a safe number and restores it', async () => {
  let upstreamRequest;
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: upstreamRequest.body.id,
        result: '0x1',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const { res } = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 'sdk-request-7', method: 'eth_chainId' }),
  });

  assert.equal(upstreamRequest.url, 'https://studio.genlayer.com/api');
  assert.equal(upstreamRequest.options.method, 'POST');
  assert.equal(Number.isSafeInteger(upstreamRequest.body.id), true);
  assert.notEqual(upstreamRequest.body.id, 'sdk-request-7');
  assert.deepEqual(JSON.parse(res.body), {
    jsonrpc: '2.0',
    id: 'sdk-request-7',
    result: '0x1',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('numeric-ID transaction proofs preserve Studio integer digits byte-for-byte', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const upstreamBody = `{"jsonrpc":"2.0","id":7,"result":{"hash":"${hash}","messages":[{"value":100000000000000000}]}}`;
  let forwarded;
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const { res } = await invoke(middleware, {
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'eth_getTransactionByHash',
      params: [hash],
    }),
  });

  assert.equal(forwarded.id, 7);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, upstreamBody);
  assert.match(res.body, /100000000000000000/);
});

test('numeric-ID transaction proofs use the strict 512 KiB upstream cap', async () => {
  const hash = `0x${'ef'.repeat(32)}`;
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      result: { hash, padding: 'x'.repeat(512 * 1024) },
    })),
  });

  const { res } = await invoke(middleware, {
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'eth_getTransactionByHash',
      params: [hash],
    }),
  });

  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error.message, /too large/i);
});

test('upstream streaming is cancelled at the byte cap with missing or false Content-Length', async () => {
  for (const declaredLength of [null, '1']) {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = declaredLength === null ? {} : { 'content-length': declaredLength };
    const middleware = createGenLayerRpcProxyMiddleware({
      maxResponseBytes: 64,
      fetchImpl: async () => new Response(body, { status: 200, headers }),
    });

    const { res } = await invoke(middleware, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'eth_chainId' }),
    });

    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error.message, /too large/i);
    assert.equal(cancelled, true);
    assert.ok(pulls >= 2);
  }
});

test('string-ID transaction reads retain ID normalization instead of raw passthrough', async () => {
  const hash = `0x${'cd'.repeat(32)}`;
  let forwardedId;
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      forwardedId = request.id;
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { hash, value: 1 },
      }));
    },
  });

  const { res } = await invoke(middleware, {
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'wallet-request',
      method: 'eth_getTransactionByHash',
      params: [hash],
    }),
  });

  assert.equal(Number.isSafeInteger(forwardedId), true);
  assert.deepEqual(JSON.parse(res.body), {
    jsonrpc: '2.0',
    id: 'wallet-request',
    result: { hash, value: 1 },
  });
});

test('batch remapping avoids numeric collisions and survives reordered responses', async () => {
  let forwarded;
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return new Response(JSON.stringify([
        { jsonrpc: '2.0', id: forwarded[3].id, result: 'second string' },
        { jsonrpc: '2.0', id: 1, result: 'numeric' },
        { jsonrpc: '2.0', id: forwarded[1].id, result: 'first string' },
      ]));
    },
  });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
    { jsonrpc: '2.0', id: 'alpha', method: 'eth_blockNumber' },
    { jsonrpc: '2.0', id: 3, method: 'eth_getBalance' },
    { jsonrpc: '2.0', id: 'beta', method: 'gen_call' },
    { jsonrpc: '2.0', method: 'net_version' },
  ];

  const { res } = await invoke(middleware, { body: JSON.stringify(requests) });
  const response = JSON.parse(res.body);

  assert.equal(forwarded[0].id, 1);
  assert.equal(forwarded[1].id, 2);
  assert.equal(forwarded[2].id, 3);
  assert.equal(forwarded[3].id, 4);
  assert.equal(Object.hasOwn(forwarded[4], 'id'), false);
  assert.deepEqual(response.map(({ id }) => id), ['beta', 1, 'alpha']);
});

test('normalization helpers leave numeric, null, and notification IDs intact', () => {
  const input = [
    { jsonrpc: '2.0', id: 9, method: 'numeric' },
    { jsonrpc: '2.0', id: 1.5, method: 'fractional numeric' },
    { jsonrpc: '2.0', id: null, method: 'null' },
    { jsonrpc: '2.0', method: 'notification' },
  ];
  const normalized = normalizeJsonRpcIds(input);
  assert.deepEqual(normalized.payload, input);
  assert.equal(normalized.originalIds.size, 0);
  assert.equal(normalized.expectsResponse, true);
  assert.deepEqual(restoreJsonRpcIds({ jsonrpc: '2.0', id: 9, result: true }, new Map()), {
    jsonrpc: '2.0', id: 9, result: true,
  });
});

test('OPTIONS receives a CORS preflight response without contacting GenLayer', async () => {
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async () => assert.fail('upstream must not be called'),
  });
  const { res } = await invoke(middleware, { method: 'OPTIONS', body: null });

  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(res.headers['access-control-allow-headers'], 'content-type');
});

test('malformed JSON and invalid JSON-RPC shapes are rejected before upstream', async () => {
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async () => assert.fail('upstream must not be called'),
  });

  const malformed = await invoke(middleware, { body: '{"jsonrpc":' });
  const invalid = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'eth_chainId' }),
  });
  const emptyBatch = await invoke(middleware, { body: '[]' });

  assert.equal(malformed.res.statusCode, 400);
  assert.equal(JSON.parse(malformed.res.body).error.code, -32700);
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(JSON.parse(invalid.res.body).error.code, -32600);
  assert.equal(emptyBatch.res.statusCode, 400);
  assert.equal(JSON.parse(emptyBatch.res.body).error.code, -32600);
});

test('request body limit is enforced before forwarding', async () => {
  const middleware = createGenLayerRpcProxyMiddleware({
    maxBodyBytes: 16,
    fetchImpl: async () => assert.fail('upstream must not be called'),
  });
  const { res } = await invoke(middleware, {
    body: '{"larger":"than limit"}',
    headers: { 'content-length': '23' },
  });

  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.body).error.code, -32000);
});

test('only wallet-safe Ethereum and required GenLayer methods are forwarded', async () => {
  const forwarded = [];
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      forwarded.push(request.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
    },
  });

  const genCall = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gen_call', params: [] }),
  });
  const rawTransaction = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_sendRawTransaction', params: ['0x00'] }),
  });
  const transactionRead = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'gen_getTransaction', params: ['0x00'] }),
  });
  const debug = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'gen_dbg_traceTransaction', params: [] }),
  });
  const personal = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'personal_unlockAccount', params: [] }),
  });

  assert.equal(genCall.res.statusCode, 200);
  assert.equal(rawTransaction.res.statusCode, 200);
  assert.equal(transactionRead.res.statusCode, 200);
  assert.equal(debug.res.statusCode, 403);
  assert.equal(JSON.parse(debug.res.body).error.code, -32601);
  assert.equal(personal.res.statusCode, 403);
  assert.deepEqual(forwarded, ['gen_call', 'eth_sendRawTransaction', 'gen_getTransaction']);
});

test('batch and per-client call limits reject abuse before forwarding', async () => {
  let calls = 0;
  let timestamp = 1_000;
  const middleware = createGenLayerRpcProxyMiddleware({
    maxBatchSize: 2,
    rateLimitRequests: 2,
    rateLimitWindowMs: 1_000,
    now: () => timestamp,
    clientKey: () => 'browser-1',
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x107d' }));
    },
  });
  const request = (id) => invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }),
  });

  assert.equal((await request(1)).res.statusCode, 200);
  assert.equal((await request(2)).res.statusCode, 200);
  const limited = await request(3);
  assert.equal(limited.res.statusCode, 429);
  assert.equal(limited.res.headers['retry-after'], '1');
  assert.equal(JSON.parse(limited.res.body).error.code, -32005);
  assert.equal(calls, 2);

  timestamp = 2_000;
  assert.equal((await request(4)).res.statusCode, 200);

  const oversizedBatch = await invoke(createGenLayerRpcProxyMiddleware({
    maxBatchSize: 1,
    fetchImpl: async () => assert.fail('upstream must not be called'),
  }), {
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 5, method: 'eth_chainId' },
      { jsonrpc: '2.0', id: 6, method: 'eth_blockNumber' },
    ]),
  });
  assert.equal(oversizedBatch.res.statusCode, 413);
});

test('rate-limit windows expire, stay bounded, and evict the least-recently-used client', async () => {
  let timestamp = 0;
  const middleware = createGenLayerRpcProxyMiddleware({
    rateLimitRequests: 1,
    rateLimitWindowMs: 100,
    maxRateLimitClients: 2,
    now: () => timestamp,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0xf22f' }));
    },
  });
  const request = (remoteAddress, id) => invoke(middleware, {
    remoteAddress,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_chainId' }),
  });

  assert.equal((await request('client-a', 1)).res.statusCode, 200);
  assert.equal((await request('client-b', 2)).res.statusCode, 200);
  assert.equal(middleware.getDiagnostics().rateLimitClients, 2);

  timestamp = 101;
  assert.equal((await request('client-c', 3)).res.statusCode, 200);
  assert.equal(middleware.getDiagnostics().rateLimitClients, 1);
  assert.equal((await request('client-d', 4)).res.statusCode, 200);
  assert.equal((await request('client-c', 5)).res.statusCode, 429);
  assert.equal((await request('client-e', 6)).res.statusCode, 200);
  assert.equal(middleware.getDiagnostics().rateLimitClients, 2);

  // Touching C moved it behind D, so inserting E evicted D deterministically.
  assert.equal((await request('client-d', 7)).res.statusCode, 200);
  assert.equal(middleware.getDiagnostics().rateLimitClients, 2);
});

test('RPC quotas use forwarded clients only when the direct proxy is trusted', async () => {
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x107d' }));
  };
  const request = (middleware, id, remoteAddress, forwardedFor) => invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }),
    headers: { 'x-forwarded-for': forwardedFor },
    remoteAddress,
  });

  const trustedProxy = createGenLayerRpcProxyMiddleware({
    fetchImpl,
    rateLimitRequests: 1,
    clientKey: createClientIpResolver(['127.0.0.1']),
  });
  assert.equal((await request(trustedProxy, 1, '127.0.0.1', '198.51.100.10')).res.statusCode, 200);
  assert.equal((await request(trustedProxy, 2, '127.0.0.1', '198.51.100.10')).res.statusCode, 429);
  assert.equal(
    (await request(trustedProxy, 3, '127.0.0.1', '198.51.100.11')).res.statusCode,
    200,
    'distinct forwarded clients receive independent quota windows behind a trusted proxy',
  );

  const untrustedPeer = createGenLayerRpcProxyMiddleware({
    fetchImpl,
    rateLimitRequests: 1,
    clientKey: createClientIpResolver(['127.0.0.1']),
  });
  assert.equal((await request(untrustedPeer, 4, '203.0.113.8', '198.51.100.10')).res.statusCode, 200);
  assert.equal(
    (await request(untrustedPeer, 5, '203.0.113.8', '198.51.100.11')).res.statusCode,
    429,
    'an untrusted direct peer cannot split its quota with spoofed forwarding values',
  );
});

test('upstream response and concurrency limits bound the GenLayer relay', async () => {
  const oversized = createGenLayerRpcProxyMiddleware({
    maxResponseBytes: 32,
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: 'x'.repeat(64),
    })),
  });
  const oversizedResult = await invoke(oversized, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
  });
  assert.equal(oversizedResult.res.statusCode, 502);
  assert.match(JSON.parse(oversizedResult.res.body).error.message, /too large/i);

  let releaseUpstream;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const upstreamGate = new Promise((resolve) => { releaseUpstream = resolve; });
  const capacityLimited = createGenLayerRpcProxyMiddleware({
    maxConcurrentRequests: 1,
    fetchImpl: async (_url, options) => {
      markStarted();
      await upstreamGate;
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x107d' }));
    },
  });
  const first = invoke(capacityLimited, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_chainId' }),
  });
  await started;
  const rejected = await invoke(capacityLimited, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_blockNumber' }),
  });
  assert.equal(rejected.res.statusCode, 503);
  assert.equal(JSON.parse(rejected.res.body).error.code, -32005);
  releaseUpstream();
  assert.equal((await first).res.statusCode, 200);
});

test('an empty successful upstream response is valid for notifications only', async () => {
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const notification = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId' }),
  });
  const request = await invoke(middleware, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'eth_chainId' }),
  });

  assert.equal(notification.res.statusCode, 204);
  assert.equal(request.res.statusCode, 502);
});

test('non-route requests fall through and plugin installs the same middleware', async () => {
  const middleware = createGenLayerRpcProxyMiddleware({
    fetchImpl: async () => assert.fail('upstream must not be called'),
  });
  const passthrough = await invoke(middleware, { url: '/not-genlayer' });
  assert.equal(passthrough.nextCalled, true);

  const installed = [];
  const plugin = genLayerRpcProxyPlugin({
    fetchImpl: async () => assert.fail('upstream must not be called'),
  });
  const devHookResult = plugin.configureServer({
    middlewares: { use(value) { installed.push(value); return this; } },
  });
  const previewHookResult = plugin.configurePreviewServer({
    middlewares: { use(value) { installed.push(value); return this; } },
  });
  assert.equal(installed.length, 2);
  assert.equal(installed[0], installed[1]);
  assert.equal(devHookResult, undefined);
  assert.equal(previewHookResult, undefined);
});
