import {
  LIQUIDITY_ARENA_POLICY,
  LIQUIDITY_ARENA_V7_PROTOCOL,
  normalizedAtto,
  normalizedContractAddress,
} from './deployment-config.mjs';

const REQUIRED_SETTLEMENT_MODES = Object.freeze([
  'PENDING',
  'PARIMUTUEL',
  'REFUND_TIE',
  'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE',
  'REFUND_UNDETERMINED',
  'REFUND_TIMEOUT',
]);

function exactInteger(value, expected, label) {
  const normalized = normalizedAtto(value, label);
  if (normalized !== String(expected)) throw new Error(`${label} must equal ${expected}.`);
}

function exactText(value, expected, label) {
  if (String(value || '').trim().toUpperCase() !== expected) {
    throw new Error(`${label} must equal ${expected}.`);
  }
}

function exactSet(value, expected, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const normalized = value.map((item) => String(item).trim().toUpperCase());
  if (normalized.length !== expected.length
    || new Set(normalized).size !== expected.length
    || expected.some((item) => !normalized.includes(item))) {
    throw new Error(`${label} must be exactly ${expected.join(', ')}.`);
  }
}

function sameAddress(left, right, leftLabel, rightLabel) {
  return normalizedContractAddress(left, leftLabel).toLowerCase()
    === normalizedContractAddress(right, rightLabel).toLowerCase();
}

export function validateLiquidityArenaV7Config(raw, expected) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Liquidity Arena V7 contract config must be an object.');
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new TypeError('Liquidity Arena V7 expected deployment profile is required.');
  }
  exactText(raw.protocol_version, LIQUIDITY_ARENA_V7_PROTOCOL, 'protocol_version');
  exactText(raw.policy_version, LIQUIDITY_ARENA_POLICY, 'policy_version');
  const owner = normalizedContractAddress(raw.owner, 'contract owner');
  const keeper = normalizedContractAddress(raw.keeper, 'contract keeper');
  const treasury = normalizedContractAddress(raw.treasury, 'contract treasury');
  if (!sameAddress(owner, expected.owner, 'contract owner', 'expected owner')) {
    throw new Error('Contract owner does not match GENLAYER_V7_OWNER.');
  }
  if (!sameAddress(keeper, expected.keeper, 'contract keeper', 'expected keeper')) {
    throw new Error('Contract keeper does not match GENLAYER_V7_KEEPER.');
  }
  if (!sameAddress(treasury, expected.treasury, 'contract treasury', 'expected treasury')) {
    throw new Error('Contract treasury does not match GENLAYER_V7_TREASURY.');
  }

  exactText(raw.native_token_symbol, 'GEN', 'native_token_symbol');
  exactInteger(raw.native_token_decimals, 18, 'native_token_decimals');
  exactInteger(raw.current_platform_fee_bps, 200, 'current_platform_fee_bps');
  exactInteger(raw.default_platform_fee_bps, 200, 'default_platform_fee_bps');
  exactInteger(raw.max_platform_fee_bps, 500, 'max_platform_fee_bps');
  const minimumStakeAtto = normalizedAtto(raw.epoch_min_stake_atto, 'epoch_min_stake_atto', {
    positive: true,
  });
  const maximumStakePerWalletAtto = normalizedAtto(
    raw.epoch_max_stake_per_wallet_atto,
    'epoch_max_stake_per_wallet_atto',
    { positive: true },
  );
  if (minimumStakeAtto !== expected.minimumStakeAtto) {
    throw new Error('epoch_min_stake_atto does not match the fixed deployment stake.');
  }
  if (maximumStakePerWalletAtto !== expected.maximumStakePerWalletAtto) {
    throw new Error('epoch_max_stake_per_wallet_atto does not match the fixed wallet cap.');
  }
  exactInteger(raw.minimum_epoch_creation_lead_seconds, 3_600, 'minimum_epoch_creation_lead_seconds');
  exactInteger(raw.keeper_max_schedule_ahead_seconds, 93_600, 'keeper_max_schedule_ahead_seconds');
  exactInteger(raw.owner_max_schedule_ahead_seconds, 2_678_400, 'owner_max_schedule_ahead_seconds');
  exactInteger(raw.wager_open_offset_seconds, 2_400, 'wager_open_offset_seconds');
  exactInteger(raw.battle_open_offset_seconds, 1_200, 'battle_open_offset_seconds');
  exactInteger(raw.resolution_publication_delay_seconds, 120, 'resolution_publication_delay_seconds');
  exactInteger(raw.timeout_refund_delay_seconds, 86_400, 'timeout_refund_delay_seconds');
  exactInteger(raw.minimum_qualified_venues, 3, 'minimum_qualified_venues');
  exactInteger(raw.validator_return_tolerance_ppb, 100_000, 'validator_return_tolerance_ppb');
  exactInteger(raw.price_scale, 100_000_000, 'price_scale');
  exactInteger(raw.return_scale, 1_000_000_000, 'return_scale');
  exactText(raw.four_venue_median_policy, 'FLOOR_AVERAGE_OF_MIDDLE_TWO', 'four_venue_median_policy');
  exactText(raw.rounding_policy, 'LAST_WINNING_CLAIMANT_RECEIVES_REMAINDER', 'rounding_policy');
  exactText(raw.transfer_finality, 'FINALIZED', 'transfer_finality');
  exactSet(raw.supported_objectives, ['HIGH', 'LOW'], 'supported_objectives');
  exactSet(raw.supported_settlement_modes, REQUIRED_SETTLEMENT_MODES, 'supported_settlement_modes');

  return Object.freeze({
    protocolVersion: LIQUIDITY_ARENA_V7_PROTOCOL,
    policyVersion: LIQUIDITY_ARENA_POLICY,
    platformFeeBps: 200,
    owner,
    keeper,
    treasury,
    minimumStakeAtto,
    maximumStakePerWalletAtto,
  });
}
