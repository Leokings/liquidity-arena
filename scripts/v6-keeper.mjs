#!/usr/bin/env node

import { spawn as nodeSpawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertFinalizedGenlayerExecution,
  createPasswordWritingSpawn,
  GENLAYER_STUDIONET_RPC_URL,
  getGenlayerTransactionStatus,
  parseGenlayerCallOutput,
  resolveGenlayerCommand,
  runGenlayerCall,
  runGenlayerStreamingCommand,
  submitGenlayerWrite,
  waitForGenlayerFinalizedReceipt,
} from './genlayer-command.mjs';
import {
  expectedEpochRecord,
  loadV6KeeperConfig,
  plannedFutureEpochEnds,
  V6_ASSET_IDS,
  V6_BATTLE_OPEN_OFFSET_SECONDS,
  V6_DEFAULT_PLATFORM_FEE_BPS,
  V6_MAX_PLATFORM_FEE_BPS,
  V6_MINIMUM_QUALIFIED_VENUES,
  V6_NETWORK,
  V6_POLICY_VERSION,
  V6_PRICE_SCALE,
  V6_PROTOCOL_VERSION,
  V6_RESOLUTION_PUBLICATION_DELAY_SECONDS,
  V6_RETURN_SCALE,
  V6_TIMEOUT_REFUND_DELAY_SECONDS,
  V6_VALIDATOR_RETURN_TOLERANCE_PPB,
  V6_VENUES,
  V6_WAGER_OPEN_OFFSET_SECONDS,
} from './v6-keeper-config.mjs';

const TERMINAL_EPOCH_STATUSES = new Set(['RESOLVED', 'UNDETERMINED', 'TIMED_OUT']);
const EXPECTED_SETTLEMENT_MODES = Object.freeze([
  'PENDING',
  'PARIMUTUEL',
  'REFUND_TIE',
  'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE',
  'REFUND_UNDETERMINED',
  'REFUND_TIMEOUT',
]);
const NO_OUTPUT = () => {};

export class V6KeeperError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'V6KeeperError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new V6KeeperError(code, message, details);
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

function exactText(value, expected, field) {
  if (String(value ?? '') !== String(expected)) {
    fail('CONTRACT_CONFIG_MISMATCH', `${field} must be ${expected}; received ${value ?? '(missing)'}`);
  }
}

function exactInteger(value, expected, field) {
  if (integerText(value, field) !== String(expected)) {
    fail('CONTRACT_CONFIG_MISMATCH', `${field} must be ${expected}; received ${value ?? '(missing)'}`);
  }
}

function exactArray(value, expected, field) {
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((item, index) => String(item) !== String(expected[index]))) {
    fail(
      'CONTRACT_CONFIG_MISMATCH',
      `${field} must be [${expected.join(', ')}]`,
      { received: value },
    );
  }
}

function ownerAddress(value) {
  const result = String(value ?? '');
  if (!/^0x[\da-f]{40}$/i.test(result) || /^0x0{40}$/i.test(result)) {
    fail('CONTRACT_CONFIG_MISMATCH', 'get_config.owner is not a nonzero address');
  }
  return result.toLowerCase();
}

export function assertV6ContractConfiguration(config, contractConfig, assetCatalog, venueCatalog) {
  exactText(
    chainField(contractConfig, 'protocol_version', 'protocolVersion'),
    V6_PROTOCOL_VERSION,
    'protocol_version',
  );
  exactText(
    chainField(contractConfig, 'policy_version', 'policyVersion'),
    V6_POLICY_VERSION,
    'policy_version',
  );
  exactText(
    chainField(contractConfig, 'native_token_symbol', 'nativeTokenSymbol'),
    'GEN',
    'native_token_symbol',
  );
  exactInteger(
    chainField(contractConfig, 'native_token_decimals', 'nativeTokenDecimals'),
    18,
    'native_token_decimals',
  );
  exactInteger(
    chainField(contractConfig, 'current_platform_fee_bps', 'currentPlatformFeeBps'),
    config.expected.platformFeeBps,
    'current_platform_fee_bps',
  );
  exactInteger(
    chainField(contractConfig, 'default_platform_fee_bps', 'defaultPlatformFeeBps'),
    V6_DEFAULT_PLATFORM_FEE_BPS,
    'default_platform_fee_bps',
  );
  exactInteger(
    chainField(contractConfig, 'max_platform_fee_bps', 'maxPlatformFeeBps'),
    V6_MAX_PLATFORM_FEE_BPS,
    'max_platform_fee_bps',
  );
  exactInteger(
    chainField(contractConfig, 'wager_open_offset_seconds', 'wagerOpenOffsetSeconds'),
    V6_WAGER_OPEN_OFFSET_SECONDS,
    'wager_open_offset_seconds',
  );
  exactInteger(
    chainField(contractConfig, 'battle_open_offset_seconds', 'battleOpenOffsetSeconds'),
    V6_BATTLE_OPEN_OFFSET_SECONDS,
    'battle_open_offset_seconds',
  );
  exactInteger(
    chainField(
      contractConfig,
      'resolution_publication_delay_seconds',
      'resolutionPublicationDelaySeconds',
    ),
    V6_RESOLUTION_PUBLICATION_DELAY_SECONDS,
    'resolution_publication_delay_seconds',
  );
  exactInteger(
    chainField(contractConfig, 'timeout_refund_delay_seconds', 'timeoutRefundDelaySeconds'),
    V6_TIMEOUT_REFUND_DELAY_SECONDS,
    'timeout_refund_delay_seconds',
  );
  exactInteger(
    chainField(contractConfig, 'minimum_qualified_venues', 'minimumQualifiedVenues'),
    V6_MINIMUM_QUALIFIED_VENUES,
    'minimum_qualified_venues',
  );
  exactInteger(
    chainField(
      contractConfig,
      'validator_return_tolerance_ppb',
      'validatorReturnTolerancePpb',
    ),
    V6_VALIDATOR_RETURN_TOLERANCE_PPB,
    'validator_return_tolerance_ppb',
  );
  exactInteger(chainField(contractConfig, 'price_scale', 'priceScale'), V6_PRICE_SCALE, 'price_scale');
  exactInteger(chainField(contractConfig, 'return_scale', 'returnScale'), V6_RETURN_SCALE, 'return_scale');
  exactText(
    chainField(contractConfig, 'four_venue_median_policy', 'fourVenueMedianPolicy'),
    'FLOOR_AVERAGE_OF_MIDDLE_TWO',
    'four_venue_median_policy',
  );
  exactText(
    chainField(contractConfig, 'rounding_policy', 'roundingPolicy'),
    'LAST_WINNING_CLAIMANT_RECEIVES_REMAINDER',
    'rounding_policy',
  );
  exactText(
    chainField(contractConfig, 'transfer_finality', 'transferFinality'),
    'FINALIZED',
    'transfer_finality',
  );
  exactArray(
    chainField(contractConfig, 'supported_objectives', 'supportedObjectives'),
    ['HIGH', 'LOW'],
    'supported_objectives',
  );
  exactArray(
    chainField(contractConfig, 'supported_settlement_modes', 'supportedSettlementModes'),
    EXPECTED_SETTLEMENT_MODES,
    'supported_settlement_modes',
  );

  const assets = assetCatalog?.assets;
  if (!Array.isArray(assets)) fail('CONTRACT_CONFIG_MISMATCH', 'asset catalog is malformed');
  exactArray(assets.map((asset) => asset?.asset_id ?? asset?.assetId), V6_ASSET_IDS, 'asset catalog');
  for (const asset of assets) {
    exactText(asset?.quote_asset ?? asset?.quoteAsset, 'USDT', 'asset quote_asset');
  }

  exactArray(venueCatalog?.venues, V6_VENUES, 'venue catalog');
  if (venueCatalog?.adapters_immutable !== true && venueCatalog?.adaptersImmutable !== true) {
    fail('CONTRACT_CONFIG_MISMATCH', 'venue adapters must be immutable');
  }
  exactText(
    venueCatalog?.candle_interval ?? venueCatalog?.candleInterval,
    '1m',
    'venue candle_interval',
  );
  exactText(
    venueCatalog?.start_price_rule ?? venueCatalog?.startPriceRule,
    'OPEN_AT_E_MINUS_20_MINUTES',
    'venue start_price_rule',
  );
  exactText(
    venueCatalog?.end_price_rule ?? venueCatalog?.endPriceRule,
    'CLOSE_AT_E_MINUS_1_MINUTE',
    'venue end_price_rule',
  );

  return Object.freeze({ owner: ownerAddress(contractConfig?.owner) });
}

function assertNetwork(networkInfo) {
  const alias = String(networkInfo?.alias ?? '').trim().toLowerCase();
  if (alias !== V6_NETWORK) {
    fail('NETWORK_MISMATCH', `Active GenLayer network must be ${V6_NETWORK}; received ${alias || '(missing)'}`);
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
  throw new V6KeeperError('RETRY_EXHAUSTED', `${label} failed after ${attempts} attempts`, {
    cause: lastError,
  });
}

function epochTimestamp(value) {
  const normalized = integerText(value, 'epoch ID');
  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result <= 0 || result % 3_600 !== 0) {
    fail('CHAIN_SCHEMA', `Epoch ID ${normalized} is not an exact UTC hour`);
  }
  return result;
}

export function classifyOpenEpoch(epoch, nowEpochSeconds) {
  if (String(epoch?.status ?? '') !== 'OPEN') return null;
  const resolutionAvailable = safeInteger(
    chainField(epoch, 'resolution_available_timestamp', 'resolutionAvailableTimestamp'),
    'resolution_available_timestamp',
  );
  const timeoutAvailable = safeInteger(
    chainField(epoch, 'timeout_refund_available_timestamp', 'timeoutRefundAvailableTimestamp'),
    'timeout_refund_available_timestamp',
  );
  if (nowEpochSeconds >= timeoutAvailable) return 'TIMEOUT';
  if (nowEpochSeconds >= resolutionAvailable) return 'RESOLVE';
  return null;
}

export function assertEpochMatchesConfiguration(config, epoch, epochEndTimestamp) {
  const expected = expectedEpochRecord(config, epochEndTimestamp);
  exactInteger(
    chainField(epoch, 'epoch_end_timestamp', 'epochEndTimestamp'),
    expected.epochEndTimestamp,
    'epoch.epoch_end_timestamp',
  );
  exactInteger(
    chainField(epoch, 'wager_opens_timestamp', 'wagerOpensTimestamp'),
    expected.wagerOpensTimestamp,
    'epoch.wager_opens_timestamp',
  );
  exactInteger(
    chainField(epoch, 'wager_closes_timestamp', 'wagerClosesTimestamp'),
    expected.wagerClosesTimestamp,
    'epoch.wager_closes_timestamp',
  );
  exactInteger(
    chainField(epoch, 'battle_starts_timestamp', 'battleStartsTimestamp'),
    expected.wagerClosesTimestamp,
    'epoch.battle_starts_timestamp',
  );
  exactInteger(
    chainField(epoch, 'resolution_available_timestamp', 'resolutionAvailableTimestamp'),
    expected.resolutionAvailableTimestamp,
    'epoch.resolution_available_timestamp',
  );
  exactInteger(
    chainField(epoch, 'timeout_refund_available_timestamp', 'timeoutRefundAvailableTimestamp'),
    expected.timeoutRefundAvailableTimestamp,
    'epoch.timeout_refund_available_timestamp',
  );
  exactText(
    chainField(epoch, 'policy_version', 'policyVersion'),
    expected.policyVersion,
    'epoch.policy_version',
  );
  exactInteger(
    chainField(epoch, 'platform_fee_bps_snapshot', 'platformFeeBpsSnapshot'),
    expected.platformFeeBpsSnapshot,
    'epoch.platform_fee_bps_snapshot',
  );
  exactInteger(
    chainField(epoch, 'min_stake_atto', 'minStakeAtto'),
    expected.minStakeAtto,
    'epoch.min_stake_atto',
  );
  exactInteger(
    chainField(epoch, 'max_stake_per_wallet_atto', 'maxStakePerWalletAtto'),
    expected.maxStakePerWalletAtto,
    'epoch.max_stake_per_wallet_atto',
  );
  const status = String(epoch?.status ?? '');
  if (status !== 'OPEN' && !TERMINAL_EPOCH_STATUSES.has(status)) {
    fail('CHAIN_SCHEMA', `Epoch ${epochEndTimestamp} has unknown status ${status || '(missing)'}`);
  }
  return epoch;
}

async function readChain(context, label, task) {
  const { config, sleep } = context;
  return withRetries(task, {
    attempts: config.operator.readAttempts,
    baseMs: config.operator.retryBaseMs,
    sleep,
    label,
  });
}

async function fetchAllEpochIds(context) {
  const countValue = await readChain(context, 'get_epoch_count', () => context.operator.getEpochCount());
  const count = safeInteger(countValue, 'get_epoch_count');
  const ids = [];
  let offset = 0;
  while (offset < count) {
    const limit = Math.min(context.config.operator.pageSize, count - offset);
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
    if (pageOffset !== offset || nextOffset <= offset || nextOffset > count || total < count) {
      fail('CHAIN_SCHEMA', 'get_epoch_page returned inconsistent pagination metadata');
    }
    if (!Array.isArray(page?.epoch_ids ?? page?.epochIds)) {
      fail('CHAIN_SCHEMA', 'get_epoch_page did not return epoch_ids');
    }
    const pageIds = page.epoch_ids ?? page.epochIds;
    if (pageIds.length !== nextOffset - offset) {
      fail('CHAIN_SCHEMA', 'get_epoch_page returned an unexpected number of IDs');
    }
    ids.push(...pageIds.map((id) => integerText(id, 'epoch ID')));
    offset = nextOffset;
    if (offset < count && context.config.operator.scanIntervalMs > 0) {
      await context.sleep(context.config.operator.scanIntervalMs);
    }
  }
  if (new Set(ids).size !== ids.length) fail('CHAIN_SCHEMA', 'get_epoch_page returned duplicate IDs');
  return Object.freeze(ids);
}

async function fetchEpoch(context, epochEndTimestamp) {
  const epoch = await readChain(
    context,
    `get_epoch(${epochEndTimestamp})`,
    () => context.operator.getEpoch(epochEndTimestamp),
  );
  return assertEpochMatchesConfiguration(context.config, epoch, epochEndTimestamp);
}

export async function planV6KeeperRun(context) {
  const { config, nowEpochSeconds } = context;
  // The epoch index is authoritative. Traverse the complete finite snapshot in
  // contract-capped pages so an OPEN epoch can never age out of reconciliation.
  const knownIds = await fetchAllEpochIds(context);
  const knownSet = new Set(knownIds);
  const state = new Map();
  const targets = plannedFutureEpochEnds(config, nowEpochSeconds);
  const actions = [];

  for (const epochEndTimestamp of targets) {
    const key = String(epochEndTimestamp);
    if (!knownSet.has(key)) {
      actions.push(Object.freeze({ type: 'CREATE', epochEndTimestamp }));
      continue;
    }
    const epoch = await fetchEpoch(context, epochEndTimestamp);
    state.set(key, epoch);
  }

  const dueIds = knownIds
    .map(epochTimestamp)
    .filter((value) => value + V6_RESOLUTION_PUBLICATION_DELAY_SECONDS <= nowEpochSeconds)
    .sort((left, right) => left - right);
  for (const [index, epochEndTimestamp] of dueIds.entries()) {
    const key = String(epochEndTimestamp);
    const epoch = state.get(key) ?? await fetchEpoch(context, epochEndTimestamp);
    state.set(key, epoch);
    const actionType = classifyOpenEpoch(epoch, nowEpochSeconds);
    if (actionType) actions.push(Object.freeze({ type: actionType, epochEndTimestamp }));
    if (index + 1 < dueIds.length && config.operator.scanIntervalMs > 0) {
      await context.sleep(config.operator.scanIntervalMs);
    }
  }

  const priority = { TIMEOUT: 0, RESOLVE: 1, CREATE: 2 };
  actions.sort((left, right) => priority[left.type] - priority[right.type]
    || left.epochEndTimestamp - right.epochEndTimestamp);
  const selected = actions.slice(0, config.operator.maxWritesPerRun);
  return Object.freeze({
    knownEpochCount: knownIds.length,
    targetEpochEnds: targets,
    actions: Object.freeze(selected),
    deferredActionCount: actions.length - selected.length,
  });
}

export function validateReceiptIdentity(receipt, contractAddress, method, args) {
  assertFinalizedGenlayerExecution(receipt);
  const recipient = String(receipt?.recipient ?? '').toLowerCase();
  const decoded = receipt?.txDataDecoded;
  const actualArgs = decoded?.callData?.args;
  const expectedArgs = args.map(String);
  if (recipient !== contractAddress.toLowerCase()
    || decoded?.type !== 'call'
    || decoded?.callData?.method !== method
    || !Array.isArray(actualArgs)
    || actualArgs.length !== expectedArgs.length
    || actualArgs.some((value, index) => String(value) !== expectedArgs[index])) {
    fail('RECEIPT_IDENTITY_MISMATCH', `Finalized receipt does not prove ${method}`, {
      recipient,
      method: decoded?.callData?.method,
      args: actualArgs,
    });
  }
  return receipt;
}

export async function runV6KeeperOnce({
  config,
  execute = false,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
  operator,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = (event) => console.log(JSON.stringify(event)),
}) {
  if (!config || !operator) fail('KEEPER_ARGUMENT', 'config and operator are required');
  const now = safeInteger(nowEpochSeconds, 'nowEpochSeconds');
  const context = { config, execute, nowEpochSeconds: now, operator, sleep, logger };

  const networkInfo = await readChain(context, 'network info', () => operator.getNetworkInfo());
  assertNetwork(networkInfo);
  const [contractConfig, assetCatalog, venueCatalog] = await Promise.all([
    readChain(context, 'get_config', () => operator.getConfig()),
    readChain(context, 'get_asset_catalog', () => operator.getAssetCatalog()),
    readChain(context, 'get_venue_catalog', () => operator.getVenueCatalog()),
  ]);
  assertV6ContractConfiguration(
    config,
    contractConfig,
    assetCatalog,
    venueCatalog,
  );
  if (execute) {
    fail(
      'V6_EXECUTION_DISABLED',
      'The legacy V6 keeper is read-only. Use the manual V6 drain for settlement recovery; V6 epoch creation is permanently disabled.',
    );
  }

  const plan = await planV6KeeperRun(context);
  logger({
    event: 'V6_KEEPER_DRY_RUN_PLAN',
    nowEpochSeconds: now,
    actions: plan.actions,
    deferredActionCount: plan.deferredActionCount,
  });
  return Object.freeze({
    ...plan,
    execute: false,
    recovered: [],
    completed: [],
    pending: [],
    skipped: [],
    failures: [],
  });
}

export function createCliV6KeeperOperator({ config, environment = process.env } = {}) {
  const invocation = resolveGenlayerCommand();
  const password = environment.GENLAYER_KEYSTORE_PASSWORD || '';
  const quiet = { writeStdout: NO_OUTPUT, writeStderr: NO_OUTPUT };
  const call = (method, args = []) => runGenlayerCall({
    invocation,
    contractAddress: config.contractAddress,
    method,
    args,
    ...quiet,
  });
  const inspect = async (command, args = []) => {
    const result = await runGenlayerStreamingCommand({
      invocation,
      command,
      args,
      ...quiet,
    });
    return parseGenlayerCallOutput(result.output);
  };
  return Object.freeze({
    canSignLockedAccount: password !== '',
    getNetworkInfo: () => inspect('network', ['info']),
    getAccountInfo: () => inspect('account'),
    getConfig: () => call('get_config'),
    getAssetCatalog: () => call('get_asset_catalog'),
    getVenueCatalog: () => call('get_venue_catalog'),
    getEpochCount: () => call('get_epoch_count'),
    getEpochPage: (offset, limit) => call('get_epoch_page', [offset, limit]),
    getEpoch: (epochEndTimestamp) => call('get_epoch', [epochEndTimestamp]),
    getTransactionStatus: (transactionHash) => getGenlayerTransactionStatus({
      rpcUrl: GENLAYER_STUDIONET_RPC_URL,
      transactionHash,
    }),
    submitWrite: (method, args, onTransactionHash) => submitGenlayerWrite({
      invocation,
      args: [config.contractAddress, method, '--args', ...args.map(String)],
      onTransactionHash,
      stdin: password ? 'pipe' : 'inherit',
      spawnImpl: password ? createPasswordWritingSpawn(password) : nodeSpawn,
      ...quiet,
    }),
    waitFinalized: (transactionHash, policy) => waitForGenlayerFinalizedReceipt({
      invocation,
      transactionHash,
      retries: policy.retries,
      intervalMs: policy.intervalMs,
      stdin: password ? 'pipe' : 'inherit',
      spawnImpl: password ? createPasswordWritingSpawn(password) : nodeSpawn,
      ...quiet,
    }),
  });
}

function usage() {
  return `Inspect the retired Liquidity Arena V6 scheduler on StudioNet.\n\nUsage:\n  node scripts/v6-keeper.mjs --config <file>\n\nOptions:\n  --config <file>  V6 keeper JSON configuration (required)\n  --execute        Rejected: V6 creation is permanently disabled\n  --help           Show this help\n\nUse scripts/v6-drain.mjs manually for permissionless settlement recovery. This legacy scheduler is read-only.`;
}

function parseArguments(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') result.execute = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--config') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--config requires a value');
      result.configPath = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}

export async function runV6KeeperCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(usage());
    return undefined;
  }
  if (!parsed.configPath) throw new Error('--config is required');
  const config = loadV6KeeperConfig(parsed.configPath);
  const operator = createCliV6KeeperOperator({ config });
  return runV6KeeperOnce({ config, execute: parsed.execute, operator });
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && process.argv[1] === invokedPath) {
  runV6KeeperCli().catch((error) => {
    const output = {
      event: 'V6_KEEPER_FAILED',
      code: error?.code || 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
    };
    console.error(JSON.stringify(output));
    process.exitCode = 1;
  });
}
