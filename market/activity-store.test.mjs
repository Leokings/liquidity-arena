import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_RECORDS, STORAGE_KEY, createActivityStore } from './activity-store.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x2222222222222222222222222222222222222222';
const V7_CONTRACT = '0x7777777777777777777777777777777777777777';
const hash = (index) => `0x${index.toString(16).padStart(64, '0')}`;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    values,
  };
}

test('activity hashes persist across reloads and progress without finalized downgrades', () => {
  const storage = memoryStorage();
  let timestamp = 1_000;
  const first = createActivityStore({ storage, now: () => timestamp });
  first.upsert({
    hash: hash(1), type: 'WAGER', status: 'SUBMITTED', account: ACCOUNT,
    contractAddress: CONTRACT, roundId: 'crypto-001', assetId: 'btc_usd',
    objective: 'high', amountAtto: 100n,
  });
  first.upsert({
    hash: hash(1), type: 'WAGER', status: 'FINALIZED',
    account: '0x3333333333333333333333333333333333333333',
    contractAddress: CONTRACT, roundId: 'CRYPTO-001', assetId: 'BTC_USD',
    objective: 'HIGH', amountAtto: '100',
  });
  timestamp = 2_000;
  first.upsert({
    hash: hash(1), type: 'WAGER', status: 'FINALIZED', account: ACCOUNT,
    contractAddress: CONTRACT, roundId: 'CRYPTO-001', assetId: 'BTC_USD',
    objective: 'HIGH', amountAtto: '100',
  });
  first.upsert({
    hash: hash(1), type: 'WAGER', status: 'REVIEW', account: ACCOUNT,
    contractAddress: CONTRACT, roundId: 'CRYPTO-001', assetId: 'BTC_USD',
    objective: 'HIGH', amountAtto: '100',
  });

  const reloaded = createActivityStore({ storage, now: () => 3_000 });
  const [record] = reloaded.list({ account: ACCOUNT.toUpperCase(), contractAddress: CONTRACT });
  assert.equal(record.status, 'FINALIZED');
  assert.equal(record.createdAt, 1_000);
  assert.equal(record.updatedAt, 2_000);
  assert.equal(record.roundId, 'CRYPTO-001');
  assert.equal(record.objective, 'HIGH');
  assert.equal(record.account, ACCOUNT);
  assert.equal(JSON.parse(storage.values.get(STORAGE_KEY)).length, 1);
});

test('activity storage discards malformed data, filters accounts, and stays bounded', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, '{broken');
  const store = createActivityStore({ storage, now: () => 10 });
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.upsert({ hash: 'bad' }), /hash/i);

  for (let index = 1; index <= MAX_RECORDS + 5; index += 1) {
    store.upsert({
      hash: hash(index), type: 'CLAIM', status: 'SUBMITTED', account: ACCOUNT,
      contractAddress: CONTRACT, roundId: `ROUND-${index}`,
    });
  }
  assert.equal(store.list({ limit: MAX_RECORDS }).length, MAX_RECORDS);
  assert.equal(store.list({ account: '0x3333333333333333333333333333333333333333' }).length, 0);
});

test('claim activity requires finalized child delivery and preserves its child hash', () => {
  const storage = memoryStorage();
  const store = createActivityStore({ storage, now: () => 10 });
  const parent = hash(100);
  const child = hash(101);
  const otherChild = hash(102);
  const base = {
    hash: parent,
    type: 'CLAIM',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    roundId: 'CRYPTO-001',
    amountAtto: '200',
  };

  store.upsert({ ...base, status: 'FINALIZED' });
  assert.equal(store.list()[0].status, 'REVIEW');
  store.upsert({
    ...base,
    status: 'FINALIZED',
    childHash: child,
    deliveryStatus: 'DELIVERED',
  });
  assert.equal(store.list()[0].status, 'FINALIZED');
  assert.equal(store.list()[0].deliveryStatus, 'DELIVERED');

  store.upsert({ ...base, status: 'REVIEW', childHash: child, deliveryStatus: 'REVIEW' });
  assert.equal(store.list()[0].status, 'FINALIZED');
  assert.equal(store.list()[0].deliveryStatus, 'DELIVERED');
  assert.throws(
    () => store.upsert({
      ...base,
      status: 'REVIEW',
      childHash: otherChild,
      deliveryStatus: 'REVIEW',
    }),
    /child transaction hash conflicts/,
  );
});

test('claim activity keeps the signing quote as intent metadata and persists the finalized amount', () => {
  const storage = memoryStorage();
  const store = createActivityStore({ storage, now: () => 10 });
  const parent = hash(150);
  const child = hash(151);
  const base = {
    hash: parent,
    type: 'CLAIM',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    roundId: '1787162400',
    objective: 'LOW',
    quotedAmountAtto: '200',
  };

  store.upsert({
    ...base,
    status: 'SUBMITTED',
    amountAtto: null,
    deliveryStatus: 'PENDING',
  });
  assert.equal(store.list()[0].quotedAmountAtto, '200');
  assert.equal(store.list()[0].amountAtto, null);

  store.upsert({
    ...base,
    status: 'FINALIZED',
    amountAtto: '201',
    childHash: child,
    deliveryStatus: 'DELIVERED',
  });
  const [record] = createActivityStore({ storage, now: () => 20 }).list();
  assert.equal(record.quotedAmountAtto, '200');
  assert.equal(record.amountAtto, '201');
  assert.equal(record.status, 'FINALIZED');
});

test('legacy claim quote survives repeated below-quote recovery reloads', () => {
  const storage = memoryStorage();
  let timestamp = 10;
  const parent = hash(175);
  const legacyStore = createActivityStore({ storage, now: () => timestamp });
  legacyStore.upsert({
    hash: parent,
    type: 'CLAIM',
    status: 'REVIEW',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    deploymentAlias: 'v6',
    roundId: '1787162400',
    objective: 'LOW',
    amountAtto: '200',
    deliveryStatus: 'REVIEW',
  });

  const reconcileBelowQuote = (store) => {
    const [record] = store.list();
    const signingQuoteAtto = BigInt(record.quotedAmountAtto ?? record.amountAtto);
    const claimedAtto = 199n;
    assert.equal(claimedAtto >= signingQuoteAtto, false);
    store.upsert({
      ...record,
      quotedAmountAtto: signingQuoteAtto.toString(),
      amountAtto: claimedAtto.toString(),
      deliveryStatus: 'REVIEW',
      status: 'REVIEW',
    });
  };

  reconcileBelowQuote(legacyStore);
  timestamp = 20;
  const firstReload = createActivityStore({ storage, now: () => timestamp });
  assert.equal(firstReload.list()[0].quotedAmountAtto, '200');
  assert.equal(firstReload.list()[0].amountAtto, '199');

  reconcileBelowQuote(firstReload);
  timestamp = 30;
  const secondReload = createActivityStore({ storage, now: () => timestamp });
  assert.equal(secondReload.list()[0].quotedAmountAtto, '200');
  assert.equal(secondReload.list()[0].amountAtto, '199');
  assert.equal(secondReload.list()[0].status, 'REVIEW');
  assert.equal(secondReload.list()[0].deliveryStatus, 'REVIEW');
  assert.throws(() => secondReload.upsert({
    ...secondReload.list()[0],
    quotedAmountAtto: '198',
  }), /quote conflicts/i);
});

test('V6 timeout-refund activity and LOW objective survive reload recovery', () => {
  const storage = memoryStorage();
  const first = createActivityStore({ storage, now: () => 50 });
  first.upsert({
    hash: hash(200),
    type: 'TIMEOUT_REFUND',
    status: 'SUBMITTED',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    roundId: '1787155200',
    objective: 'LOW',
  });

  const [record] = createActivityStore({ storage, now: () => 60 }).list();
  assert.equal(record.type, 'TIMEOUT_REFUND');
  assert.equal(record.objective, 'LOW');
  assert.equal(record.roundId, '1787155200');
});

test('deployment identity upgrades legacy V6 records without changing the v2 storage key', () => {
  const storage = memoryStorage();
  const store = createActivityStore({ storage, now: () => 10 });
  store.upsert({
    hash: hash(201),
    type: 'WAGER',
    status: 'SUBMITTED',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    roundId: '1787162400',
    objective: 'HIGH',
  });
  store.upsert({
    hash: hash(201),
    type: 'WAGER',
    status: 'FINALIZED',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    deploymentAlias: 'v6',
    roundId: '1787162400',
    objective: 'HIGH',
  });
  const [record] = store.list({ deploymentAlias: 'v6' });
  assert.equal(record.deploymentAlias, 'v6');
  assert.equal(record.status, 'FINALIZED');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).length, 1);
  store.upsert({
    hash: hash(202),
    type: 'WAGER',
    status: 'FINALIZED',
    account: ACCOUNT,
    contractAddress: V7_CONTRACT,
    deploymentAlias: 'v7',
    roundId: '1787162400',
    objective: 'HIGH',
  });
  assert.deepEqual(
    store.list({ account: ACCOUNT }).map((item) => item.deploymentAlias),
    ['v7', 'v6'],
  );
  assert.throws(() => store.upsert({
    ...record,
    hash: `0x${'f'.repeat(64)}`,
    deploymentAlias: 'arbitrary',
  }), /deployment alias is invalid/);
});
