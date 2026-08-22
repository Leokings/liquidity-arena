import { HistoryError } from './errors.mjs';
import {
  KEEPER_JOURNAL_SCHEMA_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V4_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V5_CHECKSUM,
} from '../keeper-journal/repository.mjs';
import {
  AUDITED_PAYOUT_FACTORY_4221,
  LIQUIDITY_ARENA_PAYOUT_PROTOCOL,
  LIQUIDITY_ARENA_POLICY,
  LIQUIDITY_ARENA_V8_PROTOCOL,
  loadLiquidityArenaDeploymentConfig,
} from '../server/deployment-config.mjs';
import { EXPECTED_V8_SCHEMA_SHA256 } from '../server/v8-contract-config.mjs';

const HISTORY_SCHEMA_CHECKSUM = 'dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2';
const BRADBURY_V8_SCHEMA_CHECKSUM = KEEPER_JOURNAL_SCHEMA_V4_CHECKSUM;
const HISTORY_INTEGRITY_COUNT_LIMIT = 10_000;
const QUERY_TIMEOUT_MS = 8_000;
const PAYOUT_STAGE_BY_KEEPER_METHOD = Object.freeze({
  retry_prepare_payout: 'PREPARING',
  dispatch_payout: 'DISPATCHED',
  retry_payout: 'DISPATCHED',
  confirm_payout: 'FUNDED_IN_ESCROW',
  refresh_payout_withdrawal: 'EOA_WITHDRAWN',
});

function json(value) {
  return JSON.stringify(value ?? null);
}

async function withTimeout(promise, timeoutMs = QUERY_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HistoryError(
          'HISTORY_DATABASE_TIMEOUT',
          'History database request timed out.',
          { statusCode: 503 },
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function databaseUrl(environment) {
  const value = String(environment?.DATABASE_URL || '').trim();
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) return '';
    return value;
  } catch {
    return '';
  }
}

function unavailable() {
  throw new HistoryError('HISTORY_UNCONFIGURED', 'Durable history is not configured.', {
    statusCode: 503,
  });
}

function exactConfiguredDeployment(environment) {
  const config = loadLiquidityArenaDeploymentConfig(environment);
  const contractAddress = config.v8ContractAddress.toLowerCase();
  return Object.freeze({
    deploymentId: `testnet-bradbury:${contractAddress}`,
    contractAddress,
    ownerAddress: config.v8Expectations.owner.toLowerCase(),
    keeperAddress: config.v8Expectations.keeper.toLowerCase(),
    treasuryAddress: config.v8Expectations.treasury.toLowerCase(),
    payoutFactoryAddress: config.v8Expectations.payoutFactory.toLowerCase(),
  });
}

function unconfiguredDeployment(cause) {
  throw new HistoryError(
    'HISTORY_DEPLOYMENT_UNCONFIGURED',
    'Durable history has no release-exact Bradbury V8 deployment configuration.',
    { statusCode: 503, cause },
  );
}

function publicDeployment(row) {
  return Object.freeze({
    deploymentId: row.deployment_id,
    deploymentAlias: row.deployment_alias,
    network: row.network,
    chainId: Number(row.chain_id),
    contractAddress: row.contract_address,
    protocolVersion: row.protocol_version,
    policyVersion: row.policy_version,
    payoutProtocolVersion: row.payout_protocol_version,
    payoutFactoryAddress: row.payout_factory_address,
    contractSchemaSha256: row.contract_schema_sha256,
    ownerAddress: row.owner_address,
    keeperAddress: row.keeper_address,
    treasuryAddress: row.treasury_address,
    deploymentTransactionHash: row.deployment_transaction_hash,
    deploymentFinality: row.deployment_proof_status ? Object.freeze({
      status: row.deployment_proof_status,
      verifiedAt: row.deployment_proof_verified_at,
    }) : null,
    active: row.active === true,
    sourceMetadata: row.source_metadata,
    contractConfig: row.contract_config,
    assetCatalog: row.asset_catalog,
    venueCatalog: row.venue_catalog,
    firstSeenAt: row.first_seen_at,
    lastSyncedAt: row.last_synced_at,
  });
}

function publicPayout(row) {
  return Object.freeze({
    deploymentId: row.deployment_id,
    deploymentAlias: 'v8',
    payoutId: row.payout_id,
    kind: row.kind,
    recipientAddress: row.recipient_address,
    amountAtto: String(row.amount_atto),
    epochEndTimestamp: row.epoch_end_timestamp === null ? null : String(row.epoch_end_timestamp),
    objective: row.objective,
    walletKey: row.wallet_key,
    stakeAtto: String(row.stake_atto),
    settlementMode: row.settlement_mode,
    includesRoundingRemainder: row.includes_rounding_remainder === true,
    state: row.state,
    vaultAddress: row.vault_address,
    prepareAttemptCount: Number(row.prepare_attempt_count),
    attemptCount: Number(row.attempt_count),
    reserveRemainingAtto: String(row.reserve_remaining_atto),
    escrowWithdrawn: row.escrow_withdrawn === true,
    createdAtTimestamp: String(row.created_at_timestamp),
    lastPrepareTimestamp: String(row.last_prepare_timestamp),
    lastDispatchTimestamp: String(row.last_dispatch_timestamp),
    fundedAtTimestamp: String(row.funded_at_timestamp),
    withdrawnAtTimestamp: String(row.withdrawn_at_timestamp),
    sourceMetadata: row.source_metadata,
    stageProofs: Object.freeze(row.stage_proofs || []),
    firstSeenAt: row.first_seen_at,
    lastSyncedAt: row.last_synced_at,
  });
}

function publicEpoch(row) {
  const snapshot = row.asset_vector === null ? null : Object.freeze({
    resultStatus: row.snapshot_result_status,
    assetVector: row.asset_vector,
    highWinnerAssetId: row.high_winner_asset_id,
    highWinnerReturnPpb: String(row.high_winner_return_ppb),
    lowWinnerAssetId: row.low_winner_asset_id,
    lowWinnerReturnPpb: String(row.low_winner_return_ppb),
    qualifiedVenues: row.snapshot_qualified_venues,
    resolutionDigest: row.snapshot_resolution_digest,
    sourceMetadata: row.snapshot_source_metadata,
  });
  return Object.freeze({
    deploymentId: row.deployment_id,
    deploymentAlias: row.deployment_alias,
    protocolVersion: row.protocol_version,
    contractAddress: row.contract_address,
    epochEndTimestamp: String(row.epoch_end_timestamp),
    status: row.status,
    resultStatus: row.result_status,
    phase: row.phase,
    wagerOpensTimestamp: String(row.wager_opens_timestamp),
    wagerClosesTimestamp: String(row.wager_closes_timestamp),
    battleStartsTimestamp: String(row.battle_starts_timestamp),
    resolutionAvailableTimestamp: String(row.resolution_available_timestamp),
    timeoutRefundAvailableTimestamp: String(row.timeout_refund_available_timestamp),
    resolvedAtTimestamp: row.resolved_at_timestamp === null ? null : String(row.resolved_at_timestamp),
    resolutionDigest: row.resolution_digest,
    qualifiedVenues: row.qualified_venues,
    venueCount: row.venue_count,
    platformFeeBps: row.platform_fee_bps,
    platformFeeAccruedAtto: String(row.platform_fee_accrued_atto),
    minimumStakeAtto: String(row.minimum_stake_atto),
    maximumStakePerWalletAtto: String(row.maximum_stake_per_wallet_atto),
    highObjective: row.high_objective,
    lowObjective: row.low_objective,
    sourceMetadata: row.source_metadata,
    finalityMetadata: row.finality_metadata,
    verifiedProofs: row.verified_proofs || [],
    snapshot,
    firstSeenAt: row.first_seen_at,
    lastSyncedAt: row.last_synced_at,
  });
}

function publicProof(row) {
  return Object.freeze({
    transactionHash: row.transaction_hash,
    deploymentId: row.deployment_id,
    deploymentAlias: row.deployment_alias,
    epochEndTimestamp: row.epoch_end_timestamp === null ? null : String(row.epoch_end_timestamp),
    kind: row.proof_kind,
    method: row.method || null,
    status: row.status,
    valueAtto: row.value_atto === null ? null : String(row.value_atto),
    valueCredited: row.value_credited === null || row.value_credited === undefined
      ? null
      : row.value_credited === true,
    parentTransactionHash: row.parent_transaction_hash || null,
    childTransactionHashes: Object.freeze([...(row.child_transaction_hashes || [])]),
    verifiedAt: row.verified_at,
  });
}

export function createNeonHistoryRepository({
  environment = process.env,
  importDriver = () => import('@neondatabase/serverless'),
} = {}) {
  const connectionString = databaseUrl(environment);
  let sqlPromise;
  const configured = Boolean(connectionString);
  let expectedDeployment = null;
  let deploymentConfigurationError = null;
  try {
    expectedDeployment = exactConfiguredDeployment(environment);
  } catch (error) {
    deploymentConfigurationError = error;
  }

  function requireExpectedDeployment() {
    if (!expectedDeployment) unconfiguredDeployment(deploymentConfigurationError);
    return expectedDeployment;
  }

  function assertExpectedDeploymentId(deploymentId) {
    const expected = requireExpectedDeployment();
    if (deploymentId !== expected.deploymentId) {
      throw new HistoryError(
        'HISTORY_DEPLOYMENT_SCOPE',
        'History writes are restricted to the configured Bradbury V8 deployment.',
        { statusCode: 409 },
      );
    }
    return expected;
  }

  function assertExpectedDeploymentValue(value) {
    const expected = assertExpectedDeploymentId(value?.deploymentId);
    if (value?.alias !== 'v8'
      || value?.network !== 'testnet-bradbury'
      || Number(value?.chainId) !== 4_221
      || value?.contractAddress !== expected.contractAddress
      || value?.owner !== expected.ownerAddress
      || value?.keeper !== expected.keeperAddress
      || value?.treasury !== expected.treasuryAddress
      || value?.payoutFactoryAddress !== expected.payoutFactoryAddress
      || value?.protocolVersion !== LIQUIDITY_ARENA_V8_PROTOCOL
      || value?.policyVersion !== LIQUIDITY_ARENA_POLICY
      || value?.payoutProtocolVersion !== LIQUIDITY_ARENA_PAYOUT_PROTOCOL
      || value?.contractSchemaSha256 !== EXPECTED_V8_SCHEMA_SHA256
      || value?.active !== true) {
      throw new HistoryError(
        'HISTORY_DEPLOYMENT_SCOPE',
        'History deployment state does not match the configured Bradbury V8 identity and roles.',
        { statusCode: 409 },
      );
    }
  }

  async function sql() {
    if (!configured) unavailable();
    sqlPromise ||= Promise.resolve(importDriver()).then((module) => {
      if (typeof module?.neon !== 'function') {
        throw new HistoryError('HISTORY_DATABASE_DRIVER', 'History database driver is unavailable.', {
          statusCode: 503,
        });
      }
      return module.neon(connectionString);
    });
    return sqlPromise;
  }

  async function query(text, params = [], timeoutMs = QUERY_TIMEOUT_MS) {
    requireExpectedDeployment();
    try {
      const client = await sql();
      return await withTimeout(client.query(text, params), timeoutMs);
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      throw new HistoryError('HISTORY_DATABASE_UNAVAILABLE', 'History database is unavailable.', {
        statusCode: 503,
        cause: error,
      });
    }
  }

  return Object.freeze({
    configured,

    async health() {
      if (!configured) return Object.freeze({ configured: false, ready: false, schemaVersion: null });
      if (!expectedDeployment) {
        return Object.freeze({ configured: true, ready: false, schemaVersion: null });
      }
      const rows = await query(
        `SELECT
           to_regclass('public.arena_deployments') IS NOT NULL AS deployments_exists,
           to_regclass('public.arena_epochs') IS NOT NULL AS epochs_exists,
           to_regclass('public.arena_market_snapshots') IS NOT NULL AS snapshots_exists,
           to_regclass('public.arena_transaction_proofs') IS NOT NULL AS proofs_exists,
           to_regclass('public.arena_payouts') IS NOT NULL AS payouts_exists,
           to_regclass('public.arena_payout_stage_proofs') IS NOT NULL AS payout_proofs_exists,
           to_regclass('public.arena_payout_sync_cursors') IS NOT NULL AS payout_cursors_exists,
           to_regclass('public.arena_keeper_runs') IS NOT NULL AS runs_exists,
           to_regclass('public.arena_keeper_operations') IS NOT NULL AS journal_operations_exists,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
             WHERE version = 1 AND schema_checksum = $1
           ) AS migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 2
                AND name = 'keeper_transaction_journal'
                AND schema_checksum = $2
           ) AS journal_base_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 3
                AND name = 'keeper_transaction_journal_attempts'
                AND schema_checksum = $3
           ) AS journal_attempt_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 4
                AND name = 'bradbury_v8_cutover'
                AND schema_checksum = $4
           ) AS bradbury_v8_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 5
                AND name = 'keeper_receipt_identity_revalidation'
                AND schema_checksum = $5
           ) AS keeper_revalidation_migration_valid,
           NOT EXISTS (
             SELECT 1 FROM arena_schema_migrations WHERE version > 5
           ) AS no_future_migrations,
           (SELECT count(*)::integer FROM arena_deployments WHERE active) AS active_deployment_count,
           (SELECT count(*)::integer FROM arena_deployments
             WHERE active AND deployment_alias = 'v8'
               AND network = 'testnet-bradbury' AND chain_id = 4221
               AND deployment_id = $8
               AND contract_address = $9
               AND owner_address = $10
               AND keeper_address = $11
               AND treasury_address = $12
               AND protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
               AND policy_version = '${LIQUIDITY_ARENA_POLICY}'
               AND payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
               AND payout_factory_address = $6
               AND contract_schema_sha256 = $7) AS active_v8_count,
           (SELECT count(*)::integer FROM arena_deployments
             WHERE active AND deployment_alias IN ('v6', 'v7')) AS active_legacy_count`,
        [
          HISTORY_SCHEMA_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V4_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V5_CHECKSUM,
          AUDITED_PAYOUT_FACTORY_4221,
          EXPECTED_V8_SCHEMA_SHA256,
          expectedDeployment.deploymentId,
          expectedDeployment.contractAddress,
          expectedDeployment.ownerAddress,
          expectedDeployment.keeperAddress,
          expectedDeployment.treasuryAddress,
        ],
        3_000,
      );
      const state = rows[0] || {};
      const schemaReady = state.deployments_exists === true
        && state.epochs_exists === true
        && state.snapshots_exists === true
        && state.proofs_exists === true
        && state.payouts_exists === true
        && state.payout_proofs_exists === true
        && state.payout_cursors_exists === true
        && state.runs_exists === true
        && state.migration_valid === true
        && state.bradbury_v8_migration_valid === true
        && state.keeper_revalidation_migration_valid === true
        && state.no_future_migrations === true;
      const journalCompatible = state.journal_operations_exists === true
        && state.journal_base_migration_valid === true
        && state.journal_attempt_migration_valid === true
        && state.bradbury_v8_migration_valid === true
        && state.keeper_revalidation_migration_valid === true
        && state.no_future_migrations === true;
      const deploymentCutoverReady = Number(state.active_deployment_count || 0) === 1
        && Number(state.active_v8_count || 0) === 1
        && Number(state.active_legacy_count || 0) === 0;
      let integrity = Object.freeze({
        checked: false,
        ready: false,
        journalSchemaVersion: state.keeper_revalidation_migration_valid === true ? 5 : null,
        activeDeploymentCount: Number(state.active_deployment_count || 0),
        activeV8Count: Number(state.active_v8_count || 0),
        activeLegacyCount: Number(state.active_legacy_count || 0),
        verifiedV8TerminalOperationCount: 0,
        verifiedV8PayoutOperationCount: 0,
        missingDurableEpochCount: 0,
        staleDurableEpochCount: 0,
        missingDeterminedSnapshotCount: 0,
        missingDurablePayoutCount: 0,
        staleDurablePayoutCount: 0,
        missingDurablePayoutStageProofCount: 0,
        countLimit: HISTORY_INTEGRITY_COUNT_LIMIT,
        countsCapped: false,
      });
      if (schemaReady && journalCompatible && deploymentCutoverReady) {
        const integrityRows = await query(
          `WITH verified_terminals AS (
             SELECT operation.contract_address, operation.epoch_end_timestamp, operation.method
               FROM arena_keeper_operations operation
              WHERE operation.deployment_alias = 'v8'
                AND operation.network = 'bradbury'
                AND operation.chain_id = 4221
                AND operation.contract_address = $2
                AND operation.signer_address = $4
                AND operation.subject_type = 'epoch'
                AND operation.method IN ('resolve_epoch', 'activate_timeout_refund')
                AND operation.state = 'VERIFIED'
           ), projection AS (
             SELECT verified.contract_address, verified.epoch_end_timestamp,
                    verified.method,
                    epoch.deployment_id AS epoch_deployment_id,
                    epoch.status AS epoch_status,
                    epoch.result_status AS epoch_result_status,
                    snapshot.deployment_id AS snapshot_deployment_id
               FROM verified_terminals verified
               LEFT JOIN arena_epochs epoch
                 ON epoch.deployment_id = $3
                AND epoch.contract_address = $2
                AND epoch.epoch_end_timestamp = verified.epoch_end_timestamp
               LEFT JOIN arena_market_snapshots snapshot
                ON snapshot.deployment_id = epoch.deployment_id
                AND snapshot.epoch_end_timestamp = epoch.epoch_end_timestamp
           ), verified_payouts AS (
             SELECT operation.contract_address, operation.subject_id AS payout_id,
                    operation.method, operation.transaction_hash,
                    operation.operation_id, operation.attempt_number
               FROM arena_keeper_operations operation
              WHERE operation.deployment_alias = 'v8'
                AND operation.network = 'bradbury'
                AND operation.chain_id = 4221
                AND operation.contract_address = $2
                AND operation.signer_address = $4
                AND operation.subject_type = 'payout'
                AND operation.state = 'VERIFIED'
           ), payout_projection AS (
             SELECT verified.payout_id, verified.method, payout.deployment_id,
                    payout.state AS payout_state,
                    stage_proof.transaction_hash AS stage_proof_transaction_hash
               FROM verified_payouts verified
               LEFT JOIN arena_payouts payout
                 ON payout.deployment_id = $3
                AND payout.payout_id = verified.payout_id
               LEFT JOIN arena_payout_stage_proofs stage_proof
                 ON stage_proof.deployment_id = $3
                AND stage_proof.payout_id = verified.payout_id
                AND stage_proof.proof_domain = 'GENLAYER'
                AND stage_proof.transaction_hash = verified.transaction_hash
                AND stage_proof.method = verified.method
                AND stage_proof.operation_id = verified.operation_id
                AND stage_proof.attempt_number = verified.attempt_number
           )
           SELECT
             LEAST(COUNT(*), $1::bigint)::integer AS verified_terminal_count,
             LEAST(COUNT(*) FILTER (
               WHERE method = 'resolve_epoch'
             ), $1::bigint)::integer AS verified_resolve_count,
             LEAST(COUNT(*) FILTER (
               WHERE method = 'activate_timeout_refund'
             ), $1::bigint)::integer AS verified_timeout_count,
             LEAST(COUNT(*) FILTER (
               WHERE epoch_deployment_id IS NULL
             ), $1::bigint)::integer AS missing_epoch_count,
             LEAST(COUNT(*) FILTER (
               WHERE epoch_deployment_id IS NOT NULL
                 AND (
                   (method = 'resolve_epoch' AND NOT (
                     epoch_status = 'RESOLVED' AND epoch_result_status = 'DETERMINED'
                   ))
                   OR (method = 'activate_timeout_refund' AND NOT (
                     epoch_status = 'TIMED_OUT' AND epoch_result_status = 'TIMEOUT'
                   ))
                 )
             ), $1::bigint)::integer AS stale_epoch_count,
             LEAST(COUNT(*) FILTER (
               WHERE method = 'resolve_epoch'
                 AND epoch_status = 'RESOLVED'
                 AND epoch_result_status = 'DETERMINED'
                 AND snapshot_deployment_id IS NULL
             ), $1::bigint)::integer AS missing_snapshot_count,
             (SELECT LEAST(COUNT(*), $1::bigint)::integer FROM verified_payouts)
               AS verified_payout_count,
             (SELECT LEAST(COUNT(*) FILTER (WHERE deployment_id IS NULL), $1::bigint)::integer
                FROM payout_projection) AS missing_payout_count,
             (SELECT LEAST(COUNT(*) FILTER (
                WHERE deployment_id IS NOT NULL AND stage_proof_transaction_hash IS NULL
              ), $1::bigint)::integer FROM payout_projection) AS missing_payout_stage_proof_count,
             (SELECT LEAST(COUNT(*) FILTER (
                WHERE deployment_id IS NOT NULL AND NOT (
                  (method = 'retry_prepare_payout' AND payout_state IN (
                    'PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                  ))
                  OR (method IN ('dispatch_payout', 'retry_payout') AND payout_state IN (
                    'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                  ))
                  OR (method = 'confirm_payout' AND payout_state IN (
                    'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                  ))
                  OR (method = 'refresh_payout_withdrawal' AND payout_state = 'EOA_WITHDRAWN')
                )
              ), $1::bigint)::integer FROM payout_projection) AS stale_payout_count,
             (COUNT(*) > $1::bigint
               OR (SELECT COUNT(*) > $1::bigint FROM verified_payouts)) AS counts_capped
             FROM projection`,
          [
            HISTORY_INTEGRITY_COUNT_LIMIT,
            expectedDeployment.contractAddress,
            expectedDeployment.deploymentId,
            expectedDeployment.keeperAddress,
          ],
          3_000,
        );
        const projection = integrityRows[0] || {};
        const missingDurableEpochCount = Number(projection.missing_epoch_count || 0);
        const staleDurableEpochCount = Number(projection.stale_epoch_count || 0);
        const missingDeterminedSnapshotCount = Number(projection.missing_snapshot_count || 0);
        const missingDurablePayoutCount = Number(projection.missing_payout_count || 0);
        const staleDurablePayoutCount = Number(projection.stale_payout_count || 0);
        const missingDurablePayoutStageProofCount = Number(
          projection.missing_payout_stage_proof_count || 0,
        );
        integrity = Object.freeze({
          checked: true,
          ready: missingDurableEpochCount === 0
            && staleDurableEpochCount === 0
            && missingDeterminedSnapshotCount === 0
            && missingDurablePayoutCount === 0
            && staleDurablePayoutCount === 0
            && missingDurablePayoutStageProofCount === 0,
          journalSchemaVersion: 5,
          activeDeploymentCount: 1,
          activeV8Count: 1,
          activeLegacyCount: 0,
          verifiedV8TerminalOperationCount: Number(projection.verified_terminal_count || 0),
          verifiedV8PayoutOperationCount: Number(projection.verified_payout_count || 0),
          missingDurableEpochCount,
          staleDurableEpochCount,
          missingDeterminedSnapshotCount,
          missingDurablePayoutCount,
          staleDurablePayoutCount,
          missingDurablePayoutStageProofCount,
          countLimit: HISTORY_INTEGRITY_COUNT_LIMIT,
          countsCapped: projection.counts_capped === true,
        });
      }
      return Object.freeze({
        configured: true,
        ready: schemaReady && journalCompatible && deploymentCutoverReady && integrity.ready,
        schemaVersion: schemaReady ? 5 : null,
        integrity,
      });
    },

    async listDeployments({ cursor, limit }) {
      if (!configured) unavailable();
      requireExpectedDeployment();
      const rows = await query(
        `SELECT d.deployment_id, d.deployment_alias, d.network, d.chain_id::text, d.contract_address,
                d.protocol_version, d.policy_version, d.owner_address, d.keeper_address, d.treasury_address,
                d.payout_protocol_version, d.payout_factory_address, d.contract_schema_sha256,
                d.deployment_transaction_hash, d.active, d.source_metadata, d.contract_config,
                d.asset_catalog, d.venue_catalog, d.first_seen_at, d.last_synced_at,
                p.status AS deployment_proof_status,
                p.verified_at AS deployment_proof_verified_at
           FROM arena_deployments d
           LEFT JOIN arena_transaction_proofs p
             ON p.transaction_hash = d.deployment_transaction_hash
            AND p.deployment_id = d.deployment_id
            AND p.proof_kind = 'DEPLOYMENT'
          WHERE d.deployment_alias = 'v8'
            AND d.network = 'testnet-bradbury'
            AND d.chain_id = 4221
            AND d.deployment_id = $1
            AND d.contract_address = $2
            AND d.owner_address = $3
            AND d.keeper_address = $4
            AND d.treasury_address = $5
            AND d.protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
            AND d.policy_version = '${LIQUIDITY_ARENA_POLICY}'
            AND d.payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
            AND d.payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
            AND d.contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
            AND d.active = true
            AND ($6::text IS NULL OR d.deployment_id < $6::text)
          ORDER BY d.deployment_id DESC
          LIMIT $7::integer`,
        [
          expectedDeployment.deploymentId,
          expectedDeployment.contractAddress,
          expectedDeployment.ownerAddress,
          expectedDeployment.keeperAddress,
          expectedDeployment.treasuryAddress,
          cursor?.deploymentId || null,
          limit + 1,
        ],
      );
      return rows.map(publicDeployment);
    },

    async listEpochs({ cursor, deployment, limit }) {
      if (!configured) unavailable();
      requireExpectedDeployment();
      const rows = await query(
        `SELECT e.deployment_id, e.deployment_alias, d.protocol_version, e.contract_address,
                e.epoch_end_timestamp::text, e.status, e.result_status, e.phase,
                e.wager_opens_timestamp::text, e.wager_closes_timestamp::text,
                e.battle_starts_timestamp::text, e.resolution_available_timestamp::text,
                e.timeout_refund_available_timestamp::text, e.resolved_at_timestamp::text,
                e.resolution_digest, e.qualified_venues, e.venue_count, e.platform_fee_bps,
                e.platform_fee_accrued_atto::text, e.minimum_stake_atto::text,
                e.maximum_stake_per_wallet_atto::text, e.high_objective, e.low_objective,
                e.source_metadata, e.finality_metadata, e.first_seen_at, e.last_synced_at,
                s.result_status AS snapshot_result_status, s.asset_vector,
                s.high_winner_asset_id, s.high_winner_return_ppb::text,
                s.low_winner_asset_id, s.low_winner_return_ppb::text,
                s.qualified_venues AS snapshot_qualified_venues,
                s.resolution_digest AS snapshot_resolution_digest,
                s.source_metadata AS snapshot_source_metadata,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'transactionHash', p.transaction_hash,
                    'kind', p.proof_kind,
                    'method', p.method,
                    'status', p.status,
                    'valueAtto', p.value_atto::text,
                    'valueCredited', p.value_credited,
                    'childTransactionHashes', p.child_transaction_hashes,
                    'verifiedAt', p.verified_at
                  ) ORDER BY p.verified_at, p.transaction_hash)
                    FROM arena_transaction_proofs p
                   WHERE p.deployment_id = e.deployment_id
                     AND p.epoch_end_timestamp = e.epoch_end_timestamp
                ), '[]'::jsonb) AS verified_proofs
           FROM arena_epochs e
           JOIN arena_deployments d ON d.deployment_id = e.deployment_id
           LEFT JOIN arena_market_snapshots s
             ON s.deployment_id = e.deployment_id
            AND s.epoch_end_timestamp = e.epoch_end_timestamp
          WHERE d.deployment_alias = 'v8'
            AND d.network = 'testnet-bradbury'
            AND d.chain_id = 4221
            AND d.deployment_id = $1
            AND d.contract_address = $2
            AND d.owner_address = $3
            AND d.keeper_address = $4
            AND d.treasury_address = $5
            AND d.protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
            AND d.policy_version = '${LIQUIDITY_ARENA_POLICY}'
            AND d.payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
            AND d.payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
            AND d.contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
            AND d.active = true
            AND ($6::text IS NULL OR e.deployment_alias = $6::text)
            AND ($7::bigint IS NULL OR (e.epoch_end_timestamp, e.deployment_id)
                 < ($7::bigint, $8::text))
          ORDER BY e.epoch_end_timestamp DESC, e.deployment_id DESC
          LIMIT $9::integer`,
        [
          expectedDeployment.deploymentId,
          expectedDeployment.contractAddress,
          expectedDeployment.ownerAddress,
          expectedDeployment.keeperAddress,
          expectedDeployment.treasuryAddress,
          deployment,
          cursor?.epochEndTimestamp || null,
          cursor?.deploymentId || '',
          limit + 1,
        ],
      );
      return rows.map(publicEpoch);
    },

    async listProofs({ cursor, deployment, limit }) {
      if (!configured) unavailable();
      requireExpectedDeployment();
      const rows = await query(
        `SELECT proof.transaction_hash, proof.deployment_id, proof.deployment_alias,
                proof.epoch_end_timestamp::text, proof.proof_kind, proof.method, proof.status,
                proof.value_atto::text, proof.value_credited, proof.parent_transaction_hash,
                proof.child_transaction_hashes, proof.verified_at
           FROM arena_transaction_proofs proof
           JOIN arena_deployments deployment ON deployment.deployment_id = proof.deployment_id
          WHERE deployment.deployment_id = $1
            AND deployment.contract_address = $2
            AND deployment.owner_address = $3
            AND deployment.keeper_address = $4
            AND deployment.treasury_address = $5
            AND deployment.protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
            AND deployment.policy_version = '${LIQUIDITY_ARENA_POLICY}'
            AND deployment.payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
            AND deployment.payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
            AND deployment.contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
            AND proof.deployment_alias = $6::text
            AND deployment.network = 'testnet-bradbury'
            AND deployment.chain_id = 4221
            AND deployment.active = true
            AND ($7::text IS NULL OR proof.transaction_hash < $7::text)
          ORDER BY proof.transaction_hash DESC
          LIMIT $8::integer`,
        [
          expectedDeployment.deploymentId,
          expectedDeployment.contractAddress,
          expectedDeployment.ownerAddress,
          expectedDeployment.keeperAddress,
          expectedDeployment.treasuryAddress,
          deployment,
          cursor?.transactionHash || null,
          limit + 1,
        ],
      );
      return rows.map(publicProof);
    },

    async listPayouts({ cursor, deployment, limit }) {
      if (!configured) unavailable();
      requireExpectedDeployment();
      const rows = await query(
        `SELECT payout.deployment_id, payout.payout_id, payout.kind,
                payout.recipient_address, payout.amount_atto::text,
                payout.epoch_end_timestamp::text, payout.objective, payout.state,
                payout.wallet_key, payout.stake_atto::text, payout.settlement_mode,
                payout.includes_rounding_remainder,
                payout.vault_address, payout.prepare_attempt_count::text,
                payout.attempt_count::text, payout.reserve_remaining_atto::text,
                payout.escrow_withdrawn, payout.created_at_timestamp::text,
                payout.last_prepare_timestamp::text, payout.last_dispatch_timestamp::text,
                payout.funded_at_timestamp::text, payout.withdrawn_at_timestamp::text,
                payout.source_metadata, payout.first_seen_at, payout.last_synced_at,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'stage', proof.stage,
                    'domain', proof.proof_domain,
                    'transactionHash', proof.transaction_hash,
                    'method', proof.method,
                    'operationId', proof.operation_id,
                    'attemptNumber', proof.attempt_number,
                    'status', proof.status,
                    'verifiedAt', proof.verified_at
                  ) ORDER BY proof.verified_at, proof.transaction_hash)
                    FROM arena_payout_stage_proofs proof
                   WHERE proof.deployment_id = payout.deployment_id
                     AND proof.payout_id = payout.payout_id
                ), '[]'::jsonb) AS stage_proofs
           FROM arena_payouts payout
           JOIN arena_deployments deployment_row
             ON deployment_row.deployment_id = payout.deployment_id
          WHERE deployment_row.deployment_id = $1
            AND deployment_row.contract_address = $2
            AND deployment_row.owner_address = $3
            AND deployment_row.keeper_address = $4
            AND deployment_row.treasury_address = $5
            AND deployment_row.protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
            AND deployment_row.policy_version = '${LIQUIDITY_ARENA_POLICY}'
            AND deployment_row.payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
            AND deployment_row.payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
            AND deployment_row.contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
            AND payout.deployment_alias = $6::text
            AND deployment_row.network = 'testnet-bradbury'
            AND deployment_row.chain_id = 4221
            AND deployment_row.active = true
            AND ($7::bigint IS NULL OR (
              payout.created_at_timestamp, payout.deployment_id, payout.payout_id
            ) < ($7::bigint, $8::text, $9::text))
          ORDER BY payout.created_at_timestamp DESC, payout.deployment_id DESC, payout.payout_id DESC
          LIMIT $10::integer`,
        [
          expectedDeployment.deploymentId,
          expectedDeployment.contractAddress,
          expectedDeployment.ownerAddress,
          expectedDeployment.keeperAddress,
          expectedDeployment.treasuryAddress,
          deployment,
          cursor?.createdAtTimestamp || null,
          cursor?.deploymentId || '',
          cursor?.payoutId || '',
          limit + 1,
        ],
      );
      return rows.map(publicPayout);
    },

    async upsertDeployment(value) {
      assertExpectedDeploymentValue(value);
      const rows = await query(
        `WITH deactivated AS (
           UPDATE arena_deployments
              SET active = false, last_synced_at = now()
            WHERE $17::boolean = true
              AND deployment_id <> $1::text
              AND active = true
         ), upserted AS (
           INSERT INTO arena_deployments (
             deployment_id, deployment_alias, network, chain_id, contract_address,
             protocol_version, policy_version, owner_address, keeper_address,
             treasury_address, payout_factory_address, payout_protocol_version,
             contract_schema_sha256, deployment_transaction_hash, source_metadata,
             contract_config, asset_catalog, venue_catalog, active, last_synced_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15::jsonb, $16::jsonb, $18::jsonb, $19::jsonb, $17, now()
           )
           ON CONFLICT (deployment_id) DO UPDATE SET
             owner_address = EXCLUDED.owner_address,
             keeper_address = EXCLUDED.keeper_address,
             treasury_address = EXCLUDED.treasury_address,
             deployment_transaction_hash = COALESCE(
               arena_deployments.deployment_transaction_hash,
               EXCLUDED.deployment_transaction_hash
             ),
             source_metadata = EXCLUDED.source_metadata,
             contract_config = EXCLUDED.contract_config,
             asset_catalog = EXCLUDED.asset_catalog,
             venue_catalog = EXCLUDED.venue_catalog,
             active = EXCLUDED.active,
             last_synced_at = now()
           WHERE arena_deployments.deployment_alias = EXCLUDED.deployment_alias
             AND arena_deployments.network = EXCLUDED.network
             AND arena_deployments.chain_id = EXCLUDED.chain_id
             AND arena_deployments.contract_address = EXCLUDED.contract_address
             AND arena_deployments.protocol_version = EXCLUDED.protocol_version
             AND arena_deployments.policy_version = EXCLUDED.policy_version
             AND arena_deployments.payout_factory_address = EXCLUDED.payout_factory_address
             AND arena_deployments.payout_protocol_version = EXCLUDED.payout_protocol_version
             AND arena_deployments.contract_schema_sha256 = EXCLUDED.contract_schema_sha256
           RETURNING deployment_id
         ) SELECT deployment_id FROM upserted`,
        [
          value.deploymentId,
          value.alias,
          value.network,
          value.chainId,
          value.contractAddress,
          value.protocolVersion,
          value.policyVersion,
          value.owner,
          value.keeper,
          value.treasury,
          value.payoutFactoryAddress,
          value.payoutProtocolVersion,
          value.contractSchemaSha256,
          value.deploymentTransactionHash,
          json(value.sourceMetadata),
          json(value.contractConfig),
          value.active,
          json(value.assetCatalog),
          json(value.venueCatalog),
        ],
      );
      if (rows.length !== 1) throw new HistoryError('HISTORY_DEPLOYMENT_CONFLICT', 'Immutable deployment identity conflict.', { statusCode: 409 });
    },

    async upsertEpoch(value) {
      assertExpectedDeploymentId(value?.deploymentId);
      const epochParams = [
        value.deploymentId, value.deploymentAlias, value.epochEndTimestamp,
        value.contractAddress, value.policyVersion, value.status, value.resultStatus, value.phase,
        value.wagerOpensTimestamp, value.wagerClosesTimestamp, value.battleStartsTimestamp,
        value.resolutionAvailableTimestamp, value.timeoutRefundAvailableTimestamp,
        value.createdAtTimestamp, value.resolvedAtTimestamp, value.creatorAddress,
        value.resolutionDigest, json(value.qualifiedVenues), value.venueCount,
        value.platformFeeBps, value.platformFeeAccruedAtto, value.minimumStakeAtto,
        value.maximumStakePerWalletAtto, json(value.highObjective), json(value.lowObjective),
        json(value.sourceMetadata), json(value.finalityMetadata),
      ];
      const epochSql = `INSERT INTO arena_epochs (
          deployment_id, deployment_alias, epoch_end_timestamp, contract_address, policy_version,
          status, result_status, phase, wager_opens_timestamp, wager_closes_timestamp,
          battle_starts_timestamp, resolution_available_timestamp, timeout_refund_available_timestamp,
          created_at_timestamp, resolved_at_timestamp, creator_address, resolution_digest,
          qualified_venues, venue_count, platform_fee_bps, platform_fee_accrued_atto,
          minimum_stake_atto, maximum_stake_per_wallet_atto, high_objective, low_objective,
          source_metadata, finality_metadata, last_synced_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18::jsonb, $19, $20, $21, $22, $23, $24::jsonb, $25::jsonb,
          $26::jsonb, $27::jsonb, now()
        ) ON CONFLICT (deployment_id, epoch_end_timestamp) DO UPDATE SET
          status = EXCLUDED.status,
          result_status = EXCLUDED.result_status,
          phase = EXCLUDED.phase,
          resolved_at_timestamp = EXCLUDED.resolved_at_timestamp,
          resolution_digest = EXCLUDED.resolution_digest,
          qualified_venues = EXCLUDED.qualified_venues,
          venue_count = EXCLUDED.venue_count,
          platform_fee_accrued_atto = EXCLUDED.platform_fee_accrued_atto,
          high_objective = EXCLUDED.high_objective,
          low_objective = EXCLUDED.low_objective,
          source_metadata = EXCLUDED.source_metadata,
          finality_metadata = EXCLUDED.finality_metadata,
          last_synced_at = now()
        WHERE arena_epochs.deployment_alias = EXCLUDED.deployment_alias
          AND arena_epochs.contract_address = EXCLUDED.contract_address
          AND arena_epochs.policy_version = EXCLUDED.policy_version
          AND arena_epochs.wager_opens_timestamp = EXCLUDED.wager_opens_timestamp
          AND arena_epochs.wager_closes_timestamp = EXCLUDED.wager_closes_timestamp
          AND arena_epochs.battle_starts_timestamp = EXCLUDED.battle_starts_timestamp
          AND arena_epochs.resolution_available_timestamp = EXCLUDED.resolution_available_timestamp
          AND arena_epochs.timeout_refund_available_timestamp = EXCLUDED.timeout_refund_available_timestamp
          AND arena_epochs.minimum_stake_atto = EXCLUDED.minimum_stake_atto
          AND arena_epochs.maximum_stake_per_wallet_atto = EXCLUDED.maximum_stake_per_wallet_atto
        RETURNING deployment_id`;
      if (!value.snapshot) {
        const rows = await query(epochSql, epochParams);
        if (rows.length !== 1) throw new HistoryError('HISTORY_EPOCH_CONFLICT', 'Immutable epoch identity conflict.', { statusCode: 409 });
        return;
      }
      const snapshot = value.snapshot;
      const rows = await query(
        `WITH epoch_upsert AS (${epochSql}), snapshot_upsert AS (
           INSERT INTO arena_market_snapshots (
             deployment_id, epoch_end_timestamp, result_status, asset_vector,
             high_winner_asset_id, high_winner_return_ppb, low_winner_asset_id,
             low_winner_return_ppb, qualified_venues, resolution_digest, source_metadata, recorded_at
           ) SELECT
             $1, $3, $28, $29::jsonb, $30, $31, $32, $33, $34::jsonb, $35, $36::jsonb, now()
           FROM epoch_upsert
           ON CONFLICT (deployment_id, epoch_end_timestamp) DO UPDATE SET
             asset_vector = EXCLUDED.asset_vector,
             high_winner_asset_id = EXCLUDED.high_winner_asset_id,
             high_winner_return_ppb = EXCLUDED.high_winner_return_ppb,
             low_winner_asset_id = EXCLUDED.low_winner_asset_id,
             low_winner_return_ppb = EXCLUDED.low_winner_return_ppb,
             qualified_venues = EXCLUDED.qualified_venues,
             resolution_digest = EXCLUDED.resolution_digest,
             source_metadata = EXCLUDED.source_metadata,
             recorded_at = now()
           RETURNING deployment_id
         ) SELECT deployment_id FROM snapshot_upsert`,
        [
          ...epochParams,
          snapshot.resultStatus,
          json(snapshot.assetVector),
          snapshot.highWinnerAssetId,
          snapshot.highWinnerReturnPpb,
          snapshot.lowWinnerAssetId,
          snapshot.lowWinnerReturnPpb,
          json(snapshot.qualifiedVenues),
          snapshot.resolutionDigest,
          json(snapshot.sourceMetadata),
        ],
      );
      if (rows.length !== 1) throw new HistoryError('HISTORY_EPOCH_CONFLICT', 'Immutable epoch or market vector conflict.', { statusCode: 409 });
    },

    async upsertPayout(value) {
      assertExpectedDeploymentId(value?.deploymentId);
      const rows = await query(
        `INSERT INTO arena_payouts (
           deployment_id, payout_id, deployment_alias, kind, recipient_address,
           amount_atto, epoch_end_timestamp, objective, wallet_key, stake_atto,
           settlement_mode, includes_rounding_remainder, state, vault_address,
           prepare_attempt_count, attempt_count, reserve_remaining_atto, escrow_withdrawn,
           created_at_timestamp, last_prepare_timestamp, last_dispatch_timestamp,
           funded_at_timestamp, withdrawn_at_timestamp, source_metadata, last_synced_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, now()
         ) ON CONFLICT (deployment_id, payout_id) DO UPDATE SET
           state = EXCLUDED.state,
           vault_address = COALESCE(arena_payouts.vault_address, EXCLUDED.vault_address),
           prepare_attempt_count = EXCLUDED.prepare_attempt_count,
           attempt_count = EXCLUDED.attempt_count,
           reserve_remaining_atto = EXCLUDED.reserve_remaining_atto,
           escrow_withdrawn = EXCLUDED.escrow_withdrawn,
           last_prepare_timestamp = EXCLUDED.last_prepare_timestamp,
           last_dispatch_timestamp = EXCLUDED.last_dispatch_timestamp,
           funded_at_timestamp = EXCLUDED.funded_at_timestamp,
           withdrawn_at_timestamp = EXCLUDED.withdrawn_at_timestamp,
           source_metadata = EXCLUDED.source_metadata,
           last_synced_at = now()
         WHERE arena_payouts.deployment_alias = EXCLUDED.deployment_alias
           AND arena_payouts.kind = EXCLUDED.kind
           AND arena_payouts.recipient_address = EXCLUDED.recipient_address
           AND arena_payouts.amount_atto = EXCLUDED.amount_atto
           AND arena_payouts.epoch_end_timestamp IS NOT DISTINCT FROM EXCLUDED.epoch_end_timestamp
           AND arena_payouts.objective = EXCLUDED.objective
           AND arena_payouts.wallet_key = EXCLUDED.wallet_key
           AND arena_payouts.stake_atto = EXCLUDED.stake_atto
           AND arena_payouts.settlement_mode = EXCLUDED.settlement_mode
           AND arena_payouts.includes_rounding_remainder = EXCLUDED.includes_rounding_remainder
           AND arena_payouts.created_at_timestamp = EXCLUDED.created_at_timestamp
           AND (arena_payouts.vault_address IS NULL
             OR arena_payouts.vault_address IS NOT DISTINCT FROM EXCLUDED.vault_address)
           AND array_position(
             ARRAY['PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN']::text[],
             arena_payouts.state
           ) <= array_position(
             ARRAY['PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN']::text[],
             EXCLUDED.state
           )
           AND arena_payouts.prepare_attempt_count <= EXCLUDED.prepare_attempt_count
           AND arena_payouts.attempt_count <= EXCLUDED.attempt_count
         RETURNING payout_id`,
        [
          value.deploymentId, value.payoutId, value.deploymentAlias, value.kind,
          value.recipientAddress, value.amountAtto, value.epochEndTimestamp,
          value.objective, value.walletKey, value.stakeAtto, value.settlementMode,
          value.includesRoundingRemainder, value.state, value.vaultAddress,
          value.prepareAttemptCount, value.attemptCount, value.reserveRemainingAtto, value.escrowWithdrawn,
          value.createdAtTimestamp, value.lastPrepareTimestamp, value.lastDispatchTimestamp,
          value.fundedAtTimestamp, value.withdrawnAtTimestamp, json(value.sourceMetadata),
        ],
      );
      if (rows.length !== 1) {
        throw new HistoryError(
          'HISTORY_PAYOUT_CONFLICT',
          'Immutable payout identity or monotonic stage conflict.',
          { statusCode: 409 },
        );
      }
    },

    async getPayoutSyncCursor(deploymentId) {
      const expected = assertExpectedDeploymentId(deploymentId);
      const rows = await query(
        `SELECT cursor.next_offset::text, cursor.observed_total::text
           FROM arena_payout_sync_cursors cursor
           JOIN arena_deployments deployment
             ON deployment.deployment_id = cursor.deployment_id
          WHERE deployment.deployment_id = $1
            AND deployment.contract_address = $2
            AND deployment.owner_address = $3
            AND deployment.keeper_address = $4
            AND deployment.treasury_address = $5
            AND deployment.protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
            AND deployment.policy_version = '${LIQUIDITY_ARENA_POLICY}'
            AND deployment.payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
            AND deployment.payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
            AND deployment.contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
            AND deployment.network = 'testnet-bradbury'
            AND deployment.chain_id = 4221
            AND deployment.deployment_alias = 'v8'
            AND deployment.active = true`,
        [
          expected.deploymentId,
          expected.contractAddress,
          expected.ownerAddress,
          expected.keeperAddress,
          expected.treasuryAddress,
        ],
      );
      const nextOffset = Number(rows[0]?.next_offset ?? 0);
      const observedTotal = Number(rows[0]?.observed_total ?? 0);
      if (!Number.isSafeInteger(nextOffset) || nextOffset < 0
        || !Number.isSafeInteger(observedTotal) || observedTotal < 0) {
        throw new HistoryError('HISTORY_PAYOUT_CURSOR_CORRUPT', 'Stored payout cursor is invalid.', { statusCode: 503 });
      }
      return Object.freeze({ nextOffset, observedTotal });
    },

    async advancePayoutSyncCursor({ deploymentId, expectedOffset, nextOffset, observedTotal }) {
      const expected = assertExpectedDeploymentId(deploymentId);
      for (const [label, value] of Object.entries({ expectedOffset, nextOffset, observedTotal })) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
          throw new TypeError(`${label} must be a bounded non-negative integer.`);
        }
      }
      const rows = await query(
        `WITH exact_deployment AS (
           SELECT deployment_id FROM arena_deployments
            WHERE deployment_id = $1
              AND contract_address = $2
              AND owner_address = $3
              AND keeper_address = $4
              AND treasury_address = $5
              AND protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
              AND policy_version = '${LIQUIDITY_ARENA_POLICY}'
              AND payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
              AND payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
              AND contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
              AND network = 'testnet-bradbury'
              AND chain_id = 4221
              AND deployment_alias = 'v8'
              AND active = true
         ), advanced AS (
           INSERT INTO arena_payout_sync_cursors (
             deployment_id, next_offset, observed_total, updated_at
           ) SELECT deployment_id, $6, $7, now() FROM exact_deployment
           ON CONFLICT (deployment_id) DO UPDATE SET
             next_offset = EXCLUDED.next_offset,
             observed_total = EXCLUDED.observed_total,
             updated_at = now()
           WHERE arena_payout_sync_cursors.next_offset = $8
           RETURNING deployment_id
         ) SELECT deployment_id FROM advanced`,
        [
          expected.deploymentId,
          expected.contractAddress,
          expected.ownerAddress,
          expected.keeperAddress,
          expected.treasuryAddress,
          nextOffset,
          observedTotal,
          expectedOffset,
        ],
      );
      if (rows.length !== 1) {
        throw new HistoryError('HISTORY_PAYOUT_CURSOR_CONFLICT', 'Payout sync cursor changed concurrently.', { statusCode: 409 });
      }
    },

    async projectVerifiedPayoutStageProofs({ deploymentId, payoutIds }) {
      const expected = assertExpectedDeploymentId(deploymentId);
      const ids = [...new Set(payoutIds || [])];
      if (ids.length === 0) return 0;
      if (ids.length > 25 || ids.some((value) => !/^[0-9a-f]{64}$/.test(String(value)))) {
        throw new TypeError('Payout-stage proof projection requires at most 25 lowercase payout IDs.');
      }
      const rows = await query(
        `WITH keeper_eligible AS (
           SELECT operation.subject_id AS payout_id,
                  CASE operation.method
                    WHEN 'retry_prepare_payout' THEN 'PREPARING'
                    WHEN 'dispatch_payout' THEN 'DISPATCHED'
                    WHEN 'retry_payout' THEN 'DISPATCHED'
                    WHEN 'confirm_payout' THEN 'FUNDED_IN_ESCROW'
                    WHEN 'refresh_payout_withdrawal' THEN 'EOA_WITHDRAWN'
                  END AS stage,
                  operation.transaction_hash, operation.method,
                  operation.operation_id, operation.attempt_number,
                  operation.verified_at,
                  'BRADBURY_KEEPER_JOURNAL'::text AS proof_authority
             FROM arena_keeper_operations operation
             JOIN arena_deployments deployment
               ON deployment.deployment_id = $1
              AND deployment.contract_address = $2
              AND deployment.owner_address = $3
              AND deployment.keeper_address = $4
              AND deployment.treasury_address = $5
              AND deployment.protocol_version = '${LIQUIDITY_ARENA_V8_PROTOCOL}'
              AND deployment.policy_version = '${LIQUIDITY_ARENA_POLICY}'
              AND deployment.payout_protocol_version = '${LIQUIDITY_ARENA_PAYOUT_PROTOCOL}'
              AND deployment.payout_factory_address = '${AUDITED_PAYOUT_FACTORY_4221}'
              AND deployment.contract_schema_sha256 = '${EXPECTED_V8_SCHEMA_SHA256}'
              AND deployment.network = 'testnet-bradbury'
              AND deployment.chain_id = 4221
              AND deployment.deployment_alias = 'v8'
              AND deployment.active = true
             JOIN arena_payouts payout
               ON payout.deployment_id = deployment.deployment_id
              AND payout.payout_id = operation.subject_id
            WHERE operation.deployment_alias = 'v8'
              AND operation.network = 'bradbury'
              AND operation.chain_id = 4221
              AND operation.contract_address = $2
              AND operation.signer_address = $4
              AND operation.subject_type = 'payout'
              AND operation.subject_id = ANY($6::text[])
              AND operation.method = ANY($7::text[])
              AND operation.state = 'VERIFIED'
              AND operation.transaction_hash IS NOT NULL
              AND CASE operation.method
                WHEN 'retry_prepare_payout' THEN payout.state IN (
                  'PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                )
                WHEN 'dispatch_payout' THEN payout.state IN (
                  'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                )
                WHEN 'retry_payout' THEN payout.state IN (
                  'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                )
                WHEN 'confirm_payout' THEN payout.state IN ('FUNDED_IN_ESCROW', 'EOA_WITHDRAWN')
                WHEN 'refresh_payout_withdrawal' THEN payout.state = 'EOA_WITHDRAWN'
                ELSE false
              END
         ), rpc_eligible AS (
           SELECT proof.arguments ->> 0 AS payout_id,
                  CASE proof.method
                    WHEN 'retry_prepare_payout' THEN 'PREPARING'
                    WHEN 'dispatch_payout' THEN 'DISPATCHED'
                    WHEN 'retry_payout' THEN 'DISPATCHED'
                    WHEN 'confirm_payout' THEN 'FUNDED_IN_ESCROW'
                    WHEN 'refresh_payout_withdrawal' THEN 'EOA_WITHDRAWN'
                  END AS stage,
                  proof.transaction_hash, proof.method,
                  NULL::text AS operation_id, NULL::bigint AS attempt_number,
                  proof.verified_at,
                  'GENLAYER_BRADBURY_RPC'::text AS proof_authority
             FROM arena_transaction_proofs proof
             JOIN arena_payouts payout
               ON payout.deployment_id = $1
              AND payout.payout_id = proof.arguments ->> 0
            WHERE proof.deployment_id = $1
              AND proof.deployment_alias = 'v8'
              AND proof.status = 'FINALIZED'
              AND proof.method = ANY($7::text[])
              AND jsonb_typeof(proof.arguments) = 'array'
              AND jsonb_array_length(proof.arguments) = 1
              AND proof.arguments ->> 0 = ANY($6::text[])
              AND NOT EXISTS (
                SELECT 1 FROM arena_keeper_operations operation
                 WHERE operation.transaction_hash = proof.transaction_hash
                   AND operation.deployment_alias = 'v8'
                   AND operation.network = 'bradbury'
                   AND operation.chain_id = 4221
                   AND operation.state = 'VERIFIED'
              )
              AND CASE proof.method
                WHEN 'retry_prepare_payout' THEN payout.state IN (
                  'PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                )
                WHEN 'dispatch_payout' THEN payout.state IN (
                  'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                )
                WHEN 'retry_payout' THEN payout.state IN (
                  'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
                )
                WHEN 'confirm_payout' THEN payout.state IN ('FUNDED_IN_ESCROW', 'EOA_WITHDRAWN')
                WHEN 'refresh_payout_withdrawal' THEN payout.state = 'EOA_WITHDRAWN'
                ELSE false
              END
         ), eligible AS (
           SELECT * FROM keeper_eligible
           UNION ALL
           SELECT * FROM rpc_eligible
         ), projected AS (
           INSERT INTO arena_payout_stage_proofs (
             deployment_id, payout_id, stage, proof_domain, transaction_hash,
             method, operation_id, attempt_number, status, proof_metadata, verified_at
           ) SELECT
             $1, payout_id, stage, 'GENLAYER', transaction_hash,
             method, operation_id, attempt_number, 'FINALIZED',
             jsonb_build_object(
               'authority', proof_authority,
               'network', 'bradbury',
               'chainId', 4221,
               'operationId', operation_id,
               'attemptNumber', attempt_number
             ), COALESCE(verified_at, now())
           FROM eligible
           ON CONFLICT (deployment_id, payout_id, proof_domain, transaction_hash) DO UPDATE SET
             verified_at = EXCLUDED.verified_at,
             proof_metadata = EXCLUDED.proof_metadata
           WHERE arena_payout_stage_proofs.stage = EXCLUDED.stage
             AND arena_payout_stage_proofs.method = EXCLUDED.method
             AND arena_payout_stage_proofs.operation_id IS NOT DISTINCT FROM EXCLUDED.operation_id
             AND arena_payout_stage_proofs.attempt_number IS NOT DISTINCT FROM EXCLUDED.attempt_number
             AND arena_payout_stage_proofs.status = 'FINALIZED'
           RETURNING payout_id
         ) SELECT count(*)::integer AS projected_count FROM projected`,
        [
          expected.deploymentId,
          expected.contractAddress,
          expected.ownerAddress,
          expected.keeperAddress,
          expected.treasuryAddress,
          ids,
          Object.keys(PAYOUT_STAGE_BY_KEEPER_METHOD),
        ],
      );
      return Number(rows[0]?.projected_count || 0);
    },

    async upsertPayoutStageProof(value) {
      assertExpectedDeploymentId(value?.deploymentId);
      const rows = await query(
        `INSERT INTO arena_payout_stage_proofs (
           deployment_id, payout_id, stage, proof_domain, transaction_hash,
           method, operation_id, attempt_number, status, proof_metadata, verified_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, 'FINALIZED', $9::jsonb, now()
         )
         ON CONFLICT (deployment_id, payout_id, proof_domain, transaction_hash) DO UPDATE SET
           verified_at = now(), proof_metadata = EXCLUDED.proof_metadata
         WHERE arena_payout_stage_proofs.stage = EXCLUDED.stage
           AND arena_payout_stage_proofs.method IS NOT DISTINCT FROM EXCLUDED.method
           AND arena_payout_stage_proofs.operation_id IS NOT DISTINCT FROM EXCLUDED.operation_id
           AND arena_payout_stage_proofs.attempt_number IS NOT DISTINCT FROM EXCLUDED.attempt_number
           AND arena_payout_stage_proofs.status = 'FINALIZED'
         RETURNING payout_id`,
        [
          value.deploymentId, value.payoutId, value.stage, value.proofDomain,
          value.transactionHash, value.method ?? null, value.operationId ?? null,
          value.attemptNumber ?? null, json(value.proofMetadata),
        ],
      );
      if (rows.length !== 1) {
        throw new HistoryError('HISTORY_PAYOUT_PROOF_CONFLICT', 'Payout-stage proof identity conflict.', { statusCode: 409 });
      }
    },

    async hasEpoch(deploymentId, epochEndTimestamp) {
      assertExpectedDeploymentId(deploymentId);
      const rows = await query(
        `SELECT EXISTS (
           SELECT 1 FROM arena_epochs WHERE deployment_id = $1 AND epoch_end_timestamp = $2
         ) AS present`,
        [deploymentId, epochEndTimestamp],
      );
      return rows[0]?.present === true;
    },

    async getProof(transactionHash) {
      const rows = await query(
        `SELECT transaction_hash, deployment_id, proof_kind, method, arguments, status, verified_at
           FROM arena_transaction_proofs
          WHERE transaction_hash = $1 AND deployment_id = $2`,
        [transactionHash, expectedDeployment.deploymentId],
      );
      return rows[0] || null;
    },

    async upsertProof(value) {
      assertExpectedDeploymentId(value?.deploymentId);
      const rows = await query(
        `INSERT INTO arena_transaction_proofs (
           transaction_hash, deployment_id, deployment_alias, epoch_end_timestamp, proof_kind,
           method, arguments, sender_address, recipient_address, parent_transaction_hash,
           child_transaction_hashes, value_atto, value_credited, status, execution_result,
           proof_metadata, verified_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12,
           $13, 'FINALIZED', $14, $15::jsonb, now()
         ) ON CONFLICT (transaction_hash) DO UPDATE SET
           verified_at = now(), proof_metadata = EXCLUDED.proof_metadata
         WHERE arena_transaction_proofs.deployment_id = EXCLUDED.deployment_id
           AND arena_transaction_proofs.proof_kind = EXCLUDED.proof_kind
           AND arena_transaction_proofs.epoch_end_timestamp IS NOT DISTINCT FROM EXCLUDED.epoch_end_timestamp
           AND arena_transaction_proofs.method IS NOT DISTINCT FROM EXCLUDED.method
           AND arena_transaction_proofs.arguments = EXCLUDED.arguments
         RETURNING transaction_hash`,
        [
          value.transactionHash, value.deploymentId, value.deploymentAlias,
          value.epochEndTimestamp, value.proofKind, value.method, json(value.arguments),
          value.senderAddress, value.recipientAddress, value.parentTransactionHash,
          json(value.childTransactionHashes), value.valueAtto, value.valueCredited,
          value.executionResult, json(value.proofMetadata),
        ],
      );
      if (rows.length !== 1) throw new HistoryError('HISTORY_PROOF_CONFLICT', 'Verified transaction proof identity conflict.', { statusCode: 409 });
    },

    async claimRun({ keyHash, requestHash, deployments, leaseSeconds = 120 }) {
      const rows = await query(
        `WITH sync_lock AS (
           SELECT pg_try_advisory_xact_lock(790771993) AS acquired
         ), existing AS (
           SELECT * FROM arena_keeper_runs WHERE idempotency_key_hash = $1
         ), other_running AS (
           SELECT 1 FROM arena_keeper_runs
            WHERE status = 'RUNNING' AND lease_expires_at > now()
              AND idempotency_key_hash <> $1
            LIMIT 1
         ), updated AS (
           UPDATE arena_keeper_runs SET
             status = 'RUNNING', started_at = now(), finished_at = NULL,
             lease_expires_at = now() + ($4::integer * interval '1 second'),
             summary = NULL, error_code = NULL
            WHERE idempotency_key_hash = $1
              AND request_sha256 = $2
              AND status <> 'SUCCEEDED'
              AND (status <> 'RUNNING' OR lease_expires_at <= now())
              AND NOT EXISTS (SELECT 1 FROM other_running)
              AND (SELECT acquired FROM sync_lock)
           RETURNING *, true AS acquired
         ), inserted AS (
           INSERT INTO arena_keeper_runs (
             idempotency_key_hash, request_sha256, status, requested_deployments,
             started_at, lease_expires_at
           ) SELECT $1, $2, 'RUNNING', $3::jsonb, now(),
                    now() + ($4::integer * interval '1 second')
             WHERE NOT EXISTS (SELECT 1 FROM existing)
               AND NOT EXISTS (SELECT 1 FROM other_running)
               AND (SELECT acquired FROM sync_lock)
           ON CONFLICT DO NOTHING
           RETURNING *, true AS acquired
         ), selected AS (
           SELECT * FROM updated UNION ALL SELECT * FROM inserted UNION ALL
           SELECT r.*, false AS acquired FROM arena_keeper_runs r
            WHERE r.idempotency_key_hash = $1
              AND NOT EXISTS (SELECT 1 FROM updated)
              AND NOT EXISTS (SELECT 1 FROM inserted)
         )
         SELECT selected.*,
                (EXISTS (SELECT 1 FROM other_running)
                  OR NOT (SELECT acquired FROM sync_lock)) AS global_busy
           FROM selected LIMIT 1`,
        [keyHash, requestHash, json(deployments), leaseSeconds],
      );
      const row = rows[0];
      if (!row) return Object.freeze({ state: 'BUSY' });
      if (row.request_sha256 !== requestHash) return Object.freeze({ state: 'CONFLICT' });
      if (row.acquired === true) return Object.freeze({ state: 'CLAIMED' });
      if (row.status === 'SUCCEEDED') return Object.freeze({ state: 'REPLAY', summary: row.summary });
      return Object.freeze({ state: row.global_busy === true ? 'BUSY' : 'RUNNING' });
    },

    async completeRun({ keyHash, requestHash, summary }) {
      await query(
        `UPDATE arena_keeper_runs SET
           status = 'SUCCEEDED', finished_at = now(), lease_expires_at = now(), summary = $3::jsonb
         WHERE idempotency_key_hash = $1 AND request_sha256 = $2 AND status = 'RUNNING'`,
        [keyHash, requestHash, json(summary)],
      );
    },

    async failRun({ keyHash, requestHash, errorCode }) {
      await query(
        `UPDATE arena_keeper_runs SET
           status = 'FAILED', finished_at = now(), lease_expires_at = now(), error_code = $3
         WHERE idempotency_key_hash = $1 AND request_sha256 = $2 AND status = 'RUNNING'`,
        [keyHash, requestHash, String(errorCode || 'HISTORY_SYNC_FAILED').slice(0, 80)],
      );
    },
  });
}

export { BRADBURY_V8_SCHEMA_CHECKSUM, HISTORY_SCHEMA_CHECKSUM };
