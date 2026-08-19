import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const TEST_EPOCH = 1_787_162_400;
export const TEST_OWNER = `0x${'1'.repeat(40)}`;
export const TEST_KEEPER = `0x${'2'.repeat(40)}`;
export const TEST_TREASURY = `0x${'3'.repeat(40)}`;
export const TEST_V7 = '0xb2Ae59aE641f571726Ae81E30080f8c2192b15EF';
export const TEST_V6 = '0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1';

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

export function testDeployment(alias = 'v7') {
  const address = alias === 'v7' ? TEST_V7 : TEST_V6;
  const addressKey = address.toLowerCase();
  return Object.freeze({
    alias,
    address,
    addressKey,
    deploymentId: `studionet:${addressKey}`,
    protocolVersion: alias === 'v7' ? 'LIQUIDITY_ARENA_V7' : 'LIQUIDITY_ARENA_V6',
    policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    active: true,
  });
}

export function testConfig(alias = 'v7') {
  return {
    protocol_version: alias === 'v7' ? 'LIQUIDITY_ARENA_V7' : 'LIQUIDITY_ARENA_V6',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: TEST_OWNER,
    ...(alias === 'v7' ? { keeper: TEST_KEEPER } : {}),
    treasury: TEST_TREASURY,
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    transfer_finality: 'FINALIZED',
  };
}

export function testAssetCatalog() {
  return { assets: ASSETS.map((asset_id, index) => ({ asset_id, label: LABELS[index], quote_asset: 'USDT' })) };
}

export function testVenueCatalog() {
  return {
    venues: ['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN'],
    adapters_immutable: true,
    candle_interval: '1m',
    start_price_rule: 'OPEN_AT_E_MINUS_20_MINUTES',
    end_price_rule: 'CLOSE_AT_E_MINUS_1_MINUTE',
  };
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
    remaining_payout_atto: '198',
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
    min_stake_atto: '100',
    max_stake_per_wallet_atto: '10000',
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
