BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 4
       AND name = 'bradbury_v8_cutover'
       AND schema_checksum = '1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 5
  )
  THEN 1
  ELSE 0
END AS keeper_receipt_identity_revalidation_migration_guard;

-- KEEPER_RECEIPT_REVALIDATION_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
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
    NEW.value_atto, NEW.epoch_end_timestamp, NEW.subject_type, NEW.subject_id,
    NEW.canonical_operation, NEW.prepared_fencing_token, NEW.prepared_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.logical_operation_id, OLD.attempt_number,
    OLD.retry_of_operation_id, OLD.retry_of_attempt_number,
    OLD.deployment_alias, OLD.network, OLD.chain_id,
    OLD.signer_address, OLD.contract_address, OLD.method, OLD.arguments,
    OLD.value_atto, OLD.epoch_end_timestamp, OLD.subject_type, OLD.subject_id,
    OLD.canonical_operation, OLD.prepared_fencing_token, OLD.prepared_at
  ) THEN
    RAISE EXCEPTION ''keeper operation identity is immutable''\x3b
  END IF\x3b
  IF (
    SELECT count(*) FROM arena_keeper_operations later
     WHERE later.logical_operation_id = OLD.logical_operation_id
       AND later.attempt_number > OLD.attempt_number
  ) > 0 THEN
    RAISE EXCEPTION ''keeper operation attempt is frozen after retry''\x3b
  END IF\x3b
  IF OLD.transaction_hash IS NOT NULL
     AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
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
    OR (
      OLD.state = ''QUARANTINED''
      AND OLD.quarantine_reason = ''RECEIPT_IDENTITY_AMBIGUOUS''
      AND OLD.state_reason_code = ''RECEIPT_IDENTITY_AMBIGUOUS''
      AND OLD.lifecycle_status = ''FINALIZED''
      AND OLD.transaction_hash IS NOT NULL
      AND NEW.state = ''FINALIZED_SUCCESS''
      AND NEW.transaction_hash = OLD.transaction_hash
      AND NEW.lifecycle_status = ''FINALIZED''
      AND NEW.state_reason_code IS NULL
      AND NEW.quarantine_reason IS NULL
      AND NEW.finality_metadata ->> ''transactionHash'' = OLD.transaction_hash
      AND NEW.finality_metadata ->> ''lifecycleStatus'' = ''FINALIZED''
      AND NEW.finality_metadata @> ''{"receiptIdentityVerified":true,"executionVerified":true}''::jsonb
      AND (SELECT count(*) FROM jsonb_object_keys(NEW.finality_metadata)) = 4
    )
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
-- KEEPER_RECEIPT_REVALIDATION_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  5,
  'keeper_receipt_identity_revalidation',
  'a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59'
);

COMMIT;
