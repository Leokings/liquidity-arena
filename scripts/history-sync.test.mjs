import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHistorySyncArguments, runHistorySyncCli } from './history-sync.mjs';

test('history sync CLI parses only bounded selector and proof assertions', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const parsed = parseHistorySyncArguments([
    '--deployment', 'v7',
    '--max-epochs', '5',
    '--proof', `v7:${hash}:resolve_epoch`,
    '--no-known-proofs',
  ]);
  assert.deepEqual(parsed.deployments, ['v7']);
  assert.equal(parsed.proofs[0].kind, 'RESOLVE_EPOCH');
  assert.equal(parsed.includeKnownProofs, false);
  assert.throws(() => parseHistorySyncArguments(['--winner', 'BTC']), /Unknown option/);
});

test('history sync CLI sends the secret only in Authorization and never logs it', async () => {
  const secret = 'z'.repeat(32);
  let captured;
  const logs = [];
  const result = await runHistorySyncCli(
    ['--deployment', 'v7', '--max-epochs', '1', '--no-known-proofs'],
    {
      environment: {
        HISTORY_SYNC_URL: 'https://liquidity.example.test/api/history-sync',
        HISTORY_INGEST_SECRET: secret,
      },
      now: () => Date.parse('2026-08-19T18:30:00Z'),
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return new Response(JSON.stringify({ status: 'ok', epochsSynced: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      log: (value) => logs.push(JSON.stringify(value)),
    },
  );
  assert.equal(result.epochsSynced, 1);
  assert.equal(captured.options.headers.authorization, `Bearer ${secret}`);
  assert.match(captured.options.headers['idempotency-key'], /^history-sync:/);
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body.deployments, ['v7']);
  assert.equal(body.maxEpochs, 1);
  assert.equal(logs.join('\n').includes(secret), false);
});

test('history sync CLI permits HTTP only for loopback tests and rejects short secrets', async () => {
  await assert.rejects(
    () => runHistorySyncCli([], {
      environment: { HISTORY_SYNC_URL: 'http://example.test/api/history-sync', HISTORY_INGEST_SECRET: 'x'.repeat(32) },
      fetchImpl: async () => { throw new Error('must not run'); },
    }),
    /must use HTTPS/,
  );
  await assert.rejects(
    () => runHistorySyncCli([], {
      environment: { HISTORY_SYNC_URL: 'http://127.0.0.1:4400/api/history-sync', HISTORY_INGEST_SECRET: 'short' },
      fetchImpl: async () => { throw new Error('must not run'); },
    }),
    /not configured/,
  );
});

test('history sync CLI cancels an oversized streaming response before parsing it', async () => {
  await assert.rejects(
    () => runHistorySyncCli([], {
      environment: {
        HISTORY_SYNC_URL: 'https://liquidity.example.test/api/history-sync',
        HISTORY_INGEST_SECRET: 'x'.repeat(32),
      },
      fetchImpl: async () => new Response('x'.repeat((64 * 1024) + 1), { status: 200 }),
      log: () => {},
    }),
    /response is too large/,
  );
});
