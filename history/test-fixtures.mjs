import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  V8_FACTORY,
  V8_KEEPER,
  V8_OWNER,
  V8_SCHEMA,
  V8_TREASURY,
  v8Config,
} from '../server/v8-test-fixtures.test-helper.mjs';

export const TEST_EPOCH = 1_787_162_400;
export const TEST_OWNER = V8_OWNER;
export const TEST_KEEPER = V8_KEEPER;
export const TEST_TREASURY = V8_TREASURY;
export const TEST_FACTORY = V8_FACTORY;
export const TEST_V8 = '0xa2ae59ae641f571726ae81e30080f8c2192b15ef';
export const TEST_PAYOUT_ID = 'a'.repeat(64);

const ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const LABELS = ['Bitcoin', 'Ethereum', 'BNB', 'Solana', 'XRP'];
const RETURNS = [10, 20, 30, 40, -10];

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function digest(value) {
  return bytesToHex(keccak_256(utf8ToBytes(JSON.stringify(sorted(value)))));
}

export function testDeployment() {
  const address = TEST_V8;
  const addressKey = address.toLowerCase();
  return Object.freeze({
    alias: 'v8',
    address,
    addressKey,
    deploymentId: `testnet-bradbury:${addressKey}`,
    protocolVersion: 'LIQUIDITY_ARENA_V8',
    policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    payoutProtocolVersion: 'IDEMPOTENT_EVM_VAULT_V1',
    expectations: Object.freeze({
      owner: TEST_OWNER,
      keeper: TEST_KEEPER,
      treasury: TEST_TREASURY,
      payoutFactory: TEST_FACTORY,
      minimumStakeAtto: '100000000000000000',
      maximumStakePerWalletAtto: '10000000000000000000',
      minimumAvailableReserveAtto: '3000000000000000000',
    }),
    active: true,
  });
}

export function testConfig(overrides = {}) {
  return v8Config(overrides);
}

export function testSchema() {
  return V8_SCHEMA;
}

function objective(name, winnerAsset, winnerReturn) {
  return {
    epoch_id: String(TEST_EPOCH),
    objective: name,
    settlement_mode: 'PARIMUTUEL',
    winner_asset_id: winnerAsset,
    winner_return_ppb: winnerReturn,
    payout_pool_atto: '198',
    winning_stake_atto: '100',
    losing_stake_atto: '100',
    platform_fee_atto: '2',
    total_stake_atto: '200',
    participant_count: 2,
    paid_atto: '0',
    funded_in_escrow_atto: '0',
    allocated_atto: '0',
    remaining_payout_atto: '198',
    unallocated_payout_atto: '198',
    allocated_not_funded_atto: '0',
    funded_not_withdrawn_atto: '0',
    unclaimed_winning_stake_atto: '100',
  };
}

export function testAssets() {
  return ASSETS.map((asset_id, index) => ({
    asset_id,
    label: LABELS[index],
    return_ppb: RETURNS[index],
    venue_returns_ppb: [RETURNS[index], RETURNS[index], RETURNS[index]],
    high_stake_atto: '100',
    low_stake_atto: '100',
  }));
}

export function testDeterminedEpoch() {
  const canonicalResult = {
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    status: 'DETERMINED',
    epoch_end_timestamp: TEST_EPOCH,
    qualified_venues: ['BINANCE', 'OKX', 'BYBIT'],
    venue_count: 3,
    assets: ASSETS.map((asset_id, index) => ({
      asset_id,
      return_ppb: RETURNS[index],
      venue_returns_ppb: [RETURNS[index], RETURNS[index], RETURNS[index]],
    })),
    high_winner_asset_id: 'SOL',
    high_winner_return_ppb: 40,
    low_winner_asset_id: 'XRP',
    low_winner_return_ppb: -10,
  };
  return {
    epoch_id: String(TEST_EPOCH),
    epoch_end_timestamp: TEST_EPOCH,
    wager_opens_timestamp: TEST_EPOCH - 2400,
    wager_closes_timestamp: TEST_EPOCH - 1200,
    battle_starts_timestamp: TEST_EPOCH - 1200,
    resolution_available_timestamp: TEST_EPOCH + 120,
    timeout_refund_available_timestamp: TEST_EPOCH + 86400,
    created_at_timestamp: TEST_EPOCH - 7200,
    creator: TEST_OWNER,
    status: 'RESOLVED',
    result_status: 'DETERMINED',
    phase: 'FINAL',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    platform_fee_bps_snapshot: 200,
    min_stake_atto: '100000000000000000',
    max_stake_per_wallet_atto: '10000000000000000000',
    qualified_venues: ['BINANCE', 'OKX', 'BYBIT'],
    venue_count: 3,
    high_winner_asset_id: 'SOL',
    high_winner_return_ppb: 40,
    low_winner_asset_id: 'XRP',
    low_winner_return_ppb: -10,
    resolved_at_timestamp: TEST_EPOCH + 180,
    resolution_digest: digest(canonicalResult),
    platform_fee_accrued_atto: '4',
    high: objective('HIGH', 'SOL', 40),
    low: objective('LOW', 'XRP', -10),
  };
}

export function testPayout(overrides = {}) {
  return {
    payout_id: TEST_PAYOUT_ID,
    kind: 'PLAYER',
    recipient: TEST_OWNER,
    amount_atto: '198',
    epoch_end_timestamp: TEST_EPOCH,
    objective: 'HIGH',
    wallet_key: `${TEST_EPOCH}|HIGH|${TEST_OWNER.toLowerCase()}`,
    stake_atto: '100',
    settlement_mode: 'PARIMUTUEL',
    includes_rounding_remainder: false,
    state: 'PREPARING',
    prepare_attempt_count: 1,
    attempt_count: 0,
    reserve_remaining_atto: '594',
    vault: '0x0000000000000000000000000000000000000000',
    created_at_timestamp: TEST_EPOCH + 200,
    last_prepare_timestamp: TEST_EPOCH + 200,
    last_dispatch_timestamp: 0,
    funded_at_timestamp: 0,
    withdrawn_at_timestamp: 0,
    escrow_withdrawn: false,
    ...overrides,
  };
}
