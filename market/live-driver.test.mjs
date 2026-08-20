import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LiveMarketDriver,
  ROUND_EVIDENCE_STATUS,
  STATIC_BINANCE_SYMBOLS,
  STREAM_CHANNEL,
  STREAM_BOOTSTRAP_TIMEOUT_MS,
  STREAM_DISPLAY_CADENCE_MS,
  WINDOW_QUERIES,
  calculateRoundMetrics,
  createSharedEventSourceConstructor,
  parseBinanceKlines,
  parseBinanceStreamPayload,
  resolveBinanceFeeds,
} from './live-driver.js';

const STREAM_ASSET_IDS = ['btc', 'eth', 'bnb', 'sol', 'xrp'];
const MINUTE_MS = 60_000;

function roundCandles({ fromMs, throughMs, incompleteOpenMs = null, priceAt = (index) => 100 + index }) {
  const candles = [];
  for (let openTimeMs = fromMs, index = 0; openTimeMs <= throughMs; openTimeMs += MINUTE_MS, index += 1) {
    const openPrice = priceAt(index, openTimeMs);
    candles.push(Object.freeze({
      openTimeMs,
      closeTimeMs: openTimeMs + MINUTE_MS - 1,
      openPrice,
      closePrice: openPrice + 1,
      completed: openTimeMs !== incompleteOpenMs,
    }));
  }
  return candles;
}

function klines(start = 100, end = 1_775_000_000_000) {
  return Array.from({ length: 240 }, (_, index) => {
    const openTime = end - ((239 - index) * 300_000);
    const price = (start + (index * 0.01)).toFixed(4);
    return [openTime, price, price, price, price, '1', openTime + 299_999, '1', 1, '1', '1', '0'];
  });
}

function oneMinuteKlines(now, start = 100) {
  const currentOpen = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return Array.from({ length: 180 }, (_, index) => {
    const openTime = currentOpen - ((179 - index) * MINUTE_MS);
    const open = start + (index * 0.01);
    const close = open + 0.005;
    return [openTime, String(open), String(close), String(open), String(close), '1', openTime + MINUTE_MS - 1, '1', 1, '1', '1', '0'];
  });
}

function createFetchRecorder() {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url), 'http://localhost');
    requests.push(parsed);
    const symbol = parsed.searchParams.get('symbol');
    return { ok: true, json: async () => klines(100 + symbol.length) };
  };
  return { fetchImpl, requests };
}

function createScheduler(startAt = Date.UTC(2026, 7, 1, 12)) {
  let clock = startAt;
  let nextId = 1;
  const tasks = new Map();
  return {
    now: () => clock,
    setTimeoutImpl(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, delay, dueAt: clock + delay });
      return id;
    },
    clearTimeoutImpl(id) { tasks.delete(id); },
    delays: () => [...tasks.values()].map((task) => task.delay),
    size: () => tasks.size,
    advance(delay) { clock += delay; },
    async runDelay(delay) {
      const match = [...tasks.entries()].find(([, task]) => task.delay === delay);
      assert.ok(match, `expected a scheduled ${delay}ms timer`);
      const [id, task] = match;
      tasks.delete(id);
      clock = Math.max(clock, task.dueAt);
      await task.callback();
    },
  };
}

function createFakeEventSource() {
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type, payload = null) {
      const event = type === 'prices'
        ? { data: typeof payload === 'string' ? payload : JSON.stringify(payload) }
        : payload;
      for (const listener of this.listeners.get(type) || []) listener(event);
    }

    close() { this.closed = true; }
  }
  FakeEventSource.instances = instances;
  return FakeEventSource;
}

function streamPayload(sourceMs, priceOffset = 0, overrides = {}) {
  const sourceTimestampUs = BigInt(sourceMs) * 1000n;
  return {
    type: 'binance_stream',
    sourceTimestampUs: sourceTimestampUs.toString(),
    assets: STREAM_ASSET_IDS.map((id, index) => ({
      id,
      price: 120 + index + priceOffset,
      feedUpdateTimestampUs: (sourceTimestampUs - BigInt(index * 10_000)).toString(),
      ...(overrides[id] || {}),
    })),
  };
}

test('shared EventSource constructor fans one native connection out and closes it after the last subscriber', () => {
  const NativeEventSource = createFakeEventSource();
  const SharedEventSource = createSharedEventSourceConstructor(NativeEventSource);
  const first = new SharedEventSource('/api/binance/stream');
  const second = new SharedEventSource('/api/binance/stream');
  const received = [];
  first.addEventListener('prices', (event) => received.push(['first', event.data]));
  second.addEventListener('prices', (event) => received.push(['second', event.data]));

  assert.equal(NativeEventSource.instances.length, 1);
  NativeEventSource.instances[0].emit('prices', { sourceTimestampUs: '1', assets: [] });
  assert.deepEqual(received.map(([subscriber]) => subscriber), ['first', 'second']);

  first.close();
  assert.equal(NativeEventSource.instances[0].closed, false);
  second.close();
  assert.equal(NativeEventSource.instances[0].closed, true);
});

test('a failing shared EventSource listener cannot starve another subscriber', () => {
  const NativeEventSource = createFakeEventSource();
  const SharedEventSource = createSharedEventSourceConstructor(NativeEventSource);
  const first = new SharedEventSource('/api/binance/stream');
  const second = new SharedEventSource('/api/binance/stream');
  const reported = [];
  const previousReportError = globalThis.reportError;
  globalThis.reportError = (error) => reported.push(error);
  let received = 0;
  first.addEventListener('prices', () => { throw new Error('subscriber render failed'); });
  second.addEventListener('prices', () => { received += 1; });

  try {
    NativeEventSource.instances[0].emit('prices', { sourceTimestampUs: '1', assets: [] });
  } finally {
    if (previousReportError === undefined) delete globalThis.reportError;
    else globalThis.reportError = previousReportError;
    first.close();
    second.close();
  }

  assert.equal(received, 1);
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /subscriber render failed/);
});

test('invalidating a shared EventSource closes the generation and notifies every peer', () => {
  const NativeEventSource = createFakeEventSource();
  const SharedEventSource = createSharedEventSourceConstructor(NativeEventSource);
  const first = new SharedEventSource('/api/binance/stream');
  const second = new SharedEventSource('/api/binance/stream');
  let peerErrors = 0;
  second.addEventListener('error', () => {
    peerErrors += 1;
    second.close();
  });

  first.invalidate();
  assert.equal(NativeEventSource.instances[0].closed, true);
  assert.equal(peerErrors, 1);
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);

  const replacement = new SharedEventSource('/api/binance/stream');
  assert.equal(NativeEventSource.instances.length, 2);
  replacement.close();
});

test('two live market drivers share one native stream without coupling normal teardown', async () => {
  const scheduler = createScheduler();
  const NativeEventSource = createFakeEventSource();
  const SharedEventSource = createSharedEventSourceConstructor(NativeEventSource);
  const firstRecorder = createFetchRecorder();
  const secondRecorder = createFetchRecorder();
  const options = {
    EventSourceImpl: SharedEventSource,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
  };
  const roundDriver = new LiveMarketDriver({
    ...options,
    window: 'ROUND',
    fetchImpl: firstRecorder.fetchImpl,
  });
  const contextDriver = new LiveMarketDriver({
    ...options,
    window: '4H',
    fetchImpl: secondRecorder.fetchImpl,
  });
  await Promise.all([roundDriver.refresh(), contextDriver.refresh()]);

  roundDriver.start();
  contextDriver.start();
  assert.equal(NativeEventSource.instances.length, 1);

  contextDriver.destroy();
  assert.equal(NativeEventSource.instances[0].closed, false);
  roundDriver.destroy();
  assert.equal(NativeEventSource.instances[0].closed, true);
  assert.equal(scheduler.size(), 0);
});

test('Binance kline parser aligns close prices and removes invalid rows', () => {
  const parsed = parseBinanceKlines([
    [1_700_000_000_000, '99', '101', '98', '100', '1', 1_700_000_059_999],
    [1_700_000_300_000, '100', '102', '99', 'bad'],
    [1_700_000_600_000, '100', '103', '99', '101', '1', 1_700_000_659_999],
  ], 'BTCUSDT');
  assert.deepEqual(parsed.prices, [100, 101]);
  assert.deepEqual(parsed.timestamps, [1_700_000_059, 1_700_000_659]);
  assert.throws(() => parseBinanceKlines({ code: -1 }, 'BTCUSDT'), /invalid kline history/);
});

test('Binance kline parser excludes the still-forming candle whose close is in the future', () => {
  const now = 1_780_000_000_000;
  const parsed = parseBinanceKlines([
    [now - 180_000, '99', '101', '98', '100', '1', now - 120_001],
    [now - 120_000, '100', '102', '99', '101', '1', now - 60_001],
    [now - 60_000, '101', '103', '100', '102', '1', now + 59_999],
  ], 'BTCUSDT', now);
  assert.deepEqual(parsed.prices, [100, 101]);
  assert.deepEqual(parsed.timestamps, [
    Math.floor((now - 120_001) / 1000),
    Math.floor((now - 60_001) / 1000),
  ]);
  assert.equal(parsed.candles.length, 3, 'the forming candle remains available for its canonical open');
  assert.equal(parsed.candles.at(-1).openPrice, 101);
  assert.equal(parsed.candles.at(-1).completed, false);
});

test('ROUND preserves the completed prior result through wagering and resets exactly at battle start', () => {
  const epochEnd = Date.UTC(2026, 7, 19, 15);
  const battleStart = epochEnd - (20 * MINUTE_MS);
  const candles = roundCandles({
    fromMs: epochEnd - (80 * MINUTE_MS),
    throughMs: battleStart,
    priceAt: (index, openTimeMs) => openTimeMs === battleStart ? 200 : 100 + index,
  });
  const before = calculateRoundMetrics(candles, 199, battleStart - 1);
  const reset = calculateRoundMetrics(candles, 202, battleStart);

  assert.equal(before.round.epochId, 'UTC-20260819-1400');
  assert.equal(before.round.operationalPhase, 'WAGERING');
  assert.equal(before.round.evidenceStatus, ROUND_EVIDENCE_STATUS.COMPLETED_CANDLE_PROVISIONAL);
  assert.notEqual(before.returnPct, 0);
  assert.equal(reset.round.epochId, 'UTC-20260819-1500');
  assert.equal(reset.round.phase, 'BATTLE_LIVE');
  assert.equal(reset.round.baselineOpenTimeMs, battleStart);
  assert.equal(reset.round.baselinePrice, 200);
  assert.equal(reset.round.evidenceStatus, ROUND_EVIDENCE_STATUS.LIVE_ESTIMATE);
  assert.ok(Math.abs(reset.returnPct - 1) < 1e-10);
});

test('ROUND reload recovers the exact E-20 open and E-1 completed close without memory', () => {
  const epochEnd = Date.UTC(2026, 7, 19, 15);
  const battleStart = epochEnd - (20 * MINUTE_MS);
  const endOpen = epochEnd - MINUTE_MS;
  const candles = roundCandles({
    fromMs: battleStart,
    throughMs: endOpen,
    priceAt: (index, openTimeMs) => openTimeMs === battleStart ? 250 : 250 + index,
  });
  const firstLoad = calculateRoundMetrics(candles, 999, epochEnd + 1);
  const reloaded = calculateRoundMetrics([...candles], 1, epochEnd + 119_999);

  assert.equal(firstLoad.round.evidenceStatus, ROUND_EVIDENCE_STATUS.COMPLETED_CANDLE_PROVISIONAL);
  assert.equal(firstLoad.round.baselineOpenTimeMs, battleStart);
  assert.equal(firstLoad.round.endpointOpenTimeMs, endOpen);
  assert.equal(firstLoad.round.endpointPrice, candles.at(-1).closePrice);
  assert.equal(firstLoad.displayPrice, candles.at(-1).closePrice, 'post-end display freezes to the canonical close');
  assert.equal(firstLoad.returnPct, reloaded.returnPct);
  assert.deepEqual(firstLoad.round, reloaded.round);
});

test('ROUND evidence fails visibly when an exact boundary candle is unavailable', () => {
  const epochEnd = Date.UTC(2026, 7, 19, 15);
  const battleStart = epochEnd - (20 * MINUTE_MS);
  const missingBaseline = roundCandles({
    fromMs: battleStart + MINUTE_MS,
    throughMs: epochEnd - MINUTE_MS,
  });
  const missing = calculateRoundMetrics(missingBaseline, 120, battleStart + MINUTE_MS);
  assert.equal(missing.round.evidenceStatus, ROUND_EVIDENCE_STATUS.BASELINE_UNAVAILABLE);
  assert.equal(missing.round.baselinePrice, null);
  assert.equal(missing.returnPct, 0);

  const incompleteEnd = roundCandles({
    fromMs: battleStart,
    throughMs: epochEnd - MINUTE_MS,
    incompleteOpenMs: epochEnd - MINUTE_MS,
  });
  const awaiting = calculateRoundMetrics(incompleteEnd, 120, epochEnd);
  assert.equal(awaiting.round.evidenceStatus, ROUND_EVIDENCE_STATUS.AWAITING_END_CANDLE);
  assert.equal(awaiting.round.endpointPrice, null);
  assert.equal(awaiting.round.provisional, true);
});

test('Binance stream parser preserves exact trade freshness and rejects empty packets', () => {
  const sourceTimestampUs = '1785606908600000';
  const parsed = parseBinanceStreamPayload({
    sourceTimestampUs,
    channel: 'ticker.price',
    transport: 'binance-ws-api-ticker-price',
    transportMode: 'fallback',
    pollIntervalMs: 1000,
    assets: [
      { id: 'btc', price: '65000.535', feedUpdateTimestampUs: '1785606908550000' },
      { id: 'eth', price: 3500.64, feedUpdateTimestampUs: sourceTimestampUs },
    ],
  });
  assert.equal(parsed.sourceTimestampUs, sourceTimestampUs);
  assert.equal(parsed.assets[0].updatedAt, 1_785_606_908_550);
  assert.equal(parsed.assets[0].marketSession, 'open');
  assert.equal(parsed.assets[0].carriedForward, false);
  assert.equal(parsed.channel, 'ticker.price');
  assert.equal(parsed.transport, 'binance-ws-api-ticker-price');
  assert.equal(parsed.transportMode, 'fallback');
  assert.equal(parsed.pollIntervalMs, 1000);
  assert.throws(() => parseBinanceStreamPayload({ sourceTimestampUs, assets: [] }), /no valid assets/);
});

test('the live basket is fixed to the five Binance USDT feeds', () => {
  const feeds = resolveBinanceFeeds();
  assert.deepEqual(Object.keys(feeds).sort(), ['bnb', 'btc', 'eth', 'sol', 'xrp']);
  assert.deepEqual(STATIC_BINANCE_SYMBOLS, {
    btc: 'BTCUSDT', eth: 'ETHUSDT', bnb: 'BNBUSDT', sol: 'SOLUSDT', xrp: 'XRPUSDT',
  });
  assert.equal(feeds.btc.symbol, 'BTCUSDT');
  assert.equal(Object.isFrozen(feeds), true);
});

test('live driver requests allow-listed Binance klines and produces an exact-100 market frame', async () => {
  const recorder = createFetchRecorder();
  const frames = [];
  const now = () => Date.UTC(2026, 7, 1, 12);
  const driver = new LiveMarketDriver({
    fetchImpl: recorder.fetchImpl,
    now,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });
  const frame = await driver.refresh();
  driver.destroy();

  assert.deepEqual(recorder.requests.map((request) => request.pathname), Array(5).fill('/api/binance/klines'));
  assert.deepEqual(
    recorder.requests.map((request) => request.searchParams.get('symbol')).sort(),
    ['BNBUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  );
  assert.ok(recorder.requests.every((request) => request.searchParams.get('interval') === '5m'));
  assert.equal(frame.assets.length, 5);
  assert.equal(frame.totalDominancePct, 100);
  assert.equal(frame.market.source, 'binance-spot');
  assert.equal(frame.market.quality, 'exchange-history');
  assert.equal(frames.length, 1);
});

test('ROUND driver requests one-minute history and exposes exact provisional boundary metadata', async () => {
  const epochEnd = Date.UTC(2026, 7, 19, 15);
  const now = epochEnd - (15 * MINUTE_MS) + 30_000;
  const requests = [];
  const driver = new LiveMarketDriver({
    window: 'ROUND',
    fetchImpl: async (url) => {
      const request = new URL(String(url), 'http://localhost');
      requests.push(request);
      const symbol = request.searchParams.get('symbol');
      return { ok: true, json: async () => oneMinuteKlines(now, 100 + symbol.length) };
    },
    EventSourceImpl: null,
    now: () => now,
    autoStart: false,
  });
  const frame = await driver.refresh();
  driver.destroy();

  assert.ok(requests.every((request) => request.searchParams.get('interval') === '1m'));
  assert.ok(requests.every((request) => request.searchParams.get('limit') === '180'));
  assert.equal(frame.window, 'ROUND');
  assert.equal(frame.epoch.displayEpoch.epochId, 'UTC-20260819-1500');
  assert.equal(frame.epoch.displayPhase, 'BATTLE_LIVE');
  assert.ok(frame.assets.every((asset) => asset.round.epochId === 'UTC-20260819-1500'));
  assert.ok(frame.assets.every((asset) => asset.round.baselineOpenTimeMs === epochEnd - (20 * MINUTE_MS)));
  assert.ok(frame.assets.every((asset) => asset.round.evidenceStatus === ROUND_EVIDENCE_STATUS.LIVE_ESTIMATE));
  assert.ok(frame.assets.every((asset) => asset.round.provisional === true));
  assert.equal(frame.totalDominancePct, 100);
});

test('live driver metrics use only completed Binance candles', async () => {
  const now = 1_780_000_000_000;
  const frames = [];
  const driver = new LiveMarketDriver({
    fetchImpl: async (url) => {
      const symbol = new URL(String(url), 'http://localhost').searchParams.get('symbol');
      return { ok: true, json: async () => klines(100 + symbol.length, now) };
    },
    EventSourceImpl: null,
    now: () => now,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });

  const frame = await driver.refresh();
  const btc = frame.assets.find((asset) => asset.id === 'btc');
  // The fixture's last candle closes five minutes after `now`; its close price
  // must not become the last historical metric observation.
  assert.equal(btc.price, 100 + 'BTCUSDT'.length + (238 * 0.01));
  assert.ok(frame.assets.every((asset) => asset.updatedAt <= now));
  assert.equal(frames.length, 1);
  driver.destroy();
});

test('hybrid driver seeds from REST klines, coalesces Binance SSE prices, and retains the latest per-asset trade', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const recorder = createFetchRecorder();
  const frames = [];
  const driver = new LiveMarketDriver({
    fetchImpl: recorder.fetchImpl,
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });

  const historyFrame = await driver.refresh();
  driver.start();
  assert.equal(historyFrame.market.transport, 'history');
  assert.equal(historyFrame.market.quality, 'exchange-history');
  assert.equal(EventSourceImpl.instances[0].url, '/api/binance/stream');

  const stream = EventSourceImpl.instances[0];
  stream.emit('open');
  const firstSourceMs = scheduler.now();
  stream.emit('prices', streamPayload(firstSourceMs, 1));
  stream.emit('prices', streamPayload(firstSourceMs + 200, 2));
  assert.equal(frames.length, 1, 'bursty packets wait for one coalesced render');
  await scheduler.runDelay(0);

  const liveFrame = frames.at(-1);
  const btc = liveFrame.assets.find((asset) => asset.id === 'btc');
  assert.equal(frames.length, 2);
  assert.equal(btc.price, 122);
  assert.equal(btc.freshness, 'live');
  assert.equal(liveFrame.market.source, 'binance-spot');
  assert.equal(liveFrame.market.quality, 'exchange-stream');
  assert.equal(liveFrame.market.transport, 'sse');
  assert.equal(liveFrame.market.streamConnected, true);
  assert.equal(liveFrame.market.channel, STREAM_CHANNEL);
  assert.equal(liveFrame.market.displayCadenceMs, STREAM_DISPLAY_CADENCE_MS);
  assert.equal(STREAM_CHANNEL, 'aggTrade');
  assert.equal(STREAM_DISPLAY_CADENCE_MS, 200);
  assert.equal(liveFrame.totalDominancePct, 100);

  const olderBtc = String((BigInt(firstSourceMs) - 1n) * 1000n);
  stream.emit('prices', streamPayload(firstSourceMs + 400, 3, {
    btc: { feedUpdateTimestampUs: olderBtc },
  }));
  await scheduler.runDelay(200);
  assert.equal(frames.at(-1).assets.find((asset) => asset.id === 'btc').price, 122,
    'a delayed Binance trade cannot overwrite a newer per-asset quote');

  driver.destroy();
  assert.equal(stream.closed, true);
  assert.equal(scheduler.size(), 0);
});

test('freshness watchdog marks a silent stream stale and reconnects instead of leaving a frozen LIVE frame', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const recorder = createFetchRecorder();
  const frames = [];
  const driver = new LiveMarketDriver({
    fetchImpl: recorder.fetchImpl,
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    streamStaleAfterMs: 1_000,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });

  await driver.refresh();
  driver.start();
  const stream = EventSourceImpl.instances[0];
  stream.emit('open');
  const initial = streamPayload(scheduler.now());
  const initialTimestampUs = String(BigInt(scheduler.now()) * 1000n);
  for (const quote of initial.assets) quote.feedUpdateTimestampUs = initialTimestampUs;
  stream.emit('prices', initial);
  await scheduler.runDelay(0);
  assert.equal(frames.at(-1).market.status, 'open');

  await scheduler.runDelay(1_000);
  const staleFrame = frames.find((frame) => frame.market.status === 'stream-stale');
  assert.ok(staleFrame, 'the watchdog emits an explicit stale frame');
  assert.equal(staleFrame.market.streamConnected, false);
  assert.deepEqual([...staleFrame.market.staleAssetIds].sort(), [...STREAM_ASSET_IDS].sort());
  assert.equal(stream.closed, true, 'the stale EventSource is closed before retrying');

  await scheduler.runDelay(1_000);
  assert.equal(EventSourceImpl.instances.length, 2, 'the client creates a fresh SSE connection after silence');
  driver.destroy();
});

test('a port-443 ticker fallback keeps its degraded source metadata in the live frame', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const recorder = createFetchRecorder();
  const frames = [];
  const driver = new LiveMarketDriver({
    fetchImpl: recorder.fetchImpl,
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });

  await driver.refresh();
  driver.start();
  const stream = EventSourceImpl.instances[0];
  stream.emit('open');
  const fallback = streamPayload(scheduler.now());
  Object.assign(fallback, {
    channel: 'ticker.price',
    transport: 'binance-ws-api-ticker-price',
    transportMode: 'fallback',
    pollIntervalMs: 1_000,
  });
  stream.emit('prices', fallback);
  await scheduler.runDelay(0);

  const frame = frames.at(-1);
  assert.equal(frame.market.quality, 'exchange-stream-fallback');
  assert.equal(frame.market.transport, 'binance-ws-api-ticker-price');
  assert.equal(frame.market.channel, 'ticker.price');
  assert.equal(frame.market.displayCadenceMs, 1_000);
  driver.destroy();
});

test('a REST ticker fallback keeps its two-second degraded source metadata in the live frame', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const recorder = createFetchRecorder();
  const frames = [];
  const driver = new LiveMarketDriver({
    fetchImpl: recorder.fetchImpl,
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });

  await driver.refresh();
  driver.start();
  const stream = EventSourceImpl.instances[0];
  stream.emit('open');
  const fallback = streamPayload(scheduler.now());
  Object.assign(fallback, {
    channel: 'ticker.price',
    transport: 'binance-rest-ticker-price',
    transportMode: 'fallback',
    pollIntervalMs: 2_000,
  });
  stream.emit('prices', fallback);
  await scheduler.runDelay(0);

  const frame = frames.at(-1);
  assert.equal(frame.market.quality, 'exchange-stream-fallback');
  assert.equal(frame.market.transport, 'binance-rest-ticker-price');
  assert.equal(frame.market.channel, 'ticker.price');
  assert.equal(frame.market.displayCadenceMs, 2_000);
  driver.destroy();
});

test('freshness watchdog reconnects when only one Binance basket member stops advancing', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const recorder = createFetchRecorder();
  const frames = [];
  const driver = new LiveMarketDriver({
    fetchImpl: recorder.fetchImpl,
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    streamStaleAfterMs: 1_000,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
  });

  await driver.refresh();
  driver.start();
  const stream = EventSourceImpl.instances[0];
  stream.emit('open');
  const startMs = scheduler.now();
  const initial = streamPayload(startMs);
  const initialTimestampUs = String(BigInt(startMs) * 1000n);
  for (const quote of initial.assets) quote.feedUpdateTimestampUs = initialTimestampUs;
  stream.emit('prices', initial);
  await scheduler.runDelay(0);

  scheduler.advance(750);
  const btcOnlyAdvance = streamPayload(scheduler.now(), 1);
  for (const quote of btcOnlyAdvance.assets) {
    if (quote.id !== 'btc') quote.feedUpdateTimestampUs = initialTimestampUs;
  }
  stream.emit('prices', btcOnlyAdvance);
  await scheduler.runDelay(0);
  await scheduler.runDelay(250);

  const staleFrame = frames.find((frame) => frame.market.status === 'stream-stale');
  assert.ok(staleFrame);
  assert.deepEqual([...staleFrame.market.staleAssetIds].sort(), ['bnb', 'eth', 'sol', 'xrp']);
  assert.equal(staleFrame.assets.find((asset) => asset.id === 'btc').stale, false);
  assert.equal(stream.closed, true);
  driver.destroy();
});

test('a REST history outage can bootstrap a truthful live frame from all five Binance trades', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const frames = [];
  const errors = [];
  const driver = new LiveMarketDriver({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'history unavailable' }) }),
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });

  driver.start();
  assert.equal(EventSourceImpl.instances.length, 1, 'SSE starts before history finishes');
  assert.equal(await driver.refresh(), null);
  assert.equal(errors.length, 0, 'the recoverable history outage must not force demo mode');

  const stream = EventSourceImpl.instances[0];
  stream.emit('open');
  const sourceMs = scheduler.now();
  const firstFour = streamPayload(sourceMs);
  firstFour.assets = firstFour.assets.slice(0, 4);
  stream.emit('prices', firstFour);
  await scheduler.runDelay(0);
  assert.equal(frames.length, 0, 'a partial basket cannot create a comparative market frame');

  const xrpOnly = streamPayload(sourceMs + 100);
  xrpOnly.assets = xrpOnly.assets.slice(4);
  stream.emit('prices', xrpOnly);
  await scheduler.runDelay(0);

  const frame = frames.at(-1);
  assert.equal(frames.length, 1);
  assert.equal(frame.market.transport, 'sse');
  assert.equal(frame.market.status, 'streaming-no-history');
  assert.equal(frame.market.quality, 'exchange-stream-bootstrap');
  assert.equal(frame.market.streamConnected, true);
  assert.ok(frame.assets.every((asset) => asset.freshness === 'live-bootstrap'));
  assert.ok(frame.assets.every((asset) => (
    asset.returnPct === 0 && asset.momentumPct === 0 && asset.volatilityPct === 0
  )), 'stream-only prices must not masquerade as 1H/4H/1D/1W metric history');
  assert.deepEqual(driver.seriesByAsset.get('btc'), [120], 'only received trades seed the pre-history series');
  assert.equal(driver.historySeriesByAsset.size, 0, 'the fallback never invents a candle backfill');
  assert.equal(errors.length, 0);

  driver.destroy();
});

test('an incomplete stream bootstrap falls back only after the bounded timeout', async () => {
  const scheduler = createScheduler();
  const EventSourceImpl = createFakeEventSource();
  const errors = [];
  const driver = new LiveMarketDriver({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'history unavailable' }) }),
    EventSourceImpl,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
    onError: (error) => errors.push(error),
  });

  driver.start();
  await driver.refresh();
  assert.equal(errors.length, 0);
  await scheduler.runDelay(STREAM_BOOTSTRAP_TIMEOUT_MS);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /did not deliver every required asset within 15 seconds/);
  assert.equal(EventSourceImpl.instances[0].closed, true);
  driver.destroy();
});

test('history recovery cadence follows candle intervals, not the former eleven-minute rule', () => {
  assert.equal(WINDOW_QUERIES.ROUND.refreshMs, 60_000);
  assert.equal(WINDOW_QUERIES['1H'].refreshMs, 60_000);
  assert.equal(WINDOW_QUERIES['4H'].refreshMs, 5 * 60_000);
  assert.equal(WINDOW_QUERIES['1D'].refreshMs, 15 * 60_000);
  assert.equal(WINDOW_QUERIES['1W'].refreshMs, 60 * 60_000);
  assert.ok(Object.values(WINDOW_QUERIES).every((query) => query.refreshMs !== 11 * 60_000));
});

test('ROUND recovery aligns to the next minute boundary plus publication settle time', async () => {
  const scheduler = createScheduler(Date.UTC(2026, 7, 1, 12, 34, 25));
  const recorder = createFetchRecorder();
  const driver = new LiveMarketDriver({
    window: 'ROUND',
    fetchImpl: recorder.fetchImpl,
    EventSourceImpl: null,
    setTimeoutImpl: scheduler.setTimeoutImpl,
    clearTimeoutImpl: scheduler.clearTimeoutImpl,
    now: scheduler.now,
    autoStart: false,
  });
  await driver.refresh();
  driver.start();
  assert.ok(scheduler.delays().includes(36_000));
  driver.destroy();
});

test('an initial Binance history failure invokes onError when no stream fallback is running', async () => {
  const errors = [];
  const driver = new LiveMarketDriver({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }),
    EventSourceImpl: null,
    autoStart: false,
    onError: (error) => errors.push(error),
  });
  assert.equal(await driver.refresh(), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Binance request failed with HTTP 503/);
  driver.destroy();
});
