import assert from 'node:assert/strict';
import test from 'node:test';

import { v8Environment } from '../server/v8-test-fixtures.test-helper.mjs';
import { loadHistoryChainConfiguration } from './config.mjs';
import { deploymentManifest } from './deployment-manifest.mjs';

test('history config exposes exactly one canonical Bradbury V8 deployment', () => {
  const configuration = loadHistoryChainConfiguration(v8Environment());
  assert.equal(configuration.network, 'testnet-bradbury');
  assert.equal(configuration.keeperNetwork, 'bradbury');
  assert.equal(configuration.chainId, 4_221);
  assert.equal(configuration.deployments.length, 1);
  const [v8] = configuration.deployments;
  assert.equal(v8.alias, 'v8');
  assert.equal(v8.deploymentId, `testnet-bradbury:${v8.address.toLowerCase()}`);
  assert.equal(v8.active, true);
  assert.equal(Object.isFrozen(v8), true);
});

test('placeholder manifest cannot claim a deployment proof before the live address is recorded', () => {
  const [v8] = loadHistoryChainConfiguration(v8Environment()).deployments;
  const manifest = deploymentManifest(v8);
  assert.equal(manifest.sourceMetadata.artifactMatched, false);
  assert.equal(manifest.deploymentTransactionHash, null);
  assert.deepEqual(manifest.knownProofs, []);
});
