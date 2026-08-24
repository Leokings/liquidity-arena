BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 9
       AND name = 'keeper_create_prehash_recovery'
       AND schema_checksum = '5be4175a165d872112f97b88323f3ed013b47eb0aca37b17c2e8c6953cde6694'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 10
  )
  THEN 1
  ELSE 0
END AS keeper_durable_signed_envelope_guard;

-- KEEPER_DURABLE_SIGNED_ENVELOPE_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_state_v7_check,
  DROP CONSTRAINT arena_keeper_operations_submission_v7_check,
  DROP CONSTRAINT arena_keeper_operations_attention_slot_v6_check,
  ADD COLUMN submission_protocol text,
  ADD COLUMN signed_raw_transaction text,
  ADD COLUMN outer_transaction_hash text,
  ADD COLUMN outer_sender_nonce numeric(78, 0),
  ADD COLUMN signed_evidence_sha256 text,
  ADD COLUMN signed_at timestamptz(3),
  ADD COLUMN signed_transaction_metadata jsonb,
  ADD COLUMN outer_receipt_observed_at timestamptz(3),
  ADD COLUMN submission_evidence jsonb,
  ADD COLUMN outer_outcome_evidence jsonb,
  ADD CONSTRAINT arena_keeper_operations_state_v10_check CHECK (state IN (
    'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED',
    'FINALIZED_FAILURE', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
    'ABANDONED_PREHASH'
  )),
  ADD CONSTRAINT arena_keeper_operations_submission_v10_check CHECK (
    state IN (
      'PREPARED', 'SIGNED', 'STATE_SATISFIED_UNPROVEN', 'QUARANTINED',
      'ABANDONED_PREHASH'
    ) OR transaction_hash IS NOT NULL
      OR (state = 'FINALIZED_FAILURE' AND outer_outcome_evidence IS NOT NULL)
  ),
  ADD CONSTRAINT arena_keeper_operations_attention_slot_v10_check CHECK (
    state NOT IN (
      'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS',
      'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
    ) OR pipeline_slot IS NOT NULL
  ),
  ADD CONSTRAINT arena_keeper_operations_submission_protocol_v10_check CHECK (
    submission_protocol IS NULL
    OR submission_protocol = 'BRADBURY_DURABLE_RAW_V1'
  ),
  ADD CONSTRAINT arena_keeper_operations_signed_envelope_v10_check CHECK (
    (
      (
        signed_raw_transaction IS NULL
        AND outer_transaction_hash IS NULL
        AND outer_sender_nonce IS NULL
        AND signed_evidence_sha256 IS NULL
        AND signed_at IS NULL
        AND signed_transaction_metadata IS NULL
      )
      OR (
        submission_protocol = 'BRADBURY_DURABLE_RAW_V1'
      AND signed_raw_transaction ~ '^0x[0-9a-f]+$'
      AND length(signed_raw_transaction) % 2 = 0
      AND octet_length(signed_raw_transaction) BETWEEN 4 AND 8194
      AND outer_transaction_hash ~ '^0x[0-9a-f]{64}$'
      AND outer_sender_nonce BETWEEN 0 AND
        115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND signed_evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND signed_at IS NOT NULL
      AND signed_transaction_metadata IS NOT NULL
      AND jsonb_typeof(signed_transaction_metadata) = 'object'
      AND octet_length(signed_transaction_metadata::text) <= 8192
      AND signed_transaction_metadata = jsonb_build_object(
        'protocolVersion', submission_protocol,
        'outerTransactionHash', outer_transaction_hash,
        'outerNonce', outer_sender_nonce::text,
        'chainId', chain_id::text,
        'signerAddress', signer_address,
        'consensusAddress', '0x0112bf6e83497965a5fdd6dad1e447a6e004271d',
        'contractAddress', contract_address,
        'method', method,
        'arguments', arguments,
        'valueAtto', value_atto::text,
        'gasLimit', signed_transaction_metadata ->> 'gasLimit',
        'gasPriceWei', signed_transaction_metadata ->> 'gasPriceWei',
        'validUntil', signed_transaction_metadata ->> 'validUntil',
        'calldataSha256', signed_transaction_metadata ->> 'calldataSha256'
      )
      AND signed_transaction_metadata ->> 'gasLimit' ~ '^[1-9][0-9]*$'
      AND signed_transaction_metadata ->> 'gasPriceWei' ~ '^[1-9][0-9]*$'
      AND signed_transaction_metadata ->> 'validUntil' ~ '^[1-9][0-9]*$'
      AND signed_transaction_metadata ->> 'calldataSha256' ~ '^[0-9a-f]{64}$'
      AND CASE
        WHEN signed_transaction_metadata ->> 'gasLimit' ~ '^[1-9][0-9]*$'
         AND signed_transaction_metadata ->> 'gasPriceWei' ~ '^[1-9][0-9]*$'
        THEN (signed_transaction_metadata ->> 'gasLimit')::numeric <= 5000000
         AND (signed_transaction_metadata ->> 'gasPriceWei')::numeric <= 1000000000
         AND (signed_transaction_metadata ->> 'gasLimit')::numeric
             * (signed_transaction_metadata ->> 'gasPriceWei')::numeric
             <= 5000000000000000
        ELSE false
        END
      )
    ) IS TRUE
  ),
  ADD CONSTRAINT arena_keeper_operations_signed_state_v10_check CHECK (
    state <> 'SIGNED'
    OR (
      signed_raw_transaction IS NOT NULL
      AND transaction_hash IS NULL
      AND submitted_at IS NULL
      AND submission_evidence IS NULL
      AND outer_outcome_evidence IS NULL
      AND outer_receipt_observed_at IS NULL
    )
  ),
  ADD CONSTRAINT arena_keeper_operations_submission_evidence_v10_check CHECK (
    (
      (
        submission_evidence IS NULL
        AND (
          (outer_outcome_evidence IS NULL AND outer_receipt_observed_at IS NULL)
          OR (outer_outcome_evidence IS NOT NULL AND outer_receipt_observed_at IS NOT NULL)
        )
      )
      OR (
        signed_raw_transaction IS NOT NULL
      AND transaction_hash IS NOT NULL
      AND outer_outcome_evidence IS NULL
      AND outer_receipt_observed_at IS NOT NULL
      AND submission_evidence IS NOT NULL
      AND jsonb_typeof(submission_evidence) = 'object'
      AND submission_evidence = jsonb_build_object(
        'transactionHash', transaction_hash,
        'outerTransactionHash', outer_transaction_hash,
        'receiptBlockHash', submission_evidence ->> 'receiptBlockHash',
        'receiptBlockNumber', submission_evidence ->> 'receiptBlockNumber',
        'finalizedHeadBlockNumber', submission_evidence ->> 'finalizedHeadBlockNumber',
        'eventTopic', '0xdab9102861c7483a187584d6371d88316f005af507982ccf95c110879f3ed5a5',
        'logIndex', submission_evidence ->> 'logIndex',
        'eventActivator', submission_evidence ->> 'eventActivator',
        'receiptIdentityVerified', true,
        'evidenceSha256', signed_evidence_sha256
      )
      AND submission_evidence ->> 'receiptBlockHash' ~ '^0x[0-9a-f]{64}$'
      AND submission_evidence ->> 'receiptBlockNumber' ~ '^(0|[1-9][0-9]*)$'
      AND submission_evidence ->> 'finalizedHeadBlockNumber' ~ '^(0|[1-9][0-9]*)$'
      AND CASE
        WHEN submission_evidence ->> 'receiptBlockNumber' ~ '^(0|[1-9][0-9]*)$'
         AND submission_evidence ->> 'finalizedHeadBlockNumber' ~ '^(0|[1-9][0-9]*)$'
        THEN (submission_evidence ->> 'receiptBlockNumber')::numeric
          <= (submission_evidence ->> 'finalizedHeadBlockNumber')::numeric
        ELSE false
      END
      AND submission_evidence ->> 'logIndex' ~ '^(0|[1-9][0-9]*)$'
      AND submission_evidence ->> 'eventActivator' ~ '^0x[0-9a-f]{40}$'
        AND submission_evidence ->> 'eventActivator'
          <> '0x0000000000000000000000000000000000000000'
      )
    ) IS TRUE
  ),
  ADD CONSTRAINT arena_keeper_operations_outer_outcome_v10_check CHECK (
    (
      outer_outcome_evidence IS NULL
      OR (
        signed_raw_transaction IS NOT NULL
      AND transaction_hash IS NULL
      AND submission_evidence IS NULL
      AND outer_receipt_observed_at IS NOT NULL
      AND jsonb_typeof(outer_outcome_evidence) = 'object'
      AND (
        (
          state = 'FINALIZED_FAILURE'
          AND lifecycle_status = 'FINALIZED'
          AND state_reason_code = 'OUTER_RECEIPT_REVERTED'
          AND quarantine_reason IS NULL
          AND outer_outcome_evidence = jsonb_build_object(
            'outerTransactionHash', outer_transaction_hash,
            'receiptBlockHash', outer_outcome_evidence ->> 'receiptBlockHash',
            'receiptBlockNumber', outer_outcome_evidence ->> 'receiptBlockNumber',
            'finalizedHeadBlockNumber', outer_outcome_evidence ->> 'finalizedHeadBlockNumber',
            'receiptStatus', '0',
            'receiptCanonical', true,
            'newTransactionEventCount', '0',
            'failureCode', 'OUTER_RECEIPT_REVERTED',
            'evidenceSha256', signed_evidence_sha256
          )
        )
        OR (
          state = 'QUARANTINED'
          AND state_reason_code = 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
          AND quarantine_reason = 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
          AND outer_outcome_evidence = jsonb_build_object(
            'outerTransactionHash', outer_transaction_hash,
            'receiptBlockHash', outer_outcome_evidence ->> 'receiptBlockHash',
            'receiptBlockNumber', outer_outcome_evidence ->> 'receiptBlockNumber',
            'finalizedHeadBlockNumber', outer_outcome_evidence ->> 'finalizedHeadBlockNumber',
            'receiptStatus', '1',
            'receiptCanonical', true,
            'newTransactionEventCount', outer_outcome_evidence ->> 'newTransactionEventCount',
            'receiptIdentityVerified', false,
            'ambiguityCode', 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS',
            'evidenceSha256', signed_evidence_sha256
          )
          AND outer_outcome_evidence ->> 'newTransactionEventCount' ~ '^(0|[1-9][0-9]*)$'
        )
      )
      AND outer_outcome_evidence ->> 'receiptBlockHash' ~ '^0x[0-9a-f]{64}$'
      AND outer_outcome_evidence ->> 'receiptBlockNumber' ~ '^(0|[1-9][0-9]*)$'
      AND outer_outcome_evidence ->> 'finalizedHeadBlockNumber' ~ '^(0|[1-9][0-9]*)$'
      AND CASE
        WHEN outer_outcome_evidence ->> 'receiptBlockNumber' ~ '^(0|[1-9][0-9]*)$'
         AND outer_outcome_evidence ->> 'finalizedHeadBlockNumber' ~ '^(0|[1-9][0-9]*)$'
        THEN (outer_outcome_evidence ->> 'receiptBlockNumber')::numeric
          <= (outer_outcome_evidence ->> 'finalizedHeadBlockNumber')::numeric
        ELSE false
        END
      )
    ) IS TRUE
  ),
  ADD CONSTRAINT arena_keeper_operations_outer_reason_v10_check CHECK (
    (
      (
        state_reason_code IS DISTINCT FROM 'OUTER_RECEIPT_REVERTED'
        AND state_reason_code IS DISTINCT FROM 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
        AND quarantine_reason IS DISTINCT FROM 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'
      )
      OR outer_outcome_evidence IS NOT NULL
    ) IS TRUE
  ),
  ADD CONSTRAINT arena_keeper_operations_v10_receipt_required_check CHECK (
    submission_protocol <> 'BRADBURY_DURABLE_RAW_V1'
    OR transaction_hash IS NULL
    OR submission_evidence IS NOT NULL
  ),
  ADD CONSTRAINT arena_keeper_operations_abandoned_unsigned_v10_check CHECK (
    state <> 'ABANDONED_PREHASH'
    OR (
      signed_raw_transaction IS NULL
      AND outer_transaction_hash IS NULL
      AND outer_sender_nonce IS NULL
      AND signed_evidence_sha256 IS NULL
      AND signed_at IS NULL
      AND signed_transaction_metadata IS NULL
      AND outer_receipt_observed_at IS NULL
      AND submission_evidence IS NULL
      AND outer_outcome_evidence IS NULL
    )
  );

ALTER TABLE arena_keeper_journal_requests
  DROP CONSTRAINT arena_keeper_journal_requests_request_action_check,
  ADD CONSTRAINT arena_keeper_journal_requests_request_action_check CHECK (
    request_action IN (
      'LEASE_ACQUIRE', 'LEASE_RENEW', 'LEASE_RELEASE', 'PREPARE',
      'BIND_SIGNED', 'LOAD_SIGNED', 'LOAD_OPERATION', 'BIND_SUBMISSION',
      'BIND_OUTER_OUTCOME',
      'OBSERVE_LIFECYCLE', 'ACCEPT_HANDOFF',
      'ABANDON_PREHASH', 'TRANSITION', 'RECOVER'
    )
  );

DROP INDEX arena_keeper_operations_pipeline_slot_v6_idx;
DROP INDEX arena_keeper_operations_attention_subject_v6_idx;
DROP INDEX arena_keeper_operations_attention_v6_idx;
DROP INDEX arena_keeper_operations_recovery_idx;

CREATE UNIQUE INDEX arena_keeper_operations_outer_transaction_hash_v10_idx
  ON arena_keeper_operations (outer_transaction_hash)
  WHERE outer_transaction_hash IS NOT NULL;

CREATE UNIQUE INDEX arena_keeper_operations_outer_nonce_v10_idx
  ON arena_keeper_operations (network, chain_id, signer_address, outer_sender_nonce)
  WHERE outer_sender_nonce IS NOT NULL;

CREATE UNIQUE INDEX arena_keeper_operations_pipeline_slot_v10_idx
  ON arena_keeper_operations (network, chain_id, signer_address, pipeline_slot)
  WHERE state IN (
    'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE UNIQUE INDEX arena_keeper_operations_attention_subject_v10_idx
  ON arena_keeper_operations (
    network, chain_id, signer_address, contract_address, subject_type, subject_id
  )
  WHERE state IN (
    'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE INDEX arena_keeper_operations_attention_v10_idx
  ON arena_keeper_operations (network, chain_id, signer_address, prepared_at, operation_id)
  WHERE state IN (
    'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE INDEX arena_keeper_operations_recovery_v10_idx
  ON arena_keeper_operations (signer_address, prepared_at, operation_id)
  WHERE state IN (
    'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE OR REPLACE FUNCTION arena_guard_keeper_operation_update()
RETURNS trigger
LANGUAGE plpgsql
AS E'\nBEGIN
  IF ROW(
    NEW.operation_id, NEW.logical_operation_id, NEW.attempt_number,
    NEW.retry_of_operation_id, NEW.retry_of_attempt_number,
    NEW.deployment_alias, NEW.network, NEW.chain_id,
    NEW.signer_address, NEW.contract_address, NEW.method, NEW.arguments,
    NEW.value_atto, NEW.epoch_end_timestamp, NEW.subject_type, NEW.subject_id,
    NEW.canonical_operation, NEW.prepared_fencing_token, NEW.prepared_at,
    NEW.submission_protocol
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.logical_operation_id, OLD.attempt_number,
    OLD.retry_of_operation_id, OLD.retry_of_attempt_number,
    OLD.deployment_alias, OLD.network, OLD.chain_id,
    OLD.signer_address, OLD.contract_address, OLD.method, OLD.arguments,
    OLD.value_atto, OLD.epoch_end_timestamp, OLD.subject_type, OLD.subject_id,
    OLD.canonical_operation, OLD.prepared_fencing_token, OLD.prepared_at,
    OLD.submission_protocol
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
  IF OLD.signed_raw_transaction IS NOT NULL AND ROW(
    NEW.signed_raw_transaction, NEW.outer_transaction_hash,
    NEW.outer_sender_nonce, NEW.signed_evidence_sha256,
    NEW.signed_at, NEW.signed_transaction_metadata
  ) IS DISTINCT FROM ROW(
    OLD.signed_raw_transaction, OLD.outer_transaction_hash,
    OLD.outer_sender_nonce, OLD.signed_evidence_sha256,
    OLD.signed_at, OLD.signed_transaction_metadata
  ) THEN
    RAISE EXCEPTION ''keeper signed transaction identity is immutable''\x3b
  END IF\x3b
  IF OLD.signed_raw_transaction IS NULL AND ROW(
    NEW.signed_raw_transaction, NEW.outer_transaction_hash,
    NEW.outer_sender_nonce, NEW.signed_evidence_sha256,
    NEW.signed_at, NEW.signed_transaction_metadata
  ) IS DISTINCT FROM ROW(
    OLD.signed_raw_transaction, OLD.outer_transaction_hash,
    OLD.outer_sender_nonce, OLD.signed_evidence_sha256,
    OLD.signed_at, OLD.signed_transaction_metadata
  ) AND NOT (OLD.state = ''PREPARED'' AND NEW.state = ''SIGNED'') THEN
    RAISE EXCEPTION ''keeper signing evidence requires PREPARED to SIGNED''\x3b
  END IF\x3b
  IF (OLD.submission_evidence IS NOT NULL OR OLD.outer_outcome_evidence IS NOT NULL) AND ROW(
    NEW.outer_receipt_observed_at, NEW.submission_evidence, NEW.outer_outcome_evidence
  ) IS DISTINCT FROM ROW(
    OLD.outer_receipt_observed_at, OLD.submission_evidence, OLD.outer_outcome_evidence
  ) THEN
    RAISE EXCEPTION ''keeper outer receipt evidence is immutable''\x3b
  END IF\x3b
  IF OLD.submission_evidence IS NULL AND OLD.outer_outcome_evidence IS NULL AND ROW(
    NEW.outer_receipt_observed_at, NEW.submission_evidence, NEW.outer_outcome_evidence
  ) IS DISTINCT FROM ROW(
    OLD.outer_receipt_observed_at, OLD.submission_evidence, OLD.outer_outcome_evidence
  ) AND NOT (OLD.state = ''SIGNED'' AND NEW.state IN (
    ''SUBMITTED'', ''FINALIZED_FAILURE'', ''QUARANTINED''
  )) THEN
    RAISE EXCEPTION ''keeper receipt evidence requires a SIGNED outer outcome''\x3b
  END IF\x3b
  IF OLD.transaction_hash IS NOT NULL
     AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
    NEW.transaction_hash := OLD.transaction_hash\x3b
    NEW.state := ''QUARANTINED''\x3b
    NEW.quarantine_reason := ''SUBMISSION_HASH_CONFLICT''\x3b
  END IF\x3b
  IF OLD.transaction_hash IS NULL AND NEW.transaction_hash IS NOT NULL
     AND NOT (
       OLD.state = ''SIGNED''
       AND NEW.state = ''SUBMITTED''
       AND NEW.submission_evidence IS NOT NULL
       AND NEW.outer_receipt_observed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION ''keeper transaction hash requires exact outer receipt evidence''\x3b
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
      ''SIGNED'', ''STATE_SATISFIED_UNPROVEN'', ''QUARANTINED'', ''ABANDONED_PREHASH''
    ))
    OR (OLD.state = ''SIGNED'' AND NEW.state IN (
      ''SUBMITTED'', ''FINALIZED_FAILURE'', ''QUARANTINED''
    ))
    OR (OLD.state = ''SUBMITTED'' AND NEW.state IN (
      ''FINALIZED_SUCCESS'', ''FINALIZED_FAILURE'',
      ''STATE_SATISFIED_UNPROVEN'', ''QUARANTINED''
    ))
    OR (OLD.state = ''FINALIZED_SUCCESS'' AND NEW.state IN (''VERIFIED'', ''QUARANTINED''))
    OR (OLD.state = ''STATE_SATISFIED_UNPROVEN'' AND NEW.state = ''QUARANTINED'')
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
END\x3b\n';
-- KEEPER_DURABLE_SIGNED_ENVELOPE_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  10,
  'keeper_durable_signed_envelope',
  '4f59d7ba919df88f2bef6c409f2449d6d76da47f25d96e02c7c013fd6c9d6fcf'
);

COMMIT;
