import {
  KEEPER_JOURNAL_MAX_BODY_BYTES,
  authorizedKeeperJournal,
  requireKeeperJournalSecret,
} from './config.mjs';
import { KeeperJournalError, publicKeeperJournalError } from './errors.mjs';
import { normalizedIdempotencyKey, parseKeeperJournalRequest } from './schema.mjs';

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function header(req, name) {
  const raw = req?.headers?.[name.toLowerCase()];
  return String(Array.isArray(raw) ? raw[0] : raw || '');
}

function jsonResponse(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(payload));
}

class StrictKeeperJsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.nodes = 0;
  }

  fail() {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_JSON',
      'Keeper journal body must be strict JSON.',
      { statusCode: 400 },
    );
  }

  whitespace() {
    while (/\s/.test(this.source[this.index] || '')) this.index += 1;
  }

  node(depth) {
    this.nodes += 1;
    if (depth > 16 || this.nodes > 512) this.fail();
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
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) this.fail();
    return parsed;
  }

  object(depth) {
    this.index += 1;
    const result = Object.create(null);
    const keys = new Set();
    this.whitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      const key = this.string();
      if (keys.has(key) || RESERVED_KEYS.has(key)) this.fail();
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

export async function readKeeperJournalBody(req) {
  const contentType = header(req, 'content-type').trim().toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_CONTENT_TYPE',
      'Keeper journal requires application/json.',
      { statusCode: 415 },
    );
  }
  const encoding = header(req, 'content-encoding').trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_CONTENT_ENCODING',
      'Compressed keeper journal bodies are not accepted.',
      { statusCode: 415 },
    );
  }
  const declared = header(req, 'content-length').trim();
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > KEEPER_JOURNAL_MAX_BODY_BYTES)) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_BODY_SIZE',
      'Keeper journal body is too large.',
      { statusCode: 413 },
    );
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    throw new KeeperJournalError('KEEPER_JOURNAL_JSON', 'Keeper journal body is unavailable.', {
      statusCode: 400,
    });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > KEEPER_JOURNAL_MAX_BODY_BYTES) {
      throw new KeeperJournalError(
        'KEEPER_JOURNAL_BODY_SIZE',
        'Keeper journal body is too large.',
        { statusCode: 413 },
      );
    }
    chunks.push(bytes);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_JSON',
      'Keeper journal body must be UTF-8 JSON.',
      { statusCode: 400 },
    );
  }
  if (!source.trim()) {
    throw new KeeperJournalError('KEEPER_JOURNAL_JSON', 'Keeper journal body is required.', {
      statusCode: 400,
    });
  }
  return new StrictKeeperJsonParser(source).document();
}

export function createKeeperJournalRateLimiter({
  limit = 60,
  windowMs = 60_000,
  now = Date.now,
  maximumKeys = 500,
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
      while (buckets.size > maximumKeys) buckets.delete(buckets.keys().next().value);
      return bucket.count <= limit;
    },
  });
}

export function createKeeperJournalHandler({
  service,
  environment = process.env,
  rateLimiter = createKeeperJournalRateLimiter(),
  clientKey = () => 'unknown',
} = {}) {
  return async function keeperJournalHandler(req, res) {
    const method = String(req.method || 'POST').toUpperCase();
    if (method !== 'POST') {
      res.setHeader('allow', 'POST');
      return jsonResponse(res, 405, { error: 'Method not allowed.', code: 'KEEPER_JOURNAL_METHOD' });
    }
    try {
      if (!rateLimiter.allow(clientKey(req))) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_RATE_LIMIT',
          'Keeper journal rate limit exceeded.',
          { statusCode: 429 },
        );
      }
      const secret = requireKeeperJournalSecret(environment);
      if (!authorizedKeeperJournal(header(req, 'authorization'), secret)) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_UNAUTHORIZED',
          'Keeper journal authorization failed.',
          { statusCode: 401 },
        );
      }
      const request = parseKeeperJournalRequest(await readKeeperJournalBody(req));
      const idempotencyKey = request.action === 'HEALTH'
        ? null
        : normalizedIdempotencyKey(header(req, 'idempotency-key'));
      const result = await service.execute({ request, idempotencyKey });
      return jsonResponse(res, request.action === 'HEALTH' && result.ready !== true ? 503 : 200, result);
    } catch (error) {
      const result = publicKeeperJournalError(error);
      return jsonResponse(res, result.statusCode, result.body);
    }
  };
}

export { StrictKeeperJsonParser };
