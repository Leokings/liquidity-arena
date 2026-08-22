import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { KEEPER_JOURNAL_SCHEMA_V6_CHECKSUM } from '../keeper-journal/repository.mjs';

const migrationUrl = new URL('../migrations/006_keeper_accepted_handoff.sql', import.meta.url);

test('migration 006 is append-only, independently checksummed, and guarded by exact v5', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');
  const marked = /-- KEEPER_ACCEPTED_HANDOFF_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_ACCEPTED_HANDOFF_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(marked);
  const digest = createHash('sha256').update(marked[1], 'utf8').digest('hex');
  assert.equal(digest, KEEPER_JOURNAL_SCHEMA_V6_CHECKSUM);
  assert.match(sql, new RegExp(`VALUES \\(\\s*6,[\\s\\S]*'${digest}'`));
  assert.match(sql, /version = 5[\s\S]*keeper_receipt_identity_revalidation/);
  assert.match(sql, /AND NOT EXISTS \([\s\S]*version >= 6/);
  assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
  assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
});

test('migration 006 hard-bounds and receipt-binds the ACCEPTED handoff pipeline', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /pipeline_slot IN \(0, 1\)/);
  assert.match(sql, /arena_keeper_operations_pipeline_slot_v6_idx/);
  assert.match(sql, /arena_keeper_operations_attention_subject_v6_idx/);
  assert.match(sql, /arena_keeper_operations_handoff_predecessor_v6_idx/);
  assert.match(sql, /accepted_at[\s\S]*acceptance_revalidated_at[\s\S]*acceptance_metadata/);
  assert.match(sql, /initial acceptance timestamp is immutable/);
  for (const evidence of [
    'transactionHash', 'contractAddress', 'recipient', 'method', 'arguments',
    'ACCEPTED', 'FINISHED_WITH_RETURN', 'receiptIdentityVerified',
    'executionVerified', 'executionSucceeded',
  ]) assert.match(sql, new RegExp(evidence));
  assert.match(sql, /DROP INDEX arena_keeper_operations_one_unresolved_signer_idx/);
  assert.match(
    sql,
    /DROP CONSTRAINT arena_keeper_journal_requests_request_action_check[\s\S]*request_action IN \([\s\S]*'ACCEPT_HANDOFF'/,
  );
  assert.match(
    sql,
    /accepted_at IS NOT NULL[\s\S]*acceptance_metadata IS NOT NULL[\s\S]*jsonb_typeof\(acceptance_metadata\) = 'object'/,
  );
  assert.match(sql, /NEW\.acceptance_metadata IS NULL/);
  assert.match(sql, /NEW\.acceptance_metadata IS DISTINCT FROM jsonb_build_object/);
});
