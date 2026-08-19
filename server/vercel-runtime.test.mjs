import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeFunctionPath,
  requireSameOrigin,
  vercelClientKey,
} from './vercel-runtime.mjs';

function responseDouble() {
  return {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
    end(body = '') { this.body = String(body); this.writableEnded = true; },
  };
}

test('Vercel client quota key uses the first platform forwarding address', () => {
  assert.equal(vercelClientKey({
    headers: {
      'x-vercel-forwarded-for': '203.0.113.4, 10.0.0.1',
      'x-forwarded-for': '198.51.100.5',
    },
  }), '203.0.113.4');
});
test('Vercel origin guard accepts only the deployed host and optional MetaMask', () => {
  const sameOrigin = responseDouble();
  assert.equal(requireSameOrigin({
    headers: { host: 'arena.example', origin: 'https://arena.example' },
  }, sameOrigin), true);

  const foreign = responseDouble();
  assert.equal(requireSameOrigin({
    headers: { host: 'arena.example', origin: 'https://evil.example' },
  }, foreign), false);
  assert.equal(foreign.statusCode, 403);

  const wallet = responseDouble();
  assert.equal(requireSameOrigin({
    headers: { host: 'arena.example', origin: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn' },
  }, wallet, { allowMetaMask: true }), true);
});

test('Vercel function path normalization preserves the query string', () => {
  const request = { url: '/api/binance/klines?symbol=BTCUSDT&interval=1h' };
  normalizeFunctionPath(request, '/api/binance/klines');
  assert.equal(request.url, '/api/binance/klines?symbol=BTCUSDT&interval=1h');
});
