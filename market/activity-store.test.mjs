import assert from 'node:assert/strict';
import test from 'node:test';

import { STORAGE_KEY, createActivityStore } from './activity-store.js';

const ACCOUNT = `0x${'a'.repeat(40)}`;
const CONTRACT = `0x${'b'.repeat(40)}`;
const PAYOUT_ID = 'c'.repeat(64);
const HASH = `0x${'d'.repeat(64)}`;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    values,
  };
}

function record(overrides = {}) {
  return {
    hash: HASH,
    type: 'DISPATCH',
    status: 'SUBMITTED',
    domain: 'GENLAYER',
    account: ACCOUNT,
    contractAddress: CONTRACT,
    roundId: '1787155200',
    objective: 'HIGH',
    amountAtto: '100',
    payoutId: PAYOUT_ID,
    ...overrides,
  };
}

test('V8 activity progresses durably without allowing identity conflicts or downgrade', () => {
  const storage = memoryStorage();
  let now = 100;
  const store = createActivityStore({ storage, now: () => now });
  store.upsert(record());
  now += 1;
  store.upsert(record({ status: 'FINALIZED' }));
  now += 1;
  store.upsert(record({ status: 'REVIEW' }));
  const [saved] = createActivityStore({ storage, now: () => now }).list({ account: ACCOUNT });
  assert.equal(saved.status, 'FINALIZED');
  assert.equal(saved.deploymentAlias, 'v8');
  assert.equal(saved.payoutId, PAYOUT_ID);
  assert.throws(() => store.upsert(record({ account: `0x${'e'.repeat(40)}` })), /conflicts/);
});

test('EVM domain is reserved exclusively for recipient vault withdrawal', () => {
  const store = createActivityStore({ storage: memoryStorage() });
  assert.throws(() => store.upsert(record({ domain: 'EVM' })), /Only the recipient vault withdrawal/);
  const saved = store.upsert(record({ type: 'WITHDRAW_EVM', domain: 'EVM' }));
  assert.equal(saved.domain, 'EVM');
  assert.equal(saved.type, 'WITHDRAW_EVM');
});

test('new storage key does not import old payout or claim records', () => {
  const storage = memoryStorage();
  storage.setItem('liquidity-arena:activity:v2', JSON.stringify([record()]));
  const store = createActivityStore({ storage });
  assert.equal(store.list().length, 0);
  assert.equal(STORAGE_KEY, 'liquidity-arena:v8:activity:v1');
});

test('malformed persisted data is discarded and V8 filters remain bounded', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, '[{"hash":"bad"}]');
  const store = createActivityStore({ storage });
  assert.equal(store.list().length, 0);
  for (let index = 0; index < 120; index += 1) {
    store.upsert(record({ hash: `0x${index.toString(16).padStart(64, '0')}` }));
  }
  assert.equal(store.list({ limit: 1_000 }).length, 100);
  assert.throws(() => store.list({ deploymentAlias: 'v7' }), /Only V8/);
});
