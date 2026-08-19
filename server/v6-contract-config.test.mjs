import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLiquidityArenaV6Config } from './v6-contract-config.mjs';

function valid(overrides = {}) {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V6',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    current_platform_fee_bps: 200,
    default_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
    ...overrides,
  };
}

test('strict V6 config validation accepts the reviewed contract profile', () => {
  assert.deepEqual(validateLiquidityArenaV6Config(valid()), {
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    platformFeeBps: 200,
  });
  assert.equal(Object.isFrozen(validateLiquidityArenaV6Config(valid())), true);
});

test('strict V6 config validation rejects timing, policy, fee, and mode drift', () => {
  for (const [overrides, pattern] of [
    [{ protocol_version: 'MARKET_DOMINANCE_ARENA_V5' }, /protocol/],
    [{ policy_version: 'OTHER' }, /policy/],
    [{ resolution_publication_delay_seconds: 1 }, /must equal 120/],
    [{ current_platform_fee_bps: 501 }, /between 0 and 500/],
    [{ supported_objectives: ['HIGH'] }, /exactly HIGH and LOW/],
    [{ supported_settlement_modes: ['PENDING'] }, /missing PARIMUTUEL/],
    [{ transfer_finality: 'ACCEPTED' }, /FINALIZED-only/],
  ]) {
    assert.throws(() => validateLiquidityArenaV6Config(valid(overrides)), pattern);
  }
});
