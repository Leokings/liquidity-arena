import assert from 'node:assert/strict';
import test from 'node:test';

import { runScheduledBackup, schedulerConfiguration } from './dispatch.mjs';
import worker from './worker.mjs';

const TOKEN = 'github_pat_scheduler_test_value_123456789';
const SCHEDULED_TIME = Date.parse('2026-08-21T08:37:00.000Z');

function response(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

function logger() {
  const lines = [];
  return { lines, log: (value) => lines.push(String(value)) };
}

test('configuration exposes only the two allowlisted backup cron expressions', () => {
  assert.deepEqual(schedulerConfiguration, {
    repository: 'Leokings/liquidity-arena',
    ref: 'main',
    crons: ['37 * * * *', '57 * * * *'],
  });
  assert.equal('fetch' in worker, false);
});

test('missing current-hour keeper run dispatches main with exact bounded credentials', async () => {
  const requests = [];
  const output = logger();
  const result = await runScheduledBackup({
    cron: '37 * * * *',
    scheduledTime: SCHEDULED_TIME,
    token: TOKEN,
    logger: output,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) return response({ workflow_runs: [] });
      return response({ workflow_run_id: 12345 });
    },
  });

  assert.equal(result.status, 'dispatched');
  assert.equal(result.target, 'keeper');
  assert.equal(result.reason, 'current_hour_run_missing');
  assert.equal(result.runId, 12345);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].url.pathname, '/repos/Leokings/liquidity-arena/actions/workflows/bradbury-v8-keeper.yml/runs');
  assert.equal(requests[0].url.searchParams.get('branch'), 'main');
  assert.equal(requests[0].url.searchParams.get('created'), '>=2026-08-21T08:00:00.000Z');
  assert.equal(requests[0].url.searchParams.get('per_page'), '5');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].url.pathname, '/repos/Leokings/liquidity-arena/actions/workflows/bradbury-v8-keeper.yml/dispatches');
  assert.deepEqual(JSON.parse(requests[1].options.body), { ref: 'main' });
  assert.equal(requests[1].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[1].options.headers['x-github-api-version'], '2026-03-10');
  assert.doesNotMatch(output.lines.join('\n'), new RegExp(TOKEN));
});

test('watchdog backup uses the watchdog workflow and disables synthetic failure', async () => {
  const requests = [];
  const result = await runScheduledBackup({
    cron: '57 * * * *',
    scheduledTime: Date.parse('2026-08-21T08:57:00.000Z'),
    token: TOKEN,
    logger: logger(),
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) return response({ workflow_runs: [] });
      return response(null, 204);
    },
  });

  assert.equal(result.status, 'dispatched');
  assert.equal(result.target, 'watchdog');
  assert.equal(result.runId, null);
  assert.equal(requests[0].url.pathname, '/repos/Leokings/liquidity-arena/actions/workflows/bradbury-v8-ops-watchdog.yml/runs');
  assert.equal(requests[1].url.pathname, '/repos/Leokings/liquidity-arena/actions/workflows/bradbury-v8-ops-watchdog.yml/dispatches');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    ref: 'main',
    inputs: { synthetic_failure: 'false' },
  });
});

for (const run of [
  { status: 'in_progress', conclusion: null, event: 'schedule' },
  { status: 'completed', conclusion: 'success', event: 'workflow_dispatch' },
]) {
  test(`current-hour ${run.status} keeper run skips backup dispatch`, async () => {
    let requests = 0;
    const result = await runScheduledBackup({
      cron: '37 * * * *',
      scheduledTime: SCHEDULED_TIME,
      token: TOKEN,
      logger: logger(),
      fetchImpl: async () => {
        requests += 1;
        return response({
          workflow_runs: [{
            id: 77,
            head_branch: 'main',
            event: run.event,
            status: run.status,
            conclusion: run.conclusion,
            created_at: '2026-08-21T08:31:00.000Z',
          }],
        });
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.runId, 77);
    assert.equal(requests, 1);
  });
}

test('old or failed keeper runs do not suppress the backup dispatch', async () => {
  const cases = [
    { status: 'completed', conclusion: 'success', created_at: '2026-08-21T07:59:59.999Z' },
    { status: 'completed', conclusion: 'failure', created_at: '2026-08-21T08:30:00.000Z' },
  ];
  for (const item of cases) {
    let requests = 0;
    const result = await runScheduledBackup({
      cron: '37 * * * *',
      scheduledTime: SCHEDULED_TIME,
      token: TOKEN,
      logger: logger(),
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? response({ workflow_runs: [{
            id: 88,
            head_branch: 'main',
            event: 'schedule',
            ...item,
          }] })
          : response({ workflow_run_id: 99 });
      },
    });
    assert.equal(result.status, 'dispatched');
    assert.equal(requests, 2);
  }
});

test('bounded current-hour query accepts five realistic large workflow records', async () => {
  let requests = 0;
  const workflowRuns = Array.from({ length: 5 }, (_, index) => ({
    id: 200 + index,
    head_branch: 'main',
    event: index === 4 ? 'workflow_dispatch' : 'schedule',
    status: index === 4 ? 'completed' : 'completed',
    conclusion: index === 4 ? 'success' : 'failure',
    created_at: `2026-08-21T08:${String(20 + index).padStart(2, '0')}:00.000Z`,
    actor: { login: 'scheduler-fixture', avatar_url: `https://example.test/${'x'.repeat(9_000)}` },
  }));
  const result = await runScheduledBackup({
    cron: '37 * * * *',
    scheduledTime: SCHEDULED_TIME,
    token: TOKEN,
    logger: logger(),
    fetchImpl: async (url) => {
      requests += 1;
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('created'), '>=2026-08-21T08:00:00.000Z');
      assert.equal(parsed.searchParams.get('per_page'), '5');
      return response({ workflow_runs: workflowRuns });
    },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'current_hour_run_succeeded');
  assert.equal(result.runId, 204);
  assert.equal(requests, 1);
});

test('preflight network, rate-limit, and server failures fail open to dispatch', async () => {
  for (const mode of ['network', 429, 503]) {
    let requests = 0;
    const result = await runScheduledBackup({
      cron: '37 * * * *',
      scheduledTime: SCHEDULED_TIME,
      token: TOKEN,
      logger: logger(),
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) {
          if (mode === 'network') throw new Error(`sensitive ${TOKEN}`);
          return response({ message: 'temporarily unavailable' }, mode);
        }
        return response({ workflow_run_id: 101 });
      },
    });
    assert.equal(result.status, 'dispatched');
    assert.equal(requests, 2);
  }
});

test('authorization and configuration failures stop without a dispatch', async () => {
  for (const status of [401, 403, 404]) {
    let requests = 0;
    await assert.rejects(
      () => runScheduledBackup({
        cron: '37 * * * *',
        scheduledTime: SCHEDULED_TIME,
        token: TOKEN,
        logger: logger(),
        fetchImpl: async () => {
          requests += 1;
          return response({ message: `sensitive ${TOKEN}` }, status);
        },
      }),
      (error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, new RegExp(TOKEN));
        return true;
      },
    );
    assert.equal(requests, 1);
  }
});

test('dispatch failure is reported without disclosing token or response body', async () => {
  let requests = 0;
  await assert.rejects(
    () => runScheduledBackup({
      cron: '37 * * * *',
      scheduledTime: SCHEDULED_TIME,
      token: TOKEN,
      logger: logger(),
      fetchImpl: async () => {
        requests += 1;
        return requests === 1
          ? response({ workflow_runs: [] })
          : response({ message: `sensitive ${TOKEN}` }, 500);
      },
    }),
    (error) => {
      assert.equal(error.message, 'GitHub workflow dispatch failed (HTTP 500).');
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    },
  );
  assert.equal(requests, 2);
});

test('malformed token and unknown cron fail before any request', async () => {
  let requests = 0;
  for (const options of [
    { cron: '37 * * * *', token: `${TOKEN}\nleak` },
    { cron: '38 * * * *', token: TOKEN },
  ]) {
    await assert.rejects(
      () => runScheduledBackup({
        ...options,
        scheduledTime: SCHEDULED_TIME,
        fetchImpl: async () => { requests += 1; },
      }),
      /invalid|allowlisted/,
    );
  }
  assert.equal(requests, 0);
});

test('worker schedules through waitUntil and has no public request handler', async () => {
  const promises = [];
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests += 1;
    return requests === 1
      ? response({ workflow_runs: [{
        id: 111,
        head_branch: 'main',
        event: 'schedule',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-21T08:30:00.000Z',
      }] })
      : response({ workflow_run_id: 112 });
  };
  try {
    worker.scheduled(
      { cron: '37 * * * *', scheduledTime: SCHEDULED_TIME },
      { CLOUDFLARE_GITHUB_TOKEN: TOKEN },
      { waitUntil: (promise) => promises.push(promise) },
    );
    assert.equal(promises.length, 1);
    const result = await promises[0];
    assert.equal(result.status, 'skipped');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests, 1);
});
