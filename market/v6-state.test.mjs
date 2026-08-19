import assert from 'node:assert/strict';
import test from 'node:test';

import {
  V7_PROTOCOL,
  normalizeArenaConfig,
  normalizeV6Config,
  normalizeV6Entry,
  normalizeV6Epoch,
  v6ClaimGate,
  v6TimeoutGate,
  v6WagerGate,
} from './v6-state.js';

const E = 1_787_162_400;

function objective(name) {
  return {
    epoch_id: String(E), objective: name, settlement_mode: 'PENDING', winner_asset_id: '',
    winner_return_ppb: 0, payout_pool_atto: 0, winning_stake_atto: 0,
    losing_stake_atto: 0, platform_fee_atto: 0, total_stake_atto: 0,
    participant_count: 0, paid_atto: 0, remaining_payout_atto: 0,
    unclaimed_winning_stake_atto: 0,
  };
}

function rawEpoch(overrides = {}) {
  return {
    epoch_id: String(E), epoch_end_timestamp: E, wager_opens_timestamp: E - 2_400,
    wager_closes_timestamp: E - 1_200, battle_starts_timestamp: E - 1_200,
    resolution_available_timestamp: E + 120, timeout_refund_available_timestamp: E + 86_400,
    status: 'OPEN', result_status: 'PENDING', phase: 'WAGER_OPEN',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1', platform_fee_bps_snapshot: 200,
    min_stake_atto: 100, max_stake_per_wallet_atto: 1_000,
    qualified_venues: [], venue_count: 0, high_winner_asset_id: '', high_winner_return_ppb: 0,
    low_winner_asset_id: '', low_winner_return_ppb: 0, resolved_at_timestamp: 0,
    resolution_digest: '', platform_fee_accrued_atto: 0,
    high: objective('HIGH'), low: objective('LOW'), ...overrides,
  };
}

test('browser config and epoch normalization enforce the exact V6 schedule and policy', () => {
  const config = normalizeV6Config({
    protocol_version: 'LIQUIDITY_ARENA_V6', policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: `0x${'1'.repeat(40)}`, treasury: `0x${'2'.repeat(40)}`,
    native_token_symbol: 'GEN', native_token_decimals: 18, current_platform_fee_bps: 200,
    default_platform_fee_bps: 200, max_platform_fee_bps: 500,
    wager_open_offset_seconds: 2_400, battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120, timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3, supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ], transfer_finality: 'FINALIZED',
  });
  assert.equal(config.currentPlatformFeeBps, 200);
  const epoch = normalizeV6Epoch(rawEpoch());
  assert.equal(epoch.epochEndTimestamp, E);
  assert.equal(epoch.high.objective, 'HIGH');
  assert.throws(() => normalizeV6Epoch(rawEpoch({ wager_closes_timestamp: E - 1_199 })), /inconsistent/);
});

test('V7 config requires the dedicated non-zero keeper while V6 remains compatible', () => {
  const base = {
    protocol_version: V7_PROTOCOL,
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: `0x${'1'.repeat(40)}`,
    keeper: `0x${'3'.repeat(40)}`,
    treasury: `0x${'2'.repeat(40)}`,
    current_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
    native_token_decimals: 18,
    default_platform_fee_bps: 200,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    native_token_symbol: 'GEN',
    transfer_finality: 'FINALIZED',
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
  };
  const normalized = normalizeArenaConfig(base, { expectedProtocol: V7_PROTOCOL });
  assert.equal(normalized.protocolVersion, V7_PROTOCOL);
  assert.equal(normalized.keeper, base.keeper);
  assert.throws(
    () => normalizeArenaConfig({ ...base, keeper: '' }, { expectedProtocol: V7_PROTOCOL }),
    /keeper must be a non-zero/,
  );
  assert.throws(
    () => normalizeArenaConfig(base, { expectedProtocol: 'LIQUIDITY_ARENA_V8' }),
    /not allowlisted/,
  );
});

test('V6 wager, claim, and timeout gates enforce their exact boundaries', () => {
  const epoch = normalizeV6Epoch(rawEpoch());
  const entry = normalizeV6Entry({
    epoch_end_timestamp: E, objective: 'HIGH', account: '0xabc', choice_asset_id: 'BTC',
    stake_atto: 200, settlement_mode: 'PENDING', eligible: false, claimed: false,
    claimed_atto: 0, amount_atto: 0, includes_rounding_remainder: false,
  });
  assert.equal(v6WagerGate({ epoch, entry, objective: 'HIGH', assetId: 'BTC', amountAtto: 100, nowSeconds: E - 2_400 }).allowed, true);
  assert.equal(v6WagerGate({ epoch, entry, objective: 'HIGH', assetId: 'ETH', amountAtto: 100, nowSeconds: E - 2_400 }).allowed, false);
  assert.equal(v6WagerGate({ epoch, entry, objective: 'HIGH', assetId: 'BTC', amountAtto: 100, nowSeconds: E - 1_200 }).allowed, false);
  assert.equal(v6ClaimGate({ ...entry, eligible: true, amountAtto: 150n }).allowed, true);
  assert.equal(v6TimeoutGate(epoch, E + 86_399).allowed, false);
  assert.equal(v6TimeoutGate(epoch, E + 86_400).allowed, true);
});
