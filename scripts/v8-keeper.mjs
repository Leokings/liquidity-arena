#!/usr/bin/env node

import { spawn as nodeSpawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Contract, JsonRpcProvider } from 'ethers';
import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';

import { createKeeperJournalClientFromEnvironment } from '../keeper-journal/client.mjs';
import {
  createAuthoritativeKeeperSession,
  keeperActionForOperation,
  keeperOperationForAction,
  reconcileAuthoritativeOperation,
  recoverAuthoritativeOperations,
  validateRecoveredKeeperOperation,
} from './authoritative-keeper-journal.mjs';
import {
  assertFinalizedGenlayerExecution,
  createPasswordWritingSpawn,
  GENLAYER_BRADBURY_RPC_URL,
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
  loadV8KeeperConfig,
  plannedFutureEpochEnds,
  V8_ASSET_IDS,
  V8_AUDITED_PAYOUT_FACTORY,
  V8_BATTLE_OPEN_OFFSET_SECONDS,
  V8_CHAIN_ID,
  V8_EVM_RPC_URL,
  V8_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS,
  V8_MAX_PAYOUT_ATTEMPTS,
  V8_MINIMUM_EPOCH_CREATION_LEAD_SECONDS,
  V8_MINIMUM_QUALIFIED_VENUES,
  V8_NETWORK,
  V8_PAYOUT_PROTOCOL_VERSION,
  V8_PAYOUT_RETRY_DELAY_SECONDS,
  V8_PLATFORM_FEE_BPS,
  V8_POLICY_VERSION,
  V8_PROTOCOL_VERSION,
  V8_PUBLIC_METHODS,
  V8_RESOLUTION_PUBLICATION_DELAY_SECONDS,
  V8_SUPPORTED_OBJECTIVES,
  V8_TIMEOUT_REFUND_DELAY_SECONDS,
  V8_VALIDATOR_RETURN_TOLERANCE_PPB,
  V8_VENUES,
  V8_WAGER_OPEN_OFFSET_SECONDS,
} from './v8-keeper-config.mjs';

const PAYOUT_ID = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const TERMINAL_EPOCH_STATUSES = new Set(['RESOLVED', 'TIMED_OUT']);
const PAYOUT_STATES = new Set(['PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN']);
const NO_OUTPUT = () => {};
export const V8_FACTORY_VIEW_ABI = Object.freeze([
  'function is_prepared(string payoutId,address recipient,uint256 amount) view returns (bool)',
  'function is_credited(string payoutId,address recipient,uint256 amount) view returns (bool)',
  'function is_withdrawn(string payoutId,address recipient,uint256 amount) view returns (bool)',
]);

function schemaMethod(params = [], readonly = false, payable = false, ret = 'null') {
  const value = { params, kwparams: {}, readonly, ret };
  if (!readonly) value.payable = payable;
  return value;
}

export const V8_KEEPER_ABI = Object.freeze({
  ctor: {
    params: [
      ['treasury', 'address'], ['keeper', 'address'],
      ['epoch_min_stake_atto', 'int'], ['epoch_max_stake_per_wallet_atto', 'int'],
      ['payout_vault_factory', 'address'],
    ],
    kwparams: {},
  },
  methods: {
    activate_payouts: schemaMethod(),
    activate_timeout_refund: schemaMethod([['epoch_end_timestamp', 'int']]),
    claim: schemaMethod([['epoch_end_timestamp', 'int'], ['objective', 'string']]),
    confirm_payout: schemaMethod([['payout_id', 'string']]),
    create_epoch: schemaMethod([['epoch_end_timestamp', 'int']]),
    dispatch_payout: schemaMethod([['payout_id', 'string']]),
    enter: schemaMethod([['epoch_end_timestamp', 'int'], ['objective', 'string'], ['asset_id', 'string']], false, true),
    fund_delivery_reserve: schemaMethod([], false, true),
    get_claim_quote: schemaMethod([['epoch_end_timestamp', 'int'], ['objective', 'string'], ['account', 'address']], true, false, 'dict'),
    get_config: schemaMethod([], true, false, 'dict'),
    get_delivery_reserve_state: schemaMethod([], true, false, 'dict'),
    get_epoch: schemaMethod([['epoch_end_timestamp', 'int']], true, false, 'dict'),
    get_epoch_asset: schemaMethod([['epoch_end_timestamp', 'int'], ['asset_id', 'string']], true, false, 'dict'),
    get_epoch_page: schemaMethod([['offset', 'int'], ['limit', 'int']], true, false, 'dict'),
    get_objective: schemaMethod([['epoch_end_timestamp', 'int'], ['objective', 'string']], true, false, 'dict'),
    get_payout: schemaMethod([['payout_id', 'string']], true, false, 'dict'),
    get_payout_page: schemaMethod([['offset', 'int'], ['limit', 'int']], true, false, 'dict'),
    pause_new_risk: schemaMethod(),
    refresh_payout_withdrawal: schemaMethod([['payout_id', 'string']]),
    request_fee_payout: schemaMethod([['amount_atto', 'int']]),
    resolve_epoch: schemaMethod([['epoch_end_timestamp', 'int']]),
    resume_new_risk: schemaMethod(),
    retry_payout: schemaMethod([['payout_id', 'string']]),
    retry_prepare_payout: schemaMethod([['payout_id', 'string']]),
    set_keeper: schemaMethod([['keeper', 'address']]),
  },
});

export class V8KeeperError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'V8KeeperError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new V8KeeperError(code, message, details);
}

function chainField(value, snake, camel) {
  return value?.[snake] ?? value?.[camel];
}

function integerText(value, field) {
  const raw = typeof value === 'bigint' ? value.toString() : String(value ?? '');
  const normalized = /^\d+n$/.test(raw) ? raw.slice(0, -1) : raw;
  if (!/^\d+$/.test(normalized)) fail('CHAIN_SCHEMA', `${field} must be an unsigned integer`);
  return normalized;
}

function safeInteger(value, field) {
  const result = Number(integerText(value, field));
  if (!Number.isSafeInteger(result)) fail('CHAIN_SCHEMA', `${field} exceeds a safe integer`);
  return result;
}

function exactText(value, expected, field) {
  if (String(value ?? '') !== String(expected)) fail('CONTRACT_CONFIG_MISMATCH', `${field} must be ${expected}`);
}

function exactInteger(value, expected, field) {
  if (integerText(value, field) !== String(expected)) fail('CONTRACT_CONFIG_MISMATCH', `${field} must be ${expected}`);
}

function exactBoolean(value, expected, field) {
  if (value !== expected) fail('CONTRACT_CONFIG_MISMATCH', `${field} must be ${expected}`);
}

function exactArray(value, expected, field) {
  if (!Array.isArray(value) || value.length !== expected.length
      || value.some((entry, index) => String(entry) !== expected[index])) {
    fail('CONTRACT_CONFIG_MISMATCH', `${field} does not match the V8 release`);
  }
}

function exactAddress(value, field) {
  const result = String(value ?? '').toLowerCase();
  if (!ADDRESS.test(result) || /^0x0{40}$/.test(result)) fail('CONTRACT_CONFIG_MISMATCH', `${field} is not a nonzero address`);
  return result;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function assertV8Schema(schema) {
  if (stableJson(schema) !== stableJson(V8_KEEPER_ABI)) fail('CONTRACT_SCHEMA_MISMATCH', 'contract schema is not the exhaustive 25-method V8 ABI');
  const methods = Object.keys(schema.methods).sort();
  if (methods.length !== 25 || methods.some((method, index) => method !== [...V8_PUBLIC_METHODS].sort()[index])) {
    fail('CONTRACT_SCHEMA_MISMATCH', 'contract schema method set is not the V8 release');
  }
  return schema;
}

export function assertV8ContractConfiguration(config, value) {
  exactText(chainField(value, 'protocol_version', 'protocolVersion'), V8_PROTOCOL_VERSION, 'protocol_version');
  exactText(chainField(value, 'policy_version', 'policyVersion'), V8_POLICY_VERSION, 'policy_version');
  exactText(chainField(value, 'payout_protocol_version', 'payoutProtocolVersion'), V8_PAYOUT_PROTOCOL_VERSION, 'payout_protocol_version');
  exactText(exactAddress(chainField(value, 'payout_vault_factory', 'payoutVaultFactory'), 'payout_vault_factory'), V8_AUDITED_PAYOUT_FACTORY, 'payout_vault_factory');
  exactText(exactAddress(value.owner, 'owner'), config.expected.ownerAddress, 'owner');
  exactText(exactAddress(value.keeper, 'keeper'), config.expected.keeperAddress, 'keeper');
  exactText(exactAddress(value.treasury, 'treasury'), config.expected.treasuryAddress, 'treasury');
  exactBoolean(chainField(value, 'payouts_enabled', 'payoutsEnabled'), true, 'payouts_enabled');
  exactInteger(chainField(value, 'current_platform_fee_bps', 'currentPlatformFeeBps'), V8_PLATFORM_FEE_BPS, 'current_platform_fee_bps');
  exactInteger(chainField(value, 'epoch_min_stake_atto', 'epochMinStakeAtto'), config.epochs.minStakeAtto, 'epoch_min_stake_atto');
  exactInteger(chainField(value, 'epoch_max_stake_per_wallet_atto', 'epochMaxStakePerWalletAtto'), config.epochs.maxStakePerWalletAtto, 'epoch_max_stake_per_wallet_atto');
  exactInteger(chainField(value, 'minimum_epoch_creation_lead_seconds', 'minimumEpochCreationLeadSeconds'), V8_MINIMUM_EPOCH_CREATION_LEAD_SECONDS, 'minimum_epoch_creation_lead_seconds');
  exactInteger(chainField(value, 'keeper_max_schedule_ahead_seconds', 'keeperMaxScheduleAheadSeconds'), V8_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS, 'keeper_max_schedule_ahead_seconds');
  exactInteger(chainField(value, 'wager_open_offset_seconds', 'wagerOpenOffsetSeconds'), V8_WAGER_OPEN_OFFSET_SECONDS, 'wager_open_offset_seconds');
  exactInteger(chainField(value, 'battle_open_offset_seconds', 'battleOpenOffsetSeconds'), V8_BATTLE_OPEN_OFFSET_SECONDS, 'battle_open_offset_seconds');
  exactInteger(chainField(value, 'resolution_publication_delay_seconds', 'resolutionPublicationDelaySeconds'), V8_RESOLUTION_PUBLICATION_DELAY_SECONDS, 'resolution_publication_delay_seconds');
  exactInteger(chainField(value, 'timeout_refund_delay_seconds', 'timeoutRefundDelaySeconds'), V8_TIMEOUT_REFUND_DELAY_SECONDS, 'timeout_refund_delay_seconds');
  exactInteger(chainField(value, 'minimum_qualified_venues', 'minimumQualifiedVenues'), V8_MINIMUM_QUALIFIED_VENUES, 'minimum_qualified_venues');
  exactInteger(chainField(value, 'validator_return_tolerance_ppb', 'validatorReturnTolerancePpb'), V8_VALIDATOR_RETURN_TOLERANCE_PPB, 'validator_return_tolerance_ppb');
  exactInteger(chainField(value, 'max_payout_attempts', 'maxPayoutAttempts'), V8_MAX_PAYOUT_ATTEMPTS, 'max_payout_attempts');
  exactInteger(chainField(value, 'payout_retry_delay_seconds', 'payoutRetryDelaySeconds'), V8_PAYOUT_RETRY_DELAY_SECONDS, 'payout_retry_delay_seconds');
  exactBoolean(chainField(value, 'prepare_retries_capped', 'prepareRetriesCapped'), false, 'prepare_retries_capped');
  exactArray(chainField(value, 'asset_ids', 'assetIds'), V8_ASSET_IDS, 'asset_ids');
  exactArray(value.venues, V8_VENUES, 'venues');
  exactArray(chainField(value, 'supported_objectives', 'supportedObjectives'), V8_SUPPORTED_OBJECTIVES, 'supported_objectives');
  exactText(chainField(value, 'payout_finality', 'payoutFinality'), 'FUNDED_IN_ESCROW', 'payout_finality');
  exactText(chainField(value, 'claimed_semantics', 'claimedSemantics'), 'EOA_WITHDRAWN', 'claimed_semantics');
  const newRiskEnabled = chainField(value, 'new_risk_enabled', 'newRiskEnabled');
  if (typeof newRiskEnabled !== 'boolean') fail('CHAIN_SCHEMA', 'new_risk_enabled must be boolean');
  return Object.freeze({ keeper: config.expected.keeperAddress, newRiskEnabled });
}

export function assertV8ReserveState(config, value) {
  for (const field of [
    'player_liability_atto', 'accrued_platform_fees_atto', 'reserved_platform_fees_atto',
    'funded_platform_fees_atto', 'withdrawn_platform_fees_atto', 'available_reserve_atto',
    'committed_reserve_atto', 'required_available_reserve_atto', 'reserved_player_payouts_atto',
  ]) integerText(chainField(value, field, field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())), field);
  exactBoolean(chainField(value, 'payouts_enabled', 'payoutsEnabled'), true, 'reserve.payouts_enabled');
  exactInteger(chainField(value, 'max_payout_attempts', 'maxPayoutAttempts'), V8_MAX_PAYOUT_ATTEMPTS, 'reserve.max_payout_attempts');
  exactInteger(chainField(value, 'retry_delay_seconds', 'retryDelaySeconds'), V8_PAYOUT_RETRY_DELAY_SECONDS, 'reserve.retry_delay_seconds');
  exactInteger(chainField(value, 'current_platform_fee_bps', 'currentPlatformFeeBps'), V8_PLATFORM_FEE_BPS, 'reserve.current_platform_fee_bps');
  exactText(chainField(value, 'payout_protocol_version', 'payoutProtocolVersion'), V8_PAYOUT_PROTOCOL_VERSION, 'reserve.payout_protocol_version');
  exactText(exactAddress(value.treasury, 'reserve.treasury'), config.expected.treasuryAddress, 'reserve.treasury');
  if (typeof chainField(value, 'new_risk_enabled', 'newRiskEnabled') !== 'boolean') fail('CHAIN_SCHEMA', 'reserve.new_risk_enabled must be boolean');
  return value;
}

function assertNetwork(value) {
  const alias = String(value?.alias ?? '').toLowerCase();
  const chainId = Number(value?.chainId ?? value?.chain_id);
  if (alias !== V8_NETWORK || chainId !== V8_CHAIN_ID) fail('NETWORK_MISMATCH', `active network must be ${V8_NETWORK}/4221`);
}

function assertSigningAccount(value, keeper, canSignLockedAccount) {
  const address = String(value?.address ?? '').toLowerCase();
  if (!ADDRESS.test(address) || value?.active !== true || address !== keeper) fail('KEEPER_MISMATCH', 'active account is not the configured V8 keeper');
  if (String(value?.status ?? '').toLowerCase() !== 'unlocked' && !canSignLockedAccount) fail('ACCOUNT_LOCKED', 'locked keeper requires GENLAYER_KEYSTORE_PASSWORD');
}

async function retry(task, { attempts, baseMs, sleep, label }) {
  let cause;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await task(); } catch (error) {
      cause = error;
      if (attempt < attempts) await sleep(baseMs * (2 ** (attempt - 1)));
    }
  }
  fail('RETRY_EXHAUSTED', `${label} failed after ${attempts} attempts`, { cause });
}

async function readChain(context, label, task) {
  return retry(task, {
    attempts: context.config.operator.readAttempts,
    baseMs: context.config.operator.retryBaseMs,
    sleep: context.sleep,
    label,
  });
}

function normalizedPage(value, offset, label, itemsField) {
  const pageOffset = safeInteger(value?.offset, `${label}.offset`);
  const nextOffset = safeInteger(chainField(value, 'next_offset', 'nextOffset'), `${label}.next_offset`);
  const total = safeInteger(value?.total, `${label}.total`);
  const items = value?.[itemsField] ?? value?.[itemsField.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
  if (pageOffset !== offset || nextOffset < offset || nextOffset > total
      || (offset < total && nextOffset === offset) || !Array.isArray(items)
      || items.length !== nextOffset - offset) fail('CHAIN_SCHEMA', `${label} pagination is inconsistent`);
  return { nextOffset, total, items };
}

async function readAllEpochIds(context) {
  const ids = [];
  let offset = 0;
  let total = null;
  do {
    const page = normalizedPage(
      await readChain(context, `get_epoch_page(${offset})`, () => context.operator.getEpochPage(offset, context.config.operator.pageSize)),
      offset,
      'get_epoch_page',
      'epoch_ids',
    );
    total ??= page.total;
    if (page.total !== total) fail('CHAIN_SCHEMA', 'epoch total changed during one snapshot');
    ids.push(...page.items.map((entry) => {
      const epochId = safeInteger(entry, 'epoch id');
      if (epochId === 0 || epochId % 3_600 !== 0) fail('CHAIN_SCHEMA', 'epoch ID must be an exact positive UTC hour');
      return String(epochId);
    }));
    offset = page.nextOffset;
  } while (offset < total);
  if (new Set(ids).size !== ids.length) fail('CHAIN_SCHEMA', 'epoch page contains duplicate IDs');
  return Object.freeze(ids);
}

export function plannedPayoutScanRanges(totalValue, budgetValue, rotationOrdinal = null) {
  const total = safeInteger(totalValue, 'payout scan total');
  const budget = safeInteger(budgetValue, 'payout scan budget');
  if (budget < 1) fail('KEEPER_ARGUMENT', 'payout scan budget must be positive');
  if (total === 0) return Object.freeze([]);
  const boundedBudget = Math.min(total, budget);
  if (total <= budget || rotationOrdinal === null || rotationOrdinal === undefined) {
    return Object.freeze([Object.freeze({ offset: total - boundedBudget, limit: boundedBudget, lane: 'TAIL' })]);
  }

  const ordinalText = integerText(rotationOrdinal, 'durable payout rotation ordinal');
  const ordinal = BigInt(ordinalText);
  if (ordinal < 1n) fail('KEEPER_ARGUMENT', 'durable payout rotation ordinal must be positive');

  // The journal lease fencing token is a durable, monotonically increasing
  // Bradbury run ordinal. Reserve half the read budget for the newest payouts,
  // then move the other half around the older ID ring on every fenced run.
  const recentBudget = budget === 1 ? 0 : Math.floor(budget / 2);
  const rotatingBudget = budget - recentBudget;
  const olderTotal = total - recentBudget;
  const start = Number(((ordinal - 1n) * BigInt(rotatingBudget)) % BigInt(olderTotal));
  const firstLength = Math.min(rotatingBudget, olderTotal - start);
  const ranges = [Object.freeze({ offset: start, limit: firstLength, lane: 'ROTATING' })];
  const wrappedLength = rotatingBudget - firstLength;
  if (wrappedLength > 0) ranges.push(Object.freeze({ offset: 0, limit: wrappedLength, lane: 'ROTATING' }));
  if (recentBudget > 0) ranges.push(Object.freeze({ offset: olderTotal, limit: recentBudget, lane: 'TAIL' }));
  return Object.freeze(ranges);
}

function validatePayout(value) {
  const payoutId = String(chainField(value, 'payout_id', 'payoutId') ?? '');
  const state = String(value?.state ?? '');
  if (!PAYOUT_ID.test(payoutId) || !PAYOUT_STATES.has(state)) fail('CHAIN_SCHEMA', 'payout record identity or state is invalid');
  const recipient = exactAddress(value.recipient, 'payout.recipient');
  const amountAtto = integerText(chainField(value, 'amount_atto', 'amountAtto'), 'payout.amount_atto');
  if (BigInt(amountAtto) === 0n) fail('CHAIN_SCHEMA', 'payout amount must be positive');
  const prepareAttemptCount = safeInteger(chainField(value, 'prepare_attempt_count', 'prepareAttemptCount'), 'payout.prepare_attempt_count');
  const attemptCount = safeInteger(chainField(value, 'attempt_count', 'attemptCount'), 'payout.attempt_count');
  const lastPrepareTimestamp = safeInteger(chainField(value, 'last_prepare_timestamp', 'lastPrepareTimestamp'), 'payout.last_prepare_timestamp');
  const lastDispatchTimestamp = safeInteger(chainField(value, 'last_dispatch_timestamp', 'lastDispatchTimestamp'), 'payout.last_dispatch_timestamp');
  const kind = String(value?.kind ?? '');
  const escrowWithdrawn = chainField(value, 'escrow_withdrawn', 'escrowWithdrawn');
  if (!['PLAYER', 'FEE'].includes(kind) || prepareAttemptCount < 1
      || attemptCount > V8_MAX_PAYOUT_ATTEMPTS || lastPrepareTimestamp < 1
      || typeof escrowWithdrawn !== 'boolean'
      || (state === 'PREPARING' && (attemptCount !== 0 || lastDispatchTimestamp !== 0 || escrowWithdrawn))
      || (state !== 'PREPARING' && (attemptCount < 1 || lastDispatchTimestamp < 1))
      || ((state === 'EOA_WITHDRAWN') !== escrowWithdrawn)) {
    fail('CHAIN_SCHEMA', 'payout record state invariants are invalid');
  }
  return Object.freeze({ ...value, payoutId, state, kind, recipient, amountAtto, prepareAttemptCount, attemptCount, lastPrepareTimestamp, lastDispatchTimestamp, escrowWithdrawn });
}

async function readPayouts(context) {
  const first = normalizedPage(
    await readChain(context, 'get_payout_page(0)', () => context.operator.getPayoutPage(0, 1)),
    0,
    'get_payout_page',
    'payouts',
  );
  const rotationOrdinal = context.journalSession?.lease?.fencingToken ?? null;
  const ranges = plannedPayoutScanRanges(
    first.total,
    context.config.operator.maxPayoutReadsPerRun,
    rotationOrdinal,
  );
  if (first.total === 0) {
    return Object.freeze({ payouts: Object.freeze([]), ranges, rotationOrdinal, total: 0 });
  }
  const budget = ranges.reduce((sum, range) => sum + range.limit, 0);
  const payouts = [];
  for (const range of ranges) {
    let offset = range.offset;
    const end = range.offset + range.limit;
    while (offset < end) {
      const limit = Math.min(context.config.operator.pageSize, end - offset);
      const page = offset === 0 && first.total === 1
        ? first
        : normalizedPage(
          await readChain(context, `get_payout_page(${offset})`, () => context.operator.getPayoutPage(offset, limit)),
          offset,
          'get_payout_page',
          'payouts',
        );
      if (page.total !== first.total || page.nextOffset > end) fail('CHAIN_SCHEMA', 'payout snapshot changed during scan');
      payouts.push(...page.items.map(validatePayout));
      offset = page.nextOffset;
    }
    if (offset !== end) fail('CHAIN_SCHEMA', 'payout scan range is incomplete');
  }
  if (payouts.length !== budget) fail('CHAIN_SCHEMA', 'payout scan is incomplete');
  if (new Set(payouts.map(({ payoutId }) => payoutId)).size !== payouts.length) {
    fail('CHAIN_SCHEMA', 'payout scan contains duplicate IDs');
  }
  return Object.freeze({
    payouts: Object.freeze(payouts),
    ranges,
    rotationOrdinal: rotationOrdinal === null ? null : String(rotationOrdinal),
    total: first.total,
  });
}

export function classifyPayoutAction(payout, nowEpochSeconds, railState) {
  const now = safeInteger(nowEpochSeconds, 'nowEpochSeconds');
  const payoutId = String(payout?.payoutId ?? chainField(payout, 'payout_id', 'payoutId') ?? '');
  const state = String(payout?.state ?? '');
  if (!PAYOUT_ID.test(payoutId)) fail('CHAIN_SCHEMA', 'payout ID is invalid');
  const lastPrepareTimestamp = safeInteger(
    payout?.lastPrepareTimestamp ?? chainField(payout, 'last_prepare_timestamp', 'lastPrepareTimestamp'),
    'payout.last_prepare_timestamp',
  );
  const lastDispatchTimestamp = safeInteger(
    payout?.lastDispatchTimestamp ?? chainField(payout, 'last_dispatch_timestamp', 'lastDispatchTimestamp'),
    'payout.last_dispatch_timestamp',
  );
  const attemptCount = safeInteger(
    payout?.attemptCount ?? chainField(payout, 'attempt_count', 'attemptCount'),
    'payout.attempt_count',
  );
  if (!railState || typeof railState.prepared !== 'boolean'
      || typeof railState.credited !== 'boolean' || typeof railState.withdrawn !== 'boolean') {
    fail('EVM_PAYOUT_SCHEMA', 'exact EVM payout rail state is required');
  }
  if ((railState.withdrawn && !railState.credited) || (railState.credited && !railState.prepared)) {
    fail('EVM_PAYOUT_SCHEMA', 'EVM payout rail violates withdrawn => credited => prepared');
  }
  if (state === 'PREPARING') {
    if (railState.prepared) return Object.freeze({ type: 'DISPATCH', payoutId });
    if (now >= lastPrepareTimestamp + V8_PAYOUT_RETRY_DELAY_SECONDS) {
      return Object.freeze({ type: 'RETRY_PREPARE', payoutId });
    }
    return null;
  }
  if (state === 'DISPATCHED') {
    if (railState.credited) return Object.freeze({ type: 'CONFIRM', payoutId });
    const retryDue = attemptCount < V8_MAX_PAYOUT_ATTEMPTS
      && now >= lastDispatchTimestamp + V8_PAYOUT_RETRY_DELAY_SECONDS;
    return retryDue ? Object.freeze({ type: 'RETRY_PAYOUT', payoutId }) : null;
  }
  if (state === 'FUNDED_IN_ESCROW') {
    return railState.withdrawn ? Object.freeze({ type: 'REFRESH', payoutId }) : null;
  }
  return null;
}

function assertEpoch(config, value, epochEndTimestamp) {
  const expected = expectedEpochRecord(config, epochEndTimestamp);
  for (const [field, expectedValue] of [
    ['epoch_end_timestamp', expected.epochEndTimestamp],
    ['wager_opens_timestamp', expected.wagerOpensTimestamp],
    ['wager_closes_timestamp', expected.wagerClosesTimestamp],
    ['battle_starts_timestamp', expected.wagerClosesTimestamp],
    ['resolution_available_timestamp', expected.resolutionAvailableTimestamp],
    ['timeout_refund_available_timestamp', expected.timeoutRefundAvailableTimestamp],
    ['platform_fee_bps_snapshot', expected.platformFeeBpsSnapshot],
    ['min_stake_atto', expected.minStakeAtto],
    ['max_stake_per_wallet_atto', expected.maxStakePerWalletAtto],
  ]) exactInteger(chainField(value, field, field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())), expectedValue, `epoch.${field}`);
  exactText(chainField(value, 'policy_version', 'policyVersion'), expected.policyVersion, 'epoch.policy_version');
  const status = String(value?.status ?? '');
  if (status !== 'OPEN' && !TERMINAL_EPOCH_STATUSES.has(status)) fail('CHAIN_SCHEMA', `unknown epoch status ${status}`);
  return value;
}

export function classifyOpenEpoch(epoch, nowEpochSeconds) {
  if (String(epoch?.status ?? '') !== 'OPEN') return null;
  const timeout = safeInteger(chainField(epoch, 'timeout_refund_available_timestamp', 'timeoutRefundAvailableTimestamp'), 'timeout timestamp');
  const resolution = safeInteger(chainField(epoch, 'resolution_available_timestamp', 'resolutionAvailableTimestamp'), 'resolution timestamp');
  if (nowEpochSeconds >= timeout) return 'TIMEOUT';
  if (nowEpochSeconds >= resolution) return 'RESOLVE';
  return null;
}

export async function planV8KeeperRun(context) {
  const epochIds = await readAllEpochIds(context);
  const known = new Set(epochIds);
  const payoutScan = await readPayouts(context);
  const { payouts } = payoutScan;
  const actions = [];
  for (const payout of payouts) {
    if (payout.state === 'EOA_WITHDRAWN') continue;
    const railState = await readChain(
      context,
      `EVM payout rail ${payout.payoutId}`,
      () => context.operator.getPayoutRailState(payout),
    );
    const action = classifyPayoutAction(payout, context.nowEpochSeconds, railState);
    if (action) actions.push(action);
  }
  const due = epochIds.map(Number)
    .filter((end) => end + V8_RESOLUTION_PUBLICATION_DELAY_SECONDS <= context.nowEpochSeconds)
    .sort((left, right) => right - left)
    .slice(0, context.config.operator.maxEpochReadsPerRun);
  for (const epochEndTimestamp of due) {
    const epoch = assertEpoch(
      context.config,
      await readChain(context, `get_epoch(${epochEndTimestamp})`, () => context.operator.getEpoch(epochEndTimestamp)),
      epochEndTimestamp,
    );
    const type = classifyOpenEpoch(epoch, context.nowEpochSeconds);
    if (type) actions.push(Object.freeze({ type, epochEndTimestamp }));
  }
  if (context.roles.newRiskEnabled) {
    for (const epochEndTimestamp of plannedFutureEpochEnds(context.config, context.nowEpochSeconds)) {
      if (!known.has(String(epochEndTimestamp))) actions.push(Object.freeze({ type: 'CREATE', epochEndTimestamp }));
    }
  }
  const priority = { REFRESH: 0, CONFIRM: 1, RETRY_PAYOUT: 2, DISPATCH: 3, RETRY_PREPARE: 4, TIMEOUT: 5, RESOLVE: 6, CREATE: 7 };
  actions.sort((left, right) => priority[left.type] - priority[right.type]
    || String(left.payoutId ?? left.epochEndTimestamp).localeCompare(String(right.payoutId ?? right.epochEndTimestamp)));
  const selected = actions.slice(0, context.config.operator.maxWritesPerRun);
  return Object.freeze({
    knownEpochCount: epochIds.length,
    totalPayoutCount: payoutScan.total,
    scannedPayoutCount: payouts.length,
    payoutScanRanges: payoutScan.ranges,
    payoutRotationOrdinal: payoutScan.rotationOrdinal,
    actions: Object.freeze(selected),
    deferredActionCount: actions.length - selected.length,
  });
}

export function validateReceiptIdentity(receipt, contractAddress, method, args) {
  assertFinalizedGenlayerExecution(receipt);
  const call = receipt?.txDataDecoded?.callData;
  const actual = call?.args;
  if (String(receipt?.recipient ?? '').toLowerCase() !== contractAddress.toLowerCase()
      || receipt?.txDataDecoded?.type !== 'call' || call?.method !== method
      || !Array.isArray(actual) || actual.length !== args.length
      || actual.some((entry, index) => String(entry) !== String(args[index]))) {
    fail('RECEIPT_IDENTITY_MISMATCH', `finalized receipt does not prove ${method}`);
  }
  return receipt;
}

export function assertActionPostState(action, value) {
  if (action.type === 'CREATE' && value.status === 'OPEN') return 'EPOCH_OPEN';
  if (action.type === 'RESOLVE' && value.status === 'RESOLVED'
      && String(chainField(value, 'result_status', 'resultStatus')) === 'DETERMINED'
      && String(chainField(value, 'resolution_digest', 'resolutionDigest'))) return 'EPOCH_RESOLVED';
  if (action.type === 'TIMEOUT' && value.status === 'TIMED_OUT'
      && String(chainField(value, 'result_status', 'resultStatus')) === 'TIMEOUT') return 'EPOCH_TIMED_OUT';
  const payoutState = String(value?.state ?? '');
  const atOrAfterPreparing = ['PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'].includes(payoutState);
  const atOrAfterDispatch = ['DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'].includes(payoutState);
  if (action.type === 'RETRY_PREPARE' && atOrAfterPreparing && value.prepareAttemptCount >= 2) return 'PAYOUT_PREPARE_RETRIED';
  if (action.type === 'DISPATCH' && atOrAfterDispatch && value.attemptCount >= 1) return 'PAYOUT_DISPATCHED';
  if (action.type === 'RETRY_PAYOUT' && atOrAfterDispatch && value.attemptCount >= 2) return 'PAYOUT_RETRIED';
  if (action.type === 'CONFIRM' && ['FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'].includes(payoutState)) return 'PAYOUT_FUNDED';
  if (action.type === 'REFRESH' && payoutState === 'EOA_WITHDRAWN'
      && chainField(value, 'escrow_withdrawn', 'escrowWithdrawn') === true) return 'PAYOUT_WITHDRAWN';
  fail('POST_STATE_MISMATCH', `${action.type} post-state is not satisfied`);
}

async function verifiedPostState(context, action) {
  let cause;
  for (let attempt = 1; attempt <= context.config.operator.postStateAttempts; attempt += 1) {
    try {
      const value = action.payoutId
        ? validatePayout(await readChain(context, `get_payout(${action.payoutId})`, () => context.operator.getPayout(action.payoutId)))
        : assertEpoch(context.config, await readChain(context, `get_epoch(${action.epochEndTimestamp})`, () => context.operator.getEpoch(action.epochEndTimestamp)), action.epochEndTimestamp);
      const status = assertActionPostState(action, value);
      return Object.freeze({ ...value, status });
    } catch (error) {
      cause = error;
      if (attempt < context.config.operator.postStateAttempts) await context.sleep(context.config.operator.postStateIntervalMs);
    }
  }
  fail('POST_STATE_NOT_VISIBLE', `${action.type} post-state was not verified`, { cause });
}

function recoveryOptions(context) {
  return {
    session: context.journalSession,
    deploymentAlias: 'v8',
    contractAddress: context.config.contractAddress,
    operator: context.operator,
    validateReceipt: (receipt, operation) => validateReceiptIdentity(receipt, operation.contractAddress, operation.method, operation.args),
    verifyPostState: (action) => verifiedPostState(context, action),
    sleep: context.sleep,
    lifecycleAttempts: context.config.operator.finalityRetries,
    lifecycleIntervalMs: context.config.operator.finalityIntervalMs,
    receiptPolicy: { retries: 1, intervalMs: context.config.operator.finalityIntervalMs },
    deadlineAtMs: context.deadlineAtMs,
    clockMs: context.clockMs,
    logger: context.logger,
  };
}

async function executeAction(context, action) {
  const identity = keeperOperationForAction({ deploymentAlias: 'v8', contractAddress: context.config.contractAddress, action });
  assertSigningAccount(
    await readChain(context, 'account before write', () => context.operator.getAccountInfo()),
    context.config.expected.keeperAddress,
    context.operator.canSignLockedAccount === true,
  );
  await context.journalSession.renew();
  const prepared = await context.journalSession.prepare(identity.operation);
  if (prepared?.canBroadcast !== true) {
    const operation = prepared?.operation ? validateRecoveredKeeperOperation(prepared.operation) : null;
    return Object.freeze({ ...action, transactionHash: operation?.transactionHash || null, pendingReceipt: true, reason: 'AUTHORITATIVE_PREPARE_NOT_BROADCASTABLE' });
  }
  let operation = validateRecoveredKeeperOperation(prepared.operation);
  if (prepared.inserted !== true || operation.state !== 'PREPARED'
      || operation.logicalOperationId !== identity.logicalOperationId
      || operation.subjectId !== identity.operation.subjectId) fail('KEEPER_JOURNAL_IDENTITY', 'prepared operation does not match the intended V8 write');
  await context.journalSession.renew();
  let transactionHash;
  await context.operator.submitWrite(identity.call.method, identity.call.args, async (hash) => {
    transactionHash = hash;
    const bound = await context.journalSession.bind(operation.operationId, hash);
    operation = validateRecoveredKeeperOperation(bound?.operation);
    if (operation.state !== 'SUBMITTED' || operation.transactionHash !== String(hash).toLowerCase()) fail('KEEPER_JOURNAL_IDENTITY', 'submission hash was not durably bound');
  });
  if (!/^0x[0-9a-f]{64}$/i.test(String(transactionHash || ''))) fail('TRANSACTION_HASH_NOT_DURABLE', 'write exited without a durable transaction hash');
  const reconciled = await reconcileAuthoritativeOperation({ ...recoveryOptions(context), operation });
  if (!reconciled.verified) return Object.freeze({ ...action, transactionHash, pendingReceipt: true, reason: reconciled.pending.reason });
  context.logger({ event: 'V8_KEEPER_ACTION_VERIFIED', ...action, transactionHash, status: reconciled.postState.status });
  return Object.freeze({ ...action, transactionHash, status: reconciled.postState.status });
}

async function revalidate(context, action) {
  if (action.epochEndTimestamp && action.type !== 'CREATE') {
    const epoch = assertEpoch(context.config, await readChain(context, 'revalidate epoch', () => context.operator.getEpoch(action.epochEndTimestamp)), action.epochEndTimestamp);
    const type = classifyOpenEpoch(epoch, context.nowEpochSeconds);
    return type ? Object.freeze({ ...action, type }) : null;
  }
  if (action.payoutId) {
    const payout = validatePayout(await readChain(context, 'revalidate payout', () => context.operator.getPayout(action.payoutId)));
    const railState = await readChain(
      context,
      'revalidate EVM payout rail',
      () => context.operator.getPayoutRailState(payout),
    );
    return classifyPayoutAction(payout, context.nowEpochSeconds, railState);
  }
  return action;
}

export async function runV8KeeperOnce({
  config,
  execute = false,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
  operator,
  journalClient = operator?.journalClient,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = (event) => console.log(JSON.stringify(event)),
  deadlineAtMs = Date.now() + 45 * 60 * 1_000,
  clockMs = Date.now,
  journalSessionOptions = {},
} = {}) {
  if (!config || !operator) fail('KEEPER_ARGUMENT', 'config and operator are required');
  const context = { config, execute, nowEpochSeconds: safeInteger(nowEpochSeconds, 'nowEpochSeconds'), operator, sleep, logger, deadlineAtMs, clockMs, journalSession: null, roles: null };
  assertNetwork(await readChain(context, 'network info', () => operator.getNetworkInfo()));
  assertV8Schema(await readChain(context, 'contract schema', () => operator.getSchema()));
  context.roles = assertV8ContractConfiguration(config, await readChain(context, 'get_config', () => operator.getConfig()));
  assertV8ReserveState(config, await readChain(context, 'get_delivery_reserve_state', () => operator.getReserveState()));
  if (!execute) {
    const plan = await planV8KeeperRun(context);
    logger({ event: 'V8_KEEPER_DRY_RUN_PLAN', ...plan });
    return Object.freeze({ ...plan, execute: false, recovered: [], completed: [], pending: [], skipped: [], failures: [], blocked: false });
  }
  assertSigningAccount(await readChain(context, 'account info', () => operator.getAccountInfo()), config.expected.keeperAddress, operator.canSignLockedAccount === true);
  const journalSession = createAuthoritativeKeeperSession({ client: journalClient, signerAddress: config.expected.keeperAddress, logger, ...journalSessionOptions });
  context.journalSession = journalSession;
  await journalSession.acquire();
  try {
    return await journalSession.withHeartbeat(async () => {
      const recovery = await recoverAuthoritativeOperations(recoveryOptions(context));
      if (recovery.blocked) return Object.freeze({ execute: true, actions: [], recovered: recovery.recovered, completed: [], pending: recovery.pending, skipped: [], failures: [], blocked: true });
      const plan = await planV8KeeperRun(context);
      const completed = [];
      const pending = [];
      const skipped = [];
      const failures = [];
      for (let index = 0; index < plan.actions.length; index += 1) {
        if (clockMs() >= deadlineAtMs) {
          skipped.push(...plan.actions.slice(index).map((action) => ({ ...action, reason: 'RUN_DEADLINE' })));
          break;
        }
        const planned = plan.actions[index];
        try {
          const action = await revalidate(context, planned);
          if (!action) { skipped.push({ ...planned, reason: 'NO_LONGER_ACTIONABLE' }); continue; }
          const result = await executeAction(context, action);
          if (result.pendingReceipt) {
            pending.push(result);
            skipped.push(...plan.actions.slice(index + 1).map((item) => ({ ...item, reason: 'BLOCKED_BY_NONTERMINAL_OPERATION' })));
            break;
          }
          completed.push(result);
        } catch (error) {
          failures.push({ ...planned, code: error?.code || 'ACTION_FAILED', message: error instanceof Error ? error.message : String(error) });
          skipped.push(...plan.actions.slice(index + 1).map((item) => ({ ...item, reason: 'BLOCKED_AFTER_ACTION_FAILURE' })));
          break;
        }
      }
      const summary = Object.freeze({ ...plan, execute: true, recovered: recovery.recovered, completed, pending, skipped, failures, blocked: pending.length > 0 || failures.length > 0 });
      if (failures.length) throw new V8KeeperError('ACTION_FAILURES', `${failures.length} V8 keeper action(s) failed`, { summary });
      return summary;
    });
  } finally {
    await journalSession.release();
  }
}

export function createCliV8KeeperOperator({ config, environment = process.env } = {}) {
  const invocation = resolveGenlayerCommand();
  const password = environment.GENLAYER_KEYSTORE_PASSWORD || '';
  const quiet = { writeStdout: NO_OUTPUT, writeStderr: NO_OUTPUT };
  const reader = createClient({ chain: testnetBradbury });
  // Keep network detection enabled: every EVM read must prove the endpoint is
  // still Bradbury chain 4221 before ethers will accept its result.
  const evmProvider = new JsonRpcProvider(V8_EVM_RPC_URL, V8_CHAIN_ID);
  const factory = new Contract(config.expected.payoutFactoryAddress, V8_FACTORY_VIEW_ABI, evmProvider);
  const call = (method, args = []) => runGenlayerCall({ invocation, contractAddress: config.contractAddress, method, args, ...quiet });
  const inspect = async (command, args = []) => parseGenlayerCallOutput((await runGenlayerStreamingCommand({ invocation, command, args, ...quiet })).output);
  return Object.freeze({
    canSignLockedAccount: password !== '',
    getNetworkInfo: () => inspect('network', ['info']),
    getAccountInfo: () => inspect('account'),
    getSchema: () => reader.getContractSchema(config.contractAddress),
    getConfig: () => call('get_config'),
    getReserveState: () => call('get_delivery_reserve_state'),
    getEpochPage: (offset, limit) => call('get_epoch_page', [offset, limit]),
    getEpoch: (epochEndTimestamp) => call('get_epoch', [epochEndTimestamp]),
    getPayoutPage: (offset, limit) => call('get_payout_page', [offset, limit]),
    getPayout: (payoutId) => call('get_payout', [payoutId]),
    getPayoutRailState: async (payout) => {
      const [prepared, credited, withdrawn] = await Promise.all([
        factory.is_prepared(payout.payoutId, payout.recipient, BigInt(payout.amountAtto)),
        factory.is_credited(payout.payoutId, payout.recipient, BigInt(payout.amountAtto)),
        factory.is_withdrawn(payout.payoutId, payout.recipient, BigInt(payout.amountAtto)),
      ]);
      return Object.freeze({ prepared: prepared === true, credited: credited === true, withdrawn: withdrawn === true });
    },
    getTransactionStatus: (transactionHash) => getGenlayerTransactionStatus({ rpcUrl: GENLAYER_BRADBURY_RPC_URL, transactionHash }),
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
  return 'Reconcile Liquidity Arena V8 epochs and EVM-backed payouts on Bradbury.\n\nUsage:\n  node scripts/v8-keeper.mjs --config <file> [--execute]\n\nThe default is a read-only plan. --execute requires the fenced V8 keeper, schema-v4 journal, and exact testnet-bradbury network. The keeper never calls an EVM vault withdrawal; only recipients can withdraw.';
}

function parseArguments(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') result.execute = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--config') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--config requires a value');
      result.configPath = argv[++index];
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}

export async function runV8KeeperCli(argv = process.argv.slice(2), {
  environment = process.env,
  loadConfig = loadV8KeeperConfig,
  createOperator = createCliV8KeeperOperator,
  createJournalClient = createKeeperJournalClientFromEnvironment,
  runOnce = runV8KeeperOnce,
} = {}) {
  const parsed = parseArguments(argv);
  if (parsed.help) { console.log(usage()); return undefined; }
  if (!parsed.configPath) throw new Error('--config is required');
  const config = loadConfig(parsed.configPath, { environment });
  const operator = createOperator({ config, environment });
  const summary = await runOnce({ config, execute: parsed.execute, operator, journalClient: parsed.execute ? createJournalClient(environment) : undefined });
  if (summary?.blocked) throw new V8KeeperError('RUN_BLOCKED', 'V8 keeper stopped with an authoritative operation blocked', { summary });
  return summary;
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && process.argv[1] === invokedPath) {
  runV8KeeperCli().catch((error) => {
    console.error(JSON.stringify({ event: 'V8_KEEPER_FAILED', code: error?.code || 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
