import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HISTORY_SCHEMA_CHECKSUM } from './repository.mjs';

test('history proof constraints use the deployed V6/V7 method identities', async () => {
  const sql = await readFile(new URL('../migrations/001_history.sql', import.meta.url), 'utf8');
  assert.match(sql, /proof_kind = 'WAGER' AND method = 'enter'/);
  assert.match(sql, /proof_kind = 'FEE_WITHDRAWAL' AND method = 'withdraw_accrued_fees'/);
  assert.doesNotMatch(sql, /place_wager|withdraw_platform_fees/);
});

test('history schema checksum is the deterministic digest of the marked migration DDL', async () => {
  const sql = (await readFile(new URL('../migrations/001_history.sql', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
  const match = /-- HISTORY_SCHEMA_DIGEST_START\n([\s\S]*?)-- HISTORY_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(match, 'migration must contain exactly one marked digest region');
  assert.equal(sql.match(/-- HISTORY_SCHEMA_DIGEST_START/g)?.length, 1);
  assert.equal(sql.match(/-- HISTORY_SCHEMA_DIGEST_END/g)?.length, 1);
  const digest = createHash('sha256').update(match[1], 'utf8').digest('hex');
  assert.equal(HISTORY_SCHEMA_CHECKSUM, digest);
  assert.match(
    sql,
    new RegExp(`INSERT INTO arena_schema_migrations[\\s\\S]*'${digest}'[\\s\\S]*\\n\\);`),
  );
  assert.doesNotMatch(sql, /CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS|ON CONFLICT \(version\)/);
});
