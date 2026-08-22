import { EXPECTED_V8_SCHEMA } from './v8-contract-config.mjs';

export const V8_CONTRACT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const V8_OWNER = '0x797d3b25fb2cca0ff93f60df1910267f3822d655';
export const V8_KEEPER = V8_OWNER;
export const V8_TREASURY = '0x87e94edab4418e8a9ea37c0fab0675cf0602a9f2';
export const V8_FACTORY = '0x944fdadd826c2a159c63cb100db174716ccd1317';

export function v8Environment(overrides = {}) {
  return {
    VITE_GENLAYER_NETWORK: 'testnet-bradbury',
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V8',
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v8',
    VITE_GENLAYER_CONTRACT: V8_CONTRACT,
    VITE_GENLAYER_V8_CONTRACT: V8_CONTRACT,
    GENLAYER_RPC_URL: 'https://rpc-bradbury.genlayer.com',
    GENLAYER_V8_OWNER: V8_OWNER,
    GENLAYER_V8_KEEPER: V8_KEEPER,
    GENLAYER_V8_TREASURY: V8_TREASURY,
    GENLAYER_V8_PAYOUT_FACTORY: V8_FACTORY,
    GENLAYER_V8_MIN_STAKE_ATTO: '100000000000000000',
    GENLAYER_V8_MAX_STAKE_PER_WALLET_ATTO: '10000000000000000000',
    GENLAYER_V8_MIN_AVAILABLE_RESERVE_ATTO: '3000000000000000000',
    ...overrides,
  };
}

export function v8Config(overrides = {}) {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V8',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: V8_OWNER,
    keeper: V8_KEEPER,
    treasury: V8_TREASURY,
    payout_vault_factory: V8_FACTORY,
    payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
    payouts_enabled: true,
    new_risk_enabled: true,
    max_payout_attempts: 3,
    prepare_retries_capped: false,
    payout_retry_delay_seconds: 3_600,
    current_platform_fee_bps: 200,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: 3_600,
    keeper_max_schedule_ahead_seconds: 93_600,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    validator_return_tolerance_ppb: 100_000,
    asset_ids: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'],
    venues: ['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN'],
    supported_objectives: ['HIGH', 'LOW'],
    payout_finality: 'FUNDED_IN_ESCROW',
    claimed_semantics: 'EOA_WITHDRAWN',
    ...overrides,
  };
}

export function v8Reserve(overrides = {}) {
  return {
    treasury: V8_TREASURY,
    current_platform_fee_bps: 200,
    payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
    payouts_enabled: true,
    new_risk_enabled: true,
    player_liability_atto: '0',
    accrued_platform_fees_atto: '0',
    reserved_platform_fees_atto: '0',
    funded_platform_fees_atto: '0',
    withdrawn_platform_fees_atto: '0',
    available_reserve_atto: '3000000000000000000',
    committed_reserve_atto: '0',
    required_available_reserve_atto: '0',
    reserved_player_payouts_atto: '0',
    max_payout_attempts: 3,
    prepare_retries_capped: false,
    retry_delay_seconds: 3_600,
    ...overrides,
  };
}

export function v8Epoch(epochEndTimestamp, overrides = {}) {
  return {
    epoch_end_timestamp: epochEndTimestamp,
    wager_opens_timestamp: epochEndTimestamp - 2_400,
    wager_closes_timestamp: epochEndTimestamp - 1_200,
    battle_starts_timestamp: epochEndTimestamp - 1_200,
    resolution_available_timestamp: epochEndTimestamp + 120,
    timeout_refund_available_timestamp: epochEndTimestamp + 86_400,
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    status: 'OPEN',
    min_stake_atto: '100000000000000000',
    max_stake_per_wallet_atto: '10000000000000000000',
    platform_fee_bps_snapshot: 200,
    ...overrides,
  };
}

export const V8_SCHEMA = EXPECTED_V8_SCHEMA;

export const BINANCE_QUOTES = Object.freeze([
  { symbol: 'BTCUSDT', price: '1' },
  { symbol: 'ETHUSDT', price: '1' },
  { symbol: 'BNBUSDT', price: '1' },
  { symbol: 'SOLUSDT', price: '1' },
  { symbol: 'XRPUSDT', price: '1' },
]);
