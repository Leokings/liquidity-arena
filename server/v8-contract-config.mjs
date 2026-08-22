import { createHash } from 'node:crypto';

import {
  LIQUIDITY_ARENA_PAYOUT_PROTOCOL,
  LIQUIDITY_ARENA_POLICY,
  LIQUIDITY_ARENA_V8_PROTOCOL,
  normalizedAtto,
  normalizedContractAddress,
} from './deployment-config.mjs';

function schemaMethod(params = [], readonly = false, payable = false, ret = 'null') {
  const result = { params, kwparams: {}, readonly, ret };
  if (!readonly) result.payable = payable;
  return result;
}

export const EXPECTED_V8_SCHEMA = Object.freeze({
  ctor: {
    params: [
      ['treasury', 'address'],
      ['keeper', 'address'],
      ['epoch_min_stake_atto', 'int'],
      ['epoch_max_stake_per_wallet_atto', 'int'],
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
    enter: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'], ['asset_id', 'string'],
    ], false, true),
    fund_delivery_reserve: schemaMethod([], false, true),
    get_claim_quote: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'], ['account', 'address'],
    ], true, false, 'dict'),
    get_config: schemaMethod([], true, false, 'dict'),
    get_delivery_reserve_state: schemaMethod([], true, false, 'dict'),
    get_epoch: schemaMethod([['epoch_end_timestamp', 'int']], true, false, 'dict'),
    get_epoch_asset: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['asset_id', 'string'],
    ], true, false, 'dict'),
    get_epoch_page: schemaMethod([['offset', 'int'], ['limit', 'int']], true, false, 'dict'),
    get_objective: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'],
    ], true, false, 'dict'),
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const V8_CONFIG_KEYS = Object.freeze([
  'protocol_version', 'policy_version', 'owner', 'keeper', 'treasury',
  'payout_vault_factory', 'payout_protocol_version', 'payouts_enabled',
  'new_risk_enabled', 'max_payout_attempts', 'prepare_retries_capped',
  'payout_retry_delay_seconds', 'current_platform_fee_bps', 'epoch_min_stake_atto',
  'epoch_max_stake_per_wallet_atto', 'minimum_epoch_creation_lead_seconds',
  'keeper_max_schedule_ahead_seconds', 'wager_open_offset_seconds',
  'battle_open_offset_seconds', 'resolution_publication_delay_seconds',
  'timeout_refund_delay_seconds', 'minimum_qualified_venues', 'asset_ids', 'venues',
  'validator_return_tolerance_ppb', 'supported_objectives', 'payout_finality',
  'claimed_semantics',
]);

const V8_RESERVE_KEYS = Object.freeze([
  'treasury', 'current_platform_fee_bps', 'payout_protocol_version', 'payouts_enabled',
  'new_risk_enabled', 'player_liability_atto', 'accrued_platform_fees_atto',
  'reserved_platform_fees_atto', 'funded_platform_fees_atto',
  'withdrawn_platform_fees_atto', 'available_reserve_atto', 'committed_reserve_atto',
  'required_available_reserve_atto', 'reserved_player_payouts_atto',
  'max_payout_attempts', 'prepare_retries_capped', 'retry_delay_seconds',
]);

function exactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are not release-exact.`);
  }
  return value;
}

export const EXPECTED_V8_SCHEMA_SHA256 = createHash('sha256')
  .update(stableStringify(EXPECTED_V8_SCHEMA))
  .digest('hex');

function sameAddress(left, right, label) {
  const actual = normalizedContractAddress(left, label).toLowerCase();
  const expected = normalizedContractAddress(right, `expected ${label}`).toLowerCase();
  if (actual !== expected) throw new Error(`${label} does not match the V8 deployment expectation.`);
  return actual;
}

function exactInteger(raw, expected, label) {
  const value = normalizedAtto(raw, label);
  if (value !== String(expected)) throw new Error(`${label} does not match the V8 protocol.`);
  return value;
}

function exactArray(raw, expected, label) {
  if (!Array.isArray(raw) || raw.length !== expected.length
    || raw.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} does not match the V8 protocol.`);
  }
  return Object.freeze([...raw]);
}

export function validateLiquidityArenaV8Schema(schema) {
  if (stableStringify(schema) !== stableStringify(EXPECTED_V8_SCHEMA)) {
    throw new Error('Contract schema is not the exact reviewed 25-method V8 ABI.');
  }
  return Object.freeze({
    methodCount: Object.keys(EXPECTED_V8_SCHEMA.methods).length,
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
  });
}

export function validateLiquidityArenaV8Config(raw, expected) {
  if (!expected) {
    throw new TypeError('Liquidity Arena V8 config and expectations are required.');
  }
  exactObjectKeys(raw, V8_CONFIG_KEYS, 'Liquidity Arena V8 config');
  if (raw.protocol_version !== LIQUIDITY_ARENA_V8_PROTOCOL
    || raw.policy_version !== LIQUIDITY_ARENA_POLICY
    || raw.payout_protocol_version !== LIQUIDITY_ARENA_PAYOUT_PROTOCOL) {
    throw new Error('Contract protocol identity is not the reviewed V8 payout protocol.');
  }
  const owner = sameAddress(raw.owner, expected.owner, 'contract owner');
  const keeper = sameAddress(raw.keeper, expected.keeper, 'contract keeper');
  const treasury = sameAddress(raw.treasury, expected.treasury, 'contract treasury');
  const payoutFactory = sameAddress(raw.payout_vault_factory, expected.payoutFactory, 'contract payout factory');
  if (raw.payouts_enabled !== true || raw.new_risk_enabled !== true
    || raw.prepare_retries_capped !== false) {
    throw new Error('V8 payout activation or new-risk state is not production-ready.');
  }
  exactInteger(raw.max_payout_attempts, 3, 'max_payout_attempts');
  exactInteger(raw.payout_retry_delay_seconds, 3_600, 'payout_retry_delay_seconds');
  exactInteger(raw.current_platform_fee_bps, 200, 'current_platform_fee_bps');
  const minimumStakeAtto = normalizedAtto(raw.epoch_min_stake_atto, 'epoch_min_stake_atto', { positive: true });
  const maximumStakePerWalletAtto = normalizedAtto(
    raw.epoch_max_stake_per_wallet_atto,
    'epoch_max_stake_per_wallet_atto',
    { positive: true },
  );
  if (minimumStakeAtto !== expected.minimumStakeAtto
    || maximumStakePerWalletAtto !== expected.maximumStakePerWalletAtto) {
    throw new Error('Contract stake limits do not match the V8 deployment expectation.');
  }
  exactInteger(raw.minimum_epoch_creation_lead_seconds, 3_600, 'minimum_epoch_creation_lead_seconds');
  exactInteger(raw.keeper_max_schedule_ahead_seconds, 93_600, 'keeper_max_schedule_ahead_seconds');
  exactInteger(raw.wager_open_offset_seconds, 2_400, 'wager_open_offset_seconds');
  exactInteger(raw.battle_open_offset_seconds, 1_200, 'battle_open_offset_seconds');
  exactInteger(raw.resolution_publication_delay_seconds, 120, 'resolution_publication_delay_seconds');
  exactInteger(raw.timeout_refund_delay_seconds, 86_400, 'timeout_refund_delay_seconds');
  exactInteger(raw.minimum_qualified_venues, 3, 'minimum_qualified_venues');
  exactInteger(raw.validator_return_tolerance_ppb, 100_000, 'validator_return_tolerance_ppb');
  exactArray(raw.asset_ids, ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'], 'asset_ids');
  exactArray(raw.venues, ['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN'], 'venues');
  exactArray(raw.supported_objectives, ['HIGH', 'LOW'], 'supported_objectives');
  if (raw.payout_finality !== 'FUNDED_IN_ESCROW' || raw.claimed_semantics !== 'EOA_WITHDRAWN') {
    throw new Error('Contract payout finality semantics do not match V8.');
  }
  return Object.freeze({
    protocolVersion: LIQUIDITY_ARENA_V8_PROTOCOL,
    policyVersion: LIQUIDITY_ARENA_POLICY,
    payoutProtocolVersion: LIQUIDITY_ARENA_PAYOUT_PROTOCOL,
    owner,
    keeper,
    treasury,
    payoutFactory,
    payoutsEnabled: true,
    newRiskEnabled: true,
    platformFeeBps: 200,
    minimumStakeAtto,
    maximumStakePerWalletAtto,
  });
}

export function validateLiquidityArenaV8Reserve(raw, expected) {
  if (!expected) {
    throw new TypeError('Liquidity Arena V8 reserve state and expectations are required.');
  }
  exactObjectKeys(raw, V8_RESERVE_KEYS, 'Liquidity Arena V8 reserve state');
  sameAddress(raw.treasury, expected.treasury, 'reserve treasury');
  if (raw.payout_protocol_version !== LIQUIDITY_ARENA_PAYOUT_PROTOCOL
    || raw.payouts_enabled !== true || raw.new_risk_enabled !== true
    || raw.prepare_retries_capped !== false) {
    throw new Error('V8 reserve reports an inactive or incompatible payout rail.');
  }
  exactInteger(raw.current_platform_fee_bps, 200, 'reserve current_platform_fee_bps');
  exactInteger(raw.max_payout_attempts, 3, 'reserve max_payout_attempts');
  exactInteger(raw.retry_delay_seconds, 3_600, 'reserve retry_delay_seconds');
  const fields = [
    'player_liability_atto',
    'accrued_platform_fees_atto',
    'reserved_platform_fees_atto',
    'funded_platform_fees_atto',
    'withdrawn_platform_fees_atto',
    'available_reserve_atto',
    'committed_reserve_atto',
    'required_available_reserve_atto',
    'reserved_player_payouts_atto',
  ];
  const amounts = Object.fromEntries(fields.map((field) => [field, normalizedAtto(raw[field], field)]));
  if (BigInt(amounts.available_reserve_atto) < BigInt(expected.minimumAvailableReserveAtto)
    || BigInt(amounts.available_reserve_atto) < BigInt(amounts.required_available_reserve_atto)) {
    throw new Error('V8 delivery reserve is below its configured or live required minimum.');
  }
  return Object.freeze({
    ready: true,
    availableReserveAtto: amounts.available_reserve_atto,
    requiredAvailableReserveAtto: amounts.required_available_reserve_atto,
    minimumAvailableReserveAtto: expected.minimumAvailableReserveAtto,
    committedReserveAtto: amounts.committed_reserve_atto,
    playerLiabilityAtto: amounts.player_liability_atto,
    reservedPlayerPayoutsAtto: amounts.reserved_player_payouts_atto,
  });
}
