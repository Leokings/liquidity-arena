import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const V7_KEEPER_CONFIG_VERSION = 1;
export const V7_NETWORK = 'studionet';
export const V7_PROTOCOL_VERSION = 'LIQUIDITY_ARENA_V7';
export const V7_POLICY_VERSION = 'CRYPTO_SPOT_1M_MEDIAN_V1';

export const V7_HOUR_SECONDS = 3_600;
export const V7_WAGER_OPEN_OFFSET_SECONDS = 2_400;
export const V7_BATTLE_OPEN_OFFSET_SECONDS = 1_200;
export const V7_RESOLUTION_PUBLICATION_DELAY_SECONDS = 120;
export const V7_TIMEOUT_REFUND_DELAY_SECONDS = 86_400;
export const V7_MINIMUM_EPOCH_CREATION_LEAD_SECONDS = 3_600;
export const V7_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS = 26 * V7_HOUR_SECONDS;
export const V7_OWNER_MAX_SCHEDULE_AHEAD_SECONDS = 31 * 24 * V7_HOUR_SECONDS;
export const V7_DEFAULT_PLATFORM_FEE_BPS = 200;
export const V7_MAX_PLATFORM_FEE_BPS = 500;
export const V7_MINIMUM_QUALIFIED_VENUES = 3;
export const V7_VALIDATOR_RETURN_TOLERANCE_PPB = 100_000;
export const V7_PRICE_SCALE = 100_000_000;
export const V7_RETURN_SCALE = 1_000_000_000;
export const V7_ASSET_IDS = Object.freeze(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
export const V7_VENUES = Object.freeze(['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN']);

const CONTRACT_ADDRESS_ENV_TOKEN = '${V7_CONTRACT_ADDRESS}';
const OWNER_ADDRESS_ENV_TOKEN = '${V7_OWNER_ADDRESS}';
const KEEPER_ADDRESS_ENV_TOKEN = '${V7_KEEPER_ADDRESS}';
const TREASURY_ADDRESS_ENV_TOKEN = '${V7_TREASURY_ADDRESS}';
const ROOT_FIELDS = new Set([
  'version', 'network', 'contractAddress', 'expected', 'epochs', 'operator',
]);
const EXPECTED_FIELDS = new Set([
  'protocolVersion', 'policyVersion', 'platformFeeBps',
  'ownerAddress', 'keeperAddress', 'treasuryAddress',
]);
const EPOCH_FIELDS = new Set([
  'futureHours', 'minimumCreationLeadSeconds', 'minStakeGen', 'maxStakePerWalletGen',
]);
const OPERATOR_FIELDS = new Set([
  'pageSize', 'scanIntervalMs', 'readIntervalMs', 'maxEpochReadsPerRun', 'maxWritesPerRun',
  'readAttempts', 'retryBaseMs', 'finalityRetries', 'finalityIntervalMs',
  'finalityWaitAttempts', 'postStateAttempts', 'postStateIntervalMs',
]);

function fail(message) {
  throw new Error(`StudioNet V7 keeper configuration: ${message}`);
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

function nonzeroAddress(value, field) {
  const result = text(value, field);
  if (!/^0x[\da-f]{40}$/i.test(result) || /^0x0{40}$/i.test(result)) {
    fail(`${field} must be a nonzero 20-byte 0x-prefixed address`);
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
  const configured = environment.V7_CONTRACT_ADDRESS;
  if (typeof configured !== 'string' || configured.trim() === '') {
    fail('V7_CONTRACT_ADDRESS is required when contractAddress uses ${V7_CONTRACT_ADDRESS}');
  }
  return configured.trim();
}

function resolveExpectedAddress(rawValue, token, environmentName, environment, field) {
  if (rawValue !== token) return rawValue;
  const configured = environment[environmentName];
  if (typeof configured !== 'string' || configured.trim() === '') {
    fail(`${environmentName} is required when ${field} uses ${token}`);
  }
  return configured.trim();
}

export function normalizeV7KeeperConfig(rawValue, { environment = process.env } = {}) {
  const raw = plainObject(rawValue, 'root');
  rejectUnknownFields(raw, ROOT_FIELDS, 'root');
  const expected = plainObject(raw.expected ?? {}, 'expected');
  const epochs = plainObject(raw.epochs ?? {}, 'epochs');
  const operator = plainObject(raw.operator ?? {}, 'operator');
  rejectUnknownFields(expected, EXPECTED_FIELDS, 'expected');
  rejectUnknownFields(epochs, EPOCH_FIELDS, 'epochs');
  rejectUnknownFields(operator, OPERATOR_FIELDS, 'operator');

  const version = integer(raw.version ?? V7_KEEPER_CONFIG_VERSION, 'version', {
    minimum: V7_KEEPER_CONFIG_VERSION,
    maximum: V7_KEEPER_CONFIG_VERSION,
  });
  const network = text(raw.network ?? V7_NETWORK, 'network').toLowerCase();
  if (network !== V7_NETWORK) fail(`network must be exactly ${V7_NETWORK}`);

  const protocolVersion = text(
    expected.protocolVersion ?? V7_PROTOCOL_VERSION,
    'expected.protocolVersion',
  );
  if (protocolVersion !== V7_PROTOCOL_VERSION) {
    fail(`expected.protocolVersion must be exactly ${V7_PROTOCOL_VERSION}`);
  }
  const policyVersion = text(
    expected.policyVersion ?? V7_POLICY_VERSION,
    'expected.policyVersion',
  );
  if (policyVersion !== V7_POLICY_VERSION) {
    fail(`expected.policyVersion must be exactly ${V7_POLICY_VERSION}`);
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
    { minimum: 7_200, maximum: 30 * 24 * V7_HOUR_SECONDS },
  );
  const futureHours = integer(epochs.futureHours ?? 24, 'epochs.futureHours', {
    minimum: 1,
    maximum: 24,
  });
  if (
    minimumCreationLeadSeconds + futureHours * V7_HOUR_SECONDS
    > V7_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS
  ) {
    fail('epochs lead plus futureHours exceeds the V7 keeper scheduling horizon');
  }
  const normalized = {
    version,
    network,
    contractAddress: nonzeroAddress(
      resolveContractAddress(raw.contractAddress, environment),
      'contractAddress',
    ),
    expected: {
      protocolVersion,
      policyVersion,
      ownerAddress: nonzeroAddress(
        resolveExpectedAddress(
          expected.ownerAddress ?? OWNER_ADDRESS_ENV_TOKEN,
          OWNER_ADDRESS_ENV_TOKEN,
          'V7_OWNER_ADDRESS',
          environment,
          'expected.ownerAddress',
        ),
        'expected.ownerAddress',
      ).toLowerCase(),
      keeperAddress: nonzeroAddress(
        resolveExpectedAddress(
          expected.keeperAddress ?? KEEPER_ADDRESS_ENV_TOKEN,
          KEEPER_ADDRESS_ENV_TOKEN,
          'V7_KEEPER_ADDRESS',
          environment,
          'expected.keeperAddress',
        ),
        'expected.keeperAddress',
      ).toLowerCase(),
      treasuryAddress: nonzeroAddress(
        resolveExpectedAddress(
          expected.treasuryAddress ?? TREASURY_ADDRESS_ENV_TOKEN,
          TREASURY_ADDRESS_ENV_TOKEN,
          'V7_TREASURY_ADDRESS',
          environment,
          'expected.treasuryAddress',
        ),
        'expected.treasuryAddress',
      ).toLowerCase(),
      platformFeeBps: integer(
        expected.platformFeeBps ?? V7_DEFAULT_PLATFORM_FEE_BPS,
        'expected.platformFeeBps',
        { minimum: 0, maximum: V7_MAX_PLATFORM_FEE_BPS },
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
      // Retained for version-1 configuration compatibility. Global read
      // pacing now supersedes page-only scan sleeps.
      scanIntervalMs: integer(operator.scanIntervalMs ?? 25, 'operator.scanIntervalMs', {
        minimum: 0,
        maximum: 5_000,
      }),
      // StudioNet's standard read bucket is 30 requests/minute. Pace every
      // keeper chain read at no more than 24/minute, leaving headroom for
      // finality polling, validator activity, and manual operator checks.
      readIntervalMs: integer(operator.readIntervalMs ?? 3_000, 'operator.readIntervalMs', {
        minimum: 2_500,
        maximum: 60_000,
      }),
      maxEpochReadsPerRun: integer(
        operator.maxEpochReadsPerRun ?? 8,
        'operator.maxEpochReadsPerRun',
        {
          minimum: 1,
          maximum: 24,
        },
      ),
      maxWritesPerRun: integer(operator.maxWritesPerRun ?? 30, 'operator.maxWritesPerRun', {
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
        operator.finalityWaitAttempts ?? 3,
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

export function loadV7KeeperConfig(configPath, options = {}) {
  const absolutePath = resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`unable to read ${absolutePath}: ${error.message}`);
  }
  return normalizeV7KeeperConfig(raw, options);
}

export function firstEligibleEpochEnd(nowEpochSeconds, minimumCreationLeadSeconds = 7_200) {
  const now = integer(nowEpochSeconds, 'nowEpochSeconds', { minimum: 0 });
  const lead = integer(minimumCreationLeadSeconds, 'minimumCreationLeadSeconds', {
    minimum: 0,
  });
  return Math.ceil((now + lead) / V7_HOUR_SECONDS) * V7_HOUR_SECONDS;
}

export function plannedFutureEpochEnds(config, nowEpochSeconds) {
  const first = firstEligibleEpochEnd(
    nowEpochSeconds,
    config.epochs.minimumCreationLeadSeconds,
  );
  return Object.freeze(Array.from(
    { length: config.epochs.futureHours },
    (_unused, index) => first + index * V7_HOUR_SECONDS,
  ));
}

export function expectedEpochRecord(config, epochEndTimestamp) {
  const epochEnd = integer(epochEndTimestamp, 'epochEndTimestamp', { minimum: V7_HOUR_SECONDS });
  if (epochEnd % V7_HOUR_SECONDS !== 0) fail('epochEndTimestamp must be an exact UTC hour');
  return Object.freeze({
    epochEndTimestamp: epochEnd,
    wagerOpensTimestamp: epochEnd - V7_WAGER_OPEN_OFFSET_SECONDS,
    wagerClosesTimestamp: epochEnd - V7_BATTLE_OPEN_OFFSET_SECONDS,
    resolutionAvailableTimestamp: epochEnd + V7_RESOLUTION_PUBLICATION_DELAY_SECONDS,
    timeoutRefundAvailableTimestamp: epochEnd + V7_TIMEOUT_REFUND_DELAY_SECONDS,
    policyVersion: config.expected.policyVersion,
    platformFeeBpsSnapshot: config.expected.platformFeeBps,
    minStakeAtto: config.epochs.minStakeAtto,
    maxStakePerWalletAtto: config.epochs.maxStakePerWalletAtto,
  });
}
