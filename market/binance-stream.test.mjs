import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  BinanceStreamHub,
  CHANNEL,
  DEFAULT_ENDPOINT,
  DEFAULT_FALLBACK_ENDPOINT,
  DEFAULT_REST_TICKER_POLL_MS,
  FALLBACK_TRANSPORT,
  PRIMARY_TRANSPORT,
  REST_FALLBACK_TRANSPORT,
  TICKER_PRICE_METHOD,
  createBinanceStreamMiddleware,
  parseBinanceAggregateTrade,
  parseBinanceRestTickerPriceResponse,
  parseBinanceTickerPriceResponse,
} from './binance-stream.js';

function createTimers(start = 1_775_000_000_000) {
  let clock = start;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => clock,
    setTimeoutImpl(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, delay, dueAt: clock + delay });
      return id;
    },
    clearTimeoutImpl(id) { timeouts.delete(id); },
    setIntervalImpl(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearIntervalImpl(id) { intervals.delete(id); },
    async runDelay(delay) {
      const match = [...timeouts.entries()].find(([, task]) => task.delay === delay);
      assert.ok(match, `expected a scheduled ${delay}ms timeout`);
      const [id, task] = match;
      timeouts.delete(id);
      clock = Math.max(clock, task.dueAt);
      await task.callback();
    },
    async runInterval(delay) {
      const match = [...intervals.entries()].find(([, task]) => task.delay === delay);
      assert.ok(match, `expected a scheduled ${delay}ms interval`);
      const [, task] = match;
      clock += delay;
      await task.callback();
    },
    timeoutDelays: () => [...timeouts.values()].map((task) => task.delay),
    counts: () => ({ timeouts: timeouts.size, intervals: intervals.size }),
  };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.terminated = false;
    this.pings = 0;
    this.sent = [];
  }

  close() { this.closed = true; this.emit('close'); }
  terminate() { this.terminated = true; this.emit('close'); }
  ping() { this.pings += 1; }
  send(payload) { this.sent.push(payload); }
}

function aggregateTrade(symbol, price, timestamp, aggregateTradeId = undefined) {
  return {
    stream: `${symbol.toLowerCase()}@aggTrade`,
    data: {
      e: 'aggTrade',
      s: symbol,
      p: String(price),
      T: timestamp,
      ...(aggregateTradeId === undefined ? {} : { a: aggregateTradeId }),
    },
  };
}

function tickerPriceResponse(id, prices = {
  BTCUSDT: 65_000,
  ETHUSDT: 3_500,
  BNBUSDT: 700,
  SOLUSDT: 180,
  XRPUSDT: 2.5,
}) {
  return {
    id,
    status: 200,
    result: Object.entries(prices).map(([symbol, price]) => ({ symbol, price: String(price) })),
  };
}

function restTickerPrices(prices = {
  BTCUSDT: 65_000,
  ETHUSDT: 3_500,
  BNBUSDT: 700,
  SOLUSDT: 180,
  XRPUSDT: 2.5,
}) {
  return Object.entries(prices).map(([symbol, price]) => ({ symbol, price: String(price) }));
}

function restTickerResponse(prices) {
  return {
    ok: true,
    status: 200,
    json: async () => restTickerPrices(prices),
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('aggregate-trade parser accepts the configured Binance Spot pairs only', () => {
  const quote = parseBinanceAggregateTrade(aggregateTrade('BTCUSDT', 65_001.23, 1_775_000_000_123));
  assert.deepEqual(quote, {
    id: 'btc',
    symbol: 'BTCUSDT',
    price: 65_001.23,
    feedUpdateTimestampUs: '1775000000123000',
    sourceTimestampUs: '1775000000123000',
    marketSession: 'open',
  });
  assert.equal(parseBinanceAggregateTrade(aggregateTrade('DOGEUSDT', 1, 1_775_000_000_123)), null);
  assert.equal(parseBinanceAggregateTrade({ data: { s: 'BTCUSDT', p: 'bad', T: 1 } }), null);
});

test('aggregate-trade parser preserves Binance aggregate ID for equal-millisecond ordering', () => {
  const quote = parseBinanceAggregateTrade(aggregateTrade('BTCUSDT', 65_001.23, 1_775_000_000_123, '847293'));
  assert.equal(quote.aggregateTradeId, '847293');
  assert.equal(parseBinanceAggregateTrade(aggregateTrade('BTCUSDT', 65_001.23, 1_775_000_000_123, 'not-an-id')), null);
});

test('ticker-price fallback parser accepts exactly the fixed five-symbol basket', () => {
  const quotes = parseBinanceTickerPriceResponse(tickerPriceResponse('request-1'), 1_775_000_000_123);
  assert.deepEqual(quotes.map((quote) => quote.id), ['btc', 'eth', 'bnb', 'sol', 'xrp']);
  assert.equal(quotes[0].price, 65_000);
  assert.equal(quotes[0].feedUpdateTimestampUs, '1775000000123000');

  assert.equal(parseBinanceTickerPriceResponse({ status: 200, result: [{ symbol: 'BTCUSDT', price: '1' }] }, 1), null);
  assert.equal(parseBinanceTickerPriceResponse(tickerPriceResponse('request-2', {
    BTCUSDT: 1,
    ETHUSDT: 2,
    BNBUSDT: 3,
    SOLUSDT: 4,
    DOGEUSDT: 5,
  }), 1), null);
  assert.equal(parseBinanceTickerPriceResponse(tickerPriceResponse('request-3', {
    BTCUSDT: 1,
    ETHUSDT: 2,
    BNBUSDT: 3,
    SOLUSDT: 4,
    XRPUSDT: 0,
  }), 1), null);
});

test('REST ticker fallback parser accepts exactly the fixed five-symbol basket', () => {
  const quotes = parseBinanceRestTickerPriceResponse(restTickerPrices(), 1_775_000_000_123);
  assert.deepEqual(quotes.map((quote) => quote.id), ['btc', 'eth', 'bnb', 'sol', 'xrp']);
  assert.equal(quotes[0].feedUpdateTimestampUs, '1775000000123000');
  assert.equal(parseBinanceRestTickerPriceResponse(restTickerPrices({
    BTCUSDT: 1,
    ETHUSDT: 2,
    BNBUSDT: 3,
    SOLUSDT: 4,
  }), 1), null);
});

test('one Binance connection fans aggregate trades out as coalesced source-neutral payloads', async () => {
  const timers = createTimers();
  const sockets = [];
  const events = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    webSocketFactory(url) {
      assert.equal(url, DEFAULT_ENDPOINT);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  hub.subscribe((payload) => events.push(payload));
  assert.equal(sockets.length, 1);
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify(aggregateTrade('BTCUSDT', 65_000, 1_775_000_000_050)));
  sockets[0].emit('message', JSON.stringify(aggregateTrade('ETHUSDT', 3_500, 1_775_000_000_100)));
  await timers.runDelay(0);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'binance_stream');
  assert.equal(events[0].channel, CHANNEL);
  assert.equal(events[0].transport, PRIMARY_TRANSPORT);
  assert.equal(events[0].transportMode, 'primary');
  assert.equal(events[0].pollIntervalMs, null);
  assert.equal(events[0].timestampSource, 'exchange-event');
  assert.equal(events[0].sourceTimestampUs, '1775000000100000');
  assert.deepEqual(events[0].assets.map((asset) => asset.id), ['btc', 'eth']);
  assert.equal(hub.running, true);
  hub.destroy();
  assert.equal(sockets[0].closed, true);
});

test('Binance hub rejects delayed per-asset trades but accepts a later trade for another asset', async () => {
  const timers = createTimers();
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    webSocketFactory: () => new FakeSocket(),
  });
  assert.equal(hub.ingest(aggregateTrade('BTCUSDT', 100, 1_000)), true);
  assert.equal(hub.ingest(aggregateTrade('BTCUSDT', 99, 999)), false);
  assert.equal(hub.ingest(aggregateTrade('ETHUSDT', 50, 998)), true,
    'different asset timestamps do not get rejected by a global ordering rule');
  await timers.runDelay(0);
  assert.equal(hub.latestByAsset.get('btc').price, 100);
  assert.equal(hub.latestByAsset.get('eth').price, 50);
  hub.destroy();
});

test('Binance hub accepts a newer aggregate ID at the same millisecond and rejects an older ID', async () => {
  const timers = createTimers();
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    webSocketFactory: () => new FakeSocket(),
  });
  assert.equal(hub.ingest(aggregateTrade('BTCUSDT', 100, 1_000, '41')), true);
  assert.equal(hub.ingest(aggregateTrade('BTCUSDT', 101, 1_000, '42')), true);
  assert.equal(hub.ingest(aggregateTrade('BTCUSDT', 99, 1_000, '40')), false);
  await timers.runDelay(0);
  assert.equal(hub.latestByAsset.get('btc').price, 101);
  assert.equal(hub.latestByAsset.get('btc').aggregateTradeId, '42');
  hub.destroy();
});

test('a silently open primary stream switches to the 443 ticker fallback and emits explicit metadata', async () => {
  const timers = createTimers();
  const sockets = [];
  const urls = [];
  const events = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    reconnectBaseMs: 500,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    webSocketFactory(url) {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  hub.subscribe((payload) => events.push(payload));
  sockets[0].emit('open');

  await timers.runDelay(10_000);
  assert.equal(sockets[0].terminated, true);
  assert.equal(urls[1], DEFAULT_FALLBACK_ENDPOINT);

  const fallback = sockets[1];
  fallback.emit('open');
  assert.equal(fallback.sent.length, 1);
  const firstRequest = JSON.parse(fallback.sent[0]);
  assert.equal(firstRequest.method, TICKER_PRICE_METHOD);
  assert.deepEqual(firstRequest.params.symbols, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT']);

  fallback.emit('message', JSON.stringify(tickerPriceResponse(firstRequest.id)));
  await timers.runDelay(0);
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, TICKER_PRICE_METHOD);
  assert.equal(events[0].transport, FALLBACK_TRANSPORT);
  assert.equal(events[0].transportMode, 'fallback');
  assert.equal(events[0].pollIntervalMs, 1_000);
  assert.equal(events[0].timestampSource, 'relay-receipt');
  assert.deepEqual(events[0].assets.map((asset) => asset.id), ['btc', 'eth', 'bnb', 'sol', 'xrp']);

  await timers.runInterval(1_000);
  assert.equal(fallback.sent.length, 2, 'one five-symbol ticker request is sent per second at most');

  hub.destroy();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

test('a synchronous primary connection failure immediately attempts the official port-443 fallback', () => {
  const urls = [];
  const hub = new BinanceStreamHub({
    webSocketFactory(url) {
      urls.push(url);
      if (url === DEFAULT_ENDPOINT) throw new Error('port 9443 blocked');
      return new FakeSocket();
    },
  });
  hub.start();
  assert.deepEqual(urls, [DEFAULT_ENDPOINT, DEFAULT_FALLBACK_ENDPOINT]);
  hub.destroy();
});

test('a synchronous port-443 connection failure immediately starts the REST ticker fallback', async () => {
  const timers = createTimers();
  const urls = [];
  const fetches = [];
  const events = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return restTickerResponse();
    },
    webSocketFactory(url) {
      urls.push(url);
      throw new Error(`${url} blocked`);
    },
  });
  hub.subscribe((payload) => events.push(payload));

  assert.deepEqual(urls, [DEFAULT_ENDPOINT, DEFAULT_FALLBACK_ENDPOINT]);
  await flushAsyncWork();
  await timers.runDelay(0);
  assert.equal(fetches.length, 1);
  assert.equal(events[0].transport, REST_FALLBACK_TRANSPORT);

  hub.destroy();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

test('a black-holed primary handshake is bounded and opens the port-443 fallback', async () => {
  const timers = createTimers();
  const sockets = [];
  const urls = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    webSocketFactory(url) {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  hub.start();
  assert.equal(urls[0], DEFAULT_ENDPOINT);
  await timers.runDelay(5_000);
  assert.equal(sockets[0].terminated, true);
  assert.equal(urls[1], DEFAULT_FALLBACK_ENDPOINT);

  hub.destroy();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

test('a black-holed WebSocket fallback switches to the bounded REST ticker fallback', async () => {
  const timers = createTimers();
  const sockets = [];
  const urls = [];
  const fetches = [];
  const events = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      // Prove the strict REST host failover: Vision fails, api.binance.com succeeds.
      if (String(url).startsWith('https://data-api.binance.vision/')) return { ok: false, status: 503 };
      return restTickerResponse();
    },
    webSocketFactory(url) {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  hub.subscribe((payload) => events.push(payload));
  sockets[0].emit('open');
  assert.equal(timers.timeoutDelays().includes(5_000), false, 'opening clears the handshake timer');
  sockets[0].emit('close');
  assert.equal(urls[1], DEFAULT_FALLBACK_ENDPOINT);
  await timers.runDelay(5_000);
  assert.equal(sockets[1].terminated, true);
  await flushAsyncWork();
  await timers.runDelay(0);
  assert.deepEqual(fetches.map((url) => new URL(url).host), ['data-api.binance.vision', 'api.binance.com']);
  assert.equal(events[0].transport, REST_FALLBACK_TRANSPORT);
  assert.equal(events[0].transportMode, 'fallback');
  assert.equal(events[0].pollIntervalMs, DEFAULT_REST_TICKER_POLL_MS);
  assert.equal(events[0].timestampSource, 'relay-receipt');

  hub.destroy();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

test('a silent port-443 fallback becomes a real two-second REST ticker feed', async () => {
  const timers = createTimers();
  const sockets = [];
  const urls = [];
  const fetches = [];
  const events = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return restTickerResponse();
    },
    webSocketFactory(url) {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  hub.subscribe((payload) => events.push(payload));
  sockets[0].emit('open');
  sockets[0].emit('close');
  sockets[1].emit('open');

  await timers.runDelay(10_000);
  assert.equal(sockets[1].terminated, true);
  await flushAsyncWork();
  await timers.runDelay(0);
  assert.equal(events[0].transport, REST_FALLBACK_TRANSPORT);
  assert.equal(events[0].pollIntervalMs, 2_000);
  await timers.runDelay(2_000);
  await flushAsyncWork();
  await timers.runDelay(0);
  assert.equal(fetches.length, 2, 'one fixed five-symbol REST request is made every two seconds');

  hub.destroy();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

test('all REST ticker hosts failing retries the preferred aggregate-trade stream', async () => {
  const timers = createTimers();
  const sockets = [];
  const urls = [];
  const fetches = [];
  const hub = new BinanceStreamHub({
    now: timers.now,
    reconnectBaseMs: 500,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return { ok: false, status: 503 };
    },
    webSocketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  hub.start();
  sockets[0].emit('open');
  sockets[0].emit('close');
  assert.equal(sockets.length, 2);
  assert.equal(urls[0], DEFAULT_ENDPOINT);
  assert.equal(urls[1], DEFAULT_FALLBACK_ENDPOINT);
  sockets[1].emit('open');
  sockets[1].emit('close');
  await flushAsyncWork();
  assert.equal(fetches.length, 3, 'all documented REST hosts are tried before reconnecting');
  assert.ok(timers.timeoutDelays().includes(500));
  await timers.runDelay(500);
  assert.equal(sockets.length, 3);
  assert.equal(urls[2], DEFAULT_ENDPOINT);
  hub.destroy();
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

function requestResponse(url) {
  const req = new EventEmitter();
  req.url = url;
  req.method = 'GET';
  req.socket = { remoteAddress: '127.0.0.1' };
  const headers = new Map();
  const res = new EventEmitter();
  res.setHeader = (name, value) => headers.set(String(name).toLowerCase(), String(value));
  res.getHeader = (name) => headers.get(String(name).toLowerCase());
  res.flushHeaders = () => {};
  res.write = (chunk) => { res.body = `${res.body || ''}${chunk}`; return true; };
  res.end = (chunk = '') => { res.body = `${res.body || ''}${chunk}`; res.writableEnded = true; };
  return { req, res };
}

test('same-origin SSE middleware sends hub payloads and enforces per-IP capacity', async () => {
  const hub = {
    configured: true,
    running: false,
    clientCount: 0,
    start() { this.running = true; },
    subscribe(listener) {
      this.clientCount += 1;
      listener({ type: 'binance_stream', sequence: 7, assets: [] });
      return () => { this.clientCount -= 1; };
    },
  };
  const middleware = createBinanceStreamMiddleware({ hub, sseKeepaliveMs: 0, maxClientsPerIp: 1 });
  const first = requestResponse('/api/binance/stream');
  await middleware(first.req, first.res, () => assert.fail('stream route should be handled'));
  assert.equal(first.res.statusCode, 200);
  assert.match(first.res.getHeader('content-type'), /^text\/event-stream/);
  assert.match(first.res.body, /event: prices\ndata: \{"type":"binance_stream","sequence":7,"assets":\[\]\}\n\n/);

  const second = requestResponse('/api/binance/stream');
  await middleware(second.req, second.res, () => assert.fail('stream route should be handled'));
  assert.equal(second.res.statusCode, 429);
  assert.match(second.res.body, /Too many Binance stream connections/);

  first.req.emit('close');
});

test('SSE middleware ends cleanly at its configured lifetime and releases the client', async () => {
  const timers = createTimers();
  const hub = {
    configured: true,
    running: false,
    clientCount: 0,
    start() { this.running = true; },
    subscribe() {
      this.clientCount += 1;
      return () => { this.clientCount -= 1; };
    },
  };
  const middleware = createBinanceStreamMiddleware({
    hub,
    sseKeepaliveMs: 0,
    sseLifetimeMs: 285_000,
    sseSetTimeoutImpl: timers.setTimeoutImpl,
    sseClearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const request = requestResponse('/api/binance/stream');
  await middleware(request.req, request.res, () => assert.fail('stream route should be handled'));

  assert.equal(hub.clientCount, 1);
  assert.deepEqual(timers.timeoutDelays(), [285_000]);
  await timers.runDelay(285_000);
  assert.equal(request.res.writableEnded, true);
  assert.equal(hub.clientCount, 0);
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });

  const disconnected = requestResponse('/api/binance/stream');
  await middleware(disconnected.req, disconnected.res, () => assert.fail('stream route should be handled'));
  assert.equal(hub.clientCount, 1);
  disconnected.req.emit('close');
  assert.equal(hub.clientCount, 0);
  assert.deepEqual(timers.counts(), { timeouts: 0, intervals: 0 });
});

test('SSE lifetime timer injection does not replace hub timer injection', () => {
  const hubSetTimeout = () => 1;
  const hubClearTimeout = () => {};
  const sseSetTimeout = () => 2;
  const sseClearTimeout = () => {};
  const middleware = createBinanceStreamMiddleware({
    setTimeoutImpl: hubSetTimeout,
    clearTimeoutImpl: hubClearTimeout,
    sseSetTimeoutImpl: sseSetTimeout,
    sseClearTimeoutImpl: sseClearTimeout,
  });

  assert.equal(middleware.hub.setTimeoutImpl, hubSetTimeout);
  assert.equal(middleware.hub.clearTimeoutImpl, hubClearTimeout);
  middleware.hub.destroy();
});
