export const BRADBURY_NETWORK = 'testnet-bradbury';
export const BRADBURY_CHAIN_ID_NUMBER = 4_221;
export const BRADBURY_CHAIN_ID = '0x107d';
export const DEFAULT_BRADBURY_RPC_URL = 'https://rpc-bradbury.genlayer.com/';
export const LIQUIDITY_ARENA_V8_PROTOCOL = 'LIQUIDITY_ARENA_V8';
export const LIQUIDITY_ARENA_POLICY = 'CRYPTO_SPOT_1M_MEDIAN_V1';
export const LIQUIDITY_ARENA_PAYOUT_PROTOCOL = 'IDEMPOTENT_EVM_VAULT_V1';
export const AUDITED_PAYOUT_FACTORY_4221 = '0x944fdadd826c2a159c63cb100db174716ccd1317';

const MAX_U256 = (1n << 256n) - 1n;
const LEGACY_ENVIRONMENT_KEYS = Object.freeze([
  'GENLAYER_LEGACY_V6_CONTRACTS',
  'GENLAYER_V6_CONTRACT',
  'GENLAYER_V7_KEEPER',
  'GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO',
  'GENLAYER_V7_MIN_STAKE_ATTO',
  'GENLAYER_V7_OWNER',
  'GENLAYER_V7_TREASURY',
  'VITE_GENLAYER_V6_CONTRACT',
  'VITE_GENLAYER_V7_CONTRACT',
]);

function requiredText(environment, name) {
  const value = String(environment?.[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function normalizedContractAddress(value, label = 'contract address') {
  const address = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error(`${label} must be a non-zero 20-byte hex address.`);
  }
  return address;
}

function addressKey(value, label = 'contract address') {
  return normalizedContractAddress(value, label).toLowerCase();
}

function sameAddress(left, right) {
  return addressKey(left) === addressKey(right);
}

function normalizedRpcUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('GENLAYER_RPC_URL must be an absolute HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('GENLAYER_RPC_URL must be an absolute HTTPS URL without credentials or a fragment.');
  }
  return url.href;
}

export function normalizedAtto(value, label, { positive = false } = {}) {
  const text = typeof value === 'bigint' ? value.toString() : String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be an unsigned base-10 integer.`);
  const amount = BigInt(text);
  if (amount > MAX_U256) throw new Error(`${label} exceeds uint256.`);
  if (positive && amount === 0n) throw new Error(`${label} must be positive.`);
  return amount.toString();
}

function requireNoLegacyConfiguration(environment) {
  const stale = LEGACY_ENVIRONMENT_KEYS.filter((name) => String(environment?.[name] || '').trim());
  if (stale.length > 0) {
    throw new Error(`Legacy V6/V7 deployment variables are forbidden: ${stale.join(', ')}.`);
  }
}

function exactAuditedFactory(value) {
  const factory = normalizedContractAddress(value, 'GENLAYER_V8_PAYOUT_FACTORY');
  if (!sameAddress(factory, AUDITED_PAYOUT_FACTORY_4221)) {
    throw new Error('GENLAYER_V8_PAYOUT_FACTORY must be the audited Bradbury factory.');
  }
  return factory;
}

function v8Expectations(environment) {
  const minimumStakeAtto = normalizedAtto(
    requiredText(environment, 'GENLAYER_V8_MIN_STAKE_ATTO'),
    'GENLAYER_V8_MIN_STAKE_ATTO',
    { positive: true },
  );
  const maximumStakePerWalletAtto = normalizedAtto(
    requiredText(environment, 'GENLAYER_V8_MAX_STAKE_PER_WALLET_ATTO'),
    'GENLAYER_V8_MAX_STAKE_PER_WALLET_ATTO',
    { positive: true },
  );
  if (BigInt(maximumStakePerWalletAtto) < BigInt(minimumStakeAtto)) {
    throw new Error('GENLAYER_V8_MAX_STAKE_PER_WALLET_ATTO must be at least GENLAYER_V8_MIN_STAKE_ATTO.');
  }
  return Object.freeze({
    owner: normalizedContractAddress(requiredText(environment, 'GENLAYER_V8_OWNER'), 'GENLAYER_V8_OWNER'),
    keeper: normalizedContractAddress(requiredText(environment, 'GENLAYER_V8_KEEPER'), 'GENLAYER_V8_KEEPER'),
    treasury: normalizedContractAddress(requiredText(environment, 'GENLAYER_V8_TREASURY'), 'GENLAYER_V8_TREASURY'),
    payoutFactory: exactAuditedFactory(requiredText(environment, 'GENLAYER_V8_PAYOUT_FACTORY')),
    minimumStakeAtto,
    maximumStakePerWalletAtto,
    minimumAvailableReserveAtto: normalizedAtto(
      requiredText(environment, 'GENLAYER_V8_MIN_AVAILABLE_RESERVE_ATTO'),
      'GENLAYER_V8_MIN_AVAILABLE_RESERVE_ATTO',
      { positive: true },
    ),
  });
}

export function loadLiquidityArenaDeploymentConfig(
  environment = process.env,
  { defaultRpcUrl = DEFAULT_BRADBURY_RPC_URL } = {},
) {
  requireNoLegacyConfiguration(environment);
  if (String(environment?.VITE_GENLAYER_NETWORK || '').trim() !== BRADBURY_NETWORK) {
    throw new Error('VITE_GENLAYER_NETWORK must be "testnet-bradbury".');
  }
  if (String(environment?.VITE_GENLAYER_PROTOCOL || '').trim().toUpperCase()
    !== LIQUIDITY_ARENA_V8_PROTOCOL) {
    throw new Error('VITE_GENLAYER_PROTOCOL must be LIQUIDITY_ARENA_V8.');
  }
  if (String(environment?.VITE_GENLAYER_ACTIVE_DEPLOYMENT || '').trim().toLowerCase() !== 'v8') {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT must be v8.');
  }
  const contractAddress = normalizedContractAddress(
    requiredText(environment, 'VITE_GENLAYER_CONTRACT'),
    'VITE_GENLAYER_CONTRACT',
  );
  const v8Address = normalizedContractAddress(
    requiredText(environment, 'VITE_GENLAYER_V8_CONTRACT'),
    'VITE_GENLAYER_V8_CONTRACT',
  );
  if (!sameAddress(contractAddress, v8Address)) {
    throw new Error('VITE_GENLAYER_V8_CONTRACT must match VITE_GENLAYER_CONTRACT.');
  }
  const configuredRpc = String(environment?.GENLAYER_RPC_URL || '').trim();
  const expectations = v8Expectations(environment);
  return Object.freeze({
    genLayerNetwork: BRADBURY_NETWORK,
    genLayerChainId: BRADBURY_CHAIN_ID,
    genLayerChainIdNumber: BRADBURY_CHAIN_ID_NUMBER,
    genLayerRpcUrl: normalizedRpcUrl(configuredRpc || defaultRpcUrl),
    expectedContractProtocol: LIQUIDITY_ARENA_V8_PROTOCOL,
    contractAddress,
    activeContract: Object.freeze({
      address: contractAddress,
      protocolVersion: LIQUIDITY_ARENA_V8_PROTOCOL,
      policyVersion: LIQUIDITY_ARENA_POLICY,
    }),
    activeDeployment: 'v8',
    v8ContractAddress: v8Address,
    v8Expectations: expectations,
  });
}

export function assertLiquidityArenaDeploymentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Liquidity Arena deployment configuration is required.');
  }
  if (config.genLayerNetwork !== BRADBURY_NETWORK
    || String(config.genLayerChainId || '').toLowerCase() !== BRADBURY_CHAIN_ID
    || Number(config.genLayerChainIdNumber) !== BRADBURY_CHAIN_ID_NUMBER) {
    throw new Error('Configured GenLayer network must be Bradbury testnet chain 4221.');
  }
  normalizedRpcUrl(config.genLayerRpcUrl);
  const contractAddress = normalizedContractAddress(config.contractAddress, 'VITE_GENLAYER_CONTRACT');
  if (config.expectedContractProtocol !== LIQUIDITY_ARENA_V8_PROTOCOL
    || config.activeDeployment !== 'v8'
    || !sameAddress(config.v8ContractAddress, contractAddress)
    || !sameAddress(config.activeContract?.address, contractAddress)
    || config.activeContract?.protocolVersion !== LIQUIDITY_ARENA_V8_PROTOCOL
    || config.activeContract?.policyVersion !== LIQUIDITY_ARENA_POLICY) {
    throw new Error('V8-only active deployment configuration is inconsistent.');
  }
  const expected = config.v8Expectations;
  normalizedContractAddress(expected?.owner, 'GENLAYER_V8_OWNER');
  normalizedContractAddress(expected?.keeper, 'GENLAYER_V8_KEEPER');
  normalizedContractAddress(expected?.treasury, 'GENLAYER_V8_TREASURY');
  exactAuditedFactory(expected?.payoutFactory);
  const minimum = normalizedAtto(expected?.minimumStakeAtto, 'GENLAYER_V8_MIN_STAKE_ATTO', { positive: true });
  const maximum = normalizedAtto(
    expected?.maximumStakePerWalletAtto,
    'GENLAYER_V8_MAX_STAKE_PER_WALLET_ATTO',
    { positive: true },
  );
  normalizedAtto(
    expected?.minimumAvailableReserveAtto,
    'GENLAYER_V8_MIN_AVAILABLE_RESERVE_ATTO',
    { positive: true },
  );
  if (BigInt(maximum) < BigInt(minimum)) throw new Error('Configured V8 stake policy is invalid.');
  return config;
}
