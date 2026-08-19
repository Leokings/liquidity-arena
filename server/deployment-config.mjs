export const STUDIONET_NETWORK = 'studionet';
export const STUDIONET_CHAIN_ID = '0xf22f';
export const DEFAULT_STUDIONET_RPC_URL = 'https://studio.genlayer.com/api';
export const LIQUIDITY_ARENA_V6_PROTOCOL = 'LIQUIDITY_ARENA_V6';
export const LIQUIDITY_ARENA_V7_PROTOCOL = 'LIQUIDITY_ARENA_V7';
export const LIQUIDITY_ARENA_POLICY = 'CRYPTO_SPOT_1M_MEDIAN_V1';

const SUPPORTED_PROTOCOLS = new Set([
  LIQUIDITY_ARENA_V6_PROTOCOL,
  LIQUIDITY_ARENA_V7_PROTOCOL,
]);
const MAX_LEGACY_V6_CONTRACTS = 8;
const MAX_U256 = (1n << 256n) - 1n;

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

function contractAddressKey(value, label = 'contract address') {
  return normalizedContractAddress(value, label).toLowerCase();
}

function sameContractAddress(left, right) {
  return contractAddressKey(left) === contractAddressKey(right);
}

function normalizedRpcUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('GENLAYER_RPC_URL must be an absolute HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('GENLAYER_RPC_URL must be an absolute HTTPS URL without embedded credentials.');
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

function optionalAddress(environment, name) {
  const value = String(environment?.[name] || '').trim();
  return value ? normalizedContractAddress(value, name) : '';
}

function deploymentRegistry(environment, protocolVersion, activeAddress) {
  const requestedAlias = String(environment?.VITE_GENLAYER_ACTIVE_DEPLOYMENT || '')
    .trim()
    .toLowerCase();
  if (requestedAlias && requestedAlias !== 'v6' && requestedAlias !== 'v7') {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT must be v6 or v7.');
  }
  const v6Address = optionalAddress(environment, 'VITE_GENLAYER_V6_CONTRACT');
  const v7Address = optionalAddress(environment, 'VITE_GENLAYER_V7_CONTRACT');
  const expectedAlias = protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL ? 'v7' : 'v6';
  if (requestedAlias && requestedAlias !== expectedAlias) {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT must match VITE_GENLAYER_PROTOCOL.');
  }
  if (v7Address && !requestedAlias) {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT is required when V7 is configured.');
  }
  if (v7Address && !v6Address) {
    throw new Error('VITE_GENLAYER_V6_CONTRACT is required when V7 is configured.');
  }
  if (v6Address && v7Address && sameContractAddress(v6Address, v7Address)) {
    throw new Error('V6 and V7 contract addresses must differ.');
  }
  if (protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL) {
    if (requestedAlias !== 'v7') {
      throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT must be v7 for an active V7 deployment.');
    }
    if (!v7Address || !sameContractAddress(v7Address, activeAddress)) {
      throw new Error('VITE_GENLAYER_V7_CONTRACT must match the active V7 contract.');
    }
    if (!v6Address) throw new Error('An allowlisted legacy V6 contract is required for V7 cutover.');
  } else if (v6Address && !sameContractAddress(v6Address, activeAddress)) {
    throw new Error('VITE_GENLAYER_V6_CONTRACT must match the active V6 contract.');
  }
  return Object.freeze({
    activeAlias: requestedAlias || 'v6',
    v6Address: v6Address || (protocolVersion === LIQUIDITY_ARENA_V6_PROTOCOL ? activeAddress : ''),
    v7Address,
  });
}

function legacyV6Allowlist(environment, activeAddress, primaryLegacyAddress = '') {
  const raw = String(environment?.GENLAYER_LEGACY_V6_CONTRACTS || '').trim();
  const entries = [
    ...(primaryLegacyAddress ? [primaryLegacyAddress] : []),
    ...(raw ? raw.split(',').map((entry, index) => normalizedContractAddress(
      entry,
      `GENLAYER_LEGACY_V6_CONTRACTS entry ${index + 1}`,
    )) : []),
  ];
  if (entries.length > MAX_LEGACY_V6_CONTRACTS) {
    throw new Error(`GENLAYER_LEGACY_V6_CONTRACTS supports at most ${MAX_LEGACY_V6_CONTRACTS} addresses.`);
  }
  if (new Set(entries.map((entry) => contractAddressKey(entry))).size !== entries.length) {
    throw new Error('GENLAYER_LEGACY_V6_CONTRACTS must not contain duplicates.');
  }
  if (entries.some((entry) => sameContractAddress(entry, activeAddress))) {
    throw new Error('The active contract cannot also be a legacy V6 contract.');
  }
  return Object.freeze(entries);
}

function v7Expectations(environment) {
  const minimumStakeAtto = normalizedAtto(
    requiredText(environment, 'GENLAYER_V7_MIN_STAKE_ATTO'),
    'GENLAYER_V7_MIN_STAKE_ATTO',
    { positive: true },
  );
  const maximumStakePerWalletAtto = normalizedAtto(
    requiredText(environment, 'GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO'),
    'GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO',
    { positive: true },
  );
  if (BigInt(maximumStakePerWalletAtto) < BigInt(minimumStakeAtto)) {
    throw new Error('GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO must be at least GENLAYER_V7_MIN_STAKE_ATTO.');
  }
  return Object.freeze({
    owner: normalizedContractAddress(
      requiredText(environment, 'GENLAYER_V7_OWNER'),
      'GENLAYER_V7_OWNER',
    ),
    keeper: normalizedContractAddress(
      requiredText(environment, 'GENLAYER_V7_KEEPER'),
      'GENLAYER_V7_KEEPER',
    ),
    treasury: normalizedContractAddress(
      requiredText(environment, 'GENLAYER_V7_TREASURY'),
      'GENLAYER_V7_TREASURY',
    ),
    minimumStakeAtto,
    maximumStakePerWalletAtto,
  });
}

export function loadLiquidityArenaDeploymentConfig(
  environment = process.env,
  { defaultRpcUrl = DEFAULT_STUDIONET_RPC_URL } = {},
) {
  const network = String(environment?.VITE_GENLAYER_NETWORK || '').trim();
  if (network !== STUDIONET_NETWORK) {
    throw new Error('VITE_GENLAYER_NETWORK must be "studionet".');
  }
  const protocolVersion = String(environment?.VITE_GENLAYER_PROTOCOL || '').trim().toUpperCase();
  if (!SUPPORTED_PROTOCOLS.has(protocolVersion)) {
    throw new Error('VITE_GENLAYER_PROTOCOL must be LIQUIDITY_ARENA_V6 or LIQUIDITY_ARENA_V7.');
  }
  const activeAddress = normalizedContractAddress(
    requiredText(environment, 'VITE_GENLAYER_CONTRACT'),
    'VITE_GENLAYER_CONTRACT',
  );
  const configuredRpc = String(environment?.GENLAYER_RPC_URL || '').trim();
  const registry = deploymentRegistry(environment, protocolVersion, activeAddress);
  const config = {
    genLayerNetwork: STUDIONET_NETWORK,
    genLayerChainId: STUDIONET_CHAIN_ID,
    genLayerRpcUrl: normalizedRpcUrl(configuredRpc || defaultRpcUrl),
    expectedContractProtocol: protocolVersion,
    contractAddress: activeAddress,
    activeContract: Object.freeze({
      address: activeAddress,
      protocolVersion,
      policyVersion: LIQUIDITY_ARENA_POLICY,
    }),
    activeDeployment: registry.activeAlias,
    v6ContractAddress: registry.v6Address,
    v7ContractAddress: registry.v7Address,
    legacyV6Contracts: legacyV6Allowlist(
      environment,
      activeAddress,
      protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL ? registry.v6Address : '',
    ),
    v7Expectations: protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL
      ? v7Expectations(environment)
      : null,
  };
  return Object.freeze(config);
}

export function assertLiquidityArenaDeploymentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Liquidity Arena deployment configuration is required.');
  }
  if (config.genLayerNetwork !== STUDIONET_NETWORK
    || String(config.genLayerChainId || '').toLowerCase() !== STUDIONET_CHAIN_ID) {
    throw new Error('Configured GenLayer network must be StudioNet chain 0xf22f.');
  }
  normalizedRpcUrl(config.genLayerRpcUrl);
  const activeAddress = normalizedContractAddress(config.contractAddress, 'VITE_GENLAYER_CONTRACT');
  const protocolVersion = String(config.expectedContractProtocol || '').trim().toUpperCase();
  if (!SUPPORTED_PROTOCOLS.has(protocolVersion)) {
    throw new Error('Configured active contract protocol is unsupported.');
  }
  if (!sameContractAddress(config.activeContract?.address, activeAddress)
    || config.activeContract?.protocolVersion !== protocolVersion
    || config.activeContract?.policyVersion !== LIQUIDITY_ARENA_POLICY) {
    throw new Error('Active contract deployment configuration is inconsistent.');
  }
  const expectedAlias = protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL ? 'v7' : 'v6';
  if (config.activeDeployment !== expectedAlias) {
    throw new Error('Active deployment alias does not match the contract protocol.');
  }
  const v6Address = config.v6ContractAddress
    ? normalizedContractAddress(config.v6ContractAddress, 'VITE_GENLAYER_V6_CONTRACT')
    : '';
  const v7Address = config.v7ContractAddress
    ? normalizedContractAddress(config.v7ContractAddress, 'VITE_GENLAYER_V7_CONTRACT')
    : '';
  if (protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL
    && (!sameContractAddress(v7Address, activeAddress)
      || !v6Address
      || sameContractAddress(v6Address, activeAddress))) {
    throw new Error('V7 cutover deployment registry is inconsistent.');
  }
  if (protocolVersion === LIQUIDITY_ARENA_V6_PROTOCOL
    && !sameContractAddress(v6Address, activeAddress)) {
    throw new Error('V6 compatibility deployment registry is inconsistent.');
  }
  if (!Array.isArray(config.legacyV6Contracts)) {
    throw new Error('Legacy V6 contract allowlist is invalid.');
  }
  const legacy = config.legacyV6Contracts.map((entry) => normalizedContractAddress(entry));
  const legacyKeys = legacy.map((entry) => contractAddressKey(entry));
  if (legacy.length > MAX_LEGACY_V6_CONTRACTS
    || new Set(legacyKeys).size !== legacy.length
    || legacy.some((entry) => sameContractAddress(entry, activeAddress))
    || (protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL
      && !legacy.some((entry) => sameContractAddress(entry, v6Address)))) {
    throw new Error('Legacy V6 contract allowlist is invalid.');
  }
  if (protocolVersion === LIQUIDITY_ARENA_V7_PROTOCOL) {
    const expected = config.v7Expectations;
    normalizedContractAddress(expected?.owner, 'GENLAYER_V7_OWNER');
    normalizedContractAddress(expected?.keeper, 'GENLAYER_V7_KEEPER');
    normalizedContractAddress(expected?.treasury, 'GENLAYER_V7_TREASURY');
    const minimum = normalizedAtto(expected?.minimumStakeAtto, 'GENLAYER_V7_MIN_STAKE_ATTO', {
      positive: true,
    });
    const maximum = normalizedAtto(
      expected?.maximumStakePerWalletAtto,
      'GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO',
      { positive: true },
    );
    if (BigInt(maximum) < BigInt(minimum)) throw new Error('Configured V7 stake policy is invalid.');
  } else if (config.v7Expectations !== null) {
    throw new Error('V6-only mode must not contain V7 expectations.');
  }
  return config;
}
