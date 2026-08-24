import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, htmlSource, stylesSource] = await Promise.all([
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('../market.html', import.meta.url), 'utf8'),
  readFile(new URL('./styles.css', import.meta.url), 'utf8'),
]);

test('live mode hides replay controls while demo mode retains the real timeline', () => {
  assert.match(htmlSource, /class="event-dock" id="event-dock" data-mode="live" aria-label="Market event status"/);
  assert.match(appSource, /openWindow\(windowName\)\s*\{[\s\S]*?\$\('#event-dock'\)\.dataset\.mode = this\.feedMode;/);
  assert.match(stylesSource, /\.event-dock\[data-mode="live"\] \.playback-controls\s*\{ display: none; \}/);
  assert.match(appSource, /\$\('#timeline-slider'\)\.disabled = false;/);
  assert.match(appSource, /_openLive\(windowName\)[\s\S]*?\$\('#timeline-slider'\)\.disabled = true;/);
});

test('event status remains visible and the bottom chrome stays compact on every layout', () => {
  assert.match(stylesSource, /grid-template-rows: 64px 54px minmax\(0, 1fr\) 44px 24px;/);
  assert.match(stylesSource, /grid-template-rows: 60px 48px minmax\(0, 1fr\) 44px 24px;/);
  assert.match(stylesSource, /grid-template-rows: 58px 46px minmax\(0, 1fr\) 44px 24px;/);
  assert.match(stylesSource, /\.event-dock\[data-mode="live"\] \.event-summary\s*\{ display: flex; \}/);
  assert.match(htmlSource, /id="event-title">LIQUIDITY SHIFT DETECTED<\/strong>/);
  assert.match(htmlSource, /MARKET VISUALIZATION · NOT FINANCIAL ADVICE/);
  assert.match(htmlSource, /id="network-explorer"[^>]*>BRADBURY EXPLORER<\/a>/);
});
