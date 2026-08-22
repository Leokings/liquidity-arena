import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SUCCESSFUL_KEEPER_AGE_MS = 2 * 60 * 60 * 1_000;

function requiredHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  return parsed;
}

function requiredRepository(value) {
  const repository = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository pair.');
  }
  return repository;
}

function requiredJournalSecret(value) {
  const secret = String(value || '');
  if (
    secret.length < 32
    || secret.length > 1_024
    || secret !== secret.trim()
    || /[\r\n]/u.test(secret)
  ) {
    throw new Error('KEEPER_JOURNAL_SECRET is invalid.');
  }
  return secret;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    throw new Error('response exceeded the watchdog byte limit');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('response body is unavailable');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('response exceeded the watchdog byte limit');
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

async function fetchJson(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const body = await boundedJson(response);
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

function check(name, ok, detail) {
  return Object.freeze({ name, ok: ok === true, detail: String(detail) });
}

export async function runOpsWatchdog({
  appUrl,
  journalUrl,
  journalSecret,
  githubRepository,
  githubToken,
  triggerConclusion = '',
  syntheticFailure = false,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const app = requiredHttpsUrl(appUrl, 'OPS_APP_URL');
  const journal = requiredHttpsUrl(journalUrl, 'KEEPER_JOURNAL_URL');
  const secret = requiredJournalSecret(journalSecret);
  const repository = requiredRepository(githubRepository);
  const token = String(githubToken || '');
  if (token.length < 20) throw new Error('GH_TOKEN is required.');

  const results = [];
  const conclusion = String(triggerConclusion || '').trim().toLowerCase();
  if (conclusion) {
    results.push(check(
      'keeper workflow event',
      conclusion === 'success',
      `workflow_run conclusion=${conclusion}`,
    ));
  }
  if (syntheticFailure === true) {
    results.push(check(
      'synthetic alert exercise',
      false,
      'operator-requested failure injection; production checks continue below',
    ));
  }

  try {
    const result = await fetchJson(fetchImpl, new URL('/readyz', app), {
      headers: { accept: 'application/json' },
    });
    const ready = result.ok
      && result.body?.status === 'ready'
      && result.body?.checks?.genlayerRpc?.ready === true
      && result.body?.checks?.contract?.ready === true
      && result.body?.checks?.keeperCoverage?.ready === true
      && result.body?.checks?.binance?.ready === true;
    results.push(check('application readiness', ready, `HTTP ${result.status}; status=${result.body?.status || 'unknown'}`));
  } catch (error) {
    results.push(check('application readiness', false, error?.message || 'request failed'));
  }

  try {
    const result = await fetchJson(fetchImpl, new URL('/api/history-health', app), {
      headers: { accept: 'application/json' },
    });
    const ready = result.ok
      && result.body?.status === 'ready'
      && result.body?.database?.ready === true
      && result.body?.database?.integrity?.checked === true
      && result.body?.database?.integrity?.ready === true;
    results.push(check('durable history integrity', ready, `HTTP ${result.status}; status=${result.body?.status || 'unknown'}`));
  } catch (error) {
    results.push(check('durable history integrity', false, error?.message || 'request failed'));
  }

  try {
    const result = await fetchJson(fetchImpl, journal, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'HEALTH' }),
    });
    const ready = result.ok
      && result.body?.status === 'ready'
      && result.body?.ready === true
      && result.body?.network === 'bradbury'
      && result.body?.chainId === '4221'
      && result.body?.database?.schemaVersion === 5;
    results.push(check('authoritative keeper journal', ready, `HTTP ${result.status}; schema=${result.body?.database?.schemaVersion ?? 'unknown'}`));
  } catch (error) {
    results.push(check('authoritative keeper journal', false, error?.message || 'request failed'));
  }

  try {
    const runsUrl = new URL(
      `/repos/${repository}/actions/workflows/bradbury-v8-keeper.yml/runs`,
      'https://api.github.com',
    );
    runsUrl.searchParams.set('branch', 'main');
    runsUrl.searchParams.set('status', 'completed');
    runsUrl.searchParams.set('per_page', '1');
    const result = await fetchJson(fetchImpl, runsUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'liquidity-arena-ops-watchdog',
        'x-github-api-version': '2022-11-28',
      },
    });
    const latestRun = result.body?.workflow_runs?.[0];
    const createdAt = latestRun?.created_at;
    const latestConclusion = String(latestRun?.conclusion || '').toLowerCase();
    const latestEvent = String(latestRun?.event || '').toLowerCase();
    const supportedEvent = latestEvent === 'schedule' || latestEvent === 'workflow_dispatch';
    const createdMs = Date.parse(String(createdAt || ''));
    const ageMs = Number(now()) - createdMs;
    const recent = result.ok
      && supportedEvent
      && Number.isFinite(ageMs)
      && ageMs >= 0
      && ageMs <= MAX_SUCCESSFUL_KEEPER_AGE_MS
      && latestConclusion === 'success';
    results.push(check(
      'recent successful keeper reconciliation',
      recent,
      result.ok && Number.isFinite(ageMs)
        ? `latest completed run event=${latestEvent || 'unknown'}; conclusion=${latestConclusion || 'unknown'}; age=${Math.round(ageMs / 60_000)}m`
        : `HTTP ${result.status}; no valid completed run`,
    ));
  } catch (error) {
    results.push(check('recent successful keeper reconciliation', false, error?.message || 'request failed'));
  }

  return Object.freeze({
    healthy: results.every((item) => item.ok),
    checkedAt: new Date(Number(now())).toISOString(),
    checks: Object.freeze(results),
  });
}

export function watchdogMarkdown(result) {
  const lines = [
    '# Bradbury V8 liquidity arena watchdog',
    '',
    `Overall: **${result.healthy ? 'PASS' : 'FAIL'}**`,
    '',
    `Checked: ${result.checkedAt}`,
    '',
  ];
  for (const item of result.checks) {
    lines.push(`- ${item.ok ? 'PASS' : 'FAIL'} — ${item.name}: ${item.detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const result = await runOpsWatchdog({
    appUrl: process.env.OPS_APP_URL,
    journalUrl: process.env.KEEPER_JOURNAL_URL,
    journalSecret: process.env.KEEPER_JOURNAL_SECRET,
    githubRepository: process.env.GITHUB_REPOSITORY,
    githubToken: process.env.GH_TOKEN,
    triggerConclusion: process.env.WATCHDOG_TRIGGER_CONCLUSION,
    syntheticFailure: process.env.WATCHDOG_SYNTHETIC_FAILURE === 'true',
  });
  const report = watchdogMarkdown(result);
  const reportPath = String(process.env.WATCHDOG_REPORT_PATH || '').trim();
  if (reportPath) await writeFile(reportPath, report, { encoding: 'utf8', flag: 'w' });
  process.stdout.write(report);
  if (!result.healthy) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failed = Object.freeze({
      healthy: false,
      checkedAt: new Date().toISOString(),
      checks: Object.freeze([
        check('watchdog configuration', false, error?.message || 'unknown error'),
      ]),
    });
    const report = watchdogMarkdown(failed);
    const reportPath = String(process.env.WATCHDOG_REPORT_PATH || '').trim();
    Promise.resolve(reportPath
      ? writeFile(reportPath, report, { encoding: 'utf8', flag: 'w' })
      : undefined)
      .catch(() => {})
      .finally(() => {
        process.stderr.write(report);
        process.exitCode = 1;
      });
  });
}

export {
  MAX_SUCCESSFUL_KEEPER_AGE_MS,
  REQUEST_TIMEOUT_MS,
  RESPONSE_LIMIT_BYTES,
};
