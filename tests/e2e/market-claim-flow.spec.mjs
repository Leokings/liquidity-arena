import { expect, test } from '@playwright/test';
import {
  CLAIM_EPOCH,
  V6_CLAIM_EPOCH,
  V6_CONTRACT,
  V7_CONTRACT,
  installStudioNetRpcMock,
  installWalletMock,
} from './fixtures/studionet.mjs';

async function failStudioNetReadsFast(page) {
  await page.route('**/genlayer-rpc', async (route) => {
    let id = null;
    try {
      const body = route.request().postDataJSON();
      id = Array.isArray(body) ? body[0]?.id ?? null : body?.id ?? null;
    } catch {
      // An invalid body should still receive a deterministic JSON-RPC failure.
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32_000, message: 'StudioNet is intentionally unavailable in this UI test.' },
      }),
    });
  });
}

test('renders the market shell and primary controls', async ({ page }) => {
  await failStudioNetReadsFast(page);

  const response = await page.goto('/market.html?deployment=v7&feed=demo');

  expect(response?.ok()).toBe(true);
  await expect(page.locator('#market-app')).toBeVisible();
  await expect(page.getByText('LIQUIDITY ARENA', { exact: true })).toBeVisible();
  await expect(page.locator('#wallet-button')).toBeVisible();
  await expect(page.locator('#prediction-modal')).toBeHidden();
  await expect(page.locator('[data-nextjs-dialog], .vite-error-overlay')).toHaveCount(0);
});

test('a claim deep link preserves intent and opens a visible reconnect path', async ({ page }) => {
  await failStudioNetReadsFast(page);

  const response = await page.goto(
    `/market.html?deployment=v7&feed=live&epoch=${CLAIM_EPOCH}&objective=highest&claim=1`,
  );

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveURL(new RegExp(`epoch=${CLAIM_EPOCH}`));
  await expect(page).toHaveURL(/objective=highest/);
  await expect(page).toHaveURL(/claim=1/);
  await expect(page).toHaveURL(/feed=live/);
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#wallet-position')).toBeVisible();
  await expect(page.locator('#claim-reconnect')).toBeVisible();
  await expect(page.locator('#claim-reconnect')).toContainText('RECONNECT WALLET');
  await expect(page.locator('#position-state')).toContainText('RECONNECT TO CLAIM');
});

test('connected OPEN & CLAIM keeps the wallet session and reveals the exact claim action', async ({ page }) => {
  await installWalletMock(page);
  const rpc = await installStudioNetRpcMock(page);

  const response = await page.goto('/market.html?deployment=v7&feed=demo');
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#prediction-button')).toBeEnabled();

  await page.locator('#wallet-button').click();
  await expect(page.locator('#wallet-label')).toContainText('0x6303');
  await expect(page.locator('#prediction-modal')).toBeHidden();
  await expect(page.locator('#prediction-label')).toHaveText('CLAIM 2 REFUNDS · 2 GEN');
  await expect(page.locator('#prediction-button')).toHaveAttribute('data-claim-summary', 'ready');
  expect((await page.locator('#prediction-button').boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.locator('#prediction-button').click();
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#claim-summary')).toBeVisible();
  await expect(page.locator('#claim-summary-total')).toHaveText('2 GEN');

  const claimLink = page.locator(
    '#claim-summary-actions a[data-claim-deployment="v7"]'
      + `[data-claim-epoch="${CLAIM_EPOCH}"][data-claim-objective="HIGH"]`,
  );
  await expect(claimLink).toBeVisible();
  await expect(claimLink).toContainText('CLAIM REFUND');
  const documentId = await page.evaluate(() => window.__e2eDocumentId);

  await claimLink.click();

  await expect(page).toHaveURL(new RegExp(`epoch=${CLAIM_EPOCH}`));
  await expect(page).toHaveURL(/objective=highest/);
  await expect(page).toHaveURL(/claim=1/);
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#claim-reconnect')).toBeHidden();
  await expect(page.locator('#wallet-label')).toContainText('0x6303');
  await expect(page.locator('#claim-wager')).toBeVisible();
  await expect(page.locator('#claim-wager')).toBeEnabled();
  await expect(page.locator('#claim-wager')).toContainText('CLAIM REFUND');
  expect(await page.evaluate(() => window.__e2eDocumentId)).toBe(documentId);
  expect(rpc.calls.filter(({ method }) => method === 'get_entry')).toHaveLength(0);
  expect(rpc.calls.filter(({ method }) => method === 'get_claim_quote').length).toBeGreaterThan(0);
});

test('successfully refreshed older-page gaps use an explicit lower-bound claim total', async ({ page }) => {
  await installWalletMock(page);
  await installStudioNetRpcMock(page, {
    positionCounts: { v7: 51, v6: 0 },
  });

  const response = await page.goto('/market.html?deployment=v7&feed=demo');
  expect(response?.ok()).toBe(true);
  await page.locator('#wallet-button').click();
  await expect(page.locator('#wallet-label')).toContainText('0x6303');

  await expect(page.locator('#prediction-modal')).toBeHidden();
  await expect(page.locator('#prediction-kicker')).toContainText('PARTIAL HISTORY');
  await expect(page.locator('#prediction-label')).toHaveText(
    'CLAIM AT LEAST 50 REFUNDS · ≥50 GEN',
  );
  await expect(page.locator('#prediction-button')).toHaveAttribute('data-claim-summary', 'partial');
  await expect(page.locator('#prediction-button')).toHaveAttribute('data-verification', 'partial');

  await page.locator('#prediction-button').click();
  await expect(page.locator('#claim-summary')).toBeVisible();
  await expect(page.locator('#claim-summary')).toHaveAttribute('data-verification', 'partial');
  await expect(page.locator('#claim-summary-total')).toHaveText('≥50 GEN');
  await expect(page.locator('#claim-summary-copy')).toContainText('lower bound');
  await expect(page.locator('#load-more-positions')).toContainText('1 REMAIN');
  await expect(page.locator('#wallet-history-errors')).toBeHidden();
});

test('load older reports and appends the combined V6 and V7 page capacity', async ({ page }) => {
  await installWalletMock(page);
  await installStudioNetRpcMock(page, {
    positionCounts: { v7: 101, v6: 101 },
  });

  const response = await page.goto('/market.html?deployment=v7&feed=demo');
  expect(response?.ok()).toBe(true);
  await page.locator('#wallet-button').click();
  await expect(page.locator('#prediction-label')).toHaveText(
    'CLAIM AT LEAST 100 REFUNDS · ≥100 GEN',
  );
  await page.locator('#prediction-button').click();

  const loadMore = page.locator('#load-more-positions');
  await expect(loadMore).toHaveAttribute('data-load-count', '100');
  await expect(loadMore).toHaveText('LOAD UP TO 100 OLDER POSITIONS · 102 REMAIN');
  await loadMore.click();

  await expect(loadMore).toHaveAttribute('data-load-count', '2');
  await expect(loadMore).toHaveText('LOAD UP TO 2 OLDER POSITIONS · 2 REMAIN');
  await expect(page.locator('#claim-summary-total')).toHaveText('≥200 GEN');
});

test('a failed refresh never presents cached externally changed claims as a lower bound', async ({ page }) => {
  await installWalletMock(page);
  const positionCounts = { v7: 1, v6: 51 };
  const rpc = await installStudioNetRpcMock(page, { positionCounts });

  const response = await page.goto('/market.html?deployment=v7&feed=demo');
  expect(response?.ok()).toBe(true);
  await page.locator('#wallet-button').click();
  await expect(page.locator('#prediction-label')).toHaveText(
    'CLAIM AT LEAST 51 REFUNDS · ≥51 GEN',
  );
  await page.locator('#prediction-button').click();
  await expect(page.locator('#load-more-positions')).toContainText('1 REMAIN');

  // Model all V6 candidates being claimed in another session just before the
  // next V6 history read becomes unavailable. The UI must retain recovery
  // links without describing that cached snapshot as a current lower bound.
  positionCounts.v6 = 0;
  rpc.failHistoryDeployments.add('v6');
  await page.locator('#load-more-positions').click();

  await expect(page.locator('#wallet-history-errors')).toBeVisible();
  await expect(page.locator('button[data-retry-deployment="v6"]')).toBeVisible();
  await expect(page.locator('#prediction-kicker')).toContainText('LAST VERIFIED / PARTIAL');
  await expect(page.locator('#prediction-label')).toHaveText(
    'REVIEW 51 REFUNDS · 51 GEN LAST VERIFIED',
  );
  await expect(page.locator('#prediction-label')).not.toContainText('AT LEAST');
  await expect(page.locator('#prediction-label')).not.toContainText('≥');
  await expect(page.locator('#claim-summary')).toHaveAttribute('data-verification', 'last-verified');
  await expect(page.locator('#claim-summary-total')).toHaveText('51 GEN · LAST VERIFIED');
  await expect(page.locator('#claim-summary-total')).not.toContainText('≥');
  await expect(page.locator('#claim-summary-copy')).toContainText('Availability may have changed elsewhere');
});

test('zero loaded claims never hides a failed deployment behind the wager CTA', async ({ page }) => {
  await installWalletMock(page);
  await installStudioNetRpcMock(page, {
    positionCounts: { v7: 0 },
    failHistoryDeployments: ['v6'],
  });

  const response = await page.goto('/market.html?deployment=v7&feed=demo');
  expect(response?.ok()).toBe(true);
  await page.locator('#wallet-button').click();
  await expect(page.locator('#wallet-label')).toContainText('0x6303');
  await expect(page.locator('#prediction-label')).toHaveText('CHECK / RETRY CLAIM HISTORY');
  await expect(page.locator('#prediction-button')).toHaveAttribute('data-claim-summary', 'check');
  await expect(page.locator('#prediction-button')).toHaveAttribute('data-verification', 'last-verified');
  await expect(page.locator('#prediction-button')).toBeEnabled();

  await page.locator('#prediction-button').click();
  await expect(page.locator('#wallet-history-errors')).toBeVisible();
  await expect(page.locator('button[data-retry-deployment="v6"]')).toBeVisible();
});

test('cross-deployment claim route reloads intentionally and reconnects to the exact V6 claim', async ({ page }) => {
  await installWalletMock(page);
  const rpc = await installStudioNetRpcMock(page);

  const response = await page.goto('/market.html?deployment=v7&feed=demo');
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#prediction-button')).toBeEnabled();
  await page.locator('#wallet-button').click();
  await expect(page.locator('#prediction-label')).toHaveText('CLAIM 2 REFUNDS · 2 GEN');
  await expect(page.locator('#prediction-modal')).toBeHidden();
  await page.locator('#prediction-button').click();

  const crossDeploymentClaim = page.locator(
    '#claim-summary-actions a[data-claim-deployment="v6"]'
      + `[data-claim-epoch="${V6_CLAIM_EPOCH}"][data-claim-objective="LOW"]`,
  );
  await expect(crossDeploymentClaim).toBeVisible();
  await expect(crossDeploymentClaim).toContainText('OPEN V6 & RECONNECT TO CLAIM');
  await expect(crossDeploymentClaim).toHaveAccessibleName(/Open V6 and reconnect to claim refund/);
  const v7DocumentId = await page.evaluate(() => window.__e2eDocumentId);

  await Promise.all([
    page.waitForNavigation(),
    crossDeploymentClaim.click(),
  ]);

  await expect(page).toHaveURL(/deployment=v6/);
  await expect(page).toHaveURL(new RegExp(`epoch=${V6_CLAIM_EPOCH}`));
  await expect(page).toHaveURL(/objective=lowest/);
  await expect(page).toHaveURL(/claim=1/);
  await expect(page).toHaveURL(/feed=live/);
  const v6DocumentId = await page.evaluate(() => window.__e2eDocumentId);
  expect(v6DocumentId).not.toBe(v7DocumentId);
  await expect(page.locator('#prediction-modal')).toBeVisible();
  await expect(page.locator('#claim-reconnect')).toBeVisible();
  await expect(page.locator('#position-state')).toContainText('RECONNECT TO CLAIM');

  await page.locator('#claim-reconnect').click();
  await expect(page.locator('#wallet-label')).toContainText('0x6303');
  await expect(page.locator('#claim-reconnect')).toBeHidden();
  await expect(page.locator('#claim-wager')).toBeVisible();
  await expect(page.locator('#claim-wager')).toBeEnabled();
  await expect(page.locator('#claim-wager')).toContainText('CLAIM REFUND');
  expect(await page.evaluate(() => window.__e2eDocumentId)).toBe(v6DocumentId);
  expect(rpc.calls.filter(({ method }) => method === 'get_entry')).toHaveLength(0);
  expect(new Set(rpc.calls.map(({ contract }) => contract))).toEqual(new Set([
    V6_CONTRACT,
    V7_CONTRACT,
  ]));
  expect(rpc.errors).toEqual([]);
});

test('claim verification survives auxiliary read failures and guards every connect control', async ({ page }) => {
  await installWalletMock(page, { accountRequestDelayMs: 200, failBalance: true });
  const rpc = await installStudioNetRpcMock(page, { failMethods: ['get_epoch_asset'] });

  const response = await page.goto(
    `/market.html?deployment=v7&feed=live&epoch=${CLAIM_EPOCH}&objective=highest&claim=1`,
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#claim-reconnect')).toBeVisible();

  await page.locator('#claim-reconnect').click();
  await expect(page.locator('#claim-reconnect')).toBeDisabled();
  await expect(page.locator('#wallet-button')).toBeDisabled();
  await page.evaluate(() => {
    document.querySelector('#wallet-button').click();
    document.querySelector('#claim-reconnect').click();
  });
  await expect(page.locator('#wallet-label')).toContainText('0x6303', { timeout: 20_000 });

  expect(rpc.errors.filter(({ method }) => method !== 'get_epoch_asset')).toEqual([]);
  await expect(page.locator('#modal-status')).toContainText('Claim-critical position data remains verified');
  await expect(page.locator('#claim-wager')).toBeVisible();
  await expect(page.locator('#claim-wager')).toBeEnabled();
  await expect(page.locator('#claim-wager')).toContainText('CLAIM REFUND');
  expect(await page.evaluate(() =>
    window.__e2eWalletRequests.filter((method) => method === 'eth_requestAccounts').length)).toBe(1);
  expect(rpc.calls.filter(({ method }) => method === 'get_entry')).toHaveLength(0);
});

test('changing the selected asset cannot strand an in-flight claim quote in VERIFYING', async ({ page }) => {
  await installWalletMock(page);
  const rpc = await installStudioNetRpcMock(page, {
    delayMethods: { get_claim_quote: 400 },
  });

  const response = await page.goto(
    `/market.html?deployment=v7&feed=live&epoch=${CLAIM_EPOCH}&objective=highest&claim=1`,
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#claim-reconnect')).toBeVisible();
  await page.locator('#claim-reconnect').click();
  await expect.poll(() => rpc.calls.filter(({ method }) => method === 'get_claim_quote').length)
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    const input = document.querySelectorAll('input[name="prediction-asset"]')[1];
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.locator('#wallet-label')).toContainText('0x6303', { timeout: 20_000 });
  await expect(page.locator('#claim-wager')).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('#claim-wager')).toContainText('CLAIM REFUND');
  await expect(page.locator('#position-state')).not.toHaveText('VERIFYING');
});

test('a mismatched claim quote fails closed and exposes the exact retry path', async ({ page }) => {
  await installWalletMock(page);
  await installStudioNetRpcMock(page, {
    claimQuoteAccount: '0x9999999999999999999999999999999999999999',
  });

  const response = await page.goto(
    `/market.html?deployment=v7&feed=live&epoch=${CLAIM_EPOCH}&objective=highest&claim=1`,
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#claim-reconnect')).toBeVisible();
  await page.locator('#claim-reconnect').click();
  await expect(page.locator('#wallet-label')).toContainText('0x6303', { timeout: 20_000 });

  await expect(page.locator('#claim-wager')).toBeVisible();
  await expect(page.locator('#claim-wager')).toBeDisabled();
  await expect(page.locator('#position-refresh')).toBeVisible();
  await expect(page.locator('#modal-status')).toContainText(
    'claim quote could not be verified',
  );
});
