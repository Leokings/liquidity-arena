import { configuredBinanceRestBases } from '../market/binance-proxy.js';

import {
  LIQUIDITY_ARENA_POLICY,
  assertLiquidityArenaDeploymentConfig,
  normalizedAtto,
} from './deployment-config.mjs';
import {
  validateLiquidityArenaV8Config,
  validateLiquidityArenaV8Reserve,
  validateLiquidityArenaV8Schema,
} from './v8-contract-config.mjs';

export const READINESS_CACHE_MS = 30_000;
export const READINESS_TIMEOUT_MS = 5_000;
const READINESS_RESPONSE_BYTES = 2 * 1024 * 1024;
const HOUR_SECONDS = 3_600;
const WAGER_OPEN_OFFSET_SECONDS = 2_400;
const BATTLE_OPEN_OFFSET_SECONDS = 1_200;
const RESOLUTION_PUBLICATION_DELAY_SECONDS = 120;
const TIMEOUT_REFUND_DELAY_SECONDS = 86_400;
const FIVE_SYMBOL_QUERY = 'ticker/price?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%2C%22BNBUSDT%22%2C%22SOLUSDT%22%2C%22XRPUSDT%22%5D';
const EXPECTED_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT']);

function chainField(value, snakeCase, camelCase) {
  return value?.[snakeCase] ?? value?.[camelCase];
}

function exactInteger(value, expected) {
  try {
    return normalizedAtto(value, 'chain integer') === String(expected);
  } catch {
    return false;
  }
}

export function readinessEpochEnds(nowMs = Date.now()) {
  const timestamp = Number(nowMs);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('Readiness timestamp must be a non-negative millisecond integer.');
  }
  const nowSeconds = Math.floor(timestamp / 1_000);
  const hourStart = Math.floor(nowSeconds / HOUR_SECONDS) * HOUR_SECONDS;
  const operational = hourStart + HOUR_SECONDS;
  return Object.freeze([operational, operational + HOUR_SECONDS]);
}

export function isOperationalLiquidityArenaEpoch(raw, epochEndTimestamp, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return exactInteger(chainField(raw, 'epoch_end_timestamp', 'epochEndTimestamp'), epochEndTimestamp)
    && exactInteger(chainField(raw, 'wager_opens_timestamp', 'wagerOpensTimestamp'), epochEndTimestamp - WAGER_OPEN_OFFSET_SECONDS)
    && exactInteger(chainField(raw, 'wager_closes_timestamp', 'wagerClosesTimestamp'), epochEndTimestamp - BATTLE_OPEN_OFFSET_SECONDS)
    && exactInteger(chainField(raw, 'battle_starts_timestamp', 'battleStartsTimestamp'), epochEndTimestamp - BATTLE_OPEN_OFFSET_SECONDS)
    && exactInteger(chainField(raw, 'resolution_available_timestamp', 'resolutionAvailableTimestamp'), epochEndTimestamp + RESOLUTION_PUBLICATION_DELAY_SECONDS)
    && exactInteger(chainField(raw, 'timeout_refund_available_timestamp', 'timeoutRefundAvailableTimestamp'), epochEndTimestamp + TIMEOUT_REFUND_DELAY_SECONDS)
    && String(chainField(raw, 'policy_version', 'policyVersion') || '') === LIQUIDITY_ARENA_POLICY
    && String(raw.status || '') === 'OPEN'
    && exactInteger(chainField(raw, 'min_stake_atto', 'minStakeAtto'), config.v8Expectations.minimumStakeAtto)
    && exactInteger(chainField(raw, 'max_stake_per_wallet_atto', 'maxStakePerWalletAtto'), config.v8Expectations.maximumStakePerWalletAtto)
    && exactInteger(chainField(raw, 'platform_fee_bps_snapshot', 'platformFeeBpsSnapshot'), 200);
}

async function readJsonWithinLimit(response, maxBytes = READINESS_RESPONSE_BYTES) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Response is too large.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('Response is too large.');
  return JSON.parse(new TextDecoder().decode(bytes));
}

function withTimeout(task, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createLiquidityArenaReadinessProbe({
  config,
  fetchImpl = globalThis.fetch,
  readContract,
  readSchema,
  now = Date.now,
  timeoutMs = READINESS_TIMEOUT_MS,
  cacheMs = READINESS_CACHE_MS,
} = {}) {
  assertLiquidityArenaDeploymentConfig(config);
  if (typeof fetchImpl !== 'function') throw new TypeError('A readiness fetch implementation is required.');
  if (typeof readContract !== 'function') throw new TypeError('A readiness contract reader is required.');
  if (typeof readSchema !== 'function') throw new TypeError('A readiness schema reader is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('Readiness timeout must be between 1 and 60000 milliseconds.');
  }
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 300_000) {
    throw new RangeError('Readiness cache must be between 0 and 300000 milliseconds.');
  }

  let cached = null;
  let pending = null;
  let controller = null;
  let destroyed = false;

  const read = (functionName, args = []) => withTimeout(
    () => readContract({ address: config.contractAddress, functionName, args, signal: controller?.signal }),
    timeoutMs,
    `${functionName}(${config.contractAddress})`,
  );

  async function checkRpc() {
    try {
      const body = await withTimeout(async () => {
        const response = await fetchImpl(config.genLayerRpcUrl, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: controller?.signal,
        });
        if (!response?.ok) throw new Error('Bradbury RPC is unavailable.');
        return readJsonWithinLimit(response);
      }, timeoutMs, 'Bradbury chain ID');
      return String(body?.result || '').toLowerCase() === config.genLayerChainId
        ? { ready: true, chainId: config.genLayerChainId, network: config.genLayerNetwork }
        : { ready: false };
    } catch {
      return { ready: false };
    }
  }

  async function checkContract() {
    try {
      const [schema, rawConfig, rawReserve] = await Promise.all([
        withTimeout(() => readSchema(config.contractAddress), timeoutMs, `schema(${config.contractAddress})`),
        read('get_config'),
        read('get_delivery_reserve_state'),
      ]);
      const schemaIdentity = validateLiquidityArenaV8Schema(schema);
      const verified = validateLiquidityArenaV8Config(rawConfig, config.v8Expectations);
      const reserve = validateLiquidityArenaV8Reserve(rawReserve, config.v8Expectations);
      return { ready: true, address: config.contractAddress, ...verified, ...schemaIdentity, reserve };
    } catch {
      return { ready: false };
    }
  }

  async function checkKeeperCoverage() {
    const epochEnds = readinessEpochEnds(Number(now()));
    try {
      const epochs = await Promise.all(epochEnds.map((epochEndTimestamp) => read(
        'get_epoch',
        [BigInt(epochEndTimestamp)],
      )));
      return {
        ready: epochs.every((epoch, index) => isOperationalLiquidityArenaEpoch(epoch, epochEnds[index], config)),
        epochEnds,
      };
    } catch {
      return { ready: false, epochEnds };
    }
  }

  async function checkFiveFeeds() {
    for (const base of configuredBinanceRestBases(config.binanceRestBases)) {
      try {
        const quotes = await withTimeout(async () => {
          const response = await fetchImpl(`${base}/${FIVE_SYMBOL_QUERY}`, {
            headers: { accept: 'application/json' }, signal: controller?.signal,
          });
          if (!response?.ok) throw new Error('Binance display feed is unavailable.');
          return readJsonWithinLimit(response);
        }, timeoutMs, `Binance display feed ${base}`);
        const symbols = new Set(Array.isArray(quotes)
          ? quotes.filter(({ symbol, price }) => EXPECTED_SYMBOLS.has(String(symbol)) && Number(price) > 0)
            .map(({ symbol }) => String(symbol))
          : []);
        if (symbols.size === EXPECTED_SYMBOLS.size) return { ready: true, feeds: EXPECTED_SYMBOLS.size };
      } catch {
        // Continue through the fixed official Binance fallback list.
      }
    }
    return { ready: false };
  }

  async function run() {
    controller = new AbortController();
    const abortTimer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const [genlayerRpc, contract, keeperCoverage, binance] = await Promise.all([
        checkRpc(), checkContract(), checkKeeperCoverage(), checkFiveFeeds(),
      ]);
      const ready = genlayerRpc.ready && contract.ready && keeperCoverage.ready && binance.ready;
      return {
        status: ready ? 'ready' : 'degraded',
        service: 'liquidity-arena',
        checks: {
          static: { ready: true, deployment: 'v8', legacyClaimsEnabled: false },
          genlayerRpc,
          contract,
          keeperCoverage,
          binance,
        },
      };
    } finally {
      clearTimeout(abortTimer);
      controller = null;
    }
  }

  return Object.freeze({
    async probe() {
      const timestamp = Number(now());
      if (cached && Number.isFinite(timestamp) && timestamp < cached.expiresAt) return cached.payload;
      if (pending) return pending;
      if (destroyed) throw new Error('Readiness probe has been destroyed.');
      pending = run().then((payload) => {
        cached = { payload, expiresAt: Number(now()) + cacheMs };
        return payload;
      }).finally(() => { pending = null; });
      return pending;
    },
    destroy() {
      destroyed = true;
      controller?.abort();
      controller = null;
      cached = null;
    },
  });
}
