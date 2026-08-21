const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_REPOSITORY = 'Leokings/liquidity-arena';
const GITHUB_REF = 'main';
const RESPONSE_LIMIT_BYTES = 96 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const TARGETS = Object.freeze({
  '37 * * * *': Object.freeze({
    name: 'keeper',
    workflow: 'studionet-v7-keeper.yml',
    events: Object.freeze(['schedule', 'workflow_dispatch']),
    inputs: null,
  }),
  '57 * * * *': Object.freeze({
    name: 'watchdog',
    workflow: 'studionet-ops-watchdog.yml',
    events: Object.freeze(['schedule', 'workflow_dispatch', 'workflow_run']),
    inputs: Object.freeze({ synthetic_failure: 'false' }),
  }),
});

const ACTIVE_RUN_STATUSES = new Set([
  'in_progress',
  'pending',
  'queued',
  'requested',
  'waiting',
]);

function requiredDispatchToken(value) {
  const token = String(value || '');
  if (
    token.length < 20
    || token.length > 1_024
    || token !== token.trim()
    || /[\0\r\n]/u.test(token)
  ) {
    throw new Error('CLOUDFLARE_GITHUB_TOKEN is invalid.');
  }
  return token;
}

function requiredScheduledTime(value) {
  const scheduledTime = Number(value);
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0) {
    throw new Error('The Cloudflare scheduled timestamp is invalid.');
  }
  return scheduledTime;
}

function requiredTarget(cron) {
  const target = TARGETS[String(cron || '')];
  if (!target) throw new Error('The Cloudflare cron expression is not allowlisted.');
  return target;
}

function githubHeaders(token, includeContentType = false) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    ...(includeContentType ? { 'content-type': 'application/json' } : {}),
    'user-agent': 'liquidity-arena-cloudflare-scheduler/1.0',
    'x-github-api-version': GITHUB_API_VERSION,
  };
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    throw new Error('GitHub response exceeded the scheduler byte limit.');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('GitHub response body is unavailable.');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('GitHub response exceeded the scheduler byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function fetchWithTimeout(fetchImpl, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function currentUtcSlotStart(scheduledTime) {
  const slot = new Date(scheduledTime);
  slot.setUTCMinutes(0, 0, 0);
  return slot.getTime();
}

function safeRunId(run) {
  const id = Number(run?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function evaluateRuns(workflowRuns, target, scheduledTime) {
  if (!Array.isArray(workflowRuns)) {
    throw new Error('GitHub returned an invalid workflow-runs response.');
  }
  const slotStart = currentUtcSlotStart(scheduledTime);
  const relevant = workflowRuns.filter((run) => {
    const createdAt = Date.parse(String(run?.created_at || ''));
    return run?.head_branch === GITHUB_REF
      && target.events.includes(String(run?.event || ''))
      && Number.isFinite(createdAt)
      && createdAt >= slotStart
      && createdAt <= scheduledTime + (5 * 60 * 1_000);
  });

  const active = relevant.find((run) => ACTIVE_RUN_STATUSES.has(String(run?.status || '')));
  if (active) {
    return Object.freeze({ dispatch: false, reason: 'current_hour_run_active', runId: safeRunId(active) });
  }
  const successful = relevant.find((run) => (
    String(run?.status || '') === 'completed'
    && String(run?.conclusion || '') === 'success'
  ));
  if (successful) {
    return Object.freeze({ dispatch: false, reason: 'current_hour_run_succeeded', runId: safeRunId(successful) });
  }
  return Object.freeze({ dispatch: true, reason: relevant.length ? 'current_hour_runs_failed' : 'current_hour_run_missing', runId: null });
}

async function preflight({ fetchImpl, target, token, scheduledTime }) {
  const url = new URL(
    `/repos/${GITHUB_REPOSITORY}/actions/workflows/${target.workflow}/runs`,
    GITHUB_API_ORIGIN,
  );
  url.searchParams.set('branch', GITHUB_REF);
  url.searchParams.set('created', `>=${new Date(currentUtcSlotStart(scheduledTime)).toISOString()}`);
  url.searchParams.set('per_page', '5');

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: githubHeaders(token),
    });
  } catch {
    return Object.freeze({ dispatch: true, reason: 'preflight_network_failure', runId: null });
  }

  if ([401, 403, 404].includes(response.status)) {
    throw new Error(`GitHub preflight authorization or configuration failed (HTTP ${response.status}).`);
  }
  if (response.status === 429 || response.status >= 500) {
    return Object.freeze({ dispatch: true, reason: `preflight_http_${response.status}`, runId: null });
  }
  if (!response.ok) {
    throw new Error(`GitHub preflight failed (HTTP ${response.status}).`);
  }

  let body;
  try {
    body = await boundedJson(response);
  } catch {
    throw new Error('GitHub preflight returned an invalid response.');
  }
  return evaluateRuns(body?.workflow_runs, target, scheduledTime);
}

async function dispatch({ fetchImpl, target, token }) {
  const url = new URL(
    `/repos/${GITHUB_REPOSITORY}/actions/workflows/${target.workflow}/dispatches`,
    GITHUB_API_ORIGIN,
  );
  const body = { ref: GITHUB_REF };
  if (target.inputs) body.inputs = target.inputs;

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: githubHeaders(token, true),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('GitHub workflow dispatch request failed.');
  }
  if (!response.ok || ![200, 204].includes(response.status)) {
    throw new Error(`GitHub workflow dispatch failed (HTTP ${response.status}).`);
  }
  if (response.status === 204) return Object.freeze({ runId: null });

  let responseBody;
  try {
    responseBody = await boundedJson(response);
  } catch {
    throw new Error('GitHub workflow dispatch returned an invalid response.');
  }
  return Object.freeze({ runId: safeRunId({ id: responseBody?.workflow_run_id }) });
}

export async function runScheduledBackup({
  cron,
  scheduledTime,
  token,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const target = requiredTarget(cron);
  const time = requiredScheduledTime(scheduledTime);
  const dispatchToken = requiredDispatchToken(token);
  const slot = new Date(currentUtcSlotStart(time)).toISOString();
  const decision = await preflight({ fetchImpl, target, token: dispatchToken, scheduledTime: time });

  if (!decision.dispatch) {
    const result = Object.freeze({
      status: 'skipped',
      target: target.name,
      cron: String(cron),
      slot,
      reason: decision.reason,
      runId: decision.runId,
    });
    logger.log(JSON.stringify({ event: 'CLOUDFLARE_BACKUP_SKIPPED', ...result }));
    return result;
  }

  const dispatched = await dispatch({ fetchImpl, target, token: dispatchToken });
  const result = Object.freeze({
    status: 'dispatched',
    target: target.name,
    cron: String(cron),
    slot,
    reason: decision.reason,
    runId: dispatched.runId,
  });
  logger.log(JSON.stringify({ event: 'CLOUDFLARE_BACKUP_DISPATCHED', ...result }));
  return result;
}

export const schedulerConfiguration = Object.freeze({
  repository: GITHUB_REPOSITORY,
  ref: GITHUB_REF,
  crons: Object.freeze(Object.keys(TARGETS)),
});
