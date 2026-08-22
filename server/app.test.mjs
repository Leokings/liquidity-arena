import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { contentSecurityPolicy, loadServerConfig, startProductionServer } from './app.mjs';
import {
  BINANCE_QUOTES,
  V8_SCHEMA,
  v8Config,
  v8Environment,
  v8Epoch,
  v8Reserve,
} from './v8-test-fixtures.test-helper.mjs';

class FakeStreamHub {
  constructor() {
    this.configured = true;
    this.running = false;
    this.clientCount = 0;
  }

  start() { this.running = true; }
  subscribe() { this.clientCount += 1; return () => { this.clientCount -= 1; }; }
  destroy() { this.running = false; }
}

test('production server selects Bradbury and serves only when exact V8 readiness is satisfied', async () => {
  const distDir = await mkdtemp(join(tmpdir(), 'liquidity-arena-v8-server-'));
  await writeFile(join(distDir, 'market.html'), '<!doctype html><title>V8</title>', 'utf8');
  const config = loadServerConfig({ ...v8Environment(), DIST_DIR: distDir, HOST: '127.0.0.1' });
  assert.equal(config.genLayerNetwork, 'testnet-bradbury');
  assert.equal(config.genLayerChainId, '0x107d');
  const now = Date.now();
  const operational = Math.floor(Math.floor(now / 1_000) / 3_600) * 3_600 + 3_600;
  const runtime = await startProductionServer({
    config,
    host: '127.0.0.1',
    port: 0,
    streamHub: new FakeStreamHub(),
    schemaReader: async () => V8_SCHEMA,
    contractReader: async ({ functionName, args }) => {
      if (functionName === 'get_config') return v8Config();
      if (functionName === 'get_delivery_reserve_state') return v8Reserve();
      if (functionName === 'get_epoch') return v8Epoch(Number(args[0]));
      throw new Error(`unexpected read ${functionName}`);
    },
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('rpc-bradbury')) {
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x107d' }), { status: 200 });
      }
      if (String(url).includes('/ticker/price')) return new Response(JSON.stringify(BINANCE_QUOTES), { status: 200 });
      return new Response('[]', { status: 200 });
    },
    logger: { error() {} },
  });
  try {
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const ready = await fetch(`${origin}/readyz`);
    assert.equal(ready.status, 200);
    const body = await ready.json();
    assert.equal(body.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V8');
    assert.deepEqual(body.checks.keeperCoverage.epochEnds, [operational, operational + 3_600]);
    const live = await fetch(`${origin}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual((await live.json()).static, {
      ready: true,
      network: 'testnet-bradbury',
      chainId: 4_221,
      deployment: 'v8',
    });
    const market = await fetch(`${origin}/market.html`);
    assert.equal(market.status, 200);
    assert.equal(
      market.headers.get('content-security-policy'),
      contentSecurityPolicy('https://rpc-bradbury.genlayer.com'),
    );
  } finally {
    await runtime.close({ graceMs: 100 });
    await rm(distDir, { recursive: true, force: true });
  }
});

test('production configuration rejects StudioNet and V7 selectors', () => {
  assert.throws(
    () => loadServerConfig(v8Environment({ VITE_GENLAYER_NETWORK: 'studionet' })),
    /testnet-bradbury/,
  );
  assert.throws(
    () => loadServerConfig(v8Environment({ VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7' })),
    /LIQUIDITY_ARENA_V8/,
  );
});
