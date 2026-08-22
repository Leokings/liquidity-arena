import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const V8_KEEPER_CONFIG_VERSION = 1;
export const V8_NETWORK = 'testnet-bradbury';
export const V8_CHAIN_ID = 4_221;
export const V8_EVM_RPC_URL = 'https://rpc.testnet-chain.genlayer.com';
export const V8_PROTOCOL_VERSION = 'LIQUIDITY_ARENA_V8';
export const V8_POLICY_VERSION = 'CRYPTO_SPOT_1M_MEDIAN_V1';
export const V8_PAYOUT_PROTOCOL_VERSION = 'IDEMPOTENT_EVM_VAULT_V1';
export const V8_AUDITED_PAYOUT_FACTORY = '0x944fdadd826c2a159c63cb100db174716ccd1317';
export const V8_HOUR_SECONDS = 3_600;
export const V8_WAGER_OPEN_OFFSET_SECONDS = 2_400;
export const V8_BATTLE_OPEN_OFFSET_SECONDS = 1_200;
export const V8_RESOLUTION_PUBLICATION_DELAY_SECONDS = 120;
export const V8_TIMEOUT_REFUND_DELAY_SECONDS = 86_400;
export const V8_MINIMUM_EPOCH_CREATION_LEAD_SECONDS = 3_600;
export const V8_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS = 26 * V8_HOUR_SECONDS;
export const V8_PLATFORM_FEE_BPS = 200;
export const V8_MINIMUM_QUALIFIED_VENUES = 3;
export const V8_VALIDATOR_RETURN_TOLERANCE_PPB = 100_000;
export const V8_PAYOUT_RETRY_DELAY_SECONDS = 3_600;
export const V8_MAX_PAYOUT_ATTEMPTS = 3;
export const V8_ASSET_IDS = Object.freeze(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
export const V8_VENUES = Object.freeze(['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN']);
export const V8_SUPPORTED_OBJECTIVES = Object.freeze(['HIGH', 'LOW']);
export const V8_PUBLIC_METHODS = Object.freeze([
  'activate_payouts', 'activate_timeout_refund', 'claim', 'confirm_payout',
  'create_epoch', 'dispatch_payout', 'enter', 'fund_delivery_reserve',
  'get_claim_quote', 'get_config', 'get_delivery_reserve_state', 'get_epoch',
  'get_epoch_asset', 'get_epoch_page', 'get_objective', 'get_payout',
  'get_payout_page', 'pause_new_risk', 'refresh_payout_withdrawal',
  'request_fee_payout', 'resolve_epoch', 'resume_new_risk', 'retry_payout',
  'retry_prepare_payout', 'set_keeper',
]);

const TOKENS = Object.freeze({
  contractAddress: ['${V8_CONTRACT_ADDRESS}', 'V8_CONTRACT_ADDRESS'],
  ownerAddress: ['${V8_OWNER_ADDRESS}', 'V8_OWNER_ADDRESS'],
  keeperAddress: ['${V8_KEEPER_ADDRESS}', 'V8_KEEPER_ADDRESS'],
  treasuryAddress: ['${V8_TREASURY_ADDRESS}', 'V8_TREASURY_ADDRESS'],
});
const ROOT_FIELDS = new Set(['version', 'network', 'chainId', 'contractAddress', 'expected', 'epochs', 'operator']);
const EXPECTED_FIELDS = new Set([
  'protocolVersion', 'policyVersion', 'payoutProtocolVersion', 'payoutFactoryAddress',
  'ownerAddress', 'keeperAddress', 'treasuryAddress', 'platformFeeBps',
]);
const EPOCH_FIELDS = new Set(['futureHours', 'minimumCreationLeadSeconds', 'minStakeGen', 'maxStakePerWalletGen']);
const OPERATOR_FIELDS = new Set([
  'pageSize', 'maxEpochReadsPerRun', 'maxPayoutReadsPerRun', 'maxWritesPerRun',
  'readAttempts', 'retryBaseMs', 'finalityRetries', 'finalityIntervalMs',
  'postStateAttempts', 'postStateIntervalMs',
]);

function fail(message) {
  throw new Error(`Bradbury V8 keeper configuration: ${message}`);
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${field} has unknown fields: ${unknown.join(', ')}`);
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

function address(value, field) {
  const result = text(value, field).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result) || /^0x0{40}$/.test(result)) fail(`${field} must be a nonzero address`);
  return result;
}

function resolveToken(value, field, environment) {
  const [token, name] = TOKENS[field];
  if (value !== token) return value;
  const configured = environment?.[name];
  if (typeof configured !== 'string' || configured.trim() === '') fail(`${name} is required when ${field} uses ${token}`);
  return configured.trim();
}

export function genDecimalToAtto(value, field = 'GEN amount') {
  const normalized = text(value, field);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    fail(`${field} must be a nonnegative decimal with at most 18 places`);
  }
  const [whole, fraction = ''] = normalized.split('.');
  return (BigInt(whole) * (10n ** 18n) + BigInt((fraction + '0'.repeat(18)).slice(0, 18))).toString();
}

export function normalizeV8KeeperConfig(rawValue, { environment = process.env } = {}) {
  const raw = plainObject(rawValue, 'root');
  rejectUnknown(raw, ROOT_FIELDS, 'root');
  const expected = plainObject(raw.expected ?? {}, 'expected');
  const epochs = plainObject(raw.epochs ?? {}, 'epochs');
  const operator = plainObject(raw.operator ?? {}, 'operator');
  rejectUnknown(expected, EXPECTED_FIELDS, 'expected');
  rejectUnknown(epochs, EPOCH_FIELDS, 'epochs');
  rejectUnknown(operator, OPERATOR_FIELDS, 'operator');

  const version = integer(raw.version ?? 1, 'version', { minimum: 1, maximum: 1 });
  const network = text(raw.network ?? V8_NETWORK, 'network').toLowerCase();
  if (network !== V8_NETWORK) fail(`network must be exactly ${V8_NETWORK}`);
  const chainId = integer(raw.chainId ?? V8_CHAIN_ID, 'chainId', { minimum: V8_CHAIN_ID, maximum: V8_CHAIN_ID });
  const contractAddress = address(resolveToken(raw.contractAddress, 'contractAddress', environment), 'contractAddress');
  const protocolVersion = text(expected.protocolVersion ?? V8_PROTOCOL_VERSION, 'expected.protocolVersion');
  const policyVersion = text(expected.policyVersion ?? V8_POLICY_VERSION, 'expected.policyVersion');
  const payoutProtocolVersion = text(expected.payoutProtocolVersion ?? V8_PAYOUT_PROTOCOL_VERSION, 'expected.payoutProtocolVersion');
  if (protocolVersion !== V8_PROTOCOL_VERSION) fail(`expected.protocolVersion must be ${V8_PROTOCOL_VERSION}`);
  if (policyVersion !== V8_POLICY_VERSION) fail(`expected.policyVersion must be ${V8_POLICY_VERSION}`);
  if (payoutProtocolVersion !== V8_PAYOUT_PROTOCOL_VERSION) fail(`expected.payoutProtocolVersion must be ${V8_PAYOUT_PROTOCOL_VERSION}`);

  const minStakeGen = text(epochs.minStakeGen ?? '0.1', 'epochs.minStakeGen');
  const maxStakePerWalletGen = text(epochs.maxStakePerWalletGen ?? '10', 'epochs.maxStakePerWalletGen');
  const minStakeAtto = genDecimalToAtto(minStakeGen, 'epochs.minStakeGen');
  const maxStakePerWalletAtto = genDecimalToAtto(maxStakePerWalletGen, 'epochs.maxStakePerWalletGen');
  if (BigInt(minStakeAtto) <= 0n || BigInt(maxStakePerWalletAtto) < BigInt(minStakeAtto)) fail('epoch stake bounds are invalid');
  const futureHours = integer(epochs.futureHours ?? 24, 'epochs.futureHours', { minimum: 1, maximum: 24 });
  const minimumCreationLeadSeconds = integer(
    epochs.minimumCreationLeadSeconds ?? 7_200,
    'epochs.minimumCreationLeadSeconds',
    { minimum: V8_MINIMUM_EPOCH_CREATION_LEAD_SECONDS, maximum: 24 * V8_HOUR_SECONDS },
  );
  if (minimumCreationLeadSeconds + futureHours * V8_HOUR_SECONDS > V8_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS) {
    fail('epoch lead plus futureHours exceeds the keeper scheduling horizon');
  }

  const normalized = {
    version,
    network,
    chainId,
    contractAddress,
    expected: {
      protocolVersion,
      policyVersion,
      payoutProtocolVersion,
      payoutFactoryAddress: address(expected.payoutFactoryAddress ?? V8_AUDITED_PAYOUT_FACTORY, 'expected.payoutFactoryAddress'),
      ownerAddress: address(resolveToken(expected.ownerAddress ?? TOKENS.ownerAddress[0], 'ownerAddress', environment), 'expected.ownerAddress'),
      keeperAddress: address(resolveToken(expected.keeperAddress ?? TOKENS.keeperAddress[0], 'keeperAddress', environment), 'expected.keeperAddress'),
      treasuryAddress: address(resolveToken(expected.treasuryAddress ?? TOKENS.treasuryAddress[0], 'treasuryAddress', environment), 'expected.treasuryAddress'),
      platformFeeBps: integer(expected.platformFeeBps ?? V8_PLATFORM_FEE_BPS, 'expected.platformFeeBps', { minimum: V8_PLATFORM_FEE_BPS, maximum: V8_PLATFORM_FEE_BPS }),
    },
    epochs: { futureHours, minimumCreationLeadSeconds, minStakeGen, maxStakePerWalletGen, minStakeAtto, maxStakePerWalletAtto },
    operator: {
      pageSize: integer(operator.pageSize ?? 50, 'operator.pageSize', { minimum: 1, maximum: 50 }),
      maxEpochReadsPerRun: integer(operator.maxEpochReadsPerRun ?? 50, 'operator.maxEpochReadsPerRun', { minimum: 1, maximum: 50 }),
      maxPayoutReadsPerRun: integer(operator.maxPayoutReadsPerRun ?? 500, 'operator.maxPayoutReadsPerRun', { minimum: 1, maximum: 500 }),
      maxWritesPerRun: integer(operator.maxWritesPerRun ?? 30, 'operator.maxWritesPerRun', { minimum: 1, maximum: 50 }),
      readAttempts: integer(operator.readAttempts ?? 3, 'operator.readAttempts', { minimum: 1, maximum: 10 }),
      retryBaseMs: integer(operator.retryBaseMs ?? 500, 'operator.retryBaseMs', { minimum: 0, maximum: 30_000 }),
      finalityRetries: integer(operator.finalityRetries ?? 180, 'operator.finalityRetries', { minimum: 1, maximum: 10_000 }),
      finalityIntervalMs: integer(operator.finalityIntervalMs ?? 5_000, 'operator.finalityIntervalMs', { minimum: 100, maximum: 60_000 }),
      postStateAttempts: integer(operator.postStateAttempts ?? 5, 'operator.postStateAttempts', { minimum: 1, maximum: 20 }),
      postStateIntervalMs: integer(operator.postStateIntervalMs ?? 2_000, 'operator.postStateIntervalMs', { minimum: 0, maximum: 60_000 }),
    },
  };
  if (normalized.expected.payoutFactoryAddress !== V8_AUDITED_PAYOUT_FACTORY) {
    fail(`expected.payoutFactoryAddress must be exactly ${V8_AUDITED_PAYOUT_FACTORY}`);
  }
  return Object.freeze({
    ...normalized,
    expected: Object.freeze(normalized.expected),
    epochs: Object.freeze(normalized.epochs),
    operator: Object.freeze(normalized.operator),
  });
}

export function loadV8KeeperConfig(configPath, options = {}) {
  const absolute = resolve(configPath);
  try {
    return normalizeV8KeeperConfig(JSON.parse(readFileSync(absolute, 'utf8')), options);
  } catch (error) {
    if (String(error?.message || '').startsWith('Bradbury V8 keeper configuration:')) throw error;
    fail(`unable to read ${absolute}: ${error.message}`);
  }
}

export function firstEligibleEpochEnd(nowEpochSeconds, minimumCreationLeadSeconds = 7_200) {
  const now = integer(nowEpochSeconds, 'nowEpochSeconds', { minimum: 0 });
  const lead = integer(minimumCreationLeadSeconds, 'minimumCreationLeadSeconds', { minimum: 0 });
  return Math.ceil((now + lead) / V8_HOUR_SECONDS) * V8_HOUR_SECONDS;
}

export function plannedFutureEpochEnds(config, nowEpochSeconds) {
  const first = firstEligibleEpochEnd(nowEpochSeconds, config.epochs.minimumCreationLeadSeconds);
  return Object.freeze(Array.from({ length: config.epochs.futureHours }, (_, index) => first + index * V8_HOUR_SECONDS));
}

export function expectedEpochRecord(config, epochEndTimestamp) {
  const end = integer(epochEndTimestamp, 'epochEndTimestamp', { minimum: V8_HOUR_SECONDS });
  if (end % V8_HOUR_SECONDS !== 0) fail('epochEndTimestamp must be an exact UTC hour');
  return Object.freeze({
    epochEndTimestamp: end,
    wagerOpensTimestamp: end - V8_WAGER_OPEN_OFFSET_SECONDS,
    wagerClosesTimestamp: end - V8_BATTLE_OPEN_OFFSET_SECONDS,
    resolutionAvailableTimestamp: end + V8_RESOLUTION_PUBLICATION_DELAY_SECONDS,
    timeoutRefundAvailableTimestamp: end + V8_TIMEOUT_REFUND_DELAY_SECONDS,
    policyVersion: config.expected.policyVersion,
    platformFeeBpsSnapshot: config.expected.platformFeeBps,
    minStakeAtto: config.epochs.minStakeAtto,
    maxStakePerWalletAtto: config.epochs.maxStakePerWalletAtto,
  });
}
