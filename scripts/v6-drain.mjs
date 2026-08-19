#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertEpochMatchesConfiguration,
  assertV6ContractConfiguration,
  classifyOpenEpoch,
  createCliV6KeeperOperator,
  validateReceiptIdentity,
} from './v6-keeper.mjs';
import {
  loadV6KeeperConfig,
  V6_NETWORK,
} from './v6-keeper-config.mjs';

const RESOLUTION_STATUSES = new Set(['RESOLVED', 'UNDETERMINED']);
const RESOLVED_SETTLEMENT_MODES = new Set([
  'PARIMUTUEL',
  'REFUND_TIE',
  'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE',
]);

export class V6DrainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'V6DrainError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new V6DrainError(code, message, details);
}

function chainField(value, snakeCase, camelCase) {
  return value?.[snakeCase] ?? value?.[camelCase];
}

function integerText(value, field) {
  const raw = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  const normalized = /^\d+n$/.test(raw) ? raw.slice(0, -1) : raw;
  if (!/^\d+$/.test(normalized)) fail('CHAIN_SCHEMA', `${field} must be a nonnegative integer`);
  return normalized;
}

function safeInteger(value, field) {
  const normalized = integerText(value, field);
  const result = Number(normalized);
  if (!Number.isSafeInteger(result)) fail('CHAIN_SCHEMA', `${field} exceeds a safe integer`);
  return result;
}

function epochTimestamp(value) {
  const result = safeInteger(value, 'epoch ID');
  if (result <= 0 || result % 3_600 !== 0) {
    fail('CHAIN_SCHEMA', `Epoch ID ${result} is not an exact UTC hour`);
  }
  return result;
}

function exactText(value, expected, field) {
  if (String(value ?? '') !== expected) {
    fail('POST_STATE_MISMATCH', `${field} must be ${expected}; received ${value ?? '(missing)'}`);
  }
}

async function withRetries(task, {
  attempts,
  baseMs,
  sleep,
  label,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(baseMs * (2 ** (attempt - 1)));
    }
  }
  throw new V6DrainError('RETRY_EXHAUSTED', `${label} failed after ${attempts} attempts`, {
    cause: lastError,
  });
}

async function readChain(context, label, task) {
  return withRetries(task, {
    attempts: context.config.operator.readAttempts,
    baseMs: context.config.operator.retryBaseMs,
    sleep: context.sleep,
    label,
  });
}

function assertStudioNet(networkInfo) {
  const alias = String(networkInfo?.alias ?? '').trim().toLowerCase();
  if (alias !== V6_NETWORK) {
    fail(
      'NETWORK_MISMATCH',
      `Active GenLayer network must be ${V6_NETWORK}; received ${alias || '(missing)'}`,
    );
  }
}

function assertActiveSigner(accountInfo, canSignLockedAccount) {
  const address = String(accountInfo?.address ?? '').trim().toLowerCase();
  if (!/^0x[\da-f]{40}$/.test(address) || /^0x0{40}$/.test(address) || accountInfo?.active !== true) {
    fail('ACCOUNT_INACTIVE', 'An active nonzero GenLayer account is required for drain execution');
  }
  const status = String(accountInfo?.status ?? '').trim().toLowerCase();
  if (status !== 'unlocked' && !canSignLockedAccount) {
    fail(
      'ACCOUNT_LOCKED',
      'The active account is locked and GENLAYER_KEYSTORE_PASSWORD was not supplied',
    );
  }
  return address;
}

async function fetchEpoch(context, epochEndTimestamp) {
  const epoch = await readChain(
    context,
    `get_epoch(${epochEndTimestamp})`,
    () => context.operator.getEpoch(epochEndTimestamp),
  );
  return assertEpochMatchesConfiguration(context.config, epoch, epochEndTimestamp);
}

async function fetchEpochSnapshot(context) {
  const rawCount = await readChain(
    context,
    'get_epoch_count',
    () => context.operator.getEpochCount(),
  );
  const snapshotCount = safeInteger(rawCount, 'get_epoch_count');
  const epochIds = [];
  let offset = 0;

  while (offset < snapshotCount) {
    const limit = Math.min(context.config.operator.pageSize, snapshotCount - offset);
    const page = await readChain(
      context,
      `get_epoch_page(${offset}, ${limit})`,
      () => context.operator.getEpochPage(offset, limit),
    );
    const pageOffset = safeInteger(page?.offset, 'epoch page offset');
    const nextOffset = safeInteger(
      chainField(page, 'next_offset', 'nextOffset'),
      'epoch page next_offset',
    );
    const total = safeInteger(page?.total, 'epoch page total');
    const ids = page?.epoch_ids ?? page?.epochIds;
    if (pageOffset !== offset
      || nextOffset <= offset
      || nextOffset > snapshotCount
      || total < snapshotCount
      || !Array.isArray(ids)
      || ids.length !== nextOffset - offset) {
      fail('CHAIN_SCHEMA', 'get_epoch_page returned inconsistent snapshot pagination');
    }
    epochIds.push(...ids.map(epochTimestamp));
    offset = nextOffset;
    if (offset < snapshotCount && context.config.operator.scanIntervalMs > 0) {
      await context.sleep(context.config.operator.scanIntervalMs);
    }
  }

  if (new Set(epochIds).size !== epochIds.length) {
    fail('CHAIN_SCHEMA', 'get_epoch_page returned duplicate epoch IDs');
  }
  return Object.freeze(epochIds);
}

export async function planV6DrainRun(context) {
  const epochIds = await fetchEpochSnapshot(context);
  const actions = [];
  let openEpochCount = 0;

  for (const [index, epochEndTimestamp] of epochIds.entries()) {
    const epoch = await fetchEpoch(context, epochEndTimestamp);
    if (String(epoch?.status ?? '') === 'OPEN') openEpochCount += 1;
    const type = classifyOpenEpoch(epoch, context.nowEpochSeconds);
    if (type) actions.push(Object.freeze({ type, epochEndTimestamp }));
    if (index + 1 < epochIds.length && context.config.operator.scanIntervalMs > 0) {
      await context.sleep(context.config.operator.scanIntervalMs);
    }
  }

  const priority = { TIMEOUT: 0, RESOLVE: 1 };
  actions.sort((left, right) => priority[left.type] - priority[right.type]
    || left.epochEndTimestamp - right.epochEndTimestamp);
  const selected = actions.slice(0, context.config.operator.maxWritesPerRun);
  return Object.freeze({
    scannedEpochCount: epochIds.length,
    openEpochCount,
    actions: Object.freeze(selected),
    deferredActionCount: actions.length - selected.length,
  });
}

function settlementMode(epoch, objective) {
  const record = epoch?.[objective.toLowerCase()];
  return String(record?.settlement_mode ?? record?.settlementMode ?? '');
}

export function assertV6DrainPostState(action, epoch) {
  const status = String(epoch?.status ?? '');
  const resultStatus = String(chainField(epoch, 'result_status', 'resultStatus') ?? '');
  const digest = String(chainField(epoch, 'resolution_digest', 'resolutionDigest') ?? '');

  if (action.type === 'TIMEOUT') {
    exactText(status, 'TIMED_OUT', 'timeout epoch status');
    exactText(resultStatus, 'TIMEOUT', 'timeout result_status');
    exactText(settlementMode(epoch, 'HIGH'), 'REFUND_TIMEOUT', 'timeout HIGH settlement_mode');
    exactText(settlementMode(epoch, 'LOW'), 'REFUND_TIMEOUT', 'timeout LOW settlement_mode');
    if (digest === '') fail('POST_STATE_MISMATCH', 'Timed-out epoch has no resolution digest');
    return epoch;
  }

  if (!RESOLUTION_STATUSES.has(status)) {
    fail('POST_STATE_MISMATCH', `Resolved epoch remains ${status || '(missing)'}`);
  }
  if (digest === '') fail('POST_STATE_MISMATCH', 'Resolved epoch has no resolution digest');
  if (status === 'UNDETERMINED') {
    exactText(resultStatus, 'UNDETERMINED', 'undetermined result_status');
    exactText(
      settlementMode(epoch, 'HIGH'),
      'REFUND_UNDETERMINED',
      'undetermined HIGH settlement_mode',
    );
    exactText(
      settlementMode(epoch, 'LOW'),
      'REFUND_UNDETERMINED',
      'undetermined LOW settlement_mode',
    );
    return epoch;
  }

  exactText(resultStatus, 'DETERMINED', 'resolved result_status');
  for (const objective of ['HIGH', 'LOW']) {
    const mode = settlementMode(epoch, objective);
    if (!RESOLVED_SETTLEMENT_MODES.has(mode)) {
      fail(
        'POST_STATE_MISMATCH',
        `resolved ${objective} settlement_mode is ${mode || '(missing)'}`,
      );
    }
  }
  return epoch;
}

function actionCall(action) {
  return Object.freeze({
    method: action.type === 'TIMEOUT' ? 'activate_timeout_refund' : 'resolve_epoch',
    args: Object.freeze([String(action.epochEndTimestamp)]),
  });
}

async function waitForFinalizedReceipt(context, transactionHash) {
  return withRetries(
    () => context.operator.waitFinalized(transactionHash, {
      retries: context.config.operator.finalityRetries,
      intervalMs: context.config.operator.finalityIntervalMs,
    }),
    {
      attempts: context.config.operator.finalityWaitAttempts,
      baseMs: Math.max(
        context.config.operator.retryBaseMs,
        context.config.operator.finalityIntervalMs,
      ),
      sleep: context.sleep,
      label: `FINALIZED receipt ${transactionHash}`,
    },
  );
}

async function revalidateAction(context, plannedAction) {
  const epoch = await fetchEpoch(context, plannedAction.epochEndTimestamp);
  const currentType = classifyOpenEpoch(epoch, context.readNow());
  if (!currentType) return null;
  return Object.freeze({ ...plannedAction, type: currentType });
}

async function executeAction(context, action) {
  const call = actionCall(action);
  let transactionHash;
  const submission = await context.operator.submitWrite(call.method, call.args, (hash) => {
    transactionHash = hash;
    context.logger({
      event: 'V6_DRAIN_TRANSACTION_SUBMITTED',
      action: action.type,
      epochEndTimestamp: action.epochEndTimestamp,
      transactionHash: hash,
    });
  });
  transactionHash = transactionHash || submission?.transactionHash;
  if (!/^0x[\da-f]{64}$/i.test(String(transactionHash ?? ''))) {
    fail('TRANSACTION_HASH_MISSING', `${call.method} did not report a transaction hash`);
  }

  const receipt = await waitForFinalizedReceipt(context, transactionHash);
  validateReceiptIdentity(receipt, context.config.contractAddress, call.method, call.args);
  const epoch = await withRetries(async () => {
    const current = await context.operator.getEpoch(action.epochEndTimestamp);
    assertEpochMatchesConfiguration(context.config, current, action.epochEndTimestamp);
    return assertV6DrainPostState(action, current);
  }, {
    attempts: context.config.operator.postStateAttempts,
    baseMs: context.config.operator.postStateIntervalMs,
    sleep: context.sleep,
    label: `post-state ${action.type} ${action.epochEndTimestamp}`,
  });

  context.logger({
    event: 'V6_DRAIN_ACTION_VERIFIED',
    action: action.type,
    epochEndTimestamp: action.epochEndTimestamp,
    transactionHash,
    status: epoch.status,
  });
  return Object.freeze({ ...action, transactionHash, status: epoch.status });
}

export async function runV6DrainOnce({
  config,
  execute = false,
  nowEpochSeconds,
  clock,
  operator,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = (event) => console.log(JSON.stringify(event)),
}) {
  if (!config || !operator) fail('DRAIN_ARGUMENT', 'config and operator are required');
  const readNow = typeof clock === 'function'
    ? () => safeInteger(clock(), 'clock')
    : (nowEpochSeconds === undefined
      ? () => Math.floor(Date.now() / 1_000)
      : () => safeInteger(nowEpochSeconds, 'nowEpochSeconds'));
  const now = readNow();
  const context = { config, execute, nowEpochSeconds: now, readNow, operator, sleep, logger };

  const networkInfo = await readChain(context, 'network info', () => operator.getNetworkInfo());
  assertStudioNet(networkInfo);
  const [contractConfig, assetCatalog, venueCatalog] = await Promise.all([
    readChain(context, 'get_config', () => operator.getConfig()),
    readChain(context, 'get_asset_catalog', () => operator.getAssetCatalog()),
    readChain(context, 'get_venue_catalog', () => operator.getVenueCatalog()),
  ]);
  assertV6ContractConfiguration(config, contractConfig, assetCatalog, venueCatalog);

  let signer = null;
  if (execute) {
    const accountInfo = await readChain(context, 'account info', () => operator.getAccountInfo());
    signer = assertActiveSigner(accountInfo, operator.canSignLockedAccount === true);
  }

  const plan = await planV6DrainRun(context);
  logger({
    event: execute ? 'V6_DRAIN_EXECUTION_PLAN' : 'V6_DRAIN_DRY_RUN_PLAN',
    nowEpochSeconds: now,
    signer,
    actions: plan.actions,
    deferredActionCount: plan.deferredActionCount,
  });
  if (!execute) {
    return Object.freeze({ ...plan, execute: false, signer, completed: [], skipped: [], failures: [] });
  }

  const completed = [];
  const skipped = [];
  const failures = [];
  for (const plannedAction of plan.actions) {
    try {
      const action = await revalidateAction(context, plannedAction);
      if (!action) {
        skipped.push(Object.freeze({ ...plannedAction, reason: 'NO_LONGER_ACTIONABLE' }));
        continue;
      }
      // Intentionally serialized: do not submit the next drain write until the
      // current transaction is FINALIZED and its exact post-state is visible.
      completed.push(await executeAction(context, action));
    } catch (error) {
      const failure = Object.freeze({
        ...plannedAction,
        code: error?.code || 'ACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      failures.push(failure);
      logger({ event: 'V6_DRAIN_ACTION_FAILED', ...failure });
    }
  }

  const summary = Object.freeze({ ...plan, execute: true, signer, completed, skipped, failures });
  if (failures.length > 0) {
    throw new V6DrainError(
      'ACTION_FAILURES',
      `${failures.length} V6 drain action(s) failed; successful actions remain verified`,
      { summary },
    );
  }
  return summary;
}

function usage() {
  return `Drain only the already-deployed Liquidity Arena V6 epochs on StudioNet.\n\nUsage:\n  node scripts/v6-drain.mjs --config <file> [--execute]\n\nOptions:\n  --config <file>  Existing V6 keeper JSON configuration (required)\n  --execute        Submit permissionless resolve/timeout writes; default is read-only\n  --help           Show this help\n\nThis operator never schedules new epochs. Any active StudioNet signer may execute it because both drain writes are permissionless.`;
}

function parseArguments(argv) {
  const parsed = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') parsed.execute = true;
    else if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument === '--config') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--config requires a value');
      parsed.configPath = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return parsed;
}

export async function runV6DrainCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(usage());
    return undefined;
  }
  if (!parsed.configPath) throw new Error('--config is required');
  const config = loadV6KeeperConfig(parsed.configPath);
  const operator = createCliV6KeeperOperator({ config });
  return runV6DrainOnce({ config, execute: parsed.execute, operator });
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && process.argv[1] === invokedPath) {
  runV6DrainCli().catch((error) => {
    console.error(JSON.stringify({
      event: 'V6_DRAIN_FAILED',
      code: error?.code || 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
