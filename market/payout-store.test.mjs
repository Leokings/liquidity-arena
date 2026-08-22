import assert from 'node:assert/strict';
import test from 'node:test';

import { PAYOUT_STORAGE_KEY, createPayoutStore } from './payout-store.js';

const ACCOUNT = `0x${'1'.repeat(40)}`;
const CONTRACT = `0x${'2'.repeat(40)}`;
const VAULT = `0x${'3'.repeat(40)}`;
const PAYOUT_ID = '4'.repeat(64);

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    values,
  };
}

function payout(overrides = {}) {
  return {
    payoutId: PAYOUT_ID,
    account: ACCOUNT,
    contractAddress: CONTRACT,
    chainId: 4221,
    epochEndTimestamp: 1_787_155_200,
    objective: 'HIGH',
    amountAtto: '1000000000000000000',
    state: 'PREPARING',
    vault: '',
    hashes: {},
    ...overrides,
  };
}

test('payout recovery is keyed by immutable payout ID and survives reload', () => {
  const backing = storage();
  let now = 1;
  const store = createPayoutStore({ storage: backing, now: () => now });
  store.upsert(payout());
  now += 1;
  store.upsert(payout({
    state: 'DISPATCHED',
    vault: VAULT,
    hashes: { DISPATCH: `0x${'5'.repeat(64)}` },
  }));
  const recovered = createPayoutStore({ storage: backing, now: () => now }).get(PAYOUT_ID);
  assert.equal(recovered.state, 'DISPATCHED');
  assert.equal(recovered.vault, VAULT);
  assert.equal(recovered.hashes.DISPATCH, `0x${'5'.repeat(64)}`);
  assert.equal(PAYOUT_STORAGE_KEY, 'liquidity-arena:v8:payouts:v2');
});

test('failed and dropped EVM withdrawals remain durable and permit a new exact attempt after restart', () => {
  const backing = storage();
  let now = 100;
  let store = createPayoutStore({ storage: backing, now: () => now });
  store.upsert(payout({ state: 'FUNDED_IN_ESCROW', vault: VAULT }));
  const failedHash = `0x${'a'.repeat(64)}`;
  store.prepareWithdrawal(PAYOUT_ID);
  store.recordWithdrawalAttempt(PAYOUT_ID, { hash: failedHash, status: 'SUBMITTED' });
  now += 1;
  store.recordWithdrawalAttempt(PAYOUT_ID, { hash: failedHash, status: 'FAILED' });

  store = createPayoutStore({ storage: backing, now: () => now });
  assert.equal(store.latestWithdrawalAttempt(PAYOUT_ID).status, 'FAILED');
  const retryHash = `0x${'b'.repeat(64)}`;
  now += 1;
  store.prepareWithdrawal(PAYOUT_ID);
  store.recordWithdrawalAttempt(PAYOUT_ID, { hash: retryHash, status: 'SUBMITTED' });
  now += 1;
  store.recordWithdrawalAttempt(PAYOUT_ID, { hash: retryHash, status: 'DROPPED' });

  const recovered = createPayoutStore({ storage: backing, now: () => now }).get(PAYOUT_ID);
  assert.deepEqual(
    recovered.withdrawalAttempts.map(({ hash, status }) => ({ hash, status })),
    [
      { hash: failedHash, status: 'FAILED' },
      { hash: retryHash, status: 'DROPPED' },
    ],
  );
});

test('a pending withdrawal blocks duplicate signing but a late receipt can still finalize it', () => {
  const store = createPayoutStore({ storage: storage(), now: () => 10 });
  store.upsert(payout({ state: 'FUNDED_IN_ESCROW', vault: VAULT }));
  const pendingHash = `0x${'c'.repeat(64)}`;
  store.prepareWithdrawal(PAYOUT_ID);
  store.recordWithdrawalAttempt(PAYOUT_ID, { hash: pendingHash, status: 'PENDING' });
  assert.throws(
    () => store.recordWithdrawalAttempt(PAYOUT_ID, {
      hash: `0x${'d'.repeat(64)}`,
      status: 'SUBMITTED',
    }),
    /still pending verification/,
  );
  store.recordWithdrawalAttempt(PAYOUT_ID, { hash: pendingHash, status: 'FINALIZED' });
  assert.equal(store.latestWithdrawalAttempt(PAYOUT_ID).status, 'FINALIZED');
  assert.throws(
    () => store.recordWithdrawalAttempt(PAYOUT_ID, { hash: pendingHash, status: 'DROPPED' }),
    /cannot be downgraded/,
  );
});

test('journal writes fail closed before signing when durable storage rejects the write', () => {
  const store = createPayoutStore({
    storage: {
      getItem() { return null; },
      setItem() { throw new Error('quota denied'); },
    },
  });
  assert.throws(
    () => store.upsert(payout({ state: 'FUNDED_IN_ESCROW', vault: VAULT })),
    (error) => error?.code === 'PAYOUT_JOURNAL_WRITE_FAILED'
      && error?.durable === false
      && /not durably writable/.test(error.message),
  );
  assert.equal(store.get(PAYOUT_ID), null);
});

test('a durable PREPARED intent blocks duplicate signing after a crash without a transaction hash', () => {
  const backing = storage();
  let store = createPayoutStore({ storage: backing, now: () => 10 });
  store.upsert(payout({ state: 'FUNDED_IN_ESCROW', vault: VAULT }));
  store.prepareWithdrawal(PAYOUT_ID);

  store = createPayoutStore({ storage: backing, now: () => 11 });
  assert.equal(store.get(PAYOUT_ID).withdrawalIntent.status, 'PREPARED');
  assert.equal(store.latestWithdrawalAttempt(PAYOUT_ID), null);
  assert.throws(
    () => store.prepareWithdrawal(PAYOUT_ID),
    /signing intent is already prepared/,
  );
});

test('post-broadcast persistence failure retains the exact hash in-session and PREPARED lock on crash', () => {
  const backing = storage();
  let failWrites = false;
  const flaky = {
    getItem: backing.getItem,
    setItem(key, value) {
      if (failWrites) throw new Error('quota changed after broadcast');
      backing.setItem(key, value);
    },
  };
  const hash = `0x${'e'.repeat(64)}`;
  const store = createPayoutStore({ storage: flaky, now: () => 20 });
  store.upsert(payout({ state: 'FUNDED_IN_ESCROW', vault: VAULT }));
  store.prepareWithdrawal(PAYOUT_ID);
  failWrites = true;
  assert.throws(
    () => store.recordWithdrawalAttempt(PAYOUT_ID, { hash, status: 'SUBMITTED' }),
    (error) => error?.code === 'PAYOUT_JOURNAL_WRITE_FAILED'
      && error?.hash === hash
      && error?.withdrawalStatus === 'PENDING'
      && error?.durable === false
      && error.message.includes(hash),
  );
  assert.deepEqual(
    store.latestWithdrawalAttempt(PAYOUT_ID),
    {
      hash,
      status: 'SUBMITTED',
      createdAt: 20,
      updatedAt: 20,
    },
  );
  assert.throws(() => store.prepareWithdrawal(PAYOUT_ID), /previous EVM withdrawal/);

  const afterCrash = createPayoutStore({ storage: backing, now: () => 21 });
  assert.equal(afterCrash.get(PAYOUT_ID).withdrawalIntent.status, 'PREPARED');
  assert.equal(afterCrash.latestWithdrawalAttempt(PAYOUT_ID), null);
  assert.throws(() => afterCrash.prepareWithdrawal(PAYOUT_ID), /already prepared/);
});

test('payout journal rejects account, chain, contract, amount, and hash conflicts', () => {
  const store = createPayoutStore({ storage: storage() });
  store.upsert(payout());
  assert.throws(() => store.upsert(payout({ account: `0x${'6'.repeat(40)}` })), /conflicts/);
  assert.throws(() => store.upsert(payout({ chainId: 1 })), /must be Bradbury 4221/);
  store.upsert(payout({ hashes: { CLAIM: `0x${'7'.repeat(64)}` } }));
  assert.throws(
    () => store.upsert(payout({ hashes: { CLAIM: `0x${'8'.repeat(64)}` } })),
    /hash conflicts/,
  );
  assert.throws(
    () => store.upsert(payout({ hashes: { UNKNOWN: `0x${'8'.repeat(64)}` } })),
    /hash key UNKNOWN is invalid/,
  );
});

test('payout stages never downgrade and a prepared vault becomes immutable', () => {
  const store = createPayoutStore({ storage: storage(), now: () => 10 });
  store.upsert(payout({ state: 'DISPATCHED', vault: VAULT }));
  const retained = store.upsert(payout({ state: 'PREPARING', vault: '' }));
  assert.equal(retained.state, 'DISPATCHED');
  assert.equal(retained.vault, VAULT);
  assert.throws(
    () => store.upsert(payout({
      state: 'FUNDED_IN_ESCROW',
      vault: `0x${'9'.repeat(40)}`,
    })),
    /vault conflicts/,
  );
});
