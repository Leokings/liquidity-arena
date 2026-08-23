BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 6
       AND name = 'keeper_accepted_handoff'
       AND schema_checksum = '5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 7
  )
  THEN 1
  ELSE 0
END AS keeper_prehash_abandonment_migration_guard;

-- KEEPER_PREHASH_ABANDONMENT_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_state_check,
  DROP CONSTRAINT arena_keeper_operations_check4,
  ADD COLUMN prehash_abandoned_at timestamptz(3),
  ADD COLUMN prehash_abandonment_metadata jsonb,
  ADD CONSTRAINT arena_keeper_operations_state_v7_check CHECK (state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED',
    'FINALIZED_FAILURE', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
    'ABANDONED_PREHASH'
  )),
  ADD CONSTRAINT arena_keeper_operations_submission_v7_check CHECK (
    state IN (
      'PREPARED', 'STATE_SATISFIED_UNPROVEN', 'QUARANTINED',
      'ABANDONED_PREHASH'
    ) OR transaction_hash IS NOT NULL
  ),
  ADD CONSTRAINT arena_keeper_operations_prehash_abandonment_v7_check CHECK (
    (
      state <> 'ABANDONED_PREHASH'
      AND prehash_abandoned_at IS NULL
      AND prehash_abandonment_metadata IS NULL
    )
    OR (
      state = 'ABANDONED_PREHASH'
      AND transaction_hash IS NULL
      AND submitted_at IS NULL
      AND lifecycle_status IS NULL
      AND lifecycle_observed_at IS NULL
      AND accepted_at IS NULL
      AND acceptance_revalidated_at IS NULL
      AND acceptance_metadata IS NULL
      AND prehash_abandoned_at IS NOT NULL
      AND prehash_abandonment_metadata IS NOT NULL
      AND jsonb_typeof(prehash_abandonment_metadata) = 'object'
      AND state_reason_code IN (
        'DEFINITE_LOCAL_PRESPAWN_FAILURE', 'AUDITED_NO_BROADCAST'
      )
      AND (
        (
          state_reason_code = 'DEFINITE_LOCAL_PRESPAWN_FAILURE'
          AND prehash_abandonment_metadata = jsonb_build_object(
            'evidenceVersion', 'LOCAL_PRESPAWN_FAILURE_V1',
            'broadcastAttempted', false,
            'transactionHashObserved', false,
            'failureCode', prehash_abandonment_metadata ->> 'failureCode',
            'failureMessage', prehash_abandonment_metadata ->> 'failureMessage',
            'lowerLevelErrorRetained', true,
            'operationId', operation_id,
            'logicalOperationId', logical_operation_id,
            'contractAddress', contract_address,
            'method', method,
            'arguments', arguments,
            'subjectType', subject_type,
            'subjectId', subject_id,
            'preparedAt', prehash_abandonment_metadata ->> 'preparedAt'
          )
          AND prehash_abandonment_metadata ->> 'failureCode'
            ~ '^[A-Z][A-Z0-9_]{0,79}$'
          AND length(prehash_abandonment_metadata ->> 'failureMessage') BETWEEN 1 AND 256
          AND (prehash_abandonment_metadata ->> 'preparedAt')::timestamptz = prepared_at
        )
        OR (
          state_reason_code = 'AUDITED_NO_BROADCAST'
          AND method = 'resolve_epoch'
          AND subject_type = 'epoch'
          AND prehash_abandonment_metadata = jsonb_build_object(
            'evidenceVersion', 'BRADBURY_KEEPER_EVM_SCAN_V1',
            'runId', prehash_abandonment_metadata ->> 'runId',
            'failedAt', prehash_abandonment_metadata ->> 'failedAt',
            'failureCode', prehash_abandonment_metadata ->> 'failureCode',
            'failureMessage', prehash_abandonment_metadata ->> 'failureMessage',
            'lowerLevelErrorRetained', false,
            'transactionHashObserved', false,
            'network', 'bradbury',
            'chainId', '4221',
            'signerAddress', signer_address,
            'operationId', operation_id,
            'logicalOperationId', logical_operation_id,
            'contractAddress', contract_address,
            'method', method,
            'arguments', arguments,
            'subjectType', subject_type,
            'subjectId', subject_id,
            'preparedAt', prehash_abandonment_metadata ->> 'preparedAt',
            'scanStartBlock', prehash_abandonment_metadata ->> 'scanStartBlock',
            'scanEndBlock', prehash_abandonment_metadata ->> 'scanEndBlock',
            'scanStartTimestamp', prehash_abandonment_metadata ->> 'scanStartTimestamp',
            'scanEndTimestamp', prehash_abandonment_metadata ->> 'scanEndTimestamp',
            'matchingOuterTransactions', '0',
            'nonceAtStart', prehash_abandonment_metadata ->> 'nonceAtStart',
            'nonceAtEnd', prehash_abandonment_metadata ->> 'nonceAtEnd',
            'latestNonce', prehash_abandonment_metadata ->> 'latestNonce',
            'pendingNonce', prehash_abandonment_metadata ->> 'pendingNonce',
            'referenceEventTransactionId',
              prehash_abandonment_metadata ->> 'referenceEventTransactionId',
            'referenceOuterTransactionHash',
              prehash_abandonment_metadata ->> 'referenceOuterTransactionHash',
            'referenceOuterNonce', prehash_abandonment_metadata ->> 'referenceOuterNonce',
            'referenceOuterBlock', prehash_abandonment_metadata ->> 'referenceOuterBlock',
            'referenceOuterSender', signer_address,
            'referenceConsensusRecipient', '0x0112bf6e83497965a5fdd6dad1e447a6e004271d',
            'referenceCallSender', signer_address,
            'referenceCallRecipient', contract_address,
            'queryResultSha256', prehash_abandonment_metadata ->> 'queryResultSha256',
            'postStateStatus', prehash_abandonment_metadata ->> 'postStateStatus',
            'postStateVerified', true,
            'auditedAt', prehash_abandonment_metadata ->> 'auditedAt'
          )
          AND prehash_abandonment_metadata ->> 'runId' ~ '^[1-9][0-9]*$'
          AND prehash_abandonment_metadata ->> 'failureCode'
            ~ '^[A-Z][A-Z0-9_]{0,79}$'
          AND length(prehash_abandonment_metadata ->> 'failureMessage') BETWEEN 1 AND 256
          AND (prehash_abandonment_metadata ->> 'preparedAt')::timestamptz = prepared_at
          AND prehash_abandonment_metadata ->> 'scanStartBlock' ~ '^[0-9]+$'
          AND prehash_abandonment_metadata ->> 'scanEndBlock' ~ '^[0-9]+$'
          AND (prehash_abandonment_metadata ->> 'scanStartBlock')::numeric
            <= (prehash_abandonment_metadata ->> 'scanEndBlock')::numeric
          AND prehash_abandonment_metadata ->> 'nonceAtStart' ~ '^[0-9]+$'
          AND prehash_abandonment_metadata ->> 'nonceAtEnd'
            = prehash_abandonment_metadata ->> 'nonceAtStart'
          AND prehash_abandonment_metadata ->> 'latestNonce'
            = prehash_abandonment_metadata ->> 'nonceAtStart'
          AND prehash_abandonment_metadata ->> 'pendingNonce'
            = prehash_abandonment_metadata ->> 'nonceAtStart'
          AND (prehash_abandonment_metadata ->> 'scanStartTimestamp')::timestamptz
            <= (prehash_abandonment_metadata ->> 'preparedAt')::timestamptz
          AND (prehash_abandonment_metadata ->> 'preparedAt')::timestamptz
            <= (prehash_abandonment_metadata ->> 'failedAt')::timestamptz
          AND (prehash_abandonment_metadata ->> 'failedAt')::timestamptz
            <= (prehash_abandonment_metadata ->> 'scanEndTimestamp')::timestamptz
          AND (prehash_abandonment_metadata ->> 'scanEndTimestamp')::timestamptz
            <= (prehash_abandonment_metadata ->> 'auditedAt')::timestamptz
          AND prehash_abandonment_metadata ->> 'referenceEventTransactionId'
            ~ '^0x[0-9a-f]{64}$'
          AND prehash_abandonment_metadata ->> 'referenceOuterTransactionHash'
            ~ '^0x[0-9a-f]{64}$'
          AND prehash_abandonment_metadata ->> 'referenceOuterNonce' ~ '^[0-9]+$'
          AND (prehash_abandonment_metadata ->> 'referenceOuterNonce')::numeric + 1
            = (prehash_abandonment_metadata ->> 'nonceAtStart')::numeric
          AND prehash_abandonment_metadata ->> 'referenceOuterBlock' ~ '^[0-9]+$'
          AND prehash_abandonment_metadata ->> 'queryResultSha256' ~ '^[0-9a-f]{64}$'
          AND prehash_abandonment_metadata ->> 'postStateStatus'
            = 'TARGET_STATE_UNCHANGED'
          AND (prehash_abandonment_metadata ->> 'failedAt')::timestamptz
            <= (prehash_abandonment_metadata ->> 'auditedAt')::timestamptz
        )
      ) IS TRUE
    )
  );

ALTER TABLE arena_keeper_journal_requests
  DROP CONSTRAINT arena_keeper_journal_requests_request_action_check,
  ADD CONSTRAINT arena_keeper_journal_requests_request_action_check CHECK (
    request_action IN (
      'LEASE_ACQUIRE', 'LEASE_RENEW', 'LEASE_RELEASE', 'PREPARE',
      'BIND_SUBMISSION', 'OBSERVE_LIFECYCLE', 'ACCEPT_HANDOFF',
      'ABANDON_PREHASH', 'TRANSITION', 'RECOVER'
    )
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
      ''SUBMITTED'', ''STATE_SATISFIED_UNPROVEN'', ''QUARANTINED'',
      ''ABANDONED_PREHASH''
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
  IF OLD.prehash_abandoned_at IS NOT NULL AND ROW(
    NEW.prehash_abandoned_at, NEW.prehash_abandonment_metadata, NEW.state_reason_code
  ) IS DISTINCT FROM ROW(
    OLD.prehash_abandoned_at, OLD.prehash_abandonment_metadata, OLD.state_reason_code
  ) THEN
    RAISE EXCEPTION ''keeper pre-hash abandonment evidence is immutable''\x3b
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
-- KEEPER_PREHASH_ABANDONMENT_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  7,
  'keeper_prehash_abandonment',
  '4fa4e8103a1b3caa7022cff2ea1b4868ea6128a4f6b359cdb93a8a6320e0a8f3'
);

COMMIT;
