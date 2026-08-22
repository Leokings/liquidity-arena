import assert from 'node:assert/strict';
import test from 'node:test';

import { createReadyHandler, readinessEpochEnds } from './readyz.mjs';
import {
  BINANCE_QUOTES,
  V8_SCHEMA,
  v8Config,
  v8Environment,
  v8Epoch,
  v8Reserve,
} from '../server/v8-test-fixtures.test-helper.mjs';

const NOW = Date.UTC(2026, 7, 22, 12, 5, 0);

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value = '') { this.body = value; },
  };
}

function fetchReady(url, options = {}) {
  if (String(url).includes('rpc-bradbury')) {
    const request = JSON.parse(options.body);
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x107d' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  return Promise.resolve(new Response(JSON.stringify(BINANCE_QUOTES), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

function handler({ schema = V8_SCHEMA, config = v8Config(), reserve = v8Reserve() } = {}) {
  return createReadyHandler({
    environment: v8Environment(),
    now: () => NOW,
    fetchImpl: fetchReady,
    createClientImpl({ chain }) {
      assert.equal(chain.id, 4_221);
      return {
        async getContractSchema() { return schema; },
        async readContract({ functionName, args }) {
          if (functionName === 'get_config') return config;
          if (functionName === 'get_delivery_reserve_state') return reserve;
          if (functionName === 'get_epoch') return v8Epoch(Number(args[0]));
          throw new Error(`unexpected read ${functionName}`);
        },
      };
    },
  });
}

test('Vercel readiness requires Bradbury V8 schema, payout/risk/reserve, epochs, and five feeds', async () => {
  const res = response();
  await handler()({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.checks.genlayerRpc, {
    ready: true, chainId: '0x107d', network: 'testnet-bradbury',
  });
  assert.equal(body.checks.contract.protocolVersion, 'LIQUIDITY_ARENA_V8');
  assert.equal(body.checks.contract.methodCount, 25);
  assert.equal(body.checks.contract.reserve.availableReserveAtto, '3000000000000000000');
  assert.equal(body.checks.static.legacyClaimsEnabled, false);
  assert.deepEqual(body.checks.keeperCoverage.epochEnds, readinessEpochEnds(NOW));
});

test('readiness degrades on schema, risk, factory, or reserve drift', async () => {
  const variants = [
    { schema: { ctor: V8_SCHEMA.ctor, methods: {} } },
    { config: v8Config({ new_risk_enabled: false }) },
    { config: v8Config({ payout_vault_factory: '0x' + 'b'.repeat(40) }) },
    { reserve: v8Reserve({ available_reserve_atto: '1' }) },
  ];
  for (const variant of variants) {
    const res = response();
    await handler(variant)({ method: 'GET' }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body).checks.contract, { ready: false });
  }
});

test('readiness exposes only GET and HEAD', async () => {
  const res = response();
  await handler()({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});
