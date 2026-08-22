import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  assertFinalizedGenlayerExecution,
  categorizeGenlayerFailure,
  createPasswordWritingSpawn,
  getGenlayerTransactionStatus,
  parseGenlayerCallOutput,
  parseGenlayerReceiptOutput,
  parseGenlayerWriteOutput,
  resolveGenlayerCommand,
  runGenlayerStreamingCommand,
  submitGenlayerWrite,
  waitForGenlayerFinalizedReceipt,
} from './genlayer-command.mjs';

const TRANSACTION_HASH = `0x${'ab'.repeat(32)}`;

function writeOutput(resultName = 'FINISHED_WITH_RETURN') {
  return `Write Transaction Hash: ${TRANSACTION_HASH}\nResult:\n{\n  statusName: 'ACCEPTED',\n  txExecutionResultName: '${resultName}'\n}`;
}

function studioWriteOutput({
  statusName = 'FINALIZED',
  result = 6,
  resultName = 'MAJORITY_AGREE',
  leaderExecution = 'SUCCESS',
  leaderReturnStatus = 'return',
  leaders,
  rawError = null,
  errorCode = null,
  readable,
  recipient,
} = {}) {
  const leaderReceipts = leaders ?? [{
    mode: 'leader',
    executionResult: leaderExecution,
    returnStatus: leaderReturnStatus,
    rawError,
    errorCode,
  }];
  const leaderText = leaderReceipts.map((leader) => `{
        mode: '${leader.mode}',
        ${leader.vote === undefined ? '' : `vote: '${leader.vote}',\n        `}execution_result: '${leader.executionResult}',
        genvm_result: { raw_error: ${leader.rawError ?? 'null'}, error_code: ${leader.errorCode ?? 'null'} },
        result: { status: '${leader.returnStatus}', payload: { readable: 'null' } }
      }`).join(',\n      ');
  return `Write Transaction Hash: ${TRANSACTION_HASH}
Result:
{
  status_name: '${statusName}',
  ${recipient === undefined ? '' : `recipient: '${recipient}',\n  `}${readable === undefined ? '' : `data: { calldata: { readable: '${readable}' } },\n  `}result: ${result},
  result_name: '${resultName}',
  consensus_data: {
    leader_receipt: [
      ${leaderText}
    ]
  }
}`;
}

test('non-Windows platforms invoke genlayer directly without a shell', () => {
  assert.deepEqual(resolveGenlayerCommand({
    platform: 'linux',
    cwdValue: '/missing',
    isFile: () => false,
  }), {
    executable: 'genlayer',
    prefixArgs: [],
  });
});

test('Windows global npm shim resolves to the CLI JavaScript entry', () => {
  const bin = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  const expectedEntry = `${bin}\\node_modules\\genlayer\\dist\\index.js`;
  const files = new Set([`${bin}\\genlayer.cmd`, expectedEntry]);
  assert.deepEqual(resolveGenlayerCommand({
    platform: 'win32',
    pathValue: bin,
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    isFile: (path) => files.has(path),
  }), {
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    prefixArgs: [expectedEntry],
  });
});

test('Windows local npm shim resolves through the parent node_modules directory', () => {
  const bin = 'C:\\project\\node_modules\\.bin';
  const expectedEntry = 'C:\\project\\node_modules\\genlayer\\dist\\index.js';
  const files = new Set([`${bin}\\genlayer.cmd`, expectedEntry]);
  assert.deepEqual(resolveGenlayerCommand({
    platform: 'win32',
    pathValue: bin,
    nodeExecutable: 'node.exe',
    isFile: (path) => files.has(path),
  }), {
    executable: 'node.exe',
    prefixArgs: [expectedEntry],
  });
});

test('Windows resolution fails closed when no matching CLI entry exists', () => {
  assert.throws(
    () => resolveGenlayerCommand({ platform: 'win32', pathValue: 'C:\\missing', isFile: () => false }),
    /Unable to resolve/,
  );
});

test('successful GenLayer write output returns the transaction receipt', () => {
  assert.deepEqual(parseGenlayerWriteOutput(writeOutput()), {
    transactionHash: TRANSACTION_HASH,
    txExecutionResultName: 'FINISHED_WITH_RETURN',
  });
});

test('native finalized receipt remains compatible with an AGREE consensus label', () => {
  const output = `Write Transaction Hash: ${TRANSACTION_HASH}\nResult:\n{
  status_name: 'FINALIZED',
  resultName: 'AGREE',
  txExecutionResultName: 'FINISHED_WITH_RETURN'
}`;
  assert.deepEqual(parseGenlayerWriteOutput(output), {
    transactionHash: TRANSACTION_HASH,
    txExecutionResultName: 'FINISHED_WITH_RETURN',
  });
});

test('GenLayer execution error is rejected even when the CLI process exits zero', () => {
  assert.throws(
    () => parseGenlayerWriteOutput(writeOutput('FINISHED_WITH_ERROR')),
    new RegExp(`${TRANSACTION_HASH}.*FINISHED_WITH_ERROR`),
  );
});

test('GenLayer output without a receipt fails closed', () => {
  assert.throws(
    () => parseGenlayerWriteOutput(`Write Transaction Hash: ${TRANSACTION_HASH}`),
    /did not report status_name/,
  );
  assert.throws(
    () => parseGenlayerWriteOutput("txExecutionResultName: 'FINISHED_WITH_RETURN'"),
    /did not report a transaction hash/,
  );
});

test('successful StudioNet write maps strict consensus evidence to execution success', () => {
  assert.deepEqual(parseGenlayerWriteOutput(studioWriteOutput()), {
    transactionHash: TRANSACTION_HASH,
    txExecutionResultName: 'FINISHED_WITH_RETURN',
  });
});

test('Studio validator timeout configuration is not misclassified as a receipt timeout', () => {
  assert.equal(categorizeGenlayerFailure("config: { timeout_ms: 22000 }"), 'UNKNOWN');
  assert.equal(
    categorizeGenlayerFailure("address: '0xaC93f1a42D9448eD28Db13Bef50460094034566B'"),
    'UNKNOWN',
  );
  assert.equal(categorizeGenlayerFailure('Timed out waiting for transaction receipt'), 'RETRYABLE_TIMEOUT');
  assert.equal(categorizeGenlayerFailure('RPC 503 unavailable'), 'RETRYABLE_TRANSPORT');
});

test('lightweight transaction status uses Bradbury request and response shapes', async () => {
  let request;
  const status = await getGenlayerTransactionStatus({
    rpcUrl: 'https://rpc-bradbury.genlayer.com',
    transactionHash: TRANSACTION_HASH,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { status: 'Finalized', statusCode: 7 },
      }), {
        status: 200,
      });
    },
  });
  assert.equal(status, 'FINALIZED');
  assert.equal(request.url, 'https://rpc-bradbury.genlayer.com/');
  assert.deepEqual(JSON.parse(request.options.body), {
    jsonrpc: '2.0',
    id: 1,
    method: 'gen_getTransactionStatus',
    params: [{ txId: TRANSACTION_HASH }],
  });
});

test('lightweight transaction status normalizes every non-journal lifecycle safely', async () => {
  for (const [statusCode, reportedStatus, expected] of [
    [0, 'UNINITIALIZED', 'UNKNOWN'],
    [1, 'PENDING', 'PENDING'],
    [2, 'PROPOSING', 'PROPOSING'],
    [3, 'COMMITTING', 'COMMITTING'],
    [4, 'REVEALING', 'REVEALING'],
    [5, 'ACCEPTED', 'ACCEPTED'],
    [6, 'UNDETERMINED', 'UNKNOWN'],
    [7, 'FINALIZED', 'FINALIZED'],
    [8, 'CANCELED', 'UNKNOWN'],
    [9, 'APPEAL_REVEALING', 'UNKNOWN'],
    [10, 'APPEAL_COMMITTING', 'UNKNOWN'],
    [11, 'READY_TO_FINALIZE', 'UNKNOWN'],
    [12, 'VALIDATORS_TIMEOUT', 'UNKNOWN'],
    [13, 'LEADER_TIMEOUT', 'UNKNOWN'],
  ]) {
    const status = await getGenlayerTransactionStatus({
      rpcUrl: 'https://rpc-bradbury.genlayer.com',
      transactionHash: TRANSACTION_HASH,
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { status: reportedStatus, statusCode },
      }), { status: 200 }),
    });
    assert.equal(status, expected);
  }
});

test('lightweight transaction status rejects malformed or unrecognized results', async () => {
  for (const payload of [
    { jsonrpc: '2.0', id: 1, result: 'SOMETHING_NEW' },
    { jsonrpc: '2.0', id: 1, result: { status: 'FINALIZED', statusCode: 5 } },
    { jsonrpc: '2.0', id: 1, result: { status: 'SOMETHING_NEW', statusCode: 14 } },
    { jsonrpc: '2.0', id: 1, error: { code: -1 } },
  ]) {
    await assert.rejects(() => getGenlayerTransactionStatus({
      rpcUrl: 'https://studio.genlayer.com/api',
      transactionHash: TRANSACTION_HASH,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
    }), /status/);
  }
});

function streamingChild({ stdout = [], stderr = [], status = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  queueMicrotask(() => {
    for (const chunk of stdout) child.stdout.write(chunk);
    for (const chunk of stderr) child.stderr.write(chunk);
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', status, null));
  });
  return child;
}

test('streamed transaction hash survives arbitrary chunks and is persisted before close', async () => {
  const events = [];
  const result = await runGenlayerStreamingCommand({
    invocation: { executable: 'genlayer', prefixArgs: [] },
    command: 'write',
    args: ['contract', 'method'],
    spawnImpl: () => streamingChild({
      stdout: ['\u001b[32mWrite Trans', 'action Hash: 0x', 'ab'.repeat(32), '\u001b[0m\n'],
    }),
    onTransactionHash: (hash) => events.push(`hash:${hash}`),
    writeStdout: () => {},
    writeStderr: () => {},
  });
  events.push('closed');

  assert.equal(result.transactionHash, TRANSACTION_HASH);
  assert.deepEqual(events, [`hash:${TRANSACTION_HASH}`, 'closed']);
});

test('stream parser never joins a hash label and value across stdout and stderr', async () => {
  const result = await runGenlayerStreamingCommand({
    invocation: { executable: 'genlayer', prefixArgs: [] },
    command: 'write',
    spawnImpl: () => streamingChild({
      stdout: ['Write Transaction Hash: '],
      stderr: [TRANSACTION_HASH],
    }),
    writeStdout: () => {},
    writeStderr: () => {},
  });
  assert.equal(result.transactionHash, undefined);
});

test('write exit after broadcast returns the authoritative captured hash for resume', async () => {
  const captured = [];
  const result = await submitGenlayerWrite({
    invocation: { executable: 'genlayer', prefixArgs: [] },
    args: ['contract', 'method'],
    spawnImpl: () => streamingChild({
      stdout: [`Write Transaction Hash: ${TRANSACTION_HASH}\n`],
      stderr: ['Timed out waiting for transaction receipt'],
      status: 1,
    }),
    onTransactionHash: (hash) => captured.push(hash),
    writeStdout: () => {},
    writeStderr: () => {},
  });

  assert.deepEqual(captured, [TRANSACTION_HASH]);
  assert.equal(result.transactionHash, TRANSACTION_HASH);
  assert.match(result.commandError, /status 1/);
});

test('hash persistence failure is never swallowed as a successful submission', async () => {
  await assert.rejects(
    submitGenlayerWrite({
      invocation: { executable: 'genlayer', prefixArgs: [] },
      args: ['contract', 'method'],
      spawnImpl: () => streamingChild({
        stdout: [`Write Transaction Hash: ${TRANSACTION_HASH}\n`],
      }),
      onTransactionHash: () => { throw new Error('disk full'); },
      writeStdout: () => {},
      writeStderr: () => {},
    }),
    /Failed to persist/,
  );
});

test('stream wrapper waits for asynchronous durable hash binding even if the child closes first', async () => {
  let releaseBinding;
  let commandSettled = false;
  const binding = new Promise((resolve) => { releaseBinding = resolve; });
  const command = runGenlayerStreamingCommand({
    invocation: { executable: 'genlayer', prefixArgs: [] },
    command: 'write',
    spawnImpl: () => streamingChild({
      stdout: [`Write Transaction Hash: ${TRANSACTION_HASH}\n`],
    }),
    onTransactionHash: () => binding,
    writeStdout: () => {},
    writeStderr: () => {},
  });
  command.finally(() => { commandSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandSettled, false);

  releaseBinding();
  const result = await command;
  assert.equal(result.transactionHash, TRANSACTION_HASH);
});

test('asynchronous hash binding rejection wins a close race and fails closed', async () => {
  let rejectBinding;
  const binding = new Promise((_resolve, reject) => { rejectBinding = reject; });
  const command = submitGenlayerWrite({
    invocation: { executable: 'genlayer', prefixArgs: [] },
    args: ['contract', 'method'],
    spawnImpl: () => streamingChild({
      stdout: [`Write Transaction Hash: ${TRANSACTION_HASH}\n`],
    }),
    onTransactionHash: () => binding,
    writeStdout: () => {},
    writeStderr: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  rejectBinding(new Error('Neon unavailable'));
  await assert.rejects(command, (error) => {
    assert.equal(error.code, 'HASH_PERSIST_FAILED');
    assert.equal(error.transactionHash, TRANSACTION_HASH);
    return true;
  });
});

test('password-writing spawn supplies a locked keystore password through stdin only', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  let received = '';
  child.stdin.on('data', (chunk) => { received += chunk.toString('utf8'); });
  let invocation;
  const spawn = createPasswordWritingSpawn('correct horse battery staple', {
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
  });

  assert.equal(spawn('genlayer', ['receipt', TRANSACTION_HASH], { stdio: ['pipe', 'pipe', 'pipe'] }), child);
  child.emit('spawn');
  await new Promise((resolve) => child.stdin.once('finish', resolve));

  assert.equal(received, 'correct horse battery staple\n');
  assert.deepEqual(invocation, {
    command: 'genlayer',
    args: ['receipt', TRANSACTION_HASH],
    options: { stdio: ['pipe', 'pipe', 'pipe'] },
  });
  assert.throws(() => createPasswordWritingSpawn(''), /non-empty/);
});

test('call parser safely handles the util.inspect object subset emitted by CLI 0.39.2', () => {
  const output = `\u001b[34mResult:\u001b[0m\n{\n  round_id: 'ROUND-HIGH',\n  asset_ids: [ 'BTC_USD', 'ETH_USD' ],\n  total_stake_atto: 1000000000000000000n,\n  open: true\n}\n\n✔ Read operation successfully executed`;
  assert.deepEqual(parseGenlayerCallOutput(output), {
    round_id: 'ROUND-HIGH',
    asset_ids: ['BTC_USD', 'ETH_USD'],
    total_stake_atto: '1000000000000000000',
    open: true,
  });
});

test('receipt parser requires FINALIZED lifecycle and successful execution independently', () => {
  const finalized = parseGenlayerReceiptOutput(`Result:\n{\n status_name: 'FINALIZED',\n txExecutionResultName: 'FINISHED_WITH_RETURN'\n}`, {
    transactionHash: TRANSACTION_HASH,
  });
  assert.equal(assertFinalizedGenlayerExecution(finalized), finalized);

  const accepted = parseGenlayerReceiptOutput(`Result:\n{\n status_name: 'ACCEPTED',\n txExecutionResultName: 'FINISHED_WITH_RETURN'\n}`);
  assert.throws(() => assertFinalizedGenlayerExecution(accepted), /ACCEPTED, not FINALIZED/);
  const failed = parseGenlayerReceiptOutput(`Result:\n{\n status_name: 'FINALIZED',\n txExecutionResultName: 'FINISHED_WITH_ERROR',\n stderr: '[TRANSIENT] SOURCE_UNAVAILABLE'\n}`);
  assert.equal(failed.errorCategory, 'TRANSIENT');
  assert.throws(() => assertFinalizedGenlayerExecution(failed), /FINISHED_WITH_ERROR/);
  assert.throws(
    () => parseGenlayerReceiptOutput("Result:\n{\n  status_name: 'ACCEPTED',\n  status_name: 'FINALIZED',\n  txExecutionResultName: 'FINISHED_WITH_RETURN'\n}"),
    /duplicate object key: status_name|conflicting status_name/,
  );
});

test('receipt parser accepts finalized StudioNet leader-return evidence', () => {
  const receipt = parseGenlayerReceiptOutput(studioWriteOutput(), {
    transactionHash: TRANSACTION_HASH,
  });

  assert.equal(receipt.statusName, 'FINALIZED');
  assert.equal(receipt.txExecutionResultName, 'FINISHED_WITH_RETURN');
  assert.equal(assertFinalizedGenlayerExecution(receipt), receipt);
});

test('StudioNet receipt parser accepts only exact numeric FINALIZED lifecycle evidence', () => {
  const numericFinalized = studioWriteOutput().replace(
    "  status_name: 'FINALIZED',",
    '  status: 7,',
  );
  const receipt = parseGenlayerReceiptOutput(numericFinalized, {
    transactionHash: TRANSACTION_HASH,
  });
  assert.equal(receipt.statusName, 'FINALIZED');
  assert.equal(assertFinalizedGenlayerExecution(receipt), receipt);

  const contradictory = studioWriteOutput({ statusName: 'ACCEPTED' }).replace(
    "  status_name: 'ACCEPTED',",
    "  status_name: 'ACCEPTED',\n  status: 7,",
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(contradictory),
    /conflicting status_name values/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(numericFinalized.replace('  status: 7,', '  status: 6,')),
    /numeric status is 6, not 7 \(FINALIZED\)/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(numericFinalized.replace('  status: 7,', "  status: '7',")),
    /malformed numeric status/,
  );

  const namedAccepted = studioWriteOutput({ statusName: 'ACCEPTED' }).replace(
    "  status_name: 'ACCEPTED',",
    "  status_name: 'ACCEPTED',\n  status: 5,",
  );
  assert.equal(
    parseGenlayerReceiptOutput(namedAccepted, { requireExecution: false }).statusName,
    'ACCEPTED',
  );
});

test('StudioNet receipt parser ignores a quorum-cancelled validator after the authoritative leader', () => {
  const receipt = parseGenlayerReceiptOutput(studioWriteOutput({
    leaders: [
      {
        mode: 'leader',
        executionResult: 'SUCCESS',
        returnStatus: 'return',
      },
      {
        mode: 'validator',
        vote: 'idle',
        executionResult: 'ERROR',
        returnStatus: 'error',
        rawError: "{ fatal: false, causes: [ 'VALIDATOR_QUORUM_REACHED' ] }",
        errorCode: "'VALIDATOR_QUORUM_REACHED'",
      },
    ],
  }), { transactionHash: TRANSACTION_HASH });

  assert.equal(receipt.txExecutionResultName, 'FINISHED_WITH_RETURN');
  assert.equal(assertFinalizedGenlayerExecution(receipt), receipt);
});

test('StudioNet receipt parser rejects consensus, result-code, and leader conflicts', () => {
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({ resultName: 'MAJORITY_DISAGREE' })),
    /consensus result is MAJORITY_DISAGREE/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({ result: 5 })),
    /result code is 5, not 6/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({ leaderExecution: 'ERROR' })),
    /execution_result is ERROR, not SUCCESS/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({ leaderReturnStatus: 'error' })),
    /result.status is ERROR, not return/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({
      leaders: [
        { mode: 'validator', executionResult: 'SUCCESS', returnStatus: 'return' },
        { mode: 'leader', executionResult: 'ERROR', returnStatus: 'error' },
      ],
    })),
    /leader_receipt\[1\] execution_result is ERROR/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({
      leaders: [
        { mode: 'leader', executionResult: 'SUCCESS', returnStatus: 'return' },
        { mode: 'leader', executionResult: 'SUCCESS', returnStatus: 'return' },
      ],
    })),
    /exactly one authoritative mode=leader entry; received 2/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({
      leaders: [
        { mode: 'validator', executionResult: 'ERROR', returnStatus: 'error' },
      ],
    })),
    /exactly one authoritative mode=leader entry; received 0/,
  );
});

test('StudioNet receipt parser rejects explicit GenVM errors and nested lookalikes', () => {
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({ rawError: "'boom'" })),
    /reported a GenVM raw error/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(`Result:\n{
  status_name: 'FINALIZED',
  result: 6,
  result_name: 'MAJORITY_AGREE',
  stdout: "execution_result: 'SUCCESS' result: { status: 'return' }"
}`),
    /did not report consensus_data/,
  );
});

test('receipt parser rejects contradictory native and StudioNet execution evidence', () => {
  const output = studioWriteOutput().replace(
    "  status_name: 'FINALIZED',",
    "  status_name: 'FINALIZED',\n  txExecutionResultName: 'FINISHED_WITH_ERROR',",
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(output),
    /conflicting execution result evidence/,
  );
});

test('receipt parser preserves exact decoded call identity for imported proof checks', () => {
  const receipt = parseGenlayerReceiptOutput(`Result:\n{
  status_name: 'FINALIZED',
  txExecutionResultName: 'FINISHED_WITH_RETURN',
  recipient: '0xd0a7430b25379B7483B61eEa881Fe1bede103852',
  txDataDecoded: {
    type: 'call',
    callData: { method: 'activate_emergency_refund', args: [ 'ROUND-1' ] }
  }
}`, { transactionHash: TRANSACTION_HASH });

  assert.equal(receipt.recipient, '0xd0a7430b25379B7483B61eEa881Fe1bede103852');
  assert.deepEqual(receipt.txDataDecoded, {
    type: 'call',
    callData: { method: 'activate_emergency_refund', args: ['ROUND-1'] },
  });
});

test('receipt parser recovers exact Bradbury call identity from raw transaction bytes', () => {
  const raw = '0xe2a01604617267730d81fcbfa235066d6574686f64646372656174655f65706f636800';
  const receipt = parseGenlayerReceiptOutput(`Result:\n{
  status_name: 'FINALIZED',
  txExecutionResultName: 'FINISHED_WITH_RETURN',
  recipient: '0x06B643f94003e51c6dC47E89524e7fD045630549',
  txCalldata: '${raw}',
  txData: '${raw}',
  txDataDecoded: { leaderOnly: false, type: 'call' }
}`, { transactionHash: TRANSACTION_HASH });

  assert.deepEqual(receipt.txDataDecoded, {
    type: 'call',
    callData: { method: 'create_epoch', args: [1787428800n] },
  });
});

test('receipt parser rejects malformed, conflicting, or disagreeing raw call identity', () => {
  const raw = '0xe2a01604617267730d81fcbfa235066d6574686f64646372656174655f65706f636800';
  const receipt = ({ txData = raw, txCalldata = raw, decoded = "{ leaderOnly: false, type: 'call' }" } = {}) => `Result:\n{
  status_name: 'FINALIZED',
  txExecutionResultName: 'FINISHED_WITH_RETURN',
  recipient: '0x06B643f94003e51c6dC47E89524e7fD045630549',
  txCalldata: '${txCalldata}',
  txData: '${txData}',
  txDataDecoded: ${decoded}
}`;

  assert.throws(
    () => parseGenlayerReceiptOutput(receipt({ txData: '0xabc' })),
    /malformed txData/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(receipt({ txCalldata: `${raw.slice(0, -2)}01` })),
    /conflicting txData and txCalldata/,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(receipt({
      decoded: "{ type: 'call', callData: { method: 'resolve_epoch', args: [ 1787428800n ] } }",
    })),
    /conflicting decoded call identity evidence/,
  );
});

test('receipt parser converts StudioNet data.calldata.readable into imported-proof identity', () => {
  const contract = '0xd0a7430b25379B7483B61eEa881Fe1bede103852';
  const receipt = parseGenlayerReceiptOutput(studioWriteOutput({
    recipient: contract,
    readable: '{"args":["ROUND-1",]"method":"resolve_round"}',
  }), { transactionHash: TRANSACTION_HASH });

  assert.equal(receipt.recipient, contract);
  assert.deepEqual(receipt.txDataDecoded, {
    type: 'call',
    callData: { method: 'resolve_round', args: ['ROUND-1'] },
  });
});

test('receipt parser rejects malformed or conflicting StudioNet decoded-call evidence', () => {
  assert.throws(
    () => parseGenlayerReceiptOutput(studioWriteOutput({
      readable: '{"args":["ROUND-1",]"method":"resolve_round""method":"create_round"}',
    })),
    /duplicate object key: method/,
  );

  const output = studioWriteOutput({
    readable: '{"args":["ROUND-1",]"method":"resolve_round"}',
  }).replace(
    "  result_name: 'MAJORITY_AGREE',",
    `  result_name: 'MAJORITY_AGREE',
  txDataDecoded: {
    type: 'call',
    callData: { method: 'resolve_round', args: [ 'ROUND-2' ] }
  },`,
  );
  assert.throws(
    () => parseGenlayerReceiptOutput(output),
    /conflicting decoded call identity evidence/,
  );
});

test('FINALIZED receipt command uses explicit bounded retry policy', async () => {
  let invocationArgs;
  const receipt = await waitForGenlayerFinalizedReceipt({
    invocation: { executable: 'genlayer', prefixArgs: [] },
    transactionHash: TRANSACTION_HASH,
    retries: 17,
    intervalMs: 321,
    spawnImpl: (_executable, args) => {
      invocationArgs = args;
      return streamingChild({
        stdout: [studioWriteOutput().replace("  status_name: 'FINALIZED',", '  status: 7,')],
      });
    },
    writeStdout: () => {},
    writeStderr: () => {},
  });

  assert.deepEqual(invocationArgs, [
    'receipt', TRANSACTION_HASH, '--status', 'FINALIZED', '--retries', '17', '--interval', '321',
  ]);
  assert.equal(receipt.statusName, 'FINALIZED');
});
