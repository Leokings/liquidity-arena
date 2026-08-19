import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLiquidityArenaV7Config } from './v7-contract-config.mjs';

const OWNER = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x4444444444444444444444444444444444444444';
const TREASURY = '0x5555555555555555555555555555555555555555';
const EXPECTED = Object.freeze({
  owner: OWNER,
  keeper: KEEPER,
  treasury: TREASURY,
  minimumStakeAtto: '100000000000000000',
  maximumStakePerWalletAtto: '10000000000000000000',
});

function valid(overrides = {}) {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V7',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: OWNER,
    pending_owner: '0x0000000000000000000000000000000000000000',
    keeper: KEEPER,
    treasury: TREASURY,
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    current_platform_fee_bps: 200,
    default_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: 3_600,
    keeper_max_schedule_ahead_seconds: 93_600,
    owner_max_schedule_ahead_seconds: 2_678_400,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    validator_return_tolerance_ppb: 100_000,
    price_scale: 100_000_000,
    return_scale: 1_000_000_000,
    four_venue_median_policy: 'FLOOR_AVERAGE_OF_MIDDLE_TWO',
    rounding_policy: 'LAST_WINNING_CLAIMANT_RECEIVES_REMAINDER',
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
    ...overrides,
  };
}

test('strict V7 validation accepts the exact deployment role, stake, and schedule profile', () => {
  assert.deepEqual(validateLiquidityArenaV7Config(valid(), EXPECTED), {
    protocolVersion: 'LIQUIDITY_ARENA_V7',
    policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    platformFeeBps: 200,
    owner: OWNER,
    keeper: KEEPER,
    treasury: TREASURY,
    minimumStakeAtto: '100000000000000000',
    maximumStakePerWalletAtto: '10000000000000000000',
  });
});

test('strict V7 validation compares role addresses without changing canonical chain casing', () => {
  const mixedOwner = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
  const result = validateLiquidityArenaV7Config(valid({ owner: mixedOwner }), {
    ...EXPECTED,
    owner: mixedOwner.toLowerCase(),
  });
  assert.equal(result.owner, mixedOwner);
});

test('strict V7 validation rejects role, stake, timing, and settlement drift', () => {
  for (const [overrides, pattern] of [
    [{ owner: '0x6666666666666666666666666666666666666666' }, /owner/],
    [{ keeper: '0x6666666666666666666666666666666666666666' }, /keeper/],
    [{ treasury: '0x6666666666666666666666666666666666666666' }, /treasury/],
    [{ epoch_min_stake_atto: '1' }, /fixed deployment stake/],
    [{ minimum_epoch_creation_lead_seconds: 1 }, /minimum_epoch_creation/],
    [{ keeper_max_schedule_ahead_seconds: 1 }, /keeper_max_schedule/],
    [{ wager_open_offset_seconds: 1 }, /wager_open_offset/],
    [{ current_platform_fee_bps: 500 }, /current_platform_fee/],
    [{ supported_objectives: ['HIGH', 'LOW', 'OTHER'] }, /exactly HIGH, LOW/],
  ]) {
    assert.throws(() => validateLiquidityArenaV7Config(valid(overrides), EXPECTED), pattern);
  }
});
