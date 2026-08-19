export const DEPLOYMENT_V6 = 'v6';
export const DEPLOYMENT_V7 = 'v7';
export const PROTOCOL_V6 = 'LIQUIDITY_ARENA_V6';
export const PROTOCOL_V7 = 'LIQUIDITY_ARENA_V7';

const ALIASES = Object.freeze([DEPLOYMENT_V6, DEPLOYMENT_V7]);
const ALIAS_SET = new Set(ALIASES);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function environmentText(environment, name) {
  return String(environment?.[name] || '').trim();
}

function normalizedAddress(value, label, { optional = false } = {}) {
  const address = String(value || '').trim();
  if (optional && address === '') return '';
  if (!ADDRESS_PATTERN.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error(`${label} must be a non-zero 20-byte address.`);
  }
  return address;
}

function normalizedProtocol(value, label, { optional = false } = {}) {
  const protocol = String(value || '').trim().toUpperCase();
  if (optional && protocol === '') return '';
  if (protocol !== PROTOCOL_V6 && protocol !== PROTOCOL_V7) {
    throw new Error(`${label} must be ${PROTOCOL_V6} or ${PROTOCOL_V7}.`);
  }
  return protocol;
}

function deployment(alias, address, {
  compatibilityMode = false,
  newWagersEnabled = false,
} = {}) {
  const protocolVersion = alias === DEPLOYMENT_V7 ? PROTOCOL_V7 : PROTOCOL_V6;
  return Object.freeze({
    alias,
    address,
    protocolVersion,
    legacy: alias === DEPLOYMENT_V6 && !compatibilityMode,
    newWagersEnabled,
    claimsEnabled: true,
    timeoutEnabled: true,
  });
}

/**
 * Build a closed deployment registry from Vite's build-time environment.
 *
 * Existing V6 builds remain valid through VITE_GENLAYER_CONTRACT and
 * VITE_GENLAYER_PROTOCOL. A migration build must explicitly name its active
 * alias and provide both immutable contract addresses. This prevents adding
 * an address through a URL or accidentally enabling V7 with a half-updated
 * environment.
 */
export function createDeploymentRegistry(environment = import.meta.env) {
  const configuredProtocol = normalizedProtocol(
    environmentText(environment, 'VITE_GENLAYER_PROTOCOL'),
    'VITE_GENLAYER_PROTOCOL',
    { optional: true },
  );
  const configuredContract = normalizedAddress(
    environmentText(environment, 'VITE_GENLAYER_CONTRACT'),
    'VITE_GENLAYER_CONTRACT',
    { optional: true },
  );
  if (Boolean(configuredProtocol) !== Boolean(configuredContract)) {
    throw new Error('VITE_GENLAYER_PROTOCOL and VITE_GENLAYER_CONTRACT must be configured together.');
  }
  if (!configuredProtocol) {
    throw new Error('VITE_GENLAYER_PROTOCOL and VITE_GENLAYER_CONTRACT are required for the active deployment.');
  }

  let v6Address = normalizedAddress(
    environmentText(environment, 'VITE_GENLAYER_V6_CONTRACT'),
    'VITE_GENLAYER_V6_CONTRACT',
    { optional: true },
  );
  let v7Address = normalizedAddress(
    environmentText(environment, 'VITE_GENLAYER_V7_CONTRACT'),
    'VITE_GENLAYER_V7_CONTRACT',
    { optional: true },
  );
  if (configuredProtocol === PROTOCOL_V6) {
    if (v6Address && v6Address.toLowerCase() !== configuredContract.toLowerCase()) {
      throw new Error('VITE_GENLAYER_CONTRACT disagrees with VITE_GENLAYER_V6_CONTRACT.');
    }
    v6Address ||= configuredContract;
  } else if (configuredProtocol === PROTOCOL_V7) {
    if (v7Address && v7Address.toLowerCase() !== configuredContract.toLowerCase()) {
      throw new Error('VITE_GENLAYER_CONTRACT disagrees with VITE_GENLAYER_V7_CONTRACT.');
    }
    v7Address ||= configuredContract;
  }

  const requestedActiveAlias = environmentText(
    environment,
    'VITE_GENLAYER_ACTIVE_DEPLOYMENT',
  ).toLowerCase();
  if (requestedActiveAlias && !ALIAS_SET.has(requestedActiveAlias)) {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT must be v6 or v7.');
  }
  if (v7Address && !requestedActiveAlias) {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT is required when V7 is configured.');
  }

  const compatibilityMode = !v7Address;
  const activeAlias = requestedActiveAlias || DEPLOYMENT_V6;
  if (!v6Address) throw new Error('A V6 compatibility or legacy contract address is required.');
  if (activeAlias === DEPLOYMENT_V7 && !v7Address) {
    throw new Error('The active V7 deployment has no configured contract address.');
  }
  if (v7Address && v6Address.toLowerCase() === v7Address.toLowerCase()) {
    throw new Error('V6 and V7 must use different contract addresses.');
  }

  const entries = new Map();
  entries.set(DEPLOYMENT_V6, deployment(DEPLOYMENT_V6, v6Address, {
    compatibilityMode,
    newWagersEnabled: compatibilityMode && activeAlias === DEPLOYMENT_V6,
  }));
  if (v7Address) {
    entries.set(DEPLOYMENT_V7, deployment(DEPLOYMENT_V7, v7Address, {
      newWagersEnabled: activeAlias === DEPLOYMENT_V7,
    }));
  }
  const active = entries.get(activeAlias);
  if (!active) throw new Error(`The active ${activeAlias} deployment is not configured.`);
  if (configuredProtocol && configuredProtocol !== active.protocolVersion) {
    throw new Error('VITE_GENLAYER_PROTOCOL does not match VITE_GENLAYER_ACTIVE_DEPLOYMENT.');
  }
  if (configuredContract && configuredContract.toLowerCase() !== active.address.toLowerCase()) {
    throw new Error('VITE_GENLAYER_CONTRACT does not match VITE_GENLAYER_ACTIVE_DEPLOYMENT.');
  }

  const all = Object.freeze([...entries.values()]);
  const byAddress = new Map(all.map((item) => [item.address.toLowerCase(), item]));
  return Object.freeze({
    activeAlias,
    active,
    compatibilityMode,
    all,
    get(alias) {
      const normalized = String(alias || '').trim().toLowerCase();
      if (!ALIAS_SET.has(normalized) || !entries.has(normalized)) {
        throw new Error(`Deployment alias "${normalized || '(empty)'}" is not allowlisted.`);
      }
      return entries.get(normalized);
    },
    findByAddress(address) {
      const normalized = String(address || '').trim().toLowerCase();
      return byAddress.get(normalized) || null;
    },
    resolveIdentity({ alias = '', address = '' } = {}) {
      const normalizedAddressValue = String(address || '').trim().toLowerCase();
      const item = String(alias || '').trim() ? this.get(alias) : byAddress.get(normalizedAddressValue);
      if (!item || item.address.toLowerCase() !== normalizedAddressValue) {
        throw new Error('Deployment alias and contract address do not identify one allowlisted deployment.');
      }
      return item;
    },
    selectRoute(rawAlias, { rawAddress = '' } = {}) {
      if (String(rawAddress || '').trim()) {
        throw new Error('Contract-address routes are forbidden; use an allowlisted deployment alias.');
      }
      const normalized = String(rawAlias || '').trim().toLowerCase();
      return normalized ? this.get(normalized) : active;
    },
  });
}

export { ALIASES as DEPLOYMENT_ALIASES };
