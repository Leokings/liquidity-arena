import { keeperJournalDatabaseUrl } from './config.mjs';
import { KeeperJournalError } from './errors.mjs';
import { publicKeeperOperation } from './schema.mjs';

export const KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM = 'd2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266';
export const KEEPER_JOURNAL_SCHEMA_CHECKSUM = '9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70';
export const KEEPER_JOURNAL_SCHEMA_V4_CHECKSUM = '1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910';
export const KEEPER_JOURNAL_SCHEMA_V5_CHECKSUM = 'a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59';
export const KEEPER_JOURNAL_SCHEMA_V6_CHECKSUM = '5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf';
export const KEEPER_JOURNAL_SCHEMA_V7_CHECKSUM = '4fa4e8103a1b3caa7022cff2ea1b4868ea6128a4f6b359cdb93a8a6320e0a8f3';
export const KEEPER_JOURNAL_SCHEMA_V8_CHECKSUM = '030604d61f54ad9f6e388f497723d7eaa7118632866574cff976dd0bd43f680a';
export const KEEPER_JOURNAL_MAX_PIPELINE_DEPTH = 2;
const QUERY_TIMEOUT_MS = 8_000;
const LEASE_SCOPE = 'bradbury:4221:keeper';

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
          'The Bradbury keeper signer already has an unresolved operation.',
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
           EXISTS (
             SELECT 1
               FROM pg_constraint request_action_constraint
              WHERE request_action_constraint.conrelid =
                    'public.arena_keeper_journal_requests'::regclass
                AND request_action_constraint.conname =
                    'arena_keeper_journal_requests_request_action_check'
                AND position(
                  '''ABANDON_PREHASH''' IN pg_get_constraintdef(request_action_constraint.oid)
                ) > 0
                AND position(
                  '''ACCEPT_HANDOFF''' IN pg_get_constraintdef(request_action_constraint.oid)
                ) > 0
           ) AS request_action_constraint_valid,
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
           to_regclass('public.arena_keeper_operations_pipeline_slot_v6_idx') IS NOT NULL
             AS pipeline_slot_index_exists,
           to_regclass('public.arena_keeper_operations_attention_subject_v6_idx') IS NOT NULL
             AS attention_subject_index_exists,
           to_regclass('public.arena_keeper_operations_handoff_predecessor_v6_idx') IS NOT NULL
             AS handoff_predecessor_index_exists,
           to_regclass('public.arena_keeper_operations_attention_v6_idx') IS NOT NULL
             AS attention_index_exists,
           to_regclass('public.arena_keeper_operations_one_unresolved_signer_idx') IS NULL
             AS legacy_unresolved_index_absent,
           to_regprocedure('public.arena_guard_keeper_accepted_handoff()') IS NOT NULL
             AS accepted_guard_function_exists,
           EXISTS (
             SELECT 1
               FROM pg_trigger
              WHERE tgrelid = 'public.arena_keeper_operations'::regclass
                AND tgname = 'arena_keeper_operations_guard_accepted_handoff'
                AND NOT tgisinternal
           ) AS accepted_guard_trigger_exists,
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
            (
              SELECT count(*) = 2
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'arena_keeper_operations'
                 AND column_name IN ('subject_type', 'subject_id')
            ) AS subject_columns_exist,
            (
              SELECT count(*) = 5
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'arena_keeper_operations'
                 AND column_name IN (
                   'pipeline_slot', 'handoff_predecessor_operation_id',
                   'accepted_at', 'acceptance_revalidated_at', 'acceptance_metadata'
                 )
            ) AS accepted_handoff_columns_exist,
            (
              SELECT count(*) = 4
                FROM pg_constraint
               WHERE conrelid = 'public.arena_keeper_operations'::regclass
                 AND conname IN (
                   'arena_keeper_operations_pipeline_slot_v6_check',
                   'arena_keeper_operations_attention_slot_v6_check',
                   'arena_keeper_operations_handoff_predecessor_v6_fk',
                   'arena_keeper_operations_acceptance_evidence_v6_check'
                 )
            ) AS accepted_handoff_constraints_exist,
            (
              SELECT count(*) = 2
                FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'arena_keeper_operations'
                 AND column_name IN (
                   'prehash_abandoned_at', 'prehash_abandonment_metadata'
                 )
            ) AS prehash_abandonment_columns_exist,
            (
              SELECT count(*) = 3
                FROM pg_constraint
               WHERE conrelid = 'public.arena_keeper_operations'::regclass
                 AND conname IN (
                   'arena_keeper_operations_state_v7_check',
                   'arena_keeper_operations_submission_v7_check',
                   'arena_keeper_operations_prehash_abandonment_v7_check'
                 )
            ) AS prehash_abandonment_constraints_exist,
           NOT EXISTS (
             SELECT 1
               FROM pg_constraint
              WHERE conrelid = 'public.arena_keeper_operations'::regclass
                AND conname = 'arena_keeper_operations_check3'
           ) AS legacy_prehash_submission_constraint_absent,
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
           ) AS attempt_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 4
                AND name = 'bradbury_v8_cutover'
                AND schema_checksum = $3
           ) AS v4_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 5
                AND name = 'keeper_receipt_identity_revalidation'
                AND schema_checksum = $4
           ) AS v5_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 6
                AND name = 'keeper_accepted_handoff'
                AND schema_checksum = $5
           ) AS v6_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 7
                AND name = 'keeper_prehash_abandonment'
                AND schema_checksum = $6
           ) AS v7_migration_valid,
           EXISTS (
             SELECT 1 FROM arena_schema_migrations
              WHERE version = 8
                AND name = 'keeper_prehash_legacy_constraint_cleanup'
                AND schema_checksum = $7
           ) AS migration_valid,
           NOT EXISTS (
             SELECT 1 FROM arena_schema_migrations WHERE version > 8
           ) AS no_unknown_migrations`,
        [
          KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V4_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V5_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V6_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V7_CHECKSUM,
          KEEPER_JOURNAL_SCHEMA_V8_CHECKSUM,
        ],
        3_000,
      );
      const row = rows[0] || {};
      const ready = row.leases_exists === true
        && row.operations_exists === true
        && row.requests_exists === true
        && row.conflicts_exists === true
        && row.request_action_constraint_valid === true
        && row.guard_function_exists === true
        && row.guard_trigger_exists === true
        && row.logical_attempt_key_exists === true
        && row.pipeline_slot_index_exists === true
        && row.attention_subject_index_exists === true
        && row.handoff_predecessor_index_exists === true
        && row.attention_index_exists === true
        && row.legacy_unresolved_index_absent === true
        && row.accepted_guard_function_exists === true
        && row.accepted_guard_trigger_exists === true
        && row.attempt_columns_exist === true
        && row.subject_columns_exist === true
        && row.accepted_handoff_columns_exist === true
        && row.accepted_handoff_constraints_exist === true
        && row.prehash_abandonment_columns_exist === true
        && row.prehash_abandonment_constraints_exist === true
        && row.legacy_prehash_submission_constraint_absent === true
        && row.base_migration_valid === true
        && row.attempt_migration_valid === true
        && row.v4_migration_valid === true
        && row.v5_migration_valid === true
        && row.v6_migration_valid === true
        && row.v7_migration_valid === true
        && row.migration_valid === true
        && row.no_unknown_migrations === true;
      return Object.freeze({ configured: true, ready, schemaVersion: ready ? 8 : null });
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
             $1, 'bradbury', 4221, $2, $3::uuid,
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
               AND operation.deployment_alias = 'v8'
               AND operation.network = 'bradbury'
               AND operation.chain_id = 4221
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
          'The global Bradbury keeper signer lease is held by another run.',
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
              AND candidate.network = 'bradbury'
              AND candidate.chain_id = 4221
              AND candidate.signer_address = $2
              AND candidate.contract_address = $7
              AND candidate.method = $8
              AND candidate.arguments = $9::jsonb
              AND candidate.value_atto = $10::numeric
              AND candidate.subject_type = $11
              AND candidate.subject_id = $12
              AND candidate.epoch_end_timestamp IS NOT DISTINCT FROM CASE
                    WHEN $11 = 'epoch' THEN $12::bigint ELSE NULL
                  END
              AND candidate.canonical_operation = $13
         ), attention AS MATERIALIZED (
           SELECT candidate.*
             FROM arena_keeper_operations candidate, active
            WHERE candidate.signer_address = $2
              AND candidate.deployment_alias = 'v8'
              AND candidate.network = 'bradbury'
              AND candidate.chain_id = 4221
              AND candidate.state IN (
                'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
                'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
              )
         ), candidate_attempt AS (
           SELECT active.fencing_token,
                  COALESCE(exact_latest.attempt_number + 1, 1) AS attempt_number,
                  exact_latest.operation_id AS retry_of_operation_id,
                  exact_latest.attempt_number AS retry_of_attempt_number,
                  (
                    SELECT available.slot
                      FROM generate_series(0, 1) AS available(slot)
                     WHERE NOT EXISTS (
                       SELECT 1 FROM attention occupied
                        WHERE occupied.pipeline_slot = available.slot
                     )
                     ORDER BY available.slot
                     LIMIT 1
                  )::smallint AS pipeline_slot,
                  CASE WHEN (SELECT count(*) FROM attention) = 1
                    THEN (SELECT operation_id FROM attention LIMIT 1)
                    ELSE NULL
                  END AS handoff_predecessor_operation_id
             FROM active
             LEFT JOIN exact_latest ON true
             WHERE (
               exact_latest.operation_id IS NULL
                OR exact_latest.state = 'FINALIZED_FAILURE'
                OR (
                  exact_latest.state = 'ABANDONED_PREHASH'
                  AND exact_latest.attempt_number = 1
                )
                OR (
                  exact_latest.state = 'VERIFIED'
                  AND exact_latest.method IN ('retry_prepare_payout', 'retry_payout')
                )
               )
               AND (SELECT count(*) FROM attention) < 2
               AND NOT EXISTS (
                 SELECT 1 FROM attention duplicate_subject
                  WHERE duplicate_subject.contract_address = $7
                    AND duplicate_subject.subject_type = $11
                    AND duplicate_subject.subject_id = $12
               )
               AND (
                 NOT EXISTS (SELECT 1 FROM attention)
                 OR (
                   (SELECT count(*) FROM attention) = 1
                   AND EXISTS (
                     SELECT 1
                       FROM attention predecessor
                       LEFT JOIN arena_keeper_operations predecessor_parent
                         ON predecessor_parent.operation_id = predecessor.handoff_predecessor_operation_id
                      WHERE predecessor.state = 'SUBMITTED'
                        AND predecessor.lifecycle_status = 'ACCEPTED'
                        AND predecessor.acceptance_revalidated_at >= now() - interval '2 minutes'
                        AND predecessor.acceptance_metadata = jsonb_build_object(
                          'transactionHash', predecessor.transaction_hash,
                          'contractAddress', predecessor.contract_address,
                          'recipient', predecessor.contract_address,
                          'method', predecessor.method,
                          'arguments', predecessor.arguments,
                          'lifecycleStatus', 'ACCEPTED',
                          'txExecutionResultName', 'FINISHED_WITH_RETURN',
                          'receiptIdentityVerified', true,
                          'executionVerified', true,
                          'executionSucceeded', true
                        )
                        AND (
                          predecessor.handoff_predecessor_operation_id IS NULL
                          OR predecessor_parent.state = 'VERIFIED'
                        )
                   )
                 )
               )
         ), inserted AS (
           INSERT INTO arena_keeper_operations (
             operation_id, logical_operation_id, attempt_number,
             retry_of_operation_id, retry_of_attempt_number,
             deployment_alias, network, chain_id, signer_address,
             contract_address, method, arguments, value_atto,
             epoch_end_timestamp, subject_type, subject_id,
             canonical_operation, state, prepared_fencing_token, last_fencing_token,
             pipeline_slot, handoff_predecessor_operation_id
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
                  $6, 'bradbury', 4221, $2, $7, $8, $9::jsonb,
                  $10::numeric,
                  CASE WHEN $11 = 'epoch' THEN $12::bigint ELSE NULL END,
                  $11, $12, $13, 'PREPARED',
                  candidate_attempt.fencing_token, candidate_attempt.fencing_token,
                  candidate_attempt.pipeline_slot,
                  candidate_attempt.handoff_predecessor_operation_id
             FROM candidate_attempt
            WHERE (
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
              AND exact_latest.state NOT IN ('FINALIZED_FAILURE', 'ABANDONED_PREHASH')
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (SELECT 1 FROM logical_latest) AS operation_exists,
           (SELECT count(*) FROM attention) >= 2 AS pipeline_full,
           EXISTS (
             SELECT 1 FROM attention duplicate_subject
              WHERE duplicate_subject.contract_address = $7
                AND duplicate_subject.subject_type = $11
                AND duplicate_subject.subject_id = $12
           ) AS subject_blocked,
           EXISTS (
             SELECT 1 FROM attention blocker
              LEFT JOIN arena_keeper_operations blocker_parent
                ON blocker_parent.operation_id = blocker.handoff_predecessor_operation_id
             WHERE blocker.state <> 'SUBMITTED'
                OR blocker.lifecycle_status <> 'ACCEPTED'
                OR blocker.acceptance_revalidated_at < now() - interval '2 minutes'
                OR blocker.acceptance_metadata IS NULL
                OR (
                  blocker.handoff_predecessor_operation_id IS NOT NULL
                  AND blocker_parent.state <> 'VERIFIED'
                )
           ) AS unresolved_blocked,
           (SELECT to_jsonb(selected)
                   || jsonb_build_object(
                     'chain_id', selected.chain_id::text,
                     'value_atto', selected.value_atto::text,
                     'attempt_number', selected.attempt_number::text,
                     'prepared_fencing_token', selected.prepared_fencing_token::text,
                     'last_fencing_token', selected.last_fencing_token::text,
                     'revision', selected.revision::text
                   )
              FROM selected LIMIT 1) AS operation
          ,(SELECT parent.prehash_abandonment_metadata ->> 'nonceAtStart'
              FROM selected
              JOIN arena_keeper_operations parent
                ON parent.operation_id = selected.retry_of_operation_id
             WHERE selected.inserted_now = true
               AND selected.attempt_number = 2
               AND parent.state = 'ABANDONED_PREHASH'
               AND parent.state_reason_code = 'AUDITED_NO_BROADCAST'
             LIMIT 1) AS audited_retry_nonce
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
          operation.subjectType,
          operation.subjectId,
          operation.canonicalOperation,
        ],
      );
      const row = rows[0] || {};
      if (row.lease_valid !== true) leaseRejected();
      const operationRow = databaseRow(row.operation);
      if (!operationRow) {
        if (row.pipeline_full === true) {
          throw new KeeperJournalError(
            'KEEPER_JOURNAL_IN_FLIGHT_LIMIT',
            'The Bradbury keeper signer pipeline already has two in-flight operations.',
            { statusCode: 409 },
          );
        }
        if (row.subject_blocked === true) {
          throw new KeeperJournalError(
            'KEEPER_JOURNAL_SUBJECT_IN_FLIGHT',
            'The Bradbury keeper already has an unresolved operation for this subject.',
            { statusCode: 409 },
          );
        }
        if (row.unresolved_blocked === true) {
          throw new KeeperJournalError(
            'KEEPER_JOURNAL_UNRESOLVED_OPERATION',
            'The Bradbury keeper signer already has an unresolved operation.',
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
      const canBroadcast = operationRow.inserted_now === true
        && operationPublic.state === 'PREPARED'
        && operationPublic.transactionHash === null
        && String(operationRow.prepared_fencing_token) === String(fencingToken);
      const auditedRetryNonce = row.audited_retry_nonce == null
        ? null
        : String(row.audited_retry_nonce);
      if (auditedRetryNonce !== null
          && (!/^(?:0|[1-9]\d*)$/.test(auditedRetryNonce)
            || operationPublic.attemptNumber !== '2' || canBroadcast !== true)) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_DATABASE_SHAPE',
          'Keeper journal returned an invalid audited retry nonce.',
          { statusCode: 503 },
        );
      }
      return Object.freeze({
        operation: operationPublic,
        canBroadcast,
        inserted: operationRow.inserted_now === true,
        auditedRetryNonce,
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
               AND operation.signer_address = $2
               AND operation.deployment_alias = 'v8'
               AND operation.network = 'bradbury'
               AND operation.chain_id = 4221
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
            EXISTS (
              SELECT 1 FROM arena_keeper_operations
               WHERE operation_id = $5
                 AND signer_address = $2
                 AND deployment_alias = 'v8'
                 AND network = 'bradbury'
                 AND chain_id = 4221
            ) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                  ON later.logical_operation_id = operation.logical_operation_id
                 AND later.attempt_number > operation.attempt_number
               WHERE operation.operation_id = $5
                 AND operation.signer_address = $2
                 AND operation.deployment_alias = 'v8'
                 AND operation.network = 'bradbury'
                 AND operation.chain_id = 4221
            ) AS attempt_frozen,
           EXISTS (SELECT 1 FROM conflict) AS hash_conflict,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
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
               AND operation.signer_address = $2
               AND operation.deployment_alias = 'v8'
               AND operation.network = 'bradbury'
               AND operation.chain_id = 4221
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
            EXISTS (
              SELECT 1 FROM arena_keeper_operations
               WHERE operation_id = $5
                 AND signer_address = $2
                 AND deployment_alias = 'v8'
                 AND network = 'bradbury'
                 AND chain_id = 4221
            ) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                  ON later.logical_operation_id = operation.logical_operation_id
                 AND later.attempt_number > operation.attempt_number
               WHERE operation.operation_id = $5
                 AND operation.signer_address = $2
                 AND operation.deployment_alias = 'v8'
                 AND operation.network = 'bradbury'
                 AND operation.chain_id = 4221
            ) AS attempt_frozen,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
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

    async acceptHandoff({
      holderId, signerAddress, fencingToken, operationId, acceptanceEvidence,
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
              AND operation.signer_address = $2
              AND operation.deployment_alias = 'v8'
              AND operation.network = 'bradbury'
              AND operation.chain_id = 4221
              AND NOT EXISTS (
                SELECT 1 FROM arena_keeper_operations later
                 WHERE later.logical_operation_id = operation.logical_operation_id
                   AND later.attempt_number > operation.attempt_number
              )
         ), updated AS (
           UPDATE arena_keeper_operations operation SET
             lifecycle_status = 'ACCEPTED',
             accepted_at = COALESCE(target.accepted_at, clock_timestamp()),
             acceptance_revalidated_at = clock_timestamp(),
             acceptance_metadata = $6::jsonb,
             last_fencing_token = active.fencing_token
           FROM target, active
           WHERE operation.operation_id = target.operation_id
             AND target.state = 'SUBMITTED'
             AND target.transaction_hash = $6::jsonb ->> 'transactionHash'
             AND $6::jsonb = jsonb_build_object(
               'transactionHash', target.transaction_hash,
               'contractAddress', target.contract_address,
               'recipient', target.contract_address,
               'method', target.method,
               'arguments', target.arguments,
               'lifecycleStatus', 'ACCEPTED',
               'txExecutionResultName', 'FINISHED_WITH_RETURN',
               'receiptIdentityVerified', true,
               'executionVerified', true,
               'executionSucceeded', true
             )
           RETURNING operation.*
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (
             SELECT 1 FROM arena_keeper_operations
              WHERE operation_id = $5
                AND signer_address = $2
                AND deployment_alias = 'v8'
                AND network = 'bradbury'
                AND chain_id = 4221
           ) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                 ON later.logical_operation_id = operation.logical_operation_id
                AND later.attempt_number > operation.attempt_number
              WHERE operation.operation_id = $5
                AND operation.signer_address = $2
                AND operation.deployment_alias = 'v8'
                AND operation.network = 'bradbury'
                AND operation.chain_id = 4221
           ) AS attempt_frozen,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
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
          JSON.stringify(acceptanceEvidence),
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
      if (!operation || operation.lifecycleStatus !== 'ACCEPTED'
          || operation.acceptedAt === null) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_ACCEPTANCE_CONFLICT',
          'Keeper ACCEPTED handoff evidence was rejected.',
          { statusCode: 409 },
        );
      }
      return operation;
    },

    async abandonPrehash({
      holderId,
      signerAddress,
      fencingToken,
      operationId,
      reasonCode,
      evidence,
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
           SELECT operation.*
             FROM arena_keeper_operations operation, active
            WHERE operation.operation_id = $5
              AND operation.signer_address = $2
              AND operation.deployment_alias = 'v8'
              AND operation.network = 'bradbury'
              AND operation.chain_id = 4221
              AND NOT EXISTS (
                SELECT 1 FROM arena_keeper_operations later
                 WHERE later.logical_operation_id = operation.logical_operation_id
                   AND later.attempt_number > operation.attempt_number
              )
            FOR UPDATE OF operation
         ), updated AS (
           UPDATE arena_keeper_operations operation SET
             state = 'ABANDONED_PREHASH',
             state_reason_code = $6,
             prehash_abandoned_at = COALESCE(target.prehash_abandoned_at, now()),
             prehash_abandonment_metadata = $7::jsonb,
             last_fencing_token = active.fencing_token
           FROM target, active
           WHERE operation.operation_id = target.operation_id
             AND target.transaction_hash IS NULL
             AND target.submitted_at IS NULL
             AND target.lifecycle_status IS NULL
             AND target.lifecycle_observed_at IS NULL
             AND target.accepted_at IS NULL
             AND target.acceptance_revalidated_at IS NULL
             AND target.acceptance_metadata IS NULL
             AND (
               target.state = 'PREPARED'
               OR (
                 target.state = 'ABANDONED_PREHASH'
                 AND target.state_reason_code = $6
                 AND target.prehash_abandonment_metadata = $7::jsonb
               )
             )
             AND (
               (
                 $6 = 'DEFINITE_LOCAL_PRESPAWN_FAILURE'
                 AND $7::jsonb ->> 'evidenceVersion' = 'LOCAL_PRESPAWN_FAILURE_V1'
                 AND $7::jsonb @> '{"broadcastAttempted":false,"transactionHashObserved":false,"lowerLevelErrorRetained":true}'::jsonb
                 AND $7::jsonb ->> 'operationId' = target.operation_id
                 AND $7::jsonb ->> 'logicalOperationId' = target.logical_operation_id
                 AND $7::jsonb ->> 'contractAddress' = target.contract_address
                 AND $7::jsonb ->> 'method' = target.method
                 AND $7::jsonb -> 'arguments' = target.arguments
                 AND $7::jsonb ->> 'subjectType' = target.subject_type
                 AND $7::jsonb ->> 'subjectId' = target.subject_id
                 AND ($7::jsonb ->> 'preparedAt')::timestamptz = target.prepared_at
               )
               OR (
                 $6 = 'AUDITED_NO_BROADCAST'
                 AND $7::jsonb ->> 'evidenceVersion' = 'BRADBURY_KEEPER_EVM_SCAN_V1'
                 AND $7::jsonb ->> 'network' = 'bradbury'
                 AND $7::jsonb ->> 'chainId' = '4221'
                 AND target.method = 'resolve_epoch'
                 AND target.subject_type = 'epoch'
                 AND $7::jsonb ->> 'signerAddress' = target.signer_address
                 AND $7::jsonb ->> 'operationId' = target.operation_id
                 AND $7::jsonb ->> 'logicalOperationId' = target.logical_operation_id
                 AND $7::jsonb ->> 'contractAddress' = target.contract_address
                 AND $7::jsonb ->> 'method' = target.method
                 AND $7::jsonb -> 'arguments' = target.arguments
                 AND $7::jsonb ->> 'subjectType' = target.subject_type
                 AND $7::jsonb ->> 'subjectId' = target.subject_id
                 AND ($7::jsonb ->> 'preparedAt')::timestamptz = target.prepared_at
                 AND $7::jsonb ->> 'referenceOuterSender' = target.signer_address
                 AND $7::jsonb ->> 'referenceCallSender' = target.signer_address
                 AND $7::jsonb ->> 'referenceCallRecipient' = target.contract_address
                 AND $7::jsonb ->> 'referenceConsensusRecipient' = '0x0112bf6e83497965a5fdd6dad1e447a6e004271d'
                 AND $7::jsonb ->> 'matchingOuterTransactions' = '0'
                 AND $7::jsonb ->> 'nonceAtStart' = $7::jsonb ->> 'nonceAtEnd'
                 AND $7::jsonb ->> 'nonceAtStart' = $7::jsonb ->> 'latestNonce'
                 AND $7::jsonb ->> 'nonceAtStart' = $7::jsonb ->> 'pendingNonce'
                 AND ($7::jsonb ->> 'referenceOuterNonce')::numeric + 1
                   = ($7::jsonb ->> 'nonceAtStart')::numeric
                 AND ($7::jsonb ->> 'scanStartTimestamp')::timestamptz
                   <= ($7::jsonb ->> 'preparedAt')::timestamptz
                 AND ($7::jsonb ->> 'preparedAt')::timestamptz
                   <= ($7::jsonb ->> 'failedAt')::timestamptz
                 AND ($7::jsonb ->> 'failedAt')::timestamptz
                   <= ($7::jsonb ->> 'scanEndTimestamp')::timestamptz
                 AND ($7::jsonb ->> 'scanEndTimestamp')::timestamptz
                   <= ($7::jsonb ->> 'auditedAt')::timestamptz
                 AND $7::jsonb ->> 'postStateStatus' = 'TARGET_STATE_UNCHANGED'
                 AND $7::jsonb @> '{"transactionHashObserved":false,"lowerLevelErrorRetained":false,"postStateVerified":true}'::jsonb
               )
             )
           RETURNING operation.*
         )
         SELECT
           EXISTS (SELECT 1 FROM active) AS lease_valid,
           EXISTS (
             SELECT 1 FROM arena_keeper_operations
              WHERE operation_id = $5
                AND signer_address = $2
                AND deployment_alias = 'v8'
                AND network = 'bradbury'
                AND chain_id = 4221
           ) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                 ON later.logical_operation_id = operation.logical_operation_id
                AND later.attempt_number > operation.attempt_number
              WHERE operation.operation_id = $5
                AND operation.signer_address = $2
                AND operation.deployment_alias = 'v8'
                AND operation.network = 'bradbury'
                AND operation.chain_id = 4221
           ) AS attempt_frozen,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
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
          reasonCode,
          JSON.stringify(evidence),
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
      if (!operation || operation.state !== 'ABANDONED_PREHASH') {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_PREHASH_ABANDONMENT_CONFLICT',
          'Keeper pre-hash abandonment evidence was rejected.',
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
        FINALIZED_SUCCESS: ['SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED'],
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
               AND operation.signer_address = $2
               AND operation.deployment_alias = 'v8'
               AND operation.network = 'bradbury'
               AND operation.chain_id = 4221
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
               WHEN target.state = 'QUARANTINED' AND $6 = 'FINALIZED_SUCCESS' THEN NULL
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
               AND (
                 target.state <> 'QUARANTINED'
                 OR (
                   target.quarantine_reason = 'RECEIPT_IDENTITY_AMBIGUOUS'
                   AND target.state_reason_code = 'RECEIPT_IDENTITY_AMBIGUOUS'
                 )
               )
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
            EXISTS (
              SELECT 1 FROM arena_keeper_operations
               WHERE operation_id = $5
                 AND signer_address = $2
                 AND deployment_alias = 'v8'
                 AND network = 'bradbury'
                 AND chain_id = 4221
            ) AS operation_exists,
           EXISTS (
             SELECT 1
               FROM arena_keeper_operations operation
               JOIN arena_keeper_operations later
                  ON later.logical_operation_id = operation.logical_operation_id
                 AND later.attempt_number > operation.attempt_number
               WHERE operation.operation_id = $5
                 AND operation.signer_address = $2
                 AND operation.deployment_alias = 'v8'
                 AND operation.network = 'bradbury'
                 AND operation.chain_id = 4221
            ) AS attempt_frozen,
           (SELECT to_jsonb(updated)
                   || jsonb_build_object(
                     'chain_id', updated.chain_id::text,
                     'value_atto', updated.value_atto::text,
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
            AND operation.deployment_alias = 'v8'
            AND operation.network = 'bradbury'
            AND operation.chain_id = 4221
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
