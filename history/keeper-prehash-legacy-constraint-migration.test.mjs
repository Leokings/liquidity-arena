import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  KEEPER_JOURNAL_SCHEMA_V7_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V8_CHECKSUM,
} from '../keeper-journal/repository.mjs';

const migrationUrl = new URL(
  '../migrations/008_keeper_prehash_legacy_constraint_cleanup.sql',
  import.meta.url,
);
const regressionUrl = new URL(
  '../migrations/regressions/008_keeper_prehash_legacy_constraint_cleanup.sql',
  import.meta.url,
);

test('migration 008 is append-only, independently checksummed, and guarded by exact v7', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_PREHASH_LEGACY_CONSTRAINT_CLEANUP_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_PREHASH_LEGACY_CONSTRAINT_CLEANUP_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, KEEPER_JOURNAL_SCHEMA_V8_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*8,[\\s\\S]*'${digest}'`));
  assert.match(sql, new RegExp(`version = 7[\\s\\S]*'${KEEPER_JOURNAL_SCHEMA_V7_CHECKSUM}'`));
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 8/);
  assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
  assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|UPDATE arena_keeper_operations/);
});

test('migration 008 removes the exact legacy submission constraint blocking abandonment', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(
    sql,
    /ALTER TABLE arena_keeper_operations\s+DROP CONSTRAINT arena_keeper_operations_check3;/,
  );
  assert.equal(
    (sql.match(/DROP CONSTRAINT/g) || []).length,
    1,
  );
});

test('migration 008 ships an executable PostgreSQL regression for the real legacy constraint', async () => {
  const sql = await readFile(regressionUrl, 'utf8');
  assert.match(sql, /^\\set ON_ERROR_STOP on/m);
  assert.match(sql, /CONSTRAINT arena_keeper_operations_check3 CHECK \([\s\S]*'PREPARED'[\s\S]*'STATE_SATISFIED_UNPROVEN'[\s\S]*'QUARANTINED'[\s\S]*OR transaction_hash IS NOT NULL/);
  assert.match(sql, /WHEN check_violation THEN NULL/);
  assert.match(sql, /DROP CONSTRAINT arena_keeper_operations_check3/);
  assert.match(sql, /state = 'ABANDONED_PREHASH'[\s\S]*transaction_hash IS NULL/);
  assert.equal(sql.trimStart().startsWith('\\set ON_ERROR_STOP on'), true);
  assert.equal(sql.trimEnd().endsWith('ROLLBACK;'), true);
});
