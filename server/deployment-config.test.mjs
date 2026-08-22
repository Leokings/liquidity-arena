import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDITED_PAYOUT_FACTORY_4221,
  assertLiquidityArenaDeploymentConfig,
  loadLiquidityArenaDeploymentConfig,
} from './deployment-config.mjs';
import { v8Environment } from './v8-test-fixtures.test-helper.mjs';

test('V8-only config binds Bradbury, one contract, fixed roles, stakes, factory, and reserve', () => {
  const config = loadLiquidityArenaDeploymentConfig(v8Environment());
  assert.equal(config.genLayerNetwork, 'testnet-bradbury');
  assert.equal(config.genLayerChainId, '0x107d');
  assert.equal(config.genLayerChainIdNumber, 4_221);
  assert.equal(config.activeDeployment, 'v8');
  assert.equal(config.expectedContractProtocol, 'LIQUIDITY_ARENA_V8');
  assert.equal(config.v8Expectations.payoutFactory.toLowerCase(), AUDITED_PAYOUT_FACTORY_4221);
  assert.equal(assertLiquidityArenaDeploymentConfig(config), config);
  assert.equal(Object.hasOwn(config, 'legacyV6Contracts'), false);
  assert.equal(Object.hasOwn(config, 'v7ContractAddress'), false);
});

test('V6/V7 selectors and stale legacy variables fail closed', () => {
  assert.throws(
    () => loadLiquidityArenaDeploymentConfig(v8Environment({ VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7' })),
    /LIQUIDITY_ARENA_V8/,
  );
  assert.throws(
    () => loadLiquidityArenaDeploymentConfig(v8Environment({ VITE_GENLAYER_V7_CONTRACT: '0x' + '1'.repeat(40) })),
    /Legacy V6\/V7 deployment variables are forbidden/,
  );
  assert.throws(
    () => loadLiquidityArenaDeploymentConfig(v8Environment({ VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7' })),
    /must be v8/,
  );
});

test('V8 config rejects contract, factory, stake, reserve, and RPC drift', () => {
  for (const [override, pattern] of [
    [{ VITE_GENLAYER_V8_CONTRACT: '0x' + 'b'.repeat(40) }, /must match/],
    [{ GENLAYER_V8_PAYOUT_FACTORY: '0x' + 'b'.repeat(40) }, /audited Bradbury factory/],
    [{ GENLAYER_V8_MIN_STAKE_ATTO: '0' }, /must be positive/],
    [{ GENLAYER_V8_MIN_AVAILABLE_RESERVE_ATTO: '' }, /is required/],
    [{ GENLAYER_RPC_URL: 'http://rpc.example' }, /absolute HTTPS/],
  ]) {
    assert.throws(() => loadLiquidityArenaDeploymentConfig(v8Environment(override)), pattern);
  }
});
