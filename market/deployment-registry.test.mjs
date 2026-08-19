import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_V6,
  PROTOCOL_V7,
  createDeploymentRegistry,
} from './deployment-registry.js';

const V6 = `0x${'6'.repeat(40)}`;
const V7 = `0x${'7'.repeat(40)}`;

test('existing V6 build variables remain a wager-compatible fallback', () => {
  const registry = createDeploymentRegistry({
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V6,
    VITE_GENLAYER_CONTRACT: V6,
  });
  assert.equal(registry.activeAlias, 'v6');
  assert.equal(registry.compatibilityMode, true);
  assert.equal(registry.get('v6').newWagersEnabled, true);
  assert.equal(registry.get('v6').legacy, false);
});

test('migration registry requires explicit V7 activation and retains V6 as claim-only legacy', () => {
  const registry = createDeploymentRegistry({
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V7,
    VITE_GENLAYER_CONTRACT: V7,
    VITE_GENLAYER_V7_CONTRACT: V7,
    VITE_GENLAYER_V6_CONTRACT: V6,
  });
  assert.equal(registry.active.alias, 'v7');
  assert.equal(registry.get('v7').newWagersEnabled, true);
  assert.equal(registry.get('v6').newWagersEnabled, false);
  assert.equal(registry.get('v6').claimsEnabled, true);
  assert.equal(registry.findByAddress(V6.toUpperCase()).alias, 'v6');
});

test('V6 stays claim-only even when selected as the active compatibility view beside V7', () => {
  const registry = createDeploymentRegistry({
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v6',
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V6,
    VITE_GENLAYER_CONTRACT: V6,
    VITE_GENLAYER_V7_CONTRACT: V7,
    VITE_GENLAYER_V6_CONTRACT: V6,
  });
  assert.equal(registry.active.alias, 'v6');
  assert.equal(registry.get('v6').newWagersEnabled, false);
  assert.equal(registry.get('v7').newWagersEnabled, false);
  assert.equal(registry.selectRoute('v7').newWagersEnabled, false);
});

test('registry fails closed on partial, conflicting, duplicate, or arbitrary deployment input', () => {
  assert.throws(() => createDeploymentRegistry({
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V7,
    VITE_GENLAYER_CONTRACT: V7,
    VITE_GENLAYER_V7_CONTRACT: V7,
    VITE_GENLAYER_V6_CONTRACT: V6,
  }), /ACTIVE_DEPLOYMENT is required/);
  assert.throws(() => createDeploymentRegistry({
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V7,
    VITE_GENLAYER_CONTRACT: V7,
    VITE_GENLAYER_V7_CONTRACT: V7,
  }), /V6 compatibility or legacy/);
  assert.throws(() => createDeploymentRegistry({
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'other',
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V6,
    VITE_GENLAYER_CONTRACT: V6,
    VITE_GENLAYER_V6_CONTRACT: V6,
  }), /must be v6 or v7/);
  assert.throws(() => createDeploymentRegistry({
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V7,
    VITE_GENLAYER_CONTRACT: V7,
    VITE_GENLAYER_V7_CONTRACT: V7,
    VITE_GENLAYER_V6_CONTRACT: V7,
  }), /different contract addresses/);

  const registry = createDeploymentRegistry({
    VITE_GENLAYER_PROTOCOL: PROTOCOL_V6,
    VITE_GENLAYER_CONTRACT: V6,
  });
  assert.throws(() => registry.selectRoute('0x1234'), /not allowlisted/);
  assert.throws(() => registry.selectRoute('v6', { rawAddress: V7 }), /forbidden/);
  assert.equal(registry.resolveIdentity({ address: V6 }).alias, 'v6');
  assert.throws(
    () => registry.resolveIdentity({ alias: 'v6', address: V7 }),
    /do not identify one allowlisted deployment/,
  );
});
