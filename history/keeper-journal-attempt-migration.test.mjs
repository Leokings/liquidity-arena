import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  KEEPER_JOURNAL_SCHEMA_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM,
} from '../keeper-journal/repository.mjs';

test('keeper journal attempt migration is strict, independently checksummed, and naive-split safe', async () => {
  const sql = (await readFile(
    new URL('../migrations/003_keeper_journal_attempts.sql', import.meta.url),
    'utf8',
  )).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_JOURNAL_ATTEMPT_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_JOURNAL_ATTEMPT_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  assert.equal(sql.match(/-- KEEPER_JOURNAL_ATTEMPT_SCHEMA_DIGEST_START/g)?.length, 1);
  assert.equal(sql.match(/-- KEEPER_JOURNAL_ATTEMPT_SCHEMA_DIGEST_END/g)?.length, 1);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(KEEPER_JOURNAL_SCHEMA_CHECKSUM, digest);
  assert.match(sql, new RegExp(`VALUES \\(\\s*3,[\\s\\S]*'${digest}'`));
  assert.match(sql, /BEGIN;\s+LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE;/);
  assert.match(sql, new RegExp(`version = 2[\\s\\S]*schema_checksum = '${KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM}'`));
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 3/);
  assert.doesNotMatch(sql, /^\s*DO\b|\$[A-Za-z_]*\$/m);
  assert.doesNotMatch(sql, /\bIF (?:NOT )?EXISTS\b/);

  const naiveStatements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  assert.equal(naiveStatements.length, 14);
  const functions = naiveStatements.filter((statement) => (
    /CREATE OR REPLACE FUNCTION arena_guard_keeper_operation_update/.test(statement)
  ));
  assert.equal(functions.length, 1);
  assert.doesNotMatch(functions[0], /;/);
  assert.equal(functions[0].match(/\\x3b/g)?.length, 28);
  const encodedBody = /AS E'([\s\S]*)'$/.exec(functions[0])?.[1];
  assert.ok(encodedBody);
  assert.doesNotMatch(encodedBody.replace(/\\x3b/g, ''), /\\/);
  const decodedBody = encodedBody.replace(/''/g, "'").replace(/\\x3b/g, ';');
  assert.equal(decodedBody.match(/;/g)?.length, 28);
  assert.match(decodedBody, /NEW\.logical_operation_id/);
  assert.match(decodedBody, /RETURN NEW;\nEND;\n$/);
});

test('attempt migration backfills attempt one and enforces append-only deterministic lineage', async () => {
  const sql = await readFile(
    new URL('../migrations/003_keeper_journal_attempts.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /SET logical_operation_id = operation_id,\s+attempt_number = 1/);
  assert.match(sql, /DROP CONSTRAINT arena_keeper_operations_canonical_operation_key/);
  assert.match(sql, /logical_operation_id = encode\(\s*sha256\(convert_to\(canonical_operation/);
  assert.match(sql, /arena_keeper_operations_logical_attempt_key UNIQUE/);
  assert.match(sql, /operation_id = CASE\s+WHEN attempt_number = 1 THEN logical_operation_id/);
  assert.match(sql, /sha256\(convert_to\(logical_operation_id \|\| ':' \|\| attempt_number::text/);
  assert.match(sql, /retry_of_attempt_number = attempt_number - 1/);
  assert.match(sql, /retry_of_operation_id IS NOT NULL\s+AND retry_of_attempt_number IS NOT NULL/);
  assert.match(sql, /arena_keeper_operations_retry_parent_fkey FOREIGN KEY/);
  assert.match(sql, /NEW\.retry_of_operation_id, NEW\.retry_of_attempt_number/);
  assert.match(
    sql,
    /DROP INDEX arena_keeper_operations_one_unresolved_signer_idx;[\s\S]*CREATE UNIQUE INDEX arena_keeper_operations_one_unresolved_signer_idx[\s\S]*'QUARANTINED'/,
  );
  assert.match(sql, /later\.attempt_number > OLD\.attempt_number/);
  assert.doesNotMatch(
    sql,
    /OLD\.state IN \(''VERIFIED'', ''FINALIZED_FAILURE''\)[\s\S]*NEW\.state = ''QUARANTINED''/,
  );
  assert.doesNotMatch(sql, /UPDATE arena_keeper_operations[\s\S]*transaction_hash\s*=/);
});
