import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  DEFAULT_BINANCE_REST_BASES,
  allowedSymbol,
  configuredBinanceRestBases,
  createBinanceProxyMiddleware,
} from './binance-proxy.js';

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function invoke(middleware, url, { method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.socket = { remoteAddress };
  const headers = new Map();
  const res = new EventEmitter();
  res.statusCode = 0;
  res.setHeader = (name, value) => headers.set(String(name).toLowerCase(), String(value));
  res.getHeader = (name) => headers.get(String(name).toLowerCase());
  res.end = (body = '') => { res.body = String(body); res.writableEnded = true; };
  return Promise.resolve(middleware(req, res, () => { res.next = true; })).then(() => res);
}

const KLINES = [
  [1_700_000_000_000, '100', '101', '99', '100.5'],
  [1_700_000_060_000, '100.5', '102', '100', '101'],
];

test('Binance proxy allows only the five fixed USDT pairs', () => {
  assert.equal(allowedSymbol('BTCUSDT'), true);
  assert.equal(allowedSymbol('BNBUSDT'), true);
  assert.equal(allowedSymbol('BTCUSD'), false);
  assert.equal(allowedSymbol('DOGEUSDT'), false);
});

test('Binance proxy forwards only bounded kline requests without a secret', async () => {
  const requests = [];
  const middleware = createBinanceProxyMiddleware({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return response(KLINES);
    },
  });
  const res = await invoke(middleware, '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), KLINES);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT&interval=5m&limit=240/);
  assert.deepEqual(requests[0].options.headers, { accept: 'application/json' });
});

test('Binance REST configuration is restricted to documented Spot v3 hosts', () => {
  assert.deepEqual(configuredBinanceRestBases(), DEFAULT_BINANCE_REST_BASES);
  assert.deepEqual(
    configuredBinanceRestBases('https://api.binance.com/api/v3, https://api-gcp.binance.com/api/v3/'),
    ['https://api.binance.com/api/v3', 'https://api-gcp.binance.com/api/v3'],
  );
  assert.throws(
    () => configuredBinanceRestBases('https://example.invalid/api/v3'),
    /documented Binance Spot REST v3 endpoints/,
  );
});

test('Binance proxy falls back to an official host and caches the successful logical request', async () => {
  const requests = [];
  const middleware = createBinanceProxyMiddleware({
    upstreamBases: [
      'https://data-api.binance.vision/api/v3',
      'https://api.binance.com/api/v3',
    ],
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).startsWith('https://data-api.binance.vision/')) return response({ code: -1000 }, 503);
      return response(KLINES);
    },
  });
  const url = '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240';
  assert.equal((await invoke(middleware, url)).statusCode, 200);
  assert.deepEqual(requests.map((request) => new URL(request).host), ['data-api.binance.vision', 'api.binance.com']);

  // The successful fallback is cached by the logical request, so it is not
  // preceded by another failed Vision attempt on each browser refresh.
  assert.equal((await invoke(middleware, url)).statusCode, 200);
  assert.equal(requests.length, 2);
});

test('Binance proxy rejects unexpected symbols, intervals, methods, and query parameters before upstream', async () => {
  let calls = 0;
  const middleware = createBinanceProxyMiddleware({ fetchImpl: async () => { calls += 1; return response(KLINES); } });
  const invalidSymbol = await invoke(middleware, '/api/binance/klines?symbol=DOGEUSDT&interval=5m&limit=240');
  assert.equal(invalidSymbol.statusCode, 400);
  const invalidInterval = await invoke(middleware, '/api/binance/klines?symbol=BTCUSDT&interval=1s&limit=240');
  assert.equal(invalidInterval.statusCode, 400);
  const invalidExtra = await invoke(middleware, '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240&startTime=1');
  assert.equal(invalidExtra.statusCode, 400);
  const invalidMethod = await invoke(middleware, '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240', { method: 'POST' });
  assert.equal(invalidMethod.statusCode, 405);
  assert.equal(calls, 0);
});

test('Binance proxy permits only the four fixed UI history shapes', async () => {
  let calls = 0;
  const middleware = createBinanceProxyMiddleware({
    fetchImpl: async () => { calls += 1; return response(KLINES); },
  });
  for (const [interval, limit] of [['1m', 180], ['5m', 240], ['15m', 240], ['1h', 240]]) {
    const res = await invoke(middleware, `/api/binance/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
    assert.equal(res.statusCode, 200, `${interval}/${limit} should remain available to the arena`);
  }
  const invalidLimit = await invoke(middleware, '/api/binance/klines?symbol=BTCUSDT&interval=1m&limit=240');
  assert.equal(invalidLimit.statusCode, 400);
  assert.match(invalidLimit.body, /must be 180 for the 1m market window/);
  assert.equal(calls, 4);
});

test('Binance proxy caches identical requests and enforces per-client quotas', async () => {
  let calls = 0;
  let clock = 100;
  const middleware = createBinanceProxyMiddleware({
    now: () => clock,
    historyCacheMs: 1_000,
    rateLimitRequests: 2,
    rateLimitWindowMs: 10_000,
    fetchImpl: async () => { calls += 1; return response(KLINES); },
  });
  const url = '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240';
  assert.equal((await invoke(middleware, url)).statusCode, 200);
  assert.equal((await invoke(middleware, url)).statusCode, 200);
  assert.equal(calls, 1, 'same kline query is coalesced/cached');
  const third = await invoke(middleware, url);
  assert.equal(third.statusCode, 429);
  assert.equal(third.getHeader('retry-after'), '10');
  clock += 10_000;
  assert.equal((await invoke(middleware, url)).statusCode, 200);
});

test('Binance proxy actively purges expired history and rate-limit records', async () => {
  let calls = 0;
  let clock = 100;
  const middleware = createBinanceProxyMiddleware({
    now: () => clock,
    historyCacheMs: 100,
    rateLimitWindowMs: 100,
    fetchImpl: async () => { calls += 1; return response(KLINES); },
  });
  const btc = '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240';
  const eth = '/api/binance/klines?symbol=ETHUSDT&interval=5m&limit=240';

  assert.equal((await invoke(middleware, btc, { remoteAddress: 'client-a' })).statusCode, 200);
  assert.deepEqual(middleware.getDiagnostics(), {
    activeRequests: 0,
    cacheBytes: Buffer.byteLength(JSON.stringify(KLINES)),
    cacheEntries: 1,
    inflightRequests: 0,
    rateLimitClients: 1,
  });

  clock += 100;
  assert.equal((await invoke(middleware, eth, { remoteAddress: 'client-b' })).statusCode, 200);
  const diagnostics = middleware.getDiagnostics();
  assert.equal(diagnostics.cacheEntries, 1, 'expired BTC cache entry is removed before ETH is cached');
  assert.equal(diagnostics.rateLimitClients, 1, 'expired client-a quota is removed before client-b is recorded');
  assert.equal(calls, 2);
});

test('Binance proxy uses LRU eviction and enforces a byte cache budget', async () => {
  let calls = 0;
  const lru = createBinanceProxyMiddleware({
    maxHistoryCacheEntries: 2,
    maxHistoryCacheBytes: 10_000,
    fetchImpl: async () => { calls += 1; return response(KLINES); },
  });
  const btc = '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240';
  const eth = '/api/binance/klines?symbol=ETHUSDT&interval=5m&limit=240';
  const bnb = '/api/binance/klines?symbol=BNBUSDT&interval=5m&limit=240';
  await invoke(lru, btc);
  await invoke(lru, eth);
  await invoke(lru, btc); // Promote BTC so ETH is the LRU entry.
  await invoke(lru, bnb);
  assert.equal(lru.getDiagnostics().cacheEntries, 2);
  await invoke(lru, btc);
  await invoke(lru, eth);
  assert.equal(calls, 4, 'BTC remained cached while ETH was evicted as the least-recently-used entry');

  const bodyBytes = Buffer.byteLength(JSON.stringify(KLINES));
  let byteCalls = 0;
  const byteBounded = createBinanceProxyMiddleware({
    maxHistoryCacheEntries: 8,
    maxHistoryCacheBytes: (bodyBytes * 2) - 1,
    fetchImpl: async () => { byteCalls += 1; return response(KLINES); },
  });
  await invoke(byteBounded, btc);
  await invoke(byteBounded, eth);
  assert.equal(byteBounded.getDiagnostics().cacheEntries, 1);
  assert.ok(byteBounded.getDiagnostics().cacheBytes <= (bodyBytes * 2) - 1);
  await invoke(byteBounded, btc);
  assert.equal(byteCalls, 3, 'the byte budget evicted the oldest response even below the entry cap');
});

test('Binance proxy bounds malformed, oversized, and unavailable upstream responses', async () => {
  const malformed = createBinanceProxyMiddleware({
    fetchImpl: async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal((await invoke(malformed, '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240')).statusCode, 502);

  const oversized = createBinanceProxyMiddleware({
    maxResponseBytes: 10,
    fetchImpl: async () => response(KLINES),
  });
  assert.equal((await invoke(oversized, '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240')).statusCode, 502);

  const unavailable = createBinanceProxyMiddleware({ fetchImpl: async () => response({ code: -1 }, 503) });
  assert.equal((await invoke(unavailable, '/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240')).statusCode, 502);
});
