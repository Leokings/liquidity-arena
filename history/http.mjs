import {
  HISTORY_MAX_REQUEST_BYTES,
  HISTORY_SYNC_RATE_LIMIT,
  HISTORY_SYNC_RATE_WINDOW_MS,
  authorizedHistoryIngest,
  historyConfigurationStatus,
  requireHistoryIngestSecret,
} from './config.mjs';
import { HistoryError, publicHistoryError } from './errors.mjs';
import {
  encodeHistoryCursor,
  normalizedIdempotencyKey,
  parseHistorySyncBody,
  parsePublicHistoryQuery,
} from './schema.mjs';

function header(req, name) {
  const value = req?.headers?.[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function jsonResponse(res, statusCode, payload, method = 'GET') {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  if (method === 'HEAD') res.end();
  else res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allow, method) {
  res.setHeader('allow', allow);
  jsonResponse(res, 405, { error: 'Method not allowed.', code: 'HISTORY_METHOD' }, method);
}

class StrictJsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.nodes = 0;
  }

  fail() {
    throw new HistoryError('HISTORY_JSON', 'History sync body must be strict JSON.', { statusCode: 400 });
  }

  whitespace() {
    while (/\s/.test(this.source[this.index] || '')) this.index += 1;
  }

  node(depth) {
    this.nodes += 1;
    if (depth > 32 || this.nodes > 2_000) this.fail();
  }

  string() {
    this.whitespace();
    if (this.source[this.index] !== '"') this.fail();
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.fail();
        }
      }
      if (character === '\\') {
        this.index += 1;
        const escape = this.source[this.index];
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'].includes(escape)) this.fail();
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) this.fail();
          this.index += 4;
        }
      } else if (character.charCodeAt(0) <= 0x1f) this.fail();
      this.index += 1;
    }
    this.fail();
    return '';
  }

  value(depth = 0) {
    this.node(depth);
    this.whitespace();
    const next = this.source[this.index];
    if (next === '"') return this.string();
    if (next === '{') return this.object(depth + 1);
    if (next === '[') return this.array(depth + 1);
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) this.fail();
    this.index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) this.fail();
    return number;
  }

  object(depth) {
    this.index += 1;
    const result = {};
    const keys = new Set();
    this.whitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      const key = this.string();
      if (keys.has(key)) this.fail();
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ':') this.fail();
      this.index += 1;
      result[key] = this.value(depth);
      this.whitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ',') this.fail();
      this.index += 1;
    }
  }

  array(depth) {
    this.index += 1;
    const result = [];
    this.whitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth));
      this.whitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ',') this.fail();
      this.index += 1;
    }
  }

  document() {
    const value = this.value();
    this.whitespace();
    if (this.index !== this.source.length) this.fail();
    return value;
  }
}

async function readBoundedBody(req) {
  const contentType = header(req, 'content-type').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new HistoryError('HISTORY_CONTENT_TYPE', 'History sync requires application/json.', { statusCode: 415 });
  }
  const contentEncoding = header(req, 'content-encoding').toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new HistoryError('HISTORY_CONTENT_ENCODING', 'Compressed history sync bodies are not accepted.', { statusCode: 415 });
  }
  const declared = header(req, 'content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > HISTORY_MAX_REQUEST_BYTES)) {
    throw new HistoryError('HISTORY_BODY_SIZE', 'History sync body is too large.', { statusCode: 413 });
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    throw new HistoryError('HISTORY_JSON', 'History sync body is unavailable.', { statusCode: 400 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > HISTORY_MAX_REQUEST_BYTES) {
      throw new HistoryError('HISTORY_BODY_SIZE', 'History sync body is too large.', { statusCode: 413 });
    }
    chunks.push(bytes);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HistoryError('HISTORY_JSON', 'History sync body must be UTF-8 JSON.', { statusCode: 400 });
  }
  if (Buffer.byteLength(source, 'utf8') > HISTORY_MAX_REQUEST_BYTES) {
    throw new HistoryError('HISTORY_BODY_SIZE', 'History sync body is too large.', { statusCode: 413 });
  }
  if (!source.trim()) throw new HistoryError('HISTORY_JSON', 'History sync body is required.', { statusCode: 400 });
  return new StrictJsonParser(source).document();
}

export function createHistoryRateLimiter({
  limit = HISTORY_SYNC_RATE_LIMIT,
  windowMs = HISTORY_SYNC_RATE_WINDOW_MS,
  now = Date.now,
  maximumKeys = 1_000,
} = {}) {
  const buckets = new Map();
  return Object.freeze({
    allow(key) {
      const timestamp = now();
      const normalized = String(key || 'unknown').slice(0, 256);
      let bucket = buckets.get(normalized);
      if (!bucket || timestamp - bucket.startedAt >= windowMs) {
        bucket = { startedAt: timestamp, count: 0 };
        buckets.set(normalized, bucket);
      }
      bucket.count += 1;
      if (buckets.size > maximumKeys) {
        for (const [storedKey, stored] of buckets) {
          if (timestamp - stored.startedAt >= windowMs) buckets.delete(storedKey);
          if (buckets.size <= maximumKeys) break;
        }
        while (buckets.size > maximumKeys) {
          buckets.delete(buckets.keys().next().value);
        }
      }
      return bucket.count <= limit;
    },
  });
}

export function createPublicHistoryHandler({ repository }) {
  return async function publicHistoryHandler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD', method);
    try {
      if (repository.configured === false) throw new HistoryError('HISTORY_UNCONFIGURED', 'Durable history is not configured.', { statusCode: 503 });
      const query = parsePublicHistoryQuery(new URL(req.url || '/api/history', 'http://localhost'));
      const rows = query.view === 'deployments'
        ? await repository.listDeployments(query)
        : query.view === 'proofs'
          ? await repository.listProofs(query)
          : query.view === 'payouts'
            ? await repository.listPayouts(query)
            : await repository.listEpochs(query);
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor = hasMore && last
        ? encodeHistoryCursor(last, query.view, query.deployment)
        : null;
      return jsonResponse(res, 200, {
        status: 'ok',
        dataScope: query.view === 'proofs'
          ? 'VERIFIED_TRANSACTION_PROOFS'
          : query.view === 'payouts'
            ? 'V8_PAYOUT_STAGES'
            : 'HOURLY_CONTRACT_EPOCHS',
        continuousVisualizationTicksStored: false,
        view: query.view,
        deployment: query.deployment,
        page: { limit: query.limit, nextCursor },
        items,
      }, method);
    } catch (error) {
      const result = publicHistoryError(error);
      return jsonResponse(res, result.statusCode, result.body, method);
    }
  };
}

export function createHistoryHealthHandler({ repository, environment = process.env }) {
  return async function historyHealthHandler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD', method);
    const configuration = historyConfigurationStatus(environment);
    let database = { configured: configuration.databaseConfigured, ready: false, schemaVersion: null };
    let probeFailed = false;
    if (configuration.databaseConfigured) {
      try {
        database = await repository.health();
      } catch {
        probeFailed = true;
      }
    }
    const fullyConfigured = configuration.databaseConfigured
      && configuration.ingestConfigured
      && configuration.chainConfigured;
    const ready = fullyConfigured
      && database.ready === true
      && database.integrity?.ready !== false
      && !probeFailed;
    const status = ready ? 'ready' : (fullyConfigured ? 'degraded' : 'unconfigured');
    return jsonResponse(res, status === 'degraded' ? 503 : 200, {
      status,
      service: 'liquidity-arena-history',
      dataScope: 'BRADBURY_V8_EPOCHS_AND_PAYOUT_STAGES',
      continuousVisualizationTicksStored: false,
      configuration,
      database,
    }, method);
  };
}

export function createHistorySyncHandler({
  service,
  environment = process.env,
  rateLimiter = createHistoryRateLimiter(),
  clientKey = () => 'unknown',
}) {
  return async function historySyncHandler(req, res) {
    const method = String(req.method || 'POST').toUpperCase();
    if (method !== 'POST') return methodNotAllowed(res, 'POST', method);
    try {
      if (!rateLimiter.allow(clientKey(req))) {
        throw new HistoryError('HISTORY_RATE_LIMIT', 'History sync rate limit exceeded.', { statusCode: 429 });
      }
      const secret = requireHistoryIngestSecret(environment);
      if (!authorizedHistoryIngest(header(req, 'authorization'), secret)) {
        throw new HistoryError('HISTORY_UNAUTHORIZED', 'History sync authorization failed.', { statusCode: 401 });
      }
      const idempotencyKey = normalizedIdempotencyKey(header(req, 'idempotency-key'));
      const request = parseHistorySyncBody(await readBoundedBody(req));
      const summary = await service.sync({ request, idempotencyKey });
      return jsonResponse(res, 200, summary, method);
    } catch (error) {
      const result = publicHistoryError(error);
      return jsonResponse(res, result.statusCode, result.body, method);
    }
  };
}

export { StrictJsonParser, readBoundedBody };
