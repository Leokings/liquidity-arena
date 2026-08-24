import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ROUND_NOT_SCHEDULED_NOTICE,
  ROUND_NOT_SCHEDULED_RPC_CODE,
  ROUND_NOT_SCHEDULED_RPC_MESSAGE,
  isRoundNotScheduledError,
} from './round-probe-error.js';

test('round-not-scheduled recognition accepts only the adapter error and exact viem wrapper', () => {
  const cause = {
    code: ROUND_NOT_SCHEDULED_RPC_CODE,
    message: ROUND_NOT_SCHEDULED_RPC_MESSAGE,
  };
  const wrapped = new Error('Requested resource not found.');
  wrapped.code = ROUND_NOT_SCHEDULED_RPC_CODE;
  wrapped.details = ROUND_NOT_SCHEDULED_RPC_MESSAGE;
  wrapped.cause = cause;

  assert.equal(isRoundNotScheduledError(cause), true);
  assert.equal(isRoundNotScheduledError(wrapped), true);
  for (const value of [
    new Error(ROUND_NOT_SCHEDULED_RPC_MESSAGE),
    { ...cause, code: -32_000 },
    { ...cause, message: `${ROUND_NOT_SCHEDULED_RPC_MESSAGE} retry` },
    { ...cause, data: 'raw-genvm-bytes' },
    Object.assign(new Error('Requested resource not found.'), {
      code: ROUND_NOT_SCHEDULED_RPC_CODE,
      details: ROUND_NOT_SCHEDULED_RPC_MESSAGE,
      cause: { ...cause, data: 'raw-genvm-bytes' },
    }),
    null,
  ]) assert.equal(isRoundNotScheduledError(value), false);
});

test('round probing renders bounded safe copy and retains an explicit fail-closed money gate', async () => {
  const appSource = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const gate = appSource.slice(
    appSource.indexOf('  _roundGate('),
    appSource.indexOf('  _syncRoundState()'),
  );
  const read = appSource.slice(
    appSource.indexOf('  async _readRound('),
    appSource.indexOf('  _refreshDisplayedFrame()'),
  );

  assert.ok(ROUND_NOT_SCHEDULED_NOTICE.length <= 120);
  assert.doesNotMatch(ROUND_NOT_SCHEDULED_NOTICE, /GenVM|ReturnData|\b(?:[0-9a-f]{32,})\b/i);
  assert.match(gate, /this\.roundNotScheduled/);
  assert.match(gate, /allowed: false, code: 'ROUND_NOT_SCHEDULED'/);
  assert.match(read, /isRoundNotScheduledError\(error\)/);
  assert.match(read, /this\.roundReadError = true/);
  assert.match(read, /this\.roundNotScheduled = roundNotScheduled/);
  assert.doesNotMatch(read, /error\.message|String\(error\)/);
});
