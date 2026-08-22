import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, htmlSource, stylesSource] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('../market.html', import.meta.url), 'utf8'),
  readFile(new URL('./styles.css', import.meta.url), 'utf8'),
]);

test('same-deployment claim navigation is an in-app replace, not a wallet-breaking reload', () => {
  const handler = appSource.slice(
    appSource.indexOf('  _handleClaimNavigation(event) {'),
    appSource.indexOf('  async _resumeClaimIntent() {'),
  );
  assert.match(handler, /intent\.deploymentAlias !== this\.deployment\.alias/);
  assert.match(handler, /event\.preventDefault\(\)/);
  assert.match(handler, /history\.replaceState\(null, '', url\)/);
  assert.doesNotMatch(handler, /history\.pushState/);
  assert.match(handler, /this\.explicitEpochEndTimestamp = normalizedIntent\.epochEndTimestamp/);
  assert.match(handler, /this\.objectiveSelector = normalizedIntent\.objective/);
  assert.match(handler, /this\._focusClaimSection\(\)/);
});

test('reload claim intent exposes an accessible reconnect and claim focus target', () => {
  assert.match(htmlSource, /id="wallet-position"[^>]*tabindex="-1"/);
  assert.match(htmlSource, /class="prediction-modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*tabindex="-1"/);
  assert.match(htmlSource, /class="claim-reconnect" id="claim-reconnect" type="button" hidden/);
  assert.match(htmlSource, /class="claim-wager" id="claim-wager" type="button"/);
  assert.match(htmlSource, /class="position-refresh" id="position-refresh" type="button" hidden/);
  assert.match(appSource, /if \(this\.pendingClaimIntent\) \{\s*this\._showModal\('prediction-modal', \{ initialFocus: '#claim-reconnect' \}\)/);
  assert.match(appSource, /RECONNECT WALLET TO CLAIM \$\{this\.pendingClaimIntent\.objective\} POSITION/);
  assert.match(appSource, /section\?\.scrollIntoView/);
  assert.match(appSource, /focusTarget\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(appSource, /positionRefresh\.hidden = !this\.gateway\.connected \|\| !this\.positionReadError/);
});

test('claim modal traps keyboard focus and isolates every background sibling', () => {
  const modalSupport = appSource.slice(
    appSource.indexOf('  _modalRecord(modalId) {'),
    appSource.indexOf('  _updateClock() {'),
  );
  assert.match(modalSupport, /this\.modalStack\.at\(-1\)/);
  assert.match(modalSupport, /element\.toggleAttribute\('inert', inert\)/);
  assert.match(modalSupport, /original\.element\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(modalSupport, /record\.dialog\.querySelectorAll\(MODAL_FOCUSABLE_SELECTOR\)/);
  assert.match(modalSupport, /if \(event\.key !== 'Tab'\) return/);
  assert.match(modalSupport, /event\.shiftKey \? -1 : 1/);
  assert.match(modalSupport, /record\.dialog\.contains\(event\.target\)/);
  assert.match(modalSupport, /event\.stopImmediatePropagation\(\)/);
  assert.match(appSource, /document\.addEventListener\('keydown',[\s\S]*?, true\)/);
  assert.match(appSource, /document\.addEventListener\('focusin',[\s\S]*?, true\)/);
  assert.match(appSource, /document\.addEventListener\('click',[\s\S]*?, true\)/);
});

test('modal close and async claim focus are generation-safe and restore the exact opener', () => {
  const modalSupport = appSource.slice(
    appSource.indexOf('  _showModal(modalId,'),
    appSource.indexOf('  _updateClock() {'),
  );
  const predictionLifecycle = appSource.slice(
    appSource.indexOf('  async openPrediction(opener = null) {'),
    appSource.indexOf('  _updateSubmitButton() {'),
  );
  assert.match(modalSupport, /record\.opener = candidate instanceof HTMLElement/);
  assert.match(modalSupport, /record\.generation \+= 1/);
  assert.match(modalSupport, /originalLayerState[\s\S]*?this\._setElementInert\(record\.layer, originalLayerState\.inert\)/);
  assert.match(modalSupport, /record\.generation !== closeGeneration \|\| !record\.layer\.hidden/);
  assert.match(modalSupport, /underlying\.dialog\.contains\(opener\)/);
  assert.match(predictionLifecycle, /opener,\s*initialFocus: '\.prediction-modal \.modal-close'/);
  assert.match(predictionLifecycle, /record\.generation !== modalGeneration \|\| record\.layer\.hidden/);
  assert.doesNotMatch(
    predictionLifecycle.slice(predictionLifecycle.indexOf('await this._loadRound();')),
    /this\._focusModal/,
  );
  assert.match(predictionLifecycle, /if \(this\._hideModal\('prediction-modal'\)\) this\._clearClaimIntentRoute\(\)/);
  assert.match(appSource, /const modalGeneration = record\.generation;[\s\S]*?record\.generation !== modalGeneration/);
});

test('V8 payout summary and epoch-scan recovery have explicit accessible semantics', () => {
  assert.match(htmlSource, /id="claim-summary" aria-labelledby="claim-summary-title" hidden/);
  assert.match(htmlSource, /id="claim-summary-actions" role="list"/);
  assert.match(htmlSource, /id="wallet-history-errors" role="region" aria-live="polite" aria-label="Wallet position history status" hidden/);
  assert.match(appSource, /row\.setAttribute\('role', 'listitem'\)/);
  assert.match(appSource, /action\.setAttribute\(\s*'aria-label'/);
  assert.match(appSource, /retry\.dataset\.retryDeployment = deploymentAlias/);
  assert.match(appSource, /Previously verified rows remain visible only for recovery navigation/);
  assert.match(appSource, /readWalletPositionPage\(\{/);
  assert.match(appSource, /pageSize: 25/);
  assert.match(appSource, /this\.onchainEpochsScanned = page\.scannedEpochs/);
  assert.match(appSource, /SCAN \$\{nextCount\} OLDER V8 EPOCH/);
});

test('claim and retry controls retain touch-sized targets on mobile', () => {
  assert.match(stylesSource, /\.claim-wager,\s*\.claim-reconnect,\s*\.position-refresh \{[\s\S]*?min-height: 44px/);
  assert.match(stylesSource, /\.claim-summary-action \{[\s\S]*?min-height: 44px/);
  const mobile = stylesSource.slice(stylesSource.indexOf('@media (max-width: 760px)'));
  assert.match(mobile, /\.claim-summary-action \{ min-height: 48px; font-size: 11px; \}/);
  assert.match(mobile, /\.wallet-history-errors button \{ min-height: 44px; \}/);
});

test('claim recovery persists the immutable payout and every stage has an explicit client action', () => {
  const reconciliation = appSource.slice(
    appSource.indexOf('  async _reconcileActivity() {'),
    appSource.indexOf('  _renderActivity(claim = null) {'),
  );
  const claimFlow = appSource.slice(
    appSource.indexOf('  async advancePayout({ retry = false } = {}) {'),
    appSource.indexOf('  async unlockEmergencyRefund() {'),
  );
  assert.match(reconciliation, /const payout = normalizeV8Payout\(await this\.gateway\.readPayout\(quote\.payoutId\)/);
  assert.match(reconciliation, /verified = payout\.amountAtto === quote\.amountAtto/);
  assert.match(reconciliation, /this\._persistPayout\(payout\)/);
  assert.match(reconciliation, /payoutId: payout\.payoutId/);
  assert.match(claimFlow, /this\.gateway\.claimEpoch/);
  assert.match(claimFlow, /this\.gateway\.retryPreparePayout/);
  assert.match(claimFlow, /this\.gateway\.dispatchPayout/);
  assert.match(claimFlow, /this\.gateway\.retryPayout/);
  assert.match(claimFlow, /this\.gateway\.confirmPayout/);
  assert.match(claimFlow, /this\.gateway\.withdrawPayoutVault/);
  assert.match(claimFlow, /this\.gateway\.inspectPayoutVaultWithdrawal/);
  assert.match(claimFlow, /this\._persistPayout\(this\.payout, \{\}, \{ required: true \}\)/);
  assert.match(claimFlow, /this\.payoutStore\.prepareWithdrawal/);
  assert.match(claimFlow, /this\.payoutStore\.recordWithdrawalAttempt/);
  assert.match(claimFlow, /Do not submit another withdrawal until this exact hash is reconciled/);
  assert.match(claimFlow, /\['FAILED', 'DROPPED'\]\.includes\(attemptStatus\)/);
  assert.match(claimFlow, /submittedHash = null;[\s\S]*?action = 'REFRESH_WITHDRAWAL'/);
  assert.match(claimFlow, /this\.gateway\.refreshPayoutWithdrawal/);
  assert.doesNotMatch(claimFlow, /child transfer|childHash|verifyClaimDelivery/i);
});

test('payout stages and the recipient vault are visible without implying escrow is delivered', () => {
  assert.match(htmlSource, /id="position-payout-stage"/);
  assert.match(htmlSource, /id="position-payout-vault"/);
  assert.match(htmlSource, /id="payout-secondary"/);
  assert.match(appSource, /VAULT PREPARING/);
  assert.match(appSource, /ESCROW DISPATCHED/);
  assert.match(appSource, /RECIPIENT WITHDRAWAL READY/);
  assert.match(appSource, /WITHDRAWN TO RECIPIENT/);
  assert.match(stylesSource, /\[data-payout-state="FUNDED_IN_ESCROW"\]/);
  assert.match(stylesSource, /\[data-payout-state="EOA_WITHDRAWN"\]/);
});
