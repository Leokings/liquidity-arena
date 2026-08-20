import { keeperJournalDatabaseUrl } from './config.mjs';
import { KeeperJournalError } from './errors.mjs';
import { publicKeeperOperation } from './schema.mjs';

export const KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM = 'd2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266';
export const KEEPER_JOURNAL_SCHEMA_CHECKSUM = '9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70';
const QUERY_TIMEOUT_MS = 8_000;
const LEASE_SCOPE = 'studionet:61999:keeper';

function databaseUnavailable(cause) {
  return new KeeperJournalError(
    'KEEPER_JOURNAL_DATABASE_UNAVAILABLE',
    'Keeper transaction journal database is unavailable.',
    { statusCode: 503, cause },
  );
}

function leaseRejected() {
  throw new KeeperJournalError(
    'KEEPER_JOURNAL_FENCE_REJECTED',
    'Keeper transaction journal mutation was rejected by the active signer fence.',
    { statusCode: 409 },
  );
}

function attemptFrozen() {
  throw new KeeperJournalError(
    'KEEPER_JOURNAL_ATTEMPT_FROZEN',
    'Keeper operation attempt is immutable after a retry has been prepared.',
    { statusCode: 409 },
  );
}

function databaseRow(value) {
  return value && typeof value === 'object' ? value : null;
}

export function createNeonKeeperJournalRepository({
  environment = process.env,
  importDriver = () => import('@neondatabase/serverless'),
} = {}) {
  const connectionString = keeperJournalDatabaseUrl(environment);
  const configured = Boolean(connectionString);
  let sqlPromise;

  async function sql() {
    if (!configured) {
      throw new KeeperJournalError(
        'KEEPER_JOURNAL_UNCONFIGURED',
        'Keeper transaction journal database is not configured.',
        { statusCode: 503 },
      );
    }
    sqlPromise ||= Promise.resolve(importDriver()).then((module) => {
      if (typeof module?.neon !== 'function') {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_DATABASE_DRIVER',
          'Keeper transaction journal database driver is unavailable.',
          { statusCode: 503 },
        );
      }
      return module.neon(connectionString);
    });
    return sqlPromise;
  }

  async function query(text, params = [], timeoutMs = QUERY_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const client = await sql();
      return await client.query(text, params, { fetchOptions: { signal: controller.signal } });
    } catch (error) {
      if (error instanceof KeeperJournalError) throw error;
      if (String(error?.code || '') === '23505') {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_UNRESOLVED_OPERATION',
          'The StudioNet keeper signer already has an unresolved operation.',
          { statusCode: 409, cause: error },
        );
      }
      if (controller.signal.aborted) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_DATABASE_TIMEOUT',
          'Keeper transaction journal database request timed out.',
          { statusCode: 503, cause: error },
        );
      }
      throw databaseUnavailable(error);
    } finally {
      clearTimeout(timer);
    }
  }

  function operationResult(row) {
    const operation = databaseRow(row?.operation);
    return operation ? publicKeeperOperation(operation) : null;
  }

  return Object.freeze({
    configured,

    async health() {
      if (!configured) return Object.freeze({ configured: false, ready: false, schemaVersion: null });
      const rows = await query(
        `SELECT
           to_regclass('public.arena_keeper_signer_leases') IS NOT NULL AS leases_exists,
           to_regclass('public.arena_keeper_operations') IS NOT NULL AS operations_exists,
           to_regclass('public.arena_keeper_journal_requests') IS NOT NULL AS requests_exists,
           to_regclass('public.arena_keeper_operation_conflicts') IS NOT NULL AS conflicts_exists,
           to_regprocedure('public.arena_guard_keeper_operation_update()') IS NOT NULL AS guard_function_exists,
           EXISTS (
             SELECT 1
               FROM pg_trigger
              WHERE tgrelid = 'public.arena_keeper_operations'::regclass
                AND tgname = 'arena_keeper_operations_guard_update'
                AND NOT tgisinternal
           ) AS guard_trigger_exists,
           to_regclass('public.arena_keeper_operations_logical_attempt_key') IS NOT NULL
             AS logical_attempt_key_exists,
           (
             SELECT count(*) = 4
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'arena_keeper_operations'
                AND column_name IN (
                  'logical_operation_id', 'attempt_number',
                  'retry_of_operation_id', 'retry_of_attempt_number'
                )
           ) AS attempt_columns_exist,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 2
                AND name = 'keeper_transaction_journal'
                AND schema_checksum = $1
           ) AS base_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 3
                AND name = 'keeper_transaction_journal_attempts'
                AND schema_checksum = $2
           ) AS migration_valid`,
        [KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM, KEEPER_JOURNAL_SCHEMA_CHECKSUM],
        3_000,
      );
      const row = rows[0] || {};
      const ready = row.leases_exists === true
        && row.operations_exists === true
        && row.requests_exists === true
        && row.conflicts_exists === true
        && row.guard_function_exists === true
        && row.guard_trigger_exists === true
        && row.logical_attempt_key_exists === true
        && row.attempt_columns_exist === true
        && row.base_migration_valid === true
        && row.migration_valid === true;
      return Object.freeze({ configured: true, ready, schemaVersion: ready ? 3 : null });
    },

    async claimRequest({ keyHash, requestHash, action }) {
      const rows = await query(
        `INSERT INTO arena_keeper_journal_requests (
           idempotency_key_hash, request_sha256, request_action
         ) VALUES ($1, $2, $3)
         ON CONFLICT (idempotency_key_hash) DO UPDATE SET last_seen_at = now()
          WHERE arena_keeper_journal_requests.request_sha256 = EXCLUDED.request_sha256
            AND arena_keeper_journal_requests.request_action = EXCLUDED.request_action
         RETURNING idempotency_key_hash`,
        [keyHash, requestHash, action],
      );
      if (rows.length !== 1) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used for a different keeper journal request.',
          { statusCode: 409 },
        );
      }
    },

    async acquireLease({ holderId, signerAddress, leaseSeconds }) {
      const rows = await query(
        `WITH acquired AS (
           INSERT INTO arena_keeper_signer_leases (
             lease_scope, network, chain_id, signer_address, holder_id,
             fencing_token, acquired_at, renewed_at, lease_expires_at, released_at
           ) VALUES (
             $1, 'studionet', 61999, $2, $3::uuid,
             1, now(), now(), now() + make_interval(secs => $4::integer), NULL
           )
           ON CONFLICT (lease_scope) DO UPDATE SET
             network = EXCLUDED.network,
             chain_id = EXCLUDED.chain_id,
             signer_address = EXCLUDED.signer_address,
             holder_id = EXCLUDED.holder_id,
             fencing_token = arena_keeper_signer_leases.fencing_token + 1,
             acquired_at = now(),
             renewed_at = now(),
             lease_expires_at = now() + make_interval(secs => $4::integer),
             released_at = NULL
           WHERE (arena_keeper_signer_leases.released_at IS NOT NULL
                  OR arena_keeper_signer_leases.lease_expires_at <= now())
             AND arena_keeper_signer_leases.fencing_token < 9223372036854775807
           RETURNING holder_id::text, signer_address, fencing_token::text, lease_expires_at
         ), owned AS (
           SELECT holder_id::text, signer_address, fencing_token::text, lease_expires_at
             FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND released_at IS NULL
              AND lease_expires_at > now()
         ), selected_lease AS (
           SELECT acquired.*, true AS newly_acquired FROM acquired
           UNION ALL
           SELECT owned.*, false AS newly_acquired FROM owned
            WHERE NOT EXISTS (SELECT 1 FROM acquired)
         ), fenced_operations AS (
           UPDATE arena_keeper_operations operation
              SET last_fencing_token = selected_lease.fencing_token::bigint
             FROM selected_lease
            WHERE operation.signer_address = selected_lease.signer_address
              AND operation.state IN (
                'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
                'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
              )
              AND operation.last_fencing_token < selected_lease.fencing_token::bigint
           RETURNING operation.operation_id
         )
         SELECT selected_lease.* FROM selected_lease
         LIMIT 1`,
        [LEASE_SCOPE, signerAddress, holderId, leaseSeconds],
      );
      if (rows.length !== 1) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_LEASE_BUSY',
          'The global StudioNet keeper signer lease is held by another run.',
          { statusCode: 409 },
        );
      }
      const row = rows[0];
      return Object.freeze({
        holderId: String(row.holder_id),
        signerAddress: String(row.signer_address),
        fencingToken: String(row.fencing_token),
        expiresAt: row.lease_expires_at,
        newlyAcquired: row.newly_acquired === true,
      });
    },

    async renewLease({ holderId, signerAddress, fencingToken, leaseSeconds }) {
      const rows = await query(
        `UPDATE arena_keeper_signer_leases
            SET renewed_at = now(),
                lease_expires_at = now() + make_interval(secs => $5::integer)
          WHERE lease_scope = $1
            AND signer_address = $2
            AND holder_id = $3::uuid
            AND fencing_token = $4::bigint
            AND released_at IS NULL
            AND lease_expires_at > now()
        RETURNING holder_id::text, signer_address, fencing_token::text, lease_expires_at`,
        [LEASE_SCOPE, signerAddress, holderId, fencingToken, leaseSeconds],
      );
      if (rows.length !== 1) leaseRejected();
      const row = rows[0];
      return Object.freeze({
        holderId: String(row.holder_id),
        signerAddress: String(row.signer_address),
        fencingToken: String(row.fencing_token),
        expiresAt: row.lease_expires_at,
      });
    },

    async releaseLease({ holderId, signerAddress, fencingToken }) {
      const rows = await query(
        `UPDATE arena_keeper_signer_leases
            SET renewed_at = now(),
                lease_expires_at = CASE WHEN released_at IS NULL THEN now() ELSE lease_expires_at END,
                released_at = COALESCE(released_at, now())
          WHERE lease_scope = $1
            AND signer_address = $2
            AND holder_id = $3::uuid
            AND fencing_token = $4::bigint
        RETURNING fencing_token::text`,
        [LEASE_SCOPE, signerAddress, holderId, fencingToken],
      );
      if (rows.length !== 1) leaseRejected();
      return Object.freeze({ released: true, fencingToken: String(rows[0].fencing_token) });
    },

    async prepare({ holderId, signerAddress, fencingToken, operation }) {
      const rows = await query(
         `WITH active AS (
           SELECT fencing_token
             FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND fencing_token = $4::bigint
              AND released_at IS NULL
              AND lease_expires_at > now()
            FOR UPDATE
         ), logical_latest AS (
           SELECT candidate.*
             FROM arena_keeper_operations candidate, active
            WHERE candidate.logical_operation_id = $5
            ORDER BY candidate.attempt_number DESC
            LIMIT 1
         ), exact_latest AS (
           SELECT candidate.*
             FROM logical_latest candidate
            WHERE candidate.deployment_alias = $6
              AND candidate.network = 'studionet'
              AND candidate.chain_id = 61999
              AND candidate.signer_address = $2
              AND candidate.contract_address = $7
              AND candidate.method = $8
              AND candidate.arguments = $9::jsonb
              AND candidate.value_atto = $10::numeric
              AND candidate.epoch_end_timestamp = $11::bigint
              AND candidate.canonical_operation = $12
         ), candidate_attempt AS (
           SELECT active.fencing_token,
                  COALESCE(exact_latest.attempt_number + 1, 1) AS attempt_number,
                  exact_latest.operation_id AS retry_of_operation_id,
                  exact_latest.attempt_number AS retry_of_attempt_number
             FROM active
             LEFT JOIN exact_latest ON true
            WHERE exact_latest.operation_id IS NULL
               OR exact_latest.state = 'FINALIZED_FAILURE'
         ), inserted AS (
           INSERT INTO arena_keeper_operations (
             operation_id, logical_operation_id, attempt_number,
             retry_of_operation_id, retry_of_attempt_number,
             deployment_alias, network, chain_id, signer_address,
             contract_address, method, arguments, value_atto, epoch_end_timestamp,
             canonical_operation, state, prepared_fencing_token, last_fencing_token
           )
           SELECT CASE
                    WHEN candidate_attempt.attempt_number = 1 THEN $5
                    ELSE encode(
                      sha256(convert_to(
                        $5 || ':' || candidate_attempt.attempt_number::text,
                        'UTF8'
                      )),
                      'hex'
                    )
                  END,
                  $5, candidate_attempt.attempt_number,
                  candidate_attempt.retry_of_operation_id,
                  candidate_attempt.retry_of_attempt_number,
                  $6, 'studionet', 61999, $2, $7, $8, $9::jsonb,
                  $10::numeric, $11::bigint, $12, 'PREPARED',
                  candidate_attempt.fencing_token, candidate_attempt.fencing_token
             FROM candidate_attempt
            WHERE NOT EXISTS (
              SELECT 1 FROM arena_keeper_operations blocker
               WHERE blocker.signer_address = $2
                 AND blocker.state IN (
                   'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
                   'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
                 )
            )
              AND (
                NOT EXISTS (SELECT 1 FROM logical_latest)
                OR EXISTS (SELECT 1 FROM exact_latest)
              )
           ON CONFLICT (operation_id) DO NOTHING
           RETURNING *
         ), selected AS (
           SELECT inserted.*, true AS inserted_now FROM inserted
           UNION ALL
           SELECT exact_latest.*, false AS inserted_now FROM exact_latest
            WHERE NOT EXISTS (SELECT 1 FROM inserted)
              AND exact_latest.state <> 'FINALIZED_FAILURE'
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (SELECT 1 FROM logical_latest) AS operation_exists,
           EXISTS (
             SELECT 1 FROM arena_keeper_operations blocker
              WHERE blocker.signer_address = $2
                AND blocker.state IN (
                  'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
                  'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
                )
           ) AS unresolved_blocked,
           (SELECT to_jsonb(selected)
                   || jsonb_build_object(
                     'chain_id', selected.chain_id::text,
                     'value_atto', selected.value_atto::text,
                     'epoch_end_timestamp', selected.epoch_end_timestamp::text,
                     'attempt_number', selected.attempt_number::text,
                     'prepared_fencing_token', selected.prepared_fencing_token::text,
                     'last_fencing_token', selected.last_fencing_token::text,
                     'revision', selected.revision::text
                   )
              FROM selected LIMIT 1) AS operation
        `,
        [
          LEASE_SCOPE,
          signerAddress,
          holderId,
          fencingToken,
          operation.operationId,
          operation.deploymentAlias,
          operation.contractAddress,
          operation.method,
          JSON.stringify(operation.args),
          operation.valueAtto,
          operation.epochEndTimestamp,
          operation.canonicalOperation,
        ],
      );
      const row = rows[0] || {};
      if (row.lease_valid !== true) leaseRejected();
      const operationRow = databaseRow(row.operation);
      if (!operationRow) {
        if (row.unresolved_blocked === true) {
          throw new KeeperJournalError(
            'KEEPER_JOURNAL_UNRESOLVED_OPERATION',
            'The StudioNet keeper signer already has an unresolved operation.',
            { statusCode: 409 },
          );
        }
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_OPERATION_CONFLICT',
          row.operation_exists === true
            ? 'Keeper operation identity conflicts with an existing canonical operation.'
            : 'Keeper operation could not be prepared.',
          { statusCode: 409 },
        );
      }
      const operationPublic = publicKeeperOperation(operationRow);
      return Object.freeze({
        operation: operationPublic,
        canBroadcast: operationRow.inserted_now === true
          && operationPublic.state === 'PREPARED'
          && operationPublic.transactionHash === null
          && String(operationRow.prepared_fencing_token) === String(fencingToken),
        inserted: operationRow.inserted_now === true,
      });
    },

    async bindSubmission({ holderId, signerAddress, fencingToken, operationId, transactionHash }) {
      const rows = await query(
        `WITH active AS (
           SELECT fencing_token
             FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND fencing_token = $4::bigint
              AND released_at IS NULL
              AND lease_expires_at > now()
            FOR UPDATE
         ), target AS (
           SELECT operation.*,
                  EXISTS (
                    SELECT 1 FROM arena_keeper_operations other
                     WHERE other.transaction_hash = $6
                       AND other.operation_id <> operation.operation_id
                  ) AS hash_bound_elsewhere
             FROM arena_keeper_operations operation, active
            WHERE operation.operation_id = $5
              AND NOT EXISTS (
                SELECT 1 FROM arena_keeper_operations later
                 WHERE later.logical_operation_id = operation.logical_operation_id
                   AND later.attempt_number > operation.attempt_number
              )
         ), updated AS (
           UPDATE arena_keeper_operations operation SET
             transaction_hash = CASE
               WHEN target.transaction_hash IS NULL AND NOT target.hash_bound_elsewhere THEN $6
               ELSE target.transaction_hash
             END,
             state = CASE
               WHEN target.hash_bound_elsewhere
                 OR (target.transaction_hash IS NOT NULL AND target.transaction_hash <> $6)
                 THEN 'QUARANTINED'
               WHEN target.state IN ('PREPARED', 'STATE_SATISFIED_UNPROVEN') THEN 'SUBMITTED'
               ELSE target.state
             END,
             lifecycle_status = CASE
               WHEN target.transaction_hash IS NULL AND NOT target.hash_bound_elsewhere
                 THEN COALESCE(target.lifecycle_status, 'UNKNOWN')
               ELSE target.lifecycle_status
             END,
             quarantine_reason = CASE
               WHEN target.hash_bound_elsewhere
                 OR (target.transaction_hash IS NOT NULL AND target.transaction_hash <> $6)
                 THEN 'SUBMISSION_HASH_CONFLICT'
               ELSE target.quarantine_reason
             END,
             last_fencing_token = active.fencing_token
           FROM target, active
           WHERE operation.operation_id = target.operation_id
           RETURNING operation.*
         ), conflict AS (
           INSERT INTO arena_keeper_operation_conflicts (
             operation_id, conflicting_transaction_hash, fencing_token
           )
           SELECT updated.operation_id, $6, $4::bigint
             FROM updated
            WHERE updated.quarantine_reason = 'SUBMISSION_HASH_CONFLICT'
           ON CONFLICT DO NOTHING
           RETURNING operation_id
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (SELECT 1 FROM arena_keeper_operations WHERE operation_id = $5) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                 ON later.logical_operation_id = operation.logical_operation_id
                AND later.attempt_number > operation.attempt_number
              WHERE operation.operation_id = $5
           ) AS attempt_frozen,
           EXISTS (SELECT 1 FROM conflict) AS hash_conflict,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
                     'epoch_end_timestamp', updated.epoch_end_timestamp::text,
                     'attempt_number', updated.attempt_number::text,
                     'prepared_fencing_token', updated.prepared_fencing_token::text,
                     'last_fencing_token', updated.last_fencing_token::text,
                     'revision', updated.revision::text
                   )
              FROM updated LIMIT 1) AS operation`,
        [LEASE_SCOPE, signerAddress, holderId, fencingToken, operationId, transactionHash],
      );
      const row = rows[0] || {};
      if (row.lease_valid !== true) leaseRejected();
      if (row.operation_exists !== true) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_OPERATION_NOT_FOUND',
          'Keeper operation was not found.',
          { statusCode: 404 },
        );
      }
      if (row.attempt_frozen === true) attemptFrozen();
      const operation = operationResult(row);
      if (!operation) leaseRejected();
      if (row.hash_conflict === true || operation.state === 'QUARANTINED') {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_HASH_CONFLICT',
          'A conflicting submission hash quarantined the keeper operation.',
          { statusCode: 409 },
        );
      }
      return operation;
    },

    async observeLifecycle({
      holderId, signerAddress, fencingToken, operationId, lifecycleStatus,
    }) {
      const rows = await query(
        `WITH active AS (
           SELECT fencing_token
             FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND fencing_token = $4::bigint
              AND released_at IS NULL
              AND lease_expires_at > now()
            FOR UPDATE
         ), target AS (
           SELECT operation.* FROM arena_keeper_operations operation, active
            WHERE operation.operation_id = $5
              AND NOT EXISTS (
                SELECT 1 FROM arena_keeper_operations later
                 WHERE later.logical_operation_id = operation.logical_operation_id
                   AND later.attempt_number > operation.attempt_number
              )
         ), updated AS (
           UPDATE arena_keeper_operations operation SET
             lifecycle_status = $6,
             last_fencing_token = active.fencing_token
           FROM target, active
           WHERE operation.operation_id = target.operation_id
             AND target.transaction_hash IS NOT NULL
             AND (target.lifecycle_status <> 'FINALIZED' OR $6 = 'FINALIZED')
           RETURNING operation.*
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (SELECT 1 FROM arena_keeper_operations WHERE operation_id = $5) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                 ON later.logical_operation_id = operation.logical_operation_id
                AND later.attempt_number > operation.attempt_number
              WHERE operation.operation_id = $5
           ) AS attempt_frozen,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
                     'epoch_end_timestamp', updated.epoch_end_timestamp::text,
                     'attempt_number', updated.attempt_number::text,
                     'prepared_fencing_token', updated.prepared_fencing_token::text,
                     'last_fencing_token', updated.last_fencing_token::text,
                     'revision', updated.revision::text
                   )
              FROM updated LIMIT 1) AS operation`,
        [LEASE_SCOPE, signerAddress, holderId, fencingToken, operationId, lifecycleStatus],
      );
      const row = rows[0] || {};
      if (row.lease_valid !== true) leaseRejected();
      if (row.operation_exists !== true) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_OPERATION_NOT_FOUND',
          'Keeper operation was not found.',
          { statusCode: 404 },
        );
      }
      if (row.attempt_frozen === true) attemptFrozen();
      const operation = operationResult(row);
      if (!operation) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_LIFECYCLE_CONFLICT',
          'Keeper lifecycle observation would regress or lacks a submission hash.',
          { statusCode: 409 },
        );
      }
      return operation;
    },

    async transition({
      holderId,
      signerAddress,
      fencingToken,
      operationId,
      targetState,
      reasonCode,
      metadata,
    }) {
      const allowed = Object.freeze({
        FINALIZED_SUCCESS: ['SUBMITTED', 'FINALIZED_SUCCESS'],
        VERIFIED: ['FINALIZED_SUCCESS', 'VERIFIED'],
        FINALIZED_FAILURE: ['SUBMITTED', 'FINALIZED_FAILURE'],
        STATE_SATISFIED_UNPROVEN: ['PREPARED', 'SUBMITTED', 'STATE_SATISFIED_UNPROVEN'],
        QUARANTINED: [
          'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
          'STATE_SATISFIED_UNPROVEN', 'QUARANTINED',
        ],
      })[targetState];
      const rows = await query(
        `WITH active AS (
           SELECT fencing_token
             FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND fencing_token = $4::bigint
              AND released_at IS NULL
              AND lease_expires_at > now()
            FOR UPDATE
         ), metadata_shape AS (
           SELECT $8::jsonb AS transition_metadata,
                  (SELECT count(*) FROM jsonb_object_keys($8::jsonb)) AS metadata_key_count
         ), target AS (
           SELECT operation.*,
                  metadata_shape.transition_metadata,
                  metadata_shape.metadata_key_count
             FROM arena_keeper_operations operation, active, metadata_shape
            WHERE operation.operation_id = $5
              AND NOT EXISTS (
                SELECT 1 FROM arena_keeper_operations later
                 WHERE later.logical_operation_id = operation.logical_operation_id
                   AND later.attempt_number > operation.attempt_number
              )
         ), updated AS (
           UPDATE arena_keeper_operations operation SET
             state = $6,
             lifecycle_status = CASE
               WHEN $6 IN ('FINALIZED_SUCCESS', 'FINALIZED_FAILURE') THEN 'FINALIZED'
               ELSE target.lifecycle_status
             END,
             finality_metadata = CASE
               WHEN target.state = $6 THEN target.finality_metadata
               WHEN $6 IN ('FINALIZED_SUCCESS', 'FINALIZED_FAILURE', 'QUARANTINED')
                 THEN target.transition_metadata
               ELSE target.finality_metadata
             END,
             verification_metadata = CASE
               WHEN target.state = $6 THEN target.verification_metadata
               WHEN $6 IN ('VERIFIED', 'STATE_SATISFIED_UNPROVEN')
                 THEN target.transition_metadata
               ELSE target.verification_metadata
             END,
             state_reason_code = CASE WHEN target.state = $6 THEN target.state_reason_code ELSE $7 END,
             quarantine_reason = CASE
               WHEN target.state = $6 THEN target.quarantine_reason
               WHEN $6 = 'QUARANTINED' THEN $7
               ELSE target.quarantine_reason
             END,
             last_fencing_token = active.fencing_token
           FROM target, active
           WHERE operation.operation_id = target.operation_id
             AND target.state = ANY($9::text[])
             AND ($6 NOT IN ('FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE')
                  OR target.transaction_hash IS NOT NULL)
             AND ($6 <> 'FINALIZED_SUCCESS' OR (
               target.lifecycle_status = 'FINALIZED'
               AND target.metadata_key_count = 4
               AND target.transition_metadata ->> 'transactionHash' = target.transaction_hash
               AND target.transition_metadata ->> 'lifecycleStatus' = 'FINALIZED'
               AND target.transition_metadata
                 @> '{"receiptIdentityVerified":true,"executionVerified":true}'::jsonb
             ))
             AND ($6 <> 'FINALIZED_FAILURE' OR (
               target.lifecycle_status = 'FINALIZED'
               AND target.metadata_key_count = 5
               AND target.transition_metadata ->> 'transactionHash' = target.transaction_hash
               AND target.transition_metadata ->> 'lifecycleStatus' = 'FINALIZED'
               AND target.transition_metadata
                 @> '{"receiptIdentityVerified":true,"executionVerified":true,"executionSucceeded":false}'::jsonb
             ))
             AND ($6 <> 'VERIFIED' OR (
               target.metadata_key_count = 3
               AND target.transition_metadata ->> 'transactionHash' = target.transaction_hash
               AND target.transition_metadata @> '{"postStateVerified":true}'::jsonb
               AND target.transition_metadata ->> 'postStateStatus' ~ '^[A-Z][A-Z0-9_]{0,79}$'
             ))
             AND ($6 <> 'STATE_SATISFIED_UNPROVEN' OR (
               target.metadata_key_count = 2
               AND target.transition_metadata @> '{"postStateVerified":true}'::jsonb
               AND target.transition_metadata ->> 'postStateStatus' ~ '^[A-Z][A-Z0-9_]{0,79}$'
             ))
             AND ($6 <> 'QUARANTINED' OR (
               target.lifecycle_status = 'FINALIZED'
               AND target.transaction_hash IS NOT NULL
               AND target.metadata_key_count = 4
               AND target.transition_metadata ->> 'transactionHash' = target.transaction_hash
               AND target.transition_metadata ->> 'lifecycleStatus' = 'FINALIZED'
               AND target.transition_metadata @> '{"receiptIdentityVerified":false}'::jsonb
               AND target.transition_metadata ->> 'ambiguityCode' = $7
               AND $7 = ANY(ARRAY[
                 'RECEIPT_HASH_MISMATCH',
                 'RECEIPT_CONTRACT_MISMATCH',
                 'RECEIPT_METHOD_MISMATCH',
                 'RECEIPT_ARGUMENTS_MISMATCH',
                 'RECEIPT_IDENTITY_AMBIGUOUS'
               ]::text[])
             ))
           RETURNING operation.*
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (SELECT 1 FROM arena_keeper_operations WHERE operation_id = $5) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                 ON later.logical_operation_id = operation.logical_operation_id
                AND later.attempt_number > operation.attempt_number
              WHERE operation.operation_id = $5
           ) AS attempt_frozen,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
                     'epoch_end_timestamp', updated.epoch_end_timestamp::text,
                     'attempt_number', updated.attempt_number::text,
                     'prepared_fencing_token', updated.prepared_fencing_token::text,
                     'last_fencing_token', updated.last_fencing_token::text,
                     'revision', updated.revision::text
                   )
              FROM updated LIMIT 1) AS operation`,
        [
          LEASE_SCOPE,
          signerAddress,
          holderId,
          fencingToken,
          operationId,
          targetState,
          reasonCode,
          JSON.stringify(metadata),
          allowed,
        ],
      );
      const row = rows[0] || {};
      if (row.lease_valid !== true) leaseRejected();
      if (row.operation_exists !== true) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_OPERATION_NOT_FOUND',
          'Keeper operation was not found.',
          { statusCode: 404 },
        );
      }
      if (row.attempt_frozen === true) attemptFrozen();
      const operation = operationResult(row);
      if (!operation) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_TRANSITION_CONFLICT',
          'Keeper operation state transition is not allowed.',
          { statusCode: 409 },
        );
      }
      return operation;
    },

    async recover({ holderId, signerAddress, fencingToken, cursor, limit }) {
      const rows = await query(
        `WITH active AS (
           SELECT 1
             FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND fencing_token = $4::bigint
              AND released_at IS NULL
              AND lease_expires_at > now()
         )
         SELECT operation.*
           FROM arena_keeper_operations operation, active
          WHERE operation.signer_address = $2
            AND operation.state IN (
              'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
              'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
            )
            AND ($5::timestamptz IS NULL
                 OR (operation.prepared_at, operation.operation_id) > ($5::timestamptz, $6::text))
          ORDER BY operation.prepared_at, operation.operation_id
          LIMIT $7::integer`,
        [
          LEASE_SCOPE,
          signerAddress,
          holderId,
          fencingToken,
          cursor?.preparedAt || null,
          cursor?.operationId || '',
          limit + 1,
        ],
      );
      // A stale fence and an empty recovery page are intentionally distinct.
      if (rows.length === 0) {
        const leaseRows = await query(
          `SELECT 1 FROM arena_keeper_signer_leases
            WHERE lease_scope = $1
              AND signer_address = $2
              AND holder_id = $3::uuid
              AND fencing_token = $4::bigint
              AND released_at IS NULL
              AND lease_expires_at > now()`,
          [LEASE_SCOPE, signerAddress, holderId, fencingToken],
        );
        if (leaseRows.length !== 1) leaseRejected();
      }
      return Object.freeze(rows.map(publicKeeperOperation));
    },
  });
}
