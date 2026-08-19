import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const V6_KEEPER_CONFIG_VERSION = 1;
export const V6_NETWORK = 'studionet';
export const V6_PROTOCOL_VERSION = 'LIQUIDITY_ARENA_V6';
export const V6_POLICY_VERSION = 'CRYPTO_SPOT_1M_MEDIAN_V1';

export const V6_HOUR_SECONDS = 3_600;
export const V6_WAGER_OPEN_OFFSET_SECONDS = 2_400;
export const V6_BATTLE_OPEN_OFFSET_SECONDS = 1_200;
export const V6_RESOLUTION_PUBLICATION_DELAY_SECONDS = 120;
export const V6_TIMEOUT_REFUND_DELAY_SECONDS = 86_400;
export const V6_DEFAULT_PLATFORM_FEE_BPS = 200;
export const V6_MAX_PLATFORM_FEE_BPS = 500;
export const V6_MINIMUM_QUALIFIED_VENUES = 3;
export const V6_VALIDATOR_RETURN_TOLERANCE_PPB = 100_000;
export const V6_PRICE_SCALE = 100_000_000;
export const V6_RETURN_SCALE = 1_000_000_000;
export const V6_ASSET_IDS = Object.freeze(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
export const V6_VENUES = Object.freeze(['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN']);

const CONTRACT_ADDRESS_ENV_TOKEN = '${V6_CONTRACT_ADDRESS}';
const ROOT_FIELDS = new Set([
  'version', 'network', 'contractAddress', 'expected', 'epochs', 'operator',
]);
const EXPECTED_FIELDS = new Set(['protocolVersion', 'policyVersion', 'platformFeeBps']);
const EPOCH_FIELDS = new Set([
  'futureHours', 'minimumCreationLeadSeconds', 'minStakeGen', 'maxStakePerWalletGen',
]);
const OPERATOR_FIELDS = new Set([
  'pageSize', 'scanIntervalMs', 'maxWritesPerRun',
  'readAttempts', 'retryBaseMs', 'finalityRetries', 'finalityIntervalMs',
  'finalityWaitAttempts', 'postStateAttempts', 'postStateIntervalMs',
]);

function fail(message) {
  throw new Error(`StudioNet V6 keeper configuration: ${message}`);
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${field} has unknown fields: ${unknown.join(', ')}`);
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} is required`);
  return value.trim();
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function contractAddress(value) {
  const result = text(value, 'contractAddress');
  if (!/^0x[\da-f]{40}$/i.test(result) || /^0x0{40}$/i.test(result)) {
    fail('contractAddress must be a nonzero 20-byte 0x-prefixed address');
  }
  return result;
}

export function genDecimalToAtto(value, field = 'GEN amount') {
  const normalized = text(value, field);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    fail(`${field} must be a nonnegative base-10 GEN amount with at most 18 decimals`);
  }
  const [whole, fraction = ''] = normalized.split('.');
  const atto = BigInt(whole) * (10n ** 18n) + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
  return atto.toString();
}

function resolveContractAddress(rawValue, environment) {
  if (rawValue !== CONTRACT_ADDRESS_ENV_TOKEN) return rawValue;
  const configured = environment.V6_CONTRACT_ADDRESS;
  if (typeof configured !== 'string' || configured.trim() === '') {
    fail('V6_CONTRACT_ADDRESS is required when contractAddress uses ${V6_CONTRACT_ADDRESS}');
  }
  return configured.trim();
}

export function normalizeV6KeeperConfig(rawValue, { environment = process.env } = {}) {
  const raw = plainObject(rawValue, 'root');
  rejectUnknownFields(raw, ROOT_FIELDS, 'root');
  const expected = plainObject(raw.expected ?? {}, 'expected');
  const epochs = plainObject(raw.epochs ?? {}, 'epochs');
  const operator = plainObject(raw.operator ?? {}, 'operator');
  rejectUnknownFields(expected, EXPECTED_FIELDS, 'expected');
  rejectUnknownFields(epochs, EPOCH_FIELDS, 'epochs');
  rejectUnknownFields(operator, OPERATOR_FIELDS, 'operator');

  const version = integer(raw.version ?? V6_KEEPER_CONFIG_VERSION, 'version', {
    minimum: V6_KEEPER_CONFIG_VERSION,
    maximum: V6_KEEPER_CONFIG_VERSION,
  });
  const network = text(raw.network ?? V6_NETWORK, 'network').toLowerCase();
  if (network !== V6_NETWORK) fail(`network must be exactly ${V6_NETWORK}`);

  const protocolVersion = text(
    expected.protocolVersion ?? V6_PROTOCOL_VERSION,
    'expected.protocolVersion',
  );
  if (protocolVersion !== V6_PROTOCOL_VERSION) {
    fail(`expected.protocolVersion must be exactly ${V6_PROTOCOL_VERSION}`);
  }
  const policyVersion = text(
    expected.policyVersion ?? V6_POLICY_VERSION,
    'expected.policyVersion',
  );
  if (policyVersion !== V6_POLICY_VERSION) {
    fail(`expected.policyVersion must be exactly ${V6_POLICY_VERSION}`);
  }

  const minStakeGen = text(epochs.minStakeGen ?? '0.1', 'epochs.minStakeGen');
  const maxStakePerWalletGen = text(
    epochs.maxStakePerWalletGen ?? '10',
    'epochs.maxStakePerWalletGen',
  );
  const minStakeAtto = genDecimalToAtto(minStakeGen, 'epochs.minStakeGen');
  const maxStakePerWalletAtto = genDecimalToAtto(
    maxStakePerWalletGen,
    'epochs.maxStakePerWalletGen',
  );
  if (BigInt(minStakeAtto) <= 0n) fail('epochs.minStakeGen must be positive');
  if (BigInt(maxStakePerWalletAtto) < BigInt(minStakeAtto)) {
    fail('epochs.maxStakePerWalletGen must be at least epochs.minStakeGen');
  }

  const minimumCreationLeadSeconds = integer(
    epochs.minimumCreationLeadSeconds ?? 7_200,
    'epochs.minimumCreationLeadSeconds',
    { minimum: 7_200, maximum: 30 * 24 * V6_HOUR_SECONDS },
  );
  const futureHours = integer(epochs.futureHours ?? 3, 'epochs.futureHours', {
    minimum: 1,
    maximum: 24,
  });
  const normalized = {
    version,
    network,
    contractAddress: contractAddress(resolveContractAddress(raw.contractAddress, environment)),
    expected: {
      protocolVersion,
      policyVersion,
      platformFeeBps: integer(
        expected.platformFeeBps ?? V6_DEFAULT_PLATFORM_FEE_BPS,
        'expected.platformFeeBps',
        { minimum: 0, maximum: V6_MAX_PLATFORM_FEE_BPS },
      ),
    },
    epochs: {
      futureHours,
      minimumCreationLeadSeconds,
      minStakeGen,
      maxStakePerWalletGen,
      minStakeAtto,
      maxStakePerWalletAtto,
    },
    operator: {
      pageSize: integer(operator.pageSize ?? 50, 'operator.pageSize', {
        minimum: 1,
        maximum: 50,
      }),
      scanIntervalMs: integer(operator.scanIntervalMs ?? 25, 'operator.scanIntervalMs', {
        minimum: 0,
        maximum: 5_000,
      }),
      maxWritesPerRun: integer(operator.maxWritesPerRun ?? 12, 'operator.maxWritesPerRun', {
        minimum: futureHours,
        maximum: 50,
      }),
      readAttempts: integer(operator.readAttempts ?? 3, 'operator.readAttempts', {
        minimum: 1,
        maximum: 10,
      }),
      retryBaseMs: integer(operator.retryBaseMs ?? 500, 'operator.retryBaseMs', {
        minimum: 0,
        maximum: 30_000,
      }),
      finalityRetries: integer(operator.finalityRetries ?? 180, 'operator.finalityRetries', {
        minimum: 1,
        maximum: 10_000,
      }),
      finalityIntervalMs: integer(
        operator.finalityIntervalMs ?? 5_000,
        'operator.finalityIntervalMs',
        { minimum: 100, maximum: 60_000 },
      ),
      finalityWaitAttempts: integer(
        operator.finalityWaitAttempts ?? 7,
        'operator.finalityWaitAttempts',
        { minimum: 1, maximum: 10 },
      ),
      postStateAttempts: integer(
        operator.postStateAttempts ?? 5,
        'operator.postStateAttempts',
        { minimum: 1, maximum: 20 },
      ),
      postStateIntervalMs: integer(
        operator.postStateIntervalMs ?? 2_000,
        'operator.postStateIntervalMs',
        { minimum: 0, maximum: 60_000 },
      ),
    },
  };
  return Object.freeze({
    ...normalized,
    expected: Object.freeze(normalized.expected),
    epochs: Object.freeze(normalized.epochs),
    operator: Object.freeze(normalized.operator),
  });
}

export function loadV6KeeperConfig(configPath, options = {}) {
  const absolutePath = resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`unable to read ${absolutePath}: ${error.message}`);
  }
  return normalizeV6KeeperConfig(raw, options);
}

export function firstEligibleEpochEnd(nowEpochSeconds, minimumCreationLeadSeconds = 7_200) {
  const now = integer(nowEpochSeconds, 'nowEpochSeconds', { minimum: 0 });
  const lead = integer(minimumCreationLeadSeconds, 'minimumCreationLeadSeconds', {
    minimum: 0,
  });
  return Math.ceil((now + lead) / V6_HOUR_SECONDS) * V6_HOUR_SECONDS;
}

export function plannedFutureEpochEnds(config, nowEpochSeconds) {
  const first = firstEligibleEpochEnd(
    nowEpochSeconds,
    config.epochs.minimumCreationLeadSeconds,
  );
  return Object.freeze(Array.from(
    { length: config.epochs.futureHours },
    (_unused, index) => first + index * V6_HOUR_SECONDS,
  ));
}

export function expectedEpochRecord(config, epochEndTimestamp) {
  const epochEnd = integer(epochEndTimestamp, 'epochEndTimestamp', { minimum: V6_HOUR_SECONDS });
  if (epochEnd % V6_HOUR_SECONDS !== 0) fail('epochEndTimestamp must be an exact UTC hour');
  return Object.freeze({
    epochEndTimestamp: epochEnd,
    wagerOpensTimestamp: epochEnd - V6_WAGER_OPEN_OFFSET_SECONDS,
    wagerClosesTimestamp: epochEnd - V6_BATTLE_OPEN_OFFSET_SECONDS,
    resolutionAvailableTimestamp: epochEnd + V6_RESOLUTION_PUBLICATION_DELAY_SECONDS,
    timeoutRefundAvailableTimestamp: epochEnd + V6_TIMEOUT_REFUND_DELAY_SECONDS,
    policyVersion: config.expected.policyVersion,
    platformFeeBpsSnapshot: config.expected.platformFeeBps,
    minStakeAtto: config.epochs.minStakeAtto,
    maxStakePerWalletAtto: config.epochs.maxStakePerWalletAtto,
  });
}
