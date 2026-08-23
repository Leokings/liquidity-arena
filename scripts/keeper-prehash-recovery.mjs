import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Interface, id as ethersId } from 'ethers';

import { createKeeperJournalClientFromEnvironment } from '../keeper-journal/client.mjs';
import { requireKeeperJournalSignerAddress } from '../keeper-journal/config.mjs';
import { keeperPrehashEvidenceDigest } from '../keeper-journal/schema.mjs';
import { createAuthoritativeKeeperSession } from './authoritative-keeper-journal.mjs';
import {
  parseGenlayerCallOutput,
  resolveGenlayerCommand,
} from './genlayer-command.mjs';

const OPERATION_ID = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const MAX_EVIDENCE_BYTES = 32 * 1024;
const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BLOCK_SPAN = 512n;
const RPC_TIMEOUT_MS = 10_000;
const GENLAYER_CALL_TIMEOUT_MS = 30_000;
const MAX_GENLAYER_CALL_OUTPUT_BYTES = 64 * 1024;
export const BRADBURY_RECOVERY_RPC_URL = 'https://rpc-bradbury.genlayer.com';
export const BRADBURY_RECOVERY_CHAIN_ID = 4_221n;
export const BRADBURY_CONSENSUS_ADDRESS = '0x0112bf6e83497965a5fdd6dad1e447a6e004271d';
export const NEW_TRANSACTION_TOPIC = ethersId(
  'NewTransaction(bytes32,address,address)',
).toLowerCase();
const ADD_TRANSACTION_INTERFACE = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);

function recoveryFailure(message) {
  throw recoveryError(message);
}

function recoveryError(message) {
  const error = new Error(message);
  error.code = 'KEEPER_PREHASH_CHAIN_EVIDENCE_INVALID';
  return error;
}

function exactLowerAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) recoveryFailure(`${label} is invalid.`);
  return value;
}

function exactLowerHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) recoveryFailure(`${label} is invalid.`);
  return value;
}

function decimal(value, label) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    recoveryFailure(`${label} is not a canonical decimal string.`);
  }
  return BigInt(value);
}

function quantity(value, label) {
  if (typeof value !== 'string' || !QUANTITY.test(value)) recoveryFailure(`${label} is invalid.`);
  return BigInt(value);
}

function blockTag(value) {
  return `0x${value.toString(16)}`;
}

function timestamp(block, label) {
  const seconds = quantity(block.timestamp, `${label}.timestamp`);
  if (seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))) {
    recoveryFailure(`${label}.timestamp is out of range.`);
  }
  return new Date(Number(seconds) * 1_000).toISOString();
}

function exactBlock(block, expectedNumber, fullTransactions, label) {
  if (!block || typeof block !== 'object' || Array.isArray(block)
      || quantity(block.number, `${label}.number`) !== expectedNumber
      || !HASH.test(String(block.hash || '').toLowerCase())
      || !Array.isArray(block.transactions)) {
    recoveryFailure(`${label} is not the requested canonical block.`);
  }
  if (fullTransactions && block.transactions.some((transaction) => (
    !transaction || typeof transaction !== 'object' || Array.isArray(transaction)
    || !ADDRESS.test(String(transaction.from || '').toLowerCase())
  ))) recoveryFailure(`${label} did not return full transaction sender objects.`);
  return block;
}

export function createBradburyRecoveryRpc({
  fetchImpl = globalThis.fetch,
  timeoutMs = RPC_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RPC_TIMEOUT_MS) {
    throw new Error('Bradbury RPC timeout is invalid.');
  }
  let requestId = 0;
  return async (method, params) => {
    const id = ++requestId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(BRADBURY_RECOVERY_RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!response?.ok) recoveryFailure(`Bradbury RPC ${method} failed.`);
      const source = await response.text();
      if (Buffer.byteLength(source, 'utf8') > MAX_RPC_RESPONSE_BYTES) {
        recoveryFailure(`Bradbury RPC ${method} response is too large.`);
      }
      let payload;
      try { payload = JSON.parse(source); } catch { recoveryFailure(`Bradbury RPC ${method} returned invalid JSON.`); }
      if (!payload || payload.jsonrpc !== '2.0' || payload.id !== id
          || Object.hasOwn(payload, 'error') || !Object.hasOwn(payload, 'result')) {
        recoveryFailure(`Bradbury RPC ${method} returned an invalid result.`);
      }
      return payload.result;
    } catch (error) {
      if (error?.code === 'KEEPER_PREHASH_CHAIN_EVIDENCE_INVALID') throw error;
      if (controller.signal.aborted) recoveryFailure(`Bradbury RPC ${method} timed out.`);
      recoveryFailure(`Bradbury RPC ${method} failed.`);
    } finally {
      clearTimeout(timer);
    }
  };
}

function assertEvidenceIdentityBeforeRpc(evidence, operationId, signerAddress) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || evidence.operationId !== operationId) {
    recoveryFailure('Audited evidence operationId does not match --operation-id.');
  }
  if (evidence.evidenceVersion !== 'BRADBURY_KEEPER_EVM_SCAN_V1'
      || evidence.network !== 'bradbury' || evidence.chainId !== '4221') {
    recoveryFailure('Audited evidence is not for Bradbury chain 4221.');
  }
  if (!['create_epoch', 'resolve_epoch'].includes(evidence.method)
      || evidence.subjectType !== 'epoch'
      || !Array.isArray(evidence.arguments) || evidence.arguments.length !== 1
      || evidence.arguments[0] !== evidence.subjectId
      || evidence.postStateStatus !== (evidence.method === 'create_epoch'
        ? 'EPOCH_UNKNOWN' : 'TARGET_STATE_UNCHANGED')) {
    recoveryFailure('Audited recovery is restricted to an exact create_epoch or resolve_epoch subject.');
  }
  const signer = exactLowerAddress(signerAddress, 'configured signer');
  if (exactLowerAddress(evidence.signerAddress, 'evidence.signerAddress') !== signer
      || exactLowerAddress(evidence.referenceOuterSender, 'evidence.referenceOuterSender') !== signer
      || exactLowerAddress(evidence.referenceCallSender, 'evidence.referenceCallSender') !== signer) {
    recoveryFailure('Audited evidence signer identity does not match the configured keeper.');
  }
  if (exactLowerAddress(evidence.referenceConsensusRecipient, 'evidence.referenceConsensusRecipient')
      !== BRADBURY_CONSENSUS_ADDRESS) {
    recoveryFailure('Audited evidence consensus recipient is not Bradbury consensus.');
  }
  if (exactLowerAddress(evidence.contractAddress, 'evidence.contractAddress')
      !== exactLowerAddress(evidence.referenceCallRecipient, 'evidence.referenceCallRecipient')) {
    recoveryFailure('Audited evidence target contract identity is inconsistent.');
  }
  exactLowerHash(evidence.referenceOuterTransactionHash, 'evidence.referenceOuterTransactionHash');
  exactLowerHash(evidence.referenceEventTransactionId, 'evidence.referenceEventTransactionId');
}

export function assertResolvableEpochPostState(value, evidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || String(value.epoch_id ?? '') !== evidence.subjectId
      || String(value.epoch_end_timestamp ?? '') !== evidence.subjectId
      || value.status !== 'OPEN'
      || value.result_status !== 'PENDING'
      || value.resolution_digest !== ''
      || value.phase !== 'RESOLVABLE'
      || !value.high || typeof value.high !== 'object' || Array.isArray(value.high)
      || !value.low || typeof value.low !== 'object' || Array.isArray(value.low)
      || value.high.settlement_mode !== 'PENDING'
      || value.low.settlement_mode !== 'PENDING') {
    recoveryFailure('Live target is not the exact unchanged OPEN/RESOLVABLE epoch.');
  }
  return Object.freeze({
    epochId: evidence.subjectId,
    status: 'OPEN',
    resultStatus: 'PENDING',
    phase: 'RESOLVABLE',
    highSettlementMode: 'PENDING',
    lowSettlementMode: 'PENDING',
  });
}

export function assertEpochUnknownPostState(value, evidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3
      || value.kind !== 'EXPECTED_CONTRACT_ERROR'
      || value.code !== 'EPOCH_UNKNOWN'
      || value.message !== 'Epoch does not exist'
      || evidence.postStateStatus !== 'EPOCH_UNKNOWN') {
    recoveryFailure('Live target did not prove the exact EPOCH_UNKNOWN create_epoch pre-state.');
  }
  return Object.freeze({
    epochId: evidence.subjectId,
    status: 'EPOCH_UNKNOWN',
  });
}

export function assertAuditedEpochPostState(value, evidence) {
  if (evidence.method === 'create_epoch') return assertEpochUnknownPostState(value, evidence);
  if (evidence.method === 'resolve_epoch') return assertResolvableEpochPostState(value, evidence);
  recoveryFailure('Audited recovery method is not supported.');
}

function exactEpochUnknownFailure(source) {
  const clean = String(source).replace(/\u001b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  const marker = '[EXPECTED] EPOCH_UNKNOWN: Epoch does not exist';
  return clean.split(marker).length === 2
    && !/(?:^|\n).*\[EXPECTED\] [A-Z][A-Z0-9_]{0,79}:/.test(
      clean.replace(marker, ''),
    );
}

export async function readBradburyRecoveryEpoch({
  contractAddress,
  subjectId,
  invocation = resolveGenlayerCommand(),
  spawnImpl = nodeSpawn,
  timeoutMs = GENLAYER_CALL_TIMEOUT_MS,
} = {}) {
  exactLowerAddress(contractAddress, 'recovery target contract');
  if (typeof subjectId !== 'string' || !DECIMAL.test(subjectId)) {
    recoveryFailure('Recovery epoch subject is invalid.');
  }
  if (!invocation || typeof invocation.executable !== 'string'
      || !Array.isArray(invocation.prefixArgs) || typeof spawnImpl !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || timeoutMs > GENLAYER_CALL_TIMEOUT_MS) {
    recoveryFailure('Recovery GenLayer call process configuration is invalid.');
  }
  const output = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(
        invocation.executable,
        [
          ...invocation.prefixArgs,
          'call',
          contractAddress,
          'get_epoch',
          '--rpc',
          BRADBURY_RECOVERY_RPC_URL,
          '--args',
          subjectId,
        ],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch {
      reject(recoveryError('Recovery GenLayer call process could not be started.'));
      return;
    }
    let settled = false;
    let source = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const append = (chunk) => {
      if (settled) return;
      source += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(source, 'utf8') > MAX_GENLAYER_CALL_OUTPUT_BYTES) {
        child.kill?.();
        finish(recoveryError('Recovery GenLayer call output exceeded its bound.'));
      }
    };
    const timer = setTimeout(() => {
      child.kill?.();
      finish(recoveryError('Recovery GenLayer call timed out.'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once?.('error', () => {
      finish(recoveryError('Recovery GenLayer call process failed.'));
    });
    child.once?.('close', (status) => {
      if (status !== 0) {
        if (exactEpochUnknownFailure(source)) {
          finish(null, Object.freeze({
            kind: 'EXPECTED_CONTRACT_ERROR',
            code: 'EPOCH_UNKNOWN',
            message: 'Epoch does not exist',
          }));
        } else {
          finish(recoveryError('Recovery GenLayer call process exited unsuccessfully.'));
        }
      } else {
        finish(null, Object.freeze({ kind: 'SUCCESS', source }));
      }
    });
  });
  if (output.kind === 'EXPECTED_CONTRACT_ERROR') return output;
  try {
    return parseGenlayerCallOutput(output.source);
  } catch {
    recoveryFailure('Recovery GenLayer call returned an invalid result.');
  }
}

function assertReferenceCall(transaction, evidence) {
  const input = String(transaction.input ?? transaction.data ?? '').toLowerCase();
  let parsed;
  try { parsed = ADD_TRANSACTION_INTERFACE.parseTransaction({ data: input }); } catch {
    recoveryFailure('Reference outer transaction is not canonical addTransaction calldata.');
  }
  if (!parsed || parsed.name !== 'addTransaction') recoveryFailure('Reference outer transaction is not addTransaction.');
  const canonical = ADD_TRANSACTION_INTERFACE.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase();
  if (canonical !== input) recoveryFailure('Reference addTransaction calldata is not canonical.');
  if (String(parsed.args[0]).toLowerCase() !== evidence.referenceCallSender
      || String(parsed.args[1]).toLowerCase() !== evidence.referenceCallRecipient) {
    recoveryFailure('Reference addTransaction sender or recipient does not match evidence.');
  }
}

export async function verifyAuditedPrehashChainEvidence({
  evidence,
  operationId,
  signerAddress,
  rpcCall = createBradburyRecoveryRpc(),
} = {}) {
  assertEvidenceIdentityBeforeRpc(evidence, operationId, signerAddress);
  const start = decimal(evidence.scanStartBlock, 'evidence.scanStartBlock');
  const end = decimal(evidence.scanEndBlock, 'evidence.scanEndBlock');
  if (start === 0n || start > end || end - start > MAX_SCAN_BLOCK_SPAN) {
    recoveryFailure('Audited scan block range is invalid or exceeds the recovery bound.');
  }
  const expectedNonce = decimal(evidence.nonceAtStart, 'evidence.nonceAtStart');
  if (evidence.matchingOuterTransactions !== '0'
      || decimal(evidence.nonceAtEnd, 'evidence.nonceAtEnd') !== expectedNonce
      || decimal(evidence.latestNonce, 'evidence.latestNonce') !== expectedNonce
      || decimal(evidence.pendingNonce, 'evidence.pendingNonce') !== expectedNonce) {
    recoveryFailure('Audited evidence does not claim one unchanged signer nonce.');
  }

  if (quantity(await rpcCall('eth_chainId', []), 'eth_chainId') !== BRADBURY_RECOVERY_CHAIN_ID) {
    recoveryFailure('Bradbury recovery RPC chainId is not 4221.');
  }

  const referenceBlockNumber = decimal(evidence.referenceOuterBlock, 'evidence.referenceOuterBlock');
  const finalizedHead = await rpcCall('eth_getBlockByNumber', ['finalized', false]);
  const finalizedNumber = quantity(finalizedHead?.number, 'finalized block number');
  exactBlock(finalizedHead, finalizedNumber, false, 'finalized block');
  if (finalizedNumber < referenceBlockNumber || finalizedNumber < end) {
    recoveryFailure('Audited scan range or reference transaction is not finalized on Bradbury.');
  }

  let startBlock;
  let endBlock;
  for (let number = start; number <= end; number += 1n) {
    const block = exactBlock(
      await rpcCall('eth_getBlockByNumber', [blockTag(number), true]),
      number,
      true,
      `scan block ${number}`,
    );
    if (number === start) startBlock = block;
    if (number === end) endBlock = block;
    if (block.transactions.some((transaction) => String(transaction.from).toLowerCase() === signerAddress)) {
      recoveryFailure(`Keeper outer transaction exists inside audited scan block ${number}.`);
    }
  }
  if (timestamp(startBlock, 'scan start block') !== evidence.scanStartTimestamp
      || timestamp(endBlock, 'scan end block') !== evidence.scanEndTimestamp) {
    recoveryFailure('Audited scan block timestamps do not match Bradbury.');
  }

  const nonceChecks = [
    ['scan boundary', blockTag(start - 1n), evidence.nonceAtStart],
    ['scan end', blockTag(end), evidence.nonceAtEnd],
    ['latest', 'latest', evidence.latestNonce],
    ['pending', 'pending', evidence.pendingNonce],
  ];
  for (const [label, tag, claimed] of nonceChecks) {
    const observed = quantity(
      await rpcCall('eth_getTransactionCount', [signerAddress, tag]),
      `${label} nonce`,
    );
    if (observed !== decimal(claimed, `evidence ${label} nonce`)) {
      recoveryFailure(`Keeper ${label} nonce does not match evidence.`);
    }
  }

  const referenceHash = evidence.referenceOuterTransactionHash;
  const [transaction, receipt, referenceBlock] = await Promise.all([
    rpcCall('eth_getTransactionByHash', [referenceHash]),
    rpcCall('eth_getTransactionReceipt', [referenceHash]),
    rpcCall('eth_getBlockByNumber', [blockTag(referenceBlockNumber), false]),
  ]);
  const canonicalReferenceBlock = exactBlock(referenceBlock, referenceBlockNumber, false, 'reference block');
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)
      || String(transaction.hash || '').toLowerCase() !== referenceHash
      || String(transaction.from || '').toLowerCase() !== evidence.referenceOuterSender
      || String(transaction.to || '').toLowerCase() !== evidence.referenceConsensusRecipient
      || quantity(transaction.nonce, 'reference transaction nonce')
        !== decimal(evidence.referenceOuterNonce, 'evidence.referenceOuterNonce')
      || quantity(transaction.blockNumber, 'reference transaction blockNumber') !== referenceBlockNumber
      || String(transaction.blockHash || '').toLowerCase() !== String(canonicalReferenceBlock.hash).toLowerCase()) {
    recoveryFailure('Reference outer transaction does not match audited evidence.');
  }
  assertReferenceCall(transaction, evidence);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || String(receipt.transactionHash || '').toLowerCase() !== referenceHash
      || quantity(receipt.status, 'reference receipt status') !== 1n
      || quantity(receipt.blockNumber, 'reference receipt blockNumber') !== referenceBlockNumber
      || String(receipt.blockHash || '').toLowerCase() !== String(canonicalReferenceBlock.hash).toLowerCase()
      || !Array.isArray(receipt.logs)) {
    recoveryFailure('Reference outer receipt is not a canonical successful receipt.');
  }
  const matchingLogs = receipt.logs.filter((log) => (
    String(log?.address || '').toLowerCase() === BRADBURY_CONSENSUS_ADDRESS
    && Array.isArray(log?.topics)
    && String(log.topics[0] || '').toLowerCase() === NEW_TRANSACTION_TOPIC
  ));
  if (matchingLogs.length !== 1 || matchingLogs[0].topics.length !== 4
      || String(matchingLogs[0].data || '').toLowerCase() !== '0x'
      || String(matchingLogs[0].transactionHash || '').toLowerCase() !== referenceHash
      || String(matchingLogs[0].blockHash || '').toLowerCase()
        !== String(canonicalReferenceBlock.hash).toLowerCase()
      || String(matchingLogs[0].topics[1] || '').toLowerCase()
        !== evidence.referenceEventTransactionId) {
    recoveryFailure('Reference NewTransaction topic1 does not match audited inner transaction id.');
  }
  return Object.freeze({
    chainId: BRADBURY_RECOVERY_CHAIN_ID.toString(),
    signerAddress,
    scanStartBlock: start.toString(),
    scanEndBlock: end.toString(),
    referenceOuterTransactionHash: referenceHash,
    referenceEventTransactionId: evidence.referenceEventTransactionId,
  });
}

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--operation-id', '--evidence-json'].includes(flag) || !value) {
      throw new Error('Usage: --operation-id <64-hex> --evidence-json <path>');
    }
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const operationId = String(values.get('--operation-id') || '').toLowerCase();
  const evidencePath = String(values.get('--evidence-json') || '');
  if (!OPERATION_ID.test(operationId) || !evidencePath || values.size !== 2) {
    throw new Error('Usage: --operation-id <64-hex> --evidence-json <path>');
  }
  return Object.freeze({ operationId, evidencePath });
}

async function readEvidence(path) {
  const source = await readFile(path);
  if (source.byteLength < 2 || source.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error('Audited pre-hash evidence file size is invalid.');
  }
  const evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source));
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Audited pre-hash evidence must be one JSON object.');
  }
  const expectedDigest = keeperPrehashEvidenceDigest(evidence);
  if (evidence.queryResultSha256 !== expectedDigest) {
    throw new Error('Audited pre-hash evidence digest does not match its canonical fields.');
  }
  return evidence;
}

export async function runKeeperPrehashRecovery({
  argv = process.argv.slice(2),
  environment = process.env,
  client = null,
  rpcCall = null,
  targetStateReader = readBradburyRecoveryEpoch,
  logger = (event) => console.log(JSON.stringify(event)),
} = {}) {
  const { operationId, evidencePath } = argumentsFrom(argv);
  const evidence = await readEvidence(evidencePath);
  if (String(evidence.operationId || '').toLowerCase() !== operationId) {
    throw new Error('Audited evidence operationId does not match --operation-id.');
  }
  const signerAddress = requireKeeperJournalSignerAddress(environment);
  await verifyAuditedPrehashChainEvidence({
    evidence,
    operationId,
    signerAddress,
    rpcCall: rpcCall || createBradburyRecoveryRpc(),
  });
  assertAuditedEpochPostState(
    await targetStateReader({
      contractAddress: evidence.contractAddress,
      subjectId: evidence.subjectId,
      method: evidence.method,
    }),
    evidence,
  );
  const journalClient = client || createKeeperJournalClientFromEnvironment(environment);
  const session = createAuthoritativeKeeperSession({
    client: journalClient,
    signerAddress,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    logger: () => {},
  });
  await session.acquire();
  try {
    const response = await session.abandonPrehash(
      operationId,
      'AUDITED_NO_BROADCAST',
      evidence,
    );
    const operation = response?.operation;
    if (operation?.operationId !== operationId
        || operation?.state !== 'ABANDONED_PREHASH'
        || operation?.stateReasonCode !== 'AUDITED_NO_BROADCAST') {
      throw new Error('Keeper journal returned an unexpected abandonment result.');
    }
    const result = Object.freeze({
      event: 'KEEPER_PREHASH_AUDITED_ABANDONMENT_RECORDED',
      operationId,
      state: operation.state,
      reasonCode: operation.stateReasonCode,
      prehashAbandonedAt: operation.prehashAbandonedAt,
      evidenceSha256: evidence.queryResultSha256,
    });
    logger(result);
    return result;
  } finally {
    await session.release();
  }
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKeeperPrehashRecovery().catch((error) => {
    const code = String(error?.code || error?.name || 'RECOVERY_FAILED')
      .toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 256);
    console.error(JSON.stringify({ event: 'KEEPER_PREHASH_RECOVERY_FAILED', code, message }));
    process.exitCode = 1;
  });
}
