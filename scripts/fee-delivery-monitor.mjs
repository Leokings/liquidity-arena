#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createCliClaimDeliveryOperator } from './claim-delivery-monitor.mjs';
import {
  assertV7ContractConfiguration,
  validateReceiptIdentity,
} from './v7-keeper.mjs';
import {
  loadV7KeeperConfig,
  V7_NETWORK,
} from './v7-keeper-config.mjs';

const HASH_PATTERN = /^0x[\da-f]{64}$/;
const ADDRESS_PATTERN = /^0x[\da-f]{40}$/;
const STUDIONET_CHAIN_ID_HEX = '0xf22f';
const DEFAULT_STUDIONET_RPC_URL = 'https://studio.genlayer.com/api';
const MAX_TARGETS = 1_000;
const U256_MAX = (1n << 256n) - 1n;

export class FeeDeliveryMonitorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FeeDeliveryMonitorError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new FeeDeliveryMonitorError(code, message, details);
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('PROOF_SCHEMA', `${field} must be an object`);
  }
  return value;
}

function normalizedHash(value, field) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!HASH_PATTERN.test(result)) fail('PROOF_SCHEMA', `${field} is not a 32-byte transaction hash`);
  return result;
}

function normalizedAddress(value, field, { allowZero = false } = {}) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(result) || (!allowZero && /^0x0{40}$/.test(result))) {
    fail('PROOF_SCHEMA', `${field} is not a ${allowZero ? '' : 'nonzero '}address`);
  }
  return result;
}

function unsignedBigInt(value, field, { positive = false, u256 = false } = {}) {
  let result;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) result = BigInt(value.trim());
  else fail('PROOF_SCHEMA', `${field} must be an unsigned integer`);
  if (result < 0n || (positive && result === 0n)) {
    fail('PROOF_SCHEMA', `${field} must be ${positive ? 'positive' : 'nonnegative'}`);
  }
  if (u256 && result > U256_MAX) fail('PROOF_SCHEMA', `${field} exceeds u256`);
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

function exactHashAliases(object, names, expected, field) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length === 0) fail('PROOF_MISSING', `${field} is missing`);
  const values = present.map((name) => normalizedHash(object[name], `${field}.${name}`));
  if (new Set(values).size !== 1 || values[0] !== expected) {
    fail('PROOF_IDENTITY', `${field} does not match ${expected}`);
  }
  return expected;
}

function exactAddressAliases(object, names, expected, field) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length === 0) fail('PROOF_MISSING', `${field} is missing`);
  const values = present.map((name) => normalizedAddress(object[name], `${field}.${name}`));
  if (new Set(values).size !== 1 || values[0] !== expected) {
    fail('PROOF_IDENTITY', `${field} does not match ${expected}`);
  }
  return expected;
}

function deriveAddressAliases(object, names, field) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length === 0) fail('PROOF_MISSING', `${field} is missing`);
  const values = present.map((name) => normalizedAddress(object[name], `${field}.${name}`));
  if (new Set(values).size !== 1) fail('PROOF_AMBIGUOUS', `${field} reports conflicting addresses`);
  return values[0];
}

function exactInteger(value, expected, field) {
  const result = unsignedBigInt(value, field);
  if (result !== expected) fail('PROOF_IDENTITY', `${field} must be ${expected.toString()}`);
  return result;
}

function assertFinalizedRaw(transaction, field) {
  const status = singleField(transaction, ['status', 'status_name', 'statusName'], `${field} status`);
  if (typeof status !== 'string' || status.trim().toUpperCase() !== 'FINALIZED') {
    fail('PROOF_FINALITY', `${field} is not FINALIZED`);
  }
}

function assertStudioNet(networkInfo, chainId) {
  const alias = String(networkInfo?.alias ?? '').trim().toLowerCase();
  if (alias !== V7_NETWORK) {
    fail('NETWORK_MISMATCH', `Active GenLayer network must be exactly ${V7_NETWORK}`);
  }
  if (String(chainId ?? '').trim().toLowerCase() !== STUDIONET_CHAIN_ID_HEX) {
    fail('NETWORK_MISMATCH', `Raw proof endpoint is not StudioNet chain ${STUDIONET_CHAIN_ID_HEX}`);
  }
}

export function normalizeFeeMonitorTargets(parentHashes = []) {
  if (!Array.isArray(parentHashes)) fail('INPUT_SCHEMA', 'parentHashes must be an array');
  if (parentHashes.length > MAX_TARGETS) {
    fail('INPUT_SIZE', `At most ${MAX_TARGETS} fee withdrawals can be monitored`);
  }
  const targets = [...new Set(parentHashes.map((hash) => normalizedHash(hash, 'parent hash')))];
  if (targets.length === 0) fail('INPUT_EMPTY', 'At least one V7 fee-withdrawal parent hash is required');
  return Object.freeze(targets.map((hash) => Object.freeze({ hash })));
}

function withdrawalCallFromReceipt(receipt, parentHash, contractAddress) {
  if (normalizedHash(receipt?.transactionHash, 'finalized receipt hash') !== parentHash) {
    fail('PARENT_RECEIPT', 'Finalized receipt hash does not match the requested parent transaction');
  }
  const decoded = receipt?.txDataDecoded;
  const method = decoded?.callData?.method;
  const args = decoded?.callData?.args;
  if (decoded?.type !== 'call'
    || method !== 'withdraw_accrued_fees'
    || !Array.isArray(args)
    || args.length !== 1) {
    fail('PARENT_CALL', 'Finalized parent is not an exact withdraw_accrued_fees(amount_atto) call');
  }
  const amountText = String(args[0] ?? '');
  if (!/^[1-9]\d*$/.test(amountText)) {
    fail('PARENT_CALL', 'Fee withdrawal amount_atto is not a canonical positive integer');
  }
  const amountAtto = unsignedBigInt(amountText, 'fee withdrawal amount_atto', {
    positive: true,
    u256: true,
  });
  validateReceiptIdentity(
    receipt,
    contractAddress,
    'withdraw_accrued_fees',
    [amountText],
  );
  return Object.freeze({ amountAtto, args: Object.freeze([amountText]) });
}

function deriveWithdrawalParent(transaction, {
  parentHash,
  contractAddress,
  ownerAddress,
  treasuryAddress,
  amountAtto,
}) {
  const parent = plainObject(transaction, 'fee-withdrawal parent transaction');
  exactHashAliases(parent, ['hash', 'tx_id', 'txId'], parentHash, 'fee-withdrawal parent hash');
  assertFinalizedRaw(parent, 'fee-withdrawal parent');
  exactAddressAliases(
    parent,
    ['to_address', 'toAddress', 'recipient'],
    contractAddress,
    'fee-withdrawal parent contract recipient',
  );
  const operator = deriveAddressAliases(
    parent,
    ['from_address', 'fromAddress', 'sender'],
    'fee-withdrawal parent sender',
  );
  if (operator !== ownerAddress && operator !== treasuryAddress) {
    fail('PARENT_CALLER', 'Fee-withdrawal parent sender is neither the configured owner nor treasury');
  }
  exactInteger(singleField(parent, ['type'], 'fee-withdrawal parent type'), 2n, 'fee-withdrawal parent type');
  exactInteger(singleField(parent, ['value'], 'fee-withdrawal parent value'), 0n, 'fee-withdrawal parent value');

  if (!Array.isArray(parent.messages) || parent.messages.length !== 1) {
    fail('PARENT_MESSAGE', 'Finalized fee withdrawal must contain exactly one transfer message');
  }
  const message = plainObject(parent.messages[0], 'fee-withdrawal transfer message');
  exactAddressAliases(message, ['recipient'], treasuryAddress, 'fee-withdrawal message recipient');
  exactInteger(
    singleField(message, ['value'], 'fee-withdrawal message value'),
    amountAtto,
    'fee-withdrawal message value',
  );
  exactInteger(
    singleField(message, ['messageType', 'message_type'], 'fee-withdrawal message type'),
    0n,
    'fee-withdrawal message type',
  );
  if (singleField(message, ['onAcceptance', 'on_acceptance'], 'fee-withdrawal message finality') !== false) {
    fail('PARENT_MESSAGE', 'Fee-withdrawal message was not deferred until parent finalization');
  }
  if (singleField(message, ['data'], 'fee-withdrawal message data') !== '') {
    fail('PARENT_MESSAGE', 'Fee-withdrawal message contains unexpected calldata');
  }

  const triggered = singleField(
    parent,
    ['triggered_transactions', 'triggeredTransactions'],
    'fee-withdrawal child list',
  );
  if (!Array.isArray(triggered) || triggered.length !== 1) {
    fail('PARENT_CHILD', 'Finalized fee withdrawal must report exactly one triggered child');
  }
  return Object.freeze({
    operator,
    childHash: normalizedHash(triggered[0], 'fee-withdrawal child hash'),
  });
}

function verifyWithdrawalChild(transaction, {
  childHash,
  parentHash,
  contractAddress,
  treasuryAddress,
  amountAtto,
}) {
  const child = plainObject(transaction, 'fee-withdrawal child transaction');
  exactHashAliases(child, ['hash', 'tx_id', 'txId'], childHash, 'fee-withdrawal child hash');
  assertFinalizedRaw(child, 'fee-withdrawal child');
  exactAddressAliases(
    child,
    ['recipient', 'to_address', 'toAddress'],
    treasuryAddress,
    'fee-withdrawal child treasury recipient',
  );
  exactAddressAliases(child, ['sender'], contractAddress, 'fee-withdrawal child sender');
  exactAddressAliases(
    child,
    ['from_address', 'fromAddress'],
    contractAddress,
    'fee-withdrawal child from address',
  );
  exactAddressAliases(
    child,
    ['origin_address', 'originAddress'],
    contractAddress,
    'fee-withdrawal child origin address',
  );
  const reportedParent = normalizedHash(
    singleField(child, ['triggered_by', 'triggeredBy'], 'fee-withdrawal child parent hash'),
    'fee-withdrawal child parent hash',
  );
  if (reportedParent !== parentHash) {
    fail('CHILD_PARENT', 'Fee-withdrawal child does not report the expected parent hash');
  }
  if (singleField(child, ['triggered_on', 'triggeredOn'], 'fee-withdrawal child trigger') !== 'finalized') {
    fail('CHILD_TRIGGER', 'Fee-withdrawal child was not triggered on parent finalization');
  }
  exactInteger(singleField(child, ['type'], 'fee-withdrawal child type'), 0n, 'fee-withdrawal child type');
  exactInteger(
    singleField(child, ['value'], 'fee-withdrawal child value'),
    amountAtto,
    'fee-withdrawal child value',
  );
  if (singleField(child, ['value_credited', 'valueCredited'], 'fee-withdrawal child credit') !== true) {
    fail('CHILD_CREDIT', 'Fee-withdrawal child did not credit its exact value to the treasury');
  }
  return child;
}

async function inspectFeeDelivery(context, target) {
  let childHash = null;
  try {
    const receipt = await context.operator.waitFinalized(target.hash, {
      retries: context.config.operator.finalityRetries,
      intervalMs: context.config.operator.finalityIntervalMs,
    });
    const call = withdrawalCallFromReceipt(receipt, target.hash, context.contractAddress);
    const parent = await context.operator.getRawTransaction(target.hash);
    const derived = deriveWithdrawalParent(parent, {
      parentHash: target.hash,
      contractAddress: context.contractAddress,
      ownerAddress: context.ownerAddress,
      treasuryAddress: context.treasuryAddress,
      amountAtto: call.amountAtto,
    });
    childHash = derived.childHash;
    const child = await context.operator.getRawTransaction(childHash);
    verifyWithdrawalChild(child, {
      childHash,
      parentHash: target.hash,
      contractAddress: context.contractAddress,
      treasuryAddress: context.treasuryAddress,
      amountAtto: call.amountAtto,
    });
    return Object.freeze({
      hash: target.hash,
      status: 'DELIVERED',
      childHash,
      operator: derived.operator,
      treasury: context.treasuryAddress,
      amountAtto: call.amountAtto.toString(),
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

export async function monitorFeeDeliveriesOnce({
  config,
  targets,
  operator,
  logger = (event) => console.log(JSON.stringify(event)),
}) {
  if (!config || !operator || !Array.isArray(targets) || targets.length === 0) {
    fail('MONITOR_ARGUMENT', 'V7 config, read-only operator, and at least one target are required');
  }
  const networkInfo = await operator.getNetworkInfo();
  const chainId = await operator.getChainId();
  assertStudioNet(networkInfo, chainId);
  const [contractConfig, assetCatalog, venueCatalog] = await Promise.all([
    operator.getConfig(),
    operator.getAssetCatalog(),
    operator.getVenueCatalog(),
  ]);
  const roles = assertV7ContractConfiguration(
    config,
    contractConfig,
    assetCatalog,
    venueCatalog,
  );
  const context = Object.freeze({
    config,
    operator,
    contractAddress: normalizedAddress(config.contractAddress, 'V7 contractAddress'),
    ownerAddress: roles.owner,
    treasuryAddress: roles.treasury,
  });

  const results = [];
  for (const target of targets) {
    const normalizedTarget = Object.freeze({ hash: normalizedHash(target?.hash, 'parent hash') });
    const result = await inspectFeeDelivery(context, normalizedTarget);
    results.push(result);
    logger({
      event: result.status === 'DELIVERED'
        ? 'V7_FEE_DELIVERY_VERIFIED'
        : 'V7_FEE_DELIVERY_REVIEW_REQUIRED',
      ...result,
    });
  }
  const deliveredCount = results.filter((result) => result.status === 'DELIVERED').length;
  return Object.freeze({
    protocol: 'v7',
    network: V7_NETWORK,
    contractAddress: context.contractAddress,
    treasuryAddress: context.treasuryAddress,
    checkedCount: results.length,
    deliveredCount,
    reviewCount: results.length - deliveredCount,
    results: Object.freeze(results),
  });
}

export function createCliFeeDeliveryOperator({
  config,
  rpcEndpoint = DEFAULT_STUDIONET_RPC_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  return createCliClaimDeliveryOperator({
    config,
    protocol: 'v7',
    rpcEndpoint,
    fetchImpl,
  });
}

function usage() {
  return `Verify finalized Liquidity Arena V7 fee-withdrawal delivery without sending transactions.\n\nUsage:\n  node scripts/fee-delivery-monitor.mjs --config <file> --parent <hash> [--parent <hash> ...] [--rpc-url <url>]\n\nOptions:\n  --config <file>   Exact V7 keeper JSON configuration (required)\n  --parent <hash>   Recorded withdraw_accrued_fees parent hash; may be repeated\n  --rpc-url <url>   Lossless StudioNet JSON-RPC endpoint\n  --help            Show this help\n\nThe monitor is V7-only and read-only. DELIVERED requires an exact successful FINALIZED withdraw_accrued_fees(amount_atto) parent, one finalization-only native transfer message, and one exact FINALIZED treasury child with value_credited=true. REVIEW never retries or re-emits a transfer.`;
}

function parseArguments(argv) {
  const parsed = { parentHashes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (['--config', '--parent', '--rpc-url'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--config') parsed.configPath = value;
      else if (argument === '--parent') parsed.parentHashes.push(value);
      else parsed.rpcEndpoint = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return parsed;
}

export async function runFeeDeliveryMonitorCli(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    console.log(usage());
    return undefined;
  }
  if (!parsed.configPath) throw new Error('--config is required');
  const config = loadV7KeeperConfig(parsed.configPath);
  const targets = normalizeFeeMonitorTargets(parsed.parentHashes);
  const operator = createCliFeeDeliveryOperator({
    config,
    rpcEndpoint: parsed.rpcEndpoint || process.env.GENLAYER_RPC_URL || DEFAULT_STUDIONET_RPC_URL,
  });
  return monitorFeeDeliveriesOnce({ config, targets, operator });
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && process.argv[1] === invokedPath) {
  runFeeDeliveryMonitorCli().then((summary) => {
    if (summary?.reviewCount > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(JSON.stringify({
      event: 'V7_FEE_DELIVERY_MONITOR_FAILED',
      code: error?.code || 'UNEXPECTED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}

export {
  DEFAULT_STUDIONET_RPC_URL,
};
