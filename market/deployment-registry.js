export const DEPLOYMENT_V8 = 'v8';
export const PROTOCOL_V8 = 'LIQUIDITY_ARENA_V8';

const RETIRED_ROUTE_ALIASES = new Set(['v6', 'v7']);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function environmentText(environment, name) {
  return String(environment?.[name] || '').trim();
}

function normalizedOptionalAddress(value, label) {
  const address = String(value || '').trim();
  if (!address) return '';
  if (!ADDRESS_PATTERN.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error(`${label} must be a non-zero 20-byte address.`);
  }
  return address;
}

/**
 * Build the single-deployment V8 registry.
 *
 * The V8 address deliberately has its own variable. Older generic variables
 * are never accepted as a fallback. An absent V8 address leaves the market
 * visualization available while every contract read and money action fails
 * closed.
 */
export function createDeploymentRegistry(environment = import.meta.env) {
  const v8Address = normalizedOptionalAddress(
    environmentText(environment, 'VITE_GENLAYER_V8_CONTRACT'),
    'VITE_GENLAYER_V8_CONTRACT',
  );
  const genericAddress = normalizedOptionalAddress(
    environmentText(environment, 'VITE_GENLAYER_CONTRACT'),
    'VITE_GENLAYER_CONTRACT',
  );
  // A retired build can still inject the old generic address. It must never
  // become an implicit V8 target: without the V8-specific variable the market
  // remains visibly unconfigured and every contract operation fails closed.
  if (v8Address && (!genericAddress || v8Address.toLowerCase() !== genericAddress.toLowerCase())) {
    throw new Error('VITE_GENLAYER_CONTRACT and VITE_GENLAYER_V8_CONTRACT must be configured together and match.');
  }
  const protocol = environmentText(environment, 'VITE_GENLAYER_PROTOCOL').toUpperCase();
  if (v8Address && protocol && protocol !== PROTOCOL_V8) {
    throw new Error(`VITE_GENLAYER_PROTOCOL must be ${PROTOCOL_V8}.`);
  }
  const activeAlias = environmentText(environment, 'VITE_GENLAYER_ACTIVE_DEPLOYMENT').toLowerCase();
  if (v8Address && activeAlias && activeAlias !== DEPLOYMENT_V8) {
    throw new Error('VITE_GENLAYER_ACTIVE_DEPLOYMENT must be v8.');
  }
  const address = v8Address;
  const active = Object.freeze({
    alias: DEPLOYMENT_V8,
    address,
    protocolVersion: PROTOCOL_V8,
    configured: Boolean(address),
  });

  return Object.freeze({
    activeAlias: DEPLOYMENT_V8,
    active,
    all: Object.freeze([active]),
    get(alias) {
      const normalized = String(alias || '').trim().toLowerCase();
      if (normalized !== DEPLOYMENT_V8) {
        throw new Error(`Deployment alias "${normalized || '(empty)'}" is not allowlisted.`);
      }
      return active;
    },
    findByAddress(candidate) {
      const normalized = String(candidate || '').trim().toLowerCase();
      return address && address.toLowerCase() === normalized ? active : null;
    },
    resolveIdentity({ alias = '', address: candidate = '' } = {}) {
      const normalizedAlias = String(alias || '').trim().toLowerCase();
      const normalizedAddress = String(candidate || '').trim().toLowerCase();
      if (normalizedAlias !== DEPLOYMENT_V8
        || !address
        || normalizedAddress !== address.toLowerCase()) {
        throw new Error('Deployment alias and contract address do not identify the active V8 deployment.');
      }
      return active;
    },
    selectRoute(rawAlias, { rawAddress = '' } = {}) {
      if (String(rawAddress || '').trim()) {
        throw new Error('Contract-address routes are forbidden; the app uses its build-configured V8 deployment.');
      }
      const normalized = String(rawAlias || '').trim().toLowerCase();
      if (!normalized || normalized === DEPLOYMENT_V8 || RETIRED_ROUTE_ALIASES.has(normalized)) {
        return active;
      }
      throw new Error(`Deployment alias "${normalized}" is not allowlisted.`);
    },
  });
}

export const DEPLOYMENT_ALIASES = Object.freeze([DEPLOYMENT_V8]);
