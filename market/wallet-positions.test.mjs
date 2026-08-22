import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearWalletClaimIntentHref,
  readWalletPositionPage,
  walletClaimIntentFromHref,
  walletClaimTarget,
} from './wallet-positions.js';

const EPOCH = 1_787_155_200;

test('V8 claim intent preserves exact epoch and objective', () => {
  for (const [direction, objective] of [['highest', 'HIGH'], ['lowest', 'LOW']]) {
    const intent = walletClaimIntentFromHref(
      `https://arena.example/market.html?deployment=v8&epoch=${EPOCH}&objective=${direction}&claim=1`,
    );
    assert.deepEqual(intent, { deploymentAlias: 'v8', epochEndTimestamp: EPOCH, objective });
  }
  assert.deepEqual(walletClaimTarget({ epochEndTimestamp: EPOCH, objective: 'LOW' }), {
    epochEndTimestamp: EPOCH,
    objective: 'LOW',
  });
});

test('claim intent rejects ambiguous, non-hourly, and retired routes', () => {
  assert.equal(walletClaimIntentFromHref(`https://arena.example/?deployment=v8&epoch=${EPOCH}&objective=highest`), null);
  assert.equal(walletClaimIntentFromHref(`https://arena.example/?deployment=v8&epoch=${EPOCH + 1}&objective=highest&claim=1`), null);
  assert.equal(walletClaimIntentFromHref(`https://arena.example/?deployment=v8&epoch=${EPOCH}&objective=sideways&claim=1`), null);
  assert.equal(walletClaimIntentFromHref(`https://arena.example/?deployment=v7&epoch=${EPOCH}&objective=highest&claim=1`), null);
});

test('clearing claim intent retains V8 payout recovery identity', () => {
  const after = new URL(clearWalletClaimIntentHref(
    `https://arena.example/?deployment=v8&epoch=${EPOCH}&objective=lowest&claim=1`,
  ));
  assert.equal(after.searchParams.get('claim'), null);
  assert.equal(after.searchParams.get('deployment'), 'v8');
  assert.equal(after.searchParams.get('epoch'), String(EPOCH));
  assert.equal(after.searchParams.get('objective'), 'lowest');
});

function rawQuote(epoch, objective, stake = '0') {
  return {
    epoch_end_timestamp: epoch,
    objective,
    account: '0x1111111111111111111111111111111111111111',
    stake_atto: stake,
  };
}

test('wallet history scans epoch IDs backward and reads both objectives without a wallet index', async () => {
  const calls = [];
  const gateway = {
    connected: true,
    account: '0x1111111111111111111111111111111111111111',
    contractAddress: '0x2222222222222222222222222222222222222222',
    async readEpochPage(offset, limit) {
      calls.push(['page', offset, limit]);
      if (offset === 0 && limit === 1) {
        return { offset: 0, next_offset: 1, total: 3, epoch_ids: [EPOCH - 7_200] };
      }
      return { offset: 1, next_offset: 3, total: 3, epoch_ids: [EPOCH - 3_600, EPOCH] };
    },
    async readEpochClaimQuote(epoch, objective, account) {
      calls.push(['quote', epoch, objective, account]);
      return rawQuote(epoch, objective, epoch === EPOCH && objective === 'LOW' ? '10' : '0');
    },
  };
  const page = await readWalletPositionPage({ gateway, account: gateway.account, pageSize: 2 });
  assert.equal(page.totalEpochs, 3);
  assert.equal(page.scannedEpochs, 2);
  assert.equal(page.complete, false);
  assert.equal(page.nextCursor.nextOffset, 1);
  assert.deepEqual(page.positions.map(({ identity }) => identity), [
    `${gateway.contractAddress}:${EPOCH}:LOW`,
  ]);
  assert.deepEqual(calls.slice(0, 2), [['page', 0, 1], ['page', 1, 2]]);
  assert.equal(calls.filter(([kind]) => kind === 'quote').length, 4);
});

test('history cursor counts epochs scanned and rejects account/index drift', async () => {
  const account = '0x1111111111111111111111111111111111111111';
  const contractAddress = '0x2222222222222222222222222222222222222222';
  const gateway = {
    connected: true,
    account,
    contractAddress,
    async readEpochPage() {
      return { offset: 0, next_offset: 1, total: 3, epoch_ids: [EPOCH - 7_200] };
    },
    async readEpochClaimQuote(epoch, objective) { return rawQuote(epoch, objective); },
  };
  const cursor = { account, contractAddress, totalEpochs: 3, nextOffset: 1, scannedEpochs: 2 };
  const finalPage = await readWalletPositionPage({ gateway, account, cursor, pageSize: 2 });
  assert.equal(finalPage.scannedEpochs, 3);
  assert.equal(finalPage.complete, true);
  assert.equal(finalPage.nextCursor, null);

  gateway.readEpochPage = async () => ({
    offset: 0,
    next_offset: 1,
    total: 4,
    epoch_ids: [EPOCH - 7_200],
  });
  await assert.rejects(
    readWalletPositionPage({ gateway, account, cursor, pageSize: 2 }),
    /changed or returned an inconsistent/,
  );
  await assert.rejects(
    readWalletPositionPage({ gateway, account: '0x3333333333333333333333333333333333333333' }),
    /Connected wallet changed/,
  );
});
