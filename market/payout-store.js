export const PAYOUT_STORAGE_KEY = 'liquidity-arena:v8:payouts:v2';
const PAYOUT_ID_PATTERN = /^[0-9a-f]{64}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const STATES = new Set(['PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN']);
const STATE_RANK = Object.freeze({ PREPARING: 0, DISPATCHED: 1, FUNDED_IN_ESCROW: 2, EOA_WITHDRAWN: 3 });
const HASH_KEYS = new Set([
  'CLAIM', 'RETRY_PREPARE', 'DISPATCH', 'RETRY_PAYOUT', 'CONFIRM', 'REFRESH_WITHDRAWAL',
]);
export const WITHDRAWAL_ATTEMPT_STATUSES = Object.freeze([
  'SUBMITTED', 'PENDING', 'FAILED', 'DROPPED', 'SUPERSEDED', 'FINALIZED',
]);
const WITHDRAWAL_ATTEMPT_STATUS_SET = new Set(WITHDRAWAL_ATTEMPT_STATUSES);
const OPEN_WITHDRAWAL_STATUSES = new Set(['SUBMITTED', 'PENDING']);
const MAX_RECORDS = 100;
const MAX_WITHDRAWAL_ATTEMPTS = 20;

function journalPersistenceError(cause, { hash = '' } = {}) {
  const normalizedHash = String(hash || '').trim().toLowerCase();
  const error = new Error(normalizedHash
    ? `The payout recovery journal could not durably store the broadcast EVM hash. Exact recovery hash: ${normalizedHash}`
    : 'The payout recovery journal is not durably writable.');
  error.name = 'PayoutJournalPersistenceError';
  error.code = 'PAYOUT_JOURNAL_WRITE_FAILED';
  error.durable = false;
  if (normalizedHash) {
    error.hash = normalizedHash;
    error.withdrawalStatus = 'PENDING';
  }
  error.cause = cause;
  return error;
}

function normalizeWithdrawalIntent(raw, now = Date.now()) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || String(raw.status || '').trim().toUpperCase() !== 'PREPARED') {
    throw new TypeError('Payout withdrawal signing intent is invalid.');
  }
  return Object.freeze({
    status: 'PREPARED',
    createdAt: Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now,
    updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now,
  });
}

function normalizeWithdrawalAttempt(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Payout withdrawal attempt must be an object.');
  }
  const hash = String(raw.hash || '').trim().toLowerCase();
  const status = String(raw.status || '').trim().toUpperCase();
  if (!HASH_PATTERN.test(hash)) throw new TypeError('Payout withdrawal attempt hash is invalid.');
  if (!WITHDRAWAL_ATTEMPT_STATUS_SET.has(status)) {
    throw new RangeError('Payout withdrawal attempt status is invalid.');
  }
  return Object.freeze({
    hash,
    status,
    createdAt: Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now,
    updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now,
  });
}

function normalizeWithdrawalAttempts(raw, now) {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) throw new TypeError('Payout withdrawal attempts must be an array.');
  const attempts = raw.map((attempt) => normalizeWithdrawalAttempt(attempt, now));
  if (new Set(attempts.map(({ hash }) => hash)).size !== attempts.length) {
    throw new Error('Payout withdrawal attempts contain a duplicate transaction hash.');
  }
  return Object.freeze(attempts.slice(-MAX_WITHDRAWAL_ATTEMPTS));
}

function mergeWithdrawalAttempts(previous, incoming, now) {
  const merged = [...previous];
  for (const candidate of incoming) {
    const index = merged.findIndex(({ hash }) => hash === candidate.hash);
    if (index >= 0) {
      const prior = merged[index];
      if (prior.status === 'FINALIZED' && candidate.status !== 'FINALIZED') {
        throw new Error('A finalized payout withdrawal attempt cannot be downgraded.');
      }
      merged[index] = normalizeWithdrawalAttempt({
        ...candidate,
        createdAt: prior.createdAt,
        updatedAt: now,
      }, now);
      continue;
    }
    if (merged.some(({ status }) => OPEN_WITHDRAWAL_STATUSES.has(status))) {
      throw new Error('A payout withdrawal transaction is still pending verification.');
    }
    merged.push(normalizeWithdrawalAttempt({ ...candidate, createdAt: now, updatedAt: now }, now));
  }
  return Object.freeze(merged.slice(-MAX_WITHDRAWAL_ATTEMPTS));
}

function normalizeRecord(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Payout recovery record must be an object.');
  }
  const payoutId = String(raw.payoutId || '').trim().toLowerCase();
  const account = String(raw.account || '').trim().toLowerCase();
  const contractAddress = String(raw.contractAddress || '').trim().toLowerCase();
  const state = String(raw.state || '').trim().toUpperCase();
  if (!PAYOUT_ID_PATTERN.test(payoutId)) throw new TypeError('Payout recovery ID is invalid.');
  if (!ADDRESS_PATTERN.test(account) || /^0x0{40}$/.test(account)) throw new TypeError('Payout recovery account is invalid.');
  if (!ADDRESS_PATTERN.test(contractAddress) || /^0x0{40}$/.test(contractAddress)) {
    throw new TypeError('Payout recovery contract is invalid.');
  }
  if (Number(raw.chainId) !== 4221) throw new RangeError('Payout recovery chain must be Bradbury 4221.');
  if (!STATES.has(state)) throw new RangeError('Payout recovery state is invalid.');
  const epochEndTimestamp = Number(raw.epochEndTimestamp);
  if (!Number.isSafeInteger(epochEndTimestamp) || epochEndTimestamp <= 0 || epochEndTimestamp % 3600 !== 0) {
    throw new TypeError('Payout recovery epoch is invalid.');
  }
  const objective = String(raw.objective || '').trim().toUpperCase();
  if (!['HIGH', 'LOW'].includes(objective)) throw new RangeError('Payout recovery objective is invalid.');
  const amountAtto = String(raw.amountAtto || '').trim();
  if (!/^\d+$/.test(amountAtto) || BigInt(amountAtto) <= 0n) throw new TypeError('Payout recovery amount is invalid.');
  const vault = String(raw.vault || '').trim().toLowerCase();
  if (vault && (!ADDRESS_PATTERN.test(vault) || /^0x0{40}$/.test(vault))) {
    throw new TypeError('Payout recovery vault is invalid.');
  }
  const hashes = {};
  for (const [key, value] of Object.entries(raw.hashes || {})) {
    if (!HASH_KEYS.has(key)) throw new TypeError(`Payout recovery hash key ${key} is invalid.`);
    const normalized = String(value || '').trim().toLowerCase();
    if (!HASH_PATTERN.test(normalized)) throw new TypeError(`Payout recovery ${key} hash is invalid.`);
    hashes[key] = normalized;
  }
  return Object.freeze({
    payoutId,
    account,
    contractAddress,
    chainId: 4221,
    epochEndTimestamp,
    objective,
    amountAtto,
    state,
    vault,
    hashes: Object.freeze(hashes),
    withdrawalAttempts: normalizeWithdrawalAttempts(raw.withdrawalAttempts, now),
    withdrawalIntent: normalizeWithdrawalIntent(raw.withdrawalIntent, now),
    createdAt: Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now,
    updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now,
  });
}

function load(storage, now) {
  try {
    const parsed = JSON.parse(storage?.getItem(PAYOUT_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizeRecord(item, now)).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function createPayoutStore({ storage = globalThis.localStorage, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Payout recovery clock must be a function.');
  let records = load(storage, Number(now()));
  const persistRequired = ({ hash = '' } = {}) => {
    try {
      if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') {
        throw new Error('localStorage is unavailable.');
      }
      const serialized = JSON.stringify(records);
      storage.setItem(PAYOUT_STORAGE_KEY, serialized);
      if (storage.getItem(PAYOUT_STORAGE_KEY) !== serialized) {
        throw new Error('localStorage did not retain the exact payout journal write.');
      }
      return true;
    } catch (error) {
      throw journalPersistenceError(error, { hash });
    }
  };
  const findIndex = (payoutId) => {
    const normalized = String(payoutId || '').trim().toLowerCase();
    return records.findIndex((record) => record.payoutId === normalized);
  };
  const sortAndPersist = ({ previousRecords, retainOnFailure = false, hash = '' } = {}) => {
    records = [...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
    try {
      persistRequired({ hash });
    } catch (error) {
      if (!retainOnFailure) records = previousRecords;
      throw error;
    }
  };
  return Object.freeze({
    upsert(raw) {
      const previousRecords = [...records];
      const timestamp = Number(now());
      const incoming = normalizeRecord(raw, timestamp);
      const index = findIndex(incoming.payoutId);
      if (index >= 0) {
        const previous = records[index];
        for (const field of ['account', 'contractAddress', 'chainId', 'epochEndTimestamp', 'objective', 'amountAtto']) {
          if (String(previous[field]).toLowerCase() !== String(incoming[field]).toLowerCase()) {
            throw new Error(`Payout recovery ${field} conflicts with its immutable identity.`);
          }
        }
        for (const [key, hash] of Object.entries(incoming.hashes)) {
          if (previous.hashes[key] && previous.hashes[key] !== hash) {
            throw new Error(`Payout recovery ${key} transaction hash conflicts with the journal.`);
          }
        }
        if (previous.vault && incoming.vault && previous.vault !== incoming.vault) {
          throw new Error('Payout recovery vault conflicts with its immutable identity.');
        }
        const progressed = STATE_RANK[incoming.state] >= STATE_RANK[previous.state];
        records[index] = normalizeRecord({
          ...previous,
          ...incoming,
          state: progressed ? incoming.state : previous.state,
          vault: incoming.vault || previous.vault,
          hashes: { ...previous.hashes, ...incoming.hashes },
          withdrawalAttempts: mergeWithdrawalAttempts(
            previous.withdrawalAttempts,
            incoming.withdrawalAttempts,
            timestamp,
          ),
          withdrawalIntent: previous.withdrawalIntent,
          createdAt: previous.createdAt,
          updatedAt: timestamp,
        }, timestamp);
      } else {
        records.unshift(incoming);
      }
      sortAndPersist({ previousRecords });
      return records.find(({ payoutId }) => payoutId === incoming.payoutId);
    },
    prepareWithdrawal(payoutId) {
      const index = findIndex(payoutId);
      if (index < 0) throw new Error('Payout recovery record must exist before preparing a withdrawal.');
      const previousRecords = [...records];
      const timestamp = Number(now());
      const previous = records[index];
      if (previous.state !== 'FUNDED_IN_ESCROW') {
        throw new Error('Only a funded-in-escrow payout can prepare an EVM withdrawal.');
      }
      if (previous.withdrawalIntent) {
        throw new Error('A durable EVM withdrawal signing intent is already prepared.');
      }
      const latest = previous.withdrawalAttempts.at(-1);
      if (latest && !['FAILED', 'DROPPED'].includes(latest.status)) {
        throw new Error('The previous EVM withdrawal is not safely retryable.');
      }
      records[index] = normalizeRecord({
        ...previous,
        withdrawalIntent: { status: 'PREPARED', createdAt: timestamp, updatedAt: timestamp },
        updatedAt: timestamp,
      }, timestamp);
      sortAndPersist({ previousRecords });
      return records.find(({ payoutId: id }) => id === previous.payoutId);
    },
    recordWithdrawalAttempt(payoutId, rawAttempt) {
      const index = findIndex(payoutId);
      if (index < 0) throw new Error('Payout recovery record must exist before journaling a withdrawal.');
      const previousRecords = [...records];
      const timestamp = Number(now());
      const previous = records[index];
      const attempt = normalizeWithdrawalAttempt(rawAttempt, timestamp);
      const isNewAttempt = !previous.withdrawalAttempts.some(({ hash }) => hash === attempt.hash);
      if (isNewAttempt
        && previous.withdrawalAttempts.some(({ status }) => OPEN_WITHDRAWAL_STATUSES.has(status))) {
        throw new Error('A payout withdrawal transaction is still pending verification.');
      }
      if (isNewAttempt && !previous.withdrawalIntent) {
        throw new Error('A durable EVM withdrawal signing intent is required before storing a new hash.');
      }
      records[index] = normalizeRecord({
        ...previous,
        withdrawalAttempts: mergeWithdrawalAttempts(previous.withdrawalAttempts, [attempt], timestamp),
        withdrawalIntent: isNewAttempt ? null : previous.withdrawalIntent,
        updatedAt: timestamp,
      }, timestamp);
      sortAndPersist({
        previousRecords,
        retainOnFailure: isNewAttempt,
        hash: isNewAttempt ? attempt.hash : '',
      });
      return records.find(({ payoutId: id }) => id === previous.payoutId);
    },
    releasePreparedWithdrawal(payoutId) {
      const index = findIndex(payoutId);
      if (index < 0) throw new Error('Payout recovery record does not exist.');
      const previous = records[index];
      if (!previous.withdrawalIntent) return previous;
      const previousRecords = [...records];
      const timestamp = Number(now());
      records[index] = normalizeRecord({
        ...previous,
        withdrawalIntent: null,
        updatedAt: timestamp,
      }, timestamp);
      sortAndPersist({ previousRecords });
      return records.find(({ payoutId: id }) => id === previous.payoutId);
    },
    latestWithdrawalAttempt(payoutId) {
      const record = records[findIndex(payoutId)];
      return record?.withdrawalAttempts?.at(-1) || null;
    },
    get(payoutId) {
      return records[findIndex(payoutId)] || null;
    },
    list({ account = '', contractAddress = '', chainId = 4221 } = {}) {
      const normalizedAccount = String(account || '').trim().toLowerCase();
      const normalizedContract = String(contractAddress || '').trim().toLowerCase();
      return Object.freeze(records.filter((record) =>
        record.chainId === Number(chainId)
        && (!normalizedAccount || record.account === normalizedAccount)
        && (!normalizedContract || record.contractAddress === normalizedContract)));
    },
  });
}
