import { abi, decodeInputData } from 'genlayer-js';

export const CLAIM_EPOCH = 1_787_205_600;
export const V6_CLAIM_EPOCH = CLAIM_EPOCH - 3_600;
export const E2E_ACCOUNT = '0x63038a000000000000000000000000000000f38e';

export const V7_CONTRACT = '0xb2ae59ae641f571726ae81e30080f8c2192b15ef';
export const V6_CONTRACT = '0x587950dcdc2a8c4dfcde98a72715a06f5844e0b1';
const OWNER = '0x797d3b25fb2cca0ff93f60df1910267f3822d655';
const KEEPER = '0x12ba664a1ec9ca78b070d103c6a69e20673f4b51';
const ONE_GEN = 1_000_000_000_000_000_000n;
const ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
const SETTLEMENT_MODES = [
  'PENDING',
  'PARIMUTUEL',
  'REFUND_TIE',
  'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE',
  'REFUND_UNDETERMINED',
  'REFUND_TIMEOUT',
];

function arenaConfig(protocol) {
  return {
    protocol_version: protocol,
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    current_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    default_platform_fee_bps: 200,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    transfer_finality: 'FINALIZED',
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: SETTLEMENT_MODES,
    owner: OWNER,
    keeper: KEEPER,
    treasury: OWNER,
  };
}

function objective(epoch, name) {
  return {
    epoch_id: String(epoch),
    objective: name,
    settlement_mode: 'REFUND_UNBACKED_WINNER',
    winner_asset_id: 'XRP',
    winner_return_ppb: name === 'HIGH' ? 3_000_000 : -3_000_000,
    payout_pool_atto: ONE_GEN,
    winning_stake_atto: ONE_GEN,
    losing_stake_atto: 0n,
    platform_fee_atto: 0n,
    total_stake_atto: ONE_GEN,
    participant_count: 1,
    paid_atto: 0n,
    remaining_payout_atto: ONE_GEN,
    unclaimed_winning_stake_atto: ONE_GEN,
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
    status: 'RESOLVED',
    result_status: 'DETERMINED',
    phase: 'RESOLVED',
    policy_version: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    platform_fee_bps_snapshot: 200,
    min_stake_atto: 100_000_000_000_000_000n,
    max_stake_per_wallet_atto: 10n * ONE_GEN,
    qualified_venues: ['BINANCE', 'OKX', 'GATE', 'KUCOIN'],
    venue_count: 4,
    high_winner_asset_id: 'XRP',
    high_winner_return_ppb: 3_000_000,
    low_winner_asset_id: 'BTC',
    low_winner_return_ppb: -3_000_000,
    resolved_at_timestamp: epoch + 130,
    resolution_digest: `e2e-${epoch}`,
    platform_fee_accrued_atto: 0n,
    high: objective(epoch, 'HIGH'),
    low: objective(epoch, 'LOW'),
  };
}

function claimPosition(
  epoch = CLAIM_EPOCH,
  objectiveName = 'HIGH',
  positionIndex = null,
  account = E2E_ACCOUNT,
) {
  return {
    epoch_end_timestamp: epoch,
    objective: objectiveName,
    account,
    choice_asset_id: 'XRP',
    stake_atto: ONE_GEN,
    settlement_mode: 'REFUND_UNBACKED_WINNER',
    eligible: true,
    claimed: false,
    claimed_atto: 0n,
    amount_atto: ONE_GEN,
    includes_rounding_remainder: false,
    ...(positionIndex === null ? {} : { position_index: positionIndex }),
  };
}

function assetRecord(assetId) {
  const index = Math.max(0, ASSETS.indexOf(assetId));
  const returnPpb = (index - 2) * 1_500_000;
  return {
    asset_id: assetId,
    return_ppb: returnPpb,
    venue_returns_ppb: [returnPpb - 2, returnPpb - 1, returnPpb + 1, returnPpb + 2],
    high_stake_atto: assetId === 'XRP' ? ONE_GEN : 0n,
    low_stake_atto: 0n,
  };
}

function deploymentAlias(contract) {
  const normalized = String(contract || '').toLowerCase();
  if (normalized === V7_CONTRACT) return 'v7';
  if (normalized === V6_CONTRACT) return 'v6';
  throw new Error(`Unexpected mocked deployment contract: ${normalized || '<empty>'}.`);
}

function deploymentPositions(contract, context) {
  const alias = deploymentAlias(contract);
  const configuredCount = context.positionCounts?.[alias];
  if (Number.isSafeInteger(configuredCount) && configuredCount >= 0) {
    const baseEpoch = alias === 'v7' ? CLAIM_EPOCH : V6_CLAIM_EPOCH;
    const objectiveName = alias === 'v7' ? 'HIGH' : 'LOW';
    return Array.from({ length: configuredCount }, (_, positionIndex) => claimPosition(
      baseEpoch + positionIndex * 3_600,
      objectiveName,
      positionIndex,
    ));
  }
  return alias === 'v7'
    ? [claimPosition(CLAIM_EPOCH, 'HIGH', 0)]
    : [claimPosition(V6_CLAIM_EPOCH, 'LOW', 0)];
}

function callResult(to, method, args, context) {
  const contract = String(to || '').toLowerCase();
  const { failMethods } = context;
  if (failMethods.has(method)) throw new Error(`Mocked ${method} read failure.`);
  if (context.failHistoryDeployments.has(deploymentAlias(contract))
    && (method === 'get_wallet_position_count' || method === 'get_wallet_position_page')) {
    throw new Error(`Mocked ${deploymentAlias(contract).toUpperCase()} wallet history failure.`);
  }
  switch (method) {
    case 'get_config':
      return arenaConfig(contract === V7_CONTRACT ? 'LIQUIDITY_ARENA_V7' : 'LIQUIDITY_ARENA_V6');
    case 'get_epoch':
      return epochRecord(Number(args[0]));
    case 'get_epoch_count':
      return 0n;
    case 'get_epoch_page':
      return { epoch_ids: [] };
    case 'get_epoch_asset':
      return assetRecord(String(args[1] || 'BTC'));
    case 'get_wallet_position_count':
      return BigInt(deploymentPositions(contract, context).length);
    case 'get_wallet_position_page': {
      const positions = deploymentPositions(contract, context);
      const offset = Number(args[1]);
      const limit = Number(args[2]);
      const pagePositions = positions.slice(offset, offset + limit);
      return {
        account: E2E_ACCOUNT,
        offset,
        next_offset: offset + pagePositions.length,
        total: positions.length,
        positions: pagePositions,
      };
    }
    case 'get_entry':
      return claimPosition(Number(args[0]), String(args[1] || 'HIGH'));
    case 'get_claim_quote':
      return claimPosition(
        Number(args[0]),
        String(args[1] || 'HIGH'),
        null,
        context.claimQuoteAccount || E2E_ACCOUNT,
      );
    default:
      throw new Error(`Unexpected mocked GenLayer method: ${method}`);
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
  const responses = await Promise.all(messages.map(async (message) => {
    let method = null;
    try {
      if (message?.method !== 'gen_call') {
        throw new Error(`Unexpected mocked JSON-RPC method: ${message?.method}`);
      }
      const params = message.params?.[0];
      const decoded = decodeInputData(params?.data, params?.to);
      method = decoded?.callData?.get('method');
      const args = decoded?.callData?.get('args') || [];
      context.calls.push(Object.freeze({
        contract: String(params?.to || '').toLowerCase(),
        method,
        args,
      }));
      const delayMs = context.delayMethods.get(method) || 0;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: encodedResult(callResult(params?.to, method, args, context)),
      };
    } catch (error) {
      context.errors.push(Object.freeze({ method, message: error.message }));
      return {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32_000, message: error.message },
      };
    }
  }));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(request) ? responses : responses[0]),
  });
}

export async function installStudioNetRpcMock(page, {
  failMethods = [],
  claimQuoteAccount = null,
  delayMethods = {},
  failHistoryDeployments = [],
  positionCounts = null,
} = {}) {
  const context = {
    calls: [],
    errors: [],
    failMethods: new Set(failMethods),
    claimQuoteAccount,
    delayMethods: new Map(Object.entries(delayMethods)),
    failHistoryDeployments: new Set(failHistoryDeployments),
    positionCounts,
  };
  const handler = (route) => handleRpcRoute(route, context);
  await page.route('**/genlayer-rpc', handler);
  await page.route('https://studio.genlayer.com/api', handler);
  return context;
}

export async function installWalletMock(page, {
  accountRequestDelayMs = 0,
  failBalance = false,
} = {}) {
  await page.addInitScript(({ account, delayMs, shouldFailBalance }) => {
    const listeners = new Map();
    const provider = {
      async request({ method }) {
        window.__e2eWalletRequests.push(method);
        if (method === 'eth_requestAccounts') {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return [account];
        }
        if (method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return '0xf22f';
        if (method === 'eth_getBalance') {
          if (shouldFailBalance) throw new Error('Mocked wallet balance failure.');
          return '0x8ac7230489e80000';
        }
        if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null;
        throw new Error(`Unexpected mocked wallet method: ${method}`);
      },
      on(name, listener) {
        const handlers = listeners.get(name) || new Set();
        handlers.add(listener);
        listeners.set(name, handlers);
      },
      removeListener(name, listener) {
        listeners.get(name)?.delete(listener);
      },
    };
    window.__e2eWalletRequests = [];
    window.__e2eDocumentId = `${Date.now()}-${Math.random()}`;
    Object.defineProperty(window, 'ethereum', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: provider,
    });
  }, {
    account: E2E_ACCOUNT,
    delayMs: accountRequestDelayMs,
    shouldFailBalance: failBalance,
  });
}
