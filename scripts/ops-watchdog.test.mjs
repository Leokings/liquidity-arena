import assert from 'node:assert/strict';
import test from 'node:test';

import { runOpsWatchdog, watchdogMarkdown } from './ops-watchdog.mjs';

const NOW = Date.parse('2026-08-21T07:00:00.000Z');
const SECRET = 'journal-secret-'.padEnd(40, 'x');

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function healthyFetch(requests) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    if (parsed.pathname === '/readyz') {
      return response({
        status: 'ready',
        checks: {
          genlayerRpc: { ready: true },
          contract: { ready: true },
          keeperCoverage: { ready: true },
          binance: { ready: true },
        },
      });
    }
    if (parsed.pathname === '/api/history-health') {
      return response({
        status: 'ready',
        database: { ready: true, integrity: { checked: true, ready: true } },
      });
    }
    if (parsed.pathname === '/api/keeper-journal') {
      return response({ status: 'ready', ready: true, database: { schemaVersion: 3 } });
    }
    if (parsed.pathname.endsWith('/actions/workflows/studionet-v7-keeper.yml/runs')) {
      return response({ workflow_runs: [{ created_at: '2026-08-21T06:00:00.000Z', conclusion: 'success' }] });
    }
    throw new Error(`unexpected URL ${parsed}`);
  };
}

test('watchdog proves readiness, history integrity, journal schema, and recent schedule without leaking secrets', async () => {
  const requests = [];
  const result = await runOpsWatchdog({
    appUrl: 'https://liquidity-arena.example.test',
    journalUrl: 'https://liquidity-arena.example.test/api/keeper-journal',
    journalSecret: SECRET,
    githubRepository: 'Leokings/liquidity-arena',
    githubToken: 'github-token-value-long-enough',
    fetchImpl: healthyFetch(requests),
    now: () => NOW,
  });

  assert.equal(result.healthy, true);
  assert.equal(result.checks.length, 4);
  assert.equal(requests.length, 4);
  const journal = requests.find(({ url }) => url.pathname === '/api/keeper-journal');
  assert.equal(journal.options.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(journal.options.body), { action: 'HEALTH' });
  const report = watchdogMarkdown(result);
  assert.match(report, /Overall: \*\*PASS\*\*/);
  assert.doesNotMatch(report, new RegExp(SECRET));
});

test('watchdog fails on a failed workflow event, stale schedule, and degraded history', async () => {
  const requests = [];
  const fetchImpl = healthyFetch(requests);
  const result = await runOpsWatchdog({
    appUrl: 'https://liquidity-arena.example.test',
    journalUrl: 'https://liquidity-arena.example.test/api/keeper-journal',
    journalSecret: SECRET,
    githubRepository: 'Leokings/liquidity-arena',
    githubToken: 'github-token-value-long-enough',
    triggerConclusion: 'failure',
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/history-health') {
        return response({ status: 'degraded', database: { ready: false, integrity: { ready: false } } }, 503);
      }
      if (parsed.pathname.endsWith('/actions/workflows/studionet-v7-keeper.yml/runs')) {
        return response({ workflow_runs: [{ created_at: '2026-08-21T03:00:00.000Z', conclusion: 'success' }] });
      }
      return fetchImpl(url, options);
    },
    now: () => NOW,
  });

  assert.equal(result.healthy, false);
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks.find(({ name }) => name === 'keeper workflow event').ok, false);
  assert.equal(result.checks.find(({ name }) => name === 'durable history integrity').ok, false);
  assert.equal(result.checks.find(({ name }) => name === 'recent scheduled keeper run').ok, false);
  assert.match(watchdogMarkdown(result), /Overall: \*\*FAIL\*\*/);
});

test('watchdog stays degraded when the latest scheduled keeper run failed', async () => {
  const requests = [];
  const fetchImpl = healthyFetch(requests);
  const result = await runOpsWatchdog({
    appUrl: 'https://liquidity-arena.example.test',
    journalUrl: 'https://liquidity-arena.example.test/api/keeper-journal',
    journalSecret: SECRET,
    githubRepository: 'Leokings/liquidity-arena',
    githubToken: 'github-token-value-long-enough',
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/actions/workflows/studionet-v7-keeper.yml/runs')) {
        assert.equal(parsed.searchParams.get('status'), 'completed');
        return response({
          workflow_runs: [{
            created_at: '2026-08-21T06:30:00.000Z',
            conclusion: 'failure',
          }],
        });
      }
      return fetchImpl(url, options);
    },
    now: () => NOW,
  });

  assert.equal(result.healthy, false);
  const schedule = result.checks.find(({ name }) => name === 'recent scheduled keeper run');
  assert.equal(schedule.ok, false);
  assert.match(schedule.detail, /conclusion=failure/);
});

test('watchdog validates configuration before making any request', async () => {
  let requests = 0;
  await assert.rejects(
    () => runOpsWatchdog({
      appUrl: 'http://liquidity-arena.example.test',
      journalUrl: 'https://liquidity-arena.example.test/api/keeper-journal',
      journalSecret: SECRET,
      githubRepository: 'Leokings/liquidity-arena',
      githubToken: 'github-token-value-long-enough',
      fetchImpl: async () => { requests += 1; },
    }),
    /HTTPS URL/,
  );
  assert.equal(requests, 0);
});

test('watchdog rejects malformed multiline journal secrets without disclosing them', async () => {
  const malformed = `${SECRET}\nprivate-suffix`;
  let requests = 0;
  await assert.rejects(
    () => runOpsWatchdog({
      appUrl: 'https://liquidity-arena.example.test',
      journalUrl: 'https://liquidity-arena.example.test/api/keeper-journal',
      journalSecret: malformed,
      githubRepository: 'Leokings/liquidity-arena',
      githubToken: 'github-token-value-long-enough',
      fetchImpl: async () => { requests += 1; },
    }),
    (error) => {
      assert.equal(error.message, 'KEEPER_JOURNAL_SECRET is invalid.');
      assert.doesNotMatch(error.message, /private-suffix/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    },
  );
  assert.equal(requests, 0);
});
