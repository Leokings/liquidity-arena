const STORAGE_KEY = 'liquidity-arena:v8:activity:v1';
const MAX_RECORDS = 100;
const TYPES = new Set([
  'WAGER', 'CLAIM', 'RETRY_PREPARE', 'DISPATCH', 'RETRY_PAYOUT', 'CONFIRM',
  'WITHDRAW_EVM', 'REFRESH_WITHDRAWAL', 'TIMEOUT_REFUND',
]);
const STATUSES = new Set(['SUBMITTED', 'FINALIZED', 'REVIEW']);
const STATUS_RANK = Object.freeze({ SUBMITTED: 0, REVIEW: 1, FINALIZED: 2 });
const DOMAINS = new Set(['GENLAYER', 'EVM']);
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const PAYOUT_ID_PATTERN = /^[0-9a-f]{64}$/;

function optionalUpper(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function normalizeRecord(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Activity record must be an object.');
  const hash = String(raw.hash || '').trim().toLowerCase();
  const account = String(raw.account || '').trim().toLowerCase();
  const contractAddress = String(raw.contractAddress || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) throw new TypeError('Activity transaction hash is invalid.');
  if (!ADDRESS_PATTERN.test(account) || /^0x0{40}$/.test(account)) throw new TypeError('Activity account is invalid.');
  if (!ADDRESS_PATTERN.test(contractAddress) || /^0x0{40}$/.test(contractAddress)) {
    throw new TypeError('Activity contract address is invalid.');
  }
  const type = optionalUpper(raw.type);
  const status = optionalUpper(raw.status);
  const domain = optionalUpper(raw.domain) || 'GENLAYER';
  if (!TYPES.has(type)) throw new RangeError('Activity type is invalid.');
  if (!STATUSES.has(status)) throw new RangeError('Activity status is invalid.');
  if (!DOMAINS.has(domain)) throw new RangeError('Activity domain is invalid.');
  if ((type === 'WITHDRAW_EVM') !== (domain === 'EVM')) {
    throw new RangeError('Only the recipient vault withdrawal belongs to the EVM activity domain.');
  }
  const payoutId = String(raw.payoutId || '').trim().toLowerCase() || null;
  if (payoutId !== null && !PAYOUT_ID_PATTERN.test(payoutId)) throw new TypeError('Activity payout ID is invalid.');
  const amountAtto = raw.amountAtto === undefined || raw.amountAtto === null
    ? null
    : String(raw.amountAtto).trim();
  if (amountAtto !== null && !/^\d+$/.test(amountAtto)) throw new TypeError('Activity amount is invalid.');
  return Object.freeze({
    hash,
    type,
    status,
    domain,
    account,
    contractAddress,
    deploymentAlias: 'v8',
    roundId: optionalUpper(raw.roundId),
    assetId: optionalUpper(raw.assetId),
    objective: optionalUpper(raw.objective),
    amountAtto,
    payoutId,
    createdAt: Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now,
    updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now,
  });
}

function loadRecords(storage, now) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((record) => {
      try { return [normalizeRecord(record, now)]; } catch { return []; }
    }).slice(0, MAX_RECORDS);
  } catch { return []; }
}

export function createActivityStore({ storage = globalThis.localStorage, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Activity clock must be a function.');
  let records = loadRecords(storage, Number(now()));
  const persist = () => {
    try { storage?.setItem?.(STORAGE_KEY, JSON.stringify(records)); } catch { /* best effort */ }
  };
  return Object.freeze({
    upsert(raw) {
      const timestamp = Number(now());
      const incoming = normalizeRecord({ ...raw, updatedAt: timestamp }, timestamp);
      const index = records.findIndex((record) => record.hash === incoming.hash && record.domain === incoming.domain);
      if (index >= 0) {
        const previous = records[index];
        for (const field of ['type', 'account', 'contractAddress', 'payoutId']) {
          if (previous[field] && incoming[field] && previous[field] !== incoming[field]) {
            throw new Error(`Activity ${field} conflicts with its durable identity.`);
          }
        }
        const progressed = STATUS_RANK[incoming.status] >= STATUS_RANK[previous.status];
        records.splice(index, 1);
        records.unshift(Object.freeze({
          ...previous,
          ...incoming,
          status: progressed ? incoming.status : previous.status,
          createdAt: previous.createdAt,
          updatedAt: progressed ? incoming.updatedAt : previous.updatedAt,
        }));
      } else records.unshift(incoming);
      records = records.slice(0, MAX_RECORDS);
      persist();
      return records[0];
    },
    list({ account = '', contractAddress = '', deploymentAlias = '', limit = 8 } = {}) {
      const normalizedAccount = String(account || '').trim().toLowerCase();
      const normalizedContract = String(contractAddress || '').trim().toLowerCase();
      const normalizedDeployment = String(deploymentAlias || '').trim().toLowerCase();
      if (normalizedDeployment && normalizedDeployment !== 'v8') throw new RangeError('Only V8 activity is available.');
      const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECORDS) : 8;
      return Object.freeze(records
        .filter((record) => !normalizedAccount || record.account === normalizedAccount)
        .filter((record) => !normalizedContract || record.contractAddress === normalizedContract)
        .slice(0, safeLimit));
    },
  });
}

export { MAX_RECORDS, STORAGE_KEY };
