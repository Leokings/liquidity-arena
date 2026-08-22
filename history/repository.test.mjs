import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRADBURY_V8_SCHEMA_CHECKSUM,
  createNeonHistoryRepository,
} from './repository.mjs';
import {
  normalizeDeploymentState,
  normalizeEpochState,
  normalizePayoutState,
} from './schema.mjs';
import {
  TEST_EPOCH,
  TEST_PAYOUT_ID,
  testAssets,
  testConfig,
  testDeployment,
  testDeterminedEpoch,
  testPayout,
  testSchema,
} from './test-fixtures.mjs';
import { v8Environment } from '../server/v8-test-fixtures.test-helper.mjs';

function repositoryWithResults(resultSets, calls = []) {
  const deployment = testDeployment();
  const repository = createNeonHistoryRepository({
    environment: {
      ...v8Environment({
        VITE_GENLAYER_CONTRACT: deployment.address,
        VITE_GENLAYER_V8_CONTRACT: deployment.address,
      }),
      DATABASE_URL: 'postgresql://ignored.invalid/database',
    },
    importDriver: async () => ({
      neon: () => ({
        async query(text, params) {
          calls.push({ text, params });
          return resultSets.shift() || [];
        },
      }),
    }),
  });
  return { repository, calls };
}

function healthySchema(overrides = {}) {
  return {
    deployments_exists: true,
    epochs_exists: true,
    snapshots_exists: true,
    proofs_exists: true,
    payouts_exists: true,
    payout_proofs_exists: true,
    payout_cursors_exists: true,
    runs_exists: true,
    journal_operations_exists: true,
    migration_valid: true,
    journal_base_migration_valid: true,
    journal_attempt_migration_valid: true,
    bradbury_v8_migration_valid: true,
    keeper_revalidation_migration_valid: true,
    no_future_migrations: true,
    active_deployment_count: 1,
    active_v8_count: 1,
    active_legacy_count: 0,
    ...overrides,
  };
}

function healthyProjection(overrides = {}) {
  return {
    verified_terminal_count: 3,
    verified_resolve_count: 2,
    verified_timeout_count: 1,
    verified_payout_count: 5,
    missing_epoch_count: 0,
    stale_epoch_count: 0,
    missing_snapshot_count: 0,
    missing_payout_count: 0,
    stale_payout_count: 0,
    missing_payout_stage_proof_count: 0,
    counts_capped: false,
    ...overrides,
  };
}

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
  await assert.rejects(() => repository.listDeployments({ cursor: null, limit: 10 }), /not configured/);
  assert.equal(imports, 0);
});

test('history health requires schema v5, one active Bradbury V8, and complete epoch and payout projections', async () => {
  const { repository, calls } = repositoryWithResults([
    [healthySchema()],
    [healthyProjection()],
  ]);
  const health = await repository.health();
  assert.equal(health.ready, true);
  assert.equal(health.schemaVersion, 5);
  assert.deepEqual(health.integrity, {
    checked: true,
    ready: true,
    journalSchemaVersion: 5,
    activeDeploymentCount: 1,
    activeV8Count: 1,
    activeLegacyCount: 0,
    verifiedV8TerminalOperationCount: 3,
    verifiedV8PayoutOperationCount: 5,
    missingDurableEpochCount: 0,
    staleDurableEpochCount: 0,
    missingDeterminedSnapshotCount: 0,
    missingDurablePayoutCount: 0,
    staleDurablePayoutCount: 0,
    missingDurablePayoutStageProofCount: 0,
    countLimit: 10_000,
    countsCapped: false,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.length, 12);
  assert.equal(calls[0].params[3], BRADBURY_V8_SCHEMA_CHECKSUM);
  assert.equal(calls[0].params[5], '0xc812709d267372ad7e06807bf0a4d451ed263a30');
  assert.equal(calls[0].params[6], 'c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4');
  assert.equal(calls[0].params[7], testDeployment().deploymentId);
  assert.equal(calls[0].params[8], testDeployment().addressKey);
  assert.equal(calls[0].params[9], testDeployment().expectations.owner);
  assert.match(calls[0].text, /version = 4[\s\S]*version = 5/);
  assert.match(calls[0].text, /active_v8_count/);
  assert.match(calls[1].text, /deployment_alias = 'v8'/);
  assert.match(calls[1].text, /operation\.network = 'bradbury'/);
  assert.match(calls[1].text, /operation\.chain_id = 4221/);
  assert.match(calls[1].text, /operation\.subject_type = 'payout'/);
  assert.match(calls[1].text, /LEFT JOIN arena_payouts/);
  assert.match(calls[1].text, /stale_payout_count/);
  assert.match(calls[1].text, /missing_payout_stage_proof_count/);
  assert.deepEqual(calls[1].params, [
    10_000,
    testDeployment().addressKey,
    testDeployment().deploymentId,
    testDeployment().expectations.keeper,
  ]);
});

test('history health fails closed when legacy is active or a V8 payout is missing', async () => {
  const cutover = repositoryWithResults([[
    healthySchema({ active_deployment_count: 2, active_legacy_count: 1 }),
  ]]);
  const cutoverHealth = await cutover.repository.health();
  assert.equal(cutoverHealth.ready, false);
  assert.equal(cutoverHealth.integrity.checked, false);
  assert.equal(cutover.calls.length, 1);

  const projection = repositoryWithResults([
    [healthySchema()],
    [healthyProjection({ missing_payout_count: 1, stale_payout_count: 1 })],
  ]);
  const projectionHealth = await projection.repository.health();
  assert.equal(projectionHealth.ready, false);
  assert.equal(projectionHealth.integrity.checked, true);
  assert.equal(projectionHealth.integrity.missingDurablePayoutCount, 1);
  assert.equal(projectionHealth.integrity.staleDurablePayoutCount, 1);

  const futureSchema = repositoryWithResults([[
    healthySchema({ no_future_migrations: false }),
  ]]);
  const futureHealth = await futureSchema.repository.health();
  assert.equal(futureHealth.ready, false);
  assert.equal(futureHealth.schemaVersion, null);
  assert.equal(futureSchema.calls.length, 1);
});

test('public repository queries expose only the globally active Bradbury V8 deployment', async () => {
  const deployment = testDeployment();
  const calls = [];
  const { repository } = repositoryWithResults([
    [{
      deployment_id: deployment.deploymentId,
      deployment_alias: 'v8',
      network: 'testnet-bradbury',
      chain_id: '4221',
      contract_address: deployment.addressKey,
      protocol_version: deployment.protocolVersion,
      policy_version: deployment.policyVersion,
      payout_protocol_version: deployment.payoutProtocolVersion,
      payout_factory_address: deployment.expectations.payoutFactory,
      contract_schema_sha256: 'c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4',
      owner_address: deployment.expectations.owner,
      keeper_address: deployment.expectations.keeper,
      treasury_address: deployment.expectations.treasury,
      active: true,
      source_metadata: {},
      contract_config: {},
      asset_catalog: {},
      venue_catalog: {},
    }],
    [{
      deployment_id: deployment.deploymentId,
      payout_id: TEST_PAYOUT_ID,
      kind: 'PLAYER',
      recipient_address: deployment.expectations.owner,
      amount_atto: '198',
      epoch_end_timestamp: String(TEST_EPOCH),
      objective: 'HIGH',
      wallet_key: `${TEST_EPOCH}|HIGH|${deployment.expectations.owner}`,
      stake_atto: '100',
      settlement_mode: 'PARIMUTUEL',
      includes_rounding_remainder: false,
      state: 'PREPARING',
      vault_address: null,
      prepare_attempt_count: '1',
      attempt_count: '0',
      reserve_remaining_atto: '594',
      escrow_withdrawn: false,
      created_at_timestamp: String(TEST_EPOCH + 200),
      last_prepare_timestamp: String(TEST_EPOCH + 200),
      last_dispatch_timestamp: '0',
      funded_at_timestamp: '0',
      withdrawn_at_timestamp: '0',
      source_metadata: {},
      stage_proofs: [{ stage: 'PREPARING', domain: 'GENLAYER' }],
    }],
  ], calls);

  const deployments = await repository.listDeployments({ cursor: null, limit: 1 });
  assert.equal(deployments[0].deploymentAlias, 'v8');
  assert.equal(deployments[0].network, 'testnet-bradbury');
  assert.match(calls[0].text, /d\.deployment_alias = 'v8'/);
  assert.match(calls[0].text, /d\.contract_address = \$2/);
  assert.match(calls[0].text, /d\.owner_address = \$3/);
  assert.match(calls[0].text, /d\.keeper_address = \$4/);
  assert.match(calls[0].text, /d\.treasury_address = \$5/);
  assert.match(calls[0].text, /d\.active = true/);

  const payouts = await repository.listPayouts({
    deployment: 'v8',
    cursor: {
      createdAtTimestamp: String(TEST_EPOCH + 201),
      deploymentId: deployment.deploymentId,
      payoutId: 'f'.repeat(64),
    },
    limit: 1,
  });
  assert.equal(payouts[0].payoutId, TEST_PAYOUT_ID);
  assert.equal(payouts[0].walletKey, `${TEST_EPOCH}|HIGH|${deployment.expectations.owner}`);
  assert.deepEqual(payouts[0].stageProofs, [{ stage: 'PREPARING', domain: 'GENLAYER' }]);
  assert.match(calls[1].text, /deployment_row\.network = 'testnet-bradbury'/);
  assert.match(calls[1].text, /deployment_row\.active = true/);
  assert.match(calls[1].text, /arena_payout_stage_proofs/);
  assert.deepEqual(calls[1].params, [
    deployment.deploymentId,
    deployment.addressKey,
    deployment.expectations.owner,
    deployment.expectations.keeper,
    deployment.expectations.treasury,
    'v8',
    String(TEST_EPOCH + 201),
    deployment.deploymentId,
    'f'.repeat(64),
    2,
  ]);
});

test('V8 deployment, epoch, payout, and payout-stage proof writes are parameterized and monotonic', async () => {
  const calls = [];
  const deployment = testDeployment();
  const canonicalDeployment = normalizeDeploymentState({
    deployment,
    config: testConfig(),
    schema: testSchema(),
    epochCount: 1,
    payoutCount: 1,
    manifest: { deploymentTransactionHash: null, sourceMetadata: {} },
  });
  const epoch = normalizeEpochState({
    deployment,
    epoch: testDeterminedEpoch(),
    assets: testAssets(),
    syncedAt: '2026-08-22T00:00:00.000Z',
  });
  const payout = normalizePayoutState({
    deployment,
    payout: testPayout(),
    syncedAt: '2026-08-22T00:00:00.000Z',
  });
  const { repository } = repositoryWithResults([
    [{ deployment_id: deployment.deploymentId }],
    [{ deployment_id: deployment.deploymentId }],
    [{ payout_id: TEST_PAYOUT_ID }],
    [{ payout_id: TEST_PAYOUT_ID }],
  ], calls);

  await repository.upsertDeployment(canonicalDeployment);
  await repository.upsertEpoch(epoch);
  await repository.upsertPayout(payout);
  await repository.upsertPayoutStageProof({
    deploymentId: deployment.deploymentId,
    payoutId: TEST_PAYOUT_ID,
    stage: 'PREPARING',
    proofDomain: 'GENLAYER',
    transactionHash: `0x${'b'.repeat(64)}`,
    method: 'claim',
    proofMetadata: { finalized: true },
  });

  assert.equal(calls.length, 4);
  assert.match(calls[0].text, /WITH deactivated AS/);
  assert.match(calls[0].text, /deployment_id <> \$1::text/);
  assert.equal(calls[0].params[2], 'testnet-bradbury');
  assert.equal(calls[0].params[3], 4_221);
  assert.match(calls[1].text, /WITH epoch_upsert AS/);
  assert.match(calls[1].text, /snapshot_upsert/);
  assert.match(calls[2].text, /array_position/);
  assert.equal(calls[2].params[1], TEST_PAYOUT_ID);
  assert.match(calls[3].text, /proof_domain/);
  assert.equal(calls[3].params[3], 'GENLAYER');
});

test('payout cursor and keeper proof projection are exact-deployment scoped and retain retry attempts', async () => {
  const deployment = testDeployment();
  const calls = [];
  const { repository } = repositoryWithResults([
    [{ next_offset: '25', observed_total: '80' }],
    [{ deployment_id: deployment.deploymentId }],
    [{ projected_count: 2 }],
    [{ payout_id: TEST_PAYOUT_ID }],
    [{ payout_id: TEST_PAYOUT_ID }],
  ], calls);

  assert.deepEqual(await repository.getPayoutSyncCursor(deployment.deploymentId), {
    nextOffset: 25,
    observedTotal: 80,
  });
  await repository.advancePayoutSyncCursor({
    deploymentId: deployment.deploymentId,
    expectedOffset: 25,
    nextOffset: 50,
    observedTotal: 90,
  });
  assert.equal(await repository.projectVerifiedPayoutStageProofs({
    deploymentId: deployment.deploymentId,
    payoutIds: [TEST_PAYOUT_ID],
  }), 2);
  for (const [attemptNumber, suffix] of [[2, 'c'], [3, 'd']]) {
    await repository.upsertPayoutStageProof({
      deploymentId: deployment.deploymentId,
      payoutId: TEST_PAYOUT_ID,
      stage: 'DISPATCHED',
      proofDomain: 'GENLAYER',
      transactionHash: `0x${suffix.repeat(64)}`,
      method: 'retry_payout',
      operationId: suffix.repeat(64),
      attemptNumber,
      proofMetadata: { finalized: true },
    });
  }

  assert.match(calls[0].text, /arena_payout_sync_cursors/);
  assert.deepEqual(calls[0].params.slice(0, 5), [
    deployment.deploymentId,
    deployment.addressKey,
    deployment.expectations.owner,
    deployment.expectations.keeper,
    deployment.expectations.treasury,
  ]);
  assert.match(calls[1].text, /next_offset = EXCLUDED\.next_offset/);
  assert.equal(calls[1].params[7], 25);
  assert.match(calls[2].text, /operation\.network = 'bradbury'/);
  assert.match(calls[2].text, /rpc_eligible/);
  assert.match(calls[2].text, /operation\.attempt_number/);
  assert.deepEqual(calls[2].params[5], [TEST_PAYOUT_ID]);
  assert.match(
    calls[3].text,
    /ON CONFLICT \(deployment_id, payout_id, proof_domain, transaction_hash\)/,
  );
  assert.equal(calls[3].params[7], 2);
  assert.equal(calls[4].params[7], 3);
  assert.notEqual(calls[3].params[4], calls[4].params[4]);
});

test('deployment writes fail before SQL when address or release roles differ from configured V8', async () => {
  const calls = [];
  const deployment = testDeployment();
  const canonical = normalizeDeploymentState({
    deployment,
    config: testConfig(),
    schema: testSchema(),
    epochCount: 0,
    payoutCount: 0,
    manifest: { deploymentTransactionHash: null, sourceMetadata: {} },
  });
  const { repository } = repositoryWithResults([], calls);
  await assert.rejects(
    () => repository.upsertDeployment({
      ...canonical,
      owner: '0x1111111111111111111111111111111111111111',
    }),
    /does not match the configured Bradbury V8 identity/,
  );
  assert.equal(calls.length, 0);
});
