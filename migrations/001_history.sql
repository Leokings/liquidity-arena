BEGIN;

-- HISTORY_SCHEMA_DIGEST_START
-- Digest algorithm: SHA-256 of the UTF-8 bytes strictly between the START and END
-- marker lines, after normalizing CRLF to LF. The marker lines are excluded.
CREATE TABLE arena_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL UNIQUE,
  schema_checksum text NOT NULL CHECK (schema_checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE arena_deployments (
  deployment_id text PRIMARY KEY CHECK (deployment_id ~ '^studionet:0x[0-9a-f]{40}$'),
  deployment_alias text NOT NULL CHECK (deployment_alias IN ('v6', 'v7')),
  network text NOT NULL CHECK (network = 'studionet'),
  chain_id bigint NOT NULL CHECK (chain_id = 61999),
  contract_address text NOT NULL UNIQUE CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  protocol_version text NOT NULL CHECK (protocol_version IN ('LIQUIDITY_ARENA_V6', 'LIQUIDITY_ARENA_V7')),
  policy_version text NOT NULL CHECK (policy_version = 'CRYPTO_SPOT_1M_MEDIAN_V1'),
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  keeper_address text CHECK (keeper_address IS NULL OR keeper_address ~ '^0x[0-9a-f]{40}$'),
  treasury_address text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
  deployment_transaction_hash text CHECK (
    deployment_transaction_hash IS NULL OR deployment_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
  contract_config jsonb NOT NULL CHECK (jsonb_typeof(contract_config) = 'object'),
  asset_catalog jsonb NOT NULL CHECK (jsonb_typeof(asset_catalog) = 'object'),
  venue_catalog jsonb NOT NULL CHECK (jsonb_typeof(venue_catalog) = 'object'),
  active boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, deployment_alias),
  UNIQUE (deployment_id, deployment_alias, contract_address, policy_version)
);

CREATE UNIQUE INDEX arena_deployments_one_active_idx
  ON arena_deployments (deployment_alias) WHERE active;

CREATE TABLE arena_epochs (
  deployment_id text NOT NULL REFERENCES arena_deployments(deployment_id),
  deployment_alias text NOT NULL CHECK (deployment_alias IN ('v6', 'v7')),
  epoch_end_timestamp bigint NOT NULL CHECK (epoch_end_timestamp > 0 AND epoch_end_timestamp % 3600 = 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  policy_version text NOT NULL CHECK (policy_version = 'CRYPTO_SPOT_1M_MEDIAN_V1'),
  status text NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'UNDETERMINED', 'TIMED_OUT')),
  result_status text NOT NULL CHECK (result_status IN ('PENDING', 'DETERMINED', 'UNDETERMINED', 'TIMEOUT')),
  phase text NOT NULL,
  wager_opens_timestamp bigint NOT NULL,
  wager_closes_timestamp bigint NOT NULL,
  battle_starts_timestamp bigint NOT NULL,
  resolution_available_timestamp bigint NOT NULL,
  timeout_refund_available_timestamp bigint NOT NULL,
  created_at_timestamp bigint NOT NULL,
  resolved_at_timestamp bigint,
  creator_address text CHECK (creator_address IS NULL OR creator_address ~ '^0x[0-9a-f]{40}$'),
  resolution_digest text CHECK (resolution_digest IS NULL OR resolution_digest ~ '^[0-9a-f]{64}$'),
  qualified_venues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(qualified_venues) = 'array'),
  venue_count integer NOT NULL DEFAULT 0 CHECK (venue_count >= 0 AND venue_count <= 5),
  platform_fee_bps integer NOT NULL CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000),
  platform_fee_accrued_atto numeric(78, 0) NOT NULL DEFAULT 0 CHECK (platform_fee_accrued_atto >= 0),
  minimum_stake_atto numeric(78, 0) NOT NULL CHECK (minimum_stake_atto > 0),
  maximum_stake_per_wallet_atto numeric(78, 0) NOT NULL CHECK (maximum_stake_per_wallet_atto >= minimum_stake_atto),
  high_objective jsonb NOT NULL CHECK (jsonb_typeof(high_objective) = 'object'),
  low_objective jsonb NOT NULL CHECK (jsonb_typeof(low_objective) = 'object'),
  source_metadata jsonb NOT NULL CHECK (jsonb_typeof(source_metadata) = 'object'),
  finality_metadata jsonb NOT NULL CHECK (jsonb_typeof(finality_metadata) = 'object'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (deployment_id, deployment_alias, contract_address, policy_version)
    REFERENCES arena_deployments(deployment_id, deployment_alias, contract_address, policy_version),
  CHECK (
    (status = 'OPEN' AND result_status = 'PENDING' AND resolved_at_timestamp IS NULL)
    OR (status = 'RESOLVED' AND result_status = 'DETERMINED' AND resolved_at_timestamp IS NOT NULL)
    OR (status = 'UNDETERMINED' AND result_status = 'UNDETERMINED' AND resolved_at_timestamp IS NOT NULL)
    OR (status = 'TIMED_OUT' AND result_status = 'TIMEOUT' AND resolved_at_timestamp IS NOT NULL)
  ),
  CHECK (
    wager_opens_timestamp < wager_closes_timestamp
    AND wager_closes_timestamp = battle_starts_timestamp
    AND battle_starts_timestamp < epoch_end_timestamp
    AND epoch_end_timestamp < resolution_available_timestamp
    AND resolution_available_timestamp < timeout_refund_available_timestamp
  ),
  CHECK (created_at_timestamp > 0 AND created_at_timestamp <= epoch_end_timestamp - 3600),
  CHECK (
    status = 'OPEN'
    OR (status IN ('RESOLVED', 'UNDETERMINED')
      AND resolved_at_timestamp >= resolution_available_timestamp
      AND resolved_at_timestamp < timeout_refund_available_timestamp)
    OR (status = 'TIMED_OUT' AND resolved_at_timestamp >= timeout_refund_available_timestamp)
  ),
  UNIQUE (deployment_id, epoch_end_timestamp, result_status),
  PRIMARY KEY (deployment_id, epoch_end_timestamp)
);

CREATE INDEX arena_epochs_public_history_idx
  ON arena_epochs (epoch_end_timestamp DESC, deployment_id DESC);

CREATE INDEX arena_epochs_status_idx
  ON arena_epochs (status, epoch_end_timestamp DESC);

CREATE TABLE arena_market_snapshots (
  deployment_id text NOT NULL,
  epoch_end_timestamp bigint NOT NULL,
  result_status text NOT NULL CHECK (result_status = 'DETERMINED'),
  asset_vector jsonb NOT NULL CHECK (
    jsonb_typeof(asset_vector) = 'array'
    AND jsonb_array_length(asset_vector) = 5
    AND asset_vector @? '$[*] ? (@.asset_id == "BTC")'
    AND asset_vector @? '$[*] ? (@.asset_id == "ETH")'
    AND asset_vector @? '$[*] ? (@.asset_id == "BNB")'
    AND asset_vector @? '$[*] ? (@.asset_id == "SOL")'
    AND asset_vector @? '$[*] ? (@.asset_id == "XRP")'
  ),
  high_winner_asset_id text NOT NULL CHECK (high_winner_asset_id IN ('BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'TIE')),
  high_winner_return_ppb bigint NOT NULL,
  low_winner_asset_id text NOT NULL CHECK (low_winner_asset_id IN ('BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'TIE')),
  low_winner_return_ppb bigint NOT NULL,
  qualified_venues jsonb NOT NULL CHECK (jsonb_typeof(qualified_venues) = 'array'),
  resolution_digest text NOT NULL CHECK (resolution_digest ~ '^[0-9a-f]{64}$'),
  source_metadata jsonb NOT NULL CHECK (jsonb_typeof(source_metadata) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, epoch_end_timestamp),
  FOREIGN KEY (deployment_id, epoch_end_timestamp, result_status)
    REFERENCES arena_epochs(deployment_id, epoch_end_timestamp, result_status) ON DELETE CASCADE
);

CREATE TABLE arena_transaction_proofs (
  transaction_hash text PRIMARY KEY CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  deployment_id text NOT NULL REFERENCES arena_deployments(deployment_id),
  deployment_alias text NOT NULL CHECK (deployment_alias IN ('v6', 'v7')),
  epoch_end_timestamp bigint CHECK (epoch_end_timestamp IS NULL OR epoch_end_timestamp > 0),
  proof_kind text NOT NULL CHECK (proof_kind IN (
    'DEPLOYMENT', 'CREATE_EPOCH', 'RESOLVE_EPOCH', 'ACTIVATE_TIMEOUT_REFUND',
    'WAGER', 'CLAIM', 'TRANSFER_CHILD', 'FEE_WITHDRAWAL'
  )),
  method text,
  arguments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(arguments) = 'array'),
  sender_address text CHECK (sender_address IS NULL OR sender_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address text CHECK (recipient_address IS NULL OR recipient_address ~ '^0x[0-9a-f]{40}$'),
  parent_transaction_hash text CHECK (
    parent_transaction_hash IS NULL OR parent_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  child_transaction_hashes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(child_transaction_hashes) = 'array'),
  value_atto numeric(78, 0) CHECK (
    value_atto IS NULL OR (
      value_atto >= 0
      AND value_atto <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    )
  ),
  value_credited boolean,
  status text NOT NULL CHECK (status = 'FINALIZED'),
  execution_result text,
  proof_metadata jsonb NOT NULL CHECK (jsonb_typeof(proof_metadata) = 'object'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (deployment_id, epoch_end_timestamp)
    REFERENCES arena_epochs(deployment_id, epoch_end_timestamp),
  FOREIGN KEY (deployment_id, deployment_alias)
    REFERENCES arena_deployments(deployment_id, deployment_alias),
  CHECK (
    (proof_kind = 'DEPLOYMENT' AND method IS NULL AND epoch_end_timestamp IS NULL)
    OR (proof_kind = 'CREATE_EPOCH' AND method = 'create_epoch' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'RESOLVE_EPOCH' AND method = 'resolve_epoch' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'ACTIVATE_TIMEOUT_REFUND' AND method = 'activate_timeout_refund' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'WAGER' AND method = 'enter' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'CLAIM' AND method = 'claim' AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'TRANSFER_CHILD' AND method IS NULL AND epoch_end_timestamp IS NOT NULL)
    OR (proof_kind = 'FEE_WITHDRAWAL' AND method = 'withdraw_accrued_fees' AND epoch_end_timestamp IS NULL)
  ),
  CHECK (
    (proof_kind = 'TRANSFER_CHILD'
      AND parent_transaction_hash IS NOT NULL
      AND value_atto > 0
      AND value_credited = true)
    OR (proof_kind <> 'TRANSFER_CHILD')
  ),
  CHECK (
    (proof_kind = 'CLAIM'
      AND jsonb_array_length(child_transaction_hashes) = 1
      AND value_atto > 0
      AND value_credited = true)
    OR (proof_kind <> 'CLAIM')
  ),
  CHECK (
    (proof_kind = 'WAGER' AND value_atto > 0)
    OR (proof_kind IN (
      'CREATE_EPOCH', 'RESOLVE_EPOCH', 'ACTIVATE_TIMEOUT_REFUND',
      'CLAIM', 'FEE_WITHDRAWAL'
    ) AND value_atto >= 0)
    OR proof_kind IN ('DEPLOYMENT', 'TRANSFER_CHILD')
  ),
  CHECK (proof_kind = 'TRANSFER_CHILD' OR execution_result = 'FINISHED_WITH_RETURN')
);

CREATE INDEX arena_transaction_proofs_epoch_idx
  ON arena_transaction_proofs (deployment_id, epoch_end_timestamp, proof_kind);

CREATE TABLE arena_keeper_runs (
  idempotency_key_hash text PRIMARY KEY CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  requested_deployments jsonb NOT NULL CHECK (jsonb_typeof(requested_deployments) = 'array'),
  started_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  summary jsonb CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  error_code text
);
-- HISTORY_SCHEMA_DIGEST_END

INSERT INTO arena_schema_migrations (version, name, schema_checksum)
VALUES (
  1,
  'durable_history',
  'dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2'
);

COMMIT;
