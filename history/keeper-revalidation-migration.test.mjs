import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { KEEPER_JOURNAL_SCHEMA_V5_CHECKSUM } from '../keeper-journal/repository.mjs';

const migrationUrl = new URL(
  '../migrations/005_keeper_receipt_identity_revalidation.sql',
  import.meta.url,
);

test('migration 005 is append-only, independently checksummed, and guarded by exact v4', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_RECEIPT_REVALIDATION_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_RECEIPT_REVALIDATION_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, KEEPER_JOURNAL_SCHEMA_V5_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*5,[\\s\\S]*'${digest}'`));
  assert.match(sql, /version = 4[\s\S]*bradbury_v8_cutover/);
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 5/);
  assert.doesNotMatch(sql, /ALTER TABLE|DROP TABLE|DELETE FROM|TRUNCATE/);
  const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  assert.equal(statements.length, 6);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
});

test('migration 005 permits only exact generic identity quarantine revalidation', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /OLD\.state = ''QUARANTINED''/);
  assert.match(sql, /OLD\.quarantine_reason = ''RECEIPT_IDENTITY_AMBIGUOUS''/);
  assert.match(sql, /OLD\.state_reason_code = ''RECEIPT_IDENTITY_AMBIGUOUS''/);
  assert.match(sql, /OLD\.lifecycle_status = ''FINALIZED''/);
  assert.match(sql, /NEW\.transaction_hash = OLD\.transaction_hash/);
  assert.match(sql, /NEW\.state = ''FINALIZED_SUCCESS''/);
  assert.match(sql, /NEW\.state_reason_code IS NULL/);
  assert.match(sql, /NEW\.quarantine_reason IS NULL/);
  assert.match(sql, /receiptIdentityVerified.*true.*executionVerified.*true/);
  assert.match(sql, /jsonb_object_keys\(NEW\.finality_metadata\)\) = 4/);
  assert.doesNotMatch(
    sql,
    /OLD\.quarantine_reason\s+IN\s*\(/,
    'specific hash, contract, method, and argument mismatch quarantines stay terminal',
  );
});
