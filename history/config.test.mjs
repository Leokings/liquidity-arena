import assert from 'node:assert/strict';
import test from 'node:test';

import { loadHistoryChainConfiguration } from './config.mjs';
import { deploymentManifest } from './deployment-manifest.mjs';

const V6 = '0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1';
const V7 = '0xb2Ae59aE641f571726Ae81E30080f8c2192b15EF';

function environment() {
  return {
    VITE_GENLAYER_NETWORK: 'studionet',
    VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7',
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_CONTRACT: V7,
    VITE_GENLAYER_V6_CONTRACT: V6,
    VITE_GENLAYER_V7_CONTRACT: V7,
    GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
    GENLAYER_V7_OWNER: '0x797d3B25fb2cca0ff93f60df1910267F3822d655',
    GENLAYER_V7_KEEPER: '0x87e94eDab4418e8a9ea37c0fab0675Cf0602a9f2',
    GENLAYER_V7_TREASURY: '0x797d3B25fb2cca0ff93f60df1910267F3822d655',
    GENLAYER_V7_MIN_STAKE_ATTO: '100000000000000000',
    GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO: '10000000000000000000',
  };
}

test('history preserves StudioNet RPC address casing while freezing lowercase persistence identities', () => {
  const configuration = loadHistoryChainConfiguration(environment());
  const v6 = configuration.deployments.find((item) => item.alias === 'v6');
  const v7 = configuration.deployments.find((item) => item.alias === 'v7');

  assert.equal(v6.address, V6);
  assert.equal(v6.addressKey, V6.toLowerCase());
  assert.equal(v6.deploymentId, `studionet:${V6.toLowerCase()}`);
  assert.equal(v7.address, V7);
  assert.equal(v7.addressKey, V7.toLowerCase());
  assert.equal(v7.deploymentId, `studionet:${V7.toLowerCase()}`);
  assert.equal(deploymentManifest(v6).sourceMetadata.artifactMatched, true);
  assert.equal(deploymentManifest(v7).sourceMetadata.artifactMatched, true);
  assert.equal(Object.isFrozen(v6), true);
  assert.equal(Object.isFrozen(v7), true);
});
