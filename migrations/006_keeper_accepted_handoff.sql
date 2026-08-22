BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 5
       AND name = 'keeper_receipt_identity_revalidation'
       AND schema_checksum = 'a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 6
  )
  THEN 1
  ELSE 0
END AS keeper_accepted_handoff_migration_guard;

-- KEEPER_ACCEPTED_HANDOFF_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
ALTER TABLE arena_keeper_operations
  ADD COLUMN pipeline_slot smallint,
  ADD COLUMN handoff_predecessor_operation_id text,
  ADD COLUMN accepted_at timestamptz(3),
  ADD COLUMN acceptance_revalidated_at timestamptz(3),
  ADD COLUMN acceptance_metadata jsonb,
  ADD CONSTRAINT arena_keeper_operations_pipeline_slot_v6_check CHECK (
    pipeline_slot IS NULL OR pipeline_slot IN (0, 1)
  ),
  ADD CONSTRAINT arena_keeper_operations_handoff_predecessor_v6_fk
    FOREIGN KEY (handoff_predecessor_operation_id)
    REFERENCES arena_keeper_operations (operation_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT arena_keeper_operations_acceptance_evidence_v6_check CHECK (
    (
      accepted_at IS NULL
      AND acceptance_revalidated_at IS NULL
      AND acceptance_metadata IS NULL
    )
    OR (
      accepted_at IS NOT NULL
      AND acceptance_revalidated_at IS NOT NULL
      AND acceptance_revalidated_at >= accepted_at
      AND transaction_hash IS NOT NULL
      AND acceptance_metadata IS NOT NULL
      AND jsonb_typeof(acceptance_metadata) = 'object'
      AND acceptance_metadata = jsonb_build_object(
        'transactionHash', transaction_hash,
        'contractAddress', contract_address,
        'recipient', contract_address,
        'method', method,
        'arguments', arguments,
        'lifecycleStatus', 'ACCEPTED',
        'txExecutionResultName', 'FINISHED_WITH_RETURN',
        'receiptIdentityVerified', true,
        'executionVerified', true,
        'executionSucceeded', true
      )
    )
  );

ALTER TABLE arena_keeper_operations
  ADD CONSTRAINT arena_keeper_operations_attention_slot_v6_check CHECK (
    state NOT IN (
      'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
      'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
    ) OR pipeline_slot IS NOT NULL
  ) NOT VALID;

UPDATE arena_keeper_operations
   SET pipeline_slot = 0
 WHERE state IN (
   'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
   'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
 );

ALTER TABLE arena_keeper_operations
  VALIDATE CONSTRAINT arena_keeper_operations_attention_slot_v6_check;

ALTER TABLE arena_keeper_journal_requests
  DROP CONSTRAINT arena_keeper_journal_requests_request_action_check,
  ADD CONSTRAINT arena_keeper_journal_requests_request_action_check CHECK (
    request_action IN (
      'LEASE_ACQUIRE', 'LEASE_RENEW', 'LEASE_RELEASE', 'PREPARE',
      'BIND_SUBMISSION', 'OBSERVE_LIFECYCLE', 'ACCEPT_HANDOFF',
      'TRANSITION', 'RECOVER'
    )
  );

DROP INDEX arena_keeper_operations_one_unresolved_signer_idx;

CREATE UNIQUE INDEX arena_keeper_operations_pipeline_slot_v6_idx
  ON arena_keeper_operations (network, chain_id, signer_address, pipeline_slot)
  WHERE state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE UNIQUE INDEX arena_keeper_operations_attention_subject_v6_idx
  ON arena_keeper_operations (
    network, chain_id, signer_address, contract_address, subject_type, subject_id
  )
  WHERE state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE UNIQUE INDEX arena_keeper_operations_handoff_predecessor_v6_idx
  ON arena_keeper_operations (handoff_predecessor_operation_id)
  WHERE handoff_predecessor_operation_id IS NOT NULL;

CREATE INDEX arena_keeper_operations_attention_v6_idx
  ON arena_keeper_operations (network, chain_id, signer_address, prepared_at, operation_id)
  WHERE state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE OR REPLACE FUNCTION arena_guard_keeper_accepted_handoff()
RETURNS trigger
LANGUAGE plpgsql
AS E'
BEGIN
  IF NEW.pipeline_slot IS DISTINCT FROM OLD.pipeline_slot
     OR NEW.handoff_predecessor_operation_id IS DISTINCT FROM OLD.handoff_predecessor_operation_id THEN
    RAISE EXCEPTION ''keeper pipeline identity is immutable''\x3b
  END IF\x3b
  IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NULL THEN
    RAISE EXCEPTION ''keeper acceptance evidence cannot be removed''\x3b
  END IF\x3b
  IF OLD.accepted_at IS NOT NULL
     AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION ''keeper initial acceptance timestamp is immutable''\x3b
  END IF\x3b
  IF NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
     OR NEW.acceptance_revalidated_at IS DISTINCT FROM OLD.acceptance_revalidated_at
     OR NEW.acceptance_metadata IS DISTINCT FROM OLD.acceptance_metadata THEN
    IF NEW.state <> ''SUBMITTED''
       OR NEW.lifecycle_status <> ''ACCEPTED''
       OR NEW.transaction_hash IS NULL
       OR NEW.accepted_at IS NULL
       OR NEW.acceptance_revalidated_at IS NULL
       OR NEW.acceptance_revalidated_at < NEW.accepted_at
       OR NEW.acceptance_metadata IS NULL
       OR jsonb_typeof(NEW.acceptance_metadata) IS DISTINCT FROM ''object''
       OR NEW.acceptance_metadata IS DISTINCT FROM jsonb_build_object(
         ''transactionHash'', NEW.transaction_hash,
         ''contractAddress'', NEW.contract_address,
         ''recipient'', NEW.contract_address,
         ''method'', NEW.method,
         ''arguments'', NEW.arguments,
         ''lifecycleStatus'', ''ACCEPTED'',
         ''txExecutionResultName'', ''FINISHED_WITH_RETURN'',
         ''receiptIdentityVerified'', true,
         ''executionVerified'', true,
         ''executionSucceeded'', true
       ) THEN
      RAISE EXCEPTION ''keeper ACCEPTED handoff requires exact successful receipt evidence''\x3b
    END IF\x3b
  END IF\x3b
  RETURN NEW\x3b
END\x3b
';

CREATE TRIGGER arena_keeper_operations_guard_accepted_handoff
BEFORE UPDATE ON arena_keeper_operations
FOR EACH ROW EXECUTE FUNCTION arena_guard_keeper_accepted_handoff();
-- KEEPER_ACCEPTED_HANDOFF_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  6,
  'keeper_accepted_handoff',
  '5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf'
);

COMMIT;
