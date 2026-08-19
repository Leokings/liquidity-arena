import assert from 'node:assert/strict';
import test from 'node:test';

import { createReadyHandler, readinessEpochEnds } from './readyz.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const LEGACY = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x4444444444444444444444444444444444444444';
const TREASURY = '0x5555555555555555555555555555555555555555';
const NOW = Date.UTC(2027, 0, 15, 10, 25, 0);
const [OPERATIONAL_EPOCH, UPCOMING_EPOCH] = readinessEpochEnds(NOW);

function config() {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V6',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    native_token_symbol: 'GEN', native_token_decimals: 18,
    current_platform_fee_bps: 200, default_platform_fee_bps: 200, max_platform_fee_bps: 500,
    wager_open_offset_seconds: 2_400, battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120, timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3, supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
  };
}

function epoch(epochEndTimestamp, overrides = {}) {
  return {
    epoch_end_timestamp: epochEndTimestamp,
    wager_opens_timestamp: epochEndTimestamp - 2_400,
    wager_closes_timestamp: epochEndTimestamp - 1_200,
    battle_starts_timestamp: epochEndTimestamp - 1_200,
    resolution_available_timestamp: epochEndTimestamp + 120,
    timeout_refund_available_timestamp: epochEndTimestamp + 86_400,
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    status: 'OPEN',
    ...overrides,
  };
}

function v7Config(overrides = {}) {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V7',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: OWNER, keeper: KEEPER, treasury: TREASURY,
    native_token_symbol: 'GEN', native_token_decimals: 18,
    current_platform_fee_bps: 200, default_platform_fee_bps: 200, max_platform_fee_bps: 500,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: 3_600,
    keeper_max_schedule_ahead_seconds: 93_600,
    owner_max_schedule_ahead_seconds: 2_678_400,
    wager_open_offset_seconds: 2_400, battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120, timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    validator_return_tolerance_ppb: 100_000,
    price_scale: 100_000_000, return_scale: 1_000_000_000,
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

function v7Epoch(epochEndTimestamp, overrides = {}) {
  return epoch(epochEndTimestamp, {
    min_stake_atto: '100000000000000000',
    max_stake_per_wallet_atto: '10000000000000000000',
    platform_fee_bps_snapshot: 200,
    ...overrides,
  });
}

function v7Environment(overrides = {}) {
  return {
    VITE_GENLAYER_NETWORK: 'studionet',
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7',
    VITE_GENLAYER_CONTRACT: CONTRACT,
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_V6_CONTRACT: LEGACY,
    VITE_GENLAYER_V7_CONTRACT: CONTRACT,
    GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    GENLAYER_V7_OWNER: OWNER,
    GENLAYER_V7_KEEPER: KEEPER,
    GENLAYER_V7_TREASURY: TREASURY,
    GENLAYER_V7_MIN_STAKE_ATTO: '100000000000000000',
    GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO: '10000000000000000000',
    ...overrides,
  };
}

async function readyFetch(url) {
  if (String(url).includes('studio.genlayer.com')) {
    return new Response(JSON.stringify({ result: '0xf22f' }), { status: 200 });
  }
  return new Response(JSON.stringify([
    { symbol: 'BTCUSDT', price: '1' }, { symbol: 'ETHUSDT', price: '1' },
    { symbol: 'BNBUSDT', price: '1' }, { symbol: 'SOLUSDT', price: '1' },
    { symbol: 'XRPUSDT', price: '1' },
  ]), { status: 200 });
}

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(value = '') { this.body = value; this.ended = true; },
  };
}

test('readiness coverage advances to the next two exact hours at an hour boundary', () => {
  const boundary = Date.UTC(2027, 0, 15, 10, 0, 0);
  assert.deepEqual(readinessEpochEnds(boundary), [
    Date.UTC(2027, 0, 15, 11, 0, 0) / 1_000,
    Date.UTC(2027, 0, 15, 12, 0, 0) / 1_000,
  ]);
});

test('Vercel readiness verifies StudioNet, V6 config, and the five-asset display feed', async () => {
  const calls = [];
  const handler = createReadyHandler({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      VITE_GENLAYER_CONTRACT: CONTRACT,
      GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    },
    createClientImpl() {
      return {
        async readContract(call) {
          calls.push(call);
          if (call.functionName === 'get_config') return config();
          return epoch(Number(call.args[0]));
        },
      };
    },
    now: () => NOW,
    async fetchImpl(url) {
      if (String(url).includes('studio.genlayer.com')) {
        return new Response(JSON.stringify({ result: '0xf22f' }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { symbol: 'BTCUSDT', price: '1' }, { symbol: 'ETHUSDT', price: '1' },
        { symbol: 'BNBUSDT', price: '1' }, { symbol: 'SOLUSDT', price: '1' },
        { symbol: 'XRPUSDT', price: '1' },
      ]), { status: 200 });
    },
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V6');
  assert.equal(body.checks.keeperCoverage.ready, true);
  assert.deepEqual(body.checks.keeperCoverage.epochEnds, [OPERATIONAL_EPOCH, UPCOMING_EPOCH]);
  assert.deepEqual(new Set(calls.map(({ functionName }) => functionName)), new Set([
    'get_config', 'get_epoch',
  ]));
});

test('V7 readiness binds exact roles and fixed epochs while exposing legacy V6 liability', async () => {
  const calls = [];
  const handler = createReadyHandler({
    environment: v7Environment(),
    createClientImpl() {
      return {
        async readContract(call) {
          calls.push(call);
          if (call.address.toLowerCase() === LEGACY && call.functionName === 'get_config') return config();
          if (call.address.toLowerCase() === LEGACY
            && call.functionName === 'get_total_player_liability_atto') return 123n;
          if (call.functionName === 'get_config') return v7Config();
          if (call.functionName === 'get_epoch') return v7Epoch(Number(call.args[0]));
          throw new Error('unexpected read');
        },
      };
    },
    now: () => NOW,
    fetchImpl: readyFetch,
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V7');
  assert.equal(body.checks.contract.owner, OWNER);
  assert.equal(body.checks.keeperCoverage.ready, true);
  assert.deepEqual(body.checks.legacyV6, {
    blocking: false,
    configured: true,
    readable: true,
    contracts: [{
      address: LEGACY,
      readable: true,
      protocolVersion: 'LIQUIDITY_ARENA_V6',
      playerLiabilityAtto: '123',
    }],
    knownPlayerLiabilityAtto: '123',
    totalPlayerLiabilityAtto: '123',
    hasOutstandingLiability: true,
  });
  assert.ok(calls.some(({ address, functionName }) => address === LEGACY
    && functionName === 'get_total_player_liability_atto'));
});

test('an unreadable allowlisted V6 contract is visible but does not block healthy V7 readiness', async () => {
  const handler = createReadyHandler({
    environment: v7Environment(),
    createClientImpl() {
      return {
        async readContract(call) {
          if (call.address.toLowerCase() === LEGACY) throw new Error('legacy unavailable');
          if (call.functionName === 'get_config') return v7Config();
          return v7Epoch(Number(call.args[0]));
        },
      };
    },
    now: () => NOW,
    fetchImpl: readyFetch,
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.legacyV6.blocking, false);
  assert.equal(body.checks.legacyV6.readable, false);
  assert.deepEqual(body.checks.legacyV6.contracts, [{ address: LEGACY, readable: false }]);
  assert.equal(body.checks.legacyV6.knownPlayerLiabilityAtto, '0');
  assert.equal(body.checks.legacyV6.totalPlayerLiabilityAtto, null);
  assert.equal(body.checks.legacyV6.hasOutstandingLiability, null);
});

test('V7 readiness fails closed when a role or fixed epoch stake drifts', async () => {
  for (const drift of ['owner', 'epoch']) {
    const handler = createReadyHandler({
      environment: v7Environment(),
      createClientImpl() {
        return {
          async readContract(call) {
            if (call.functionName === 'get_config') {
              return drift === 'owner'
                ? v7Config({ owner: '0x6666666666666666666666666666666666666666' })
                : v7Config();
            }
            return v7Epoch(Number(call.args[0]), drift === 'epoch' ? { min_stake_atto: '1' } : {});
          },
        };
      },
      now: () => NOW,
      fetchImpl: readyFetch,
    });
    const res = response();
    await handler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    if (drift === 'owner') assert.equal(body.checks.contract.ready, false);
    else assert.equal(body.checks.keeperCoverage.ready, false);
  }
});

test('Vercel readiness fails closed on a drifting contract policy', async () => {
  const handler = createReadyHandler({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      VITE_GENLAYER_CONTRACT: CONTRACT,
    },
    createClientImpl() {
      return {
        async readContract(call) {
          if (call.functionName === 'get_config') {
            return { ...config(), policy_version: 'WRONG' };
          }
          return epoch(Number(call.args[0]));
        },
      };
    },
    now: () => NOW,
    async fetchImpl(url) {
      if (String(url).includes('studio.genlayer.com')) {
        return new Response(JSON.stringify({ result: '0xf22f' }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { symbol: 'BTCUSDT', price: '1' }, { symbol: 'ETHUSDT', price: '1' },
        { symbol: 'BNBUSDT', price: '1' }, { symbol: 'SOLUSDT', price: '1' },
        { symbol: 'XRPUSDT', price: '1' },
      ]), { status: 200 });
    },
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).checks.contract.ready, false);
});

test('Vercel readiness fails when the keeper has not created exact current coverage', async () => {
  const handler = createReadyHandler({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      VITE_GENLAYER_CONTRACT: CONTRACT,
    },
    createClientImpl() {
      return {
        async readContract(call) {
          if (call.functionName === 'get_config') return config();
          const epochEndTimestamp = Number(call.args[0]);
          if (epochEndTimestamp === UPCOMING_EPOCH) throw new Error('epoch absent');
          return epoch(epochEndTimestamp);
        },
      };
    },
    now: () => NOW,
    async fetchImpl(url) {
      if (String(url).includes('studio.genlayer.com')) {
        return new Response(JSON.stringify({ result: '0xf22f' }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { symbol: 'BTCUSDT', price: '1' }, { symbol: 'ETHUSDT', price: '1' },
        { symbol: 'BNBUSDT', price: '1' }, { symbol: 'SOLUSDT', price: '1' },
        { symbol: 'XRPUSDT', price: '1' },
      ]), { status: 200 });
    },
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.checks.keeperCoverage.ready, false);
  assert.deepEqual(body.checks.keeperCoverage.epochEnds, [OPERATIONAL_EPOCH, UPCOMING_EPOCH]);
});

test('Vercel readiness times out a hung contract read instead of hanging the request', async () => {
  const handler = createReadyHandler({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      VITE_GENLAYER_CONTRACT: CONTRACT,
    },
    createClientImpl() {
      return { readContract: async () => new Promise(() => {}) };
    },
    now: () => NOW,
    timeoutMs: 10,
    async fetchImpl(url) {
      if (String(url).includes('studio.genlayer.com')) {
        return new Response(JSON.stringify({ result: '0xf22f' }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { symbol: 'BTCUSDT', price: '1' }, { symbol: 'ETHUSDT', price: '1' },
        { symbol: 'BNBUSDT', price: '1' }, { symbol: 'SOLUSDT', price: '1' },
        { symbol: 'XRPUSDT', price: '1' },
      ]), { status: 200 });
    },
  });
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.checks.contract.ready, false);
  assert.equal(body.checks.keeperCoverage.ready, false);
});
