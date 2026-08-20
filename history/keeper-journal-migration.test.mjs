import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM } from '../keeper-journal/repository.mjs';

function splitSqlStatements(source) {
  const statements = [];
  let start = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") inString = false;
      continue;
    }
    if (inLineComment) {
      if (character === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (character === '-' && next === '-') {
      inLineComment = true;
      index += 1;
    } else if (character === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
    } else if (character === "'") inString = true;
    else if (character === ';') {
      const statement = source.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const remainder = source.slice(start).trim();
  if (remainder) statements.push(remainder);
  assert.equal(inString, false, 'migration must not contain an unterminated SQL string');
  assert.equal(inBlockComment, false, 'migration must not contain an unterminated block comment');
  return statements;
}

test('keeper journal migration is independently checksummed and strict one-shot version 2', async () => {
  const sql = (await readFile(new URL('../migrations/002_keeper_journal.sql', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
  const match = /-- KEEPER_JOURNAL_SCHEMA_DIGEST_START\n([\s\S]*?)-- KEEPER_JOURNAL_SCHEMA_DIGEST_END\n/.exec(sql);
  assert.ok(match);
  assert.equal(sql.match(/-- KEEPER_JOURNAL_SCHEMA_DIGEST_START/g)?.length, 1);
  assert.equal(sql.match(/-- KEEPER_JOURNAL_SCHEMA_DIGEST_END/g)?.length, 1);
  const digest = createHash('sha256').update(match[1], 'utf8').digest('hex');
  assert.equal(KEEPER_JOURNAL_SCHEMA_V2_CHECKSUM, digest);
  assert.match(sql, new RegExp(`VALUES \\(\\s*2,[\\s\\S]*'${digest}'`));
  assert.match(sql, /LOCK TABLE arena_schema_migrations IN EXCLUSIVE MODE/);
  assert.match(sql, /schema_checksum = 'dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2'/);
  assert.match(sql, /SELECT 1 \/ CASE WHEN[\s\S]*AND NOT EXISTS \([\s\S]*version >= 2/);
  assert.doesNotMatch(sql, /^\s*DO\b|\$[A-Za-z_]*\$/m);
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 14);
  const functions = statements.filter((statement) => /CREATE FUNCTION arena_guard_keeper_operation_update/.test(statement));
  assert.equal(functions.length, 1);
  assert.match(functions[0], /AS E'\nBEGIN[\s\S]*RAISE EXCEPTION ''keeper operation identity is immutable''\\x3b[\s\S]*END\\x3b\n';$/);

  // Neon currently performs a fully naive semicolon split before sending SQL.
  // The encoded PL/pgSQL body must therefore contain no literal semicolon.
  const naiveStatements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
  assert.equal(naiveStatements.length, 14);
  const naiveFunctions = naiveStatements.filter((statement) => /CREATE FUNCTION arena_guard_keeper_operation_update/.test(statement));
  assert.equal(naiveFunctions.length, 1);
  assert.doesNotMatch(naiveFunctions[0], /;/);
  assert.equal(naiveFunctions[0].match(/\\x3b/g)?.length, 26);
  const encodedBody = /AS E'([\s\S]*)'$/.exec(naiveFunctions[0])?.[1];
  assert.ok(encodedBody);
  assert.doesNotMatch(encodedBody.replace(/\\x3b/g, ''), /\\/);
  const decodedBody = encodedBody.replace(/''/g, "'").replace(/\\x3b/g, ';');
  assert.equal(decodedBody.match(/;/g)?.length, 26);
  assert.match(decodedBody, /RAISE EXCEPTION 'keeper operation identity is immutable';/);
  assert.match(decodedBody, /RETURN NEW;\nEND;\n$/);
  assert.doesNotMatch(sql, /CREATE (?:TABLE|FUNCTION|TRIGGER|(?:UNIQUE )?INDEX) IF NOT EXISTS/);
});

test('keeper journal DDL enforces canonical operations, fenced leases, immutable hashes, and exact states', async () => {
  const sql = await readFile(new URL('../migrations/002_keeper_journal.sql', import.meta.url), 'utf8');
  for (const state of [
    'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'VERIFIED',
    'FINALIZED_FAILURE', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
  ]) assert.match(sql, new RegExp(`'${state}'`));
  assert.match(sql, /lease_scope = 'studionet:61999:keeper'/);
  assert.match(sql, /chain_id bigint NOT NULL CHECK \(chain_id = 61999\)/);
  assert.match(sql, /prepared_fencing_token bigint NOT NULL/);
  assert.match(sql, /last_fencing_token bigint NOT NULL/);
  assert.match(sql, /prepared_at timestamptz\(3\) NOT NULL/);
  assert.match(
    sql,
    /arena_keeper_operations_one_unresolved_signer_idx[\s\S]*STATE_SATISFIED_UNPROVEN/,
  );
  assert.match(sql, /NEW\.transaction_hash := OLD\.transaction_hash/);
  assert.match(sql, /NEW\.quarantine_reason := ''SUBMISSION_HASH_CONFLICT''/);
  assert.match(sql, /keeper operation identity is immutable/);
  assert.match(sql, /invalid keeper operation state transition/);
  assert.match(sql, /deployment_alias = 'v7' OR method <> 'create_epoch'/);
  assert.match(sql, /arena_keeper_operation_conflicts/);
  assert.match(sql, /idempotency_key_hash text PRIMARY KEY/);
  assert.doesNotMatch(sql, /private.?key|mnemonic|keystore_password/i);
});

test('applied history migration checksum remains unchanged by keeper journal migration', async () => {
  const sql = await readFile(new URL('../migrations/001_history.sql', import.meta.url), 'utf8');
  assert.match(sql, /'dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2'/);
  assert.doesNotMatch(sql, /arena_keeper_signer_leases|keeper_transaction_journal/);
});
