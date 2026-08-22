import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BRADBURY_V8_SCHEMA_CHECKSUM } from './repository.mjs';

test('migration 004 is append-only, independently checksummed, and guarded by exact v3', async () => {
  const sql = (await readFile(
    new URL('../migrations/004_bradbury_v8_cutover.sql', import.meta.url),
    'utf8',
  )).replace(/\r\n/g, '\n');
  const marked = /-- BRADBURY_V8_SCHEMA_DIGEST_START\n([\s\S]*?)-- BRADBURY_V8_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, BRADBURY_V8_SCHEMA_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*4,[\\s\\S]*'${digest}'`));
  assert.match(sql, /version = 3[\s\S]*keeper_transaction_journal_attempts/);
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 4/);
  assert.doesNotMatch(sql, /CREATE (?:TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/);
  const naiveStatements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  assert.equal(naiveStatements.length, 23);
  assert.equal(naiveStatements[0], 'BEGIN');
  assert.equal(naiveStatements.at(-1), 'COMMIT');
});

test('migration 004 globally deactivates legacy rows and admits only canonical V8 Bradbury identity', async () => {
  const sql = await readFile(new URL('../migrations/004_bradbury_v8_cutover.sql', import.meta.url), 'utf8');
  assert.match(sql, /UPDATE arena_deployments SET active = false WHERE active = true/);
  assert.match(sql, /ON arena_deployments \(active\) WHERE active/);
  assert.match(sql, /deployment_alias = 'v8'[\s\S]*network = 'testnet-bradbury'[\s\S]*chain_id = 4221/);
  assert.match(sql, /payout_protocol_version = 'IDEMPOTENT_EVM_VAULT_V1'/);
  assert.match(sql, /contract_schema_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('migration 004 adds canonical payout stages/proofs and V8 keeper subjects', async () => {
  const sql = await readFile(new URL('../migrations/004_bradbury_v8_cutover.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE arena_payouts/);
  assert.match(sql, /PRIMARY KEY \(deployment_id, payout_id\)/);
  assert.match(sql, /wallet_key = epoch_end_timestamp::text \|\| '\|' \|\| objective/);
  assert.match(sql, /settlement_mode = 'FEE_WITHDRAWAL'/);
  assert.match(sql, /CREATE TABLE arena_payout_sync_cursors/);
  assert.match(sql, /CREATE TABLE arena_payout_stage_proofs/);
  assert.match(sql, /proof_domain IN \('GENLAYER', 'EVM'\)/);
  assert.match(sql, /PRIMARY KEY \(deployment_id, payout_id, proof_domain, transaction_hash\)/);
  assert.match(sql, /operation_id text REFERENCES arena_keeper_operations/);
  assert.match(sql, /attempt_number bigint/);
  assert.match(sql, /ON arena_payout_stage_proofs \(operation_id, attempt_number\)/);
  assert.match(sql, /subject_type = 'payout'[\s\S]*subject_id ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /deployment_alias = 'v8' AND network = 'bradbury' AND chain_id = 4221/);
  assert.match(sql, /arguments ->> 0 = subject_id/);
  assert.match(sql, /value_atto = 0/);
  assert.match(
    sql,
    /ON arena_keeper_operations \(network, chain_id, signer_address\)[\s\S]*'QUARANTINED'/,
  );
});
