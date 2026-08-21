import { normalizeV6Entry } from './v6-state.js';

const MAX_POSITION_PAGE_SIZE = 50;
const OBJECTIVES = new Set(['HIGH', 'LOW']);

function unsignedInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return normalized;
}

function deploymentIdentity(deployment) {
  const alias = String(deployment?.alias || '').trim().toLowerCase();
  const address = String(deployment?.address || '').trim();
  const protocolVersion = String(deployment?.protocolVersion || '').trim();
  if (!alias || !address || !protocolVersion) {
    throw new TypeError('Wallet position deployment identity is incomplete.');
  }
  return { alias, address, protocolVersion };
}

export function walletPositionPageWindow({ total, loaded = 0, pageSize = MAX_POSITION_PAGE_SIZE }) {
  const normalizedTotal = unsignedInteger(total, 'Wallet position count');
  const normalizedLoaded = Math.min(
    unsignedInteger(loaded, 'Loaded wallet position count'),
    normalizedTotal,
  );
  const normalizedPageSize = unsignedInteger(pageSize, 'Wallet position page size');
  if (normalizedPageSize < 1 || normalizedPageSize > MAX_POSITION_PAGE_SIZE) {
    throw new RangeError(`Wallet position page size must be between 1 and ${MAX_POSITION_PAGE_SIZE}.`);
  }
  const remaining = normalizedTotal - normalizedLoaded;
  const limit = Math.min(normalizedPageSize, remaining);
  return Object.freeze({
    total: normalizedTotal,
    loaded: normalizedLoaded,
    remaining,
    limit,
    offset: Math.max(0, remaining - limit),
  });
}

export function normalizeWalletPositionPage(rawPositions, deployment) {
  if (!Array.isArray(rawPositions)) return Object.freeze([]);
  const identity = deploymentIdentity(deployment);
  return Object.freeze(rawPositions.map((position) => Object.freeze({
    ...normalizeV6Entry(position),
    deploymentAlias: identity.alias,
    contractAddress: identity.address,
    protocolVersion: identity.protocolVersion,
  })).reverse());
}

export function walletClaimTarget(position) {
  const epochEndTimestamp = unsignedInteger(
    position?.epochEndTimestamp,
    'Wallet position epoch',
  );
  if (epochEndTimestamp < 1) throw new RangeError('Wallet position epoch must be positive.');
  const objective = String(position?.objective || '').trim().toUpperCase();
  if (!OBJECTIVES.has(objective)) throw new RangeError('Wallet position objective is unsupported.');
  return Object.freeze({ epochEndTimestamp, objective });
}

export function walletPositionPresentation(position, deployment, baseHref) {
  const identity = deploymentIdentity(deployment);
  const claimTarget = walletClaimTarget(position);
  const href = new URL(baseHref);
  href.searchParams.delete('contract');
  href.searchParams.set('feed', 'live');
  href.searchParams.set('deployment', identity.alias);
  href.searchParams.set('epoch', String(claimTarget.epochEndTimestamp));
  href.searchParams.set('objective', claimTarget.objective === 'LOW' ? 'lowest' : 'highest');
  const status = position.claimed
    ? 'CLAIMED'
    : position.eligible
      ? (position.settlementMode.startsWith('REFUND_') ? 'REFUND READY' : 'PAYOUT READY')
      : position.settlementMode === 'PENDING' ? 'AWAITING RESULT' : 'NO PAYOUT';
  return Object.freeze({
    claimTarget,
    dataStatus: position.claimed ? 'finalized' : position.eligible ? 'submitted' : 'review',
    status,
    href: href.href,
    actionText: position.eligible ? 'OPEN & CLAIM' : 'OPEN EPOCH',
    actionTitle: `Open epoch ${claimTarget.epochEndTimestamp} ${claimTarget.objective}`,
  });
}
