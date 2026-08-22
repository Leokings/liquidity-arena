BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 3
       AND name = 'keeper_transaction_journal_attempts'
       AND schema_checksum = '9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 4
  )
  THEN 1
  ELSE 0
END AS bradbury_v8_cutover_migration_guard;

-- Canonical identity mapping: public deployment/history rows use
-- testnet-bradbury:4221, while keeper execution-journal rows use bradbury:4221.
-- BRADBURY_V8_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
UPDATE arena_deployments SET active = false WHERE active = true;

DROP INDEX arena_deployments_one_active_idx;

ALTER TABLE arena_deployments
  DROP CONSTRAINT arena_deployments_deployment_id_check,
  DROP CONSTRAINT arena_deployments_deployment_alias_check,
  DROP CONSTRAINT arena_deployments_network_check,
  DROP CONSTRAINT arena_deployments_chain_id_check,
  DROP CONSTRAINT arena_deployments_protocol_version_check,
  ADD COLUMN payout_factory_address text,
  ADD COLUMN payout_protocol_version text,
  ADD COLUMN contract_schema_sha256 text,
  ADD CONSTRAINT arena_deployments_deployment_id_v4_check CHECK (
    deployment_id ~ '^(studionet|testnet-bradbury):0x[0-9a-f]{40}$'
  ),
  ADD CONSTRAINT arena_deployments_alias_v4_check CHECK (
    deployment_alias IN ('v6', 'v7', 'v8')
  ),
  ADD CONSTRAINT arena_deployments_identity_v4_check CHECK (
    (
      deployment_alias IN ('v6', 'v7')
      AND network = 'studionet'
      AND chain_id = 61999
      AND deployment_id LIKE 'studionet:%'
      AND protocol_version IN ('LIQUIDITY_ARENA_V6', 'LIQUIDITY_ARENA_V7')
    )
    OR (
      deployment_alias = 'v8'
      AND network = 'testnet-bradbury'
      AND chain_id = 4221
      AND deployment_id LIKE 'testnet-bradbury:%'
      AND protocol_version = 'LIQUIDITY_ARENA_V8'
      AND payout_factory_address ~ '^0x[0-9a-f]{40}$'
      AND payout_protocol_version = 'IDEMPOTENT_EVM_VAULT_V1'
      AND contract_schema_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX arena_deployments_one_active_idx
  ON arena_deployments (active) WHERE active;

ALTER TABLE arena_epochs
  DROP CONSTRAINT arena_epochs_deployment_alias_check,
  ADD CONSTRAINT arena_epochs_deployment_alias_v4_check CHECK (
    deployment_alias IN ('v6', 'v7', 'v8')
  );

ALTER TABLE arena_transaction_proofs
  DROP CONSTRAINT arena_transaction_proofs_deployment_alias_check,
  DROP CONSTRAINT arena_transaction_proofs_proof_kind_check,
  DROP CONSTRAINT arena_transaction_proofs_check,
  DROP CONSTRAINT arena_transaction_proofs_check1,
  DROP CONSTRAINT arena_transaction_proofs_check2,
  DROP CONSTRAINT arena_transaction_proofs_check3,
  DROP CONSTRAINT arena_transaction_proofs_check4,
  ADD CONSTRAINT arena_transaction_proofs_alias_v4_check CHECK (
    deployment_alias IN ('v6', 'v7', 'v8')
  ),
  ADD CONSTRAINT arena_transaction_proofs_kind_v4_check CHECK (proof_kind IN (
    'DEPLOYMENT', 'CREATE_EPOCH', 'RESOLVE_EPOCH', 'ACTIVATE_TIMEOUT_REFUND',
    'WAGER', 'CLAIM', 'TRANSFER_CHILD', 'FEE_WITHDRAWAL', 'CLAIM_REQUEST',
    'REQUEST_FEE_PAYOUT', 'RETRY_PREPARE_PAYOUT', 'DISPATCH_PAYOUT',
    'RETRY_PAYOUT', 'CONFIRM_PAYOUT', 'REFRESH_PAYOUT_WITHDRAWAL'
  )),
  ADD CONSTRAINT arena_transaction_proofs_method_v4_check CHECK (
    (proof_kind = 'DEPLOYMENT' AND method IS NULL AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'CREATE_EPOCH' AND method = 'create_epoch' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'RESOLVE_EPOCH' AND method = 'resolve_epoch' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'ACTIVATE_TIMEOUT_REFUND' AND method = 'activate_timeout_refund' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'WAGER' AND method = 'enter' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'CLAIM' AND deployment_alias IN ('v6', 'v7') AND method = 'claim' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'TRANSFER_CHILD' AND deployment_alias IN ('v6', 'v7') AND method IS NULL AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'FEE_WITHDRAWAL' AND deployment_alias IN ('v6', 'v7') AND method = 'withdraw_accrued_fees' AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'CLAIM_REQUEST' AND deployment_alias = 'v8' AND method = 'claim' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'REQUEST_FEE_PAYOUT' AND deployment_alias = 'v8' AND method = 'request_fee_payout' AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'RETRY_PREPARE_PAYOUT' AND deployment_alias = 'v8' AND method = 'retry_prepare_payout' AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'DISPATCH_PAYOUT' AND deployment_alias = 'v8' AND method = 'dispatch_payout' AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'RETRY_PAYOUT' AND deployment_alias = 'v8' AND method = 'retry_payout' AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'CONFIRM_PAYOUT' AND deployment_alias = 'v8' AND method = 'confirm_payout' AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'REFRESH_PAYOUT_WITHDRAWAL' AND deployment_alias = 'v8' AND method = 'refresh_payout_withdrawal' AND epoch_end_timestamp IS NULL)
  ),
  ADD CONSTRAINT arena_transaction_proofs_transfer_v4_check CHECK (
    (proof_kind = 'TRANSFER_CHILD' AND parent_transaction_hash IS NOT NULL AND value_atto > 0 AND value_credited = true)
    OR proof_kind <> 'TRANSFER_CHILD'
  ),
  ADD CONSTRAINT arena_transaction_proofs_claim_v4_check CHECK (
    (proof_kind = 'CLAIM' AND jsonb_array_length(child_transaction_hashes) = 1 AND value_atto > 0 AND value_credited = true)
    OR (proof_kind = 'CLAIM_REQUEST' AND jsonb_array_length(child_transaction_hashes) = 0 AND value_atto = 0 AND value_credited IS NULL)
    OR proof_kind NOT IN ('CLAIM', 'CLAIM_REQUEST')
  ),
  ADD CONSTRAINT arena_transaction_proofs_value_v4_check CHECK (
    (proof_kind = 'WAGER' AND value_atto > 0)
    OR (proof_kind IN (
      'CREATE_EPOCH', 'RESOLVE_EPOCH', 'ACTIVATE_TIMEOUT_REFUND', 'CLAIM',
      'FEE_WITHDRAWAL', 'CLAIM_REQUEST', 'REQUEST_FEE_PAYOUT',
      'RETRY_PREPARE_PAYOUT', 'DISPATCH_PAYOUT', 'RETRY_PAYOUT',
      'CONFIRM_PAYOUT', 'REFRESH_PAYOUT_WITHDRAWAL'
    ) AND value_atto >= 0)
    OR proof_kind IN ('DEPLOYMENT', 'TRANSFER_CHILD')
  ),
  ADD CONSTRAINT arena_transaction_proofs_execution_v4_check CHECK (
    proof_kind = 'TRANSFER_CHILD' OR execution_result = 'FINISHED_WITH_RETURN'
  );

ALTER TABLE arena_keeper_signer_leases
  DROP CONSTRAINT arena_keeper_signer_leases_lease_scope_check,
  DROP CONSTRAINT arena_keeper_signer_leases_network_check,
  DROP CONSTRAINT arena_keeper_signer_leases_chain_id_check,
  ADD CONSTRAINT arena_keeper_signer_leases_network_v4_check CHECK (
    (lease_scope = 'studionet:61999:keeper' AND network = 'studionet' AND chain_id = 61999)
    OR (lease_scope = 'bradbury:4221:keeper' AND network = 'bradbury' AND chain_id = 4221)
  );

ALTER TABLE arena_keeper_operations
  DROP CONSTRAINT arena_keeper_operations_deployment_alias_check,
  DROP CONSTRAINT arena_keeper_operations_network_check,
  DROP CONSTRAINT arena_keeper_operations_chain_id_check,
  DROP CONSTRAINT arena_keeper_operations_method_check,
  DROP CONSTRAINT arena_keeper_operations_check,
  DROP CONSTRAINT arena_keeper_operations_check1,
  DROP CONSTRAINT arena_keeper_operations_check2,
  ALTER COLUMN epoch_end_timestamp DROP NOT NULL,
  ADD COLUMN subject_type text,
  ADD COLUMN subject_id text;

UPDATE arena_keeper_operations
   SET subject_type = 'epoch', subject_id = epoch_end_timestamp::text;

ALTER TABLE arena_keeper_operations
  ALTER COLUMN subject_type SET NOT NULL,
  ALTER COLUMN subject_id SET NOT NULL,
  ADD CONSTRAINT arena_keeper_operations_identity_v4_check CHECK (
    (deployment_alias IN ('v6', 'v7') AND network = 'studionet' AND chain_id = 61999)
    OR (deployment_alias = 'v8' AND network = 'bradbury' AND chain_id = 4221)
  ),
  ADD CONSTRAINT arena_keeper_operations_subject_v4_check CHECK (
    (
      subject_type = 'epoch'
      AND subject_id ~ '^[1-9][0-9]*$'
      AND epoch_end_timestamp IS NOT NULL
      AND epoch_end_timestamp > 0
      AND epoch_end_timestamp % 3600 = 0
      AND subject_id = epoch_end_timestamp::text
      AND method IN ('create_epoch', 'resolve_epoch', 'activate_timeout_refund')
    )
    OR (
      subject_type = 'payout'
      AND subject_id ~ '^[0-9a-f]{64}$'
      AND epoch_end_timestamp IS NULL
      AND deployment_alias = 'v8'
      AND method IN (
        'retry_prepare_payout', 'dispatch_payout', 'retry_payout',
        'confirm_payout', 'refresh_payout_withdrawal'
      )
    )
  ),
  ADD CONSTRAINT arena_keeper_operations_arguments_v4_check CHECK (
    jsonb_typeof(arguments) = 'array'
    AND jsonb_array_length(arguments) = 1
    AND jsonb_typeof(arguments -> 0) = 'string'
    AND arguments ->> 0 = subject_id
    AND octet_length(arguments::text) <= 1024
  ),
  ADD CONSTRAINT arena_keeper_operations_value_v4_check CHECK (value_atto = 0),
  ADD CONSTRAINT arena_keeper_operations_legacy_create_v4_check CHECK (
    deployment_alias IN ('v7', 'v8') OR method <> 'create_epoch'
  );

DROP INDEX arena_keeper_operations_one_unresolved_signer_idx;

CREATE UNIQUE INDEX arena_keeper_operations_one_unresolved_signer_idx
  ON arena_keeper_operations (network, chain_id, signer_address)
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

CREATE TABLE arena_payouts (
  deployment_id text NOT NULL REFERENCES arena_deployments(deployment_id),
  payout_id text NOT NULL CHECK (payout_id ~ '^[0-9a-f]{64}$'),
  deployment_alias text NOT NULL CHECK (deployment_alias = 'v8'),
  kind text NOT NULL CHECK (kind IN ('PLAYER', 'FEE')),
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  amount_atto numeric(78, 0) NOT NULL CHECK (amount_atto > 0),
  epoch_end_timestamp bigint,
  objective text NOT NULL CHECK (objective IN ('', 'HIGH', 'LOW')),
  wallet_key text NOT NULL,
  stake_atto numeric(78, 0) NOT NULL CHECK (stake_atto >= 0),
  settlement_mode text NOT NULL CHECK (settlement_mode IN (
    'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
    'REFUND_NO_LOSING_SIDE', 'REFUND_TIMEOUT', 'FEE_WITHDRAWAL'
  )),
  includes_rounding_remainder boolean NOT NULL,
  state text NOT NULL CHECK (state IN (
    'PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
  )),
  vault_address text CHECK (vault_address IS NULL OR vault_address ~ '^0x[0-9a-f]{40}$'),
  prepare_attempt_count bigint NOT NULL CHECK (prepare_attempt_count > 0),
  attempt_count bigint NOT NULL CHECK (attempt_count >= 0 AND attempt_count <= 3),
  reserve_remaining_atto numeric(78, 0) NOT NULL CHECK (reserve_remaining_atto >= 0),
  escrow_withdrawn boolean NOT NULL,
  created_at_timestamp bigint NOT NULL CHECK (created_at_timestamp > 0),
  last_prepare_timestamp bigint NOT NULL CHECK (last_prepare_timestamp >= created_at_timestamp),
  last_dispatch_timestamp bigint NOT NULL CHECK (last_dispatch_timestamp >= 0),
  funded_at_timestamp bigint NOT NULL CHECK (funded_at_timestamp >= 0),
  withdrawn_at_timestamp bigint NOT NULL CHECK (withdrawn_at_timestamp >= 0),
  source_metadata jsonb NOT NULL CHECK (jsonb_typeof(source_metadata) = 'object'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, payout_id),
  FOREIGN KEY (deployment_id, deployment_alias)
    REFERENCES arena_deployments(deployment_id, deployment_alias),
  CHECK (
    (
      kind = 'PLAYER'
      AND epoch_end_timestamp > 0
      AND objective IN ('HIGH', 'LOW')
      AND wallet_key = epoch_end_timestamp::text || '|' || objective || '|' || recipient_address
      AND stake_atto > 0
      AND settlement_mode IN (
        'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
        'REFUND_NO_LOSING_SIDE', 'REFUND_TIMEOUT'
      )
      AND (includes_rounding_remainder = false OR settlement_mode = 'PARIMUTUEL')
    )
    OR (
      kind = 'FEE'
      AND epoch_end_timestamp IS NULL
      AND objective = ''
      AND wallet_key = ''
      AND stake_atto = 0
      AND settlement_mode = 'FEE_WITHDRAWAL'
      AND includes_rounding_remainder = false
    )
  ),
  CHECK (
    (state = 'PREPARING' AND attempt_count = 0 AND last_dispatch_timestamp = 0)
    OR (state = 'DISPATCHED' AND attempt_count > 0 AND last_dispatch_timestamp > 0)
    OR (state = 'FUNDED_IN_ESCROW' AND funded_at_timestamp > 0 AND escrow_withdrawn = false)
    OR (state = 'EOA_WITHDRAWN' AND funded_at_timestamp > 0 AND withdrawn_at_timestamp > 0 AND escrow_withdrawn = true)
  )
);

CREATE INDEX arena_payouts_public_history_idx
  ON arena_payouts (created_at_timestamp DESC, deployment_id, payout_id);

CREATE TABLE arena_payout_sync_cursors (
  deployment_id text PRIMARY KEY REFERENCES arena_deployments(deployment_id) ON DELETE CASCADE,
  next_offset bigint NOT NULL CHECK (next_offset >= 0 AND next_offset <= 1000000),
  observed_total bigint NOT NULL CHECK (observed_total >= 0 AND observed_total <= 1000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_payout_stage_proofs (
  deployment_id text NOT NULL,
  payout_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN (
    'PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'
  )),
  proof_domain text NOT NULL CHECK (proof_domain IN ('GENLAYER', 'EVM')),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  method text,
  operation_id text REFERENCES arena_keeper_operations(operation_id),
  attempt_number bigint,
  status text NOT NULL CHECK (status = 'FINALIZED'),
  proof_metadata jsonb NOT NULL CHECK (jsonb_typeof(proof_metadata) = 'object'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, payout_id, proof_domain, transaction_hash),
  UNIQUE (proof_domain, transaction_hash),
  FOREIGN KEY (deployment_id, payout_id)
    REFERENCES arena_payouts(deployment_id, payout_id) ON DELETE CASCADE,
  CHECK (
    (
      proof_domain = 'GENLAYER'
      AND method IN (
        'claim', 'request_fee_payout', 'retry_prepare_payout', 'dispatch_payout',
        'retry_payout', 'confirm_payout', 'refresh_payout_withdrawal'
      )
      AND (
        (operation_id IS NULL AND attempt_number IS NULL)
        OR (operation_id ~ '^[0-9a-f]{64}$' AND attempt_number > 0)
      )
      AND (
        (method IN ('claim', 'request_fee_payout', 'retry_prepare_payout') AND stage = 'PREPARING')
        OR (method IN ('dispatch_payout', 'retry_payout') AND stage = 'DISPATCHED')
        OR (method = 'confirm_payout' AND stage = 'FUNDED_IN_ESCROW')
        OR (method = 'refresh_payout_withdrawal' AND stage = 'EOA_WITHDRAWN')
      )
    )
    OR (
      proof_domain = 'EVM'
      AND method IS NULL
      AND operation_id IS NULL
      AND attempt_number IS NULL
    )
  )
);

CREATE UNIQUE INDEX arena_payout_stage_proofs_operation_attempt_idx
  ON arena_payout_stage_proofs (operation_id, attempt_number)
  WHERE operation_id IS NOT NULL;
-- BRADBURY_V8_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  4,
  'bradbury_v8_cutover',
  '1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910'
);

COMMIT;
