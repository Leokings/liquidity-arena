import assert from 'node:assert/strict';
import test from 'node:test';

import {
  V8_ASSETS,
  V8_PAYOUT_FACTORY,
  V8_VENUES,
  normalizeArenaConfig,
  normalizeV8Epoch,
  normalizeV8Payout,
  normalizeVerifiedClaimQuote,
  v8ClaimGate,
  v8TimeoutGate,
  v8WagerGate,
} from './v8-state.js';

const E = 1_787_155_200;
const ACCOUNT = `0x${'1'.repeat(40)}`;

function objective(name) {
  return {
    epoch_id: String(E), objective: name, settlement_mode: 'PENDING',
    winner_asset_id: '', winner_return_ppb: 0, payout_pool_atto: 0,
    winning_stake_atto: 0, losing_stake_atto: 0, platform_fee_atto: 0,
    total_stake_atto: 0, participant_count: 0, paid_atto: 0,
    funded_in_escrow_atto: 0, allocated_atto: 0, remaining_payout_atto: 0,
    unallocated_payout_atto: 0, allocated_not_funded_atto: 0,
    funded_not_withdrawn_atto: 0, unclaimed_winning_stake_atto: 0,
  };
}

function epoch(overrides = {}) {
  return {
    epoch_id: String(E), epoch_end_timestamp: E,
    wager_opens_timestamp: E - 2400, wager_closes_timestamp: E - 1200,
    battle_starts_timestamp: E - 1200, resolution_available_timestamp: E + 120,
    timeout_refund_available_timestamp: E + 86400, status: 'OPEN', result_status: 'PENDING',
    phase: 'WAGER_OPEN', policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    platform_fee_bps_snapshot: 200, min_stake_atto: 100, max_stake_per_wallet_atto: 1000,
    qualified_venues: [], venue_count: 0, high_winner_asset_id: '', high_winner_return_ppb: 0,
    low_winner_asset_id: '', low_winner_return_ppb: 0, resolved_at_timestamp: 0,
    resolution_digest: '', platform_fee_accrued_atto: 0,
    high: objective('HIGH'), low: objective('LOW'), ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    epoch_end_timestamp: E, objective: 'HIGH', account: ACCOUNT,
    choice_asset_id: 'BTC', stake_atto: 100, settlement_mode: 'REFUND_TIMEOUT',
    eligible: true, claimed: false, claimed_atto: 0, escrow_funded_atto: 0,
    amount_atto: 100, includes_rounding_remainder: false, payout_id: '', payout_state: '',
    ...overrides,
  };
}

test('V8 config pins protocol, Bradbury factory, fee, assets, venues, and payout semantics', () => {
  const config = normalizeArenaConfig({
    protocol_version: 'LIQUIDITY_ARENA_V8', policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: ACCOUNT, keeper: `0x${'2'.repeat(40)}`, treasury: `0x${'3'.repeat(40)}`,
    payout_vault_factory: V8_PAYOUT_FACTORY, payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
    payouts_enabled: true, new_risk_enabled: false, max_payout_attempts: 3,
    prepare_retries_capped: false, payout_retry_delay_seconds: 3600,
    current_platform_fee_bps: 200, epoch_min_stake_atto: 100,
    epoch_max_stake_per_wallet_atto: 1000, minimum_epoch_creation_lead_seconds: 3600,
    keeper_max_schedule_ahead_seconds: 93600, wager_open_offset_seconds: 2400,
    battle_open_offset_seconds: 1200, resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86400, minimum_qualified_venues: 3,
    validator_return_tolerance_ppb: 100000, asset_ids: V8_ASSETS, venues: V8_VENUES,
    supported_objectives: ['HIGH', 'LOW'], payout_finality: 'FUNDED_IN_ESCROW',
    claimed_semantics: 'EOA_WITHDRAWN',
  });
  assert.equal(config.currentPlatformFeeBps, 200);
  assert.equal(config.payoutVaultFactory, V8_PAYOUT_FACTORY);
  assert.equal(config.payoutsEnabled, true);
  assert.equal(config.newRiskEnabled, false);
  assert.equal(config.validatorReturnTolerancePpb, 100000);
});

test('epoch and claim gates enforce V8 schedule and payout-aware claimed semantics', () => {
  const normalizedEpoch = normalizeV8Epoch(epoch());
  const normalizedQuote = normalizeVerifiedClaimQuote(quote(), {
    epochEndTimestamp: E, objective: 'HIGH', account: ACCOUNT,
  });
  assert.equal(v8WagerGate({
    epoch: normalizedEpoch, entry: normalizedQuote, objective: 'HIGH', assetId: 'BTC',
    amountAtto: 100n, nowSeconds: E - 2000,
  }).allowed, true);
  assert.equal(v8ClaimGate(normalizedQuote).allowed, true);
  assert.equal(v8TimeoutGate(normalizedEpoch, E + 86400).allowed, true);
  const withPayout = normalizeVerifiedClaimQuote(quote({
    eligible: false, payout_id: 'a'.repeat(64), payout_state: 'PREPARING',
  }), { epochEndTimestamp: E, objective: 'HIGH', account: ACCOUNT });
  assert.equal(v8ClaimGate(withPayout).allowed, false);
  assert.match(v8ClaimGate(withPayout).reason, /existing payout/);
});

test('player payout normalization enforces lowercase ID, exact recipient, vault, and withdrawal stage', () => {
  const base = {
    payout_id: 'a'.repeat(64), kind: 'PLAYER', recipient: ACCOUNT, amount_atto: 100,
    epoch_end_timestamp: E, objective: 'HIGH', settlement_mode: 'REFUND_TIMEOUT',
    state: 'FUNDED_IN_ESCROW', prepare_attempt_count: 1, attempt_count: 1,
    reserve_remaining_atto: 0, vault: `0x${'4'.repeat(40)}`, created_at_timestamp: E,
    last_prepare_timestamp: E, last_dispatch_timestamp: E, funded_at_timestamp: E,
    withdrawn_at_timestamp: 0, escrow_withdrawn: false,
  };
  assert.equal(normalizeV8Payout(base, { payoutId: 'a'.repeat(64), recipient: ACCOUNT }).state, 'FUNDED_IN_ESCROW');
  assert.throws(() => normalizeV8Payout({ ...base, kind: 'FEE' }), /player payouts/);
  assert.throws(
    () => normalizeV8Payout({ ...base, state: 'EOA_WITHDRAWN', escrow_withdrawn: false }),
    /inconsistent/,
  );
  assert.throws(
    () => normalizeV8Payout({
      ...base,
      state: 'PREPARING',
      attempt_count: 0,
      last_dispatch_timestamp: 0,
      funded_at_timestamp: 0,
    }),
    /cannot already expose an EVM vault/,
  );
  assert.throws(
    () => normalizeV8Payout({
      ...base,
      state: 'PREPARING',
      vault: `0x${'0'.repeat(40)}`,
      attempt_count: 1,
      last_dispatch_timestamp: 0,
      funded_at_timestamp: 0,
    }),
    /timestamps are inconsistent/,
  );
  assert.throws(
    () => normalizeV8Payout({
      ...base,
      state: 'DISPATCHED',
      attempt_count: 0,
      funded_at_timestamp: 0,
    }),
    /timestamps are inconsistent/,
  );
  assert.throws(
    () => normalizeV8Payout({ ...base, attempt_count: 0 }),
    /timestamps are inconsistent/,
  );
  assert.throws(
    () => normalizeV8Payout({ ...base, funded_at_timestamp: E - 1 }),
    /timestamps are inconsistent/,
  );
});
