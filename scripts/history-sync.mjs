import { fileURLToPath } from 'node:url';

import { requireHistoryIngestSecret } from '../history/config.mjs';
import {
  canonicalSyncRequestHash,
  normalizedIdempotencyKey,
  parseHistorySyncBody,
} from '../history/schema.mjs';

const RESPONSE_MAX_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 100_000;

function usage() {
  return `Synchronize durable StudioNet epoch history through the authenticated API.

Usage:
  node scripts/history-sync.mjs [options]

Options:
  --url <https-url>          Sync endpoint (or HISTORY_SYNC_URL)
  --deployment <v6|v7>      Deployment alias; may be repeated
  --start-offset <integer>   Bounded contract epoch-page offset
  --max-epochs <1-10>        Total epoch work budget (default 10)
  --proof <alias:hash:kind>  Finalized proof assertion; may be repeated
  --no-known-proofs          Do not verify bundled proof hints
  --idempotency-key <key>    Explicit safe idempotency key
  --help                     Show this help

HISTORY_INGEST_SECRET is required and is never printed.`;
}

function endpointUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('HISTORY_SYNC_URL must be an absolute URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.hash) {
    throw new Error('HISTORY_SYNC_URL must use HTTPS, except for loopback testing, and contain no credentials.');
  }
  return url.href;
}

function proofArgument(value) {
  const match = /^(v6|v7):(0x[0-9a-fA-F]{64}):([A-Za-z_]+)$/.exec(String(value || ''));
  if (!match) throw new Error('--proof must be alias:0x-hash:kind.');
  return { deployment: match[1], hash: match[2], kind: match[3].toUpperCase() };
}

export function parseHistorySyncArguments(argv) {
  const result = { deployments: [], proofs: [], includeKnownProofs: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--no-known-proofs') result.includeKnownProofs = false;
    else if (['--url', '--deployment', '--start-offset', '--max-epochs', '--proof', '--idempotency-key'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--url') result.url = value;
      else if (argument === '--deployment') result.deployments.push(value);
      else if (argument === '--start-offset') result.startOffset = value;
      else if (argument === '--max-epochs') result.maxEpochs = value;
      else if (argument === '--proof') result.proofs.push(proofArgument(value));
      else result.idempotencyKey = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}

function defaultIdempotencyKey(request, now) {
  const hour = new Date(now()).toISOString().slice(0, 13).replace(/[-T:]/g, '');
  return `history-sync:${hour}:${canonicalSyncRequestHash(request).slice(0, 16)}`;
}

async function boundedResponse(response) {
  const declared = String(response?.headers?.get?.('content-length') || '');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_MAX_BYTES)) {
    throw new Error('History sync response is too large.');
  }
  const chunks = [];
  let total = 0;
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('History sync response is too large.');
      }
      chunks.push(value);
    }
  } else {
    const value = Buffer.from(await response.text(), 'utf8');
    total = value.byteLength;
    chunks.push(value);
  }
  if (total > RESPONSE_MAX_BYTES) throw new Error('History sync response is too large.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new Error('History sync endpoint returned invalid UTF-8.');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('History sync endpoint returned invalid JSON.');
  }
  if (!response.ok) {
    const code = String(payload?.code || 'HISTORY_SYNC_HTTP').slice(0, 80);
    throw new Error(`History sync failed (${response.status}, ${code}).`);
  }
  if (!payload || payload.status !== 'ok') throw new Error('History sync endpoint returned an invalid success response.');
  return payload;
}

export async function runHistorySyncCli(
  argv = process.argv.slice(2),
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    log = (value) => console.log(JSON.stringify(value)),
  } = {},
) {
  const parsed = parseHistorySyncArguments(argv);
  if (parsed.help) {
    log(usage());
    return undefined;
  }
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  const url = endpointUrl(parsed.url || environment.HISTORY_SYNC_URL);
  const secret = requireHistoryIngestSecret(environment);
  const request = parseHistorySyncBody({
    ...(parsed.deployments.length > 0 ? { deployments: parsed.deployments } : {}),
    ...(parsed.startOffset !== undefined ? { startOffset: parsed.startOffset } : {}),
    ...(parsed.maxEpochs !== undefined ? { maxEpochs: parsed.maxEpochs } : { maxEpochs: 10 }),
    proofs: parsed.proofs,
    includeKnownProofs: parsed.includeKnownProofs,
  });
  const idempotencyKey = normalizedIdempotencyKey(
    parsed.idempotencyKey || defaultIdempotencyKey(request, now),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const payload = await boundedResponse(response);
  log(payload);
  return payload;
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && process.argv[1] === invokedPath) {
  runHistorySyncCli().catch((error) => {
    console.error(JSON.stringify({
      event: 'HISTORY_SYNC_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}

export { usage };
