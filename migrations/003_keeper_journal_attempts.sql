BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 2
       AND name = 'keeper_transaction_journal'
       AND schema_checksum = 'd2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 3
  )
  THEN 1
  ELSE 0
END AS keeper_journal_attempt_migration_guard;

-- KEEPER_JOURNAL_ATTEMPT_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
ALTER TABLE arena_keeper_operations
  ADD COLUMN logical_operation_id text,
  ADD COLUMN attempt_number bigint,
  ADD COLUMN retry_of_operation_id text,
  ADD COLUMN retry_of_attempt_number bigint;

UPDATE arena_keeper_operations
   SET logical_operation_id = operation_id,
       attempt_number = 1;

ALTER TABLE arena_keeper_operations
  ALTER COLUMN logical_operation_id SET NOT NULL,
  ALTER COLUMN attempt_number SET NOT NULL;

ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_canonical_operation_key;

ALTER TABLE arena_keeper_operations
  ADD CONSTRAINT arena_keeper_operations_logical_identity_check CHECK (
    logical_operation_id ~ '^[0-9a-f]{64}$'
    AND logical_operation_id = encode(
      sha256(convert_to(canonical_operation, 'UTF8')),
      'hex'
    )
  ),
  ADD CONSTRAINT arena_keeper_operations_attempt_number_check CHECK (
    attempt_number > 0
  ),
  ADD CONSTRAINT arena_keeper_operations_attempt_identity_check CHECK (
    operation_id = CASE
      WHEN attempt_number = 1 THEN logical_operation_id
      ELSE encode(
        sha256(convert_to(logical_operation_id || ':' || attempt_number::text, 'UTF8')),
        'hex'
      )
    END
  ),
  ADD CONSTRAINT arena_keeper_operations_attempt_lineage_check CHECK (
    (
      attempt_number = 1
      AND retry_of_operation_id IS NULL
      AND retry_of_attempt_number IS NULL
    )
    OR (
      attempt_number > 1
      AND retry_of_operation_id IS NOT NULL
      AND retry_of_attempt_number IS NOT NULL
      AND retry_of_attempt_number = attempt_number - 1
      AND retry_of_operation_id = CASE
        WHEN retry_of_attempt_number = 1 THEN logical_operation_id
        ELSE encode(
          sha256(convert_to(logical_operation_id || ':' || retry_of_attempt_number::text, 'UTF8')),
          'hex'
        )
      END
    )
  ),
  ADD CONSTRAINT arena_keeper_operations_logical_attempt_key UNIQUE (
    logical_operation_id,
    attempt_number
  );

ALTER TABLE arena_keeper_operations
  ADD CONSTRAINT arena_keeper_operations_retry_parent_fkey FOREIGN KEY (
    logical_operation_id,
    retry_of_attempt_number
  ) REFERENCES arena_keeper_operations (
    logical_operation_id,
    attempt_number
  );

DROP INDEX arena_keeper_operations_one_unresolved_signer_idx;

CREATE UNIQUE INDEX arena_keeper_operations_one_unresolved_signer_idx
  ON arena_keeper_operations (signer_address)
  WHERE state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE OR REPLACE FUNCTION arena_guard_keeper_operation_update()
RETURNS trigger
LANGUAGE plpgsql
AS E'
BEGIN
  IF ROW(
    NEW.operation_id, NEW.logical_operation_id, NEW.attempt_number,
    NEW.retry_of_operation_id, NEW.retry_of_attempt_number,
    NEW.deployment_alias, NEW.network, NEW.chain_id,
    NEW.signer_address, NEW.contract_address, NEW.method, NEW.arguments,
    NEW.value_atto, NEW.epoch_end_timestamp, NEW.canonical_operation,
    NEW.prepared_fencing_token, NEW.prepared_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.logical_operation_id, OLD.attempt_number,
    OLD.retry_of_operation_id, OLD.retry_of_attempt_number,
    OLD.deployment_alias, OLD.network, OLD.chain_id,
    OLD.signer_address, OLD.contract_address, OLD.method, OLD.arguments,
    OLD.value_atto, OLD.epoch_end_timestamp, OLD.canonical_operation,
    OLD.prepared_fencing_token, OLD.prepared_at
  ) THEN
    RAISE EXCEPTION ''keeper operation identity is immutable''\x3b
  END IF\x3b

  IF (
    SELECT count(*)
      FROM arena_keeper_operations later
     WHERE later.logical_operation_id = OLD.logical_operation_id
       AND later.attempt_number > OLD.attempt_number
  ) > 0 THEN
    RAISE EXCEPTION ''keeper operation attempt is frozen after retry''\x3b
  END IF\x3b

  IF OLD.transaction_hash IS NOT NULL
     AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
    -- Preserve the first hash and turn every conflicting mutation, including a
    -- concurrent stale-snapshot update, into an auditable quarantine.
    NEW.transaction_hash := OLD.transaction_hash\x3b
    NEW.state := ''QUARANTINED''\x3b
    NEW.quarantine_reason := ''SUBMISSION_HASH_CONFLICT''\x3b
  END IF\x3b

  IF NEW.last_fencing_token < OLD.last_fencing_token THEN
    RAISE EXCEPTION ''keeper fencing token cannot move backwards''\x3b
  END IF\x3b

  IF OLD.lifecycle_status = ''FINALIZED''
     AND NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status THEN
    RAISE EXCEPTION ''keeper lifecycle status cannot regress from FINALIZED''\x3b
  END IF\x3b

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = ''PREPARED'' AND NEW.state IN (
      ''SUBMITTED'', ''STATE_SATISFIED_UNPROVEN'', ''QUARANTINED''
    ))
    OR (OLD.state = ''SUBMITTED'' AND NEW.state IN (
      ''FINALIZED_SUCCESS'', ''FINALIZED_FAILURE'',
      ''STATE_SATISFIED_UNPROVEN'', ''QUARANTINED''
    ))
    OR (OLD.state = ''FINALIZED_SUCCESS'' AND NEW.state IN (''VERIFIED'', ''QUARANTINED''))
    OR (OLD.state = ''STATE_SATISFIED_UNPROVEN'' AND NEW.state IN (''SUBMITTED'', ''QUARANTINED''))
  ) THEN
    RAISE EXCEPTION ''invalid keeper operation state transition: % -> %'', OLD.state, NEW.state\x3b
  END IF\x3b

  IF NEW.transaction_hash IS NOT NULL AND OLD.transaction_hash IS NULL THEN
    NEW.submitted_at := COALESCE(NEW.submitted_at, clock_timestamp())\x3b
  END IF\x3b
  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status THEN
    NEW.lifecycle_observed_at := clock_timestamp()\x3b
  END IF\x3b
  IF NEW.state IN (''FINALIZED_SUCCESS'', ''VERIFIED'', ''FINALIZED_FAILURE'') THEN
    NEW.lifecycle_status := ''FINALIZED''\x3b
    NEW.lifecycle_observed_at := COALESCE(NEW.lifecycle_observed_at, clock_timestamp())\x3b
    NEW.finalized_at := COALESCE(NEW.finalized_at, clock_timestamp())\x3b
  END IF\x3b
  IF NEW.state = ''VERIFIED'' THEN
    NEW.verified_at := COALESCE(NEW.verified_at, clock_timestamp())\x3b
  END IF\x3b
  NEW.updated_at := clock_timestamp()\x3b
  NEW.revision := OLD.revision + 1\x3b
  RETURN NEW\x3b
END\x3b
';
-- KEEPER_JOURNAL_ATTEMPT_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  3,
  'keeper_transaction_journal_attempts',
  '9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70'
);

COMMIT;
