import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  contentSecurityPolicy,
  createClientIpResolver,
  createProductionApp,
  loadServerConfig,
  startProductionServer,
} from './app.mjs';

const CONTRACT_ADDRESS = '0xd0a7430b25379B7483B61eEa881Fe1bede103852';
const LEGACY_CONTRACT_ADDRESS = '0x2222222222222222222222222222222222222222';
const V7_OWNER = '0x3333333333333333333333333333333333333333';
const V7_KEEPER = '0x4444444444444444444444444444444444444444';
const V7_TREASURY = '0x5555555555555555555555555555555555555555';
const BINANCE_QUOTES = [
  { symbol: 'BTCUSDT', price: '65000' },
  { symbol: 'ETHUSDT', price: '3500' },
  { symbol: 'BNBUSDT', price: '600' },
  { symbol: 'SOLUSDT', price: '150' },
  { symbol: 'XRPUSDT', price: '0.50' },
];
const KLINES = [
  [1_700_000_000_000, '100', '101', '99', '100.5'],
  [1_700_000_300_000, '100.5', '102', '100', '101'],
];

function validContractConfig(protocolVersion = 'LIQUIDITY_ARENA_V6') {
  return {
    protocol_version: protocolVersion,
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
      'PENDING',
      'PARIMUTUEL',
      'REFUND_TIE',
      'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE',
      'REFUND_UNDETERMINED',
      'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
  };
}

function validEpoch(epochEndTimestamp, overrides = {}) {
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

async function validV6ContractReader({ functionName, args }) {
  if (functionName === 'get_config') return validContractConfig();
  if (functionName === 'get_epoch') return validEpoch(Number(args[0]));
  if (functionName === 'get_total_player_liability_atto') return 0n;
  throw new Error(`Unexpected contract read ${functionName}`);
}

function validV7ContractConfig() {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V7',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: V7_OWNER, keeper: V7_KEEPER, treasury: V7_TREASURY,
    native_token_symbol: 'GEN', native_token_decimals: 18,
    current_platform_fee_bps: 200, default_platform_fee_bps: 200, max_platform_fee_bps: 500,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: 3_600,
    keeper_max_schedule_ahead_seconds: 93_600,
    owner_max_schedule_ahead_seconds: 2_678_400,
    wager_open_offset_seconds: 2_400, battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120, timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3, validator_return_tolerance_ppb: 100_000,
    price_scale: 100_000_000, return_scale: 1_000_000_000,
    four_venue_median_policy: 'FLOOR_AVERAGE_OF_MIDDLE_TWO',
    rounding_policy: 'LAST_WINNING_CLAIMANT_RECEIVES_REMAINDER',
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
  };
}

function validV7Epoch(epochEndTimestamp) {
  return validEpoch(epochEndTimestamp, {
    min_stake_atto: '100000000000000000',
    max_stake_per_wallet_atto: '10000000000000000000',
    platform_fee_bps_snapshot: 200,
  });
}

class FakeStreamHub {
  constructor() {
    this.configured = true;
    this.running = false;
    this.clientCount = 0;
    this.destroyCalls = 0;
  }

  start() { this.running = true; }

  subscribe(listener) {
    this.clientCount += 1;
    listener({ type: 'binance_stream', sequence: 1, assets: [] });
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.clientCount -= 1;
    };
  }

  destroy() { this.destroyCalls += 1; this.running = false; }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'liquidity-arena-server-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Liquidity Arena</title>', 'utf8');
  await writeFile(join(root, 'market.html'), '<!doctype html><title>Liquidity Arena</title>', 'utf8');
  return root;
}

function testConfig(distDir, environment = {}) {
  return loadServerConfig({
    HOST: '127.0.0.1',
    PORT: '4400',
    DIST_DIR: distDir,
    VITE_GENLAYER_NETWORK: 'studionet',
    GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    VITE_GENLAYER_CONTRACT: CONTRACT_ADDRESS,
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
    SHUTDOWN_GRACE_MS: '100',
    ...environment,
  });
}

async function startFixture({
  fetchImpl,
  contractReader = validV6ContractReader,
  environment,
} = {}) {
  const distDir = await createFixture();
  const streamHub = new FakeStreamHub();
  const upstreamRequests = [];
  const config = testConfig(distDir, environment);
  const runtime = await startProductionServer({
    config,
    host: '127.0.0.1',
    port: 0,
    streamHub,
    logger: { error() {} },
    contractReader,
    fetchImpl: fetchImpl || (async (url, options = {}) => {
      upstreamRequests.push({ url: String(url), options });
      if (String(url).startsWith(config.genLayerRpcUrl)) {
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: config.genLayerChainId }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/ticker/price')) {
        return new Response(JSON.stringify(BINANCE_QUOTES), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(KLINES), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const address = runtime.server.address();
  return { distDir, origin: `http://127.0.0.1:${address.port}`, runtime, streamHub, upstreamRequests };
}

async function stopFixture(fixture) {
  await fixture.runtime.close({ graceMs: 100 });
  await rm(fixture.distDir, { recursive: true, force: true });
}

test('production configuration has no market-data secret and still fails closed for unsafe chain settings', () => {
  assert.throws(() => loadServerConfig({}), /VITE_GENLAYER_NETWORK must be "studionet"/);
  assert.throws(
    () => loadServerConfig({
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      GENLAYER_RPC_URL: 'http://rpc.example',
      VITE_GENLAYER_CONTRACT: CONTRACT_ADDRESS,
    }),
    /absolute HTTPS URL/,
  );
  assert.throws(
    () => loadServerConfig({
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      GENLAYER_RPC_URL: 'https://rpc.example',
      VITE_GENLAYER_CONTRACT: '0x0000000000000000000000000000000000000000',
    }),
    /non-zero 20-byte hex address/,
  );
  assert.throws(
    () => loadServerConfig({
      VITE_GENLAYER_NETWORK: 'localnet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      VITE_GENLAYER_CONTRACT: CONTRACT_ADDRESS,
    }),
    /VITE_GENLAYER_NETWORK must be "studionet"/,
  );
  assert.throws(
    () => loadServerConfig({
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'MARKET_DOMINANCE_ARENA_V5',
      VITE_GENLAYER_CONTRACT: CONTRACT_ADDRESS,
    }),
    /VITE_GENLAYER_PROTOCOL must be/,
  );
  assert.throws(
    () => loadServerConfig({
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      GENLAYER_RPC_URL: 'https://rpc.example',
      VITE_GENLAYER_CONTRACT: CONTRACT_ADDRESS,
      SSE_MAX_CLIENTS_PER_IP: '0',
    }),
    /SSE_MAX_CLIENTS_PER_IP must be an integer between 1 and 100/,
  );
  assert.throws(
    () => createProductionApp({ config: { distDir: '.', genLayerRpcUrl: 'https://rpc.example' } }),
    /VITE_GENLAYER_NETWORK/,
  );
  const config = loadServerConfig({
    VITE_GENLAYER_NETWORK: 'studionet',
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
    VITE_GENLAYER_CONTRACT: CONTRACT_ADDRESS,
  });
  assert.equal(config.genLayerNetwork, 'studionet');
  assert.equal(config.genLayerChainId, '0xf22f');
  assert.equal(config.genLayerRpcUrl, 'https://studio.genlayer.com/api');
  assert.equal(config.expectedContractProtocol, 'LIQUIDITY_ARENA_V6');
  assert.equal(Object.keys(config).some((key) => /api.?key/i.test(key)), false);
});

test('production server serves the build and reports Binance plus GenLayer readiness', async () => {
  const fixture = await startFixture();
  try {
    const market = await fetch(`${fixture.origin}/market.html`);
    assert.equal(market.status, 200);
    assert.equal(
      market.headers.get('content-security-policy'),
      contentSecurityPolicy('https://studio.genlayer.com/api'),
    );
    assert.match(market.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(market.headers.get('x-frame-options'), 'DENY');
    assert.match(await market.text(), /Liquidity Arena/);

    const health = await fetch(`${fixture.origin}/healthz`);
    assert.deepEqual(await health.json(), {
      status: 'ok', service: 'liquidity-arena', check: 'liveness', static: { ready: true },
      binance: { configured: true, streamRunning: false, clients: 0 },
      genlayerRpc: { configured: true }, contract: { configured: true },
    });

    const readiness = await fetch(`${fixture.origin}/readyz`);
    assert.equal(readiness.status, 200);
    const payload = await readiness.json();
    assert.equal(payload.status, 'ready');
    assert.deepEqual(payload.checks.binance, { ready: true, feeds: 5 });
    assert.deepEqual(payload.checks.genlayerRpc, {
      ready: true, chainId: '0xf22f', network: 'studionet',
    });
    assert.equal(payload.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V6');
    assert.equal(payload.checks.contract.policyVersion, 'CRYPTO_SPOT_1M_MEDIAN_V1');
    assert.equal(payload.checks.contract.platformFeeBps, 200);
  } finally {
    await stopFixture(fixture);
  }
});

test('StudioNet selects its built-in chain, dynamic RPC policy, and exact V6 readiness gate', async () => {
  const fixture = await startFixture({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    },
    contractReader: validV6ContractReader,
  });
  try {
    const market = await fetch(`${fixture.origin}/market.html`);
    const policy = market.headers.get('content-security-policy');
    assert.equal(policy, contentSecurityPolicy('https://studio.genlayer.com/api'));
    assert.match(policy, /connect-src 'self' https:\/\/studio\.genlayer\.com/);
    assert.doesNotMatch(policy, /rpc-bradbury/);

    const readiness = await fetch(`${fixture.origin}/readyz`);
    assert.equal(readiness.status, 200);
    const payload = await readiness.json();
    assert.deepEqual(payload.checks.genlayerRpc, {
      ready: true, chainId: '0xf22f', network: 'studionet',
    });
    assert.equal(payload.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V6');

    const rpc = await fetch(`${fixture.origin}/genlayer-rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'eth_chainId', params: [] }),
    });
    assert.equal((await rpc.json()).result, '0xf22f');
  } finally {
    await stopFixture(fixture);
  }
});

test('local server uses the shared V7 gate and reports legacy V6 liability without blocking', async () => {
  const fixture = await startFixture({
    environment: {
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7',
      VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
      VITE_GENLAYER_V6_CONTRACT: LEGACY_CONTRACT_ADDRESS,
      VITE_GENLAYER_V7_CONTRACT: CONTRACT_ADDRESS,
      GENLAYER_V7_OWNER: V7_OWNER,
      GENLAYER_V7_KEEPER: V7_KEEPER,
      GENLAYER_V7_TREASURY: V7_TREASURY,
      GENLAYER_V7_MIN_STAKE_ATTO: '100000000000000000',
      GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO: '10000000000000000000',
    },
    contractReader: async ({ address, functionName, args }) => {
      if (address === LEGACY_CONTRACT_ADDRESS && functionName === 'get_config') {
        return validContractConfig();
      }
      if (address === LEGACY_CONTRACT_ADDRESS
        && functionName === 'get_total_player_liability_atto') return 77n;
      if (address === CONTRACT_ADDRESS
        && functionName === 'get_total_player_liability_atto') return 456n;
      if (functionName === 'get_config') return validV7ContractConfig();
      if (functionName === 'get_epoch') return validV7Epoch(Number(args[0]));
      throw new Error('unexpected contract read');
    },
  });
  try {
    const response = await fetch(`${fixture.origin}/readyz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V7');
    assert.equal(body.checks.contract.keeper, V7_KEEPER);
    assert.equal(body.checks.keeperCoverage.ready, true);
    assert.deepEqual(body.checks.activePlayerFunds, {
      blocking: false,
      readable: true,
      playerLiabilityAtto: '456',
      hasOutstandingLiability: true,
    });
    assert.equal(body.checks.legacyV6.blocking, false);
    assert.equal(body.checks.legacyV6.totalPlayerLiabilityAtto, '77');
    assert.equal(body.checks.legacyV6.hasOutstandingLiability, true);
  } finally {
    await stopFixture(fixture);
  }
});

test('StudioNet readiness rejects a wrong chain ID or contract protocol', async () => {
  const wrongChain = await startFixture({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    },
    contractReader: async () => validContractConfig(),
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith('https://studio.genlayer.com/api')) {
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x107d' }));
      }
      if (String(url).includes('/ticker/price')) return new Response(JSON.stringify(BINANCE_QUOTES));
      return new Response(JSON.stringify(KLINES));
    },
  });
  try {
    const response = await fetch(`${wrongChain.origin}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).checks.genlayerRpc, { ready: false });
  } finally {
    await stopFixture(wrongChain);
  }

  const wrongProtocol = await startFixture({
    environment: {
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
      GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    },
    contractReader: async () => validContractConfig('MARKET_DOMINANCE_ARENA_V5'),
  });
  try {
    const response = await fetch(`${wrongProtocol.origin}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).checks.contract, { ready: false });
  } finally {
    await stopFixture(wrongProtocol);
  }

  for (const unsafeConfig of [
    { ...validContractConfig(), resolution_publication_delay_seconds: 1 },
    { ...validContractConfig(), timeout_refund_delay_seconds: 1 },
  ]) {
    const unsafeDelay = await startFixture({
      environment: {
        VITE_GENLAYER_NETWORK: 'studionet',
        VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V6',
        GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
      },
      contractReader: async () => unsafeConfig,
    });
    try {
      const response = await fetch(`${unsafeDelay.origin}/readyz`);
      assert.equal(response.status, 503);
      assert.deepEqual((await response.json()).checks.contract, { ready: false });
    } finally {
      await stopFixture(unsafeDelay);
    }
  }
});

test('readiness tries an official Binance fallback when Vision is unavailable', async () => {
  const tickerHosts = [];
  const fixture = await startFixture({
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.includes('studio.genlayer.com')) {
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0xf22f' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('/ticker/price')) {
        tickerHosts.push(new URL(target).host);
        if (target.includes('data-api.binance.vision')) throw new Error('Vision unavailable');
        return new Response(JSON.stringify(BINANCE_QUOTES), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(KLINES), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const readiness = await fetch(`${fixture.origin}/readyz`);
    assert.equal(readiness.status, 200);
    assert.deepEqual((await readiness.json()).checks.binance, { ready: true, feeds: 5 });
    assert.deepEqual(tickerHosts, ['data-api.binance.vision', 'api.binance.com']);
  } finally {
    await stopFixture(fixture);
  }
});

test('client IP resolution accepts forwarding headers only from an explicit trusted proxy', () => {
  const spoofed = { socket: { remoteAddress: '203.0.113.8' }, headers: { 'x-forwarded-for': '198.51.100.20' } };
  assert.equal(createClientIpResolver([])(spoofed), '203.0.113.8');
  const proxied = {
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.5' },
  };
  assert.equal(createClientIpResolver(['127.0.0.1', '10.0.0.5'])(proxied), '198.51.100.20');
});

test('same-origin Binance and wallet routes reject foreign origins but allow browser and MetaMask traffic', async () => {
  const fixture = await startFixture();
  try {
    const foreignHistory = await fetch(
      `${fixture.origin}/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240`,
      { headers: { origin: 'https://evil.example' } },
    );
    assert.equal(foreignHistory.status, 403);

    const history = await fetch(`${fixture.origin}/api/binance/klines?symbol=BTCUSDT&interval=5m&limit=240`);
    assert.equal(history.status, 200);
    assert.deepEqual(await history.json(), KLINES);
    assert.ok(fixture.upstreamRequests.some(({ url }) => url.includes('/api/v3/klines?')));

    const rpc = await fetch(`${fixture.origin}/genlayer-rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    assert.equal(rpc.status, 200);
    assert.equal((await rpc.json()).result, '0xf22f');
  } finally {
    await stopFixture(fixture);
  }
});

test('Binance SSE is mounted without a key and enforces the configured per-IP quota', async () => {
  const fixture = await startFixture({ environment: { SSE_MAX_CLIENTS_PER_IP: '1' } });
  const firstController = new AbortController();
  try {
    const first = await fetch(`${fixture.origin}/api/binance/stream`, { signal: firstController.signal });
    assert.equal(first.status, 200);
    const reader = first.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: prices/);

    const second = await fetch(`${fixture.origin}/api/binance/stream`);
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /Too many Binance stream connections/);

    firstController.abort();
    await reader.cancel().catch(() => {});
  } finally {
    firstController.abort();
    await stopFixture(fixture);
  }
  assert.equal(fixture.streamHub.destroyCalls, 1);
});

test('readiness degrades when chain data is unavailable while liveness stays available', async () => {
  const fixture = await startFixture({
    fetchImpl: async (url) => {
      if (String(url).includes('studio.genlayer.com')) return new Response('unavailable', { status: 503 });
      if (String(url).includes('/ticker/price')) {
        return new Response(JSON.stringify(BINANCE_QUOTES), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(KLINES), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const readiness = await fetch(`${fixture.origin}/readyz`);
    assert.equal(readiness.status, 503);
    const payload = await readiness.json();
    assert.equal(payload.status, 'degraded');
    assert.deepEqual(payload.checks.genlayerRpc, { ready: false });
    assert.deepEqual(payload.checks.binance, { ready: true, feeds: 5 });
    assert.equal((await fetch(`${fixture.origin}/healthz`)).status, 200);
  } finally {
    await stopFixture(fixture);
  }
});

test('production server refuses to start without a built dist directory', async () => {
  const missing = join(tmpdir(), `missing-arena-dist-${Date.now()}`);
  await assert.rejects(
    startProductionServer({
      config: testConfig(missing), host: '127.0.0.1', port: 0,
      streamHub: new FakeStreamHub(), logger: { error() {} },
    }),
    /Run npm run build first/,
  );
});
