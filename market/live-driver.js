import { MARKET_ASSETS } from './assets.js';
import { calculateMarketMetrics } from './dominance.js';
import { EPOCH_PHASE, MINUTE_MS, arenaEpochState } from './epoch-schedule.js';
import { createMarketFrame, deriveMarketEvents } from './model.js';

// Binance Spot symbols are intentionally fixed rather than discovered at
// runtime. That keeps the browser/server allow-lists and the circular arena
// basket identical, and avoids turning either proxy into an arbitrary market
// data relay.
const STATIC_BINANCE_SYMBOLS = Object.freeze({
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  bnb: 'BNBUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
});

// The comparison controls choose the amount of market context. They do not
// control the real-time trade stream; that is always coalesced to 200 ms for
// rendering after a complete history backfill is available.
const WINDOW_QUERIES = Object.freeze({
  ROUND: {
    interval: '1m', pointLimit: 180, returnLookback: 20, momentumLookback: 5, volatilityLookback: 20, refreshMs: 60_000,
  },
  '1H': {
    interval: '1m', pointLimit: 180, returnLookback: 60, momentumLookback: 20, volatilityLookback: 60, refreshMs: 60_000,
  },
  '4H': {
    interval: '5m', pointLimit: 240, returnLookback: 48, momentumLookback: 12, volatilityLookback: 36, refreshMs: 5 * 60_000,
  },
  '1D': {
    interval: '15m', pointLimit: 240, returnLookback: 96, momentumLookback: 24, volatilityLookback: 48, refreshMs: 15 * 60_000,
  },
  '1W': {
    interval: '1h', pointLimit: 240, returnLookback: 168, momentumLookback: 42, volatilityLookback: 84, refreshMs: 60 * 60_000,
  },
});

const STREAM_CHANNEL = 'aggTrade';
const STREAM_DISPLAY_CADENCE_MS = 200;
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 30_000;
// REST history makes the selected comparison window immediately useful, but
// it is not required to show real Binance trades. Give the SSE hub a bounded
// chance to deliver one genuine quote for every asset before treating an
// initial history outage as terminal.
const STREAM_BOOTSTRAP_TIMEOUT_MS = 15_000;
const HISTORY_STALE_AFTER_MS = 36 * 60 * 60 * 1000;
const STREAM_STALE_AFTER_MS = 15_000;
// Let Binance finish publishing the just-opened/just-closed one-minute row,
// while still aligning ROUND recovery to wall-clock candle boundaries.
const ROUND_HISTORY_SETTLE_MS = 1_000;
const NEUTRAL_MARKET_METRICS = Object.freeze({
  returnPct: 0,
  momentumPct: 0,
  volatilityPct: 0,
});

export const ROUND_EVIDENCE_STATUS = Object.freeze({
  AWAITING_BATTLE: 'AWAITING_BATTLE',
  BASELINE_UNAVAILABLE: 'BASELINE_UNAVAILABLE',
  LIVE_ESTIMATE: 'LIVE_ESTIMATE',
  AWAITING_END_CANDLE: 'AWAITING_END_CANDLE',
  COMPLETED_CANDLE_PROVISIONAL: 'COMPLETED_CANDLE_PROVISIONAL',
});

/** Resolve the five public Binance Spot feeds used by the arena. */
export function resolveBinanceFeeds() {
  return Object.freeze(Object.fromEntries(
    Object.entries(STATIC_BINANCE_SYMBOLS).map(([assetId, symbol]) => [assetId, Object.freeze({ assetId, symbol })]),
  ));
}

/** Parse completed Binance REST klines into the source-neutral history shape. */
export function parseBinanceKlines(payload, symbol = 'the requested symbol', now = Date.now()) {
  if (!Array.isArray(payload)) throw new TypeError(`Binance returned invalid kline history for ${symbol}.`);
  const receivedAt = Number(now);
  if (!Number.isFinite(receivedAt) || receivedAt < 0) {
    throw new TypeError('A non-negative receipt timestamp is required for Binance kline history.');
  }
  const points = [];
  const candles = [];
  for (const row of payload) {
    if (!Array.isArray(row)) continue;
    const openTimestamp = Number(row[0]);
    // Binance kline rows include the candle close at index 6. The close price
    // at index 4 belongs to that close timestamp, not the candle open. Keep a
    // conservative open-time fallback for shortened/legacy rows.
    const closeTimestamp = Number(row[6]);
    const timestamp = Number.isFinite(closeTimestamp) && closeTimestamp >= openTimestamp
      ? closeTimestamp
      : openTimestamp;
    const openPrice = Number(row[1]);
    const price = Number(row[4]);
    if (Number.isFinite(openTimestamp) && openTimestamp > 0
      && Number.isFinite(timestamp) && timestamp >= openTimestamp
      && Number.isFinite(openPrice) && openPrice > 0
      && Number.isFinite(price) && price > 0) {
      candles.push(Object.freeze({
        openTimeMs: Math.floor(openTimestamp),
        closeTimeMs: Math.floor(timestamp),
        openPrice,
        closePrice: price,
        completed: timestamp <= receivedAt,
      }));
    }
    // Binance includes the candle currently being formed. Its close timestamp
    // is ahead of the response receipt time, so its close price cannot yet be
    // used as a completed historical observation or shown as a candle close.
    if (timestamp > receivedAt) continue;
    if (Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(price) && price > 0) {
      points.push({ timestamp: Math.floor(timestamp / 1000), price });
    }
  }
  if (points.length < 2) throw new Error(`Binance returned too little history for ${symbol}.`);
  return {
    prices: points.map((point) => point.price),
    timestamps: points.map((point) => point.timestamp),
    candles: Object.freeze(candles),
  };
}

function supportMetrics(candles) {
  const prices = candles.filter((candle) => candle.completed).map((candle) => candle.closePrice);
  if (prices.length < 2) return NEUTRAL_MARKET_METRICS;
  return calculateMarketMetrics(prices, {
    returnLookback: Math.min(20, prices.length - 1),
    momentumLookback: Math.min(5, prices.length - 1),
    volatilityLookback: Math.min(20, prices.length - 1),
  });
}

/** Build a reload-safe ROUND observation from exact Binance 1m boundaries. */
export function calculateRoundMetrics(candles, livePrice, atMs = Date.now()) {
  if (!Array.isArray(candles)) throw new TypeError('ROUND candles must be an array');
  const now = Number(atMs);
  const price = Number(livePrice);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('ROUND timestamp must be an epoch-millisecond integer');
  if (!Number.isFinite(price) || price <= 0) throw new TypeError('ROUND live price must be positive');
  const state = arenaEpochState(now);
  const epoch = state.displayEpoch;
  const phase = state.displayPhase;
  const start = candles.find((candle) => candle.openTimeMs === epoch.battleStartMs);
  const endOpenMs = epoch.battleEndMs - MINUTE_MS;
  const end = candles.find((candle) => candle.openTimeMs === endOpenMs && candle.completed);
  const completedBeforeEnd = candles
    .filter((candle) => candle.completed && candle.openTimeMs >= epoch.battleStartMs && candle.openTimeMs < epoch.battleEndMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const motion = supportMetrics(completedBeforeEnd.length ? completedBeforeEnd : candles);
  const beforeBattle = phase === EPOCH_PHASE.UPCOMING
    || phase === EPOCH_PHASE.BUFFER
    || phase === EPOCH_PHASE.WAGERING;
  let status = ROUND_EVIDENCE_STATUS.AWAITING_BATTLE;
  let displayPrice = price;
  let returnPct = 0;
  let endpointPrice = null;

  if (!beforeBattle && !start) {
    status = ROUND_EVIDENCE_STATUS.BASELINE_UNAVAILABLE;
  } else if (phase === EPOCH_PHASE.BATTLE_LIVE) {
    status = ROUND_EVIDENCE_STATUS.LIVE_ESTIMATE;
    returnPct = ((price / start.openPrice) - 1) * 100;
  } else if (!beforeBattle && end) {
    status = ROUND_EVIDENCE_STATUS.COMPLETED_CANDLE_PROVISIONAL;
    endpointPrice = end.closePrice;
    displayPrice = endpointPrice;
    returnPct = ((endpointPrice / start.openPrice) - 1) * 100;
  } else if (!beforeBattle) {
    status = ROUND_EVIDENCE_STATUS.AWAITING_END_CANDLE;
    const lastCompleted = completedBeforeEnd.at(-1);
    if (lastCompleted) {
      displayPrice = lastCompleted.closePrice;
      returnPct = ((displayPrice / start.openPrice) - 1) * 100;
    }
  }

  const scoredSeries = start
    ? [start.openPrice, ...completedBeforeEnd.map((candle) => candle.closePrice)]
    : [price];
  if (phase === EPOCH_PHASE.BATTLE_LIVE && scoredSeries.at(-1) !== price) scoredSeries.push(price);
  return Object.freeze({
    returnPct,
    momentumPct: motion.momentumPct,
    volatilityPct: motion.volatilityPct,
    displayPrice,
    series: Object.freeze(scoredSeries),
    round: Object.freeze({
      epochId: epoch.epochId,
      phase,
      operationalPhase: state.operationalPhase,
      battleStartMs: epoch.battleStartMs,
      battleEndMs: epoch.battleEndMs,
      baselineOpenTimeMs: start?.openTimeMs ?? null,
      baselinePrice: start?.openPrice ?? null,
      endpointOpenTimeMs: end?.openTimeMs ?? null,
      endpointPrice,
      evidenceStatus: status,
      provisional: true,
    }),
  });
}

async function fetchJson(url, signal, fetchImpl) {
  const response = await fetchImpl(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error || payload?.message || payload?.msg || '';
    } catch {
      // The status code remains useful when a proxy sends non-JSON.
    }
    throw new Error(`Binance request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  return response.json();
}

async function fetchAsset(asset, feed, windowName, basePath, signal, fetchImpl, now) {
  if (!feed) throw new Error(`No Binance feed is configured for ${asset.id}.`);
  const query = WINDOW_QUERIES[windowName] || WINDOW_QUERIES['4H'];
  const params = new URLSearchParams({
    symbol: feed.symbol,
    interval: query.interval,
    limit: String(query.pointLimit),
  });
  const history = parseBinanceKlines(
    await fetchJson(`${basePath}/klines?${params}`, signal, fetchImpl),
    feed.symbol,
    now,
  );
  const prices = history.prices.slice(-query.pointLimit);
  const timestamps = history.timestamps.slice(-query.pointLimit);
  const minimumPoints = Math.max(
    query.returnLookback,
    query.momentumLookback,
    query.volatilityLookback,
  ) + 1;
  if (prices.length < minimumPoints || timestamps.length < minimumPoints) {
    throw new Error(`Binance returned too little completed candle history for ${feed.symbol}.`);
  }
  const updatedAt = timestamps.at(-1) * 1000;
  const roundMetrics = windowName === 'ROUND'
    ? calculateRoundMetrics(history.candles, prices.at(-1), now)
    : null;
  const metrics = roundMetrics || calculateMarketMetrics(prices, query);
  const displayPrices = roundMetrics?.series || prices;
  return {
    id: asset.id,
    price: roundMetrics?.displayPrice || prices.at(-1),
    series: displayPrices,
    timestamps,
    candles: history.candles,
    ...metrics,
    updatedAt,
    stale: now - updatedAt > HISTORY_STALE_AFTER_MS,
    marketSession: 'open',
    carriedForward: false,
    freshness: now - updatedAt > HISTORY_STALE_AFTER_MS ? 'stale' : 'history',
    sourceTimestampUs: String(BigInt(updatedAt) * 1000n),
    feedUpdateTimestampUs: String(BigInt(updatedAt) * 1000n),
  };
}

function parseTimestampUs(value, label) {
  try {
    if (typeof value === 'bigint') {
      if (value < 0n) throw new RangeError();
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError();
      return BigInt(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    // A malformed packet must not tear down an otherwise healthy stream.
  }
  throw new TypeError(`${label} must be a non-negative microsecond timestamp`);
}

function timestampUsToMs(value) {
  return Number(value / 1000n);
}

/** Validate and normalize one named `prices` SSE payload from the server hub. */
export function parseBinanceStreamPayload(payload) {
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.assets)) {
    throw new TypeError('Binance stream payload must contain an assets array');
  }
  const sourceTimestamp = parseTimestampUs(payload.sourceTimestampUs, 'sourceTimestampUs');
  const channel = typeof payload.channel === 'string' && payload.channel.trim()
    ? payload.channel.trim().slice(0, 96)
    : STREAM_CHANNEL;
  const transport = typeof payload.transport === 'string' && payload.transport.trim()
    ? payload.transport.trim().slice(0, 128)
    : 'sse';
  const transportMode = typeof payload.transportMode === 'string' && payload.transportMode.trim()
    ? payload.transportMode.trim().slice(0, 32)
    : 'primary';
  const pollInterval = Number(payload.pollIntervalMs);
  const pollIntervalMs = Number.isFinite(pollInterval) && pollInterval > 0
    ? Math.floor(pollInterval)
    : null;
  const assets = [];
  for (const candidate of payload.assets) {
    if (!candidate || typeof candidate.id !== 'string') continue;
    const price = Number(candidate.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const feedTimestamp = candidate.feedUpdateTimestampUs == null
      ? sourceTimestamp
      : parseTimestampUs(candidate.feedUpdateTimestampUs, `${candidate.id}.feedUpdateTimestampUs`);
    assets.push(Object.freeze({
      id: candidate.id,
      price,
      sourceTimestampUs: sourceTimestamp.toString(),
      feedUpdateTimestampUs: feedTimestamp.toString(),
      updatedAt: timestampUsToMs(feedTimestamp),
      marketSession: 'open',
      carriedForward: candidate.carriedForward === true,
      carriedForwardProvided: typeof candidate.carriedForward === 'boolean',
    }));
  }
  if (!assets.length) throw new Error('Binance stream payload contained no valid assets');
  return Object.freeze({
    sourceTimestamp,
    sourceTimestampUs: sourceTimestamp.toString(),
    sourceTimestampMs: timestampUsToMs(sourceTimestamp),
    channel,
    transport,
    transportMode,
    pollIntervalMs,
    assets: Object.freeze(assets),
  });
}

export class LiveMarketDriver {
  constructor({
    onFrame = () => {},
    onEvent = () => {},
    onError = () => {},
    window = '4H',
    basePath = '/api/binance',
    fetchImpl = globalThis.fetch,
    EventSourceImpl = globalThis.EventSource,
    // Browser timer functions require the Window receiver. Wrapping them keeps
    // injected test timers simple while avoiding an illegal invocation later.
    setTimeoutImpl = (...args) => globalThis.setTimeout(...args),
    clearTimeoutImpl = (...args) => globalThis.clearTimeout(...args),
    now = () => Date.now(),
    minStreamEmitMs = STREAM_DISPLAY_CADENCE_MS,
    reconnectBaseMs = STREAM_RECONNECT_BASE_MS,
    reconnectMaxMs = STREAM_RECONNECT_MAX_MS,
    streamBootstrapTimeoutMs = STREAM_BOOTSTRAP_TIMEOUT_MS,
    streamStaleAfterMs = STREAM_STALE_AFTER_MS,
    autoStart = true,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
      throw new TypeError('Timer implementations are required.');
    }
    this.onFrame = onFrame;
    this.onEvent = onEvent;
    this.onError = onError;
    this.window = WINDOW_QUERIES[window] ? window : '4H';
    this.historyRefreshMs = WINDOW_QUERIES[this.window].refreshMs;
    this.basePath = basePath.replace(/\/$/, '');
    this.streamPath = `${this.basePath}/stream`;
    this.fetchImpl = fetchImpl;
    this.EventSourceImpl = EventSourceImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.minStreamEmitMs = Math.max(1, Number(minStreamEmitMs) || STREAM_DISPLAY_CADENCE_MS);
    this.reconnectBaseMs = Math.max(1, Number(reconnectBaseMs) || STREAM_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, Number(reconnectMaxMs) || STREAM_RECONNECT_MAX_MS);
    this.streamBootstrapTimeoutMs = Math.max(
      1,
      Number(streamBootstrapTimeoutMs) || STREAM_BOOTSTRAP_TIMEOUT_MS,
    );
    this.streamStaleAfterMs = Math.max(1, Number(streamStaleAfterMs) || STREAM_STALE_AFTER_MS);
    this.previousFrame = null;
    this.seriesByAsset = new Map();
    this.historySeriesByAsset = new Map();
    this.historyTimestampsByAsset = new Map();
    this.historyCandlesByAsset = new Map();
    this.historyObservationsByAsset = new Map();
    this.streamBootstrapSeriesByAsset = new Map();
    this.streamBootstrapTimestampUsByAsset = new Map();
    this.latestStreamByAsset = new Map();
    this.feedConfig = resolveBinanceFeeds();
    this.sequence = 0;
    this.controller = null;
    this.refreshPromise = null;
    this.historyTimer = null;
    this.reconnectTimer = null;
    this.streamFlushTimer = null;
    this.streamBootstrapTimer = null;
    this.streamFreshnessTimer = null;
    this.eventSource = null;
    this.eventSourceHandlers = null;
    this.pendingStream = false;
    this.latestSourceTimestamp = null;
    this.streamMetadata = Object.freeze({
      channel: STREAM_CHANNEL,
      transport: 'sse',
      transportMode: 'primary',
      pollIntervalMs: null,
    });
    this.lastStreamEmitAt = null;
    this.reconnectAttempt = 0;
    this.initialized = false;
    this.historyAvailable = false;
    this.historyUnavailable = false;
    this.streamBootstrapActive = false;
    this.initialHistoryError = null;
    this.running = false;
    this.paused = false;
    this.destroyed = false;
    this.streamConnected = false;
    this.streamOpenedAt = null;
    this.lastHistoryRefreshAt = 0;
    this.startedAt = this.now();
    if (autoStart) this.start();
  }

  _commitFrame(observations, {
    timestamp,
    status,
    quality,
    transport,
    streamConnected,
    sourceTimestampUs,
    channel = null,
    displayCadenceMs,
  }) {
    const frame = createMarketFrame({
      timestamp,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      sequence: this.sequence,
      window: this.window,
      source: 'binance-spot',
      status,
      quality,
      transport,
      streamConnected,
      sourceTimestampUs,
      channel,
      displayCadenceMs,
      observations,
      previousFrame: this.previousFrame,
      epochState: this.window === 'ROUND' ? arenaEpochState(this.now()) : null,
    });
    // A stream-only bootstrap has no candle window behind its values. Do not
    // manufacture breakouts or leader changes from the neutral placeholder
    // metrics used until a real history backfill is present.
    if (!['streaming-no-history', 'stream-stale'].includes(status)) {
      for (const event of deriveMarketEvents(this.previousFrame, frame)) this.onEvent(event);
    }
    this.previousFrame = frame;
    this.sequence += 1;
    this.onFrame(frame);
    return frame;
  }

  _storeHistory(observations) {
    this.historySeriesByAsset = new Map(observations.map((entry) => [entry.id, [...entry.series]]));
    this.historyTimestampsByAsset = new Map(observations.map((entry) => [entry.id, [...entry.timestamps]]));
    this.historyCandlesByAsset = new Map(observations.map((entry) => [entry.id, [...(entry.candles || [])]]));
    this.historyObservationsByAsset = new Map(observations.map((entry) => [entry.id, entry]));
    this.seriesByAsset = new Map(observations.map((entry) => [entry.id, [...entry.series]]));
    this.historyAvailable = true;
    this.historyUnavailable = false;
    this.streamBootstrapActive = false;
    this.initialHistoryError = null;
    this._clearStreamBootstrapTimer();
  }

  _historyFrame(observations, now, { initial = false } = {}) {
    const timestamp = Math.max(...observations.map((entry) => entry.updatedAt));
    return this._commitFrame(observations, {
      timestamp,
      status: initial ? 'connecting' : 'recovering',
      quality: 'exchange-history',
      transport: 'history',
      streamConnected: false,
      sourceTimestampUs: String(BigInt(timestamp) * 1000n),
      displayCadenceMs: this.historyRefreshMs,
    });
  }

  async _refreshHistory({ initial = !this.initialized } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    const controller = new AbortController();
    this.controller = controller;
    this.refreshPromise = (async () => {
      try {
        const now = this.now();
        const observations = await Promise.all(MARKET_ASSETS.map((asset) => (
          fetchAsset(
            asset,
            this.feedConfig[asset.id],
            this.window,
            this.basePath,
            controller.signal,
            this.fetchImpl,
            now,
          )
        )));
        if (this.destroyed || controller.signal.aborted) return null;
        this._storeHistory(observations);
        this.initialized = true;
        this.lastHistoryRefreshAt = now;

        if (this.streamConnected && this.latestStreamByAsset.size > 0 && this.latestSourceTimestamp !== null) {
          return this._emitStreamFrame();
        }
        return this._historyFrame(observations, now, { initial });
      } catch (error) {
        if (error.name !== 'AbortError' && initial && !this.destroyed) {
          if (this.running && typeof this.EventSourceImpl === 'function') {
            this._beginStreamBootstrap(error);
          } else {
            this.onError(error);
          }
        }
        return null;
      } finally {
        if (this.controller === controller) this.controller = null;
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  refresh(options) {
    return this._refreshHistory(options);
  }

  _seriesWithQuote(assetId, quote) {
    if (this.window === 'ROUND') {
      const round = calculateRoundMetrics(
        this.historyCandlesByAsset.get(assetId) || [],
        quote.price,
        this.now(),
      );
      return [...round.series];
    }
    const base = this.historySeriesByAsset.get(assetId) || [];
    const timestamps = this.historyTimestampsByAsset.get(assetId) || [];
    if (!base.length) return [quote.price];
    const prices = [...base];
    const lastTimestampMs = (timestamps.at(-1) || 0) * 1000;
    const quoteBucketMs = Math.floor(quote.updatedAt / this.historyRefreshMs) * this.historyRefreshMs;
    if (quoteBucketMs <= lastTimestampMs) prices[prices.length - 1] = quote.price;
    else prices.push(quote.price);
    return prices.slice(-WINDOW_QUERIES[this.window].pointLimit);
  }

  _hasCompleteStreamBasket() {
    return MARKET_ASSETS.every((asset) => this.latestStreamByAsset.has(asset.id));
  }

  _recordStreamBootstrapQuote(assetId, quote) {
    const series = this.streamBootstrapSeriesByAsset.get(assetId) || [];
    const timestampUs = quote.feedUpdateTimestampUs;
    const previousTimestampUs = this.streamBootstrapTimestampUsByAsset.get(assetId);
    if (previousTimestampUs === timestampUs && series.length) {
      series[series.length - 1] = quote.price;
    } else {
      series.push(quote.price);
    }
    const capped = series.slice(-WINDOW_QUERIES[this.window].pointLimit);
    this.streamBootstrapSeriesByAsset.set(assetId, capped);
    this.streamBootstrapTimestampUsByAsset.set(assetId, timestampUs);
  }

  _clearStreamBootstrapTimer() {
    if (this.streamBootstrapTimer) this.clearTimeoutImpl(this.streamBootstrapTimer);
    this.streamBootstrapTimer = null;
  }

  _clearStreamFreshnessTimer() {
    if (this.streamFreshnessTimer) this.clearTimeoutImpl(this.streamFreshnessTimer);
    this.streamFreshnessTimer = null;
  }

  _staleStreamAssetIds(now = this.now()) {
    if (this.streamOpenedAt === null) return [];
    return MARKET_ASSETS
      .filter((asset) => {
        const quote = this.latestStreamByAsset.get(asset.id);
        // A new SSE connection that never delivers one member of the basket is
        // not a live comparative market, even if the REST backfill succeeded.
        const observedAt = quote?.updatedAt ?? this.streamOpenedAt;
        return now - observedAt >= this.streamStaleAfterMs;
      })
      .map((asset) => asset.id);
  }

  _scheduleStreamFreshnessWatchdog() {
    this._clearStreamFreshnessTimer();
    if (!this.running || this.paused || this.destroyed || this.streamOpenedAt === null) return;

    const now = this.now();
    const nextDeadline = Math.min(...MARKET_ASSETS.map((asset) => {
      const quote = this.latestStreamByAsset.get(asset.id);
      return (quote?.updatedAt ?? this.streamOpenedAt) + this.streamStaleAfterMs;
    }));
    const delay = Math.max(1, nextDeadline - now);
    this.streamFreshnessTimer = this.setTimeoutImpl(() => {
      this.streamFreshnessTimer = null;
      this._handleStreamFreshnessTimeout();
    }, delay);
  }

  _streamFrameMetadata({ stale = false } = {}) {
    const metadata = this.streamMetadata;
    const fallback = metadata.transportMode === 'fallback';
    return {
      quality: stale
        ? (fallback ? 'exchange-stream-stale-fallback' : 'exchange-stream-stale')
        : (fallback ? 'exchange-stream-fallback' : 'exchange-stream'),
      transport: metadata.transport,
      channel: metadata.channel,
      // The normal aggregate-trade stream is coalesced for rendering. The
      // WebSocket API fallback is a bounded server poll, so show its genuine
      // one-second cadence rather than implying 200 ms trade updates.
      displayCadenceMs: fallback && metadata.pollIntervalMs
        ? metadata.pollIntervalMs
        : this.minStreamEmitMs,
    };
  }

  _emitStaleStreamFrame() {
    if (!this.initialized) return null;
    const now = this.now();
    const observations = this._streamObservations();
    const sourceTimestampUs = this.latestSourceTimestamp?.toString() || String(BigInt(now) * 1000n);
    const metadata = this._streamFrameMetadata({ stale: true });
    return this._commitFrame(observations, {
      timestamp: now,
      status: 'stream-stale',
      quality: metadata.quality,
      transport: metadata.transport,
      streamConnected: false,
      sourceTimestampUs,
      channel: metadata.channel,
      displayCadenceMs: metadata.displayCadenceMs,
    });
  }

  _handleStreamFreshnessTimeout() {
    if (!this.running || this.paused || this.destroyed) return;
    const staleAssetIds = this._staleStreamAssetIds();
    if (staleAssetIds.length === 0) {
      this._scheduleStreamFreshnessWatchdog();
      return;
    }

    // EventSource can stay technically OPEN while its upstream silently stops
    // producing data. Treat stale source timestamps (including only one asset
    // in the basket) as a transport failure, render it honestly, and rebuild
    // the same-origin connection instead of leaving a frozen "LIVE" screen.
    this.streamConnected = false;
    this._emitStaleStreamFrame();
    this.streamOpenedAt = null;
    this._removeEventSource();
    this._scheduleReconnect();
    this._recoverHistory();
  }

  _activateStreamBootstrap() {
    if (!this.historyUnavailable || !this._hasCompleteStreamBasket()) return false;
    this.initialized = true;
    this.streamBootstrapActive = true;
    this._clearStreamBootstrapTimer();
    this.pendingStream = true;
    this._scheduleStreamFlush();
    return true;
  }

  _streamBootstrapExpired() {
    this.streamBootstrapTimer = null;
    if (this.destroyed || !this.running || this.initialized || !this.historyUnavailable) return;
    const historyError = this.initialHistoryError;
    this.running = false;
    this.streamConnected = false;
    this._clearTransportTimers();
    this._removeEventSource();
    this.onError(new Error(
      `Binance history backfill failed and the live stream did not deliver every required asset within ${Math.round(this.streamBootstrapTimeoutMs / 1000)} seconds.${historyError ? ` ${historyError.message}` : ''}`,
    ));
  }

  _beginStreamBootstrap(error) {
    this.historyUnavailable = true;
    this.initialHistoryError = error;
    this._connectStream();
    if (this._activateStreamBootstrap()) return;
    if (!this.streamBootstrapTimer && this.running && !this.destroyed) {
      this.streamBootstrapTimer = this.setTimeoutImpl(
        () => this._streamBootstrapExpired(),
        this.streamBootstrapTimeoutMs,
      );
    }
  }

  _streamObservations() {
    const now = this.now();
    return MARKET_ASSETS.map((asset) => {
      const quote = this.latestStreamByAsset.get(asset.id);
      const history = this.historyObservationsByAsset.get(asset.id);
      if (!quote) {
        const series = [...(this.historySeriesByAsset.get(asset.id) || history?.series || [])];
        const updatedAt = history?.updatedAt || now;
        const stale = now - updatedAt >= this.streamStaleAfterMs;
        this.seriesByAsset.set(asset.id, series);
        return {
          ...history,
          id: asset.id,
          series,
          updatedAt,
          stale,
          marketSession: 'open',
          carriedForward: true,
          freshness: stale ? 'stale' : 'history',
          sourceTimestampUs: this.latestSourceTimestamp?.toString() || String(BigInt(now) * 1000n),
          feedUpdateTimestampUs: String(BigInt(updatedAt) * 1000n),
        };
      }
      const series = this.historyAvailable
        ? this._seriesWithQuote(asset.id, quote)
        : [...(this.streamBootstrapSeriesByAsset.get(asset.id) || [quote.price])];
      const roundMetrics = this.historyAvailable && this.window === 'ROUND'
        ? calculateRoundMetrics(this.historyCandlesByAsset.get(asset.id) || [], quote.price, now)
        : null;
      const metrics = this.historyAvailable
        ? (roundMetrics || calculateMarketMetrics(series, WINDOW_QUERIES[this.window]))
        : NEUTRAL_MARKET_METRICS;
      const stale = now - quote.updatedAt >= this.streamStaleAfterMs;
      this.seriesByAsset.set(asset.id, series);
      return {
        id: asset.id,
        price: roundMetrics?.displayPrice || quote.price,
        series: roundMetrics?.series || series,
        ...metrics,
        updatedAt: quote.updatedAt,
        stale,
        marketSession: 'open',
        carriedForward: quote.carriedForward,
        freshness: stale
          ? 'stale'
          : quote.carriedForward
            ? 'carried-forward'
            : this.historyAvailable ? 'live' : 'live-bootstrap',
        sourceTimestampUs: quote.sourceTimestampUs,
        feedUpdateTimestampUs: quote.feedUpdateTimestampUs,
      };
    });
  }

  _emitStreamFrame() {
    if (!this.initialized || this.latestSourceTimestamp === null || !this._hasCompleteStreamBasket()) return null;
    const observations = this._streamObservations();
    const metadata = this._streamFrameMetadata();
    const bootstrapFallback = this.streamMetadata.transportMode === 'fallback';
    const frame = this._commitFrame(observations, {
      timestamp: timestampUsToMs(this.latestSourceTimestamp),
      status: this.historyAvailable ? 'open' : 'streaming-no-history',
      quality: this.historyAvailable
        ? metadata.quality
        : (bootstrapFallback ? 'exchange-stream-bootstrap-fallback' : 'exchange-stream-bootstrap'),
      transport: metadata.transport,
      streamConnected: this.streamConnected,
      sourceTimestampUs: this.latestSourceTimestamp.toString(),
      channel: metadata.channel,
      displayCadenceMs: metadata.displayCadenceMs,
    });
    this.lastStreamEmitAt = this.now();
    return frame;
  }

  _scheduleStreamFlush() {
    if (this.streamFlushTimer || !this.running || this.paused || this.destroyed) return;
    const elapsed = this.lastStreamEmitAt === null ? Number.POSITIVE_INFINITY : this.now() - this.lastStreamEmitAt;
    const delay = Number.isFinite(elapsed) ? Math.max(0, this.minStreamEmitMs - elapsed) : 0;
    this.streamFlushTimer = this.setTimeoutImpl(() => {
      this.streamFlushTimer = null;
      if (!this.pendingStream || !this.running || this.paused || this.destroyed) return;
      this.pendingStream = false;
      this._emitStreamFrame();
    }, delay);
  }

  _handlePrices(event) {
    let update;
    try {
      update = parseBinanceStreamPayload(event?.data);
    } catch {
      return;
    }
    const supported = new Set(MARKET_ASSETS.map((asset) => asset.id));
    const receivedAt = this.now();
    if (this.streamOpenedAt === null) this.streamOpenedAt = receivedAt;
    let accepted = 0;
    for (const quote of update.assets) {
      if (!supported.has(quote.id)) continue;
      const previous = this.latestStreamByAsset.get(quote.id);
      const previousTimestamp = previous
        ? parseTimestampUs(previous.feedUpdateTimestampUs, 'previous.feedUpdateTimestampUs')
        : null;
      const quoteTimestamp = parseTimestampUs(quote.feedUpdateTimestampUs, 'quote.feedUpdateTimestampUs');
      if (previousTimestamp !== null && previousTimestamp > quoteTimestamp) {
        continue;
      }
      // The server fan-out may repeat unchanged quotes for the other assets
      // when a single market trades. Equal source timestamps are not fresh
      // data, so they must not mask a silent/frozen individual asset.
      if (previousTimestamp !== null && previousTimestamp === quoteTimestamp && previous.price === quote.price) {
        continue;
      }
      const carriedForward = quote.carriedForwardProvided ? quote.carriedForward : false;
      const storedQuote = Object.freeze({ ...quote, carriedForward: Boolean(carriedForward) });
      this.latestStreamByAsset.set(quote.id, storedQuote);
      if (!this.historyAvailable) this._recordStreamBootstrapQuote(quote.id, storedQuote);
      accepted += 1;
    }
    if (!accepted) return;
    this.streamMetadata = Object.freeze({
      channel: update.channel,
      transport: update.transport,
      transportMode: update.transportMode,
      pollIntervalMs: update.pollIntervalMs,
    });
    if (this.latestSourceTimestamp === null || update.sourceTimestamp > this.latestSourceTimestamp) {
      this.latestSourceTimestamp = update.sourceTimestamp;
    }
    this.streamConnected = true;
    if (this._staleStreamAssetIds(receivedAt).length === 0) this.reconnectAttempt = 0;
    this._activateStreamBootstrap();
    this._scheduleStreamFreshnessWatchdog();
    this.pendingStream = true;
    this._scheduleStreamFlush();
  }

  _removeEventSource() {
    const source = this.eventSource;
    if (!source) return;
    const handlers = this.eventSourceHandlers;
    if (handlers && typeof source.removeEventListener === 'function') {
      source.removeEventListener('open', handlers.open);
      source.removeEventListener('prices', handlers.prices);
      source.removeEventListener('error', handlers.error);
    }
    try { source.close(); } catch {}
    this.eventSource = null;
    this.eventSourceHandlers = null;
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || !this.running || this.paused || this.destroyed || typeof this.EventSourceImpl !== 'function') return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      this._connectStream();
    }, delay);
  }

  _recoverHistory() {
    this._refreshHistory({ initial: false }).finally(() => {
      if (this.running && !this.paused && !this.destroyed) this._scheduleHistoryRefresh();
    });
  }

  _handleStreamError(source) {
    if (source !== this.eventSource || this.destroyed) return;
    this.streamConnected = false;
    this.streamOpenedAt = null;
    this._clearStreamFreshnessTimer();
    this._removeEventSource();
    this._scheduleReconnect();
    this._recoverHistory();
  }

  _connectStream() {
    if (this.eventSource || !this.running || this.paused || this.destroyed) return;
    if (typeof this.EventSourceImpl !== 'function') return;
    let source;
    try {
      source = new this.EventSourceImpl(this.streamPath);
    } catch {
      this._scheduleReconnect();
      return;
    }
    const handlers = {
      open: () => {
        if (source !== this.eventSource) return;
        this.streamConnected = true;
        this.streamOpenedAt = this.now();
        this._scheduleStreamFreshnessWatchdog();
      },
      prices: (event) => {
        if (source === this.eventSource) this._handlePrices(event);
      },
      error: () => this._handleStreamError(source),
    };
    this.eventSource = source;
    this.eventSourceHandlers = handlers;
    source.addEventListener('open', handlers.open);
    source.addEventListener('prices', handlers.prices);
    source.addEventListener('error', handlers.error);
  }

  _scheduleHistoryRefresh() {
    if (this.historyTimer) this.clearTimeoutImpl(this.historyTimer);
    this.historyTimer = null;
    if (!this.running || this.paused || this.destroyed) return;
    const delay = this.window === 'ROUND'
      ? ((this.historyRefreshMs - (this.now() % this.historyRefreshMs)) % this.historyRefreshMs)
        + ROUND_HISTORY_SETTLE_MS
      : this.historyRefreshMs;
    this.historyTimer = this.setTimeoutImpl(async () => {
      this.historyTimer = null;
      await this._refreshHistory({ initial: false });
      if (this.running && !this.paused && !this.destroyed) this._scheduleHistoryRefresh();
    }, delay);
  }

  start() {
    if (this.destroyed || this.running) return this;
    this.running = true;
    this.paused = false;
    if (this.initialized) {
      this._connectStream();
      this._scheduleHistoryRefresh();
      if (this.now() - this.lastHistoryRefreshAt >= this.historyRefreshMs) this._recoverHistory();
      return this;
    }
    // Start the stream before the REST backfill completes. If the history
    // endpoint is unavailable, already-received genuine trades can still
    // bootstrap a truthful live frame once the whole basket is present.
    this._connectStream();
    this._refreshHistory({ initial: true }).then((frame) => {
      if (!this.running || this.paused || this.destroyed) return;
      if (frame || this.historyUnavailable || this.initialized) {
        this._connectStream();
        this._scheduleHistoryRefresh();
        return;
      }
      this.running = false;
    });
    return this;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused) return this.start();
    this.running = false;
    this._clearTransportTimers();
    this._removeEventSource();
    this.streamConnected = false;
    this.controller?.abort();
    return this;
  }

  _clearTransportTimers() {
    for (const key of ['historyTimer', 'reconnectTimer', 'streamFlushTimer', 'streamBootstrapTimer', 'streamFreshnessTimer']) {
      if (this[key]) this.clearTimeoutImpl(this[key]);
      this[key] = null;
    }
    this.pendingStream = false;
    this.streamOpenedAt = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.paused = true;
    this._clearTransportTimers();
    this._removeEventSource();
    this.streamConnected = false;
    this.controller?.abort();
    this.controller = null;
  }
}

export {
  STATIC_BINANCE_SYMBOLS,
  STREAM_CHANNEL,
  STREAM_BOOTSTRAP_TIMEOUT_MS,
  STREAM_DISPLAY_CADENCE_MS,
  WINDOW_QUERIES,
};
