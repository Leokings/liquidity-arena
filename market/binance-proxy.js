const STATIC_SYMBOLS = new Set([
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
]);
const ALLOWED_INTERVALS = new Set(['1m', '5m', '15m', '1h']);
// These are Binance's documented Spot REST hosts. Keep this list explicit: the
// public proxy must never turn a deployment-time environment variable into an
// arbitrary server-side request target.
const OFFICIAL_BINANCE_REST_BASES = Object.freeze([
  'https://data-api.binance.vision/api/v3',
  'https://api.binance.com/api/v3',
  'https://api-gcp.binance.com/api/v3',
  'https://api1.binance.com/api/v3',
  'https://api2.binance.com/api/v3',
  'https://api3.binance.com/api/v3',
  'https://api4.binance.com/api/v3',
]);
// Vision is Binance's preferred public-market-data host. The two official
// general API hosts give the UI a no-key fallback if that CDN is unreachable.
const DEFAULT_BINANCE_REST_BASES = Object.freeze(OFFICIAL_BINANCE_REST_BASES.slice(0, 3));
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_HISTORY_CACHE_MS = 20_000;
// There are only twenty supported history queries (five symbols x four
// comparison windows). Keep a little headroom while still making the cache
// bounded if the allowed basket grows in the future.
const DEFAULT_MAX_HISTORY_CACHE_ENTRIES = 32;
const DEFAULT_MAX_HISTORY_CACHE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_REQUESTS = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
// A public server can see many client addresses. Expiry cleanup handles
// normal churn; this hard cap keeps a burst of unique clients from retaining
// an unbounded number of live windows for the full minute.
const DEFAULT_MAX_RATE_LIMIT_CLIENTS = 1_024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const MAX_KLINE_LIMIT = 1_000;

// The browser's four comparison windows intentionally have fixed history
// shapes. Accepting arbitrary limits would turn the otherwise tiny shared
// cache into a high-cardinality public data relay. Keep the proxy aligned
// with those four UI requests while retaining MAX_KLINE_LIMIT as a hard
// numeric guard for malformed input.
const ALLOWED_KLINE_LIMITS = Object.freeze({
  '1m': 180,
  '5m': 240,
  '15m': 240,
  '1h': 240,
});

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function copyResponse(res, entry) {
  res.statusCode = entry.status;
  res.setHeader('content-type', entry.contentType || 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, max-age=20');
  res.end(entry.body);
}

function allowedSymbol(symbol) {
  return STATIC_SYMBOLS.has(symbol);
}

function allowedKlineRequest(interval, limit) {
  return ALLOWED_KLINE_LIMITS[interval] === limit;
}

/**
 * Parse an optional comma-separated server configuration while allowing only
 * Binance's documented Spot REST v3 hosts. This preserves the bounded proxy's
 * SSRF boundary even when an operator changes the preferred failover order.
 */
export function configuredBinanceRestBases(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value ?? '').split(',');
  const requested = entries.map((entry) => String(entry || '').trim().replace(/\/+$/, '')).filter(Boolean);
  if (requested.length === 0) return DEFAULT_BINANCE_REST_BASES;
  if (requested.length > OFFICIAL_BINANCE_REST_BASES.length) {
    throw new Error('BINANCE_REST_BASES contains too many endpoints.');
  }
  const official = new Set(OFFICIAL_BINANCE_REST_BASES);
  const unique = [];
  for (const endpoint of requested) {
    if (!official.has(endpoint)) {
      throw new Error('BINANCE_REST_BASES may contain only documented Binance Spot REST v3 endpoints.');
    }
    if (!unique.includes(endpoint)) unique.push(endpoint);
  }
  return Object.freeze(unique);
}

/**
 * A bounded same-origin proxy for the five public Binance Spot kline routes.
 * It deliberately accepts no arbitrary URL, extra query parameters, or API
 * credentials, so it cannot become an open relay when deployed publicly.
 */
export function createBinanceProxyMiddleware({
  fetchImpl = globalThis.fetch,
  // Binance documents Vision specifically for public market data. The
  // fallbacks are also official public Spot hosts and use no credentials.
  upstreamBases,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  historyCacheMs = DEFAULT_HISTORY_CACHE_MS,
  maxHistoryCacheEntries = DEFAULT_MAX_HISTORY_CACHE_ENTRIES,
  maxHistoryCacheBytes = DEFAULT_MAX_HISTORY_CACHE_BYTES,
  rateLimitRequests = DEFAULT_RATE_LIMIT_REQUESTS,
  rateLimitWindowMs = DEFAULT_RATE_LIMIT_WINDOW_MS,
  maxRateLimitClients = DEFAULT_MAX_RATE_LIMIT_CLIENTS,
  maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  clientKey = (req) => req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown',
  now = Date.now,
  onError = () => {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const resolvedUpstreamBases = configuredBinanceRestBases(upstreamBases);
  for (const [name, value] of Object.entries({
    timeoutMs,
    maxResponseBytes,
    historyCacheMs,
    maxHistoryCacheEntries,
    maxHistoryCacheBytes,
    rateLimitRequests,
    rateLimitWindowMs,
    maxRateLimitClients,
    maxConcurrentRequests,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  if (typeof clientKey !== 'function') throw new TypeError('clientKey must be a function.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function.');

  const cache = new Map();
  const inflight = new Map();
  const requestWindows = new Map();
  let cacheBytes = 0;
  let activeRequests = 0;

  function currentTimestamp() {
    const timestamp = Number(now());
    // A custom clock is useful in tests, but it must not be able to leave
    // immortal cache/rate-limit entries in a public server.
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
  }

  function removeCacheEntry(key) {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    cacheBytes = Math.max(0, cacheBytes - entry.byteLength);
  }

  function purgeExpiredCache(timestamp) {
    for (const [key, entry] of cache) {
      if (!Number.isFinite(entry.expiresAt) || timestamp >= entry.expiresAt) removeCacheEntry(key);
    }
  }

  function touchCacheEntry(key, entry) {
    // Map iteration order is insertion order. Moving a hit to the tail makes
    // the eviction below true LRU rather than FIFO.
    cache.delete(key);
    cache.set(key, entry);
  }

  function cacheEntry(key, result, timestamp) {
    const byteLength = result.body.length;
    // A valid response larger than the total cache budget can still be served;
    // it is simply not retained.
    if (byteLength > maxHistoryCacheBytes) return;
    removeCacheEntry(key);
    const entry = {
      ...result,
      byteLength,
      expiresAt: timestamp + historyCacheMs,
    };
    cache.set(key, entry);
    cacheBytes += byteLength;
    while (cache.size > maxHistoryCacheEntries || cacheBytes > maxHistoryCacheBytes) {
      const oldestKey = cache.keys().next().value;
      removeCacheEntry(oldestKey);
    }
  }

  function purgeExpiredRateLimitWindows(timestamp) {
    for (const [key, window] of requestWindows) {
      if (!Number.isFinite(window.resetAt) || timestamp >= window.resetAt) requestWindows.delete(key);
    }
  }

  function touchRateLimitWindow(key, window) {
    requestWindows.delete(key);
    requestWindows.set(key, window);
  }

  function consumeRateLimit(req, timestamp) {
    const key = String(clientKey(req) || 'unknown');
    let window = requestWindows.get(key);
    if (!window) {
      window = { count: 0, resetAt: timestamp + rateLimitWindowMs };
      requestWindows.set(key, window);
    } else {
      touchRateLimitWindow(key, window);
    }
    while (requestWindows.size > maxRateLimitClients) {
      requestWindows.delete(requestWindows.keys().next().value);
    }
    if (window.count >= rateLimitRequests) {
      return Math.max(1, Math.ceil((window.resetAt - timestamp) / 1000));
    }
    window.count += 1;
    return null;
  }

  async function requestBinance(upstreamUrls) {
    if (activeRequests >= maxConcurrentRequests) return { busy: true };
    activeRequests += 1;
    try {
      let lastResult = { upstreamError: true };
      for (const upstreamUrl of upstreamUrls) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const upstream = await fetchImpl(upstreamUrl, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          if (!upstream.ok) {
            lastResult = { upstreamError: true };
            continue;
          }
          const declaredLength = Number(upstream.headers?.get?.('content-length'));
          if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
            lastResult = { tooLarge: true };
            continue;
          }
          const body = Buffer.from(await upstream.arrayBuffer());
          if (body.length > maxResponseBytes) {
            lastResult = { tooLarge: true };
            continue;
          }
          try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (!Array.isArray(parsed)) {
              lastResult = { malformed: true };
              continue;
            }
          } catch {
            lastResult = { malformed: true };
            continue;
          }
          return {
            ok: true,
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body,
          };
        } catch (error) {
          try { onError(error); } catch { /* diagnostics cannot break the proxy */ }
          lastResult = { timeout: error?.name === 'AbortError', failed: true };
        } finally {
          clearTimeout(timeout);
        }
      }
      return lastResult;
    } finally {
      activeRequests -= 1;
    }
  }

  const binanceProxy = async function binanceProxy(req, res, next) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (!requestUrl.pathname.startsWith('/api/binance/')) return next();
    const timestamp = currentTimestamp();
    // Cleanup is deliberately active rather than relying on a background
    // timer: the proxy never keeps a timer alive in dev/test processes, and
    // every Binance namespace request performs bounded maintenance.
    purgeExpiredCache(timestamp);
    purgeExpiredRateLimitWindows(timestamp);
    if (req.method !== 'GET') return json(res, 405, { error: 'Only GET requests are allowed.' });
    if (requestUrl.pathname !== '/api/binance/klines') {
      return json(res, 404, { error: 'Unknown Binance route.' });
    }

    const symbol = requestUrl.searchParams.get('symbol') || '';
    const interval = requestUrl.searchParams.get('interval') || '';
    const limit = Number(requestUrl.searchParams.get('limit'));
    if (!allowedSymbol(symbol)) return json(res, 400, { error: 'Unsupported Binance symbol.' });
    if (!ALLOWED_INTERVALS.has(interval)) return json(res, 400, { error: 'Unsupported Binance kline interval.' });
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > MAX_KLINE_LIMIT) {
      return json(res, 400, { error: `Kline limit must be an integer between 2 and ${MAX_KLINE_LIMIT}.` });
    }
    if (!allowedKlineRequest(interval, limit)) {
      return json(res, 400, { error: `Kline limit must be ${ALLOWED_KLINE_LIMITS[interval]} for the ${interval} market window.` });
    }
    if ([...requestUrl.searchParams.keys()].some((key) => !['symbol', 'interval', 'limit'].includes(key))) {
      return json(res, 400, { error: 'Unsupported Binance query parameter.' });
    }

    const retryAfter = consumeRateLimit(req, timestamp);
    if (retryAfter !== null) {
      res.setHeader('retry-after', String(retryAfter));
      return json(res, 429, { error: 'Binance history rate limit exceeded.' });
    }

    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    // Cache and coalesce the logical public kline request rather than the
    // selected upstream so a successful fallback is reused until expiry.
    const requestKey = params.toString();
    const upstreamUrls = resolvedUpstreamBases.map((base) => `${base}/klines?${params}`);
    const cached = cache.get(requestKey);
    if (cached) {
      touchCacheEntry(requestKey, cached);
      copyResponse(res, cached);
      return undefined;
    }

    let pending = inflight.get(requestKey);
    if (!pending) {
      pending = requestBinance(upstreamUrls);
      inflight.set(requestKey, pending);
    }
    let result;
    try {
      result = await pending;
    } finally {
      if (inflight.get(requestKey) === pending) inflight.delete(requestKey);
    }
    if (result.busy) {
      res.setHeader('retry-after', '1');
      return json(res, 503, { error: 'Binance history proxy is at capacity.' });
    }
    if (result.tooLarge) return json(res, 502, { error: 'Binance response exceeded the server limit.' });
    if (result.malformed) return json(res, 502, { error: 'Binance returned malformed data.' });
    if (result.upstreamError) return json(res, 502, { error: 'Binance upstream request failed.' });
    if (result.failed) {
      return json(res, 502, { error: result.timeout ? 'Binance request timed out.' : 'Unable to reach Binance.' });
    }

    cacheEntry(requestKey, result, timestamp);
    copyResponse(res, result);
    return undefined;
  };

  // This is process-local diagnostic data only; it is not exposed over HTTP.
  // Keeping it on the middleware makes bounded-state behaviour testable and
  // gives a host application an optional, safe health metric.
  Object.defineProperty(binanceProxy, 'getDiagnostics', {
    enumerable: false,
    value: () => Object.freeze({
      activeRequests,
      cacheBytes,
      cacheEntries: cache.size,
      inflightRequests: inflight.size,
      rateLimitClients: requestWindows.size,
    }),
  });
  return binanceProxy;
}

export function binanceProxyPlugin(options) {
  const middleware = createBinanceProxyMiddleware(options);
  return {
    name: 'liquidity-arena-binance-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export {
  ALLOWED_KLINE_LIMITS,
  ALLOWED_INTERVALS,
  DEFAULT_HISTORY_CACHE_MS,
  DEFAULT_BINANCE_REST_BASES,
  DEFAULT_MAX_HISTORY_CACHE_BYTES,
  DEFAULT_MAX_HISTORY_CACHE_ENTRIES,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RATE_LIMIT_CLIENTS,
  DEFAULT_RATE_LIMIT_REQUESTS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_KLINE_LIMIT,
  OFFICIAL_BINANCE_REST_BASES,
  STATIC_SYMBOLS,
  allowedKlineRequest,
  allowedSymbol,
};
