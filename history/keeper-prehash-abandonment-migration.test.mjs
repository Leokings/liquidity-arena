import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { KEEPER_JOURNAL_SCHEMA_V7_CHECKSUM } from '../keeper-journal/repository.mjs';

const migrationUrl = new URL('../migrations/007_keeper_prehash_abandonment.sql', import.meta.url);

test('migration 007 is append-only, independently checksummed, and guarded by exact v6', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_PREHASH_ABANDONMENT_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_PREHASH_ABANDONMENT_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, KEEPER_JOURNAL_SCHEMA_V7_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*7,[\\s\\S]*'${digest}'`));
  assert.match(sql, /version = 6[\s\S]*keeper_accepted_handoff/);
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 7/);
  assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
  assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
});

test('migration 007 preserves evidence and removes only ABANDONED_PREHASH from attention', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /ABANDONED_PREHASH/);
  assert.match(sql, /prehash_abandoned_at[\s\S]*prehash_abandonment_metadata/);
  assert.match(sql, /keeper pre-hash abandonment evidence is immutable/);
  assert.match(sql, /DEFINITE_LOCAL_PRESPAWN_FAILURE/);
  assert.match(sql, /broadcastAttempted', false/);
  assert.match(sql, /AUDITED_NO_BROADCAST/);
  assert.match(sql, /BRADBURY_KEEPER_EVM_SCAN_V1/);
  assert.match(sql, /matchingOuterTransactions', '0'/);
  assert.match(sql, /nonceAtStart'[\s\S]*nonceAtEnd'[\s\S]*latestNonce'[\s\S]*pendingNonce'/);
  assert.match(sql, /referenceEventTransactionId/);
  assert.match(sql, /referenceOuterTransactionHash/);
  assert.match(sql, /scanStartTimestamp[\s\S]*scanEndTimestamp/);
  assert.match(sql, /referenceOuterNonce'[\s\S]*\+ 1/);
  assert.match(sql, /referenceConsensusRecipient/);
  assert.match(sql, /referenceCallSender/);
  assert.match(sql, /referenceCallRecipient/);
  assert.doesNotMatch(sql, /referenceEventSender|referenceEventRecipient/);
  assert.match(sql, /TARGET_STATE_UNCHANGED/);
  assert.match(sql, /'operationId', operation_id/);
  assert.match(sql, /'logicalOperationId', logical_operation_id/);
  assert.match(sql, /'contractAddress', contract_address/);
  assert.match(sql, /'method', method[\s\S]*'arguments', arguments/);
  assert.match(sql, /'subjectType', subject_type[\s\S]*'subjectId', subject_id/);
  assert.match(sql, /preparedAt'[\s\S]*prepared_at/);
  assert.match(sql, /arena_keeper_operations_prehash_abandonment_v7_check[\s\S]*\) IS TRUE/);
  assert.match(sql, /AUDITED_NO_BROADCAST'[\s\S]*method = 'resolve_epoch'[\s\S]*subject_type = 'epoch'/);
  assert.match(sql, /ABANDON_PREHASH/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE/);
});
