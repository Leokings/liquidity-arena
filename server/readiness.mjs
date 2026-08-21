import { configuredBinanceRestBases } from '../market/binance-proxy.js';

import {
  LIQUIDITY_ARENA_POLICY,
  LIQUIDITY_ARENA_V6_PROTOCOL,
  LIQUIDITY_ARENA_V7_PROTOCOL,
  assertLiquidityArenaDeploymentConfig,
  normalizedAtto,
} from './deployment-config.mjs';
import { validateLiquidityArenaV6Config } from './v6-contract-config.mjs';
import { validateLiquidityArenaV7Config } from './v7-contract-config.mjs';

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
  const baseMatches = exactInteger(
    chainField(raw, 'epoch_end_timestamp', 'epochEndTimestamp'),
    epochEndTimestamp,
  )
    && exactInteger(
      chainField(raw, 'wager_opens_timestamp', 'wagerOpensTimestamp'),
      epochEndTimestamp - WAGER_OPEN_OFFSET_SECONDS,
    )
    && exactInteger(
      chainField(raw, 'wager_closes_timestamp', 'wagerClosesTimestamp'),
      epochEndTimestamp - BATTLE_OPEN_OFFSET_SECONDS,
    )
    && exactInteger(
      chainField(raw, 'battle_starts_timestamp', 'battleStartsTimestamp'),
      epochEndTimestamp - BATTLE_OPEN_OFFSET_SECONDS,
    )
    && exactInteger(
      chainField(raw, 'resolution_available_timestamp', 'resolutionAvailableTimestamp'),
      epochEndTimestamp + RESOLUTION_PUBLICATION_DELAY_SECONDS,
    )
    && exactInteger(
      chainField(raw, 'timeout_refund_available_timestamp', 'timeoutRefundAvailableTimestamp'),
      epochEndTimestamp + TIMEOUT_REFUND_DELAY_SECONDS,
    )
    && String(chainField(raw, 'policy_version', 'policyVersion') || '') === LIQUIDITY_ARENA_POLICY
    && String(raw.status || '') === 'OPEN';
  if (!baseMatches) return false;
  if (config.expectedContractProtocol !== LIQUIDITY_ARENA_V7_PROTOCOL) return true;
  return exactInteger(
    chainField(raw, 'min_stake_atto', 'minStakeAtto'),
    config.v7Expectations.minimumStakeAtto,
  )
    && exactInteger(
      chainField(raw, 'max_stake_per_wallet_atto', 'maxStakePerWalletAtto'),
      config.v7Expectations.maximumStakePerWalletAtto,
    )
    && exactInteger(
      chainField(raw, 'platform_fee_bps_snapshot', 'platformFeeBpsSnapshot'),
      200,
    );
}

async function readJsonWithinLimit(response, maxBytes = READINESS_RESPONSE_BYTES) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Response is too large.');
  }
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

function validateActiveContract(raw, config) {
  if (config.expectedContractProtocol === LIQUIDITY_ARENA_V7_PROTOCOL) {
    return validateLiquidityArenaV7Config(raw, config.v7Expectations);
  }
  const verified = validateLiquidityArenaV6Config(raw);
  if (verified.protocolVersion !== LIQUIDITY_ARENA_V6_PROTOCOL) {
    throw new Error('Active V6 protocol does not match deployment configuration.');
  }
  return verified;
}

export function createLiquidityArenaReadinessProbe({
  config,
  fetchImpl = globalThis.fetch,
  readContract,
  now = Date.now,
  timeoutMs = READINESS_TIMEOUT_MS,
  cacheMs = READINESS_CACHE_MS,
} = {}) {
  assertLiquidityArenaDeploymentConfig(config);
  if (typeof fetchImpl !== 'function') throw new TypeError('A readiness fetch implementation is required.');
  if (typeof readContract !== 'function') throw new TypeError('A readiness contract reader is required.');
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

  async function read(address, functionName, args = []) {
    return withTimeout(
      () => readContract({ address, functionName, args, signal: controller?.signal }),
      timeoutMs,
      `${functionName}(${address})`,
    );
  }

  async function checkRpc() {
    try {
      const body = await withTimeout(async () => {
        const response = await fetchImpl(config.genLayerRpcUrl, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: controller?.signal,
        });
        if (!response?.ok) throw new Error('StudioNet RPC is unavailable.');
        return readJsonWithinLimit(response);
      }, timeoutMs, 'StudioNet chain ID');
      return String(body?.result || '').toLowerCase() === config.genLayerChainId
        ? { ready: true, chainId: config.genLayerChainId, network: config.genLayerNetwork }
        : { ready: false };
    } catch {
      return { ready: false };
    }
  }

  async function checkActiveContract() {
    try {
      const raw = await read(config.contractAddress, 'get_config');
      const verified = validateActiveContract(raw, config);
      return { ready: true, address: config.contractAddress, ...verified };
    } catch {
      return { ready: false };
    }
  }

  async function checkKeeperCoverage() {
    const epochEnds = readinessEpochEnds(Number(now()));
    try {
      const epochs = await Promise.all(epochEnds.map((epochEndTimestamp) => read(
        config.contractAddress,
        'get_epoch',
        [BigInt(epochEndTimestamp)],
      )));
      const ready = epochs.every((epoch, index) => isOperationalLiquidityArenaEpoch(
        epoch,
        epochEnds[index],
        config,
      ));
      return { ready, epochEnds };
    } catch {
      return { ready: false, epochEnds };
    }
  }

  async function checkFiveFeeds() {
    for (const base of configuredBinanceRestBases(config.binanceRestBases)) {
      try {
        const quotes = await withTimeout(async () => {
          const response = await fetchImpl(`${base}/${FIVE_SYMBOL_QUERY}`, {
            headers: { accept: 'application/json' },
            signal: controller?.signal,
          });
          if (!response?.ok) throw new Error('Binance display feed is unavailable.');
          return readJsonWithinLimit(response);
        }, timeoutMs, `Binance display feed ${base}`);
        const symbols = new Set(Array.isArray(quotes)
          ? quotes
            .filter(({ symbol, price }) => EXPECTED_SYMBOLS.has(String(symbol)) && Number(price) > 0)
            .map(({ symbol }) => String(symbol))
          : []);
        if (symbols.size === EXPECTED_SYMBOLS.size) {
          return { ready: true, feeds: EXPECTED_SYMBOLS.size };
        }
      } catch {
        // Continue through the fixed official Binance fallback list.
      }
    }
    return { ready: false };
  }

  async function checkActivePlayerFunds() {
    try {
      const rawLiability = await read(
        config.contractAddress,
        'get_total_player_liability_atto',
      );
      const playerLiabilityAtto = normalizedAtto(
        rawLiability,
        'active contract player liability',
      );
      return {
        blocking: false,
        readable: true,
        playerLiabilityAtto,
        hasOutstandingLiability: BigInt(playerLiabilityAtto) > 0n,
      };
    } catch {
      return {
        blocking: false,
        readable: false,
        playerLiabilityAtto: null,
        hasOutstandingLiability: null,
      };
    }
  }

  async function checkLegacyV6() {
    const addresses = config.legacyV6Contracts;
    if (addresses.length === 0) {
      return {
        blocking: false,
        configured: false,
        readable: true,
        contracts: [],
        knownPlayerLiabilityAtto: '0',
        totalPlayerLiabilityAtto: '0',
        hasOutstandingLiability: false,
      };
    }
    const contracts = await Promise.all(addresses.map(async (address) => {
      try {
        const [rawConfig, rawLiability] = await Promise.all([
          read(address, 'get_config'),
          read(address, 'get_total_player_liability_atto'),
        ]);
        const verified = validateLiquidityArenaV6Config(rawConfig);
        const playerLiabilityAtto = normalizedAtto(
          rawLiability,
          'legacy V6 player liability',
        );
        return {
          address,
          readable: true,
          protocolVersion: verified.protocolVersion,
          playerLiabilityAtto,
        };
      } catch {
        return { address, readable: false };
      }
    }));
    const readable = contracts.every((contract) => contract.readable);
    const total = contracts.reduce(
      (sum, contract) => sum + BigInt(contract.playerLiabilityAtto || '0'),
      0n,
    );
    return {
      blocking: false,
      configured: true,
      readable,
      contracts,
      knownPlayerLiabilityAtto: total.toString(),
      totalPlayerLiabilityAtto: readable ? total.toString() : null,
      hasOutstandingLiability: readable ? total > 0n : null,
    };
  }

  async function run() {
    controller = new AbortController();
    const abortTimer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const [
        genlayerRpc,
        contract,
        keeperCoverage,
        binance,
        activePlayerFunds,
        legacyV6,
      ] = await Promise.all([
        checkRpc(),
        checkActiveContract(),
        checkKeeperCoverage(),
        checkFiveFeeds(),
        checkActivePlayerFunds(),
        checkLegacyV6(),
      ]);
      const ready = genlayerRpc.ready && contract.ready && keeperCoverage.ready && binance.ready;
      return {
        status: ready ? 'ready' : 'degraded',
        service: 'liquidity-arena',
        checks: {
          static: { ready: true },
          genlayerRpc,
          contract,
          keeperCoverage,
          binance,
          activePlayerFunds,
          legacyV6,
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
