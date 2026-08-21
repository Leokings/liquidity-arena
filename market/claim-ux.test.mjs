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
  assert.match(htmlSource, /class="claim-reconnect" id="claim-reconnect" type="button" hidden/);
  assert.match(htmlSource, /class="claim-wager" id="claim-wager" type="button"/);
  assert.match(htmlSource, /class="position-refresh" id="position-refresh" type="button" hidden/);
  assert.match(appSource, /if \(this\.pendingClaimIntent\) \$\('#prediction-modal'\)\.hidden = false/);
  assert.match(appSource, /RECONNECT WALLET TO CLAIM \$\{this\.pendingClaimIntent\.objective\} POSITION/);
  assert.match(appSource, /section\?\.scrollIntoView/);
  assert.match(appSource, /focusTarget\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(appSource, /positionRefresh\.hidden = !this\.gateway\.connected \|\| !this\.positionReadError/);
});

test('claim summary and partial-history recovery have explicit accessible semantics', () => {
  assert.match(htmlSource, /id="claim-summary" aria-labelledby="claim-summary-title" hidden/);
  assert.match(htmlSource, /id="claim-summary-actions" role="list"/);
  assert.match(htmlSource, /id="wallet-history-errors" role="region" aria-live="polite" aria-label="Wallet position history status" hidden/);
  assert.match(appSource, /row\.setAttribute\('role', 'listitem'\)/);
  assert.match(appSource, /action\.setAttribute\(\s*'aria-label'/);
  assert.match(appSource, /retry\.dataset\.retryDeployment = deploymentAlias/);
  assert.match(appSource, /Last verified rows remain visible/);
});

test('claim and retry controls retain touch-sized targets on mobile', () => {
  assert.match(stylesSource, /\.claim-wager,\s*\.claim-reconnect,\s*\.position-refresh \{[\s\S]*?min-height: 44px/);
  assert.match(stylesSource, /\.claim-summary-action \{[\s\S]*?min-height: 44px/);
  const mobile = stylesSource.slice(stylesSource.indexOf('@media (max-width: 760px)'));
  assert.match(mobile, /\.claim-summary-action \{ min-height: 48px; font-size: 11px; \}/);
  assert.match(mobile, /\.wallet-history-errors button \{ min-height: 44px; \}/);
});

test('claim activity promotes finalized claimed value while retaining quote intent metadata', () => {
  const reconciliation = appSource.slice(
    appSource.indexOf('  async _reconcileActivity() {'),
    appSource.indexOf('  _renderActivity(claim = null) {'),
  );
  const claimFlow = appSource.slice(
    appSource.indexOf('  async claimWager() {'),
    appSource.indexOf('  async unlockEmergencyRefund() {'),
  );
  assert.match(reconciliation, /minimumValueAtto: claimedAtto/);
  assert.match(reconciliation, /claimedAtto >= signingQuoteAtto/);
  assert.match(reconciliation, /amountAtto: claimedAtto\.toString\(\)/);
  assert.equal(
    reconciliation.match(/quotedAmountAtto: signingQuoteAtto\?\.toString\(\) \?\? null/g)?.length,
    3,
    'every claim recovery outcome must migrate and retain the original signing quote',
  );
  assert.match(claimFlow, /quotedAmountAtto: submission\.quotedAmountAtto/);
  assert.match(claimFlow, /amountAtto: submission\.actualAmountAtto \|\| activity\.amountAtto/);
  assert.match(claimFlow, /amountAtto: result\.actualAmountAtto/);
  assert.match(claimFlow, /amountAtto: error\?\.actualAmountAtto \|\| activity\.amountAtto/);
});
