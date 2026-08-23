BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 8
       AND name = 'keeper_prehash_legacy_constraint_cleanup'
       AND schema_checksum = '030604d61f54ad9f6e388f497723d7eaa7118632866574cff976dd0bd43f680a'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 9
  )
  THEN 1
  ELSE 0
END AS keeper_create_prehash_recovery_guard;

-- KEEPER_CREATE_PREHASH_RECOVERY_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_prehash_abandonment_v7_check,
  ADD CONSTRAINT arena_keeper_operations_prehash_abandonment_v9_check CHECK (
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
          AND method IN ('create_epoch', 'resolve_epoch')
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
          AND prehash_abandonment_metadata ->> 'postStateStatus' = CASE method
            WHEN 'resolve_epoch' THEN 'TARGET_STATE_UNCHANGED'
            WHEN 'create_epoch' THEN 'EPOCH_UNKNOWN'
          END
          AND (prehash_abandonment_metadata ->> 'failedAt')::timestamptz
            <= (prehash_abandonment_metadata ->> 'auditedAt')::timestamptz
        )
      ) IS TRUE
    )
  ),
  ADD CONSTRAINT arena_keeper_operations_finalized_state_v9_check CHECK (
    (
      state NOT IN ('FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE')
      OR (lifecycle_status = 'FINALIZED' AND finalized_at IS NOT NULL)
    ) IS TRUE
  );
-- KEEPER_CREATE_PREHASH_RECOVERY_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  9,
  'keeper_create_prehash_recovery',
  '5be4175a165d872112f97b88323f3ed013b47eb0aca37b17c2e8c6953cde6694'
);

COMMIT;
