import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_V8, createDeploymentRegistry } from './deployment-registry.js';

const V8 = `0x${'8'.repeat(40)}`;

function environment(overrides = {}) {
  return {
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v8',
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V8,
    VITE_GENLAYER_CONTRACT: V8,
    VITE_GENLAYER_V8_CONTRACT: V8,
    ...overrides,
  };
}

test('registry exposes exactly one configured V8 deployment', () => {
  const registry = createDeploymentRegistry(environment());
  assert.equal(registry.activeAlias, 'v8');
  assert.equal(registry.all.length, 1);
  assert.equal(registry.active.protocolVersion, PROTOCOL_V8);
  assert.equal(registry.active.address, V8);
  assert.equal(registry.resolveIdentity({ alias: 'v8', address: V8 }), registry.active);
});

test('retired route aliases canonicalize to V8 without creating an old deployment', () => {
  const registry = createDeploymentRegistry(environment());
  assert.equal(registry.selectRoute('v6'), registry.active);
  assert.equal(registry.selectRoute('v7'), registry.active);
  assert.equal(registry.selectRoute('v8'), registry.active);
  assert.equal(registry.selectRoute(''), registry.active);
  assert.throws(() => registry.get('v7'), /not allowlisted/);
  assert.throws(() => registry.selectRoute('v8', { rawAddress: V8 }), /forbidden/);
  assert.throws(() => registry.selectRoute('other'), /not allowlisted/);
});

test('missing V8 address is visible but every money capability fails closed', () => {
  const registry = createDeploymentRegistry({
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7',
    VITE_GENLAYER_CONTRACT: `0x${'7'.repeat(40)}`,
  });
  assert.equal(registry.active.configured, false);
  assert.equal(registry.active.address, '');
  assert.equal(registry.findByAddress(V8), null);
});

test('registry rejects a configured V8 address with partial, mismatched, or non-V8 build identity', () => {
  assert.throws(
    () => createDeploymentRegistry(environment({ VITE_GENLAYER_CONTRACT: '' })),
    /configured together and match/,
  );
  assert.throws(
    () => createDeploymentRegistry(environment({ VITE_GENLAYER_CONTRACT: `0x${'9'.repeat(40)}` })),
    /configured together and match/,
  );
  assert.throws(
    () => createDeploymentRegistry(environment({ VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7' })),
    /must be LIQUIDITY_ARENA_V8/,
  );
  assert.throws(
    () => createDeploymentRegistry(environment({ VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7' })),
    /must be v8/,
  );
});
