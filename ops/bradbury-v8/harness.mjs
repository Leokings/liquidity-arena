import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  posix as posixPath,
  resolve,
  win32 as win32Path,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import {
  Interface,
  Transaction,
  decodeRlp,
  getBytes,
  hexlify,
  id as ethersId,
  keccak256,
  toUtf8String,
} from 'ethers';
import { abi as genlayerAbi, createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { CalldataAddress } from 'genlayer-js/types';

import { assertFinalizedExecution } from '../../market/genlayer-client.js';
import { createPasswordWritingSpawn } from '../../scripts/genlayer-command.mjs';

export const HARNESS_VERSION = 1;
export const STATE_VERSION = 1;
export const BRADBURY_ALIAS = 'testnet-bradbury';
export const BRADBURY_CHAIN_ID = 4_221;
export const BRADBURY_RPC_URL = 'https://rpc-bradbury.genlayer.com';
export const BRADBURY_CONSENSUS_ADDRESS = '0x0112bf6e83497965a5fdd6dad1e447a6e004271d';
export const BRADBURY_INITIAL_VALIDATORS = 5;
export const BRADBURY_MAX_ROTATIONS = 3;
export const V8_PROTOCOL_VERSION = 'LIQUIDITY_ARENA_V8';
export const V8_POLICY_VERSION = 'CRYPTO_SPOT_1M_MEDIAN_V1';
export const PAYOUT_PROTOCOL_VERSION = 'IDEMPOTENT_EVM_VAULT_V1';
export const BIND_REQUEST_SCHEMA = 'liquidity-arena-bradbury-bind-request-v1';
export const ACTIVATION_TERMINAL_STAGE = 'PAYOUTS_ACTIVE_RISK_PAUSED';
export const MAX_TRANSACTION_GAS_COST_ATTO = 30_000_000_000_000_000n;
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
export const SOURCE_PATH = 'contracts/LiquidityArenaV8.py';
export const MAX_OUTPUT_BYTES = 64 * 1024;

const ADDRESS_PATTERN = /^0x[\da-f]{40}$/i;
const HASH_PATTERN = /^0x[\da-f]{64}$/i;
const SHA256_PATTERN = /^[\da-f]{64}$/i;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;
const SOURCE_ANCHOR_PATTERN = /^AUDITED_PAYOUT_FACTORY_4221 = ["'](0x[\da-f]{40})["']\s*$/gmi;
const SUPPORTED_CHAIN_PATTERN = /^SUPPORTED_ESCROW_CHAIN_IDS = \(4_221,\)\s*$/m;
export const NEW_TRANSACTION_TOPIC = ethersId(
  'NewTransaction(bytes32,address,address)',
).toLowerCase();
export const CREATED_TRANSACTION_TOPIC = ethersId(
  'CreatedTransaction(bytes32,uint256)',
).toLowerCase();
const ADD_TRANSACTION_V6_INTERFACE = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);
const PAYOUT_FACTORY_INTERFACE = new Interface([
  'function binder() view returns (address)',
  'function reserveSink() view returns (address)',
  'function arena() view returns (address)',
  'function protocol_version() view returns (string)',
  'function bind_arena(address arenaGhost)',
  'event ArenaBound(address indexed arena)',
]);
const ARENA_BOUND_TOPIC = ethersId('ArenaBound(address)').toLowerCase();

const ROOT_FIELDS = new Set([
  'version', 'network', 'chainId', 'sourcePath', 'sourceSha256',
  'schemaSha256', 'ownerAccountName', 'expected', 'reserve', 'operator',
]);
const EXPECTED_FIELDS = new Set([
  'ownerAddress', 'keeperAddress', 'treasuryAddress', 'payoutFactoryAddress',
  'factoryBinderAddress', 'reserveSinkAddress', 'factoryRuntimeBytecodeSha256',
  'protocolVersion', 'policyVersion', 'payoutProtocolVersion',
  'epochMinStakeAtto', 'epochMaxStakePerWalletAtto', 'platformFeeBps',
]);
const RESERVE_FIELDS = new Set(['initialFundingAtto']);
const OPERATOR_FIELDS = new Set([
  'finalityRetries', 'finalityIntervalMs', 'maxEvmGasLimit', 'maxEvmGasPriceWei',
]);
const BIND_PROOF_FIELDS = new Set([
  'version', 'network', 'chainId', 'factoryAddress', 'arenaAddress',
  'binderAddress', 'reserveSinkAddress', 'protocolVersion',
  'factoryRuntimeBytecodeSha256', 'bindTransactionHash', 'bindReceiptStatus',
  'bindExecutionSuccess', 'boundArenaReadback', 'verifiedAt',
]);
const BIND_REQUEST_FIELDS = new Set([
  'schema', 'version', 'network', 'chainId', 'configFingerprint', 'sourcePath',
  'sourceSha256', 'schemaSha256', 'deploymentGenLayerTransactionHash',
  'deploymentEvmTransactionHash', 'deploymentEvmReceiptBlockHash',
  'deploymentEvmReceiptBlockNumber', 'deploymentGenLayerReceiptStatus',
  'deploymentGenLayerExecutionResult', 'deploymentGenLayerExecutionSuccess',
  'deploymentEvmFinalityVerified', 'deploymentEvmFinalityRequiredBeforeBind', 'leaderOnly',
  'arenaAddress', 'ownerAddress', 'constructorArguments', 'factoryAddress',
  'binderAddress', 'reserveSinkAddress', 'v8ProtocolVersion',
  'payoutProtocolVersion', 'factoryRuntimeBytecodeSha256',
  'exactDeploymentReadback', 'cutsOverApplication', 'cutsOverDatabase', 'verifiedAt',
]);
const BIND_REQUEST_CONSTRUCTOR_FIELDS = new Set([
  'treasuryAddress', 'keeperAddress', 'epochMinStakeAtto',
  'epochMaxStakePerWalletAtto', 'payoutFactoryAddress',
]);

function schemaMethod(params = [], readonly = false, payable = false, ret = 'null') {
  const result = { params, kwparams: {}, readonly, ret };
  if (!readonly) result.payable = payable;
  return result;
}

// This is deliberately exhaustive. A deployed method being added, removed, or
// changed is a release failure, even if get_config still looks familiar.
export const EXPECTED_V8_SCHEMA = Object.freeze({
  ctor: {
    params: [
      ['treasury', 'address'],
      ['keeper', 'address'],
      ['epoch_min_stake_atto', 'int'],
      ['epoch_max_stake_per_wallet_atto', 'int'],
      ['payout_vault_factory', 'address'],
    ],
    kwparams: {},
  },
  methods: {
    accept_ownership: schemaMethod(),
    activate_payouts: schemaMethod(),
    activate_timeout_refund: schemaMethod([['epoch_end_timestamp', 'int']]),
    cancel_ownership_transfer: schemaMethod(),
    claim: schemaMethod([['epoch_end_timestamp', 'int'], ['objective', 'string']]),
    confirm_payout: schemaMethod([['payout_id', 'string']]),
    create_epoch: schemaMethod([['epoch_end_timestamp', 'int']]),
    dispatch_payout: schemaMethod([['payout_id', 'string']]),
    enter: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'], ['asset_id', 'string'],
    ], false, true),
    fund_delivery_reserve: schemaMethod([], false, true),
    get_asset_catalog: schemaMethod([], true, false, 'dict'),
    get_claim_quote: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'], ['account', 'address'],
    ], true, false, 'dict'),
    get_config: schemaMethod([], true, false, 'dict'),
    get_delivery_reserve_state: schemaMethod([], true, false, 'dict'),
    get_entry: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'], ['account', 'address'],
    ], true, false, 'dict'),
    get_epoch: schemaMethod([['epoch_end_timestamp', 'int']], true, false, 'dict'),
    get_epoch_asset: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['asset_id', 'string'],
    ], true, false, 'dict'),
    get_epoch_count: schemaMethod([], true, false, 'int'),
    get_epoch_id: schemaMethod([['index', 'int']], true, false, 'string'),
    get_epoch_page: schemaMethod([
      ['offset', 'int'], ['limit', 'int'],
    ], true, false, 'dict'),
    get_fee_state: schemaMethod([], true, false, 'dict'),
    get_objective: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'],
    ], true, false, 'dict'),
    get_open_epoch_count: schemaMethod([], true, false, 'int'),
    get_open_epoch_page: schemaMethod([
      ['offset', 'int'], ['limit', 'int'],
    ], true, false, 'dict'),
    get_payout: schemaMethod([['payout_id', 'string']], true, false, 'dict'),
    get_payout_count: schemaMethod([], true, false, 'int'),
    get_payout_for_position: schemaMethod([
      ['epoch_end_timestamp', 'int'], ['objective', 'string'], ['account', 'address'],
    ], true, false, 'dict'),
    get_payout_page: schemaMethod([
      ['offset', 'int'], ['limit', 'int'],
    ], true, false, 'dict'),
    get_total_player_liability_atto: schemaMethod([], true, false, 'int'),
    get_venue_catalog: schemaMethod([], true, false, 'dict'),
    get_wallet_position: schemaMethod([
      ['account', 'address'], ['index', 'int'],
    ], true, false, 'dict'),
    get_wallet_position_count: schemaMethod([
      ['account', 'address'],
    ], true, false, 'int'),
    get_wallet_position_page: schemaMethod([
      ['account', 'address'], ['offset', 'int'], ['limit', 'int'],
    ], true, false, 'dict'),
    pause_new_risk: schemaMethod(),
    propose_ownership: schemaMethod([['proposed_owner', 'address']]),
    refresh_payout_withdrawal: schemaMethod([['payout_id', 'string']]),
    request_fee_payout: schemaMethod([['amount_atto', 'int']]),
    resolve_epoch: schemaMethod([['epoch_end_timestamp', 'int']]),
    resume_new_risk: schemaMethod(),
    retry_payout: schemaMethod([['payout_id', 'string']]),
    retry_prepare_payout: schemaMethod([['payout_id', 'string']]),
    set_keeper: schemaMethod([['keeper', 'address']]),
    set_platform_fee_bps: schemaMethod([['fee_bps', 'int']]),
  },
});

function fail(message) {
  throw new Error(`Bradbury V8 harness refused: ${message}`);
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value;
}

function decodedRecord(value, field) {
  if (value instanceof Map) {
    const result = {};
    for (const [key, item] of value.entries()) {
      if (typeof key !== 'string' || Object.hasOwn(result, key)) {
        fail(`${field} contains an invalid decoded map key`);
      }
      result[key] = item;
    }
    return result;
  }
  return plainObject(value, field);
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${field} has unknown fields: ${unknown.join(', ')}`);
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} is required`);
  return value.trim();
}

export async function resolveKeychainSecretWithFallback(keychainRead, fallbackRead) {
  if (typeof keychainRead !== 'function' || typeof fallbackRead !== 'function') {
    fail('keychain and encrypted-keystore readers must be functions');
  }
  try {
    const value = await keychainRead();
    if (typeof value === 'string' && value !== '') return value;
  } catch {
    // Headless Linux commonly has no usable Secret Service backend. Its error
    // text can include environment details and is never surfaced. Continue to
    // the reviewed encrypted-keystore/stdin path instead.
  }
  return fallbackRead();
}

function exactAddress(value, field) {
  const address = requiredText(value, field).toLowerCase();
  if (!ADDRESS_PATTERN.test(address) || address === ZERO_ADDRESS) {
    fail(`${field} must be a nonzero 20-byte 0x-prefixed address`);
  }
  return address;
}

function exactHash(value, field) {
  const hash = requiredText(value, field).toLowerCase();
  if (!HASH_PATTERN.test(hash)) fail(`${field} must be a 32-byte 0x-prefixed hash`);
  return hash;
}

function exactSha256(value, field) {
  const hash = requiredText(value, field).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) fail(`${field} must be a 64-character SHA-256`);
  return hash;
}

function exactDecimal(value, field, { positive = false, maximum } = {}) {
  const decimal = requiredText(value, field);
  if (!DECIMAL_PATTERN.test(decimal)) fail(`${field} must be a canonical base-10 integer string`);
  const number = BigInt(decimal);
  if (positive && number <= 0n) fail(`${field} must be positive`);
  if (maximum !== undefined && number > maximum) fail(`${field} exceeds its safety maximum`);
  return number.toString();
}

function exactInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const EXPECTED_V8_SCHEMA_SHA256 = sha256(stableStringify(EXPECTED_V8_SCHEMA));

export function normalizeConfig(rawValue) {
  const raw = plainObject(rawValue, 'config');
  rejectUnknownFields(raw, ROOT_FIELDS, 'config');
  const expected = plainObject(raw.expected, 'expected');
  const reserve = plainObject(raw.reserve, 'reserve');
  const operator = plainObject(raw.operator ?? {}, 'operator');
  rejectUnknownFields(expected, EXPECTED_FIELDS, 'expected');
  rejectUnknownFields(reserve, RESERVE_FIELDS, 'reserve');
  rejectUnknownFields(operator, OPERATOR_FIELDS, 'operator');

  const version = exactInteger(raw.version, 'version', HARNESS_VERSION, HARNESS_VERSION);
  const network = requiredText(raw.network, 'network').toLowerCase();
  if (network !== BRADBURY_ALIAS) fail(`network must be exactly ${BRADBURY_ALIAS}`);
  const chainId = exactInteger(raw.chainId, 'chainId', BRADBURY_CHAIN_ID, BRADBURY_CHAIN_ID);
  const sourcePath = requiredText(raw.sourcePath, 'sourcePath').replaceAll('\\', '/');
  if (sourcePath !== SOURCE_PATH) fail(`sourcePath must be exactly ${SOURCE_PATH}`);
  const sourceSha256 = exactSha256(raw.sourceSha256, 'sourceSha256');
  const schemaSha256 = exactSha256(raw.schemaSha256, 'schemaSha256');
  if (schemaSha256 !== EXPECTED_V8_SCHEMA_SHA256) {
    fail(`schemaSha256 is not the exhaustive V8 schema hash ${EXPECTED_V8_SCHEMA_SHA256}`);
  }

  const protocolVersion = requiredText(expected.protocolVersion, 'expected.protocolVersion');
  if (protocolVersion !== V8_PROTOCOL_VERSION) {
    fail(`expected.protocolVersion must be exactly ${V8_PROTOCOL_VERSION}`);
  }
  const policyVersion = requiredText(expected.policyVersion, 'expected.policyVersion');
  if (policyVersion !== V8_POLICY_VERSION) {
    fail(`expected.policyVersion must be exactly ${V8_POLICY_VERSION}`);
  }
  const payoutProtocolVersion = requiredText(
    expected.payoutProtocolVersion,
    'expected.payoutProtocolVersion',
  );
  if (payoutProtocolVersion !== PAYOUT_PROTOCOL_VERSION) {
    fail(`expected.payoutProtocolVersion must be exactly ${PAYOUT_PROTOCOL_VERSION}`);
  }

  const epochMinStakeAtto = exactDecimal(
    expected.epochMinStakeAtto,
    'expected.epochMinStakeAtto',
    { positive: true, maximum: 10n ** 36n },
  );
  const epochMaxStakePerWalletAtto = exactDecimal(
    expected.epochMaxStakePerWalletAtto,
    'expected.epochMaxStakePerWalletAtto',
    { positive: true, maximum: 10n ** 36n },
  );
  if (BigInt(epochMaxStakePerWalletAtto) < BigInt(epochMinStakeAtto)) {
    fail('expected.epochMaxStakePerWalletAtto must be at least expected.epochMinStakeAtto');
  }
  const platformFeeBps = exactInteger(
    expected.platformFeeBps,
    'expected.platformFeeBps',
    200,
    200,
  );
  const initialFundingAtto = exactDecimal(
    reserve.initialFundingAtto,
    'reserve.initialFundingAtto',
    { positive: true, maximum: 10n ** 36n },
  );
  const maxEvmGasLimit = exactDecimal(
    operator.maxEvmGasLimit,
    'operator.maxEvmGasLimit',
    { positive: true, maximum: 100_000_000n },
  );
  const maxEvmGasPriceWei = exactDecimal(
    operator.maxEvmGasPriceWei,
    'operator.maxEvmGasPriceWei',
    { positive: true, maximum: 1_000_000_000_000_000n },
  );
  if (BigInt(maxEvmGasLimit) * BigInt(maxEvmGasPriceWei)
      > MAX_TRANSACTION_GAS_COST_ATTO) {
    fail('configured EVM gas-limit/price product exceeds the hard 0.03 GEN transaction ceiling');
  }

  const normalized = {
    version,
    network,
    chainId,
    sourcePath,
    sourceSha256,
    schemaSha256,
    ownerAccountName: requiredText(raw.ownerAccountName, 'ownerAccountName'),
    expected: {
      ownerAddress: exactAddress(expected.ownerAddress, 'expected.ownerAddress'),
      keeperAddress: exactAddress(expected.keeperAddress, 'expected.keeperAddress'),
      treasuryAddress: exactAddress(expected.treasuryAddress, 'expected.treasuryAddress'),
      payoutFactoryAddress: exactAddress(
        expected.payoutFactoryAddress,
        'expected.payoutFactoryAddress',
      ),
      factoryBinderAddress: exactAddress(
        expected.factoryBinderAddress,
        'expected.factoryBinderAddress',
      ),
      reserveSinkAddress: exactAddress(expected.reserveSinkAddress, 'expected.reserveSinkAddress'),
      factoryRuntimeBytecodeSha256: exactSha256(
        expected.factoryRuntimeBytecodeSha256,
        'expected.factoryRuntimeBytecodeSha256',
      ),
      protocolVersion,
      policyVersion,
      payoutProtocolVersion,
      epochMinStakeAtto,
      epochMaxStakePerWalletAtto,
      platformFeeBps,
    },
    reserve: { initialFundingAtto },
    operator: {
      finalityRetries: exactInteger(
        operator.finalityRetries ?? 900,
        'operator.finalityRetries',
        1,
        10_000,
      ),
      finalityIntervalMs: exactInteger(
        operator.finalityIntervalMs ?? 5_000,
        'operator.finalityIntervalMs',
        100,
        60_000,
      ),
      maxEvmGasLimit,
      maxEvmGasPriceWei,
    },
  };
  if (normalized.expected.ownerAddress !== normalized.expected.factoryBinderAddress) {
    fail('expected.ownerAddress and expected.factoryBinderAddress must be the same reviewed EOA');
  }
  const fingerprint = sha256(stableStringify(normalized));
  return Object.freeze({
    ...normalized,
    expected: Object.freeze(normalized.expected),
    reserve: Object.freeze(normalized.reserve),
    operator: Object.freeze(normalized.operator),
    fingerprint,
  });
}

export function loadConfig(configPath) {
  const absolutePath = resolve(requiredText(configPath, '--config'));
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`unable to read config ${absolutePath}: ${error.message}`);
  }
  return Object.freeze({ config: normalizeConfig(raw), absolutePath });
}

export function verifyLocalCandidate(config, { projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..') } = {}) {
  const sourcePath = resolve(projectRoot, config.sourcePath);
  const expectedRoot = resolve(projectRoot);
  if (!sourcePath.startsWith(`${expectedRoot}\\`) && sourcePath !== expectedRoot
    && !sourcePath.startsWith(`${expectedRoot}/`)) {
    fail('sourcePath escaped the project root');
  }
  const source = readFileSync(sourcePath, 'utf8');
  if (source.charCodeAt(0) === 0xfeff) fail('V8 source must not contain a UTF-8 BOM');
  const sourceHash = sha256(source);
  if (sourceHash !== config.sourceSha256) {
    fail(`local V8 source hash is ${sourceHash}, not configured ${config.sourceSha256}`);
  }
  const anchors = [...source.matchAll(SOURCE_ANCHOR_PATTERN)].map((match) => match[1].toLowerCase());
  if (anchors.length !== 1 || anchors[0] !== config.expected.payoutFactoryAddress) {
    fail(
      'V8 source must freeze exactly one literal AUDITED_PAYOUT_FACTORY_4221 equal to '
      + 'expected.payoutFactoryAddress; the zero-address release candidate cannot be broadcast',
    );
  }
  if (!SUPPORTED_CHAIN_PATTERN.test(source)) {
    fail('V8 source does not contain the exact Bradbury-only chain allowlist');
  }
  return Object.freeze({ source, sourcePath, sourceHash });
}

function networkPreflight() {
  const rpc = testnetBradbury?.rpcUrls?.default?.http?.[0];
  const consensusAddress = testnetBradbury?.consensusMainContract?.address?.toLowerCase();
  if (testnetBradbury?.id !== BRADBURY_CHAIN_ID
    || testnetBradbury?.name !== 'Genlayer Bradbury Testnet'
    || rpc !== BRADBURY_RPC_URL
    || consensusAddress !== BRADBURY_CONSENSUS_ADDRESS
    || testnetBradbury?.defaultNumberOfInitialValidators !== BRADBURY_INITIAL_VALIDATORS
    || testnetBradbury?.defaultConsensusMaxRotations !== BRADBURY_MAX_ROTATIONS
    || testnetBradbury?.isStudio !== false
    || testnetBradbury?.testnet !== true) {
    fail('pinned genlayer-js Bradbury chain definition is not exact');
  }
  return Object.freeze({ alias: BRADBURY_ALIAS, chainId: BRADBURY_CHAIN_ID, rpc });
}

export function createBradburyReader({ client } = {}) {
  const network = networkPreflight();
  const readClient = client ?? createClient({ chain: testnetBradbury });
  return Object.freeze({
    network,
    client: readClient,
    schemaForCode: (source) => readClient.getContractSchemaForCode(source),
    code: (address) => readClient.getContractCode(address),
    schema: (address) => readClient.getContractSchema(address),
    call: (address, method, args = []) => readClient.readContract({
      address,
      functionName: method,
      args,
    }),
    waitFinalized: (hash, operator) => readClient.waitForTransactionReceipt({
      hash,
      status: 'FINALIZED',
      retries: operator.finalityRetries,
      interval: operator.finalityIntervalMs,
    }),
    transaction: (hash) => readClient.getTransaction({ hash }),
    evmReceipt: (hash) => readClient.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    }),
    sendSignedEvmTransaction: (signedEvmTransaction) => readClient.sendRawTransaction({
      serializedTransaction: signedEvmTransaction,
    }),
    evmRequest: (method, params) => readClient.request({ method, params }),
  });
}

function normalizedAddressLike(value, field) {
  let text = value instanceof CalldataAddress
    ? hexlify(value.bytes).toLowerCase()
    : String(value ?? '').trim().toLowerCase();
  if (text.startsWith('addr#')) text = `0x${text.slice(5)}`;
  if (!ADDRESS_PATTERN.test(text)) fail(`${field} is not an address`);
  return text;
}

function normalizedDecimalLike(value, field) {
  const text = String(value ?? '').trim().replace(/n$/, '');
  if (!DECIMAL_PATTERN.test(text)) fail(`${field} is not a canonical nonnegative integer`);
  return BigInt(text).toString();
}

function exactObject(actual, expected, field) {
  const left = stableStringify(actual);
  const right = stableStringify(expected);
  if (left !== right) fail(`${field} did not exactly match the reviewed V8 value`);
}

export function assertExactSchema(schema) {
  exactObject(schema, EXPECTED_V8_SCHEMA, 'schema readback');
  return schema;
}

function normalizeConfigReadback(value) {
  const raw = plainObject(value, 'get_config readback');
  const addresses = new Set(['owner', 'pending_owner', 'keeper', 'treasury', 'payout_vault_factory']);
  const integers = new Set([
    'max_payout_attempts', 'payout_retry_delay_seconds', 'native_token_decimals',
    'current_platform_fee_bps', 'default_platform_fee_bps', 'max_platform_fee_bps',
    'epoch_min_stake_atto', 'epoch_max_stake_per_wallet_atto',
    'minimum_epoch_creation_lead_seconds', 'keeper_max_schedule_ahead_seconds',
    'owner_max_schedule_ahead_seconds', 'wager_open_offset_seconds',
    'battle_open_offset_seconds', 'resolution_publication_delay_seconds',
    'timeout_refund_delay_seconds', 'minimum_qualified_venues',
    'validator_return_tolerance_ppb', 'price_scale', 'return_scale',
  ]);
  const normalized = {};
  for (const [key, item] of Object.entries(raw)) {
    if (addresses.has(key)) normalized[key] = normalizedAddressLike(item, `get_config.${key}`);
    else if (integers.has(key)) normalized[key] = normalizedDecimalLike(item, `get_config.${key}`);
    else normalized[key] = item;
  }
  return normalized;
}

export function buildExpectedConfigReadback(config, { payoutsEnabled, newRiskEnabled }) {
  return {
    protocol_version: config.expected.protocolVersion,
    policy_version: config.expected.policyVersion,
    owner: config.expected.ownerAddress,
    pending_owner: ZERO_ADDRESS,
    keeper: config.expected.keeperAddress,
    treasury: config.expected.treasuryAddress,
    payout_vault_factory: config.expected.payoutFactoryAddress,
    payout_protocol_version: config.expected.payoutProtocolVersion,
    payouts_enabled: payoutsEnabled,
    new_risk_enabled: newRiskEnabled,
    max_payout_attempts: '3',
    prepare_retries_capped: false,
    payout_retry_delay_seconds: '3600',
    native_token_symbol: 'GEN',
    native_token_decimals: '18',
    current_platform_fee_bps: String(config.expected.platformFeeBps),
    default_platform_fee_bps: '200',
    max_platform_fee_bps: '500',
    epoch_min_stake_atto: config.expected.epochMinStakeAtto,
    epoch_max_stake_per_wallet_atto: config.expected.epochMaxStakePerWalletAtto,
    minimum_epoch_creation_lead_seconds: '3600',
    keeper_max_schedule_ahead_seconds: '93600',
    owner_max_schedule_ahead_seconds: '2678400',
    wager_open_offset_seconds: '2400',
    battle_open_offset_seconds: '1200',
    resolution_publication_delay_seconds: '120',
    timeout_refund_delay_seconds: '86400',
    minimum_qualified_venues: '3',
    validator_return_tolerance_ppb: '100000',
    price_scale: '100000000',
    return_scale: '1000000000',
    four_venue_median_policy: 'FLOOR_AVERAGE_OF_MIDDLE_TWO',
    rounding_policy: 'LAST_WINNING_CLAIMANT_RECEIVES_REMAINDER',
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
    payout_finality: 'FUNDED_IN_ESCROW',
    claimed_semantics: 'EOA_WITHDRAWN',
  };
}

export function assertExactConfigReadback(value, config, stateFlags) {
  const normalized = normalizeConfigReadback(value);
  exactObject(normalized, buildExpectedConfigReadback(config, stateFlags), 'get_config readback');
  return normalized;
}

function normalizeReserveReadback(value) {
  const raw = plainObject(value, 'get_delivery_reserve_state readback');
  const integerFields = new Set([
    'available_reserve_atto', 'committed_reserve_atto', 'required_available_reserve_atto',
    'reserved_player_payouts_atto', 'reserved_platform_fees_atto',
    'max_payout_attempts', 'retry_delay_seconds',
  ]);
  const normalized = {};
  for (const [key, item] of Object.entries(raw)) {
    normalized[key] = integerFields.has(key)
      ? normalizedDecimalLike(item, `reserve.${key}`)
      : item;
  }
  return normalized;
}

export function assertExactReserveReadback(value, config, {
  payoutsEnabled,
  newRiskEnabled,
  availableReserveAtto,
}) {
  const normalized = normalizeReserveReadback(value);
  exactObject(normalized, buildExpectedReserveReadback(config, {
    payoutsEnabled,
    newRiskEnabled,
    availableReserveAtto,
  }), 'get_delivery_reserve_state readback');
  return normalized;
}

export function buildExpectedReserveReadback(config, {
  payoutsEnabled,
  newRiskEnabled,
  availableReserveAtto,
}) {
  return {
    payout_protocol_version: config.expected.payoutProtocolVersion,
    payouts_enabled: payoutsEnabled,
    new_risk_enabled: newRiskEnabled,
    available_reserve_atto: String(availableReserveAtto),
    committed_reserve_atto: '0',
    required_available_reserve_atto: '0',
    reserved_player_payouts_atto: '0',
    reserved_platform_fees_atto: '0',
    max_payout_attempts: '3',
    prepare_retries_capped: false,
    retry_delay_seconds: '3600',
  };
}

function normalizeFeeReadback(value) {
  const raw = plainObject(value, 'get_fee_state readback');
  const normalized = {};
  for (const [key, item] of Object.entries(raw)) {
    normalized[key] = key === 'treasury'
      ? normalizedAddressLike(item, 'get_fee_state.treasury')
      : normalizedDecimalLike(item, `get_fee_state.${key}`);
  }
  return normalized;
}

export function assertPristineAccounting({ feeState, epochCount, openEpochCount, payoutCount, liability }, config) {
  exactObject(normalizeFeeReadback(feeState), {
    treasury: config.expected.treasuryAddress,
    current_platform_fee_bps: '200',
    accrued_platform_fees_atto: '0',
    reserved_platform_fees_atto: '0',
    funded_platform_fees_atto: '0',
    withdrawn_platform_fees_atto: '0',
    player_liability_atto: '0',
    reserved_player_payouts_atto: '0',
  }, 'get_fee_state readback');
  for (const [field, value] of Object.entries({ epochCount, openEpochCount, payoutCount, liability })) {
    if (normalizedDecimalLike(value, field) !== '0') fail(`${field} must remain zero in the canary`);
  }
}

export async function readAndVerifyDeployment(reader, contractAddress, local, config, expectedState) {
  const address = exactAddress(contractAddress, 'contractAddress');
  const [code, schema, configReadback, reserveReadback, feeState,
    epochCount, openEpochCount, payoutCount, liability] = await Promise.all([
    reader.code(address),
    reader.schema(address),
    reader.call(address, 'get_config'),
    reader.call(address, 'get_delivery_reserve_state'),
    reader.call(address, 'get_fee_state'),
    reader.call(address, 'get_epoch_count'),
    reader.call(address, 'get_open_epoch_count'),
    reader.call(address, 'get_payout_count'),
    reader.call(address, 'get_total_player_liability_atto'),
  ]);
  if (code !== local.source) fail('deployed code is not byte-for-byte identical to local reviewed V8 source');
  if (sha256(code) !== config.sourceSha256) fail('deployed code hash does not match sourceSha256');
  assertExactSchema(schema);
  assertExactConfigReadback(configReadback, config, expectedState);
  assertExactReserveReadback(reserveReadback, config, expectedState);
  assertPristineAccounting({
    feeState, epochCount, openEpochCount, payoutCount, liability,
  }, config);
  return Object.freeze({ address, config: configReadback, reserve: reserveReadback });
}

export function assertLiveAccountingIdentity({
  reserveReadback,
  feeState,
  epochCount,
  openEpochCount,
  payoutCount,
  liability,
}, config, { newRiskEnabled }) {
  const reserve = normalizeReserveReadback(reserveReadback);
  const fee = normalizeFeeReadback(feeState);
  const expectedReserveKeys = Object.keys(buildExpectedReserveReadback(config, {
    payoutsEnabled: true,
    newRiskEnabled,
    availableReserveAtto: '0',
  })).sort();
  const expectedFeeKeys = [
    'treasury', 'current_platform_fee_bps', 'accrued_platform_fees_atto',
    'reserved_platform_fees_atto', 'funded_platform_fees_atto',
    'withdrawn_platform_fees_atto', 'player_liability_atto',
    'reserved_player_payouts_atto',
  ].sort();
  exactObject(Object.keys(reserve).sort(), expectedReserveKeys, 'live reserve field identity');
  exactObject(Object.keys(fee).sort(), expectedFeeKeys, 'live fee field identity');
  exactObject({
    payout_protocol_version: reserve.payout_protocol_version,
    payouts_enabled: reserve.payouts_enabled,
    new_risk_enabled: reserve.new_risk_enabled,
    max_payout_attempts: reserve.max_payout_attempts,
    prepare_retries_capped: reserve.prepare_retries_capped,
    retry_delay_seconds: reserve.retry_delay_seconds,
  }, {
    payout_protocol_version: config.expected.payoutProtocolVersion,
    payouts_enabled: true,
    new_risk_enabled: newRiskEnabled,
    max_payout_attempts: '3',
    prepare_retries_capped: false,
    retry_delay_seconds: '3600',
  }, 'live reserve policy identity');
  if (fee.treasury !== config.expected.treasuryAddress
    || fee.current_platform_fee_bps !== String(config.expected.platformFeeBps)) {
    fail('live fee role or fee policy differs from the reviewed V8 configuration');
  }

  const exactEpochCount = normalizedDecimalLike(epochCount, 'live epochCount');
  const exactOpenEpochCount = normalizedDecimalLike(openEpochCount, 'live openEpochCount');
  const exactPayoutCount = normalizedDecimalLike(payoutCount, 'live payoutCount');
  const exactLiability = normalizedDecimalLike(liability, 'live liability');
  if (BigInt(exactOpenEpochCount) > BigInt(exactEpochCount)) {
    fail('live open epoch count exceeds total epoch count');
  }
  if (fee.player_liability_atto !== exactLiability
    || reserve.reserved_player_payouts_atto !== fee.reserved_player_payouts_atto
    || reserve.reserved_platform_fees_atto !== fee.reserved_platform_fees_atto) {
    fail('live accounting aliases disagree across reserve, fee, and liability readbacks');
  }
  const playerLiability = BigInt(exactLiability);
  const reservedPlayer = BigInt(fee.reserved_player_payouts_atto);
  if (reservedPlayer > playerLiability) {
    fail('live reserved player payouts exceed total player liability');
  }
  const accruedFees = BigInt(fee.accrued_platform_fees_atto);
  const requiredAvailable = (playerLiability - reservedPlayer + accruedFees) * 3n;
  if (BigInt(reserve.required_available_reserve_atto) !== requiredAvailable) {
    fail('live required reserve does not match the exact bounded-attempt accounting identity');
  }
  if (BigInt(reserve.available_reserve_atto) < requiredAvailable) {
    fail('live available reserve is below its exact required accounting identity');
  }
  if (BigInt(fee.withdrawn_platform_fees_atto)
      > BigInt(fee.funded_platform_fees_atto)) {
    fail('live withdrawn platform fees exceed funded platform fees');
  }
  const identity = Object.freeze({
    reserve: Object.freeze(reserve),
    fee: Object.freeze(fee),
    epochCount: exactEpochCount,
    openEpochCount: exactOpenEpochCount,
    payoutCount: exactPayoutCount,
    liability: exactLiability,
  });
  return Object.freeze({
    ...identity,
    sha256: sha256(stableStringify(identity)),
  });
}

const PAUSE_ACCOUNTING_FIELDS = Object.freeze([
  'reserve', 'fee', 'epochCount', 'openEpochCount', 'payoutCount', 'liability', 'sha256',
]);

export function normalizePauseAccountingIdentity(value, field = 'pause accounting identity') {
  const raw = plainObject(value, field);
  exactObject(Object.keys(raw).sort(), [...PAUSE_ACCOUNTING_FIELDS].sort(), `${field} fields`);
  const reserve = normalizeReserveReadback(raw.reserve);
  const fee = normalizeFeeReadback(raw.fee);
  const expectedReserveKeys = [
    'payout_protocol_version', 'payouts_enabled', 'new_risk_enabled',
    'available_reserve_atto', 'committed_reserve_atto',
    'required_available_reserve_atto', 'reserved_player_payouts_atto',
    'reserved_platform_fees_atto', 'max_payout_attempts',
    'prepare_retries_capped', 'retry_delay_seconds',
  ].sort();
  const expectedFeeKeys = [
    'treasury', 'current_platform_fee_bps', 'accrued_platform_fees_atto',
    'reserved_platform_fees_atto', 'funded_platform_fees_atto',
    'withdrawn_platform_fees_atto', 'player_liability_atto',
    'reserved_player_payouts_atto',
  ].sort();
  exactObject(Object.keys(reserve).sort(), expectedReserveKeys, `${field} reserve fields`);
  exactObject(Object.keys(fee).sort(), expectedFeeKeys, `${field} fee fields`);
  if (typeof reserve.payouts_enabled !== 'boolean'
    || typeof reserve.new_risk_enabled !== 'boolean'
    || typeof reserve.prepare_retries_capped !== 'boolean') {
    fail(`${field} reserve flags are not exact booleans`);
  }
  const identity = Object.freeze({
    reserve: Object.freeze(reserve),
    fee: Object.freeze(fee),
    epochCount: normalizedDecimalLike(raw.epochCount, `${field}.epochCount`),
    openEpochCount: normalizedDecimalLike(raw.openEpochCount, `${field}.openEpochCount`),
    payoutCount: normalizedDecimalLike(raw.payoutCount, `${field}.payoutCount`),
    liability: normalizedDecimalLike(raw.liability, `${field}.liability`),
  });
  const identitySha256 = sha256(stableStringify(identity));
  const suppliedSha256 = requiredText(raw.sha256, `${field}.sha256`).toLowerCase();
  if (!/^[\da-f]{64}$/.test(suppliedSha256) || suppliedSha256 !== identitySha256) {
    fail(`${field} hash does not match its exact canonical contents`);
  }
  return Object.freeze({ ...identity, sha256: identitySha256 });
}

export function assertExactPauseAccountingIdentity(expectedValue, actualValue) {
  const expected = normalizePauseAccountingIdentity(
    expectedValue,
    'recorded pre-pause accounting identity',
  );
  const actual = normalizePauseAccountingIdentity(
    actualValue,
    'live pre-pause accounting identity',
  );
  exactObject(actual, expected, 'pre-pause accounting identity continuity');
  return actual;
}

export function assertPauseAccountingContinuity(beforeValue, afterValue) {
  const before = normalizePauseAccountingIdentity(beforeValue, 'pre-pause accounting identity');
  const after = normalizePauseAccountingIdentity(afterValue, 'post-pause accounting identity');
  if (before.reserve.payouts_enabled !== true
    || before.reserve.new_risk_enabled !== true
    || after.reserve.payouts_enabled !== true
    || after.reserve.new_risk_enabled !== false) {
    fail('pause accounting continuity requires the exact payout-on risk true-to-false transition');
  }
  const immutablePolicy = (identity) => ({
    reserve: {
      payout_protocol_version: identity.reserve.payout_protocol_version,
      payouts_enabled: identity.reserve.payouts_enabled,
      max_payout_attempts: identity.reserve.max_payout_attempts,
      prepare_retries_capped: identity.reserve.prepare_retries_capped,
      retry_delay_seconds: identity.reserve.retry_delay_seconds,
    },
    fee: {
      treasury: identity.fee.treasury,
      current_platform_fee_bps: identity.fee.current_platform_fee_bps,
    },
  });
  exactObject(
    immutablePolicy(after),
    immutablePolicy(before),
    'pause immutable accounting policy continuity',
  );
  return Object.freeze({ before, after });
}

export async function readAndVerifyPauseState(
  reader,
  contractAddress,
  local,
  config,
  { newRiskEnabled },
) {
  const address = exactAddress(contractAddress, 'pause contractAddress');
  const [code, schema, configReadback, reserveReadback, feeState,
    epochCount, openEpochCount, payoutCount, liability] = await Promise.all([
    reader.code(address),
    reader.schema(address),
    reader.call(address, 'get_config'),
    reader.call(address, 'get_delivery_reserve_state'),
    reader.call(address, 'get_fee_state'),
    reader.call(address, 'get_epoch_count'),
    reader.call(address, 'get_open_epoch_count'),
    reader.call(address, 'get_payout_count'),
    reader.call(address, 'get_total_player_liability_atto'),
  ]);
  if (code !== local.source) fail('pause target code is not byte-for-byte identical to reviewed V8');
  if (sha256(code) !== config.sourceSha256) fail('pause target code hash differs from sourceSha256');
  assertExactSchema(schema);
  assertExactConfigReadback(configReadback, config, {
    payoutsEnabled: true,
    newRiskEnabled,
  });
  const accounting = assertLiveAccountingIdentity({
    reserveReadback,
    feeState,
    epochCount,
    openEpochCount,
    payoutCount,
    liability,
  }, config, { newRiskEnabled });
  return Object.freeze({ address, config: configReadback, accounting });
}

function uniqueReceiptField(receipt, names, field, { required = true } = {}) {
  const values = names
    .map((name) => receipt?.[name])
    .filter((value) => value !== undefined && value !== null)
    .map(String);
  const unique = [...new Set(values)];
  if (unique.length > 1) fail(`receipt reports conflicting ${field}`);
  if (required && unique.length !== 1) fail(`receipt does not report ${field}`);
  return unique[0];
}

function exactEvmQuantity(value, field) {
  const quantity = String(value ?? '').toLowerCase();
  if (!/^0x(?:0|[1-9a-f][\da-f]*)$/.test(quantity)) {
    fail(`${field} is not a canonical EVM quantity`);
  }
  return quantity;
}

/**
 * Proves the relationship the GenLayer SDK does not expose directly:
 * the exact signed EVM transaction was mined by Bradbury and its single
 * consensus event created one exact GenLayer transaction id.
 */
export function assertExactEvmSubmissionReceipt(receipt, { evmTransactionHash }) {
  plainObject(receipt, 'Bradbury EVM receipt');
  const expectedEvmHash = exactHash(evmTransactionHash, 'expected EVM transaction hash');
  const receiptEvmHash = exactHash(uniqueReceiptField(
    receipt,
    ['transactionHash', 'transaction_hash'],
    'EVM transaction hash',
  ), 'EVM receipt transaction hash');
  if (receiptEvmHash !== expectedEvmHash) {
    fail('Bradbury EVM receipt does not belong to the exact pre-signed transaction');
  }
  if (String(receipt.status ?? '').toLowerCase() !== '0x1') {
    fail('Bradbury EVM submission receipt is not successful');
  }
  const blockHash = exactHash(receipt.blockHash, 'EVM receipt blockHash');
  if (blockHash === `0x${'0'.repeat(64)}`) fail('EVM receipt blockHash must be mined');
  const blockNumber = exactEvmQuantity(receipt.blockNumber, 'EVM receipt blockNumber');
  if (!Array.isArray(receipt.logs)) fail('Bradbury EVM receipt logs must be an array');

  const supported = [];
  for (const [index, rawLog] of receipt.logs.entries()) {
    const log = plainObject(rawLog, `EVM receipt log ${index}`);
    const address = normalizedAddressLike(log.address, `EVM receipt log ${index} address`);
    if (address !== BRADBURY_CONSENSUS_ADDRESS) continue;
    if (!Array.isArray(log.topics) || log.topics.length === 0) {
      fail(`EVM receipt log ${index} topics are malformed`);
    }
    const topics = log.topics.map((topic, topicIndex) => exactHash(
      topic,
      `EVM receipt log ${index} topic ${topicIndex}`,
    ));
    const eventTopic = topics[0];
    if (![NEW_TRANSACTION_TOPIC, CREATED_TRANSACTION_TOPIC].includes(eventTopic)) continue;
    if (log.removed === true) fail('Bradbury EVM consensus event was removed');
    if (exactHash(log.transactionHash, `EVM receipt log ${index} transactionHash`)
      !== expectedEvmHash) {
      fail('Bradbury EVM consensus event belongs to a different transaction');
    }
    if (exactHash(log.blockHash, `EVM receipt log ${index} blockHash`) !== blockHash
      || exactEvmQuantity(log.blockNumber, `EVM receipt log ${index} blockNumber`) !== blockNumber) {
      fail('Bradbury EVM consensus event belongs to a different block');
    }
    const data = String(log.data ?? '').toLowerCase();
    if (eventTopic === NEW_TRANSACTION_TOPIC) {
      if (topics.length !== 4 || data !== '0x') {
        fail('Bradbury NewTransaction event has an unexpected encoding');
      }
    } else if (topics.length !== 2 || !/^0x[\da-f]{64}$/.test(data)) {
      fail('Bradbury CreatedTransaction event has an unexpected encoding');
    }
    supported.push({
      genlayerTransactionHash: topics[1],
      eventTopic,
      logIndex: exactEvmQuantity(log.logIndex, `EVM receipt log ${index} logIndex`),
    });
  }
  if (supported.length !== 1) {
    fail(`Bradbury EVM receipt must contain exactly one supported consensus event; found ${supported.length}`);
  }
  return Object.freeze({
    evmTransactionHash: expectedEvmHash,
    genlayerTransactionHash: supported[0].genlayerTransactionHash,
    eventTopic: supported[0].eventTopic,
    blockHash,
    blockNumber,
    logIndex: supported[0].logIndex,
  });
}

export function assertExactSignedEvmEnvelope(operation, config) {
  plainObject(operation, 'signed operation');
  const raw = String(operation.signedEvmTransaction || '').toLowerCase();
  if (!/^0x[\da-f]+$/.test(raw) || raw.length % 2 !== 0) {
    fail('stored signed EVM transaction is malformed');
  }
  const expectedHash = exactHash(operation.evmTransactionHash, 'stored EVM transaction hash');
  if (keccak256(raw).toLowerCase() !== expectedHash) {
    fail('stored signed EVM bytes do not match their deterministic hash');
  }
  let transaction;
  try {
    transaction = Transaction.from(raw);
  } catch {
    fail('stored signed EVM transaction cannot be decoded');
  }
  if (!transaction.signature || transaction.hash?.toLowerCase() !== expectedHash) {
    fail('stored EVM transaction does not contain the exact signed envelope');
  }
  const calldataSha256 = sha256(Buffer.from(transaction.data.slice(2), 'hex'));
  if (exactSha256(
    operation.consensusCalldataSha256,
    'stored consensus calldata SHA-256',
  ) !== calldataSha256) {
    fail('stored signed EVM calldata does not match its durable reviewed hash');
  }
  const recordedSenderNonce = normalizedDecimalLike(
    operation.senderNonce,
    'recorded EVM sender nonce',
  );
  if (normalizedDecimalLike(
    operation.ownerNonceLatestAtSign,
    'recorded latest owner nonce at sign',
  ) !== recordedSenderNonce
    || normalizedDecimalLike(
      operation.ownerNoncePendingAtSign,
      'recorded pending owner nonce at sign',
    ) !== recordedSenderNonce) {
    fail('stored signed operation was not bound to one quiescent owner nonce');
  }
  if (transaction.chainId !== BigInt(BRADBURY_CHAIN_ID)
    || transaction.type !== 0
    || normalizedAddressLike(transaction.to, 'stored EVM recipient') !== BRADBURY_CONSENSUS_ADDRESS
    || normalizedAddressLike(transaction.from, 'stored EVM sender') !== config.expected.ownerAddress
    || normalizedDecimalLike(transaction.nonce, 'stored EVM sender nonce')
      !== recordedSenderNonce) {
    fail('stored signed EVM envelope is not the exact Bradbury owner submission');
  }
  const maximumGasCost = transaction.gasLimit * (transaction.gasPrice ?? 0n);
  if (transaction.gasLimit <= 0n
    || transaction.gasLimit > BigInt(config.operator.maxEvmGasLimit)
    || transaction.gasPrice === null
    || transaction.gasPrice <= 0n
    || transaction.gasPrice > BigInt(config.operator.maxEvmGasPriceWei)
    || maximumGasCost > MAX_TRANSACTION_GAS_COST_ATTO) {
    fail('stored signed EVM envelope exceeds the explicit reviewed fee caps');
  }
  const recordedPendingBalance = normalizedDecimalLike(
    operation.ownerPendingBalanceAtSign,
    'recorded pending owner balance at sign',
  );
  const recordedMaximumCost = normalizedDecimalLike(
    operation.maximumTransactionCostAtSign,
    'recorded maximum transaction cost at sign',
  );
  const exactMaximumCost = (transaction.value + maximumGasCost).toString();
  if (recordedMaximumCost !== exactMaximumCost
    || BigInt(recordedPendingBalance) < BigInt(recordedMaximumCost)) {
    fail('stored signed operation is not bound to sufficient exact pending-balance evidence');
  }
  return transaction;
}

function nonnegativeTransactionQuantity(value, field) {
  try {
    const quantity = BigInt(value);
    if (quantity < 0n) throw new Error('negative');
    return quantity;
  } catch {
    fail(`${field} is not a nonnegative transaction quantity`);
  }
}

export async function assertFreshSignerAccountPreflight({
  reader,
  ownerAddress,
  transactionRequest,
  config,
  expectedValueAtto,
}) {
  if (typeof reader?.evmRequest !== 'function') {
    fail('fresh signing requires exact Bradbury EVM account reads');
  }
  const owner = normalizedAddressLike(ownerAddress, 'fresh-sign owner');
  let latestRaw;
  let pendingRaw;
  let balanceRaw;
  try {
    [latestRaw, pendingRaw, balanceRaw] = await Promise.all([
      reader.evmRequest('eth_getTransactionCount', [owner, 'latest']),
      reader.evmRequest('eth_getTransactionCount', [owner, 'pending']),
      reader.evmRequest('eth_getBalance', [owner, 'pending']),
    ]);
  } catch {
    fail('fresh signing could not prove the Bradbury owner nonce and pending balance');
  }
  const latestQuantity = exactEvmQuantity(latestRaw, 'latest owner nonce');
  const pendingQuantity = exactEvmQuantity(pendingRaw, 'pending owner nonce');
  const balanceQuantity = exactEvmQuantity(balanceRaw, 'pending owner balance');
  const latestNonce = BigInt(latestQuantity);
  const pendingNonce = BigInt(pendingQuantity);
  if (latestNonce !== pendingNonce) {
    fail('fresh signing refused because the Bradbury owner has a pending EVM transaction');
  }
  const requestedNonce = nonnegativeTransactionQuantity(
    transactionRequest?.nonce,
    'fresh-sign transaction nonce',
  );
  if (requestedNonce !== pendingNonce) {
    fail('fresh-sign transaction nonce does not equal the quiescent Bradbury owner nonce');
  }
  const gasLimit = nonnegativeTransactionQuantity(
    transactionRequest?.gasLimit,
    'fresh-sign gas limit',
  );
  const gasPrice = nonnegativeTransactionQuantity(
    transactionRequest?.gasPrice,
    'fresh-sign gas price',
  );
  const value = nonnegativeTransactionQuantity(
    transactionRequest?.value ?? 0n,
    'fresh-sign value',
  );
  const expectedValue = nonnegativeTransactionQuantity(
    expectedValueAtto,
    'planned fresh-sign value',
  );
  const maximumGasCost = gasLimit * gasPrice;
  if (value !== expectedValue) fail('fresh-sign value differs from the exact operation plan');
  if (gasLimit <= 0n
    || gasLimit > BigInt(config.operator.maxEvmGasLimit)
    || gasPrice <= 0n
    || gasPrice > BigInt(config.operator.maxEvmGasPriceWei)
    || maximumGasCost > MAX_TRANSACTION_GAS_COST_ATTO) {
    fail('fresh-sign transaction exceeds the explicit gas and 0.03 GEN cost ceilings');
  }
  const pendingBalance = BigInt(balanceQuantity);
  const maximumTransactionCost = value + maximumGasCost;
  if (pendingBalance < maximumTransactionCost) {
    fail('fresh signing refused because pending owner balance cannot cover value plus maximum gas cost');
  }
  return Object.freeze({
    senderNonce: pendingNonce.toString(),
    ownerNonceLatestAtSign: latestNonce.toString(),
    ownerNoncePendingAtSign: pendingNonce.toString(),
    ownerPendingBalanceAtSign: pendingBalance.toString(),
    maximumTransactionCostAtSign: maximumTransactionCost.toString(),
  });
}

export async function signAfterFreshAccountPreflight({
  signImpl,
  signOptions,
  ...preflightInput
}) {
  if (typeof signImpl !== 'function') fail('fresh signing implementation is unavailable');
  const accountPreflight = await assertFreshSignerAccountPreflight(preflightInput);
  // Intentionally no asynchronous operation is inserted between the final
  // onchain account gate and the signer call.
  const signedEvmTransaction = await signImpl(
    preflightInput.transactionRequest,
    signOptions,
  );
  return Object.freeze({ signedEvmTransaction, accountPreflight });
}

function decodeConsensusTransactionData(value) {
  let elements;
  try {
    elements = decodeRlp(value);
  } catch {
    fail('consensus addTransaction payload is not canonical RLP');
  }
  if (!Array.isArray(elements) || elements.some((item) => typeof item !== 'string')) {
    fail('consensus addTransaction payload has an unexpected RLP shape');
  }
  return elements.map((item) => item.toLowerCase());
}

function decodeGenVmCalldata(value, field) {
  try {
    return decodedRecord(genlayerAbi.calldata.decode(getBytes(value)), field);
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith('Bradbury V8 harness refused:')) throw error;
    fail(`${field} cannot be decoded`);
  }
}

function expectedInnerTransactionData(action, config, local) {
  if (action === 'deploy') {
    const constructor = genlayerAbi.calldata.makeCalldataObject(undefined, [
      new CalldataAddress(getBytes(config.expected.treasuryAddress)),
      new CalldataAddress(getBytes(config.expected.keeperAddress)),
      BigInt(config.expected.epochMinStakeAtto),
      BigInt(config.expected.epochMaxStakePerWalletAtto),
      new CalldataAddress(getBytes(config.expected.payoutFactoryAddress)),
    ], undefined);
    return genlayerAbi.transactions.serialize([
      local.source,
      genlayerAbi.calldata.encode(constructor),
      false,
    ]).toLowerCase();
  }
  const method = {
    fund: 'fund_delivery_reserve',
    activate: 'activate_payouts',
    pause: 'pause_new_risk',
  }[action];
  const call = genlayerAbi.calldata.makeCalldataObject(method, [], undefined);
  return genlayerAbi.transactions.serialize([
    genlayerAbi.calldata.encode(call),
    false,
  ]).toLowerCase();
}

/** Independently proves the SDK signing request still represents the reviewed operation. */
export function assertExactPlannedConsensusCalldata(data, {
  action,
  config,
  state,
  local,
  nowSeconds = Math.floor(Date.now() / 1_000),
  requireUnexpired = true,
}) {
  const encoded = String(data || '').toLowerCase();
  if (!/^0x[\da-f]+$/.test(encoded) || encoded.length % 2 !== 0) {
    fail('outer consensus calldata is malformed');
  }
  let parsed;
  try {
    parsed = ADD_TRANSACTION_V6_INTERFACE.parseTransaction({ data: encoded });
  } catch {
    fail('outer calldata is not the exact Bradbury addTransaction v6 call');
  }
  if (!parsed || parsed.name !== 'addTransaction' || parsed.fragment.inputs.length !== 6) {
    fail('outer calldata is not the exact Bradbury addTransaction v6 call');
  }
  const canonicalOuter = ADD_TRANSACTION_V6_INTERFACE.encodeFunctionData(
    parsed.fragment,
    Array.from(parsed.args),
  ).toLowerCase();
  if (canonicalOuter !== encoded) {
    fail('outer consensus calldata is not the canonical exact-byte encoding');
  }
  if (!['deploy', 'fund', 'activate', 'pause'].includes(action)) {
    fail(`unknown planned consensus action ${action}`);
  }
  const expectedRecipient = action === 'deploy'
    ? ZERO_ADDRESS
    : normalizedAddressLike(state?.contractAddress, 'planned V8 recipient');
  if (normalizedAddressLike(parsed.args[0], 'addTransaction sender')
      !== config.expected.ownerAddress
    || normalizedAddressLike(parsed.args[1], 'addTransaction recipient') !== expectedRecipient
    || BigInt(parsed.args[2]) !== BigInt(BRADBURY_INITIAL_VALIDATORS)
    || BigInt(parsed.args[3]) !== BigInt(BRADBURY_MAX_ROTATIONS)) {
    fail('outer consensus calldata sender, recipient, or validator policy drifted');
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    fail('calldata validation time is invalid');
  }
  const validUntil = BigInt(parsed.args[5]);
  const now = BigInt(nowSeconds);
  if ((requireUnexpired && validUntil <= now) || validUntil > now + 3_600n) {
    fail('outer consensus calldata validity window is not the pinned one-hour Bradbury window');
  }

  const transactionData = String(parsed.args[4]).toLowerCase();
  const expectedTransactionData = expectedInnerTransactionData(action, config, local);
  if (transactionData !== expectedTransactionData) {
    fail(`planned ${action} GenLayer transaction bytes differ from the exact reviewed operation`);
  }
  const elements = decodeConsensusTransactionData(transactionData);
  if (action === 'deploy') {
    if (elements.length !== 3 || elements[2] !== '0x00') {
      fail('planned deployment payload is not exact full consensus');
    }
    let source;
    try {
      source = toUtf8String(elements[0]);
    } catch {
      fail('planned deployment source is not UTF-8');
    }
    if (source !== local?.source) fail('planned deployment source differs from reviewed V8 source');
    const constructor = decodeGenVmCalldata(elements[1], 'planned deployment constructor');
    if (Object.keys(constructor).some((key) => key !== 'args')
      || !Array.isArray(constructor.args)
      || constructor.args.length !== 5) {
      fail('planned deployment constructor encoding drifted');
    }
    exactObject([
      normalizedAddressLike(constructor.args[0], 'planned constructor treasury'),
      normalizedAddressLike(constructor.args[1], 'planned constructor keeper'),
      normalizedDecimalLike(constructor.args[2], 'planned constructor minimum stake'),
      normalizedDecimalLike(constructor.args[3], 'planned constructor wallet cap'),
      normalizedAddressLike(constructor.args[4], 'planned constructor factory'),
    ], [
      config.expected.treasuryAddress,
      config.expected.keeperAddress,
      config.expected.epochMinStakeAtto,
      config.expected.epochMaxStakePerWalletAtto,
      config.expected.payoutFactoryAddress,
    ], 'planned deployment constructor arguments');
    return Object.freeze({ action, validUntil: validUntil.toString(), data: encoded });
  }

  if (elements.length !== 2 || elements[1] !== '0x00') {
    fail(`planned ${action} payload is not exact full consensus`);
  }
  const call = decodeGenVmCalldata(elements[0], `planned ${action} call`);
  const expectedMethod = {
    fund: 'fund_delivery_reserve',
    activate: 'activate_payouts',
    pause: 'pause_new_risk',
  }[action];
  exactObject(call, { method: expectedMethod }, `planned ${action} call`);
  return Object.freeze({ action, validUntil: validUntil.toString(), data: encoded });
}

export function assertSuccessfulFinalizedReceipt(receipt, expectedHash) {
  assertFinalizedExecution(receipt);
  const hash = uniqueReceiptField(
    receipt,
    ['hash', 'txId', 'tx_id', 'transactionHash', 'transaction_hash'],
    'transaction hash',
  );
  if (exactHash(hash, 'receipt transaction hash') !== exactHash(expectedHash, 'expected hash')) {
    fail('FINALIZED receipt hash does not match the submitted transaction');
  }
  return receipt;
}

function receiptSender(receipt) {
  return uniqueReceiptField(receipt, ['sender', 'from', 'fromAddress', 'from_address'], 'sender');
}

function receiptValue(receipt) {
  return uniqueReceiptField(
    receipt,
    ['value', 'valueAtto', 'value_atto'],
    'value',
    { required: false },
  );
}

export function assertExactCallReceipt(receipt, {
  hash,
  sender,
  contractAddress,
  method,
  args = [],
  valueAtto = '0',
  signedOperation,
  config,
}) {
  assertSuccessfulFinalizedReceipt(receipt, hash);
  if (normalizedAddressLike(receiptSender(receipt), 'receipt sender') !== sender.toLowerCase()) {
    fail('FINALIZED call sender does not match the configured owner');
  }
  if (normalizedAddressLike(receipt.recipient, 'receipt recipient') !== contractAddress.toLowerCase()) {
    fail('FINALIZED call recipient does not match the V8 contract');
  }
  const reportedValue = receiptValue(receipt);
  if (reportedValue !== undefined
    && normalizedDecimalLike(reportedValue, 'receipt value') !== String(valueAtto)) {
    fail('FINALIZED call reported value does not match the planned value');
  }
  if (signedOperation !== undefined) {
    if (!config) fail('signed call value evidence requires the exact configuration');
    const outerEvmTransaction = assertExactSignedEvmEnvelope(signedOperation, config);
    if (outerEvmTransaction.value.toString() !== String(valueAtto)) {
      fail('signed outer EVM call value does not match the planned value');
    }
  } else if (reportedValue === undefined) {
    fail('FINALIZED call value is absent and no signed outer EVM evidence was supplied');
  }
  const decoded = decodedRecord(receipt.txDataDecoded, 'receipt.txDataDecoded');
  const callData = decodedRecord(decoded.callData, 'receipt.txDataDecoded.callData');
  const decodedArgs = Object.hasOwn(callData, 'args') ? callData.args : [];
  if (decoded.type !== 'call' || decoded.leaderOnly !== false
    || callData.method !== method || !Array.isArray(decodedArgs)) {
    fail(`FINALIZED receipt does not prove call ${method}`);
  }
  const actualArgs = decodedArgs.map(String);
  const expectedArgs = args.map(String);
  exactObject(actualArgs, expectedArgs, `FINALIZED ${method} arguments`);
  return receipt;
}

export function assertExactDeploymentReceipt(receipt, {
  hash,
  source,
  config,
  signedOperation,
}) {
  assertSuccessfulFinalizedReceipt(receipt, hash);
  if (normalizedAddressLike(receiptSender(receipt), 'deployment sender')
    !== config.expected.ownerAddress) {
    fail('FINALIZED deployment sender does not match expected.ownerAddress');
  }
  if (signedOperation !== undefined) {
    const outerEvmTransaction = assertExactSignedEvmEnvelope(signedOperation, config);
    if (outerEvmTransaction.value !== 0n) {
      fail('signed outer EVM deployment unexpectedly carries value');
    }
  }
  const decoded = decodedRecord(receipt.txDataDecoded, 'deployment receipt.txDataDecoded');
  if (decoded.type !== 'deploy' || decoded.leaderOnly !== false || decoded.code !== source) {
    fail('FINALIZED receipt does not prove the exact full-consensus V8 source deployment');
  }
  const constructor = decodedRecord(decoded.constructorArgs, 'deployment constructorArgs');
  if (!Array.isArray(constructor.args) || Object.keys(constructor).some(
    (key) => !['args', 'kwargs'].includes(key),
  )) {
    fail('deployment receipt constructor arguments are malformed');
  }
  const normalizedKwargs = constructor.kwargs instanceof Map
    ? decodedRecord(constructor.kwargs, 'deployment constructor kwargs')
    : constructor.kwargs;
  if (normalizedKwargs !== undefined
    && stableStringify(normalizedKwargs) !== stableStringify({})) {
    fail('deployment receipt contains unexpected constructor keyword arguments');
  }
  if (constructor.args.length !== 5) fail('deployment receipt constructor arity is not five');
  const normalizedArgs = [
    normalizedAddressLike(constructor.args[0], 'constructor treasury'),
    normalizedAddressLike(constructor.args[1], 'constructor keeper'),
    normalizedDecimalLike(constructor.args[2], 'constructor minimum stake'),
    normalizedDecimalLike(constructor.args[3], 'constructor wallet cap'),
    normalizedAddressLike(constructor.args[4], 'constructor factory'),
  ];
  exactObject(normalizedArgs, [
    config.expected.treasuryAddress,
    config.expected.keeperAddress,
    config.expected.epochMinStakeAtto,
    config.expected.epochMaxStakePerWalletAtto,
    config.expected.payoutFactoryAddress,
  ], 'deployment constructor arguments');
  const recipient = normalizedAddressLike(receipt.recipient, 'deployment recipient');
  const decodedAddress = normalizedAddressLike(decoded.contractAddress, 'decoded contract address');
  if (recipient !== decodedAddress) fail('deployment receipt reports conflicting contract addresses');
  return recipient;
}

export function loadAndValidateBindProof(proofPath, config, arenaAddress) {
  const absolutePath = resolve(requiredText(proofPath, '--bind-proof'));
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`unable to read factory bind proof ${absolutePath}: ${error.message}`);
  }
  const proof = plainObject(raw, 'factory bind proof');
  rejectUnknownFields(proof, BIND_PROOF_FIELDS, 'factory bind proof');
  exactObject({
    version: exactInteger(proof.version, 'bind proof version', 1, 1),
    network: requiredText(proof.network, 'bind proof network'),
    chainId: exactInteger(proof.chainId, 'bind proof chainId', BRADBURY_CHAIN_ID, BRADBURY_CHAIN_ID),
    factoryAddress: exactAddress(proof.factoryAddress, 'bind proof factoryAddress'),
    arenaAddress: exactAddress(proof.arenaAddress, 'bind proof arenaAddress'),
    binderAddress: exactAddress(proof.binderAddress, 'bind proof binderAddress'),
    reserveSinkAddress: exactAddress(proof.reserveSinkAddress, 'bind proof reserveSinkAddress'),
    protocolVersion: requiredText(proof.protocolVersion, 'bind proof protocolVersion'),
    factoryRuntimeBytecodeSha256: exactSha256(
      proof.factoryRuntimeBytecodeSha256,
      'bind proof factoryRuntimeBytecodeSha256',
    ),
    bindTransactionHash: exactHash(proof.bindTransactionHash, 'bind proof transaction hash'),
    bindReceiptStatus: requiredText(proof.bindReceiptStatus, 'bind proof receipt status'),
    bindExecutionSuccess: proof.bindExecutionSuccess,
    boundArenaReadback: exactAddress(proof.boundArenaReadback, 'bind proof boundArenaReadback'),
    verifiedAt: requiredText(proof.verifiedAt, 'bind proof verifiedAt'),
  }, {
    version: 1,
    network: BRADBURY_ALIAS,
    chainId: BRADBURY_CHAIN_ID,
    factoryAddress: config.expected.payoutFactoryAddress,
    arenaAddress: arenaAddress.toLowerCase(),
    binderAddress: config.expected.factoryBinderAddress,
    reserveSinkAddress: config.expected.reserveSinkAddress,
    protocolVersion: config.expected.payoutProtocolVersion,
    factoryRuntimeBytecodeSha256: config.expected.factoryRuntimeBytecodeSha256,
    bindTransactionHash: exactHash(proof.bindTransactionHash, 'bind proof transaction hash'),
    bindReceiptStatus: 'FINALIZED',
    bindExecutionSuccess: true,
    boundArenaReadback: arenaAddress.toLowerCase(),
    verifiedAt: requiredText(proof.verifiedAt, 'bind proof verifiedAt'),
  }, 'delegated EVM factory bind proof');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(proof.verifiedAt)
    || Number.isNaN(Date.parse(proof.verifiedAt))) {
    fail('bind proof verifiedAt must be an exact UTC ISO timestamp');
  }
  if (Date.parse(proof.verifiedAt) > Date.now() + 5 * 60_000) {
    fail('bind proof verifiedAt cannot be in the future');
  }
  return Object.freeze({ ...proof, absolutePath });
}

function exactFactoryLogAddressTopic(topic, field) {
  const value = exactHash(topic, field);
  if (value.slice(2, 26) !== '0'.repeat(24)) fail(`${field} is not a canonical indexed address`);
  return `0x${value.slice(26)}`;
}

function decodeFactoryResult(functionName, value) {
  const result = requiredText(value, `${functionName} EVM result`).toLowerCase();
  if (!/^0x[\da-f]*$/.test(result) || result.length % 2 !== 0) {
    fail(`${functionName} EVM result is malformed`);
  }
  try {
    return PAYOUT_FACTORY_INTERFACE.decodeFunctionResult(functionName, result);
  } catch {
    fail(`${functionName} EVM result cannot be decoded exactly`);
  }
}

export async function verifyFactoryBindOnBradbury(reader, proof, config, arenaAddress) {
  if (typeof reader?.evmRequest !== 'function') {
    fail('Bradbury reader cannot independently verify the delegated EVM bind');
  }
  const factory = config.expected.payoutFactoryAddress;
  const arena = normalizedAddressLike(arenaAddress, 'bound V8 arena');
  const bindHash = exactHash(proof.bindTransactionHash, 'bind transaction hash');
  const [receipt, transaction, finalizedBlock] = await Promise.all([
    reader.evmRequest('eth_getTransactionReceipt', [bindHash]),
    reader.evmRequest('eth_getTransactionByHash', [bindHash]),
    reader.evmRequest('eth_getBlockByNumber', ['finalized', false]),
  ]);
  plainObject(receipt, 'bind EVM receipt');
  plainObject(transaction, 'bind EVM transaction');
  plainObject(finalizedBlock, 'Bradbury finalized block');
  if (exactHash(receipt.transactionHash, 'bind receipt transactionHash') !== bindHash
    || String(receipt.status ?? '').toLowerCase() !== '0x1'
    || normalizedAddressLike(receipt.from, 'bind receipt sender')
      !== config.expected.factoryBinderAddress
    || normalizedAddressLike(receipt.to, 'bind receipt recipient') !== factory) {
    fail('delegated bind receipt is not the exact successful binder-to-factory transaction');
  }
  const receiptBlockHash = exactHash(receipt.blockHash, 'bind receipt blockHash');
  const receiptBlockNumber = exactEvmQuantity(receipt.blockNumber, 'bind receipt blockNumber');
  const finalizedBlockNumber = exactEvmQuantity(
    finalizedBlock.number,
    'Bradbury finalized block number',
  );
  if (BigInt(finalizedBlockNumber) < BigInt(receiptBlockNumber)) {
    fail('delegated bind transaction has not reached Bradbury EVM finality');
  }
  const canonicalBlock = await reader.evmRequest(
    'eth_getBlockByNumber',
    [receiptBlockNumber, false],
  );
  plainObject(canonicalBlock, 'bind canonical block');
  if (exactHash(canonicalBlock.hash, 'bind canonical block hash') !== receiptBlockHash
    || exactEvmQuantity(canonicalBlock.number, 'bind canonical block number') !== receiptBlockNumber) {
    fail('delegated bind receipt is not in the canonical Bradbury chain');
  }

  if (exactHash(transaction.hash, 'bind transaction hash readback') !== bindHash
    || normalizedAddressLike(transaction.from, 'bind transaction sender')
      !== config.expected.factoryBinderAddress
    || normalizedAddressLike(transaction.to, 'bind transaction recipient') !== factory
    || exactHash(transaction.blockHash, 'bind transaction blockHash') !== receiptBlockHash
    || exactEvmQuantity(transaction.blockNumber, 'bind transaction blockNumber') !== receiptBlockNumber
    || exactEvmQuantity(transaction.chainId, 'bind transaction chainId')
      !== `0x${BRADBURY_CHAIN_ID.toString(16)}`
    || BigInt(exactEvmQuantity(transaction.value, 'bind transaction value')) !== 0n) {
    fail('delegated bind transaction envelope does not exactly match the reviewed Bradbury bind');
  }
  const expectedBindData = PAYOUT_FACTORY_INTERFACE.encodeFunctionData(
    'bind_arena',
    [arena],
  ).toLowerCase();
  const transactionInput = uniqueReceiptField(
    transaction,
    ['input', 'data'],
    'bind transaction input',
  )?.toLowerCase();
  if (transactionInput !== expectedBindData) {
    fail('delegated bind transaction does not call exact bind_arena(V8_ADDRESS)');
  }

  if (!Array.isArray(receipt.logs)) fail('bind receipt logs must be an array');
  const boundEvents = receipt.logs.filter((rawLog) => {
    const log = plainObject(rawLog, 'bind receipt log');
    const address = normalizedAddressLike(log.address, 'bind receipt log address');
    return address === factory
      && Array.isArray(log.topics)
      && String(log.topics[0] ?? '').toLowerCase() === ARENA_BOUND_TOPIC;
  });
  if (boundEvents.length !== 1) {
    fail(`bind receipt must contain exactly one ArenaBound event; found ${boundEvents.length}`);
  }
  const boundEvent = boundEvents[0];
  if (boundEvent.topics.length !== 2
    || String(boundEvent.data ?? '').toLowerCase() !== '0x'
    || exactFactoryLogAddressTopic(boundEvent.topics[1], 'ArenaBound arena topic') !== arena
    || exactHash(boundEvent.transactionHash, 'ArenaBound transactionHash') !== bindHash
    || exactHash(boundEvent.blockHash, 'ArenaBound blockHash') !== receiptBlockHash
    || exactEvmQuantity(boundEvent.blockNumber, 'ArenaBound blockNumber') !== receiptBlockNumber) {
    fail('delegated bind ArenaBound event is not exact');
  }

  const finalizedTag = finalizedBlockNumber;
  const getterNames = ['binder', 'reserveSink', 'arena', 'protocol_version'];
  const [code, ...getterResults] = await Promise.all([
    reader.evmRequest('eth_getCode', [factory, finalizedTag]),
    ...getterNames.map((functionName) => reader.evmRequest('eth_call', [{
      to: factory,
      data: PAYOUT_FACTORY_INTERFACE.encodeFunctionData(functionName),
    }, finalizedTag])),
  ]);
  const runtimeCode = requiredText(code, 'factory runtime code').toLowerCase();
  if (!/^0x[\da-f]+$/.test(runtimeCode) || runtimeCode.length % 2 !== 0) {
    fail('factory runtime code is missing or malformed');
  }
  const runtimeSha256 = sha256(Buffer.from(runtimeCode.slice(2), 'hex'));
  if (runtimeSha256 !== config.expected.factoryRuntimeBytecodeSha256) {
    fail('factory runtime bytecode SHA-256 differs from the reviewed immutable factory');
  }
  const [binderResult, sinkResult, arenaResult, protocolResult] = getterResults.map(
    (value, index) => decodeFactoryResult(getterNames[index], value),
  );
  if (normalizedAddressLike(binderResult[0], 'factory binder readback')
      !== config.expected.factoryBinderAddress
    || normalizedAddressLike(sinkResult[0], 'factory reserveSink readback')
      !== config.expected.reserveSinkAddress
    || normalizedAddressLike(arenaResult[0], 'factory arena readback') !== arena
    || String(protocolResult[0]) !== config.expected.payoutProtocolVersion) {
    fail('live finalized factory roles, arena, or protocol do not exactly match the reviewed bind');
  }
  return Object.freeze({
    bindTransactionHash: bindHash,
    bindBlockHash: receiptBlockHash,
    bindBlockNumber: receiptBlockNumber,
    finalizedBlockNumber,
    factoryRuntimeBytecodeSha256: runtimeSha256,
    arena,
  });
}

export function bindRequestPathFor(statePath) {
  return `${resolve(statePath)}.bind-request.json`;
}

function exactUtcTimestamp(value, field) {
  const timestamp = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)
    || Number.isNaN(Date.parse(timestamp))) {
    fail(`${field} must be an exact UTC ISO timestamp`);
  }
  if (Date.parse(timestamp) > Date.now() + 5 * 60_000) fail(`${field} cannot be in the future`);
  return timestamp;
}

function expectedBindRequest({ config, local, operation, arenaAddress, verifiedAt }) {
  if (!operation || !['SUBMITTED', 'FINALIZED'].includes(operation.status)) {
    fail('bind request requires a submitted, successfully verified deployment operation');
  }
  return {
    schema: BIND_REQUEST_SCHEMA,
    version: 1,
    network: BRADBURY_ALIAS,
    chainId: BRADBURY_CHAIN_ID,
    configFingerprint: config.fingerprint,
    sourcePath: config.sourcePath,
    sourceSha256: local.sourceHash,
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    deploymentGenLayerTransactionHash: exactHash(
      operation.transactionHash,
      'deployment GenLayer transaction hash',
    ),
    deploymentEvmTransactionHash: exactHash(
      operation.evmTransactionHash,
      'deployment EVM transaction hash',
    ),
    deploymentEvmReceiptBlockHash: exactHash(
      operation.evmReceiptBlockHash,
      'deployment EVM receipt blockHash',
    ),
    deploymentEvmReceiptBlockNumber: exactEvmQuantity(
      operation.evmReceiptBlockNumber,
      'deployment EVM receipt blockNumber',
    ),
    // This finality is the GenLayer transaction lifecycle/execution proof. The
    // outer EVM submission receipt can lag the EVM `finalized` tag, so this
    // artifact intentionally does not assert EVM finality. The bind utility
    // must prove this exact block hash canonical and finalized before binding.
    deploymentGenLayerReceiptStatus: 'FINALIZED',
    deploymentGenLayerExecutionResult: 'FINISHED_WITH_RETURN',
    deploymentGenLayerExecutionSuccess: true,
    deploymentEvmFinalityVerified: false,
    deploymentEvmFinalityRequiredBeforeBind: true,
    leaderOnly: false,
    arenaAddress: normalizedAddressLike(arenaAddress, 'bind request arenaAddress'),
    ownerAddress: config.expected.ownerAddress,
    constructorArguments: {
      treasuryAddress: config.expected.treasuryAddress,
      keeperAddress: config.expected.keeperAddress,
      epochMinStakeAtto: config.expected.epochMinStakeAtto,
      epochMaxStakePerWalletAtto: config.expected.epochMaxStakePerWalletAtto,
      payoutFactoryAddress: config.expected.payoutFactoryAddress,
    },
    factoryAddress: config.expected.payoutFactoryAddress,
    binderAddress: config.expected.factoryBinderAddress,
    reserveSinkAddress: config.expected.reserveSinkAddress,
    v8ProtocolVersion: config.expected.protocolVersion,
    payoutProtocolVersion: config.expected.payoutProtocolVersion,
    factoryRuntimeBytecodeSha256: config.expected.factoryRuntimeBytecodeSha256,
    exactDeploymentReadback: true,
    cutsOverApplication: false,
    cutsOverDatabase: false,
    verifiedAt: exactUtcTimestamp(verifiedAt, 'bind request verifiedAt'),
  };
}

export function validateBindRequestArtifact(raw, expected) {
  const artifact = plainObject(raw, 'bind request artifact');
  rejectUnknownFields(artifact, BIND_REQUEST_FIELDS, 'bind request artifact');
  const constructor = plainObject(
    artifact.constructorArguments,
    'bind request constructorArguments',
  );
  rejectUnknownFields(
    constructor,
    BIND_REQUEST_CONSTRUCTOR_FIELDS,
    'bind request constructorArguments',
  );
  const reviewed = expectedBindRequest({
    ...expected,
    verifiedAt: artifact.verifiedAt,
  });
  exactObject(artifact, reviewed, 'sanitized finalized V8 bind request');
  return Object.freeze(artifact);
}

export function loadBindRequestArtifact(statePath, expected) {
  const protectedRoot = dirname(resolve(statePath));
  const artifactPath = assertProtectedOperationalPath(
    bindRequestPathFor(statePath),
    protectedRoot,
    { field: 'bind request read path' },
  );
  if (!existsSync(artifactPath)) {
    fail(`finalized deployment bind request is missing at ${artifactPath}`);
  }
  let existing;
  try {
    existing = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    fail(`existing bind request artifact is unreadable: ${error.message}`);
  }
  return Object.freeze({
    artifactPath,
    artifact: validateBindRequestArtifact(existing, expected),
  });
}

export function ensureBindRequestArtifact(statePath, expected) {
  const protectedRoot = dirname(resolve(statePath));
  const artifactPath = assertProtectedOperationalPath(
    bindRequestPathFor(statePath),
    protectedRoot,
    { field: 'bind request write path' },
  );
  if (existsSync(artifactPath)) {
    return Object.freeze({ ...loadBindRequestArtifact(statePath, expected), created: false });
  }
  const artifact = expectedBindRequest({
    ...expected,
    verifiedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(artifactPath), { recursive: true });
  assertProtectedOperationalPath(artifactPath, protectedRoot, {
    field: 'bind request write path after parent creation',
  });
  const temporary = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    assertProtectedOperationalPath(temporary, protectedRoot, {
      field: 'temporary bind request path',
    });
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertProtectedOperationalPath(artifactPath, protectedRoot, {
      field: 'bind request publication path',
    });
    linkSync(temporary, artifactPath);
    unlinkSync(temporary);
    // The temporary inode was flushed before it was published. Windows rejects
    // fsync on a read-only descriptor, but FlushFileBuffers through r+ is
    // supported and strengthens publication durability there.
    assertProtectedOperationalPath(artifactPath, protectedRoot, {
      field: 'published bind request path',
    });
    const targetDescriptor = openSync(artifactPath, 'r+');
    try {
      fsyncSync(targetDescriptor);
    } finally {
      closeSync(targetDescriptor);
    }
    // POSIX additionally permits syncing the directory entry. Node does not
    // expose an equivalent Windows directory handle, so this is best-effort.
    try {
      const directoryDescriptor = openSync(dirname(artifactPath), 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {}
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    if (error?.code === 'EEXIST') {
      let existing;
      try {
        assertProtectedOperationalPath(artifactPath, protectedRoot, {
          field: 'racing bind request path',
        });
        existing = JSON.parse(readFileSync(artifactPath, 'utf8'));
      } catch (readError) {
        fail(`racing bind request artifact is unreadable: ${readError.message}`);
      }
      return Object.freeze({
        artifactPath,
        artifact: validateBindRequestArtifact(existing, expected),
        created: false,
      });
    }
    fail(`unable to atomically create sanitized bind request artifact: ${error.message}`);
  }
  return Object.freeze({ artifactPath, artifact: Object.freeze(artifact), created: true });
}

export function stateLockPathFor(statePath) {
  return `${resolve(statePath)}.lock`;
}

export function assertStateLockOwnership(statePath, token) {
  const exactToken = requiredText(token, 'state lock token');
  const protectedRoot = dirname(resolve(statePath));
  const exactStatePath = assertProtectedOperationalPath(statePath, protectedRoot, {
    field: 'locked state path',
  });
  const lockPath = assertProtectedOperationalPath(
    stateLockPathFor(exactStatePath),
    protectedRoot,
    { field: 'state lock ownership path' },
  );
  let record;
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    fail('exclusive state lock is missing or unreadable');
  }
  plainObject(record, 'state lock');
  if (record.version !== 1
    || record.statePath !== exactStatePath
    || record.token !== exactToken
    || !Number.isSafeInteger(record.pid)
    || typeof record.createdAt !== 'string') {
    fail('exclusive state lock ownership does not match this process');
  }
  return Object.freeze({ lockPath, token: exactToken });
}

export function acquireStateLock(statePath) {
  const protectedRoot = dirname(resolve(statePath));
  const absoluteStatePath = assertProtectedOperationalPath(statePath, protectedRoot, {
    field: 'state lock target',
  });
  const lockPath = assertProtectedOperationalPath(
    stateLockPathFor(absoluteStatePath),
    protectedRoot,
    { field: 'state lock path' },
  );
  mkdirSync(dirname(lockPath), { recursive: true });
  assertProtectedOperationalPath(absoluteStatePath, protectedRoot, {
    field: 'state lock target after parent creation',
  });
  assertProtectedOperationalPath(lockPath, protectedRoot, {
    field: 'state lock path after parent creation',
  });
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(`exclusive state lock already exists at ${lockPath}; verify the owning process before manual stale-lock removal`);
    }
    fail(`unable to acquire exclusive state lock: ${error.message}`);
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      statePath: absoluteStatePath,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, { encoding: 'utf8' });
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lockPath); } catch {}
    fail(`unable to persist exclusive state lock: ${error.message}`);
  }
  let released = false;
  return Object.freeze({
    lockPath,
    token,
    release() {
      if (released) return;
      released = true;
      try { closeSync(descriptor); } catch {}
      const owned = assertStateLockOwnership(absoluteStatePath, token);
      try {
        unlinkSync(owned.lockPath);
      } catch (error) {
        fail(`unable to release exclusive state lock: ${error.message}`);
      }
    },
  });
}

export function ownerLockPathFor(config) {
  const lockDirectory = resolve(operationalEvidenceRoot(), 'locks');
  return assertProtectedOperationalPath(resolve(
    lockDirectory,
    `owner-${BRADBURY_CHAIN_ID}-${config.expected.ownerAddress.slice(2)}.lock`,
  ), lockDirectory, { field: 'Bradbury owner lock path' });
}

export function assertOwnerLockOwnership(config, token) {
  const exactToken = requiredText(token, 'owner lock token');
  const lockPath = ownerLockPathFor(config);
  let record;
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    fail('exclusive Bradbury owner lock is missing or unreadable');
  }
  plainObject(record, 'owner lock');
  if (record.version !== 1
    || record.chainId !== BRADBURY_CHAIN_ID
    || record.ownerAddress !== config.expected.ownerAddress
    || record.token !== exactToken
    || !Number.isSafeInteger(record.pid)
    || typeof record.createdAt !== 'string') {
    fail('exclusive Bradbury owner lock ownership does not match this process');
  }
  return Object.freeze({ lockPath, token: exactToken });
}

export function acquireOwnerLock(config) {
  const lockPath = ownerLockPathFor(config);
  const lockDirectory = dirname(lockPath);
  mkdirSync(lockDirectory, { recursive: true });
  assertProtectedOperationalPath(lockPath, lockDirectory, {
    field: 'Bradbury owner lock path after parent creation',
  });
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(`exclusive Bradbury owner lock already exists at ${lockPath}; verify the owning process and all external owner activity before manual stale-lock removal`);
    }
    fail(`unable to acquire exclusive Bradbury owner lock: ${error.message}`);
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      chainId: BRADBURY_CHAIN_ID,
      ownerAddress: config.expected.ownerAddress,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, { encoding: 'utf8' });
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lockPath); } catch {}
    fail(`unable to persist exclusive Bradbury owner lock: ${error.message}`);
  }
  let released = false;
  return Object.freeze({
    lockPath,
    token,
    release() {
      if (released) return;
      released = true;
      try { closeSync(descriptor); } catch {}
      const owned = assertOwnerLockOwnership(config, token);
      try {
        unlinkSync(owned.lockPath);
      } catch (error) {
        fail(`unable to release exclusive Bradbury owner lock: ${error.message}`);
      }
    },
  });
}

export function newState(config) {
  return {
    version: STATE_VERSION,
    configFingerprint: config.fingerprint,
    stage: 'PLANNED',
    contractAddress: null,
    operations: {},
    updatedAt: null,
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

export function operationalEvidenceRoot({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (platform === 'win32') {
    const base = requiredText(localAppData, 'LOCALAPPDATA for protected operational evidence');
    if (!isAbsolute(base)) fail('LOCALAPPDATA must be an absolute owner-profile path');
    return resolve(base, 'LiquidityArena', 'bradbury-v8');
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '.operational');
}

function pathIsWithin(candidate, root, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  const normalize = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const exactCandidate = normalize(pathApi.resolve(candidate));
  const exactRoot = normalize(pathApi.resolve(root));
  return exactCandidate === exactRoot
    || exactCandidate.startsWith(`${exactRoot}${pathApi.sep}`);
}

function comparableFilesystemPath(value, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  let exact = pathApi.resolve(value);
  if (platform === 'win32') {
    exact = exact.replace(/^\\\\\?\\/, '').toLowerCase();
  }
  return exact;
}

function pathEntryExists(pathValue, field) {
  try {
    lstatSync(pathValue);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return false;
    fail(`${field} cannot be inspected safely: ${error.message}`);
  }
}

function assertExistingPathIsNotAliased(pathValue, field, platform = process.platform) {
  let stat;
  try {
    stat = lstatSync(pathValue);
  } catch (error) {
    fail(`${field} cannot be inspected for filesystem aliases: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    fail(`${field} must not be a symbolic link or Windows junction`);
  }
  let canonical;
  try {
    canonical = realpathSync(pathValue);
  } catch (error) {
    fail(`${field} cannot be resolved without filesystem aliases: ${error.message}`);
  }
  if (comparableFilesystemPath(canonical, platform)
    !== comparableFilesystemPath(pathValue, platform)) {
    fail(`${field} resolves through a symbolic link, junction, or aliased parent`);
  }
}

export function assertProtectedOperationalPath(candidate, protectedRoot, {
  field = 'protected operational path',
  platform = process.platform,
} = {}) {
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  const exactCandidate = pathApi.resolve(candidate);
  const exactRoot = pathApi.resolve(protectedRoot);
  if (!pathIsWithin(exactCandidate, exactRoot, platform)) {
    fail(`${field} must stay inside ${exactRoot}`);
  }
  // Synthetic cross-platform path tests cannot be inspected by this host's
  // filesystem. Production always uses process.platform, where every existing
  // ancestor is checked below.
  if (platform !== process.platform) return exactCandidate;

  let anchor = exactRoot;
  while (!pathEntryExists(anchor, `${field} root ancestry`)) {
    const parent = pathApi.dirname(anchor);
    if (parent === anchor) {
      fail(`${field} has no inspectable existing filesystem ancestor`);
    }
    anchor = parent;
  }
  assertExistingPathIsNotAliased(anchor, `${field} existing root`, platform);

  if (pathEntryExists(exactRoot, `${field} root`)) {
    assertExistingPathIsNotAliased(exactRoot, `${field} root`, platform);
    const suffix = pathApi.relative(exactRoot, exactCandidate);
    let current = exactRoot;
    if (suffix !== '') {
      for (const component of suffix.split(pathApi.sep)) {
        current = pathApi.join(current, component);
        if (!pathEntryExists(current, `${field} component`)) break;
        assertExistingPathIsNotAliased(current, `${field} component`, platform);
      }
    }
  }
  return exactCandidate;
}

export function statePathFor(configPath, config, overridePath, {
  platform = process.platform,
  evidenceRoot = operationalEvidenceRoot({ platform }),
} = {}) {
  const pathApi = platform === 'win32' ? win32Path : posixPath;
  const stateRoot = pathApi.resolve(evidenceRoot, 'state');
  if (overridePath) {
    const candidate = pathApi.resolve(overridePath);
    if (!pathIsWithin(candidate, stateRoot, platform)) {
      fail(`--state must stay inside the protected operational state root ${stateRoot}`);
    }
    return assertProtectedOperationalPath(candidate, stateRoot, {
      field: '--state path',
      platform,
    });
  }
  // Keep the config-path parameter for CLI compatibility, but state never
  // inherits an arbitrary config directory because it can contain replayable
  // raw signed transaction bytes.
  requiredText(configPath, 'config path');
  return assertProtectedOperationalPath(
    pathApi.resolve(stateRoot, `v8-${config.fingerprint.slice(0, 16)}.json`),
    stateRoot,
    { field: 'default state path', platform },
  );
}

export function loadState(statePath, config) {
  const protectedRoot = dirname(resolve(statePath));
  const exactStatePath = assertProtectedOperationalPath(statePath, protectedRoot, {
    field: 'state read path',
  });
  if (!existsSync(exactStatePath)) return newState(config);
  let state;
  try {
    state = JSON.parse(readFileSync(exactStatePath, 'utf8'));
  } catch (error) {
    fail(`unable to read protected state: ${error.message}`);
  }
  plainObject(state, 'state');
  if (state.version !== STATE_VERSION || state.configFingerprint !== config.fingerprint) {
    fail('state does not belong to this exact configuration');
  }
  if (state.cutsOverApplication !== false || state.cutsOverDatabase !== false) {
    fail('state contains a prohibited application/database cutover marker');
  }
  if (state.contractAddress !== null) exactAddress(state.contractAddress, 'state.contractAddress');
  plainObject(state.operations, 'state.operations');
  return state;
}

export function writeStateAtomic(statePath, state, {
  openImpl = openSync,
  writeImpl = writeFileSync,
  fsyncImpl = fsyncSync,
  closeImpl = closeSync,
  renameImpl = renameSync,
  unlinkImpl = unlinkSync,
} = {}) {
  const protectedRoot = dirname(resolve(statePath));
  const exactStatePath = assertProtectedOperationalPath(statePath, protectedRoot, {
    field: 'state write path',
  });
  const directory = dirname(exactStatePath);
  mkdirSync(directory, { recursive: true });
  assertProtectedOperationalPath(exactStatePath, protectedRoot, {
    field: 'state write path after parent creation',
  });
  const temporary = `${exactStatePath}.${process.pid}.${randomUUID()}.tmp`;
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
  let descriptor;
  try {
    assertProtectedOperationalPath(temporary, protectedRoot, {
      field: 'temporary state write path',
    });
    descriptor = openImpl(temporary, 'wx', 0o600);
    writeImpl(descriptor, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
    fsyncImpl(descriptor);
    closeImpl(descriptor);
    descriptor = undefined;
    assertProtectedOperationalPath(exactStatePath, protectedRoot, {
      field: 'state publication path',
    });
    renameImpl(temporary, exactStatePath);
    assertProtectedOperationalPath(exactStatePath, protectedRoot, {
      field: 'published state path',
    });
    const targetDescriptor = openImpl(exactStatePath, 'r+');
    try {
      fsyncImpl(targetDescriptor);
    } finally {
      closeImpl(targetDescriptor);
    }
    // POSIX directory fsync makes the rename durable. Windows does not allow
    // opening directories this way, so the unsupported directory sync is
    // best-effort. The temporary inode and published file are both flushed.
    try {
      const directoryDescriptor = openImpl(directory, 'r');
      try {
        fsyncImpl(directoryDescriptor);
      } finally {
        closeImpl(directoryDescriptor);
      }
    } catch {}
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeImpl(descriptor); } catch {}
    }
    try { unlinkImpl(temporary); } catch {}
    fail(`unable to persist state atomically: ${error.message}`);
  }
  return next;
}

const PREPARED_STAGE = Object.freeze({
  deploy: 'DEPLOY_PREPARED',
  fund: 'RESERVE_FUND_PREPARED',
  activate: 'ACTIVATION_PREPARED',
  pause: 'PAUSE_PREPARED',
});
const SUBMITTED_STAGE = Object.freeze({
  deploy: 'DEPLOY_SUBMITTED',
  fund: 'RESERVE_FUND_SUBMITTED',
  activate: 'ACTIVATION_SUBMITTED',
  pause: 'PAUSE_SUBMITTED',
});
const SIGNED_STAGE = Object.freeze({
  deploy: 'DEPLOY_SIGNED',
  fund: 'RESERVE_FUND_SIGNED',
  activate: 'ACTIVATION_SIGNED',
  pause: 'PAUSE_SIGNED',
});
const EVM_CONFIRMED_STAGE = Object.freeze({
  deploy: 'DEPLOY_EVM_CONFIRMED',
  fund: 'RESERVE_FUND_EVM_CONFIRMED',
  activate: 'ACTIVATION_EVM_CONFIRMED',
  pause: 'PAUSE_EVM_CONFIRMED',
});

function unresolvedOperationEntries(state) {
  return Object.entries(state.operations).filter(([, operation]) => (
    operation && !['FINALIZED', 'FAILED'].includes(operation.status)
  ));
}

export function prepareOperation(statePath, state, type, { pauseAccountingIdentity } = {}) {
  if (!Object.hasOwn(PREPARED_STAGE, type)) fail(`unknown operation type ${type}`);
  const previous = state.operations[type];
  const unresolved = unresolvedOperationEntries(state);
  const reusesPrepared = previous?.status === 'PREPARED'
    && previous.transactionHash === null
    && previous.signedEvmTransaction === undefined
    && previous.evmTransactionHash === undefined
    && unresolved.length === 1
    && unresolved[0][0] === type;
  if (!reusesPrepared && unresolved.length > 0) {
    const summary = unresolved.map(([name, operation]) => `${name}:${operation.status}`).join(', ');
    fail(`state has unresolved operation(s) ${summary}; reconcile before preparing ${type}`);
  }
  let exactPauseAccountingIdentity;
  if (type === 'pause') {
    exactPauseAccountingIdentity = normalizePauseAccountingIdentity(
      pauseAccountingIdentity,
      'pause PREPARED accounting identity',
    );
    if (exactPauseAccountingIdentity.reserve.payouts_enabled !== true
      || exactPauseAccountingIdentity.reserve.new_risk_enabled !== true) {
      fail('pause can be prepared only from exact payout-on risk-enabled accounting');
    }
  } else if (pauseAccountingIdentity !== undefined) {
    fail(`${type} cannot record pause accounting evidence`);
  }
  if (reusesPrepared) {
    if (type === 'pause') {
      const recorded = normalizePauseAccountingIdentity(
        previous.pauseAccountingIdentity,
        'recorded pause PREPARED accounting identity',
      );
      exactObject(
        recorded,
        exactPauseAccountingIdentity,
        'reused pause PREPARED accounting identity',
      );
    }
    // The signing hook is the only path to eth_sendRawTransaction, and it
    // persists SIGNED before returning. In the documented process-crash model,
    // PREPARED therefore proves no payload reached the SDK broadcaster. After
    // an OS/power crash, operators must audit the dedicated owner onchain
    // before resuming any PREPARED evidence because Windows cannot fsync a
    // directory entry through Node.
    return state;
  }
  const nonce = randomUUID();
  const operation = { status: 'PREPARED', nonce, transactionHash: null };
  if (type === 'pause') operation.pauseAccountingIdentity = exactPauseAccountingIdentity;
  return writeStateAtomic(statePath, {
    ...state,
    stage: PREPARED_STAGE[type],
    operations: {
      ...state.operations,
      [type]: operation,
    },
  });
}

export function recordSubmittedOperation(statePath, state, type, nonce, transactionHash) {
  const current = state.operations[type];
  if (!current || current.status !== 'EVM_CONFIRMED' || current.nonce !== nonce
    || !current.signedEvmTransaction || !current.evmTransactionHash
    || !current.genlayerTransactionHash) {
    fail(`state no longer contains the EVM-confirmed ${type} operation`);
  }
  const submittedHash = exactHash(transactionHash, `${type} GenLayer transaction hash`);
  if (submittedHash !== current.genlayerTransactionHash) {
    fail(`${type} SDK GenLayer transaction id does not match the exact Bradbury EVM event`);
  }
  return writeStateAtomic(statePath, {
    ...state,
    stage: SUBMITTED_STAGE[type],
    operations: {
      ...state.operations,
      [type]: {
        ...current,
        status: 'SUBMITTED',
        transactionHash: submittedHash,
      },
    },
  });
}

export function recordEvmReceiptEvidence(statePath, state, type, nonce, evidence) {
  const current = state.operations[type];
  if (!current || current.status !== 'SIGNED' || current.nonce !== nonce
    || !current.signedEvmTransaction || !current.evmTransactionHash) {
    fail(`state no longer contains the exact signed ${type} operation`);
  }
  const evmTransactionHash = exactHash(
    evidence?.evmTransactionHash,
    `${type} EVM receipt transaction hash`,
  );
  if (evmTransactionHash !== current.evmTransactionHash) {
    fail(`${type} EVM receipt does not match the stored signed transaction`);
  }
  const genlayerTransactionHash = exactHash(
    evidence?.genlayerTransactionHash,
    `${type} GenLayer transaction hash`,
  );
  const evmReceiptBlockHash = exactHash(
    evidence?.blockHash,
    `${type} EVM receipt blockHash`,
  );
  const evmReceiptBlockNumber = exactEvmQuantity(
    evidence?.blockNumber,
    `${type} EVM receipt blockNumber`,
  );
  const evmReceiptEventTopic = exactHash(
    evidence?.eventTopic,
    `${type} EVM receipt event topic`,
  );
  if (![NEW_TRANSACTION_TOPIC, CREATED_TRANSACTION_TOPIC].includes(evmReceiptEventTopic)) {
    fail(`${type} EVM receipt event topic is not a supported consensus event`);
  }
  const evmReceiptLogIndex = exactEvmQuantity(
    evidence?.logIndex,
    `${type} EVM receipt logIndex`,
  );
  return writeStateAtomic(statePath, {
    ...state,
    stage: EVM_CONFIRMED_STAGE[type],
    operations: {
      ...state.operations,
      [type]: {
        ...current,
        status: 'EVM_CONFIRMED',
        genlayerTransactionHash,
        evmReceiptBlockHash,
        evmReceiptBlockNumber,
        evmReceiptEventTopic,
        evmReceiptLogIndex,
      },
    },
  });
}

export function recordSignedOperation(
  statePath,
  state,
  type,
  nonce,
  {
    signedEvmTransaction,
    evmTransactionHash,
    senderNonce,
    ownerNonceLatestAtSign,
    ownerNoncePendingAtSign,
    ownerPendingBalanceAtSign,
    maximumTransactionCostAtSign,
  },
) {
  const current = state.operations[type];
  if (!current || current.status !== 'PREPARED' || current.nonce !== nonce) {
    fail(`state no longer contains the exact prepared ${type} operation`);
  }
  const raw = String(signedEvmTransaction || '').toLowerCase();
  if (!/^0x[\da-f]+$/.test(raw) || raw.length % 2 !== 0 || raw.length > 512 * 1024) {
    fail(`${type} signed EVM transaction is malformed`);
  }
  const evmHash = exactHash(evmTransactionHash, `${type} EVM transaction hash`);
  if (keccak256(raw).toLowerCase() !== evmHash) {
    fail(`${type} signed EVM bytes do not match their deterministic hash`);
  }
  let signedEnvelope;
  try {
    signedEnvelope = Transaction.from(raw);
  } catch {
    fail(`${type} signed EVM transaction cannot be decoded before persistence`);
  }
  if (!signedEnvelope.signature || signedEnvelope.hash?.toLowerCase() !== evmHash
    || !/^0x[\da-f]+$/i.test(signedEnvelope.data)) {
    fail(`${type} signed EVM transaction does not contain an exact calldata envelope`);
  }
  const consensusCalldataSha256 = sha256(Buffer.from(signedEnvelope.data.slice(2), 'hex'));
  const exactNonce = normalizedDecimalLike(senderNonce, `${type} sender nonce`);
  const exactLatestNonce = normalizedDecimalLike(
    ownerNonceLatestAtSign,
    `${type} latest owner nonce at sign`,
  );
  const exactPendingNonce = normalizedDecimalLike(
    ownerNoncePendingAtSign,
    `${type} pending owner nonce at sign`,
  );
  if (exactLatestNonce !== exactNonce || exactPendingNonce !== exactNonce) {
    fail(`${type} signed operation is not bound to one quiescent owner nonce`);
  }
  const exactPendingBalance = normalizedDecimalLike(
    ownerPendingBalanceAtSign,
    `${type} pending owner balance at sign`,
  );
  const exactMaximumCost = normalizedDecimalLike(
    maximumTransactionCostAtSign,
    `${type} maximum transaction cost at sign`,
  );
  if (BigInt(exactPendingBalance) < BigInt(exactMaximumCost)) {
    fail(`${type} pending owner balance did not cover the signed transaction ceiling`);
  }
  const signedMaximumCost = signedEnvelope.gasPrice === null
    ? null
    : signedEnvelope.value + signedEnvelope.gasLimit * signedEnvelope.gasPrice;
  if (normalizedDecimalLike(signedEnvelope.nonce, `${type} signed sender nonce`) !== exactNonce
    || signedMaximumCost === null
    || signedMaximumCost.toString() !== exactMaximumCost) {
    fail(`${type} signed envelope does not match its nonce and maximum-cost evidence`);
  }
  return writeStateAtomic(statePath, {
    ...state,
    stage: SIGNED_STAGE[type],
    operations: {
      ...state.operations,
      [type]: {
        ...current,
        status: 'SIGNED',
        signedEvmTransaction: raw,
        evmTransactionHash: evmHash,
        senderNonce: exactNonce,
        ownerNonceLatestAtSign: exactLatestNonce,
        ownerNoncePendingAtSign: exactPendingNonce,
        ownerPendingBalanceAtSign: exactPendingBalance,
        maximumTransactionCostAtSign: exactMaximumCost,
        consensusCalldataSha256,
      },
    },
  });
}

function finalizeOperation(statePath, state, type, stage, extra = {}) {
  const current = state.operations[type];
  if (!current || current.status !== 'SUBMITTED' || !current.transactionHash) {
    fail(`state does not contain a submitted ${type} operation`);
  }
  return writeStateAtomic(statePath, {
    ...state,
    ...extra,
    stage,
    operations: {
      ...state.operations,
      [type]: { ...current, status: 'FINALIZED' },
    },
  });
}

function signerChildPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'signer-child.mjs');
}

export function runSignerChild({
  config,
  configPath,
  statePath,
  action,
  nonce,
  bindProofPath,
  lockToken,
  ownerLockToken,
  password = process.env.GENLAYER_KEYSTORE_PASSWORD || '',
  spawnImpl = nodeSpawn,
}) {
  assertStateLockOwnership(resolve(statePath), lockToken);
  assertOwnerLockOwnership(config, ownerLockToken);
  return new Promise((resolvePromise, reject) => {
    const args = [
      signerChildPath(), '--broadcast', '--config', configPath, '--state', statePath,
      '--action', action, '--nonce', nonce,
    ];
    if (bindProofPath) args.push('--bind-proof', resolve(bindProofPath));
    const childEnvironment = { ...process.env };
    delete childEnvironment.GENLAYER_KEYSTORE_PASSWORD;
    delete childEnvironment.BRADBURY_V8_LOCK_TOKEN;
    delete childEnvironment.BRADBURY_V8_OWNER_LOCK_TOKEN;
    childEnvironment.BRADBURY_V8_LOCK_TOKEN = requiredText(lockToken, 'state lock token');
    childEnvironment.BRADBURY_V8_OWNER_LOCK_TOKEN = requiredText(
      ownerLockToken,
      'owner lock token',
    );
    const selectedSpawn = password
      ? createPasswordWritingSpawn(password, { spawnImpl })
      : spawnImpl;
    const child = selectedSpawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      env: childEnvironment,
      stdio: [password ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let processError;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) child.kill();
    });
    child.once('error', (error) => { processError = error; });
    child.once('close', (status) => {
      if (processError) return reject(processError);
      if (status !== 0) {
        return reject(new Error(`signer child failed without exposing credentials: ${stderr.slice(0, 2_048)}`));
      }
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(new Error('signer child returned malformed output'));
      }
      if (result?.event !== 'BRADBURY_V8_TRANSACTION_SUBMITTED'
        || result.action !== action
        || result.nonce !== nonce
        || !HASH_PATTERN.test(String(result.transactionHash || ''))) {
        return reject(new Error('signer child output did not prove the exact submitted operation'));
      }
      return resolvePromise(Object.freeze(result));
    });
  });
}

const sleep = (milliseconds) => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, milliseconds);
});

export async function reconcileEvmSubmission({
  reader,
  operation,
  config,
  action,
  state,
  local,
  broadcast = false,
  sleepImpl = sleep,
}) {
  if (operation?.status !== 'SIGNED') {
    fail('EVM submission reconciliation requires one exact SIGNED operation');
  }
  const envelope = assertExactSignedEvmEnvelope(operation, config);
  const expectedValue = action === 'fund' ? config.reserve.initialFundingAtto : '0';
  if (envelope.value.toString() !== expectedValue) {
    fail(`stored signed EVM value does not match the exact ${action} operation`);
  }
  assertExactPlannedConsensusCalldata(envelope.data, {
    action,
    config,
    state,
    local,
    requireUnexpired: false,
  });
  if (typeof reader?.evmReceipt !== 'function') {
    fail('Bradbury reader cannot inspect an exact EVM transaction hash');
  }
  const evmTransactionHash = exactHash(
    operation.evmTransactionHash,
    'stored EVM transaction hash',
  );
  let receipt = await reader.evmReceipt(evmTransactionHash);
  if (receipt) {
    return assertExactEvmSubmissionReceipt(receipt, { evmTransactionHash });
  }
  if (!broadcast) return null;
  assertExactPlannedConsensusCalldata(envelope.data, {
    action,
    config,
    state,
    local,
    requireUnexpired: true,
  });
  if (action === 'pause') {
    const current = await readAndVerifyPauseState(
      reader,
      state.contractAddress,
      local,
      config,
      { newRiskEnabled: true },
    );
    assertExactPauseAccountingIdentity(
      operation.pauseAccountingIdentity,
      current.accounting,
    );
  }
  if (typeof reader.sendSignedEvmTransaction !== 'function') {
    fail('Bradbury reader cannot replay the exact stored signed transaction');
  }

  // eth_sendRawTransaction is idempotent by raw bytes/hash. A provider may
  // return the hash or report "already known" after accepting it. In either
  // case, only the exact stored hash and its exact receipt can advance state.
  try {
    const replayedHash = await reader.sendSignedEvmTransaction(
      operation.signedEvmTransaction,
    );
    if (exactHash(replayedHash, 'replayed EVM transaction hash') !== evmTransactionHash) {
      fail('Bradbury raw replay returned a different EVM transaction hash');
    }
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith('Bradbury V8 harness refused:')) throw error;
    // Do not surface provider error text: some providers echo raw payloads.
    // Polling the deterministic hash is the only safe success criterion.
  }

  const retries = config.operator.finalityRetries;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    receipt = await reader.evmReceipt(evmTransactionHash);
    if (receipt) return assertExactEvmSubmissionReceipt(receipt, { evmTransactionHash });
    if (attempt + 1 < retries) await sleepImpl(config.operator.finalityIntervalMs);
  }
  fail('exact stored EVM transaction did not produce an inspectable Bradbury receipt');
}

async function exactRawReceipt(reader, hash, operator) {
  const finalized = await reader.waitFinalized(hash, operator);
  assertFinalizedExecution(finalized);
  const raw = await reader.transaction(hash);
  assertSuccessfulFinalizedReceipt(raw, hash);
  return raw;
}

function expectedStateForStage(stage, config) {
  if (['RESERVE_FUNDED', 'ACTIVATION_PREPARED', 'ACTIVATION_SIGNED',
    'ACTIVATION_EVM_CONFIRMED', 'ACTIVATION_SUBMITTED'].includes(stage)) {
    return { payoutsEnabled: false, newRiskEnabled: false, availableReserveAtto: config.reserve.initialFundingAtto };
  }
  if (['PAUSE_PREPARED', 'PAUSE_SIGNED',
    'PAUSE_EVM_CONFIRMED', 'PAUSE_SUBMITTED'].includes(stage)) {
    return { payoutsEnabled: true, newRiskEnabled: true, availableReserveAtto: config.reserve.initialFundingAtto };
  }
  if (stage === ACTIVATION_TERMINAL_STAGE) return activationTerminalReadback(config);
  return { payoutsEnabled: false, newRiskEnabled: false, availableReserveAtto: '0' };
}

function nextAction(stage) {
  const actions = {
    PLANNED: 'deploy',
    AWAITING_FACTORY_BIND: 'complete the external one-time EVM factory bind and produce its proof',
    RESERVE_FUNDED: 'activate',
    [ACTIVATION_TERMINAL_STAGE]: 'run independent payout-only canaries; no resume-risk or app/database cutover exists in this harness',
  };
  return actions[stage] ?? 'reconcile the recorded operation before any new broadcast';
}

async function verifyLocalSchema(reader, local) {
  const schema = await reader.schemaForCode(local.source);
  assertExactSchema(schema);
}

export function activationTerminalReadback(config) {
  return Object.freeze({
    payoutsEnabled: true,
    newRiskEnabled: false,
    availableReserveAtto: config.reserve.initialFundingAtto,
  });
}

async function statusAction(context) {
  const { config, state, statePath, reader, local } = context;
  await verifyLocalSchema(reader, local);
  let readback = null;
  let bindRequestPath = null;
  if (state.contractAddress) {
    const deployOperation = state.operations.deploy;
    if (!deployOperation || deployOperation.status !== 'FINALIZED') {
      fail('recorded V8 contract does not have one finalized deployment operation');
    }
    bindRequestPath = loadBindRequestArtifact(statePath, {
      config,
      local,
      operation: deployOperation,
      arenaAddress: state.contractAddress,
    }).artifactPath;
    const expected = expectedStateForStage(state.stage, config);
    if (!['_PREPARED', '_SIGNED', '_EVM_CONFIRMED', '_SUBMITTED'].some(
      (suffix) => state.stage.endsWith(suffix),
    )) {
      if (state.stage === ACTIVATION_TERMINAL_STAGE) {
        await readAndVerifyPauseState(
          reader,
          state.contractAddress,
          local,
          config,
          { newRiskEnabled: false },
        );
      } else {
        await readAndVerifyDeployment(reader, state.contractAddress, local, config, expected);
      }
      readback = 'PASS_EXACT';
    } else {
      readback = 'PENDING_RECONCILIATION';
    }
  }
  return {
    event: 'BRADBURY_V8_STATUS',
    dryRun: true,
    network: reader.network,
    sourceSha256: local.sourceHash,
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    stage: state.stage,
    contractAddress: state.contractAddress,
    bindRequestPath,
    exactReadback: readback,
    nextAction: nextAction(state.stage),
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

function planResult(action, context) {
  return {
    event: 'BRADBURY_V8_DRY_RUN',
    dryRun: true,
    action,
    stage: context.state.stage,
    network: context.reader.network,
    sourceSha256: context.local.sourceHash,
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    contractAddress: context.state.contractAddress,
    initialReserveAtto: context.config.reserve.initialFundingAtto,
    cutsOverApplication: false,
    cutsOverDatabase: false,
    instruction: `re-run the same action with --broadcast only after reviewing this exact plan`,
  };
}

async function deployAction(context, options) {
  const { config, statePath, reader, local } = context;
  if (!['PLANNED', 'DEPLOY_PREPARED'].includes(context.state.stage)
    || context.state.contractAddress) {
    fail('deploy is allowed only from PLANNED with no recorded contract');
  }
  await verifyLocalSchema(reader, local);
  if (!options.broadcast) return planResult('deploy', context);
  let state = prepareOperation(statePath, context.state, 'deploy');
  const nonce = state.operations.deploy.nonce;
  await runSignerChild({
    config,
    configPath: context.configPath,
    statePath,
    action: 'deploy',
    nonce,
    lockToken: context.lockToken,
    ownerLockToken: context.ownerLockToken,
  });
  state = loadState(statePath, config);
  const hash = state.operations.deploy?.transactionHash;
  if (!hash) fail('signer child did not durably record the deployment hash');
  const receipt = await exactRawReceipt(reader, hash, config.operator);
  const contractAddress = assertExactDeploymentReceipt(receipt, {
    hash,
    source: local.source,
    config,
    signedOperation: state.operations.deploy,
  });
  await readAndVerifyDeployment(reader, contractAddress, local, config, {
    payoutsEnabled: false,
    newRiskEnabled: false,
    availableReserveAtto: '0',
  });
  const bindRequest = ensureBindRequestArtifact(statePath, {
    config,
    local,
    operation: state.operations.deploy,
    arenaAddress: contractAddress,
  });
  state = finalizeOperation(
    statePath,
    state,
    'deploy',
    'AWAITING_FACTORY_BIND',
    { contractAddress },
  );
  return {
    event: 'BRADBURY_V8_DEPLOYED_INACTIVE',
    transactionHash: hash,
    contractAddress,
    bindRequestPath: bindRequest.artifactPath,
    stage: state.stage,
    nextAction: nextAction(state.stage),
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

async function fundAction(context, options) {
  const { config, statePath, reader, local } = context;
  if (!['AWAITING_FACTORY_BIND', 'RESERVE_FUND_PREPARED'].includes(context.state.stage)) {
    fail('fund is allowed only after exact deployment readback and before activation');
  }
  if (!context.state.contractAddress) fail('fund requires a recorded V8 contract');
  const bindProof = loadAndValidateBindProof(
    options.bindProofPath,
    config,
    context.state.contractAddress,
  );
  await verifyFactoryBindOnBradbury(
    reader,
    bindProof,
    config,
    context.state.contractAddress,
  );
  await readAndVerifyDeployment(reader, context.state.contractAddress, local, config, {
    payoutsEnabled: false,
    newRiskEnabled: false,
    availableReserveAtto: '0',
  });
  if (!options.broadcast) return planResult('fund', context);
  let state = prepareOperation(statePath, context.state, 'fund');
  const nonce = state.operations.fund.nonce;
  await runSignerChild({
    config,
    configPath: context.configPath,
    statePath,
    action: 'fund',
    nonce,
    lockToken: context.lockToken,
    ownerLockToken: context.ownerLockToken,
    bindProofPath: options.bindProofPath,
  });
  state = loadState(statePath, config);
  const hash = state.operations.fund?.transactionHash;
  if (!hash) fail('signer child did not durably record the reserve-funding hash');
  const receipt = await exactRawReceipt(reader, hash, config.operator);
  assertExactCallReceipt(receipt, {
    hash,
    sender: config.expected.ownerAddress,
    contractAddress: state.contractAddress,
    method: 'fund_delivery_reserve',
    valueAtto: config.reserve.initialFundingAtto,
    signedOperation: state.operations.fund,
    config,
  });
  await readAndVerifyDeployment(reader, state.contractAddress, local, config, {
    payoutsEnabled: false,
    newRiskEnabled: false,
    availableReserveAtto: config.reserve.initialFundingAtto,
  });
  state = finalizeOperation(statePath, state, 'fund', 'RESERVE_FUNDED');
  return {
    event: 'BRADBURY_V8_RESERVE_FUNDED',
    transactionHash: hash,
    contractAddress: state.contractAddress,
    availableReserveAtto: config.reserve.initialFundingAtto,
    stage: state.stage,
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

async function broadcastPause(context, state, options, pauseAccountingIdentity) {
  const { config, statePath, reader, local } = context;
  state = prepareOperation(statePath, state, 'pause', { pauseAccountingIdentity });
  const nonce = state.operations.pause.nonce;
  await runSignerChild({
    config,
    configPath: context.configPath,
    statePath,
    action: 'pause',
    nonce,
    lockToken: context.lockToken,
    ownerLockToken: context.ownerLockToken,
    bindProofPath: options.bindProofPath,
  });
  state = loadState(statePath, config);
  const hash = state.operations.pause?.transactionHash;
  if (!hash) fail('signer child did not durably record the pause hash');
  const receipt = await exactRawReceipt(reader, hash, config.operator);
  assertExactCallReceipt(receipt, {
    hash,
    sender: config.expected.ownerAddress,
    contractAddress: state.contractAddress,
    method: 'pause_new_risk',
    valueAtto: '0',
    signedOperation: state.operations.pause,
    config,
  });
  const pausedReadback = await readAndVerifyPauseState(
    reader,
    state.contractAddress,
    local,
    config,
    { newRiskEnabled: false },
  );
  assertPauseAccountingContinuity(
    state.operations.pause.pauseAccountingIdentity,
    pausedReadback.accounting,
  );
  return finalizeOperation(statePath, state, 'pause', ACTIVATION_TERMINAL_STAGE);
}

async function activateAction(context, options) {
  const { config, statePath, reader, local } = context;
  if (!['RESERVE_FUNDED', 'ACTIVATION_PREPARED'].includes(context.state.stage)) {
    fail('activate is allowed only after exact reserve funding');
  }
  const bindProof = loadAndValidateBindProof(
    options.bindProofPath,
    config,
    context.state.contractAddress,
  );
  await verifyFactoryBindOnBradbury(
    reader,
    bindProof,
    config,
    context.state.contractAddress,
  );
  await readAndVerifyDeployment(reader, context.state.contractAddress, local, config, {
    payoutsEnabled: false,
    newRiskEnabled: false,
    availableReserveAtto: config.reserve.initialFundingAtto,
  });
  if (!options.broadcast) return planResult('activate', context);
  let state = prepareOperation(statePath, context.state, 'activate');
  const nonce = state.operations.activate.nonce;
  await runSignerChild({
    config,
    configPath: context.configPath,
    statePath,
    action: 'activate',
    nonce,
    lockToken: context.lockToken,
    ownerLockToken: context.ownerLockToken,
    bindProofPath: options.bindProofPath,
  });
  state = loadState(statePath, config);
  const activationHash = state.operations.activate?.transactionHash;
  if (!activationHash) fail('signer child did not durably record the activation hash');
  const activationReceipt = await exactRawReceipt(reader, activationHash, config.operator);
  assertExactCallReceipt(activationReceipt, {
    hash: activationHash,
    sender: config.expected.ownerAddress,
    contractAddress: state.contractAddress,
    method: 'activate_payouts',
    valueAtto: '0',
    signedOperation: state.operations.activate,
    config,
  });
  // V8 activation intentionally enables the payout subsystem without opening
  // any new epoch/wager risk. A resume-risk write is outside this harness.
  await readAndVerifyDeployment(
    reader,
    state.contractAddress,
    local,
    config,
    activationTerminalReadback(config),
  );
  state = finalizeOperation(
    statePath,
    state,
    'activate',
    ACTIVATION_TERMINAL_STAGE,
  );
  return {
    event: 'BRADBURY_V8_PAYOUTS_ACTIVATED_RISK_REMAINS_PAUSED',
    activationTransactionHash: activationHash,
    contractAddress: state.contractAddress,
    stage: state.stage,
    newRiskEnabled: false,
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

async function emergencyPauseAction(context, options) {
  if (!context.state.contractAddress) fail('pause requires a recorded V8 contract');
  const unresolved = unresolvedOperationEntries(context.state);
  const cleanPreparedPause = unresolved.length === 1
    && unresolved[0][0] === 'pause'
    && unresolved[0][1].status === 'PREPARED'
    && unresolved[0][1].transactionHash === null
    && unresolved[0][1].signedEvmTransaction === undefined
    && unresolved[0][1].evmTransactionHash === undefined
    && context.state.stage === 'PAUSE_PREPARED';
  if (unresolved.length > 0 && !cleanPreparedPause) {
    fail('pause cannot bypass unresolved durable state; run reconcile first');
  }
  const liveConfig = await context.reader.call(context.state.contractAddress, 'get_config');
  const normalized = normalizeConfigReadback(liveConfig);
  if (normalized.owner !== context.config.expected.ownerAddress
    || normalized.protocol_version !== V8_PROTOCOL_VERSION) {
    fail('emergency pause target is not the exact owned V8 contract');
  }
  if (normalized.new_risk_enabled === false) {
    if (cleanPreparedPause) {
      if (!options.broadcast) {
        return {
          ...planResult('pause', context),
          instruction: 're-run pause with --broadcast to close the clean PREPARED record from exact paused readback; no transaction will be sent',
        };
      }
      const pausedReadback = await readAndVerifyPauseState(
        context.reader,
        context.state.contractAddress,
        context.local,
        context.config,
        { newRiskEnabled: false },
      );
      const pause = context.state.operations.pause;
      assertPauseAccountingContinuity(
        pause.pauseAccountingIdentity,
        pausedReadback.accounting,
      );
      const state = writeStateAtomic(context.statePath, {
        ...context.state,
        stage: ACTIVATION_TERMINAL_STAGE,
        operations: {
          ...context.state.operations,
          pause: {
            ...pause,
            status: 'FAILED',
            failure: 'NO_TRANSACTION_BROADCAST; EXACT_PAUSED_READBACK',
          },
        },
      });
      return {
        event: 'BRADBURY_V8_PREPARED_PAUSE_CLOSED_FROM_EXACT_READBACK',
        contractAddress: state.contractAddress,
        stage: state.stage,
        transactionBroadcast: false,
        cutsOverApplication: false,
        cutsOverDatabase: false,
      };
    }
    await readAndVerifyPauseState(
      context.reader,
      context.state.contractAddress,
      context.local,
      context.config,
      { newRiskEnabled: false },
    );
    return { event: 'BRADBURY_V8_ALREADY_PAUSED', contractAddress: context.state.contractAddress };
  }
  if (normalized.payouts_enabled !== true || normalized.new_risk_enabled !== true) {
    fail('emergency pause readback has an impossible activation state');
  }
  const prePauseReadback = await readAndVerifyPauseState(
    context.reader,
    context.state.contractAddress,
    context.local,
    context.config,
    { newRiskEnabled: true },
  );
  if (!options.broadcast) return planResult('pause', context);
  const state = await broadcastPause(
    context,
    context.state,
    options,
    prePauseReadback.accounting,
  );
  return {
    event: 'BRADBURY_V8_EMERGENCY_PAUSED',
    transactionHash: state.operations.pause.transactionHash,
    contractAddress: state.contractAddress,
    stage: state.stage,
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

function assertStoredEvmEvidence(operation, evidence) {
  if (operation.evmTransactionHash !== evidence.evmTransactionHash
    || operation.genlayerTransactionHash !== evidence.genlayerTransactionHash
    || operation.evmReceiptBlockHash !== evidence.blockHash
    || operation.evmReceiptBlockNumber !== evidence.blockNumber
    || operation.evmReceiptEventTopic !== evidence.eventTopic
    || operation.evmReceiptLogIndex !== evidence.logIndex) {
    fail('stored EVM confirmation evidence no longer matches the exact Bradbury receipt');
  }
  if (operation.transactionHash !== null
    && operation.transactionHash !== undefined
    && operation.transactionHash !== evidence.genlayerTransactionHash) {
    fail('stored submitted GenLayer transaction id diverges from the Bradbury EVM event');
  }
}

function oneUnresolvedOperation(state) {
  const unresolved = unresolvedOperationEntries(state);
  if (unresolved.length !== 1) {
    fail(`reconcile requires exactly one unresolved signed operation; found ${unresolved.length}`);
  }
  const [[type, operation]] = unresolved;
  if (!['SIGNED', 'EVM_CONFIRMED', 'SUBMITTED'].includes(operation.status)) {
    fail(`reconcile cannot replay unsigned ${operation.status} state; re-run the original dry-run action`);
  }
  if (!Object.hasOwn(SIGNED_STAGE, type)) fail(`state contains unknown operation type ${type}`);
  const expectedStage = {
    SIGNED: SIGNED_STAGE[type],
    EVM_CONFIRMED: EVM_CONFIRMED_STAGE[type],
    SUBMITTED: SUBMITTED_STAGE[type],
  }[operation.status];
  if (state.stage !== expectedStage) {
    fail(`state stage does not match its unresolved ${type} operation`);
  }
  return { type, operation };
}

async function finalizeReconciledOperation(context, state, type) {
  const { config, statePath, reader, local } = context;
  const operation = state.operations[type];
  const hash = operation.transactionHash;
  const receipt = await exactRawReceipt(reader, hash, config.operator);

  if (type === 'deploy') {
    const contractAddress = assertExactDeploymentReceipt(receipt, {
      hash,
      source: local.source,
      config,
      signedOperation: operation,
    });
    await readAndVerifyDeployment(reader, contractAddress, local, config, {
      payoutsEnabled: false,
      newRiskEnabled: false,
      availableReserveAtto: '0',
    });
    const bindRequest = ensureBindRequestArtifact(statePath, {
      config,
      local,
      operation,
      arenaAddress: contractAddress,
    });
    state = finalizeOperation(
      statePath,
      state,
      type,
      'AWAITING_FACTORY_BIND',
      { contractAddress },
    );
    return {
      event: 'BRADBURY_V8_DEPLOY_RECONCILED_INACTIVE',
      transactionHash: hash,
      contractAddress,
      bindRequestPath: bindRequest.artifactPath,
      stage: state.stage,
      nextAction: nextAction(state.stage),
      cutsOverApplication: false,
      cutsOverDatabase: false,
    };
  }

  const call = {
    fund: { method: 'fund_delivery_reserve', valueAtto: config.reserve.initialFundingAtto },
    activate: { method: 'activate_payouts', valueAtto: '0' },
    pause: { method: 'pause_new_risk', valueAtto: '0' },
  }[type];
  assertExactCallReceipt(receipt, {
    hash,
    sender: config.expected.ownerAddress,
    contractAddress: state.contractAddress,
    method: call.method,
    valueAtto: call.valueAtto,
    signedOperation: operation,
    config,
  });

  if (type === 'fund') {
    await readAndVerifyDeployment(reader, state.contractAddress, local, config, {
      payoutsEnabled: false,
      newRiskEnabled: false,
      availableReserveAtto: config.reserve.initialFundingAtto,
    });
    state = finalizeOperation(statePath, state, type, 'RESERVE_FUNDED');
    return {
      event: 'BRADBURY_V8_RESERVE_FUND_RECONCILED',
      transactionHash: hash,
      contractAddress: state.contractAddress,
      stage: state.stage,
      cutsOverApplication: false,
      cutsOverDatabase: false,
    };
  }

  if (type === 'pause') {
    const pausedReadback = await readAndVerifyPauseState(
      reader,
      state.contractAddress,
      local,
      config,
      { newRiskEnabled: false },
    );
    assertPauseAccountingContinuity(
      operation.pauseAccountingIdentity,
      pausedReadback.accounting,
    );
    state = finalizeOperation(statePath, state, type, ACTIVATION_TERMINAL_STAGE);
    return {
      event: 'BRADBURY_V8_PAUSE_RECONCILED',
      transactionHash: hash,
      contractAddress: state.contractAddress,
      stage: state.stage,
      cutsOverApplication: false,
      cutsOverDatabase: false,
    };
  }

  await readAndVerifyDeployment(
    reader,
    state.contractAddress,
    local,
    config,
    activationTerminalReadback(config),
  );
  state = finalizeOperation(
    statePath,
    state,
    type,
    ACTIVATION_TERMINAL_STAGE,
  );
  return {
    event: 'BRADBURY_V8_ACTIVATION_RECONCILED_RISK_REMAINS_PAUSED',
    activationTransactionHash: hash,
    contractAddress: state.contractAddress,
    stage: state.stage,
    cutsOverApplication: false,
    cutsOverDatabase: false,
  };
}

async function reconcileAction(context, options) {
  const { type, operation } = oneUnresolvedOperation(context.state);
  if (['fund', 'activate'].includes(type)) {
    const bindProof = loadAndValidateBindProof(
      options.bindProofPath,
      context.config,
      context.state.contractAddress,
    );
    await verifyFactoryBindOnBradbury(
      context.reader,
      bindProof,
      context.config,
      context.state.contractAddress,
    );
  }
  const evidence = await reconcileEvmSubmission({
    reader: context.reader,
    operation: { ...operation, status: 'SIGNED' },
    config: context.config,
    action: type,
    state: context.state,
    local: context.local,
    broadcast: options.broadcast,
  });
  if (!evidence) {
    return {
      event: 'BRADBURY_V8_SIGNED_EVM_TRANSACTION_NOT_FOUND',
      dryRun: true,
      operation: type,
      evmTransactionHash: operation.evmTransactionHash,
      instruction: 're-run reconcile with --broadcast to replay only the exact stored raw transaction',
      cutsOverApplication: false,
      cutsOverDatabase: false,
    };
  }

  let state = context.state;
  if (operation.status === 'SIGNED') {
    state = recordEvmReceiptEvidence(
      context.statePath,
      state,
      type,
      operation.nonce,
      evidence,
    );
  } else {
    assertStoredEvmEvidence(operation, evidence);
  }
  if (state.operations[type].status === 'EVM_CONFIRMED') {
    state = recordSubmittedOperation(
      context.statePath,
      state,
      type,
      operation.nonce,
      evidence.genlayerTransactionHash,
    );
  }
  return finalizeReconciledOperation(context, state, type);
}

function parseArguments(argv) {
  const args = [...argv];
  const result = {
    action: 'status',
    configPath: null,
    statePath: null,
    bindProofPath: null,
    broadcast: false,
    help: false,
  };
  if (args[0] && !args[0].startsWith('--')) result.action = args.shift();
  while (args.length > 0) {
    const option = args.shift();
    if (option === '--broadcast') result.broadcast = true;
    else if (option === '--help' || option === '-h') result.help = true;
    else if (['--config', '--state', '--bind-proof'].includes(option)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) fail(`${option} requires a value`);
      if (option === '--config') result.configPath = value;
      else if (option === '--state') result.statePath = value;
      else result.bindProofPath = value;
    } else fail(`unknown option ${option}`);
  }
  if (!['status', 'deploy', 'fund', 'activate', 'pause', 'reconcile'].includes(result.action)) {
    fail(`unknown action ${result.action}`);
  }
  if (result.action === 'status' && result.broadcast) fail('status never accepts --broadcast');
  if (['fund', 'activate'].includes(result.action) && !result.bindProofPath) {
    fail(`${result.action} requires --bind-proof from the delegated EVM utility`);
  }
  return result;
}

export function helpText() {
  return `Bradbury-only Liquidity Arena V8 deployment canary (never app/DB cutover).\n\nUsage:\n  node ops/bradbury-v8/harness.mjs [status] --config <file> [--state <file>]\n  node ops/bradbury-v8/harness.mjs deploy --config <file> [--broadcast]\n  node ops/bradbury-v8/harness.mjs fund --config <file> --bind-proof <file> [--broadcast]\n  node ops/bradbury-v8/harness.mjs activate --config <file> --bind-proof <file> [--broadcast]\n  node ops/bradbury-v8/harness.mjs pause --config <file> [--broadcast]\n  node ops/bradbury-v8/harness.mjs reconcile --config <file> [--bind-proof <file>] [--broadcast]\n\nNo action broadcasts without the literal --broadcast flag. status is the default and is read-only.\nActivation enables payouts while new risk remains paused; this harness exposes no resume-risk or cutover command.\nreconcile inspects the exact stored EVM hash first; --broadcast can only replay its exact stored signed bytes.\nThe exact-state lock serializes its state file; the canonical owner lock coordinates the reviewed harness/factory/bind tools across checkouts under one user profile. It cannot coordinate external or unreviewed writers. Verify PID/owner inactivity before manually removing a crash-stale lock.\nThe SDK is pinned to testnet-bradbury/chain 4221 and never changes the global GenLayer CLI network.\nLocked-keystore passwords use GENLAYER_KEYSTORE_PASSWORD only in the parent and are sent to the signer child over stdin; they are never arguments or logs.`;
}

export async function runHarness(argv, dependencies = {}) {
  const options = parseArguments(argv);
  if (options.help) return { help: helpText() };
  if (!options.configPath) fail('--config is required');
  const loaded = loadConfig(options.configPath);
  const config = loaded.config;
  const local = verifyLocalCandidate(config, dependencies);
  const reader = dependencies.reader ?? createBradburyReader(dependencies);
  const statePath = statePathFor(loaded.absolutePath, config, options.statePath);
  const requiresLock = options.broadcast || options.action === 'reconcile';
  const ownerLock = requiresLock ? acquireOwnerLock(config) : null;
  let lock = null;
  try {
    lock = requiresLock ? acquireStateLock(statePath) : null;
  } catch (error) {
    ownerLock?.release();
    throw error;
  }
  try {
    const state = loadState(statePath, config);
    const context = {
      config,
      configPath: loaded.absolutePath,
      local,
      reader,
      state,
      statePath,
      lockToken: lock?.token ?? null,
      ownerLockToken: ownerLock?.token ?? null,
    };
    if (options.action === 'status') return statusAction(context);
    if (options.action === 'deploy') return deployAction(context, options);
    if (options.action === 'fund') return fundAction(context, options);
    if (options.action === 'activate') return activateAction(context, options);
    if (options.action === 'reconcile') return reconcileAction(context, options);
    return emergencyPauseAction(context, options);
  } finally {
    try {
      lock?.release();
    } finally {
      ownerLock?.release();
    }
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runHarness(process.argv.slice(2)).then((result) => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: 'BRADBURY_V8_HARNESS_REFUSED',
      message: error instanceof Error ? error.message : String(error),
      cutsOverApplication: false,
      cutsOverDatabase: false,
    })}\n`);
    process.exitCode = 1;
  });
}
