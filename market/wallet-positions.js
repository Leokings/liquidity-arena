const CLAIM_INTENT_VALUE = '1';
const OBJECTIVES = new Set(['HIGH', 'LOW']);
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DEFAULT_EPOCH_PAGE_SIZE = 25;

function positiveHourlyEpoch(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized % 3_600 !== 0) {
    throw new RangeError(`${label} must be a positive exact-hour timestamp.`);
  }
  return normalized;
}

export function walletClaimTarget(position) {
  const epochEndTimestamp = positiveHourlyEpoch(
    position?.epochEndTimestamp,
    'Wallet position epoch',
  );
  const objective = String(position?.objective || '').trim().toUpperCase();
  if (!OBJECTIVES.has(objective)) throw new RangeError('Wallet position objective is unsupported.');
  return Object.freeze({ epochEndTimestamp, objective });
}

/**
 * Parse only a V8 claim/payout-recovery route. Legacy deployment parameters
 * are canonicalized by the registry before this helper runs and never retain
 * a route to an old contract.
 */
export function walletClaimIntentFromHref(href, baseHref = 'https://liquidity-arena.invalid/') {
  let url;
  try { url = new URL(href, baseHref); } catch { return null; }
  if (url.searchParams.get('claim') !== CLAIM_INTENT_VALUE) return null;
  if (String(url.searchParams.get('deployment') || '').trim().toLowerCase() !== 'v8') return null;
  const epoch = String(url.searchParams.get('epoch') || '').trim();
  if (!/^\d{10}$/.test(epoch)) return null;
  const epochEndTimestamp = Number(epoch);
  if (!Number.isSafeInteger(epochEndTimestamp) || epochEndTimestamp <= 0 || epochEndTimestamp % 3_600 !== 0) {
    return null;
  }
  const direction = String(url.searchParams.get('objective') || '').trim().toLowerCase();
  const objective = direction === 'highest' ? 'HIGH' : direction === 'lowest' ? 'LOW' : null;
  return objective ? Object.freeze({ deploymentAlias: 'v8', epochEndTimestamp, objective }) : null;
}

export function clearWalletClaimIntentHref(href, baseHref = 'https://liquidity-arena.invalid/') {
  const url = new URL(href, baseHref);
  url.searchParams.delete('claim');
  return url.href;
}

function exactAccount(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized) || /^0x0{40}$/.test(normalized)) {
    throw new TypeError('Wallet history account must be a non-zero address.');
  }
  return normalized;
}

function pageInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} is malformed.`);
  }
  return normalized;
}

/**
 * Scan one newest-first page of V8 epochs and both immutable objectives.
 *
 * V8 deliberately has no wallet-position index. The cursor therefore counts
 * epochs scanned, never the number of positions found. A page is accepted only
 * if its total remains identical across reads; callers keep the previous page
 * on any inconsistency and may retry from the same cursor.
 */
export async function readWalletPositionPage({
  gateway,
  account,
  cursor = null,
  pageSize = DEFAULT_EPOCH_PAGE_SIZE,
} = {}) {
  if (typeof gateway?.readEpochPage !== 'function'
    || typeof gateway?.readEpochClaimQuote !== 'function') {
    throw new TypeError('A V8 gateway with epoch-page and claim-quote reads is required.');
  }
  const normalizedAccount = exactAccount(account);
  const contractAddress = exactAccount(gateway.contractAddress);
  const limit = pageInteger(pageSize, 'Wallet history page size', { minimum: 1, maximum: 50 });
  if (gateway.connected && String(gateway.account || '').toLowerCase() !== normalizedAccount) {
    throw new Error('Connected wallet changed before V8 history scanning.');
  }

  let totalEpochs;
  let endOffset;
  let scannedBefore;
  let metadataPage = null;
  if (cursor) {
    if (String(cursor.account || '').toLowerCase() !== normalizedAccount
      || String(cursor.contractAddress || '').toLowerCase() !== contractAddress) {
      throw new Error('Wallet history cursor belongs to a different chain identity.');
    }
    totalEpochs = pageInteger(cursor.totalEpochs, 'Wallet history total');
    endOffset = pageInteger(cursor.nextOffset, 'Wallet history cursor', { maximum: totalEpochs });
    scannedBefore = pageInteger(cursor.scannedEpochs, 'Wallet history scanned count', { maximum: totalEpochs });
    if (scannedBefore !== totalEpochs - endOffset) throw new Error('Wallet history cursor is inconsistent.');
  } else {
    metadataPage = await gateway.readEpochPage(0, 1);
    totalEpochs = pageInteger(metadataPage?.total, 'V8 epoch total');
    endOffset = totalEpochs;
    scannedBefore = 0;
  }

  if (endOffset === 0) {
    return Object.freeze({
      account: normalizedAccount,
      contractAddress,
      totalEpochs,
      scannedEpochs: scannedBefore,
      positions: Object.freeze([]),
      nextCursor: null,
      complete: true,
    });
  }

  const startOffset = Math.max(0, endOffset - limit);
  const expectedLength = endOffset - startOffset;
  const page = !cursor && totalEpochs === 1 && startOffset === 0
    ? metadataPage
    : await gateway.readEpochPage(startOffset, expectedLength);
  if (pageInteger(page?.total, 'V8 epoch page total') !== totalEpochs
    || pageInteger(page?.offset, 'V8 epoch page offset') !== startOffset
    || !Array.isArray(page?.epoch_ids)
    || page.epoch_ids.length !== expectedLength) {
    throw new Error('V8 epoch index changed or returned an inconsistent history page.');
  }
  const epochIds = page.epoch_ids.map((value) => positiveHourlyEpoch(value, 'V8 history epoch'));
  if (new Set(epochIds).size !== epochIds.length) throw new Error('V8 epoch history contains duplicate IDs.');
  for (let index = 1; index < epochIds.length; index += 1) {
    if (epochIds[index] <= epochIds[index - 1]) throw new Error('V8 epoch history is not strictly ordered.');
  }

  const quoteReads = [];
  for (const epochEndTimestamp of [...epochIds].reverse()) {
    for (const requestedObjective of OBJECTIVES) {
      quoteReads.push((async () => {
        const quote = await gateway.readEpochClaimQuote(
          epochEndTimestamp,
          requestedObjective,
          normalizedAccount,
        );
        if (!quote || typeof quote !== 'object') throw new Error('V8 claim quote is unavailable.');
        if (Number(quote.epoch_end_timestamp) !== epochEndTimestamp
          || String(quote.objective || '').trim().toUpperCase() !== requestedObjective
          || String(quote.account || '').trim().toLowerCase() !== normalizedAccount) {
          throw new Error('V8 claim quote does not match the requested wallet position.');
        }
        let stake;
        try { stake = BigInt(quote.stake_atto); } catch { throw new TypeError('V8 claim quote stake is malformed.'); }
        if (stake < 0n) throw new RangeError('V8 claim quote stake is malformed.');
        if (stake === 0n) return null;
        return Object.freeze({
          identity: `${contractAddress}:${epochEndTimestamp}:${requestedObjective}`,
          epochEndTimestamp,
          objective: requestedObjective,
          quote,
        });
      })());
    }
  }
  const positions = (await Promise.all(quoteReads)).filter(Boolean);
  if (gateway.connected && String(gateway.account || '').toLowerCase() !== normalizedAccount) {
    throw new Error('Connected wallet changed during V8 history scanning.');
  }
  const scannedEpochs = scannedBefore + epochIds.length;
  const nextCursor = startOffset === 0 ? null : Object.freeze({
    account: normalizedAccount,
    contractAddress,
    totalEpochs,
    nextOffset: startOffset,
    scannedEpochs,
  });
  return Object.freeze({
    account: normalizedAccount,
    contractAddress,
    totalEpochs,
    scannedEpochs,
    positions: Object.freeze(positions),
    nextCursor,
    complete: nextCursor === null,
  });
}
