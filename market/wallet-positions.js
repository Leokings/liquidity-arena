import { normalizeV6Entry } from './v6-state.js';

const MAX_POSITION_PAGE_SIZE = 50;
const OBJECTIVES = new Set(['HIGH', 'LOW']);
const CLAIM_INTENT_VALUE = '1';
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export class WalletPositionRetryError extends Error {
  constructor(code, message, { refreshNewest = false } = {}) {
    super(message);
    this.name = 'WalletPositionRetryError';
    this.code = code;
    this.retryable = true;
    this.refreshNewest = refreshNewest;
  }
}

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

function walletAccount(value, label) {
  const normalized = String(value || '').trim();
  if (!ADDRESS_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a 20-byte hexadecimal address.`);
  }
  return normalized;
}

function retryPage(code, message, options) {
  throw new WalletPositionRetryError(code, message, options);
}

export function normalizeWalletPositionPage(rawPage, deployment, {
  account = null,
  offset = null,
  limit = null,
  expectedTotal = null,
} = {}) {
  if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage)) {
    throw new TypeError('Wallet position page must be an object.');
  }
  const identity = deploymentIdentity(deployment);
  const pageAccount = walletAccount(rawPage.account, 'Wallet position page account');
  const pageOffset = unsignedInteger(rawPage.offset, 'Wallet position page offset');
  const nextOffset = unsignedInteger(rawPage.next_offset, 'Wallet position page next offset');
  const total = unsignedInteger(rawPage.total, 'Wallet position page total');
  if (!Array.isArray(rawPage.positions)) {
    throw new TypeError('Wallet position page positions must be an array.');
  }
  if (account !== null
    && pageAccount.toLowerCase() !== walletAccount(account, 'Expected wallet account').toLowerCase()) {
    retryPage(
      'WALLET_POSITION_PAGE_ACCOUNT_MISMATCH',
      'Wallet position page account does not match the requested wallet.',
      { refreshNewest: true },
    );
  }
  if (offset !== null && pageOffset !== unsignedInteger(offset, 'Expected wallet position page offset')) {
    retryPage(
      'WALLET_POSITION_PAGE_OFFSET_MISMATCH',
      'Wallet position page offset does not match the requested offset.',
      { refreshNewest: true },
    );
  }
  if (expectedTotal !== null
    && total !== unsignedInteger(expectedTotal, 'Expected wallet position page total')) {
    retryPage(
      'WALLET_POSITION_PAGE_TOTAL_MISMATCH',
      'Wallet position count changed while its page was being read.',
      { refreshNewest: true },
    );
  }
  if (pageOffset > total || nextOffset > total
    || nextOffset !== pageOffset + rawPage.positions.length) {
    retryPage(
      'WALLET_POSITION_PAGE_CURSOR_MISMATCH',
      'Wallet position page cursor is inconsistent with its rows and total.',
      { refreshNewest: true },
    );
  }
  if (limit !== null) {
    const normalizedLimit = unsignedInteger(limit, 'Wallet position page limit');
    const expectedLength = Math.min(normalizedLimit, total - pageOffset);
    if (rawPage.positions.length !== expectedLength) {
      retryPage(
        'WALLET_POSITION_PAGE_LIMIT_MISMATCH',
        'Wallet position page length does not match the requested limit.',
        { refreshNewest: true },
      );
    }
  }

  const seenIndices = new Set();
  const positions = rawPage.positions.map((position, pageIndex) => {
    const positionIndex = unsignedInteger(
      position?.position_index,
      'Wallet position index',
    );
    if (seenIndices.has(positionIndex)) {
      retryPage(
        'WALLET_POSITION_PAGE_DUPLICATE',
        'Wallet position page contains a duplicate position index.',
        { refreshNewest: true },
      );
    }
    seenIndices.add(positionIndex);
    if (positionIndex !== pageOffset + pageIndex) {
      retryPage(
        'WALLET_POSITION_PAGE_INDEX_MISMATCH',
        'Wallet position index is inconsistent with its page offset.',
        { refreshNewest: true },
      );
    }
    const normalized = normalizeV6Entry(position);
    const positionAccount = walletAccount(normalized.account, 'Wallet position row account');
    if (positionAccount.toLowerCase() !== pageAccount.toLowerCase()) {
      retryPage(
        'WALLET_POSITION_PAGE_ACCOUNT_MISMATCH',
        'Wallet position row account does not match its page account.',
        { refreshNewest: true },
      );
    }
    return Object.freeze({
      ...normalized,
      positionIndex,
      deploymentAlias: identity.alias,
      contractAddress: identity.address,
      protocolVersion: identity.protocolVersion,
    });
  }).reverse();

  return Object.freeze({
    account: pageAccount,
    offset: pageOffset,
    nextOffset,
    total,
    positions: Object.freeze(positions),
  });
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

export function walletClaimIntentFromHref(href, baseHref = 'https://liquidity-arena.invalid/') {
  let url;
  try {
    url = new URL(href, baseHref);
  } catch {
    return null;
  }
  if (url.searchParams.get('claim') !== CLAIM_INTENT_VALUE) return null;
  const deploymentAlias = String(url.searchParams.get('deployment') || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(deploymentAlias)) return null;
  const epoch = String(url.searchParams.get('epoch') || '').trim();
  const epochEndTimestamp = /^\d{10}$/.test(epoch) ? Number(epoch) : 0;
  if (!Number.isSafeInteger(epochEndTimestamp)
    || epochEndTimestamp < 1
    || epochEndTimestamp % 3_600 !== 0) return null;
  const objectiveParam = String(url.searchParams.get('objective') || '').trim().toLowerCase();
  const objective = objectiveParam === 'highest'
    ? 'HIGH'
    : objectiveParam === 'lowest' ? 'LOW' : null;
  if (!objective) return null;
  return Object.freeze({ deploymentAlias, epochEndTimestamp, objective });
}

export function clearWalletClaimIntentHref(href, baseHref = 'https://liquidity-arena.invalid/') {
  const url = new URL(href, baseHref);
  url.searchParams.delete('claim');
  return url.href;
}

export function walletClaimSummary(positions) {
  const claimablePositions = Object.freeze((Array.isArray(positions) ? positions : [])
    .filter((position) => position?.eligible === true
      && position?.claimed !== true
      && typeof position?.amountAtto === 'bigint'
      && position.amountAtto > 0n));
  return Object.freeze({
    count: claimablePositions.length,
    amountAtto: claimablePositions.reduce((sum, position) => sum + position.amountAtto, 0n),
    refundCount: claimablePositions.filter((position) =>
      String(position.settlementMode || '').startsWith('REFUND_')).length,
    payoutCount: claimablePositions.filter((position) =>
      !String(position.settlementMode || '').startsWith('REFUND_')).length,
    positions: claimablePositions,
  });
}

export function reconcileWalletPositionSnapshot({
  previousPositions = [],
  previousCount = null,
  nextPage = null,
  observedCount = null,
  append = false,
  error = null,
} = {}) {
  const verifiedPrevious = Object.freeze(Array.isArray(previousPositions)
    ? [...previousPositions]
    : []);
  const verifiedPreviousCount = previousCount === null
    ? verifiedPrevious.length
    : unsignedInteger(previousCount, 'Previous wallet position count');
  if (verifiedPrevious.length > verifiedPreviousCount) {
    throw new RangeError('Loaded wallet positions exceed the previous verified on-chain count.');
  }
  if (error) {
    return Object.freeze({
      positions: verifiedPrevious,
      count: verifiedPreviousCount,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!nextPage || typeof nextPage !== 'object' || Array.isArray(nextPage)
    || !Array.isArray(nextPage.positions)) {
    throw new TypeError('Next wallet position page must be normalized after a successful read.');
  }
  const verifiedObservedCount = observedCount === null
    ? unsignedInteger(nextPage.total, 'Wallet position page total')
    : unsignedInteger(observedCount, 'Observed wallet position count');
  if (nextPage.total !== verifiedObservedCount) {
    retryPage(
      'WALLET_POSITION_PAGE_TOTAL_MISMATCH',
      'Wallet position count does not match the normalized page total.',
      { refreshNewest: true },
    );
  }
  if (append && verifiedObservedCount !== verifiedPreviousCount) {
    retryPage(
      'WALLET_POSITION_COUNT_CHANGED',
      'Wallet position count changed before an older page could be appended.',
      { refreshNewest: true },
    );
  }

  const keyFor = (position) => {
    const positionIndex = unsignedInteger(position?.positionIndex, 'Wallet position index');
    const deploymentAlias = String(position?.deploymentAlias || '').trim().toLowerCase();
    const contractAddress = String(position?.contractAddress || '').trim().toLowerCase();
    if (!deploymentAlias || !contractAddress) {
      throw new TypeError('Wallet position identity is incomplete.');
    }
    return `${deploymentAlias}:${contractAddress}:${positionIndex}`;
  };
  const seenKeys = new Set();
  if (append) {
    for (const position of verifiedPrevious) {
      const key = keyFor(position);
      if (seenKeys.has(key)) {
        retryPage(
          'WALLET_POSITION_SNAPSHOT_DUPLICATE',
          'Previous wallet position snapshot contains duplicate rows.',
          { refreshNewest: true },
        );
      }
      seenKeys.add(key);
    }
  }
  const nextKeys = new Set();
  for (const position of nextPage.positions) {
    const key = keyFor(position);
    if (nextKeys.has(key)) {
      retryPage(
        'WALLET_POSITION_PAGE_DUPLICATE',
        'Wallet position page contains duplicate rows.',
        { refreshNewest: true },
      );
    }
    if (append && seenKeys.has(key)) {
      retryPage(
        'WALLET_POSITION_PAGE_OVERLAP',
        'Wallet position page overlaps rows already present in the snapshot.',
        { refreshNewest: true },
      );
    }
    nextKeys.add(key);
    if (append) seenKeys.add(key);
  }

  if (append) {
    const expectedWindow = walletPositionPageWindow({
      total: verifiedObservedCount,
      loaded: verifiedPrevious.length,
    });
    if (nextPage.offset !== expectedWindow.offset
      || nextPage.positions.length !== expectedWindow.limit) {
      retryPage(
        'WALLET_POSITION_PAGE_COVERAGE_MISMATCH',
        'Wallet position page does not continue the verified snapshot.',
        { refreshNewest: true },
      );
    }
  } else if (nextPage.nextOffset !== verifiedObservedCount) {
    retryPage(
      'WALLET_POSITION_PAGE_COVERAGE_MISMATCH',
      'Wallet position refresh did not return the newest page.',
      { refreshNewest: true },
    );
  }

  const positions = Object.freeze(append
    ? [...verifiedPrevious, ...nextPage.positions]
    : [...nextPage.positions]);
  return Object.freeze({
    positions,
    count: verifiedObservedCount,
    stale: false,
    error: '',
  });
}

export function walletPositionPresentation(position, deployment, baseHref) {
  const identity = deploymentIdentity(deployment);
  const claimTarget = walletClaimTarget(position);
  const href = new URL(baseHref);
  const currentDeploymentAlias = String(href.searchParams.get('deployment') || '')
    .trim()
    .toLowerCase();
  href.searchParams.delete('contract');
  href.searchParams.set('feed', 'live');
  href.searchParams.set('deployment', identity.alias);
  href.searchParams.set('epoch', String(claimTarget.epochEndTimestamp));
  href.searchParams.set('objective', claimTarget.objective === 'LOW' ? 'lowest' : 'highest');
  if (position.eligible && !position.claimed) href.searchParams.set('claim', CLAIM_INTENT_VALUE);
  else href.searchParams.delete('claim');
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
    actionText: position.eligible && !position.claimed
      ? currentDeploymentAlias && currentDeploymentAlias !== identity.alias
        ? `OPEN ${identity.alias.toUpperCase()} & RECONNECT TO CLAIM`
        : 'OPEN & CLAIM'
      : 'OPEN EPOCH',
    actionTitle: `Open epoch ${claimTarget.epochEndTimestamp} ${claimTarget.objective}`,
  });
}
