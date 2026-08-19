import assert from 'node:assert/strict';
import test from 'node:test';

import { createNeonHistoryRepository } from './repository.mjs';
import { normalizeDeploymentState, normalizeEpochState } from './schema.mjs';
import {
  testAssetCatalog,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testVenueCatalog,
} from './test-fixtures.mjs';

test('Neon history repository remains lazy and build-safe without DATABASE_URL', async () => {
  let imports = 0;
  const repository = createNeonHistoryRepository({
    environment: {},
    importDriver: async () => {
      imports += 1;
      throw new Error('must not import');
    },
  });
  assert.equal(repository.configured, false);
  assert.deepEqual(await repository.health(), { configured: false, ready: false, schemaVersion: null });
  assert.equal(imports, 0);
  await assert.rejects(() => repository.listDeployments({ cursor: null, limit: 10 }), /not configured/);
  assert.equal(imports, 0);
});

test('Neon driver is imported only on first query and schema health validates the exact migration', async () => {
  let imports = 0;
  let connectionString;
  const calls = [];
  const repository = createNeonHistoryRepository({
    environment: { DATABASE_URL: 'postgresql://secret.example.invalid/database' },
    importDriver: async () => {
      imports += 1;
      return {
        neon(value) {
          connectionString = value;
          return {
            async query(text, params) {
              calls.push({ text, params });
              return [{
                deployments_exists: true,
                epochs_exists: true,
                snapshots_exists: true,
                proofs_exists: true,
                runs_exists: true,
                migration_valid: true,
              }];
            },
          };
        },
      };
    },
  });
  assert.equal(imports, 0);
  assert.equal((await repository.health()).ready, true);
  assert.equal(imports, 1);
  assert.match(connectionString, /^postgresql:/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /arena_schema_migrations/);
  assert.equal(calls[0].params[0].length, 64);
});

test('deployment and determined epoch writes are parameterized and snapshot is atomic with epoch upsert', async () => {
  const calls = [];
  const repository = createNeonHistoryRepository({
    environment: { DATABASE_URL: 'postgresql://ignored.invalid/database' },
    importDriver: async () => ({
      neon: () => ({
        async query(text, params) {
          calls.push({ text, params });
          return [{ deployment_id: params[0] }];
        },
      }),
    }),
  });
  const deployment = testDeployment();
  const canonicalDeployment = normalizeDeploymentState({
    deployment,
    config: testConfig(),
    assetCatalog: testAssetCatalog(),
    venueCatalog: testVenueCatalog(),
    epochCount: 1,
    manifest: { deploymentTransactionHash: null, sourceMetadata: {} },
  });
  await repository.upsertDeployment(canonicalDeployment);
  const epoch = normalizeEpochState({
    deployment,
    epoch: testDeterminedEpoch(),
    assets: testAssets(),
    syncedAt: '2026-08-19T18:00:00.000Z',
  });
  await repository.upsertEpoch(epoch);
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /ON CONFLICT \(deployment_id\)/);
  assert.equal(calls[0].params[0], deployment.deploymentId);
  assert.equal(calls[0].params[4], deployment.addressKey);
  assert.notEqual(calls[0].params[4], deployment.address);
  assert.match(calls[1].text, /WITH epoch_upsert AS/);
  assert.match(calls[1].text, /snapshot_upsert/);
  assert.doesNotMatch(calls[1].text, /198000000000000000/);
  assert.equal(calls[1].params[0], deployment.deploymentId);
  assert.equal(calls[1].params[3], deployment.addressKey);
  assert.equal(JSON.parse(calls[1].params[28]).length, 5);
});
