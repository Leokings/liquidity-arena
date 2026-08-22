import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { abi, decodeInputData } from 'genlayer-js';

export const CLAIM_EPOCH = 1_787_155_200;
export const E2E_ACCOUNT = '0x63038a000000000000000000000000000000f38e';
export const V8_CONTRACT = '0x8888888888888888888888888888888888888888';
export const V8_PAYOUT_ID = 'ab'.repeat(32);
export const V8_VAULT = '0x4444444444444444444444444444444444444444';
export const PENDING_WITHDRAWAL_HASH = `0x${'cd'.repeat(32)}`;

const FACTORY = '0x944fdadd826c2a159c63cb100db174716ccd1317';
const OWNER = '0x1111111111111111111111111111111111111111';
const KEEPER = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const RESERVE_SINK = '0x5555555555555555555555555555555555555555';
const ONE_GEN = 1_000_000_000_000_000_000n;
const ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const VENUES = ['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN'];
const BINANCE_PRICES = Object.freeze({
  BTCUSDT: 65_000,
  ETHUSDT: 3_200,
  BNBUSDT: 580,
  SOLUSDT: 145,
  XRPUSDT: 0.62,
});
const BINANCE_INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
});

const factoryInterface = new Interface([
  'function protocol_version() view returns (string)',
  'function is_bound(address) view returns (bool)',
  'function is_prepared(string,address,uint256) view returns (bool)',
  'function vault_of(string) view returns (address)',
  'function reserveSink() view returns (address)',
]);
const vaultInterface = new Interface([
  'function record() view returns (bytes32,address,address,address,uint256,bool,bool,uint256,uint256,uint256,uint256,uint256)',
]);

function arenaConfig() {
  return {
    protocol_version: 'LIQUIDITY_ARENA_V8',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    owner: OWNER,
    keeper: KEEPER,
    treasury: TREASURY,
    payout_vault_factory: FACTORY,
    payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
    payouts_enabled: true,
    new_risk_enabled: true,
    max_payout_attempts: 3,
    prepare_retries_capped: false,
    payout_retry_delay_seconds: 3_600,
    current_platform_fee_bps: 200,
    epoch_min_stake_atto: 100_000_000_000_000_000n,
    epoch_max_stake_per_wallet_atto: 10n * ONE_GEN,
    minimum_epoch_creation_lead_seconds: 3_600,
    keeper_max_schedule_ahead_seconds: 93_600,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    asset_ids: ASSETS,
    venues: VENUES,
    validator_return_tolerance_ppb: 100_000,
    supported_objectives: ['HIGH', 'LOW'],
    payout_finality: 'FUNDED_IN_ESCROW',
    claimed_semantics: 'EOA_WITHDRAWN',
  };
}

function objective(epoch, name, { funded = false } = {}) {
  const total = name === 'HIGH' ? ONE_GEN : 0n;
  const fundedAmount = funded ? ONE_GEN : 0n;
  return {
    epoch_id: String(epoch),
    objective: name,
    settlement_mode: 'REFUND_TIMEOUT',
    winner_asset_id: '',
    winner_return_ppb: 0,
    payout_pool_atto: total,
    winning_stake_atto: 0n,
    losing_stake_atto: 0n,
    platform_fee_atto: 0n,
    total_stake_atto: total,
    participant_count: name === 'HIGH' ? 1 : 0,
    paid_atto: 0n,
    funded_in_escrow_atto: fundedAmount,
    allocated_atto: fundedAmount,
    remaining_payout_atto: total - fundedAmount,
    unallocated_payout_atto: total - fundedAmount,
    allocated_not_funded_atto: 0n,
    funded_not_withdrawn_atto: fundedAmount,
    unclaimed_winning_stake_atto: 0n,
  };
}

function epochRecord(epoch) {
  return {
    epoch_id: String(epoch),
    epoch_end_timestamp: epoch,
    wager_opens_timestamp: epoch - 2_400,
    wager_closes_timestamp: epoch - 1_200,
    battle_starts_timestamp: epoch - 1_200,
    resolution_available_timestamp: epoch + 120,
    timeout_refund_available_timestamp: epoch + 86_400,
    created_at_timestamp: epoch - 3_600,
    creator: OWNER,
    status: 'TIMED_OUT',
    result_status: 'TIMEOUT',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    platform_fee_bps_snapshot: 200,
    min_stake_atto: 100_000_000_000_000_000n,
    max_stake_per_wallet_atto: 10n * ONE_GEN,
    qualified_venues: [],
    venue_count: 0,
    high_winner_asset_id: '',
    high_winner_return_ppb: 0,
    low_winner_asset_id: '',
    low_winner_return_ppb: 0,
    resolved_at_timestamp: epoch + 86_401,
    resolution_digest: `e2e-timeout-${epoch}`,
    platform_fee_accrued_atto: 0n,
    phase: 'TIMED_OUT',
    high: objective(epoch, 'HIGH', { funded: epoch === CLAIM_EPOCH }),
    low: objective(epoch, 'LOW'),
  };
}

function claimQuote(epoch, objectiveName, account) {
  const isPosition = epoch === CLAIM_EPOCH && objectiveName === 'HIGH';
  return {
    epoch_end_timestamp: epoch,
    objective: objectiveName,
    account,
    choice_asset_id: isPosition ? 'XRP' : '',
    stake_atto: isPosition ? ONE_GEN : 0n,
    settlement_mode: 'REFUND_TIMEOUT',
    eligible: false,
    claimed: false,
    claimed_atto: 0n,
    escrow_funded_atto: isPosition ? ONE_GEN : 0n,
    amount_atto: isPosition ? ONE_GEN : 0n,
    includes_rounding_remainder: false,
    payout_id: isPosition ? V8_PAYOUT_ID : '',
    payout_state: isPosition ? 'FUNDED_IN_ESCROW' : '',
  };
}

function payoutRecord() {
  return {
    payout_id: V8_PAYOUT_ID,
    kind: 'PLAYER',
    recipient: E2E_ACCOUNT,
    amount_atto: ONE_GEN,
    epoch_end_timestamp: CLAIM_EPOCH,
    objective: 'HIGH',
    wallet_key: E2E_ACCOUNT,
    stake_atto: ONE_GEN,
    settlement_mode: 'REFUND_TIMEOUT',
    includes_rounding_remainder: false,
    state: 'FUNDED_IN_ESCROW',
    prepare_attempt_count: 1,
    attempt_count: 1,
    reserve_remaining_atto: 0n,
    vault: V8_VAULT,
    created_at_timestamp: CLAIM_EPOCH + 86_400,
    last_prepare_timestamp: CLAIM_EPOCH + 86_401,
    last_dispatch_timestamp: CLAIM_EPOCH + 86_402,
    funded_at_timestamp: CLAIM_EPOCH + 86_403,
    withdrawn_at_timestamp: 0,
    escrow_withdrawn: false,
  };
}

function callResult(method, args) {
  switch (method) {
    case 'get_config':
      return arenaConfig();
    case 'get_epoch_page': {
      const offset = Number(args[0]);
      const limit = Number(args[1]);
      const epochIds = [String(CLAIM_EPOCH)].slice(offset, offset + limit);
      return { offset, next_offset: offset + epochIds.length, total: 1, epoch_ids: epochIds };
    }
    case 'get_epoch':
      return epochRecord(Number(args[0]));
    case 'get_epoch_asset':
      return {
        asset_id: String(args[1] || 'BTC'),
        label: String(args[1] || 'BTC'),
        return_ppb: 0,
        venue_returns_ppb: [],
        high_stake_atto: String(args[1] || '').toUpperCase() === 'XRP' ? ONE_GEN : 0n,
        low_stake_atto: 0n,
      };
    case 'get_objective':
      return objective(Number(args[0]), String(args[1] || 'HIGH'));
    case 'get_claim_quote': {
      return claimQuote(
        Number(args[0]),
        String(args[1] || 'HIGH').toUpperCase(),
        E2E_ACCOUNT,
      );
    }
    case 'get_payout':
      return payoutRecord();
    case 'get_delivery_reserve_state':
      return { available_reserve_atto: 10n * ONE_GEN };
    case 'get_payout_page':
      return { offset: 0, next_offset: 1, total: 1, payouts: [payoutRecord()] };
    default:
      throw new Error(`Unexpected mocked V8 method: ${method}`);
  }
}

function encodedResult(value) {
  return Buffer.from(abi.calldata.encode(value)).toString('hex');
}

async function handleRpcRoute(route, context) {
  let request;
  try {
    request = route.request().postDataJSON();
  } catch {
    await route.fulfill({ status: 400, body: 'Malformed JSON-RPC request.' });
    return;
  }
  const messages = Array.isArray(request) ? request : [request];
  const responses = messages.map((message) => {
    let method = null;
    try {
      if (message?.method !== 'gen_call') {
        throw new Error(`Unexpected mocked JSON-RPC method: ${message?.method}`);
      }
      const params = message.params?.[0];
      const decoded = decodeInputData(params?.data, params?.to);
      method = decoded?.callData?.get('method');
      const args = decoded?.callData?.get('args') || [];
      context.calls.push(Object.freeze({ method, args }));
      return {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: encodedResult(callResult(method, args)),
      };
    } catch (error) {
      context.errors.push(Object.freeze({ method, message: error.message }));
      return {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32_000, message: error.message },
      };
    }
  });
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(request) ? responses : responses[0]),
  });
}

export async function installBradburyV8RpcMock(page) {
  const context = { calls: [], errors: [] };
  const handler = (route) => handleRpcRoute(route, context);
  await page.route('**/genlayer-rpc', handler);
  await page.route('https://rpc-bradbury.genlayer.com/**', handler);
  return context;
}

export async function installHermeticBinanceMock(page) {
  const context = { requests: [] };
  await page.route('**/api/binance/**', async (route) => {
    const url = new URL(route.request().url());
    context.requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/api/binance/stream') {
      const nowUs = String(BigInt(Date.now()) * 1_000n);
      const payload = {
        channel: 'aggTrade',
        transport: 'playwright-fixture',
        transportMode: 'hermetic',
        sourceTimestampUs: nowUs,
        assets: ASSETS.map((id) => ({
          id,
          price: BINANCE_PRICES[`${id}USDT`],
          feedUpdateTimestampUs: nowUs,
          carriedForward: false,
        })),
      };
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-store' },
        body: `event: prices\ndata: ${JSON.stringify(payload)}\n\n`,
      });
      return;
    }
    if (url.pathname !== '/api/binance/klines') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unknown fixture route"}' });
      return;
    }
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
    const interval = String(url.searchParams.get('interval') || '');
    const limit = Number(url.searchParams.get('limit'));
    const intervalMs = BINANCE_INTERVAL_MS[interval];
    const base = BINANCE_PRICES[symbol];
    if (!base || !intervalMs || !Number.isSafeInteger(limit) || limit < 2 || limit > 1_000) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"invalid fixture query"}' });
      return;
    }
    const lastOpen = Math.floor((Date.now() - intervalMs) / intervalMs) * intervalMs;
    const firstOpen = lastOpen - ((limit - 1) * intervalMs);
    const rows = Array.from({ length: limit }, (_, index) => {
      const openTime = firstOpen + (index * intervalMs);
      const open = base * (1 + (index * 0.00005));
      const close = open * (1 + (((index % 5) - 2) * 0.00002));
      return [
        openTime,
        open.toFixed(8),
        (Math.max(open, close) * 1.0001).toFixed(8),
        (Math.min(open, close) * 0.9999).toFixed(8),
        close.toFixed(8),
        '100',
        openTime + intervalMs - 1,
        '1000',
        10,
        '50',
        '500',
        '0',
      ];
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(rows),
    });
  });
  return context;
}

export async function installBradburyWalletMock(page, { vaultWithdrawn = false } = {}) {
  const factoryResults = Object.fromEntries([
    ['protocol_version', ['IDEMPOTENT_EVM_VAULT_V1']],
    ['is_bound', [true]],
    ['is_prepared', [true]],
    ['vault_of', [V8_VAULT]],
    ['reserveSink', [RESERVE_SINK]],
  ].map(([name, values]) => [
    factoryInterface.getFunction(name).selector,
    factoryInterface.encodeFunctionResult(name, values),
  ]));
  const vaultResult = vaultInterface.encodeFunctionResult('record', [
    keccak256(toUtf8Bytes(V8_PAYOUT_ID)),
    V8_CONTRACT,
    E2E_ACCOUNT,
    RESERVE_SINK,
    ONE_GEN,
    true,
    vaultWithdrawn,
    10n,
    vaultWithdrawn ? 20n : 0n,
    vaultWithdrawn ? 0n : ONE_GEN,
    vaultWithdrawn ? 0n : ONE_GEN,
    0n,
  ]);
  await page.addInitScript((fixture) => {
    let activeChain = '0x1';
    const listeners = new Map();
    window.__e2eWalletRequests = [];
    const provider = {
      async request({ method, params = [] }) {
        window.__e2eWalletRequests.push({ method, params });
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [fixture.account];
        if (method === 'eth_chainId') return activeChain;
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'wallet_switchEthereumChain') {
          activeChain = params[0].chainId;
          return null;
        }
        if (method === 'eth_getBalance') return '0x8ac7230489e80000';
        if (method === 'eth_getCode') return '0x60006000';
        if (method === 'eth_call') {
          const [{ to, data }] = params;
          if (String(to).toLowerCase() === fixture.vault) return fixture.vaultResult;
          const result = fixture.factoryResults[String(data).slice(0, 10).toLowerCase()];
          if (result) return result;
          throw new Error(`Unexpected mocked eth_call selector ${String(data).slice(0, 10)}.`);
        }
        if (method === 'eth_getTransactionByHash') {
          if (String(params[0]).toLowerCase() !== fixture.pendingHash) return null;
          return {
            hash: fixture.pendingHash,
            from: fixture.account,
            to: fixture.vault,
            input: '0x3ccfd60b',
            value: '0x0',
            blockHash: null,
          };
        }
        if (method === 'eth_getTransactionReceipt') return null;
        if (method === 'eth_sendTransaction') return fixture.retryHash;
        throw new Error(`Unexpected mocked wallet method: ${method}`);
      },
      on(name, listener) {
        const handlers = listeners.get(name) || new Set();
        handlers.add(listener);
        listeners.set(name, handlers);
      },
      removeListener(name, listener) { listeners.get(name)?.delete(listener); },
    };
    Object.defineProperty(window, 'ethereum', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: provider,
    });
  }, {
    account: E2E_ACCOUNT,
    vault: V8_VAULT,
    pendingHash: PENDING_WITHDRAWAL_HASH,
    retryHash: `0x${'ee'.repeat(32)}`,
    factoryResults,
    vaultResult,
  });
}

export async function seedPendingWithdrawalJournal(page) {
  await page.addInitScript((fixture) => {
    if (localStorage.getItem(fixture.key)) return;
    localStorage.setItem(fixture.key, JSON.stringify([{
      payoutId: fixture.payoutId,
      account: fixture.account,
      contractAddress: fixture.contract,
      chainId: 4221,
      epochEndTimestamp: fixture.epoch,
      objective: 'HIGH',
      amountAtto: fixture.amount,
      state: 'FUNDED_IN_ESCROW',
      vault: fixture.vault,
      hashes: {},
      withdrawalAttempts: [{
        hash: fixture.hash,
        status: 'PENDING',
        createdAt: 1,
        updatedAt: 1,
      }],
      createdAt: 1,
      updatedAt: 1,
    }]));
  }, {
    key: 'liquidity-arena:v8:payouts:v2',
    payoutId: V8_PAYOUT_ID,
    account: E2E_ACCOUNT,
    contract: V8_CONTRACT,
    epoch: CLAIM_EPOCH,
    amount: ONE_GEN.toString(),
    vault: V8_VAULT,
    hash: PENDING_WITHDRAWAL_HASH,
  });
}
