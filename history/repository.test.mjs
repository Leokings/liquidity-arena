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

test('Neon driver is imported only on first query and v1 health stays ready without a journal schema', async () => {
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
  const health = await repository.health();
  assert.equal(health.ready, true);
  assert.equal(imports, 1);
  assert.match(connectionString, /^postgresql:/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /arena_schema_migrations/);
  assert.equal(calls[0].params[0].length, 64);
  assert.equal(calls[0].params.length, 3);
  assert.equal(health.schemaVersion, 1);
  assert.deepEqual(health.integrity, {
    checked: false,
    ready: true,
    journalSchemaVersion: null,
    verifiedV7TerminalOperationCount: 0,
    verifiedV7ResolveOperationCount: 0,
    verifiedV7TimeoutOperationCount: 0,
    missingDurableEpochCount: 0,
    staleDurableEpochCount: 0,
    missingDeterminedSnapshotCount: 0,
    countLimit: 10_000,
    countsCapped: false,
  });
});

test('history health verifies every journaled V7 resolve has a terminal durable epoch', async () => {
  const calls = [];
  const resultSets = [[{
    deployments_exists: true,
    epochs_exists: true,
    snapshots_exists: true,
    proofs_exists: true,
    runs_exists: true,
    journal_operations_exists: true,
    migration_valid: true,
    journal_base_migration_valid: true,
    journal_attempt_migration_valid: true,
    journal_attempt_migration_present: true,
  }], [{
    verified_terminal_count: 28,
    verified_resolve_count: 27,
    verified_timeout_count: 1,
    missing_epoch_count: 0,
    stale_epoch_count: 0,
    missing_snapshot_count: 0,
    counts_capped: false,
  }]];
  const repository = createNeonHistoryRepository({
    environment: { DATABASE_URL: 'postgresql://ignored.invalid/database' },
    importDriver: async () => ({
      neon: () => ({
        async query(text, params) {
          calls.push({ text, params });
          return resultSets.shift();
        },
      }),
    }),
  });

  const health = await repository.health();
  assert.equal(health.ready, true);
  assert.equal(health.schemaVersion, 1);
  assert.deepEqual(health.integrity, {
    checked: true,
    ready: true,
    journalSchemaVersion: 3,
    verifiedV7TerminalOperationCount: 28,
    verifiedV7ResolveOperationCount: 27,
    verifiedV7TimeoutOperationCount: 1,
    missingDurableEpochCount: 0,
    staleDurableEpochCount: 0,
    missingDeterminedSnapshotCount: 0,
    countLimit: 10_000,
    countsCapped: false,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].text, /operation\.deployment_alias = 'v7'/);
  assert.match(calls[1].text, /operation\.method IN \('resolve_epoch', 'activate_timeout_refund'\)/);
  assert.match(calls[1].text, /operation\.state = 'VERIFIED'/);
  assert.match(calls[1].text, /LEFT JOIN arena_epochs/);
  assert.match(calls[1].text, /epoch_status = 'RESOLVED'/);
  assert.match(calls[1].text, /epoch_status = 'UNDETERMINED'/);
  assert.match(calls[1].text, /epoch_status = 'TIMED_OUT'/);
  assert.match(calls[1].text, /LEFT JOIN arena_market_snapshots/);
  assert.match(calls[1].text, /snapshot_deployment_id IS NULL/);
  assert.match(calls[1].text, /LEAST\(COUNT\(\*\)/);
  assert.deepEqual(calls[1].params, [10_000]);
});

test('history health degrades on missing or stale verified V7 resolve projections and caps diagnostics', async () => {
  const resultSets = [[{
    deployments_exists: true,
    epochs_exists: true,
    snapshots_exists: true,
    proofs_exists: true,
    runs_exists: true,
    journal_operations_exists: true,
    migration_valid: true,
    journal_base_migration_valid: true,
    journal_attempt_migration_valid: true,
    journal_attempt_migration_present: true,
  }], [{
    verified_terminal_count: 10_000,
    verified_resolve_count: 10_000,
    verified_timeout_count: 3,
    missing_epoch_count: 1,
    stale_epoch_count: 2,
    missing_snapshot_count: 4,
    counts_capped: true,
  }]];
  const repository = createNeonHistoryRepository({
    environment: { DATABASE_URL: 'postgresql://ignored.invalid/database' },
    importDriver: async () => ({
      neon: () => ({ async query() { return resultSets.shift(); } }),
    }),
  });

  const health = await repository.health();
  assert.equal(health.ready, false);
  assert.equal(health.schemaVersion, 1);
  assert.deepEqual(health.integrity, {
    checked: true,
    ready: false,
    journalSchemaVersion: 3,
    verifiedV7TerminalOperationCount: 10_000,
    verifiedV7ResolveOperationCount: 10_000,
    verifiedV7TimeoutOperationCount: 3,
    missingDurableEpochCount: 1,
    staleDurableEpochCount: 2,
    missingDeterminedSnapshotCount: 4,
    countLimit: 10_000,
    countsCapped: true,
  });
});

test('history health fails closed when a present v3 journal migration has the wrong checksum', async () => {
  let calls = 0;
  const repository = createNeonHistoryRepository({
    environment: { DATABASE_URL: 'postgresql://ignored.invalid/database' },
    importDriver: async () => ({
      neon: () => ({
        async query() {
          calls += 1;
          return [{
            deployments_exists: true,
            epochs_exists: true,
            snapshots_exists: true,
            proofs_exists: true,
            runs_exists: true,
            journal_operations_exists: true,
            migration_valid: true,
            journal_base_migration_valid: true,
            journal_attempt_migration_valid: false,
            journal_attempt_migration_present: true,
          }];
        },
      }),
    }),
  });

  const health = await repository.health();
  assert.equal(calls, 1);
  assert.equal(health.ready, false);
  assert.equal(health.integrity.checked, false);
  assert.equal(health.integrity.ready, false);
  assert.equal(health.integrity.journalSchemaVersion, 3);
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

test('public proof query keysets by hash and exposes the live fee parent without claiming treasury credit', async () => {
  const calls = [];
  const feeParent = '0x3df8d942bd9c5d699ee0d7816761ec5fd6264108d3a3e8bf3486c2c4f4fbb01f';
  const treasuryChild = '0x566082ceef10482356f7aeac310098b7ece8f9c0a7e054eb1db718623602470e';
  const cursorHash = `0x${'f'.repeat(64)}`;
  const deployment = testDeployment();
  const repository = createNeonHistoryRepository({
    environment: { DATABASE_URL: 'postgresql://ignored.invalid/database' },
    importDriver: async () => ({
      neon: () => ({
        async query(text, params) {
          calls.push({ text, params });
          return [{
            transaction_hash: feeParent,
            deployment_id: deployment.deploymentId,
            deployment_alias: 'v7',
            epoch_end_timestamp: null,
            proof_kind: 'FEE_WITHDRAWAL',
            method: 'withdraw_accrued_fees',
            status: 'FINALIZED',
            value_atto: '0',
            value_credited: null,
            parent_transaction_hash: null,
            child_transaction_hashes: [],
            verified_at: '2026-08-19T22:42:37.000Z',
          }];
        },
      }),
    }),
  });

  const proofs = await repository.listProofs({
    deployment: 'v7',
    cursor: { transactionHash: cursorHash },
    limit: 1,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /WHERE deployment_alias = \$1::text/);
  assert.match(calls[0].text, /transaction_hash < \$2::text/);
  assert.match(calls[0].text, /ORDER BY transaction_hash DESC/);
  assert.doesNotMatch(calls[0].text, /\barguments\b|sender_address|recipient_address|proof_metadata|execution_result/);
  assert.deepEqual(calls[0].params, ['v7', cursorHash, 2]);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].transactionHash, feeParent);
  assert.equal(proofs[0].epochEndTimestamp, null);
  assert.equal(proofs[0].kind, 'FEE_WITHDRAWAL');
  assert.equal(proofs[0].status, 'FINALIZED');
  assert.equal(proofs[0].valueAtto, '0');
  assert.equal(proofs[0].valueCredited, null);
  assert.deepEqual(proofs[0].childTransactionHashes, []);
  assert.equal(proofs[0].childTransactionHashes.includes(treasuryChild), false);
  assert.equal(Object.hasOwn(proofs[0], 'proofMetadata'), false);
  assert.equal(Object.hasOwn(proofs[0], 'senderAddress'), false);
  assert.equal(Object.hasOwn(proofs[0], 'recipientAddress'), false);
});
