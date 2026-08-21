const STORAGE_KEY = 'liquidity-arena:activity:v2';
const MAX_RECORDS = 50;
const TYPES = new Set(['WAGER', 'CLAIM', 'TIMEOUT_REFUND']);
const STATUSES = new Set(['SUBMITTED', 'FINALIZED', 'REVIEW']);
const STATUS_RANK = Object.freeze({ SUBMITTED: 0, REVIEW: 1, FINALIZED: 2 });
const DELIVERY_STATUSES = new Set(['PENDING', 'DELIVERED', 'REVIEW']);
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const OBJECTIVES = new Set(['HIGH', 'LOW']);
const DEPLOYMENT_ALIASES = new Set(['v6', 'v7']);

function optionalUpperText(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function normalizeRecord(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Activity record must be an object.');
  const hash = String(raw.hash || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) throw new TypeError('Activity transaction hash is invalid.');
  const type = String(raw.type || '').trim().toUpperCase();
  if (!TYPES.has(type)) throw new RangeError('Activity type must be WAGER, CLAIM, or TIMEOUT_REFUND.');
  let status = String(raw.status || '').trim().toUpperCase();
  if (!STATUSES.has(status)) throw new RangeError('Activity status is invalid.');
  const account = String(raw.account || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(account)) throw new TypeError('Activity account is invalid.');
  const contractAddress = String(raw.contractAddress || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(contractAddress)) throw new TypeError('Activity contract address is invalid.');
  const rawDeploymentAlias = String(raw.deploymentAlias || '').trim().toLowerCase();
  const deploymentAlias = rawDeploymentAlias || null;
  if (deploymentAlias !== null && !DEPLOYMENT_ALIASES.has(deploymentAlias)) {
    throw new RangeError('Activity deployment alias is invalid.');
  }
  const amountAtto = raw.amountAtto === undefined || raw.amountAtto === null
    ? null
    : String(raw.amountAtto).trim();
  if (amountAtto !== null && !/^\d+$/.test(amountAtto)) throw new TypeError('Activity amount must be an attoGEN integer.');
  const quotedAmountAtto = raw.quotedAmountAtto === undefined || raw.quotedAmountAtto === null
    ? null
    : String(raw.quotedAmountAtto).trim();
  if (quotedAmountAtto !== null && !/^\d+$/.test(quotedAmountAtto)) {
    throw new TypeError('Activity quoted amount must be an attoGEN integer.');
  }
  const objective = optionalUpperText(raw.objective);
  if (objective !== null && !OBJECTIVES.has(objective)) throw new RangeError('Activity objective is invalid.');
  const rawChildHash = String(raw.childHash || '').trim().toLowerCase();
  const childHash = rawChildHash || null;
  if (childHash !== null && !HASH_PATTERN.test(childHash)) throw new TypeError('Activity child transaction hash is invalid.');
  const deliveryStatus = optionalUpperText(raw.deliveryStatus);
  if (deliveryStatus !== null && !DELIVERY_STATUSES.has(deliveryStatus)) {
    throw new RangeError('Activity delivery status is invalid.');
  }
  if (type === 'CLAIM') {
    if (deliveryStatus === 'DELIVERED' && childHash === null) {
      throw new TypeError('A delivered claim must include its child transaction hash.');
    }
    // Records written by older builds used FINALIZED for parent claim state.
    // Migrate them fail-closed until child delivery can be independently
    // proven and persisted.
    if (status === 'FINALIZED' && deliveryStatus !== 'DELIVERED') status = 'REVIEW';
  }
  const createdAt = Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now;
  const updatedAt = Number.isSafeInteger(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now;
  return Object.freeze({
    hash,
    type,
    status,
    account,
    contractAddress,
    deploymentAlias,
    roundId: optionalUpperText(raw.roundId),
    assetId: optionalUpperText(raw.assetId),
    objective,
    amountAtto,
    quotedAmountAtto: type === 'CLAIM' ? quotedAmountAtto : null,
    childHash: type === 'CLAIM' ? childHash : null,
    deliveryStatus: type === 'CLAIM' ? deliveryStatus : null,
    createdAt,
    updatedAt,
  });
}

function loadRecords(storage, now) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((record) => {
      try {
        return [normalizeRecord(record, now)];
      } catch {
        return [];
      }
    }).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function createActivityStore({ storage = globalThis.localStorage, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Activity clock must be a function.');
  let records = loadRecords(storage, Number(now()));

  function persist() {
    try {
      storage?.setItem?.(STORAGE_KEY, JSON.stringify(records));
    } catch {
      // Private browsing and quota failures must not block a wallet action.
    }
  }

  return Object.freeze({
    upsert(raw) {
      const timestamp = Number(now());
      const incoming = normalizeRecord({ ...raw, updatedAt: timestamp }, timestamp);
      const index = records.findIndex((record) =>
        record.hash === incoming.hash
        && record.contractAddress === incoming.contractAddress
        && (
          record.deploymentAlias === incoming.deploymentAlias
          || record.deploymentAlias === null
          || incoming.deploymentAlias === null
        ));
      if (index >= 0) {
        const previous = records[index];
        if (
          previous.childHash
          && incoming.childHash
          && previous.childHash !== incoming.childHash
        ) {
          throw new Error('Activity child transaction hash conflicts with the persisted claim.');
        }
        if (
          previous.quotedAmountAtto
          && incoming.quotedAmountAtto
          && previous.quotedAmountAtto !== incoming.quotedAmountAtto
        ) {
          throw new Error('Activity claim quote conflicts with the persisted signing intent.');
        }
        const progressed = STATUS_RANK[incoming.status] >= STATUS_RANK[previous.status];
        const status = progressed ? incoming.status : previous.status;
        const deliveryStatus = previous.deliveryStatus === 'DELIVERED'
          ? 'DELIVERED'
          : incoming.deliveryStatus || previous.deliveryStatus;
        records.splice(index, 1);
        records.unshift(Object.freeze({
          ...previous,
          ...incoming,
          type: previous.type,
          account: previous.account,
          contractAddress: previous.contractAddress,
          deploymentAlias: previous.deploymentAlias || incoming.deploymentAlias,
          status,
          quotedAmountAtto: previous.quotedAmountAtto || incoming.quotedAmountAtto,
          childHash: previous.childHash || incoming.childHash,
          deliveryStatus,
          createdAt: previous.createdAt,
          updatedAt: progressed ? incoming.updatedAt : previous.updatedAt,
        }));
      } else {
        records.unshift(incoming);
      }
      records = records.slice(0, MAX_RECORDS);
      persist();
      return records[0];
    },
    list({ account = '', contractAddress = '', deploymentAlias = '', limit = 8 } = {}) {
      const normalizedAccount = String(account || '').trim().toLowerCase();
      const normalizedContract = String(contractAddress || '').trim().toLowerCase();
      const normalizedDeployment = String(deploymentAlias || '').trim().toLowerCase();
      if (normalizedDeployment && !DEPLOYMENT_ALIASES.has(normalizedDeployment)) {
        throw new RangeError('Activity deployment alias filter is invalid.');
      }
      const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECORDS) : 8;
      return Object.freeze(records
        .filter((record) => !normalizedAccount || record.account === normalizedAccount)
        .filter((record) => !normalizedContract || record.contractAddress === normalizedContract)
        .filter((record) => !normalizedDeployment || record.deploymentAlias === normalizedDeployment)
        .slice(0, safeLimit));
    },
  });
}

export { MAX_RECORDS, STORAGE_KEY };
