import { expect, test } from '@playwright/test';

import {
  CLAIM_EPOCH,
  E2E_ACCOUNT,
  V8_CONTRACT,
  installBradburyV8RpcMock,
  installBradburyWalletMock,
  installHermeticBinanceMock,
  seedPendingWithdrawalJournal,
} from './fixtures/bradbury-v8.mjs';

const USER_CONTRACT = '0x1111111111111111111111111111111111111111';
let binanceMock;

test.beforeEach(async ({ page }) => {
  await installBradburyV8RpcMock(page);
  binanceMock = await installHermeticBinanceMock(page);
});

test('retired deployment routes canonicalize to the sole V8 market', async ({ page }) => {
  for (const retired of ['v6', 'v7']) {
    const response = await page.goto(`/market.html?deployment=${retired}&feed=demo`);
    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL(/deployment=v8/);
    await expect(page.locator('#market-app')).toBeVisible();
    await expect(page.locator('#battle-card')).toHaveAttribute('data-deployment', 'v8');
    await expect(page.locator('#battle-card')).toHaveAttribute(
      'data-target-protocol',
      'LIQUIDITY_ARENA_V8',
    );
    await expect(page.locator('#network-escrow-copy')).toContainText('sole deployment on Bradbury');
    await expect(page.locator('body')).not.toContainText(/LIQUIDITY_ARENA_V[67]/);
  }
});

test('an arbitrary contract route is rejected and cannot expose a money action', async ({ page }) => {
  const response = await page.goto(
    `/market.html?deployment=v8&contract=${USER_CONTRACT}&feed=demo`,
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#prediction-button')).toBeDisabled();
  await expect(page.locator('#prediction-availability')).toContainText(
    'Contract-address routes are forbidden',
  );
  await expect(page.locator('#battle-card')).toHaveAttribute('data-contract-address', V8_CONTRACT);
  await expect(page.locator('#battle-card')).not.toHaveAttribute('data-contract-address', USER_CONTRACT);
});

test('a retired claim deep link becomes a V8 reconnect intent, never an old claim route', async ({ page }) => {
  const response = await page.goto(
    `/market.html?deployment=v7&feed=live&epoch=${CLAIM_EPOCH}&objective=highest&claim=1`,
  );
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveURL(/deployment=v8/);
  await expect(page).toHaveURL(new RegExp(`epoch=${CLAIM_EPOCH}`));
  await expect(page).toHaveURL(/objective=highest/);
  await expect(page).toHaveURL(/claim=1/);
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#claim-reconnect')).toBeVisible();
  await expect(page.locator('#claim-reconnect')).toContainText('RECONNECT WALLET');
  await expect(page.locator('#claim-reconnect')).toBeFocused();
  await expect(page.locator('[data-claim-deployment="v6"], [data-claim-deployment="v7"]'))
    .toHaveCount(0);
  await expect.poll(() => binanceMock.requests.some((request) =>
    request.startsWith('/api/binance/klines?'))).toBe(true);
});

test('configured Bradbury wallet reconnect scans V8 quotes and never duplicates a pending vault withdrawal', async ({ page }) => {
  await installBradburyWalletMock(page);
  await seedPendingWithdrawalJournal(page);
  const response = await page.goto(
    `/market.html?deployment=v8&feed=live&epoch=${CLAIM_EPOCH}&objective=highest`,
    { waitUntil: 'domcontentloaded' },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#battle-card')).toHaveAttribute('data-contract-address', V8_CONTRACT);
  await expect.poll(() => binanceMock.requests.some((request) =>
    request.startsWith('/api/binance/klines?'))).toBe(true);

  await page.locator('#wallet-button').click();
  await expect(page.locator('#wallet-label')).toContainText('0x6303');
  await expect.poll(() => page.evaluate(() =>
    window.__e2eWalletRequests.map(({ method }) => method))).toEqual(expect.arrayContaining([
    'eth_requestAccounts',
    'wallet_addEthereumChain',
    'wallet_switchEthereumChain',
  ]));

  await page.locator('#selected-orb').click();
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#position-payout-stage')).toHaveText('FUNDED IN ESCROW');
  await expect(page.locator('#claim-wager')).toContainText('VERIFY PENDING EVM WITHDRAWAL');
  await page.locator('#claim-wager').click();
  await expect(page.locator('#modal-status')).toContainText('still pending on Bradbury');
  expect(await page.evaluate(() =>
    window.__e2eWalletRequests.filter(({ method }) => method === 'eth_sendTransaction').length)).toBe(0);

  const persisted = await page.evaluate(() => JSON.parse(
    localStorage.getItem('liquidity-arena:v8:payouts:v2'),
  )[0]);
  expect(persisted.account).toBe(E2E_ACCOUNT);
  expect(persisted.withdrawalAttempts.at(-1).status).toBe('PENDING');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#wallet-button').click();
  await page.locator('#selected-orb').click();
  await expect(page.locator('#claim-wager')).toContainText('VERIFY PENDING EVM WITHDRAWAL');
});

test('the V8 payout panel exposes stages and recipient vault controls accessibly', async ({ page }) => {
  const response = await page.goto('/market.html?deployment=v8&feed=demo');
  expect(response?.ok()).toBe(true);
  const opener = page.locator('#selected-orb');
  await opener.click();
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#position-payout-stage')).toBeVisible();
  await expect(page.locator('#position-payout-vault')).toBeVisible();
  await expect(page.locator('#claim-wager')).toBeVisible();
  await expect(page.locator('#payout-secondary')).toBeHidden();
  await expect(page.getByText('Bradbury V8 test escrow.')).toBeVisible();

  await expect.poll(() => page.evaluate(() =>
    document.querySelector('.prediction-modal').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#prediction-modal')).toBeHidden();
  await expect(opener).toBeFocused();
});
