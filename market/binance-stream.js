import WebSocket from 'ws';

const ASSET_ORDER = Object.freeze(['btc', 'eth', 'bnb', 'sol', 'xrp']);
const BINANCE_SYMBOLS = Object.freeze({
  BTCUSDT: 'btc',
  ETHUSDT: 'eth',
  BNBUSDT: 'bnb',
  SOLUSDT: 'sol',
  XRPUSDT: 'xrp',
});
const CHANNEL = 'aggTrade';
const TICKER_PRICE_METHOD = 'ticker.price';
const STREAM_PATH = '/api/binance/stream';
const DEFAULT_ENDPOINT = `wss://stream.binance.com:9443/stream?streams=${ASSET_ORDER
  .map((assetId) => ({ btc: 'btcusdt', eth: 'ethusdt', bnb: 'bnbusdt', sol: 'solusdt', xrp: 'xrpusdt' })[assetId])
  .map((symbol) => `${symbol}@aggTrade`)
  .join('/')}`;
// The WebSocket API is a request/response transport, not a push stream. It is
// intentionally a degraded, port-443 fallback for networks that block the
// normal Spot stream's port 9443. Binance documents `ticker.price` as a public
// market-data method, so this path uses no credential and is bounded to one
// five-symbol request per second.
const DEFAULT_FALLBACK_ENDPOINT = 'wss://ws-api.binance.com:443/ws-api/v3';
const DEFAULT_FALLBACK_POLL_MS = 1_000;
const DEFAULT_FALLBACK_SILENCE_TIMEOUT_MS = 10_000;
// The last-resort relay uses the same three documented no-key REST hosts as
// the historical-candle proxy. It is deliberately fixed rather than
// configurable so this stream hub never becomes an arbitrary fetch relay.
const DEFAULT_REST_TICKER_BASES = Object.freeze([
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.com/api/v3',
  'https://api-gcp.binance.com/api/v3',
]);
const DEFAULT_REST_TICKER_POLL_MS = 2_000;
const DEFAULT_REST_TICKER_TIMEOUT_MS = 5_000;
// `ws` has its own handshake timeout, but keep an application-level bound as
// well so an injected/mock socket or a platform-level black-hole can never
// leave the hub stuck before it emits `open`, `error`, or `close`.
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
// Keep this shorter than the browser driver's 15s bootstrap grace so an SSE
// connection that is open but silently data-starved gets a chance to recover
// through port 443 before the UI gives up on a live comparison frame.
const DEFAULT_PRIMARY_SILENCE_TIMEOUT_MS = 10_000;
const PRIMARY_TRANSPORT = 'binance-spot-aggtrade';
const FALLBACK_TRANSPORT = 'binance-ws-api-ticker-price';
const REST_FALLBACK_TRANSPORT = 'binance-rest-ticker-price';
const DEFAULT_MAX_SSE_CLIENTS = 100;
const DEFAULT_MAX_SSE_CLIENTS_PER_IP = 4;
const DEFAULT_MAX_SOCKET_PAYLOAD_BYTES = 1024 * 1024;

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function websocketDataToString(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}

function timestampUsFromMilliseconds(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return (BigInt(timestamp) * 1000n).toString();
}

function timestampUs(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function unsignedIntegerText(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    try { return BigInt(value).toString(); } catch { return null; }
  }
  return null;
}

/** Normalize one Binance combined-stream aggregate-trade packet. */
export function parseBinanceAggregateTrade(message) {
  const trade = message?.data && typeof message.data === 'object' ? message.data : message;
  if (!trade || typeof trade !== 'object') return null;
  const symbol = String(trade.s || '').trim().toUpperCase();
  const id = BINANCE_SYMBOLS[symbol];
  const price = Number(trade.p);
  const feedUpdateTimestampUs = timestampUsFromMilliseconds(trade.T ?? trade.E);
  const aggregateTradeId = trade.a == null ? null : unsignedIntegerText(trade.a);
  if (!id || !Number.isFinite(price) || price <= 0 || !feedUpdateTimestampUs || (trade.a != null && !aggregateTradeId)) return null;
  return Object.freeze({
    id,
    symbol,
    price,
    feedUpdateTimestampUs,
    sourceTimestampUs: feedUpdateTimestampUs,
    marketSession: 'open',
    ...(aggregateTradeId === null ? {} : { aggregateTradeId }),
  });
}

/**
 * Normalize a successful five-symbol WebSocket API `ticker.price` response.
 * The request uses an explicit, fixed symbol array, so accepting a partial,
 * duplicate, unexpected, or malformed result would otherwise create a mixed
 * market frame. The WebSocket API response has no exchange event timestamp;
 * the trusted server receipt time is used and identified in emitted metadata.
 */
export function parseBinanceTickerPriceResponse(message, receivedAt = Date.now()) {
  if (!message || typeof message !== 'object' || message.status !== 200) return null;
  return parseBinanceTickerPriceEntries(message.result, receivedAt);
}

/** Normalize a raw REST `/ticker/price?symbols=...` response for the fixed basket. */
export function parseBinanceRestTickerPriceResponse(payload, receivedAt = Date.now()) {
  return parseBinanceTickerPriceEntries(payload, receivedAt);
}

function parseBinanceTickerPriceEntries(entries, receivedAt) {
  const timestamp = timestampUsFromMilliseconds(receivedAt);
  if (!timestamp || !Array.isArray(entries) || entries.length !== ASSET_ORDER.length) return null;

  const byId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return null;
    const symbol = typeof entry.symbol === 'string' ? entry.symbol.trim().toUpperCase() : '';
    const id = BINANCE_SYMBOLS[symbol];
    if (typeof entry.price !== 'string' && typeof entry.price !== 'number') return null;
    const price = Number(entry.price);
    if (!id || !Number.isFinite(price) || price <= 0 || byId.has(id)) return null;
    byId.set(id, Object.freeze({
      id,
      symbol,
      price,
      feedUpdateTimestampUs: timestamp,
      sourceTimestampUs: timestamp,
      marketSession: 'open',
    }));
  }
  if (byId.size !== ASSET_ORDER.length) return null;
  return Object.freeze(ASSET_ORDER.map((id) => byId.get(id)));
}

/**
 * One server-side Binance Spot socket, fanned out as same-origin SSE. It is
 * intentionally public/no-key: a browser never needs a vendor credential and
 * the Node process makes at most one upstream connection per app instance.
 */
export class BinanceStreamHub {
  constructor({
    webSocketFactory = (url, options) => new WebSocket(url, options),
    endpoint = DEFAULT_ENDPOINT,
    fallbackEndpoint = DEFAULT_FALLBACK_ENDPOINT,
    emitIntervalMs = 200,
    fallbackPollMs = DEFAULT_FALLBACK_POLL_MS,
    fallbackSilenceTimeoutMs = DEFAULT_FALLBACK_SILENCE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    restTickerBases = DEFAULT_REST_TICKER_BASES,
    restTickerPollMs = DEFAULT_REST_TICKER_POLL_MS,
    restTickerTimeoutMs = DEFAULT_REST_TICKER_TIMEOUT_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    primarySilenceTimeoutMs = DEFAULT_PRIMARY_SILENCE_TIMEOUT_MS,
    keepaliveMs = 15_000,
    idleStopMs = 30_000,
    reconnectBaseMs = 250,
    reconnectMaxMs = 10_000,
    maxSocketPayloadBytes = DEFAULT_MAX_SOCKET_PAYLOAD_BYTES,
    now = () => Date.now(),
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    onError = () => {},
  } = {}) {
    if (typeof webSocketFactory !== 'function') throw new TypeError('A WebSocket factory is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    if (!String(endpoint || '').startsWith('wss://')) throw new TypeError('Binance endpoint must be a WSS URL.');
    if (!String(fallbackEndpoint || '').startsWith('wss://')) throw new TypeError('Binance fallback endpoint must be a WSS URL.');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    if (!Number.isSafeInteger(maxSocketPayloadBytes) || maxSocketPayloadBytes <= 0) {
      throw new TypeError('maxSocketPayloadBytes must be a positive safe integer.');
    }

    this.webSocketFactory = webSocketFactory;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.fallbackEndpoint = fallbackEndpoint;
    this.emitIntervalMs = Math.max(1, Number(emitIntervalMs) || 200);
    // Do not allow a deployment option to turn the no-key fallback into a
    // high-frequency polling client. One request covers all five symbols.
    const requestedFallbackPollMs = Number(fallbackPollMs);
    this.fallbackPollMs = Number.isSafeInteger(requestedFallbackPollMs) && requestedFallbackPollMs > 0
      ? Math.max(DEFAULT_FALLBACK_POLL_MS, requestedFallbackPollMs)
      : DEFAULT_FALLBACK_POLL_MS;
    const requestedFallbackSilenceTimeoutMs = Number(fallbackSilenceTimeoutMs);
    this.fallbackSilenceTimeoutMs = Number.isSafeInteger(requestedFallbackSilenceTimeoutMs) && requestedFallbackSilenceTimeoutMs > 0
      ? Math.max(this.fallbackPollMs * 2, requestedFallbackSilenceTimeoutMs)
      : DEFAULT_FALLBACK_SILENCE_TIMEOUT_MS;
    const requestedConnectTimeoutMs = Number(connectTimeoutMs);
    this.connectTimeoutMs = Number.isSafeInteger(requestedConnectTimeoutMs) && requestedConnectTimeoutMs > 0
      ? Math.max(1_000, requestedConnectTimeoutMs)
      : DEFAULT_CONNECT_TIMEOUT_MS;
    if (!Array.isArray(restTickerBases) || restTickerBases.length === 0 || restTickerBases.some((base) => !DEFAULT_REST_TICKER_BASES.includes(base))) {
      throw new TypeError('REST ticker bases must be a non-empty subset of the documented Binance Spot REST hosts.');
    }
    this.restTickerBases = Object.freeze([...new Set(restTickerBases)]);
    const requestedRestTickerPollMs = Number(restTickerPollMs);
    this.restTickerPollMs = Number.isSafeInteger(requestedRestTickerPollMs) && requestedRestTickerPollMs > 0
      ? Math.max(DEFAULT_REST_TICKER_POLL_MS, requestedRestTickerPollMs)
      : DEFAULT_REST_TICKER_POLL_MS;
    const requestedRestTickerTimeoutMs = Number(restTickerTimeoutMs);
    this.restTickerTimeoutMs = Number.isSafeInteger(requestedRestTickerTimeoutMs) && requestedRestTickerTimeoutMs > 0
      ? Math.max(1_000, requestedRestTickerTimeoutMs)
      : DEFAULT_REST_TICKER_TIMEOUT_MS;
    const requestedPrimarySilenceTimeoutMs = Number(primarySilenceTimeoutMs);
    this.primarySilenceTimeoutMs = Number.isSafeInteger(requestedPrimarySilenceTimeoutMs) && requestedPrimarySilenceTimeoutMs > 0
      ? Math.max(1_000, requestedPrimarySilenceTimeoutMs)
      : DEFAULT_PRIMARY_SILENCE_TIMEOUT_MS;
    this.keepaliveMs = Math.max(0, Number(keepaliveMs) || 0);
    this.idleStopMs = Math.max(0, Number(idleStopMs) || 0);
    this.reconnectBaseMs = Math.max(1, Number(reconnectBaseMs) || 250);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, Number(reconnectMaxMs) || 10_000);
    this.maxSocketPayloadBytes = maxSocketPayloadBytes;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.onError = onError;

    this.listeners = new Set();
    this.socket = null;
    this.socketMode = null;
    this.activeTransport = null;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.connectTimer = null;
    this.primarySilenceTimer = null;
    this.fallbackSilenceTimer = null;
    this.restTickerTimer = null;
    this.restTickerController = null;
    this.restTickerPollInFlight = false;
    this.restTickerActive = false;
    this.restTickerGeneration = 0;
    this.restTickerPollPromise = null;
    this.fallbackPollTimer = null;
    this.emitTimer = null;
    this.idleTimer = null;
    this.awaitingPong = false;
    this.reconnectAttempt = 0;
    this.latestByAsset = new Map();
    this.latestSourceTimestamp = null;
    this.lastEmittedAt = null;
    this.lastPayload = null;
    this.fallbackRequestSequence = 0;
    this.fallbackRequestIds = new Set();
    this.sequence = 0;
    this.running = false;
    this.destroyed = false;
    this.intentionalClose = false;
  }

  get configured() {
    return true;
  }

  get clientCount() {
    return this.listeners.size;
  }

  _report(error) {
    try {
      this.onError(error instanceof Error ? error : new Error(String(error || 'Unknown Binance stream error')));
    } catch {
      // Diagnostics must never be able to stop the price stream.
    }
  }

  start() {
    if (this.destroyed) throw new Error('Binance stream hub has been destroyed.');
    if (this.running) return this;
    this._clearIdleTimer();
    this.running = true;
    this.intentionalClose = false;
    this._openSocket();
    return this;
  }

  subscribe(listener, { replay = true, autoStart = true } = {}) {
    if (typeof listener !== 'function') throw new TypeError('A stream listener is required.');
    if (this.destroyed) throw new Error('Binance stream hub has been destroyed.');
    this._clearIdleTimer();
    this.listeners.add(listener);
    if (replay && this.lastPayload) {
      try {
        listener(this.lastPayload);
      } catch (error) {
        this._report(error);
      }
    }
    if (autoStart && !this.running) {
      try {
        this.start();
      } catch (error) {
        this._report(error);
      }
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this._scheduleIdleStop();
    };
  }

  _resetSourceState() {
    if (this.emitTimer !== null) this.clearTimeoutImpl(this.emitTimer);
    this.emitTimer = null;
    this.latestByAsset.clear();
    this.latestSourceTimestamp = null;
    this.lastEmittedAt = null;
    this.lastPayload = null;
  }

  _clearFallbackPolling() {
    if (this.fallbackPollTimer !== null) this.clearIntervalImpl(this.fallbackPollTimer);
    this.fallbackPollTimer = null;
    this.fallbackRequestIds.clear();
  }

  _clearSocketHandshakeTimer() {
    if (this.connectTimer !== null) this.clearTimeoutImpl(this.connectTimer);
    this.connectTimer = null;
  }

  _armSocketHandshakeTimer(socket, mode) {
    this._clearSocketHandshakeTimer();
    if (this.socket !== socket || this.socketMode !== mode || !this.running || this.destroyed) return;
    this.connectTimer = this.setTimeoutImpl(() => {
      this.connectTimer = null;
      if (this.socket !== socket || this.socketMode !== mode || !this.running || this.destroyed) return;
      this._report(new Error(
        `Binance ${mode === 'primary' ? 'aggregate-trade' : 'port-443 ticker'} socket did not complete its handshake within ${Math.round(this.connectTimeoutMs / 1000)} seconds.`,
      ));
      this._socketFailed(socket, mode);
      try { socket.terminate?.(); } catch {}
    }, this.connectTimeoutMs);
  }

  _clearPrimarySilenceWatchdog() {
    if (this.primarySilenceTimer !== null) this.clearTimeoutImpl(this.primarySilenceTimer);
    this.primarySilenceTimer = null;
  }

  _clearFallbackSilenceWatchdog() {
    if (this.fallbackSilenceTimer !== null) this.clearTimeoutImpl(this.fallbackSilenceTimer);
    this.fallbackSilenceTimer = null;
  }

  _armPrimarySilenceWatchdog(socket) {
    this._clearPrimarySilenceWatchdog();
    if (this.socket !== socket || this.socketMode !== 'primary' || !this.running || this.destroyed) return;
    this.primarySilenceTimer = this.setTimeoutImpl(() => {
      this.primarySilenceTimer = null;
      if (this.socket !== socket || this.socketMode !== 'primary' || !this.running || this.destroyed) return;
      this._report(new Error(
        `Binance aggregate-trade stream delivered no accepted data for ${Math.round(this.primarySilenceTimeoutMs / 1000)} seconds; switching to the port-443 ticker fallback.`,
      ));
      this._socketFailed(socket, 'primary');
      try { socket.terminate?.(); } catch {}
    }, this.primarySilenceTimeoutMs);
  }

  _markPrimaryDataReceived() {
    if (this.socketMode === 'primary' && this.socket) this._armPrimarySilenceWatchdog(this.socket);
  }

  _armFallbackSilenceWatchdog(socket) {
    this._clearFallbackSilenceWatchdog();
    if (this.socket !== socket || this.socketMode !== 'fallback' || !this.running || this.destroyed) return;
    this.fallbackSilenceTimer = this.setTimeoutImpl(() => {
      this.fallbackSilenceTimer = null;
      if (this.socket !== socket || this.socketMode !== 'fallback' || !this.running || this.destroyed) return;
      this._report(new Error(
        `Binance port-443 ticker fallback delivered no accepted response for ${Math.round(this.fallbackSilenceTimeoutMs / 1000)} seconds; retrying the aggregate-trade stream.`,
      ));
      this._socketFailed(socket, 'fallback');
      try { socket.terminate?.(); } catch {}
    }, this.fallbackSilenceTimeoutMs);
  }

  _markFallbackDataReceived() {
    if (this.socketMode === 'fallback' && this.socket) this._armFallbackSilenceWatchdog(this.socket);
  }

  _restFallbackUsable(generation) {
    return this.restTickerActive
      && generation === this.restTickerGeneration
      && this.running
      && !this.destroyed;
  }

  _clearRestTickerPollTimer() {
    if (this.restTickerTimer !== null) this.clearTimeoutImpl(this.restTickerTimer);
    this.restTickerTimer = null;
  }

  _stopRestTickerFallback() {
    this.restTickerGeneration += 1;
    this.restTickerActive = false;
    this.restTickerPollInFlight = false;
    this._clearRestTickerPollTimer();
    const controller = this.restTickerController;
    this.restTickerController = null;
    if (controller) {
      try { controller.abort(); } catch {}
    }
  }

  _restTickerUrl(base) {
    const params = new URLSearchParams({ symbols: JSON.stringify(Object.keys(BINANCE_SYMBOLS)) });
    return `${base}/ticker/price?${params}`;
  }

  async _requestRestTicker(generation) {
    let lastError = new Error('Binance REST ticker fallback did not return a usable full basket.');
    for (const base of this.restTickerBases) {
      if (!this._restFallbackUsable(generation)) throw lastError;
      const controller = new AbortController();
      this.restTickerController = controller;
      let timeout = null;
      const url = this._restTickerUrl(base);
      const timeoutError = new Error(`Binance REST ticker request timed out after ${this.restTickerTimeoutMs}ms.`);
      timeoutError.name = 'AbortError';
      const timeoutPromise = new Promise((resolve, reject) => {
        timeout = this.setTimeoutImpl(() => {
          try { controller.abort(); } catch {}
          reject(timeoutError);
        }, this.restTickerTimeoutMs);
      });
      try {
        const request = Promise.resolve().then(() => this.fetchImpl(url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        }));
        const response = await Promise.race([request, timeoutPromise]);
        if (!response?.ok) throw new Error(`Binance REST ticker returned HTTP ${response?.status ?? 'error'}.`);
        const payload = await response.json();
        const quotes = parseBinanceRestTickerPriceResponse(payload, this.now());
        if (!quotes) throw new Error('Binance REST ticker returned an invalid or incomplete basket.');
        return quotes;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error || 'Binance REST ticker request failed.'));
      } finally {
        if (timeout !== null) this.clearTimeoutImpl(timeout);
        if (this.restTickerController === controller) this.restTickerController = null;
      }
    }
    throw lastError;
  }

  _acceptQuotes(quotes) {
    let accepted = false;
    for (const quote of quotes) accepted = this._acceptQuote(quote) || accepted;
    return accepted;
  }

  _scheduleRestTickerPoll(generation) {
    this._clearRestTickerPollTimer();
    if (!this._restFallbackUsable(generation)) return;
    this.restTickerTimer = this.setTimeoutImpl(() => {
      this.restTickerTimer = null;
      return this._pollRestTicker(generation);
    }, this.restTickerPollMs);
  }

  _failRestTickerFallback(error, generation) {
    if (!this._restFallbackUsable(generation)) return;
    this._report(error);
    this._stopRestTickerFallback();
    this.activeTransport = null;
    this._resetSourceState();
    if (!this.intentionalClose && this.running && !this.destroyed) this._scheduleReconnect();
  }

  async _pollRestTicker(generation) {
    if (!this._restFallbackUsable(generation) || this.restTickerPollInFlight) return;
    this.restTickerPollInFlight = true;
    try {
      const quotes = await this._requestRestTicker(generation);
      if (!this._restFallbackUsable(generation)) return;
      const accepted = this._acceptQuotes(quotes);
      if (accepted) {
        this.reconnectAttempt = 0;
        this._scheduleEmit();
      }
    } catch (error) {
      this._failRestTickerFallback(
        error instanceof Error ? error : new Error(String(error || 'Binance REST ticker fallback failed.')),
        generation,
      );
    } finally {
      if (generation === this.restTickerGeneration) {
        this.restTickerPollInFlight = false;
        if (this._restFallbackUsable(generation)) this._scheduleRestTickerPoll(generation);
      }
    }
  }

  _startRestTickerFallback() {
    if (this.restTickerActive || !this.running || this.destroyed) return;
    this._stopRestTickerFallback();
    this._resetSourceState();
    this.activeTransport = REST_FALLBACK_TRANSPORT;
    this.restTickerActive = true;
    const generation = ++this.restTickerGeneration;
    this.restTickerPollPromise = this._pollRestTicker(generation);
  }

  _socketFailed(socket, mode) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.socketMode = null;
    this.activeTransport = null;
    this._clearSocketKeepalive();
    this._clearSocketHandshakeTimer();
    this._clearFallbackPolling();
    this._clearPrimarySilenceWatchdog();
    this._clearFallbackSilenceWatchdog();
    this._resetSourceState();
    if (this.intentionalClose || !this.running || this.destroyed) return;

    // Port 9443 is the normal, richer stream. Only when it cannot be used do
    // we open the port-443 request/response fallback. If that fallback fails,
    // reconnect begins with the preferred aggregate-trade stream again.
    if (mode === 'primary') this._openSocket('fallback');
    else this._startRestTickerFallback();
  }

  _sendFallbackTickerRequest(socket) {
    if (this.socket !== socket || this.socketMode !== 'fallback' || !this.running || this.destroyed) return;
    const id = `liquidity-arena-ticker-${++this.fallbackRequestSequence}`;
    // Keep request correlation bounded even if a broken upstream never replies.
    this.fallbackRequestIds.add(id);
    while (this.fallbackRequestIds.size > 4) this.fallbackRequestIds.delete(this.fallbackRequestIds.values().next().value);
    try {
      socket.send(JSON.stringify({
        id,
        method: TICKER_PRICE_METHOD,
        params: { symbols: Object.keys(BINANCE_SYMBOLS) },
      }));
    } catch (error) {
      this._report(error);
      this._socketFailed(socket, 'fallback');
      try { socket.terminate?.(); } catch {}
    }
  }

  _startFallbackPolling(socket) {
    this._clearFallbackPolling();
    this._sendFallbackTickerRequest(socket);
    if (this.socket !== socket || this.socketMode !== 'fallback') return;
    this.fallbackPollTimer = this.setIntervalImpl(
      () => this._sendFallbackTickerRequest(socket),
      this.fallbackPollMs,
    );
  }

  _openSocket(mode = 'primary') {
    if (!this.running || this.destroyed || this.socket) return;
    const isFallback = mode === 'fallback';
    const endpoint = isFallback ? this.fallbackEndpoint : this.endpoint;
    let socket;
    try {
      socket = this.webSocketFactory(endpoint, {
        maxPayload: this.maxSocketPayloadBytes,
        handshakeTimeout: this.connectTimeoutMs,
      });
    } catch (error) {
      this._report(error);
      // A synchronous constructor failure is uncommon in Node, but it is
      // still a failed port-443 route. Treat it exactly like an asynchronous
      // fallback failure so a restrictive network can reach the no-key REST
      // relay instead of waiting through a needless retry cycle.
      if (isFallback) this._startRestTickerFallback();
      else this._openSocket('fallback');
      return;
    }
    this.socket = socket;
    this.socketMode = mode;
    this.intentionalClose = false;
    this._armSocketHandshakeTimer(socket, mode);

    socket.on('open', () => {
      if (this.socket !== socket || !this.running) return;
      this._clearSocketHandshakeTimer();
      this.reconnectAttempt = 0;
      this._resetSourceState();
      this.activeTransport = isFallback ? FALLBACK_TRANSPORT : PRIMARY_TRANSPORT;
      this._startSocketKeepalive(socket);
      if (isFallback) {
        this._startFallbackPolling(socket);
        this._armFallbackSilenceWatchdog(socket);
      }
      else this._armPrimarySilenceWatchdog(socket);
    });
    socket.on('message', (data) => {
      if (this.socket !== socket || !this.running) return;
      let message;
      try {
        message = JSON.parse(websocketDataToString(data));
      } catch {
        return;
      }
      if (isFallback) {
        const id = typeof message?.id === 'string' ? message.id : '';
        if (!id || !this.fallbackRequestIds.delete(id)) return;
        this.ingestTickerPrice(message, this.now());
      } else {
        this.ingest(message);
      }
    });
    socket.on('pong', () => {
      if (this.socket === socket) this.awaitingPong = false;
    });
    socket.on('error', (error) => {
      this._report(error);
      this._socketFailed(socket, mode);
    });
    socket.on('close', () => {
      this._socketFailed(socket, mode);
    });
  }

  /** Accept a decoded aggregate-trade packet. Exposed for deterministic tests. */
  ingest(message) {
    const quote = parseBinanceAggregateTrade(message);
    if (!quote) return false;
    const accepted = this._acceptQuote(quote);
    if (accepted) {
      this._markPrimaryDataReceived();
      this._scheduleEmit();
    }
    return accepted;
  }

  /** Accept a decoded fallback `ticker.price` response. Exposed for deterministic tests. */
  ingestTickerPrice(message, receivedAt = this.now()) {
    const quotes = parseBinanceTickerPriceResponse(message, receivedAt);
    if (!quotes) return false;
    const accepted = quotes.reduce((result, quote) => this._acceptQuote(quote) || result, false);
    if (accepted) {
      this._markFallbackDataReceived();
      this._scheduleEmit();
    }
    return accepted;
  }

  _acceptQuote(quote) {
    const feedTimestamp = timestampUs(quote.feedUpdateTimestampUs);
    const previous = this.latestByAsset.get(quote.id);
    const previousTimestamp = previous ? timestampUs(previous.feedUpdateTimestampUs) : null;
    if (!feedTimestamp || (previousTimestamp !== null && previousTimestamp > feedTimestamp)) return false;
    if (previousTimestamp !== null && previousTimestamp === feedTimestamp) {
      const previousAggregateTradeId = unsignedIntegerText(previous?.aggregateTradeId);
      const aggregateTradeId = unsignedIntegerText(quote.aggregateTradeId);
      if (previousAggregateTradeId !== null && aggregateTradeId !== null) {
        if (BigInt(aggregateTradeId) <= BigInt(previousAggregateTradeId)) return false;
      } else if (previous?.price === quote.price) {
        // Fallback ticker responses do not have aggregate IDs. A same-price,
        // same-timestamp repeat cannot improve the market state, but a distinct
        // price is accepted in arrival order rather than silently discarded.
        return false;
      }
    }

    this.latestByAsset.set(quote.id, quote);
    if (this.latestSourceTimestamp === null || feedTimestamp > BigInt(this.latestSourceTimestamp)) {
      this.latestSourceTimestamp = quote.sourceTimestampUs;
    }
    return true;
  }

  _scheduleEmit() {
    if (this.emitTimer !== null) return;
    const elapsed = this.lastEmittedAt === null ? this.emitIntervalMs : this.now() - this.lastEmittedAt;
    const delay = this.lastEmittedAt === null ? 0 : Math.max(0, this.emitIntervalMs - elapsed);
    this.emitTimer = this.setTimeoutImpl(() => {
      this.emitTimer = null;
      this._emit();
    }, delay);
  }

  _emit() {
    if (!this.latestSourceTimestamp || this.latestByAsset.size === 0) return;
    const websocketFallback = this.activeTransport === FALLBACK_TRANSPORT;
    const restFallback = this.activeTransport === REST_FALLBACK_TRANSPORT;
    const fallback = websocketFallback || restFallback;
    this.lastEmittedAt = this.now();
    const payload = Object.freeze({
      type: 'binance_stream',
      sequence: ++this.sequence,
      emittedAt: this.lastEmittedAt,
      sourceTimestampUs: this.latestSourceTimestamp,
      // Consumers can distinguish the normal event stream from either
      // degraded fallback without changing the established SSE shape.
      channel: fallback ? TICKER_PRICE_METHOD : CHANNEL,
      transport: restFallback
        ? REST_FALLBACK_TRANSPORT
        : websocketFallback ? FALLBACK_TRANSPORT : PRIMARY_TRANSPORT,
      transportMode: fallback ? 'fallback' : 'primary',
      pollIntervalMs: restFallback
        ? this.restTickerPollMs
        : websocketFallback ? this.fallbackPollMs : null,
      timestampSource: fallback ? 'relay-receipt' : 'exchange-event',
      assets: ASSET_ORDER
        .map((id) => this.latestByAsset.get(id))
        .filter(Boolean)
        .map((asset) => Object.freeze({ ...asset })),
    });
    this.lastPayload = payload;
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch (error) {
        this._report(error);
      }
    }
  }

  _startSocketKeepalive(socket) {
    this._clearSocketKeepalive();
    if (!this.keepaliveMs || typeof socket.ping !== 'function') return;
    this.keepaliveTimer = this.setIntervalImpl(() => {
      if (this.socket !== socket || !this.running) return;
      if (this.awaitingPong) {
        try {
          socket.terminate?.();
        } catch (error) {
          this._report(error);
        }
        return;
      }
      this.awaitingPong = true;
      try {
        socket.ping();
      } catch (error) {
        this._report(error);
        try { socket.terminate?.(); } catch {}
      }
    }, this.keepaliveMs);
  }

  _clearSocketKeepalive() {
    if (this.keepaliveTimer !== null) this.clearIntervalImpl(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.awaitingPong = false;
  }

  _scheduleReconnect() {
    if (this.reconnectTimer !== null || !this.running || this.destroyed) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 16)),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  _clearIdleTimer() {
    if (this.idleTimer !== null) this.clearTimeoutImpl(this.idleTimer);
    this.idleTimer = null;
  }

  _scheduleIdleStop() {
    this._clearIdleTimer();
    if (!this.running) return;
    if (!this.idleStopMs) {
      this.stop();
      return;
    }
    this.idleTimer = this.setTimeoutImpl(() => {
      this.idleTimer = null;
      if (this.listeners.size === 0) this.stop();
    }, this.idleStopMs);
  }

  stop() {
    this.running = false;
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) this.clearTimeoutImpl(this.reconnectTimer);
    if (this.emitTimer !== null) this.clearTimeoutImpl(this.emitTimer);
    this.reconnectTimer = null;
    this.emitTimer = null;
    this._clearIdleTimer();
    this._clearSocketKeepalive();
    this._clearSocketHandshakeTimer();
    this._clearFallbackPolling();
    this._clearPrimarySilenceWatchdog();
    this._clearFallbackSilenceWatchdog();
    this._stopRestTickerFallback();
    const socket = this.socket;
    this.socket = null;
    this.socketMode = null;
    this.activeTransport = null;
    if (socket) {
      try {
        socket.close?.(1000, 'Binance stream hub stopped');
      } catch {
        try { socket.terminate?.(); } catch {}
      }
    }
    this.latestByAsset.clear();
    this.latestSourceTimestamp = null;
    this.lastEmittedAt = null;
    this.lastPayload = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.listeners.clear();
  }
}

export function createBinanceStreamMiddleware({
  hub,
  sseKeepaliveMs = 15_000,
  maxClients = DEFAULT_MAX_SSE_CLIENTS,
  maxClientsPerIp = DEFAULT_MAX_SSE_CLIENTS_PER_IP,
  resolveClientIp = (req) => String(req?.socket?.remoteAddress || 'unknown'),
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  ...hubOptions
} = {}) {
  if (!Number.isSafeInteger(maxClients) || maxClients <= 0) {
    throw new TypeError('maxClients must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxClientsPerIp) || maxClientsPerIp <= 0) {
    throw new TypeError('maxClientsPerIp must be a positive safe integer.');
  }
  if (typeof resolveClientIp !== 'function') throw new TypeError('resolveClientIp must be a function.');
  const streamHub = hub || new BinanceStreamHub(hubOptions);
  let reservedClients = 0;
  const reservedClientsByIp = new Map();

  const clientIpFor = (req) => {
    try {
      const value = String(resolveClientIp(req) || '').trim();
      return value ? value.slice(0, 256) : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const reserveClient = (clientIp) => {
    reservedClients += 1;
    reservedClientsByIp.set(clientIp, (reservedClientsByIp.get(clientIp) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedClients = Math.max(0, reservedClients - 1);
      const remaining = Math.max(0, (reservedClientsByIp.get(clientIp) || 0) - 1);
      if (remaining > 0) reservedClientsByIp.set(clientIp, remaining);
      else reservedClientsByIp.delete(clientIp);
    };
  };

  const middleware = async function binanceStreamMiddleware(req, res, next) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname !== STREAM_PATH) return next();
    if (req.method !== 'GET') return json(res, 405, { error: 'Only GET requests are allowed.' });
    const clientIp = clientIpFor(req);
    if (Math.max(reservedClients, Number(streamHub.clientCount || 0)) >= maxClients) {
      res.setHeader('retry-after', '5');
      return json(res, 503, { error: 'Binance stream capacity is currently full.' });
    }
    if ((reservedClientsByIp.get(clientIp) || 0) >= maxClientsPerIp) {
      res.setHeader('retry-after', '5');
      return json(res, 429, { error: 'Too many Binance stream connections from this client.' });
    }

    let requestClosed = false;
    const releaseReservation = reserveClient(clientIp);
    const markClosed = () => {
      requestClosed = true;
      releaseReservation();
    };
    req.once?.('close', markClosed);
    res.once?.('close', markClosed);

    try {
      streamHub.start();
    } catch (error) {
      req.off?.('close', markClosed);
      res.off?.('close', markClosed);
      releaseReservation();
      if (requestClosed) return undefined;
      streamHub._report?.(error);
      return json(res, 502, { error: 'Unable to start the Binance price stream.' });
    }
    if (requestClosed || res.destroyed || res.writableEnded) {
      req.off?.('close', markClosed);
      res.off?.('close', markClosed);
      releaseReservation();
      return undefined;
    }
    if (Number(streamHub.clientCount || 0) >= maxClients) {
      req.off?.('close', markClosed);
      res.off?.('close', markClosed);
      releaseReservation();
      res.setHeader('retry-after', '5');
      return json(res, 503, { error: 'Binance stream capacity is currently full.' });
    }
    req.off?.('close', markClosed);
    res.off?.('close', markClosed);

    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 1000\n\n');

    let closed = false;
    let keepaliveTimer = null;
    let backpressured = false;
    let pendingPayload = null;
    const writeChunk = (chunk) => {
      if (closed || res.writableEnded || backpressured) return false;
      const writable = res.write(chunk);
      if (!writable) {
        backpressured = true;
        res.once?.('drain', flushPending);
      }
      return writable;
    };
    const flushPending = () => {
      res.off?.('drain', flushPending);
      backpressured = false;
      if (closed || res.writableEnded || pendingPayload === null) return;
      const payload = pendingPayload;
      pendingPayload = null;
      writeChunk(`event: prices\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const send = (payload) => {
      if (closed || res.writableEnded) return;
      if (backpressured) {
        pendingPayload = payload;
        return;
      }
      writeChunk(`event: prices\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = streamHub.subscribe(send, { autoStart: false });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      releaseReservation();
      pendingPayload = null;
      res.off?.('drain', flushPending);
      if (keepaliveTimer !== null) clearIntervalImpl(keepaliveTimer);
      keepaliveTimer = null;
      req.off?.('close', cleanup);
      res.off?.('close', cleanup);
    };
    req.once?.('close', cleanup);
    res.once?.('close', cleanup);
    if (sseKeepaliveMs > 0) {
      keepaliveTimer = setIntervalImpl(() => {
        if (!closed && !res.writableEnded && !backpressured) writeChunk(': keepalive\n\n');
      }, sseKeepaliveMs);
    }
    return undefined;
  };

  middleware.hub = streamHub;
  return middleware;
}

export function binanceStreamPlugin(options = {}) {
  const middleware = createBinanceStreamMiddleware(options);
  const install = (server) => {
    server.middlewares.use(middleware);
    server.httpServer?.once('close', () => middleware.hub.destroy());
  };
  return {
    name: 'liquidity-arena-binance-stream',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle() {
      middleware.hub.destroy();
    },
  };
}

export {
  ASSET_ORDER,
  BINANCE_SYMBOLS,
  CHANNEL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_ENDPOINT,
  DEFAULT_FALLBACK_ENDPOINT,
  DEFAULT_FALLBACK_POLL_MS,
  DEFAULT_REST_TICKER_BASES,
  DEFAULT_REST_TICKER_POLL_MS,
  DEFAULT_REST_TICKER_TIMEOUT_MS,
  DEFAULT_PRIMARY_SILENCE_TIMEOUT_MS,
  DEFAULT_MAX_SOCKET_PAYLOAD_BYTES,
  DEFAULT_MAX_SSE_CLIENTS,
  DEFAULT_MAX_SSE_CLIENTS_PER_IP,
  FALLBACK_TRANSPORT,
  PRIMARY_TRANSPORT,
  REST_FALLBACK_TRANSPORT,
  STREAM_PATH,
  TICKER_PRICE_METHOD,
};
