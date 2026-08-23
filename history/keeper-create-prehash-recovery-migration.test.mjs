import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  KEEPER_JOURNAL_SCHEMA_V8_CHECKSUM,
  KEEPER_JOURNAL_SCHEMA_V9_CHECKSUM,
} from '../keeper-journal/repository.mjs';

const migrationUrl = new URL('../migrations/009_keeper_create_prehash_recovery.sql', import.meta.url);

test('migration 009 is append-only, independently checksummed, and guarded by exact v8', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_CREATE_PREHASH_RECOVERY_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_CREATE_PREHASH_RECOVERY_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, KEEPER_JOURNAL_SCHEMA_V9_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*9,[\\s\\S]*'${digest}'`));
  assert.match(sql, new RegExp(`version = 8[\\s\\S]*'${KEEPER_JOURNAL_SCHEMA_V8_CHECKSUM}'`));
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 9/);
  assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
  assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|UPDATE arena_keeper_operations/);
});

test('migration 009 admits only create and resolve audited recovery with method-specific post-state', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /DROP CONSTRAINT arena_keeper_operations_prehash_abandonment_v7_check/);
  assert.match(sql, /ADD CONSTRAINT arena_keeper_operations_prehash_abandonment_v9_check/);
  assert.match(sql, /method IN \('create_epoch', 'resolve_epoch'\)/);
  assert.match(sql, /WHEN 'resolve_epoch' THEN 'TARGET_STATE_UNCHANGED'/);
  assert.match(sql, /WHEN 'create_epoch' THEN 'EPOCH_UNKNOWN'/);
  assert.doesNotMatch(sql, /activate_timeout_refund'[\s\S]*EPOCH_UNKNOWN/);
  assert.match(sql, /'operationId', operation_id/);
  assert.match(sql, /'logicalOperationId', logical_operation_id/);
  assert.match(sql, /'contractAddress', contract_address/);
  assert.match(sql, /'method', method[\s\S]*'arguments', arguments/);
  assert.match(sql, /preparedAt'[\s\S]*prepared_at/);
  assert.match(sql, /referenceOuterNonce'[\s\S]*\+ 1/);
});

test('migration 009 finalized-state defense rejects a NULL lifecycle by requiring TRUE', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /ADD CONSTRAINT arena_keeper_operations_finalized_state_v9_check CHECK \(/);
  assert.match(sql, /state NOT IN \('FINALIZED_SUCCESS', 'VERIFIED', 'FINALIZED_FAILURE'\)/);
  assert.match(sql, /lifecycle_status = 'FINALIZED' AND finalized_at IS NOT NULL/);
  assert.match(sql, /lifecycle_status = 'FINALIZED'[\s\S]*finalized_at IS NOT NULL[\s\S]*\) IS TRUE/);
  assert.doesNotMatch(sql, /NOT VALID/);
});
