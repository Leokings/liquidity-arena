BEGIN;

LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;

-- Deliberately divide by zero unless the exact prerequisite is present and no
-- version 2+ migration exists. This is one ordinary SQL statement so the Neon
-- migration statement splitter does not need to understand a procedural block.
SELECT 1 / CASE WHEN
  EXISTS (
    SELECT 1
      FROM arena_schema_migrations
     WHERE version = 1
       AND name = 'durable_history'
       AND schema_checksum = 'dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2'
  )
  AND NOT EXISTS (
    SELECT 1 FROM arena_schema_migrations WHERE version >= 2
  )
  THEN 1
  ELSE 0
END AS keeper_journal_migration_guard;

-- KEEPER_JOURNAL_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
CREATE TABLE arena_keeper_signer_leases (
  lease_scope text PRIMARY KEY CHECK (lease_scope = 'studionet:61999:keeper'),
  network text NOT NULL CHECK (network = 'studionet'),
  chain_id bigint NOT NULL CHECK (chain_id = 61999),
  signer_address text NOT NULL CHECK (
    signer_address ~ '^0x[0-9a-f]{40}$'
    AND signer_address <> '0x0000000000000000000000000000000000000000'
  ),
  holder_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (lease_expires_at > acquired_at OR released_at IS NOT NULL),
  CHECK (released_at IS NULL OR lease_expires_at <= released_at)
);

CREATE TABLE arena_keeper_operations (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[0-9a-f]{64}$'),
  deployment_alias text NOT NULL CHECK (deployment_alias IN ('v6', 'v7')),
  network text NOT NULL CHECK (network = 'studionet'),
  chain_id bigint NOT NULL CHECK (chain_id = 61999),
  signer_address text NOT NULL CHECK (
    signer_address ~ '^0x[0-9a-f]{40}$'
    AND signer_address <> '0x0000000000000000000000000000000000000000'
  ),
  contract_address text NOT NULL CHECK (
    contract_address ~ '^0x[0-9a-f]{40}$'
    AND contract_address <> '0x0000000000000000000000000000000000000000'
  ),
  method text NOT NULL CHECK (
    method IN ('create_epoch', 'resolve_epoch', 'activate_timeout_refund')
  ),
  arguments jsonb NOT NULL CHECK (
    jsonb_typeof(arguments) = 'array'
    AND jsonb_array_length(arguments) BETWEEN 1 AND 3
    AND octet_length(arguments::text) <= 1024
  ),
  value_atto numeric(78, 0) NOT NULL CHECK (
    value_atto >= 0
    AND value_atto <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  ),
  epoch_end_timestamp bigint NOT NULL CHECK (
    epoch_end_timestamp > 0 AND epoch_end_timestamp % 3600 = 0
  ),
  canonical_operation text NOT NULL UNIQUE CHECK (
    octet_length(canonical_operation) BETWEEN 64 AND 4096
    AND canonical_operation !~ '[\r\n]'
  ),
  state text NOT NULL CHECK (state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED',
    'FINALIZED_FAILURE', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  )),
  transaction_hash text CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  lifecycle_status text CHECK (lifecycle_status IS NULL OR lifecycle_status IN (
    'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING', 'ACCEPTED', 'FINALIZED'
  )),
  lifecycle_observed_at timestamptz,
  finality_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(finality_metadata) = 'object'
    AND octet_length(finality_metadata::text) <= 8192
  ),
  verification_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(verification_metadata) = 'object'
    AND octet_length(verification_metadata::text) <= 8192
  ),
  state_reason_code text CHECK (
    state_reason_code IS NULL OR state_reason_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  quarantine_reason text CHECK (
    quarantine_reason IS NULL OR quarantine_reason ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  prepared_fencing_token bigint NOT NULL CHECK (prepared_fencing_token > 0),
  last_fencing_token bigint NOT NULL CHECK (last_fencing_token > 0),
  prepared_at timestamptz(3) NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  finalized_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (arguments ->> 0 = epoch_end_timestamp::text),
  CHECK (jsonb_array_length(arguments) = 1),
  CHECK (deployment_alias = 'v7' OR method <> 'create_epoch'),
  CHECK (
    (transaction_hash IS NULL AND submitted_at IS NULL)
    OR (transaction_hash IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  CHECK (
    state IN ('PREPARED', 'STATE_SATISFIED_UNPROVEN', 'QUARANTINED')
    OR transaction_hash IS NOT NULL
  ),
  CHECK (
    state NOT IN ('FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE')
    OR (lifecycle_status = 'FINALIZED' AND finalized_at IS NOT NULL)
  ),
  CHECK (state <> 'VERIFIED' OR verified_at IS NOT NULL),
  CHECK (state <> 'QUARANTINED' OR quarantine_reason IS NOT NULL)
);

CREATE UNIQUE INDEX arena_keeper_operations_transaction_hash_idx
  ON arena_keeper_operations (transaction_hash) WHERE transaction_hash IS NOT NULL;

CREATE UNIQUE INDEX arena_keeper_operations_one_unresolved_signer_idx
  ON arena_keeper_operations (signer_address)
  WHERE state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE INDEX arena_keeper_operations_recovery_idx
  ON arena_keeper_operations (signer_address, prepared_at, operation_id)
  WHERE state IN (
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS',
    'QUARANTINED', 'STATE_SATISFIED_UNPROVEN'
  );

CREATE TABLE arena_keeper_operation_conflicts (
  operation_id text NOT NULL REFERENCES arena_keeper_operations(operation_id),
  conflicting_transaction_hash text NOT NULL CHECK (
    conflicting_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, conflicting_transaction_hash)
);

CREATE TABLE arena_keeper_journal_requests (
  idempotency_key_hash text PRIMARY KEY CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  request_action text NOT NULL CHECK (request_action IN (
    'LEASE_ACQUIRE', 'LEASE_RENEW', 'LEASE_RELEASE', 'PREPARE',
    'BIND_SUBMISSION', 'OBSERVE_LIFECYCLE', 'TRANSITION', 'RECOVER'
  )),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION arena_guard_keeper_operation_update()
RETURNS trigger
LANGUAGE plpgsql
AS E'
BEGIN
  IF ROW(
    NEW.operation_id, NEW.deployment_alias, NEW.network, NEW.chain_id,
    NEW.signer_address, NEW.contract_address, NEW.method, NEW.arguments,
    NEW.value_atto, NEW.epoch_end_timestamp, NEW.canonical_operation,
    NEW.prepared_fencing_token, NEW.prepared_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.deployment_alias, OLD.network, OLD.chain_id,
    OLD.signer_address, OLD.contract_address, OLD.method, OLD.arguments,
    OLD.value_atto, OLD.epoch_end_timestamp, OLD.canonical_operation,
    OLD.prepared_fencing_token, OLD.prepared_at
  ) THEN
    RAISE EXCEPTION ''keeper operation identity is immutable''\x3b
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
    OR (OLD.state IN (''VERIFIED'', ''FINALIZED_FAILURE'') AND NEW.state = ''QUARANTINED'')
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

CREATE TRIGGER arena_keeper_operations_guard_update
BEFORE UPDATE ON arena_keeper_operations
FOR EACH ROW EXECUTE FUNCTION arena_guard_keeper_operation_update();
-- KEEPER_JOURNAL_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  2,
  'keeper_transaction_journal',
  'd2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266'
);

COMMIT;
