import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  KEEPER_JOURNAL_SCHEMA_V9_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V10_CHECKSUM,
} from '../keeper-journal/repository.mjs';

const migrationUrl = new URL(
  '../migrations/010_keeper_durable_signed_envelope.sql',
  import.meta.url,
);

test('migration 010 is append-only, independently checksummed, and guarded by exact v9', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_DURABLE_SIGNED_ENVELOPE_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_DURABLE_SIGNED_ENVELOPE_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, KEEPER_JOURNAL_SCHEMA_V10_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*10,[\\s\\S]*'${digest}'`));
  assert.match(sql, new RegExp(`version = 9[\\s\\S]*'${KEEPER_JOURNAL_SCHEMA_V9_CHECKSUM}'`));
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 10/);
  assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
  assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
  assert.doesNotMatch(sql, /\$keeper_v10\$/);
  assert.match(sql, /LANGUAGE plpgsql\s+AS E'\\nBEGIN/);
  assert.match(sql, /RETURN NEW\\x3b\s*END\\x3b\\n';/);
});

test('migration 010 stores raw exactly once and makes the public metadata redacted', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN signed_raw_transaction text/);
  assert.match(sql, /ADD COLUMN signed_transaction_metadata jsonb/);
  assert.match(sql, /octet_length\(signed_raw_transaction\) BETWEEN 4 AND 8194/);
  const metadataObject = /signed_transaction_metadata = jsonb_build_object\(([\s\S]*?)\n\s*\)/
    .exec(sql)?.[1] || '';
  assert.doesNotMatch(metadataObject, /rawTransaction/);
  assert.match(metadataObject, /'protocolVersion', submission_protocol/);
  assert.match(metadataObject, /'calldataSha256'/);
  assert.match(sql, /keeper signed transaction identity is immutable/);
  assert.match(sql, /OLD\.state = ''PREPARED'' AND NEW\.state = ''SIGNED''/);
});

test('migration 010 binds exact finalized success, revert, and ambiguity evidence null-safely', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /arena_keeper_operations_submission_evidence_v10_check CHECK \([\s\S]*?\) IS TRUE/);
  assert.match(sql, /arena_keeper_operations_outer_outcome_v10_check CHECK \([\s\S]*?\) IS TRUE/);
  assert.match(sql, /'finalizedHeadBlockNumber'/);
  assert.match(sql, /receiptBlockNumber'[\s\S]*<= [\s\S]*finalizedHeadBlockNumber'/);
  assert.match(sql, /'eventTopic', '0xdab9102861c7483a187584d6371d88316f005af507982ccf95c110879f3ed5a5'/);
  assert.match(sql, /'eventActivator'/);
  assert.match(sql, /'receiptStatus', '0'[\s\S]*'newTransactionEventCount', '0'/);
  assert.match(sql, /'failureCode', 'OUTER_RECEIPT_REVERTED'/);
  assert.match(sql, /'receiptStatus', '1'[\s\S]*'receiptIdentityVerified', false/);
  assert.match(sql, /'ambiguityCode', 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS'/);
  assert.match(sql, /arena_keeper_operations_outer_reason_v10_check/);
  assert.match(sql, /BIND_OUTER_OUTCOME/);
  assert.doesNotMatch(sql, /BIND_OUTER_FAILURE/);
});

test('migration 010 recovers SIGNED but never exposes a raw-load action as generic recovery', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /'PREPARED', 'SIGNED', 'SUBMITTED', 'FINALIZED_SUCCESS'/);
  assert.match(sql, /'BIND_SIGNED', 'LOAD_SIGNED', 'LOAD_OPERATION', 'BIND_SUBMISSION'/);
  assert.match(sql, /LOAD_SIGNED/);
  assert.match(sql, /keeper receipt evidence requires a SIGNED outer outcome/);
  assert.match(sql, /OLD\.state = ''SIGNED'' AND NEW\.state IN \([\s\S]*''SUBMITTED''[\s\S]*''FINALIZED_FAILURE''[\s\S]*''QUARANTINED''/);
});
