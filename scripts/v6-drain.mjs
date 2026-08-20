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
  createKeeperJournalClientFromEnvironment,
} from '../keeper-journal/client.mjs';
import {
  createAuthoritativeKeeperSession,
  keeperActionForOperation,
  keeperOperationForAction,
  reconcileAuthoritativeOperation,
  recoverAuthoritativeOperations,
  validateRecoveredKeeperOperation,
} from './authoritative-keeper-journal.mjs';
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

async function readVerifiedPostState(context, action) {
  return withRetries(async () => {
    const current = await context.operator.getEpoch(action.epochEndTimestamp);
    assertEpochMatchesConfiguration(context.config, current, action.epochEndTimestamp);
    return assertV6DrainPostState(action, current);
  }, {
    attempts: context.config.operator.postStateAttempts,
    baseMs: context.config.operator.postStateIntervalMs,
    sleep: context.sleep,
    label: `post-state ${action.type} ${action.epochEndTimestamp}`,
  });
}

async function revalidateAction(context, plannedAction) {
  const epoch = await fetchEpoch(context, plannedAction.epochEndTimestamp);
  const currentType = classifyOpenEpoch(epoch, context.readNow());
  if (!currentType) return null;
  return Object.freeze({ ...plannedAction, type: currentType });
}

async function executeAction(context, action) {
  const accountInfo = await readChain(
    context,
    `account info before ${action.type}`,
    () => context.operator.getAccountInfo(),
  );
  const activeSigner = assertActiveSigner(
    accountInfo,
    context.operator.canSignLockedAccount === true,
  );
  if (activeSigner !== context.journalSession.signerAddress) {
    fail('SIGNER_DRIFT', 'The active StudioNet signer changed after the fenced lease was acquired.');
  }
  const identity = keeperOperationForAction({
    deploymentAlias: 'v6',
    contractAddress: context.config.contractAddress,
    action,
  });
  const call = identity.call;
  await context.journalSession.renew();
  const prepared = await context.journalSession.prepare(identity.operation);
  if (prepared?.canBroadcast !== true) {
    const operation = prepared?.operation
      ? validateRecoveredKeeperOperation(prepared.operation)
      : null;
    return Object.freeze({
      ...action,
      transactionHash: operation?.transactionHash || null,
      pendingReceipt: true,
      code: 'PREPARE_BLOCKED',
      reason: 'AUTHORITATIVE_PREPARE_NOT_BROADCASTABLE',
    });
  }
  let operation = validateRecoveredKeeperOperation(prepared.operation);
  if (prepared.inserted !== true
      || operation.logicalOperationId !== identity.logicalOperationId
      || operation.state !== 'PREPARED'
      || operation.transactionHash !== null
      || operation.deploymentAlias !== 'v6'
      || operation.contractAddress !== context.config.contractAddress.toLowerCase()
      || operation.signerAddress !== context.journalSession.signerAddress) {
    fail('KEEPER_JOURNAL_IDENTITY', 'Prepared V6 drain operation does not match the intended write.');
  }
  await context.journalSession.renew();
  const preparedOperationId = operation.operationId;
  let transactionHash;
  await context.operator.submitWrite(call.method, call.args, async (hash) => {
    transactionHash = hash;
    context.logger({
      event: 'V6_DRAIN_TRANSACTION_HASH_CAPTURED',
      operationId: operation.operationId,
      logicalOperationId: operation.logicalOperationId,
      attemptNumber: operation.attemptNumber,
      action: action.type,
      epochEndTimestamp: action.epochEndTimestamp,
      transactionHash: hash,
      authoritativeBound: false,
    });
    const bound = await context.journalSession.bind(operation.operationId, hash);
    operation = validateRecoveredKeeperOperation(bound?.operation);
    if (operation.operationId !== preparedOperationId
        || operation.logicalOperationId !== identity.logicalOperationId
        || operation.transactionHash !== String(hash).toLowerCase()
        || operation.state !== 'SUBMITTED') {
      fail('KEEPER_JOURNAL_IDENTITY', 'V6 drain hash was not bound to its prepared operation.');
    }
    context.logger({
      event: 'V6_DRAIN_TRANSACTION_SUBMITTED',
      operationId: operation.operationId,
      logicalOperationId: operation.logicalOperationId,
      attemptNumber: operation.attemptNumber,
      action: action.type,
      epochEndTimestamp: action.epochEndTimestamp,
      transactionHash: hash,
    });
  });
  if (!/^0x[\da-f]{64}$/i.test(String(transactionHash ?? ''))) {
    fail(
      'TRANSACTION_HASH_NOT_DURABLE',
      `${call.method} did not durably bind its transaction hash before the wrapper exited`,
    );
  }
  const reconciled = await reconcileAuthoritativeOperation({
    ...authoritativeRecoveryOptions(context),
    operation,
  });
  if (!reconciled.verified) {
    const pending = Object.freeze({
      ...action,
      transactionHash,
      pendingReceipt: true,
      code: 'AUTHORITATIVE_OPERATION_PENDING',
      reason: reconciled.pending.reason,
    });
    context.logger({ event: 'V6_DRAIN_TRANSACTION_DEFERRED', ...pending });
    return pending;
  }
  const epoch = reconciled.postState;

  context.logger({
    event: 'V6_DRAIN_ACTION_VERIFIED',
    action: action.type,
    epochEndTimestamp: action.epochEndTimestamp,
    transactionHash,
    status: epoch.status,
  });
  return Object.freeze({ ...action, transactionHash, status: epoch.status });
}

function authoritativeRecoveryOptions(context) {
  const { config } = context;
  return {
    session: context.journalSession,
    deploymentAlias: 'v6',
    contractAddress: config.contractAddress,
    operator: context.operator,
    validateReceipt: (receipt, operation) => {
      const action = keeperActionForOperation(operation);
      const expected = keeperOperationForAction({
        deploymentAlias: 'v6',
        contractAddress: config.contractAddress,
        action,
      });
      if (expected.logicalOperationId !== operation.logicalOperationId) {
        fail('KEEPER_JOURNAL_CALL_MISMATCH', 'Recovered V6 drain call is not canonical.');
      }
      validateReceiptIdentity(receipt, config.contractAddress, expected.call.method, expected.call.args);
    },
    verifyPostState: (action) => readVerifiedPostState(context, action),
    sleep: context.sleep,
    lifecycleAttempts: config.operator.finalityRetries,
    lifecycleIntervalMs: config.operator.finalityIntervalMs,
    receiptPolicy: {
      retries: 1,
      intervalMs: config.operator.finalityIntervalMs,
    },
    deadlineAtMs: context.deadlineAtMs,
    clockMs: context.clockMs,
    logger: context.logger,
  };
}

export async function runV6DrainOnce({
  config,
  execute = false,
  nowEpochSeconds,
  clock,
  operator,
  journalClient = operator?.journalClient,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = (event) => console.log(JSON.stringify(event)),
  deadlineAtMs = Date.now() + (45 * 60 * 1_000),
  clockMs = Date.now,
  journalSessionOptions = {},
}) {
  if (!config || !operator) fail('DRAIN_ARGUMENT', 'config and operator are required');
  const readNow = typeof clock === 'function'
    ? () => safeInteger(clock(), 'clock')
    : (nowEpochSeconds === undefined
      ? () => Math.floor(Date.now() / 1_000)
      : () => safeInteger(nowEpochSeconds, 'nowEpochSeconds'));
  const now = readNow();
  const context = {
    config,
    execute,
    nowEpochSeconds: now,
    readNow,
    operator,
    sleep,
    logger,
    deadlineAtMs,
    clockMs,
    journalSession: null,
  };

  const networkInfo = await readChain(context, 'network info', () => operator.getNetworkInfo());
  assertStudioNet(networkInfo);
  const [contractConfig, assetCatalog, venueCatalog] = await Promise.all([
    readChain(context, 'get_config', () => operator.getConfig()),
    readChain(context, 'get_asset_catalog', () => operator.getAssetCatalog()),
    readChain(context, 'get_venue_catalog', () => operator.getVenueCatalog()),
  ]);
  assertV6ContractConfiguration(config, contractConfig, assetCatalog, venueCatalog);

  if (!execute) {
    const plan = await planV6DrainRun(context);
    logger({
      event: 'V6_DRAIN_DRY_RUN_PLAN',
      nowEpochSeconds: now,
      signer: null,
      actions: plan.actions,
      deferredActionCount: plan.deferredActionCount,
    });
    return Object.freeze({
      ...plan,
      execute: false,
      signer: null,
      recovered: [],
      completed: [],
      pending: [],
      skipped: [],
      failures: [],
    });
  }

  const accountInfo = await readChain(context, 'account info', () => operator.getAccountInfo());
  const signer = assertActiveSigner(accountInfo, operator.canSignLockedAccount === true);
  const journalSession = createAuthoritativeKeeperSession({
    client: journalClient,
    signerAddress: signer,
    logger,
    ...journalSessionOptions,
  });
  context.journalSession = journalSession;
  await journalSession.acquire();

  let summary;
  try {
    summary = await journalSession.withHeartbeat(async () => {
      const recovery = await recoverAuthoritativeOperations(authoritativeRecoveryOptions(context));
      if (recovery.blocked) {
        logger({ event: 'V6_DRAIN_RECOVERY_BLOCKED', pending: recovery.pending });
        return Object.freeze({
          scannedEpochCount: null,
          openEpochCount: null,
          actions: Object.freeze([]),
          deferredActionCount: 0,
          execute: true,
          signer,
          recovered: recovery.recovered,
          completed: [],
          pending: recovery.pending,
          skipped: [],
          failures: [],
          blocked: true,
        });
      }

      const plan = await planV6DrainRun(context);
      logger({
        event: 'V6_DRAIN_EXECUTION_PLAN',
        nowEpochSeconds: now,
        signer,
        actions: plan.actions,
        deferredActionCount: plan.deferredActionCount,
      });
      const completed = [];
      const skipped = [];
      const pending = [];
      const failures = [];
      for (let index = 0; index < plan.actions.length; index += 1) {
        const plannedAction = plan.actions[index];
        if (clockMs() >= deadlineAtMs) {
          skipped.push(...plan.actions.slice(index).map((item) => Object.freeze({
            ...item,
            reason: 'RUN_DEADLINE',
          })));
          break;
        }
        try {
          const action = await revalidateAction(context, plannedAction);
          if (!action) {
            skipped.push(Object.freeze({ ...plannedAction, reason: 'NO_LONGER_ACTIONABLE' }));
            continue;
          }
          const result = await executeAction(context, action);
          if (result.pendingReceipt) {
            pending.push(result);
            skipped.push(...plan.actions.slice(index + 1).map((item) => Object.freeze({
              ...item,
              reason: 'BLOCKED_BY_NONTERMINAL_OPERATION',
              transactionHash: result.transactionHash,
            })));
            break;
          }
          completed.push(result);
        } catch (error) {
          const failure = Object.freeze({
            ...plannedAction,
            code: error?.code || 'ACTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
          failures.push(failure);
          logger({ event: 'V6_DRAIN_ACTION_FAILED', ...failure });
          skipped.push(...plan.actions.slice(index + 1).map((item) => Object.freeze({
            ...item,
            reason: 'BLOCKED_AFTER_ACTION_FAILURE',
          })));
          break;
        }
      }
      return Object.freeze({
        ...plan,
        execute: true,
        signer,
        recovered: recovery.recovered,
        completed,
        pending,
        skipped,
        failures,
        blocked: pending.length > 0 || failures.length > 0,
      });
    });
  } finally {
    await journalSession.release();
  }
  if (summary.failures.length > 0) {
    throw new V6DrainError(
      'ACTION_FAILURES',
      `${summary.failures.length} V6 drain action(s) failed; successful actions remain verified`,
      { summary },
    );
  }
  return summary;
}

function usage() {
  return `Drain only the already-deployed Liquidity Arena V6 epochs on StudioNet.\n\nUsage:\n  node scripts/v6-drain.mjs --config <file> [--execute]\n\nOptions:\n  --config <file>  Existing V6 keeper JSON configuration (required)\n  --execute        Submit permissionless resolve/timeout writes; default is read-only\n  --help           Show this help\n\nThis operator never schedules new epochs. The contract methods are permissionless, but this journal-backed operator accepts only the configured fenced keeper signer.`;
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

export async function runV6DrainCli(
  argv = process.argv.slice(2),
  {
    environment = process.env,
    loadConfig = loadV6KeeperConfig,
    createOperator = createCliV6KeeperOperator,
    createJournalClient = createKeeperJournalClientFromEnvironment,
    runOnce = runV6DrainOnce,
  } = {},
) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(usage());
    return undefined;
  }
  if (!parsed.configPath) throw new Error('--config is required');
  const config = loadConfig(parsed.configPath);
  const operator = createOperator({ config, environment });
  const journalClient = parsed.execute
    ? createJournalClient(environment)
    : undefined;
  const summary = await runOnce({ config, execute: parsed.execute, operator, journalClient });
  if (summary?.blocked === true) {
    throw new V6DrainError(
      'RUN_BLOCKED',
      'V6 drain stopped with an authoritative operation still blocked',
      { summary },
    );
  }
  return summary;
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
