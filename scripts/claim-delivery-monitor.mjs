#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRawGenLayerTransactionResponse,
  verifyRawClaimChildTransaction,
  verifyRawClaimParentTransaction,
} from '../market/genlayer-client.js';
import {
  assertV6ContractConfiguration,
  createCliV6KeeperOperator,
  validateReceiptIdentity as validateV6ReceiptIdentity,
} from './v6-keeper.mjs';
import {
  loadV6KeeperConfig,
  V6_NETWORK,
} from './v6-keeper-config.mjs';
import {
  assertV7ContractConfiguration,
  createCliV7KeeperOperator,
  validateReceiptIdentity as validateV7ReceiptIdentity,
} from './v7-keeper.mjs';
import {
  loadV7KeeperConfig,
  V7_NETWORK,
} from './v7-keeper-config.mjs';

const HASH_PATTERN = /^0x[\da-f]{64}$/;
const ADDRESS_PATTERN = /^0x[\da-f]{40}$/;
const STUDIONET_CHAIN_ID_HEX = '0xf22f';
const DEFAULT_STUDIONET_RPC_URL = 'https://studio.genlayer.com/api';
const ACTIVITY_STORAGE_KEY = 'liquidity-arena:activity:v2';
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS = 1_000;
const DEFAULT_PROTOCOL = 'v6';
const PROTOCOLS = Object.freeze({
  v6: Object.freeze({
    alias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    network: V6_NETWORK,
    loadConfig: loadV6KeeperConfig,
    createKeeperOperator: createCliV6KeeperOperator,
    assertContractConfiguration: assertV6ContractConfiguration,
    validateReceiptIdentity: validateV6ReceiptIdentity,
  }),
  v7: Object.freeze({
    alias: 'v7',
    protocolVersion: 'LIQUIDITY_ARENA_V7',
    network: V7_NETWORK,
    loadConfig: loadV7KeeperConfig,
    createKeeperOperator: createCliV7KeeperOperator,
    assertContractConfiguration: assertV7ContractConfiguration,
    validateReceiptIdentity: validateV7ReceiptIdentity,
  }),
});

export class ClaimDeliveryMonitorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaimDeliveryMonitorError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ClaimDeliveryMonitorError(code, message, details);
}

function protocolDefinition(value = DEFAULT_PROTOCOL) {
  const alias = String(value ?? '').trim().toLowerCase();
  const definition = PROTOCOLS[alias];
  if (!definition) fail('PROTOCOL', 'protocol must be exactly v6 or v7');
  return definition;
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INPUT_SCHEMA', `${field} must be an object`);
  }
  return value;
}

function normalizedHash(value, field) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!HASH_PATTERN.test(result)) fail('INPUT_SCHEMA', `${field} is not a 32-byte transaction hash`);
  return result;
}

function normalizedAddress(value, field) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(result) || /^0x0{40}$/.test(result)) {
    fail('INPUT_SCHEMA', `${field} is not a nonzero address`);
  }
  return result;
}

function unsignedBigInt(value, field, { positive = false } = {}) {
  let result;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) result = BigInt(value.trim());
  else fail('INPUT_SCHEMA', `${field} must be an unsigned integer`);
  if (result < 0n || (positive && result === 0n)) {
    fail('INPUT_SCHEMA', `${field} must be ${positive ? 'positive' : 'nonnegative'}`);
  }
  return result;
}

function singleField(object, names, field, { required = true } = {}) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length > 1) fail('PROOF_AMBIGUOUS', `${field} has conflicting aliases`);
  if (present.length === 0) {
    if (required) fail('PROOF_MISSING', `${field} is missing`);
    return undefined;
  }
  return object[present[0]];
}

function exactAddressAliases(object, names, expected, field) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length === 0) fail('PROOF_MISSING', `${field} is missing`);
  const values = present.map((name) => normalizedAddress(object[name], `${field}.${name}`));
  if (new Set(values).size !== 1 || values[0] !== expected) {
    fail('PROOF_IDENTITY', `${field} does not match ${expected}`);
  }
  return values[0];
}

function deriveAddressAliases(object, names, field) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length === 0) fail('PROOF_MISSING', `${field} is missing`);
  const values = present.map((name) => normalizedAddress(object[name], `${field}.${name}`));
  if (new Set(values).size !== 1) fail('PROOF_AMBIGUOUS', `${field} reports conflicting addresses`);
  return values[0];
}

function exactRawInteger(value, expected, field) {
  if (unsignedBigInt(value, field) !== expected) {
    fail('PROOF_IDENTITY', `${field} must be ${expected.toString()}`);
  }
}

function assertStudioNet(networkInfo, chainId, expectedNetwork) {
  const alias = String(networkInfo?.alias ?? '').trim().toLowerCase();
  if (alias !== expectedNetwork) {
    fail('NETWORK_MISMATCH', `Active GenLayer network must be ${expectedNetwork}`);
  }
  if (String(chainId ?? '').trim().toLowerCase() !== STUDIONET_CHAIN_ID_HEX) {
    fail('NETWORK_MISMATCH', `Raw proof endpoint is not StudioNet chain ${STUDIONET_CHAIN_ID_HEX}`);
  }
}

function activityArray(value) {
  if (Array.isArray(value)) return value;
  const root = plainObject(value, 'activity JSON root');
  if (Object.hasOwn(root, ACTIVITY_STORAGE_KEY)) {
    const stored = root[ACTIVITY_STORAGE_KEY];
    if (Array.isArray(stored)) return stored;
    if (typeof stored !== 'string') {
      fail('INPUT_SCHEMA', `${ACTIVITY_STORAGE_KEY} must be an array or JSON string`);
    }
    let parsed;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      fail('INPUT_JSON', `${ACTIVITY_STORAGE_KEY} contains invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed)) fail('INPUT_SCHEMA', `${ACTIVITY_STORAGE_KEY} must contain an array`);
    return parsed;
  }
  for (const field of ['records', 'activity', 'claims']) {
    if (Object.hasOwn(root, field)) {
      if (!Array.isArray(root[field])) fail('INPUT_SCHEMA', `${field} must be an array`);
      return root[field];
    }
  }
  fail('INPUT_SCHEMA', 'activity JSON must be an array or contain records/activity/claims');
  return [];
}

export function loadClaimActivityFile(activityPath) {
  const absolutePath = resolve(activityPath);
  let source;
  try {
    source = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    fail('INPUT_READ', `Unable to read ${absolutePath}: ${error.message}`);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) {
    fail('INPUT_SIZE', `Activity input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail('INPUT_JSON', `Activity input is invalid JSON: ${error.message}`);
  }
  return activityArray(value);
}

function activityTarget(raw, contractAddress, protocol) {
  if (typeof raw === 'string') {
    return Object.freeze({ hash: normalizedHash(raw, 'activity parent hash'), source: 'activity-hash' });
  }
  const record = plainObject(raw, 'activity record');
  const type = String(record.type ?? '').trim().toUpperCase();
  if (type !== 'CLAIM') return null;
  const deploymentAlias = String(record.deploymentAlias ?? '').trim().toLowerCase();
  if (deploymentAlias && !PROTOCOLS[deploymentAlias]) {
    fail('INPUT_SCHEMA', 'activity deploymentAlias must be v6 or v7');
  }
  const recordProtocolVersion = String(record.protocolVersion ?? '').trim().toUpperCase();
  const protocolFromVersion = Object.values(PROTOCOLS)
    .find((definition) => definition.protocolVersion === recordProtocolVersion)?.alias ?? '';
  if (recordProtocolVersion && !protocolFromVersion) {
    fail('INPUT_SCHEMA', 'activity protocolVersion must be LIQUIDITY_ARENA_V6 or LIQUIDITY_ARENA_V7');
  }
  if (deploymentAlias && protocolFromVersion && deploymentAlias !== protocolFromVersion) {
    fail('INPUT_SCHEMA', 'activity deploymentAlias and protocolVersion conflict');
  }
  const recordProtocol = deploymentAlias || protocolFromVersion;
  if (recordProtocol && recordProtocol !== protocol.alias) return null;
  const recordContract = normalizedAddress(record.contractAddress, 'activity contractAddress');
  if (recordContract !== contractAddress) return null;
  const target = {
    hash: normalizedHash(record.hash, 'activity claim hash'),
    source: 'activity-record',
    account: normalizedAddress(record.account, 'activity account'),
    amountAtto: unsignedBigInt(record.amountAtto, 'activity amountAtto', { positive: true }),
  };
  if (record.childHash !== undefined && record.childHash !== null && String(record.childHash).trim()) {
    target.childHash = normalizedHash(record.childHash, 'activity childHash');
  }
  if (record.roundId !== undefined && record.roundId !== null && String(record.roundId).trim()) {
    target.epochEndTimestamp = String(record.roundId).trim();
  }
  if (record.objective !== undefined && record.objective !== null && String(record.objective).trim()) {
    const objective = String(record.objective).trim().toUpperCase();
    if (!['HIGH', 'LOW'].includes(objective)) fail('INPUT_SCHEMA', 'activity objective must be HIGH or LOW');
    target.objective = objective;
  }
  return Object.freeze(target);
}

function sameOptional(left, right, field, hash) {
  if (left === undefined || right === undefined) return left ?? right;
  const leftText = typeof left === 'bigint' ? left.toString() : String(left);
  const rightText = typeof right === 'bigint' ? right.toString() : String(right);
  if (leftText !== rightText) fail('INPUT_CONFLICT', `Conflicting ${field} for ${hash}`);
  return left;
}

export function normalizeClaimMonitorTargets({
  parentHashes = [],
  activityRecords = [],
  contractAddress,
  protocol = DEFAULT_PROTOCOL,
}) {
  const selectedProtocol = protocolDefinition(protocol);
  const contract = normalizedAddress(contractAddress, 'contractAddress');
  const candidates = [
    ...parentHashes.map((hash) => Object.freeze({
      hash: normalizedHash(hash, 'parent hash'),
      source: 'argument',
    })),
    ...activityRecords
      .map((record) => activityTarget(record, contract, selectedProtocol))
      .filter(Boolean),
  ];
  if (candidates.length > MAX_TARGETS) fail('INPUT_SIZE', `At most ${MAX_TARGETS} claims can be monitored`);
  const merged = new Map();
  for (const candidate of candidates) {
    const previous = merged.get(candidate.hash);
    if (!previous) {
      merged.set(candidate.hash, candidate);
      continue;
    }
    merged.set(candidate.hash, Object.freeze({
      hash: candidate.hash,
      source: `${previous.source}+${candidate.source}`,
      account: sameOptional(previous.account, candidate.account, 'account', candidate.hash),
      amountAtto: sameOptional(previous.amountAtto, candidate.amountAtto, 'amountAtto', candidate.hash),
      childHash: sameOptional(previous.childHash, candidate.childHash, 'childHash', candidate.hash),
      epochEndTimestamp: sameOptional(
        previous.epochEndTimestamp,
        candidate.epochEndTimestamp,
        'epochEndTimestamp',
        candidate.hash,
      ),
      objective: sameOptional(previous.objective, candidate.objective, 'objective', candidate.hash),
    }));
  }
  if (merged.size === 0) {
    fail('INPUT_EMPTY', `No ${selectedProtocol.alias.toUpperCase()} claim parent hashes were supplied`);
  }
  return Object.freeze([...merged.values()]);
}

function deriveClaimParent(transaction, expectedContract) {
  exactAddressAliases(
    transaction,
    ['to_address', 'toAddress', 'recipient'],
    expectedContract,
    'claim parent contract recipient',
  );
  const claimant = deriveAddressAliases(
    transaction,
    ['from_address', 'fromAddress', 'sender'],
    'claim parent sender',
  );
  exactRawInteger(singleField(transaction, ['type'], 'claim parent type'), 2n, 'claim parent type');
  exactRawInteger(singleField(transaction, ['value'], 'claim parent value'), 0n, 'claim parent value');
  if (!Array.isArray(transaction.messages) || transaction.messages.length !== 1) {
    fail('PROOF_IDENTITY', 'Finalized claim parent must contain exactly one message');
  }
  const message = plainObject(transaction.messages[0], 'claim transfer message');
  const recipient = normalizedAddress(
    singleField(message, ['recipient'], 'claim message recipient'),
    'claim message recipient',
  );
  if (recipient !== claimant) fail('PROOF_IDENTITY', 'Claim message recipient is not the claimant');
  const amountAtto = unsignedBigInt(
    singleField(message, ['value'], 'claim message value'),
    'claim message value',
    { positive: true },
  );
  exactRawInteger(
    singleField(message, ['messageType', 'message_type'], 'claim message type'),
    0n,
    'claim message type',
  );
  if (singleField(message, ['onAcceptance', 'on_acceptance'], 'claim message finality') !== false) {
    fail('PROOF_IDENTITY', 'Claim message was not deferred until parent finalization');
  }
  if (singleField(message, ['data'], 'claim message data') !== '') {
    fail('PROOF_IDENTITY', 'Claim message contains unexpected calldata');
  }
  const triggered = singleField(
    transaction,
    ['triggered_transactions', 'triggeredTransactions'],
    'claim child list',
  );
  if (!Array.isArray(triggered) || triggered.length !== 1) {
    fail('PROOF_IDENTITY', 'Finalized claim parent must report exactly one child');
  }
  return Object.freeze({
    claimant,
    amountAtto,
    childHash: normalizedHash(triggered[0], 'claim child hash'),
  });
}

function claimCallFromReceipt(receipt) {
  const decoded = receipt?.txDataDecoded;
  const method = decoded?.callData?.method;
  const args = decoded?.callData?.args;
  if (decoded?.type !== 'call' || method !== 'claim' || !Array.isArray(args) || args.length !== 2) {
    fail('PARENT_CALL', 'Finalized parent is not an exact claim(epoch, objective) call');
  }
  const epochText = String(args[0] ?? '');
  const epoch = Number(epochText);
  if (!/^\d+$/.test(epochText)
    || !Number.isSafeInteger(epoch)
    || epoch <= 0
    || epoch % 3_600 !== 0) {
    fail('PARENT_CALL', 'Claim epoch is not an exact UTC hour');
  }
  const objective = String(args[1] ?? '').trim().toUpperCase();
  if (!['HIGH', 'LOW'].includes(objective)) fail('PARENT_CALL', 'Claim objective is not HIGH or LOW');
  return Object.freeze({ args: Object.freeze(args.map(String)), epochEndTimestamp: epochText, objective });
}

function assertTargetExpectations(target, derived, call) {
  if (target.account !== undefined && target.account !== derived.claimant) {
    fail('ACTIVITY_MISMATCH', 'Activity account does not match the finalized claim recipient');
  }
  if (target.amountAtto !== undefined && target.amountAtto !== derived.amountAtto) {
    fail('ACTIVITY_MISMATCH', 'Activity amount does not match the finalized claim value');
  }
  if (target.childHash !== undefined && target.childHash !== derived.childHash) {
    fail('ACTIVITY_MISMATCH', 'Activity child hash conflicts with the finalized claim child');
  }
  if (target.epochEndTimestamp !== undefined
    && target.epochEndTimestamp !== call.epochEndTimestamp) {
    fail('ACTIVITY_MISMATCH', 'Activity roundId does not match the finalized claim epoch');
  }
  if (target.objective !== undefined && target.objective !== call.objective) {
    fail('ACTIVITY_MISMATCH', 'Activity objective does not match the finalized claim objective');
  }
}

async function inspectClaimDelivery(context, target) {
  let childHash = target.childHash ?? null;
  try {
    const receipt = await context.operator.waitFinalized(target.hash, {
      retries: context.config.operator.finalityRetries,
      intervalMs: context.config.operator.finalityIntervalMs,
    });
    const call = claimCallFromReceipt(receipt);
    context.protocol.validateReceiptIdentity(
      receipt,
      context.config.contractAddress,
      'claim',
      call.args,
    );

    const parent = await context.operator.getRawTransaction(target.hash);
    const derived = deriveClaimParent(parent, context.contractAddress);
    childHash = derived.childHash;
    assertTargetExpectations(target, derived, call);
    verifyRawClaimParentTransaction(parent, {
      hash: target.hash,
      recipient: derived.claimant,
      amountAtto: derived.amountAtto,
      childHash,
    });

    const child = await context.operator.getRawTransaction(childHash);
    verifyRawClaimChildTransaction(child, {
      hash: childHash,
      parentHash: target.hash,
      recipient: derived.claimant,
      amountAtto: derived.amountAtto,
      contractAddress: context.contractAddress,
    });
    return Object.freeze({
      hash: target.hash,
      status: 'DELIVERED',
      childHash,
      account: derived.claimant,
      amountAtto: derived.amountAtto.toString(),
      epochEndTimestamp: call.epochEndTimestamp,
      objective: call.objective,
    });
  } catch (error) {
    return Object.freeze({
      hash: target.hash,
      status: 'REVIEW',
      childHash,
      code: error?.code || 'DELIVERY_UNVERIFIED',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function monitorClaimDeliveriesOnce({
  config,
  targets,
  operator,
  protocol = DEFAULT_PROTOCOL,
  logger = (event) => console.log(JSON.stringify(event)),
}) {
  if (!config || !operator || !Array.isArray(targets) || targets.length === 0) {
    fail('MONITOR_ARGUMENT', 'config, operator, and at least one target are required');
  }
  const selectedProtocol = protocolDefinition(protocol);
  const networkInfo = await operator.getNetworkInfo();
  const chainId = await operator.getChainId();
  assertStudioNet(networkInfo, chainId, selectedProtocol.network);
  const [contractConfig, assetCatalog, venueCatalog] = await Promise.all([
    operator.getConfig(),
    operator.getAssetCatalog(),
    operator.getVenueCatalog(),
  ]);
  selectedProtocol.assertContractConfiguration(
    config,
    contractConfig,
    assetCatalog,
    venueCatalog,
  );
  const contractAddress = normalizedAddress(config.contractAddress, 'contractAddress');
  const context = {
    config,
    operator,
    logger,
    contractAddress,
    protocol: selectedProtocol,
  };

  const results = [];
  for (const target of targets) {
    const result = await inspectClaimDelivery(context, target);
    results.push(result);
    logger({
      event: result.status === 'DELIVERED'
        ? 'CLAIM_DELIVERY_VERIFIED'
        : 'CLAIM_DELIVERY_REVIEW_REQUIRED',
      protocol: selectedProtocol.alias,
      ...result,
    });
  }
  const deliveredCount = results.filter((result) => result.status === 'DELIVERED').length;
  return Object.freeze({
    protocol: selectedProtocol.alias,
    contractAddress,
    checkedCount: results.length,
    deliveredCount,
    reviewCount: results.length - deliveredCount,
    results: Object.freeze(results),
  });
}

function rpcUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_STUDIONET_RPC_URL));
  } catch {
    fail('RPC_URL', 'StudioNet RPC URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('RPC_URL', 'StudioNet RPC URL must be credential-free HTTPS');
  }
  return url.toString();
}

async function rawRpcRequest(endpoint, method, params, fetchImpl) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response?.ok) fail('RPC_HTTP', `StudioNet RPC returned HTTP ${response?.status ?? 'unknown'}`);
  return response.text();
}

export function createCliClaimDeliveryOperator({
  config,
  protocol = DEFAULT_PROTOCOL,
  rpcEndpoint = DEFAULT_STUDIONET_RPC_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') fail('RPC_FETCH', 'A fetch implementation is required');
  const endpoint = rpcUrl(rpcEndpoint);
  const selectedProtocol = protocolDefinition(protocol);
  const base = selectedProtocol.createKeeperOperator({ config });
  return Object.freeze({
    getNetworkInfo: base.getNetworkInfo,
    getConfig: base.getConfig,
    getAssetCatalog: base.getAssetCatalog,
    getVenueCatalog: base.getVenueCatalog,
    waitFinalized: base.waitFinalized,
    async getChainId() {
      const text = await rawRpcRequest(endpoint, 'eth_chainId', [], fetchImpl);
      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch (error) {
        fail('RPC_JSON', `StudioNet chain ID response is invalid JSON: ${error.message}`);
      }
      if (envelope?.jsonrpc !== '2.0' || envelope?.id !== 1 || typeof envelope?.result !== 'string') {
        fail('RPC_JSON', 'StudioNet chain ID response is malformed');
      }
      return envelope.result;
    },
    async getRawTransaction(hash) {
      const expectedHash = normalizedHash(hash, 'raw transaction hash');
      const text = await rawRpcRequest(
        endpoint,
        'eth_getTransactionByHash',
        [expectedHash],
        fetchImpl,
      );
      return parseRawGenLayerTransactionResponse(text, expectedHash);
    },
  });
}

function usage() {
  return `Verify finalized V6 or V7 claim payout delivery without sending transactions.\n\nUsage:\n  node scripts/claim-delivery-monitor.mjs --protocol <v6|v7> --config <file> (--parent <hash> ... | --activity <file>) [--rpc-url <url>]\n\nOptions:\n  --protocol <v6|v7> Exact deployment protocol (defaults to v6 for backward compatibility)\n  --config <file>     Corresponding V6 or V7 keeper JSON configuration (required)\n  --parent <hash>     Recorded claim parent hash; may be repeated\n  --activity <file>   Browser activity JSON export or claim-record array\n  --rpc-url <url>     Lossless StudioNet JSON-RPC endpoint\n  --help              Show this help\n\nThe monitor is read-only. It reports DELIVERED only after exact parent and child proof, including FINALIZED child state, exact parent/child link, contract, recipient, value, trigger, and value_credited=true. REVIEW never triggers a retry or payout.`;
}

function parseArguments(argv) {
  const parsed = { parentHashes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (['--protocol', '--config', '--parent', '--activity', '--rpc-url'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--protocol') parsed.protocol = value;
      else if (argument === '--config') parsed.configPath = value;
      else if (argument === '--parent') parsed.parentHashes.push(value);
      else if (argument === '--activity') parsed.activityPath = value;
      else parsed.rpcEndpoint = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return parsed;
}

export async function runClaimDeliveryMonitorCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(usage());
    return undefined;
  }
  if (!parsed.configPath) throw new Error('--config is required');
  if (parsed.parentHashes.length === 0 && !parsed.activityPath) {
    throw new Error('At least one --parent or --activity is required');
  }
  const selectedProtocol = protocolDefinition(parsed.protocol ?? DEFAULT_PROTOCOL);
  const config = selectedProtocol.loadConfig(parsed.configPath);
  const activityRecords = parsed.activityPath ? loadClaimActivityFile(parsed.activityPath) : [];
  const targets = normalizeClaimMonitorTargets({
    parentHashes: parsed.parentHashes,
    activityRecords,
    contractAddress: config.contractAddress,
    protocol: selectedProtocol.alias,
  });
  const operator = createCliClaimDeliveryOperator({
    config,
    protocol: selectedProtocol.alias,
    rpcEndpoint: parsed.rpcEndpoint || process.env.GENLAYER_RPC_URL || DEFAULT_STUDIONET_RPC_URL,
  });
  return monitorClaimDeliveriesOnce({
    config,
    targets,
    operator,
    protocol: selectedProtocol.alias,
  });
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && process.argv[1] === invokedPath) {
  runClaimDeliveryMonitorCli().then((summary) => {
    if (summary?.reviewCount > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(JSON.stringify({
      event: 'CLAIM_DELIVERY_MONITOR_FAILED',
      code: error?.code || 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}

export {
  ACTIVITY_STORAGE_KEY,
  DEFAULT_STUDIONET_RPC_URL,
};
