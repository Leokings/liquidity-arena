import { HistoryError } from './errors.mjs';

const HISTORY_SCHEMA_CHECKSUM = 'dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2';
const QUERY_TIMEOUT_MS = 8_000;

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

function publicDeployment(row) {
  return Object.freeze({
    deploymentId: row.deployment_id,
    deploymentAlias: row.deployment_alias,
    network: row.network,
    chainId: Number(row.chain_id),
    contractAddress: row.contract_address,
    protocolVersion: row.protocol_version,
    policyVersion: row.policy_version,
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

export function createNeonHistoryRepository({
  environment = process.env,
  importDriver = () => import('@neondatabase/serverless'),
} = {}) {
  const connectionString = databaseUrl(environment);
  let sqlPromise;
  const configured = Boolean(connectionString);

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
      const rows = await query(
        `SELECT
           to_regclass('public.arena_deployments') IS NOT NULL AS deployments_exists,
           to_regclass('public.arena_epochs') IS NOT NULL AS epochs_exists,
           to_regclass('public.arena_market_snapshots') IS NOT NULL AS snapshots_exists,
           to_regclass('public.arena_transaction_proofs') IS NOT NULL AS proofs_exists,
           to_regclass('public.arena_keeper_runs') IS NOT NULL AS runs_exists,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
             WHERE version = 1 AND schema_checksum = $1
           ) AS migration_valid`,
        [HISTORY_SCHEMA_CHECKSUM],
        3_000,
      );
      const state = rows[0] || {};
      const ready = state.deployments_exists === true
        && state.epochs_exists === true
        && state.snapshots_exists === true
        && state.proofs_exists === true
        && state.runs_exists === true
        && state.migration_valid === true;
      return Object.freeze({ configured: true, ready, schemaVersion: ready ? 1 : null });
    },

    async listDeployments({ cursor, limit }) {
      const rows = await query(
        `SELECT d.deployment_id, d.deployment_alias, d.network, d.chain_id::text, d.contract_address,
                d.protocol_version, d.policy_version, d.owner_address, d.keeper_address, d.treasury_address,
                d.deployment_transaction_hash, d.active, d.source_metadata, d.contract_config,
                d.asset_catalog, d.venue_catalog, d.first_seen_at, d.last_synced_at,
                p.status AS deployment_proof_status,
                p.verified_at AS deployment_proof_verified_at
           FROM arena_deployments d
           LEFT JOIN arena_transaction_proofs p
             ON p.transaction_hash = d.deployment_transaction_hash
            AND p.deployment_id = d.deployment_id
            AND p.proof_kind = 'DEPLOYMENT'
          WHERE ($1::text IS NULL OR d.deployment_id < $1::text)
          ORDER BY d.deployment_id DESC
          LIMIT $2::integer`,
        [cursor?.deploymentId || null, limit + 1],
      );
      return rows.map(publicDeployment);
    },

    async listEpochs({ cursor, deployment, limit }) {
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
          WHERE ($1::text IS NULL OR e.deployment_alias = $1::text)
            AND ($2::bigint IS NULL OR (e.epoch_end_timestamp, e.deployment_id)
                 < ($2::bigint, $3::text))
          ORDER BY e.epoch_end_timestamp DESC, e.deployment_id DESC
          LIMIT $4::integer`,
        [deployment, cursor?.epochEndTimestamp || null, cursor?.deploymentId || '', limit + 1],
      );
      return rows.map(publicEpoch);
    },

    async upsertDeployment(value) {
      const rows = await query(
        `WITH deactivated AS (
           UPDATE arena_deployments
              SET active = false, last_synced_at = now()
            WHERE $14::boolean = true
              AND deployment_alias = $2::text
              AND deployment_id <> $1::text
              AND active = true
         ), upserted AS (
           INSERT INTO arena_deployments (
             deployment_id, deployment_alias, network, chain_id, contract_address,
             protocol_version, policy_version, owner_address, keeper_address,
             treasury_address, deployment_transaction_hash, source_metadata,
             contract_config, asset_catalog, venue_catalog, active, last_synced_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::jsonb, $13::jsonb, $15::jsonb, $16::jsonb, $14, now()
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

    async hasEpoch(deploymentId, epochEndTimestamp) {
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
        `SELECT transaction_hash, deployment_id, proof_kind, status, verified_at
           FROM arena_transaction_proofs WHERE transaction_hash = $1`,
        [transactionHash],
      );
      return rows[0] || null;
    },

    async upsertProof(value) {
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

export { HISTORY_SCHEMA_CHECKSUM };
