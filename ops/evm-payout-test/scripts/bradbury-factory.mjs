import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  getCreate2Address,
  getCreateAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";

import {
  PAYOUT_BUILD_LOCK,
  PAYOUT_PROTOCOL_VERSION,
  loadLockedPayoutBuild,
  materializeFactoryRuntime,
} from "./payout-build-lock.mjs";
import {
  acquireOwnerLock,
  operationalEvidenceRoot,
} from "../../../ops/bradbury-v8/harness.mjs";

export const BRADBURY_CHAIN_ID = 4221n;
export const BRADBURY_RPC_URL = "https://rpc.testnet-chain.genlayer.com";
export const BRADBURY_EXPLORER_API_URL =
  "https://explorer-api.testnet-chain.genlayer.com/api";
export const BRADBURY_CLIENT_PATTERN =
  /^zksync-os\/v0\.21\.0(?:$|[\s/+\-])/i;
export const BROADCAST_CONFIRMATION_PREFIX =
  "AUTHORIZE_BRADBURY_SIGNED_INTENT_";
export const REHEARSAL_PAYOUT_ID =
  "LIQUIDITY_ARENA_V8_FACTORY_REHEARSAL_V1";
export const REHEARSAL_AMOUNT = 1n;
export const BRADBURY_EXPLORER_SOLC_VERSION =
  "v0.8.28+commit.7893614a";
export const FACTORY_FULLY_QUALIFIED_NAME =
  "contracts/evm/LiquidityArenaPayoutFactory.sol:LiquidityArenaPayoutFactory";

const UINT256_MAX = (1n << 256n) - 1n;
const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_FINALITY_TIMEOUT_MS = 45 * 60 * 1_000;
export const BRADBURY_MAX_QUERY_FILTER_BLOCKS = 10_000;
const MAX_GAS_LIMIT = 6_000_000n;
export const MAX_FEE_PER_GAS = 1_000_000_000n;
export const MAX_TRANSACTION_GAS_COST = 6_000_000_000_000_000n;
export const MAX_SEQUENCE_NATIVE_COST = 30_000_000_000_000_000n;
export const PROTECTED_EVM_EVIDENCE_SUBDIRECTORY = "evm-payout";
export const MAX_REHEARSAL_SIGNED_TRANSACTIONS = 7;
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;
const EVIDENCE_SCHEMA = "liquidity-arena-bradbury-factory-evidence-v2";
const JOURNAL_SCHEMA = "liquidity-arena-bradbury-factory-journal-v1";

function fail(message) {
  throw new Error(message);
}

export async function queryFilterInBradburyChunks(
  contract,
  filter,
  fromBlock,
  toBlock,
) {
  const first = Number(fromBlock);
  const last = Number(toBlock);
  if (!Number.isSafeInteger(first) || first < 0) {
    fail("Bradbury event fromBlock must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(last) || last < 0) {
    fail("Bradbury event toBlock must be a non-negative safe integer");
  }
  if (first > last) return [];
  const events = [];
  for (
    let chunkFrom = first;
    chunkFrom <= last;
    chunkFrom += BRADBURY_MAX_QUERY_FILTER_BLOCKS
  ) {
    const chunkTo = Math.min(
      chunkFrom + BRADBURY_MAX_QUERY_FILTER_BLOCKS - 1,
      last,
    );
    events.push(...await contract.queryFilter(filter, chunkFrom, chunkTo));
  }
  return events;
}

function parseInteger(label, value, minimum, maximum) {
  if (!/^[0-9]+$/.test(String(value ?? ""))) {
    fail(`${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

export function parseArguments(argv) {
  const parsed = {
    broadcast: false,
    rehearse: false,
    requireExplorerVerified: false,
    submitExplorerVerification: false,
    overwriteEvidence: false,
    rebroadcastSigned: false,
    allowCustomEndpoints: false,
    json: false,
    help: false,
  };
  const valueOptions = new Map([
    ["--rpc-url", "rpcUrl"],
    ["--explorer-api-url", "explorerApiUrl"],
    ["--binder", "binder"],
    ["--reserve-sink", "reserveSink"],
    ["--factory", "factory"],
    ["--tx-hash", "txHash"],
    ["--evidence", "evidencePath"],
    ["--confirmations", "confirmations"],
    ["--timeout-ms", "timeoutMs"],
    ["--finality-timeout-ms", "finalityTimeoutMs"],
    ["--from-block", "fromBlock"],
    ["--rehearsal-evidence", "rehearsalEvidencePath"],
  ]);
  const flagOptions = new Map([
    ["--broadcast", "broadcast"],
    ["--rehearse", "rehearse"],
    ["--require-explorer-verified", "requireExplorerVerified"],
    ["--submit-explorer-verification", "submitExplorerVerification"],
    ["--overwrite-evidence", "overwriteEvidence"],
    ["--rebroadcast-signed", "rebroadcastSigned"],
    ["--allow-custom-endpoints", "allowCustomEndpoints"],
    ["--json", "json"],
    ["--help", "help"],
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) fail(`Duplicate option ${option}`);
    if (valueOptions.has(option)) {
      parsed[valueOptions.get(option)] = takeValue(argv, index, option);
      seen.add(option);
      index += 1;
    } else if (flagOptions.has(option)) {
      parsed[flagOptions.get(option)] = true;
      seen.add(option);
    } else {
      fail(`Unknown option ${option}`);
    }
  }
  return parsed;
}

export function validateCredentialFreeUrl(value, label, expectedProtocol = "https:") {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (url.protocol !== expectedProtocol) {
    fail(`${label} must use ${expectedProtocol.replace(":", "")}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    fail(`${label} must not contain credentials, query parameters, or a fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

function requiredAddress(label, value) {
  if (!value) fail(`${label} is required`);
  let normalized;
  try {
    normalized = getAddress(value);
  } catch {
    fail(`${label} must be a valid EVM address`);
  }
  if (normalized === ZeroAddress) fail(`${label} must not be the zero address`);
  return normalized;
}

function optionalTransactionHash(value) {
  if (value === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) {
    fail("tx-hash must be a 32-byte hexadecimal transaction hash");
  }
  return String(value).toLowerCase();
}

export function resolveConfiguration(args, env = process.env) {
  const binder = requiredAddress(
    "binder (--binder or BRADBURY_EVM_BINDER)",
    args.binder ?? env.BRADBURY_EVM_BINDER,
  );
  const reserveSink = requiredAddress(
    "reserve sink (--reserve-sink or BRADBURY_EVM_RESERVE_SINK)",
    args.reserveSink ?? env.BRADBURY_EVM_RESERVE_SINK,
  );
  if (binder === reserveSink) fail("binder and reserve sink must be distinct addresses");

  const factoryValue = args.factory ?? env.BRADBURY_EVM_FACTORY;
  const factory = factoryValue
    ? requiredAddress("factory", factoryValue)
    : undefined;
  const txHash = optionalTransactionHash(
    args.txHash ?? env.BRADBURY_EVM_TX_HASH,
  );
  const confirmations = parseInteger(
    "confirmations",
    args.confirmations ?? env.BRADBURY_EVM_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS,
    1,
    20,
  );
  const timeoutMs = parseInteger(
    "timeout-ms",
    args.timeoutMs ?? env.BRADBURY_EVM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    60_000,
    30 * 60 * 1_000,
  );
  const fromBlockValue = args.fromBlock ?? env.BRADBURY_EVM_FROM_BLOCK;
  const finalityTimeoutMs = parseInteger(
    "finality-timeout-ms",
    args.finalityTimeoutMs ??
      env.BRADBURY_EVM_FINALITY_TIMEOUT_MS ??
      DEFAULT_FINALITY_TIMEOUT_MS,
    5 * 60_000,
    2 * 60 * 60 * 1_000,
  );
  const fromBlock =
    fromBlockValue === undefined
      ? undefined
      : parseInteger("from-block", fromBlockValue, 0, Number.MAX_SAFE_INTEGER);

  if (args.rehearse && factory && fromBlock === undefined) {
    fail("Rehearsal reconciliation with --factory requires --from-block");
  }
  if (args.rehearse && args.requireExplorerVerified) {
    fail("Explorer source verification is a production-factory gate, not a sacrificial rehearsal gate");
  }
  if (args.rehearse && args.submitExplorerVerification) {
    fail("Explorer source submission is forbidden for sacrificial rehearsal factories");
  }
  if (args.submitExplorerVerification && !factory && !txHash) {
    fail("--submit-explorer-verification requires --factory or --tx-hash");
  }

  if (args.broadcast && args.requireExplorerVerified && !factory) {
    fail(
      "A new deployment cannot already be explorer-verified; run readback with --factory and --require-explorer-verified after verification",
    );
  }
  if (factory && txHash) fail("Use either --factory or --tx-hash, not both");
  const evidencePath = args.evidencePath ?? env.BRADBURY_EVM_EVIDENCE_PATH;
  if (txHash && !evidencePath) {
    fail("--tx-hash recovery requires the original --evidence summary and journal");
  }
  if (args.broadcast && !evidencePath) {
    fail("--broadcast requires --evidence so every submitted transaction hash is durably checkpointed");
  }
  const rehearsalEvidencePath =
    args.rehearsalEvidencePath ?? env.BRADBURY_EVM_REHEARSAL_EVIDENCE;
  if (
    args.broadcast &&
    !args.rehearse &&
    !factory &&
    !txHash &&
    !rehearsalEvidencePath
  ) {
    fail("Production broadcast requires --rehearsal-evidence from a finalized passed sacrificial run");
  }
  if (args.broadcast && args.rehearse && factory && !rehearsalEvidencePath) {
    fail("Rehearsal resume requires --rehearsal-evidence for the prior signed session");
  }
  if (args.broadcast && factory && !args.rehearse) {
    fail("--broadcast is not valid for production readback of an existing factory");
  }
  if (args.overwriteEvidence && args.broadcast) {
    fail("--overwrite-evidence is forbidden for every broadcast or signed-transaction recovery");
  }
  if (args.rebroadcastSigned && (!args.broadcast || !txHash)) {
    fail("--rebroadcast-signed requires both --broadcast and --tx-hash");
  }
  if (args.broadcast && txHash && !args.rebroadcastSigned) {
    fail("--tx-hash reconciliation is read-only unless --rebroadcast-signed is explicit");
  }
  if (env.BRADBURY_EVM_PRIVATE_KEY || env.BRADBURY_EVM_RECIPIENT_PRIVATE_KEY) {
    fail("Raw private-key environment variables are forbidden; use encrypted keystores");
  }

  const rpcUrl = validateCredentialFreeUrl(
    args.rpcUrl ?? env.BRADBURY_EVM_RPC_URL ?? BRADBURY_RPC_URL,
    "Bradbury RPC URL",
  );
  const explorerApiUrl = validateCredentialFreeUrl(
    args.explorerApiUrl ??
      env.BRADBURY_EVM_EXPLORER_API_URL ??
      BRADBURY_EXPLORER_API_URL,
    "Bradbury explorer API URL",
  );
  const customEndpoints =
    rpcUrl !== BRADBURY_RPC_URL ||
    explorerApiUrl !== BRADBURY_EXPLORER_API_URL;
  if (
    customEndpoints &&
    (args.broadcast || args.submitExplorerVerification) &&
    !args.allowCustomEndpoints
  ) {
    fail(
      "Broadcasts and source publication require the canonical Bradbury endpoints unless --allow-custom-endpoints is explicit",
    );
  }

  return {
    mode: args.rehearse
      ? "rehearsal"
      : factory
        ? "readback"
        : txHash
          ? "transaction-readback"
          : "production",
    broadcast: args.broadcast,
    rpcUrl,
    explorerApiUrl,
    customEndpoints,
    binder,
    reserveSink,
    factory,
    txHash,
    confirmations,
    timeoutMs,
    finalityTimeoutMs,
    fromBlock,
    evidencePath,
    rehearsalEvidencePath,
    overwriteEvidence: args.overwriteEvidence,
    rebroadcastSigned: args.rebroadcastSigned,
    allowCustomEndpoints: args.allowCustomEndpoints,
    requireExplorerVerified: args.requireExplorerVerified,
    submitExplorerVerification: args.submitExplorerVerification,
    json: args.json,
    broadcastConfirmation: env.BRADBURY_EVM_BROADCAST_CONFIRM,
  };
}

function decodeBase64Strict(value, label) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    fail(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    bytes.fill(0);
    fail(`${label} is not canonical base64`);
  }
  return bytes;
}

function encryptedKeystoreInput(env, prefix) {
  const jsonName = `${prefix}_KEYSTORE_JSON`;
  const base64Name = `${prefix}_KEYSTORE_B64`;
  const passwordName = `${prefix}_KEYSTORE_PASSWORD`;
  const jsonValue = env[jsonName];
  const base64Value = env[base64Name];
  const password = env[passwordName];

  if (Boolean(jsonValue) === Boolean(base64Value)) {
    fail(`Set exactly one of ${jsonName} or ${base64Name}`);
  }
  if (!password) fail(`${passwordName} is required`);

  let json = jsonValue;
  let decoded;
  if (base64Value) {
    decoded = decodeBase64Strict(base64Value, base64Name);
    json = decoded.toString("utf8");
  }
  try {
    const parsed = JSON.parse(json);
    if (!parsed || (!parsed.crypto && !parsed.Crypto)) {
      fail(`${prefix} input is not an encrypted Web3 keystore`);
    }
  } catch (error) {
    if (String(error.message).includes("encrypted Web3 keystore")) throw error;
    fail(`${prefix} input is not valid encrypted-keystore JSON`);
  } finally {
    decoded?.fill(0);
  }
  return { json, password };
}

export async function loadEncryptedWallet(env, prefix, expectedAddress, provider) {
  const input = encryptedKeystoreInput(env, prefix);
  let wallet;
  try {
    wallet = await Wallet.fromEncryptedJson(input.json, input.password);
  } catch {
    fail(`${prefix} keystore could not be decrypted`);
  } finally {
    input.json = undefined;
    input.password = undefined;
  }
  if (wallet.address !== getAddress(expectedAddress)) {
    fail(`${prefix} keystore address does not match its required role`);
  }
  return wallet.connect(provider);
}

export function validateBradburyIdentity(chainIdValue, clientVersion) {
  const chainId = BigInt(chainIdValue);
  if (chainId !== BRADBURY_CHAIN_ID) {
    fail(`Refusing chain ${chainId}; expected Bradbury chain ${BRADBURY_CHAIN_ID}`);
  }
  if (!BRADBURY_CLIENT_PATTERN.test(String(clientVersion))) {
    fail(
      `Refusing unexpected Bradbury client ${String(clientVersion)}; expected zksync-os/v0.21.0`,
    );
  }
}

export async function readBradburyIdentity(provider) {
  const [rawChainId, clientVersion, network, latestBlock] = await Promise.all([
    provider.send("eth_chainId", []),
    provider.send("web3_clientVersion", []),
    provider.getNetwork(),
    provider.getBlock("latest"),
  ]);
  validateBradburyIdentity(rawChainId, clientVersion);
  if (network.chainId !== BRADBURY_CHAIN_ID) {
    fail("Provider network detection disagrees with eth_chainId");
  }
  if (!latestBlock?.hash) fail("Bradbury latest block could not be read");
  return {
    chainId: BRADBURY_CHAIN_ID.toString(),
    clientVersion,
    latestBlockNumber: latestBlock.number,
    latestBlockHash: latestBlock.hash,
  };
}

export async function assertExternallyOwnedRole(provider, label, address) {
  const code = await provider.getCode(address);
  if (code !== "0x") fail(`${label} must be an EOA with no deployed code`);
}

export function bufferedGas(estimate) {
  const value = (estimate * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) /
    GAS_BUFFER_DENOMINATOR;
  if (value <= 0n || value > MAX_GAS_LIMIT) {
    fail(`Buffered deployment gas ${value} is outside the reviewed limit`);
  }
  return value;
}

export function bigintFields(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === "bigint" ? item.toString() : item,
    ]),
  );
}

function canonicalize(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function endpointEvidence(value, canonicalValue) {
  if (value === canonicalValue) return value;
  const url = new URL(value);
  return {
    custom: true,
    origin: url.origin,
    sha256: sha256(value),
  };
}

export function protectedEvmEvidenceRoot() {
  return path.resolve(
    operationalEvidenceRoot(),
    PROTECTED_EVM_EVIDENCE_SUBDIRECTORY,
  );
}

function pathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function openRegularFileNoFollow(filePath, flags, mode) {
  const descriptor = fs.openSync(
    filePath,
    flags | (fs.constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    const pathMetadata = lstatIfPresent(filePath);
    const descriptorMetadata = fs.fstatSync(descriptor);
    if (
      !pathMetadata ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      pathMetadata.nlink !== 1 ||
      pathMetadata.dev !== descriptorMetadata.dev ||
      pathMetadata.ino !== descriptorMetadata.ino
    ) {
      fail(`Operational file must be one unaliased regular file: ${filePath}`);
    }
    return descriptor;
  } catch (error) {
    try { fs.closeSync(descriptor); } catch {}
    throw error;
  }
}

function rejectAliasedPathComponents(candidate, root) {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = lstatIfPresent(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink()) {
      fail(`Protected operational path must not traverse an alias: ${current}`);
    }
  }
  const candidateMetadata = lstatIfPresent(candidate);
  if (candidateMetadata?.isSymbolicLink()) {
    fail(`Protected operational path must not be an alias: ${candidate}`);
  }
  if (candidateMetadata && fs.statSync(candidate).nlink !== 1) {
    fail(`Protected operational file must not be hard-linked: ${candidate}`);
  }
}

export function requireProtectedOperationalPath(filePath, label) {
  if (!filePath) fail(`${label} is required inside protected operational storage`);
  const root = protectedEvmEvidenceRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootMetadata = fs.lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("Protected EVM operational root must be a real directory");
  }
  const resolvedRoot = fs.realpathSync(root);
  const candidate = path.resolve(filePath);
  if (!pathWithin(candidate, root)) {
    fail(`${label} must stay inside protected operational storage ${root}`);
  }
  const parent = path.dirname(candidate);
  const existingParent = fs.existsSync(parent) ? fs.realpathSync(parent) : undefined;
  if (existingParent && !pathWithin(existingParent, resolvedRoot) && existingParent !== resolvedRoot) {
    fail(`${label} parent resolves outside protected operational storage`);
  }
  rejectAliasedPathComponents(candidate, root);
  return candidate;
}

function ownerLockConfig(address) {
  return { expected: { ownerAddress: getAddress(address).toLowerCase() } };
}

export function acquireBradburySignerLocks(addresses) {
  const normalized = [...new Set(addresses.map((address) =>
    getAddress(address).toLowerCase()))].sort();
  const locks = [];
  try {
    for (const address of normalized) {
      locks.push(acquireOwnerLock(ownerLockConfig(address)));
    }
  } catch (error) {
    for (const lock of locks.reverse()) {
      try { lock.release(); } catch {}
    }
    throw error;
  }
  let released = false;
  return Object.freeze({
    addresses: Object.freeze(normalized),
    lockPaths: Object.freeze(locks.map((lock) => lock.lockPath)),
    release() {
      if (released) return;
      released = true;
      let firstError;
      for (const lock of [...locks].reverse()) {
        try { lock.release(); } catch (error) { firstError ??= error; }
      }
      if (firstError) throw firstError;
    },
  });
}

export function sanitizeOperationalError(error, endpointValues = []) {
  let message = String(error?.message ?? error);
  for (const value of endpointValues.filter(Boolean)) {
    let endpoint;
    try { endpoint = new URL(value); } catch { continue; }
    const replacements = [endpoint.toString(), value];
    if (endpoint.pathname && endpoint.pathname !== "/") {
      replacements.push(endpoint.pathname);
    }
    for (const secretPart of replacements.sort((a, b) => b.length - a.length)) {
      message = message.split(secretPart).join("/[redacted-endpoint-path]");
    }
  }
  return message;
}

export function requiredIntentConfirmation(intent) {
  return `${BROADCAST_CONFIRMATION_PREFIX}${sha256(canonicalJson(intent)).toUpperCase()}`;
}

function assertIntentConfirmation(config, expected) {
  if (config.broadcastConfirmation !== expected) {
    fail(
      `Broadcast authorization mismatch. Run the matching dry-run and set BRADBURY_EVM_BROADCAST_CONFIRM=${expected}`,
    );
  }
}

export async function feeCeiling(provider, gasLimit) {
  const fees = await provider.getFeeData();
  const perGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (perGas === null || perGas === undefined || perGas <= 0n) {
    fail("Bradbury did not return a usable gas fee");
  }
  if (perGas > MAX_FEE_PER_GAS) {
    fail(`Bradbury fee ${perGas} exceeds the reviewed per-gas ceiling`);
  }
  if (
    (fees.maxFeePerGas == null) !==
    (fees.maxPriorityFeePerGas == null)
  ) {
    fail("Bradbury returned an incomplete EIP-1559 fee pair");
  }
  if (perGas > UINT256_MAX / gasLimit) fail("Gas cost calculation overflowed");
  const maximumGasCost = perGas * gasLimit;
  if (maximumGasCost > MAX_TRANSACTION_GAS_COST) {
    fail(`Maximum gas cost ${maximumGasCost} exceeds the reviewed transaction ceiling`);
  }
  return {
    gasPrice: fees.gasPrice,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maximumGasCost,
  };
}

function exactFeeFields(fees) {
  if (
    fees.maxFeePerGas !== null &&
    fees.maxFeePerGas !== undefined &&
    fees.maxPriorityFeePerGas !== null &&
    fees.maxPriorityFeePerGas !== undefined
  ) {
    return {
      type: 2,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }
  if (fees.gasPrice === null || fees.gasPrice === undefined) {
    fail("Bradbury returned no complete transaction fee mode");
  }
  return { type: 0, gasPrice: fees.gasPrice };
}

export function assertNoAccessList(transaction, field = "Transaction") {
  const accessList = transaction?.accessList;
  if (
    accessList !== null &&
    accessList !== undefined &&
    (!Array.isArray(accessList) || accessList.length !== 0)
  ) {
    fail(`${field} must not contain an unreviewed access list`);
  }
}

export function reviewedFeeIntent(fees) {
  return bigintFields({
    ...exactFeeFields(fees),
    maximumGasCost: fees.maximumGasCost,
  });
}

export function validateRehearsalAuthorization(value) {
  const fields = [
    "schema",
    "evidenceSha256",
    "journalHeadHash",
    "journalEntries",
    "factoryAddress",
    "outcome",
    "finalizedTransactions",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      canonicalJson(Object.keys(value).sort()) !== canonicalJson(fields.sort())) {
    fail("Rehearsal authorization fields do not match the reviewed schema");
  }
  if (
    value.schema !== "liquidity-arena-bradbury-rehearsal-authorization-v1" ||
    !/^[0-9a-f]{64}$/.test(String(value.evidenceSha256 ?? "")) ||
    !/^[0-9a-f]{64}$/.test(String(value.journalHeadHash ?? "")) ||
    !Number.isSafeInteger(value.journalEntries) ||
    value.journalEntries <= 0 ||
    requiredAddress("rehearsal authorization factory", value.factoryAddress) !==
      value.factoryAddress ||
    value.outcome !== "sacrificial-rehearsal-passed" ||
    !Array.isArray(value.finalizedTransactions) ||
    value.finalizedTransactions.length !== REHEARSAL_TRANSACTION_LABELS.length
  ) {
    fail("Rehearsal authorization is not an exact passed finalized proof");
  }
  for (let index = 0; index < REHEARSAL_TRANSACTION_LABELS.length; index += 1) {
    const transaction = value.finalizedTransactions[index];
    const transactionFields = ["label", "transactionHash", "blockNumber", "blockHash"];
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
        canonicalJson(Object.keys(transaction).sort()) !==
          canonicalJson(transactionFields.sort()) ||
        transaction.label !== REHEARSAL_TRANSACTION_LABELS[index] ||
        !/^0x[0-9a-f]{64}$/.test(String(transaction.transactionHash ?? "")) ||
        !Number.isSafeInteger(transaction.blockNumber) ||
        transaction.blockNumber < 0 ||
        !/^0x[0-9a-f]{64}$/.test(String(transaction.blockHash ?? ""))) {
      fail("Rehearsal authorization transaction sequence is not exact");
    }
  }
  return value;
}

export async function preflightFactoryDeployment(provider, build, roles) {
  if (roles.rehearsalAuthorization) {
    validateRehearsalAuthorization(roles.rehearsalAuthorization);
  }
  const contractFactory = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
  );
  const deployRequest = await contractFactory.getDeployTransaction(
    roles.binder,
    roles.reserveSink,
  );
  if (!deployRequest.data || deployRequest.value) {
    fail("Factory deployment transaction is malformed or value-bearing");
  }

  const [latestNonce, pendingNonce, estimate, balance, latestBlock] = await Promise.all([
    provider.getTransactionCount(roles.binder, "latest"),
    provider.getTransactionCount(roles.binder, "pending"),
    provider.estimateGas({ from: roles.binder, data: deployRequest.data }),
    provider.getBalance(roles.binder),
    provider.getBlock("latest"),
  ]);
  if (latestNonce !== pendingNonce) {
    fail("Factory binder has an unresolved pending transaction");
  }
  const nonce = pendingNonce;
  const gasLimit = bufferedGas(estimate);
  if (!latestBlock || gasLimit > latestBlock.gasLimit) {
    fail("Buffered deployment gas exceeds the latest block gas limit");
  }
  const fees = await feeCeiling(provider, gasLimit);
  if (balance < fees.maximumGasCost) {
    fail("Binder balance is below the maximum deployment gas cost");
  }

  const predictedAddress = getCreateAddress({ from: roles.binder, nonce });
  if ((await provider.getCode(predictedAddress)) !== "0x") {
    fail(`Predicted factory address ${predictedAddress} already contains code`);
  }

  const expectedRuntime = materializeFactoryRuntime(build, roles);
  const simulatedRuntime = await provider.call({
    from: roles.binder,
    data: deployRequest.data,
    gasLimit,
  });
  if (simulatedRuntime.toLowerCase() !== expectedRuntime.toLowerCase()) {
    fail("Contract-creation eth_call did not return the exact immutable-patched runtime");
  }

  const intent = {
    schema: "liquidity-arena-bradbury-signed-intent-v1",
    chainId: BRADBURY_CHAIN_ID.toString(),
    mode: roles.mode ?? "production",
    binder: roles.binder,
    reserveSink: roles.reserveSink,
    buildLock: build.lock,
    ...(roles.mode === "production"
      ? { rehearsalAuthorization: roles.rehearsalAuthorization ?? null }
      : {}),
    nonce,
    predictedAddress,
    to: null,
    value: "0",
    transactionDataKeccak256: keccak256(deployRequest.data),
    gasLimit: gasLimit.toString(),
    fees: reviewedFeeIntent(fees),
  };
  const requiredBroadcastConfirmation = requiredIntentConfirmation(intent);

  return {
    transactionData: deployRequest.data,
    nonce,
    predictedAddress,
    estimate,
    gasLimit,
    balance,
    fees,
    intent,
    requiredBroadcastConfirmation,
    expectedRuntime,
    evidence: {
      predictedAddress,
      latestNonce,
      pendingNonce: nonce,
      gasEstimate: estimate.toString(),
      gasLimit: gasLimit.toString(),
      binderBalance: balance.toString(),
      fees: bigintFields(fees),
      creationBytecodeKeccak256: keccak256(build.creationBytecode),
      expectedRuntimeKeccak256: keccak256(expectedRuntime),
      creationCallRuntimeMatched: true,
      predictedAddressEmpty: true,
      requiredBroadcastConfirmation,
    },
  };
}

export async function verifyFactoryAt(
  provider,
  address,
  build,
  roles,
  { expectedArena = ZeroAddress, blockTag } = {},
) {
  const factoryAddress = getAddress(address);
  const code = await provider.getCode(factoryAddress, blockTag);
  if (code === "0x") fail(`No factory code exists at ${factoryAddress}`);
  const expectedRuntime = materializeFactoryRuntime(build, roles);
  const actualRuntimeKeccak256 = keccak256(code);
  const expectedRuntimeKeccak256 = keccak256(expectedRuntime);
  if (code.toLowerCase() !== expectedRuntime.toLowerCase()) {
    fail(
      `Factory runtime mismatch at ${factoryAddress} (expected ${expectedRuntimeKeccak256}, received ${actualRuntimeKeccak256})`,
    );
  }

  const contract = new Contract(factoryAddress, build.factoryArtifact.abi, provider);
  const proxySlots = [
    "eip1967.proxy.implementation",
    "eip1967.proxy.admin",
    "eip1967.proxy.beacon",
  ].map((label) => {
    const value = BigInt(keccak256(toUtf8Bytes(label))) - 1n;
    return `0x${value.toString(16).padStart(64, "0")}`;
  });
  const [
    binder,
    reserveSink,
    arena,
    protocolVersion,
    expectedArenaBound,
    ...proxyStorage
  ] =
    await Promise.all([
      contract.binder({ blockTag }),
      contract.reserveSink({ blockTag }),
      contract.arena({ blockTag }),
      contract.protocol_version({ blockTag }),
      contract.is_bound(expectedArena, { blockTag }),
      ...proxySlots.map((slot) =>
        provider.getStorage(factoryAddress, slot, blockTag)),
    ]);
  if (getAddress(binder) !== roles.binder) fail("Factory binder view mismatch");
  if (getAddress(reserveSink) !== roles.reserveSink) {
    fail("Factory reserveSink view mismatch");
  }
  if (getAddress(arena) !== getAddress(expectedArena)) fail("Factory arena view mismatch");
  if (protocolVersion !== PAYOUT_PROTOCOL_VERSION) {
    fail("Factory protocol_version view mismatch");
  }
  const shouldBeBound = getAddress(expectedArena) !== ZeroAddress;
  if (expectedArenaBound !== shouldBeBound) fail("Factory is_bound view mismatch");
  if (proxyStorage.some((word) => BigInt(word) !== 0n)) {
    fail("Factory unexpectedly uses an EIP-1967 proxy control slot");
  }

  return {
    contract,
    evidence: {
      address: factoryAddress,
      codeBytes: (code.length - 2) / 2,
      actualRuntimeKeccak256,
      expectedRuntimeKeccak256,
      runtimeMatched: true,
      runtimeVerificationMethod:
        "solc immutableReferences patched with ABI-encoded binder and reserveSink, then exact byte comparison",
      blockTag: blockTag ?? "latest",
      eip1967ProxySlotsZero: true,
      views: {
        binder: getAddress(binder),
        reserveSink: getAddress(reserveSink),
        arena: getAddress(arena),
        protocolVersion,
        isExpectedArenaBound: expectedArenaBound,
      },
    },
  };
}

function parseExplorerStandardJson(sourceCode) {
  if (sourceCode && typeof sourceCode === "object" && sourceCode.sources) {
    return sourceCode;
  }
  let candidate = String(sourceCode ?? "").trim();
  if (candidate.startsWith("{{") && candidate.endsWith("}}")) {
    candidate = candidate.slice(1, -1);
  }
  if (!candidate.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && parsed.sources ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodedFactoryConstructorArguments(roles) {
  return AbiCoder.defaultAbiCoder()
    .encode(["address", "address"], [roles.binder, roles.reserveSink])
    .slice(2)
    .toLowerCase();
}

export async function inspectExplorerVerification(
  explorerApiUrl,
  factoryAddress,
  roles,
  { fetchImpl = globalThis.fetch } = {},
) {
  const url = new URL(explorerApiUrl);
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", factoryAddress);
  const requester = fetchImpl ?? globalThis.fetch;
  let response;
  try {
    response = await requester(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { verified: false, sourceLockMatched: false, status: "unreachable" };
  }
  if (!response.ok) {
    return {
      verified: false,
      sourceLockMatched: false,
      status: `http-${response.status}`,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { verified: false, sourceLockMatched: false, status: "invalid-json" };
  }
  const record = Array.isArray(payload?.result) ? payload.result[0] : undefined;
  const rawSourceCode = record?.SourceCode;
  const sourceCodeText =
    typeof rawSourceCode === "string" ? rawSourceCode.trim() : "";
  const standardJson = parseExplorerStandardJson(rawSourceCode);
  const verified =
    Boolean(standardJson || sourceCodeText) &&
    !sourceCodeText.toLowerCase().includes("not verified");
  if (!verified) {
    return { verified: false, sourceLockMatched: false, status: "unverified" };
  }

  const expectedSourcePaths = Object.keys(PAYOUT_BUILD_LOCK.sourceSha256).sort();
  const recordedSourcePaths = Object.keys(standardJson?.sources ?? {}).sort();
  const sourceMatches = standardJson
    ? JSON.stringify(recordedSourcePaths) === JSON.stringify(expectedSourcePaths) &&
      Object.entries(PAYOUT_BUILD_LOCK.sourceSha256).every(
        ([sourcePath, expectedHash]) =>
          sha256(standardJson.sources?.[sourcePath]?.content ?? "") === expectedHash,
      )
    : false;
  const compilerVersion = String(record.CompilerVersion ?? "");
  const normalizedCompilerVersion = compilerVersion
    .replace(/^v/, "")
    .replace(/\.Emscripten\.clang$/, "");
  const compilerMatches =
    normalizedCompilerVersion === BRADBURY_EXPLORER_SOLC_VERSION.slice(1);
  const optimizerMatches =
    String(record.OptimizationUsed) === "1" &&
    String(record.Runs) === "200" &&
    standardJson?.settings?.optimizer?.enabled === true &&
    standardJson?.settings?.optimizer?.runs === 200;
  const evmVersionMatches =
    String(record.EVMVersion ?? "").toLowerCase() === "cancun" &&
    standardJson?.settings?.evmVersion === "cancun";
  const contractMatches = String(record.ContractName) ===
    FACTORY_FULLY_QUALIFIED_NAME;
  const recordedConstructorArguments = String(
    record.ConstructorArguments ?? "",
  )
    .replace(/^0x/, "")
    .toLowerCase();
  // The canonical ZKsync explorer mapper currently returns an empty constructor
  // field. Exact roles are instead proven by the finalized creation transaction,
  // immutable-patched runtime bytes, and live binder/reserve readback. If a future
  // explorer does return constructor bytes, they must still match exactly.
  const constructorArgumentsAvailable = recordedConstructorArguments.length > 0;
  const constructorMatches = !constructorArgumentsAvailable ||
    recordedConstructorArguments === encodedFactoryConstructorArguments(roles);
  const sourceLockMatched =
    sourceMatches &&
    compilerMatches &&
    optimizerMatches &&
    evmVersionMatches &&
    contractMatches &&
    constructorMatches;
  return {
    verified: true,
    sourceLockMatched,
    status: sourceLockMatched ? "verified-and-locked" : "verified-but-lock-mismatch",
    contractName: String(record.ContractName ?? ""),
    compilerVersion,
    normalizedCompilerVersion,
    optimizerEnabled: String(record.OptimizationUsed) === "1",
    optimizerRuns: String(record.Runs ?? ""),
    evmVersion: String(record.EVMVersion ?? ""),
    sourceHashesMatched: sourceMatches,
    constructorArgumentsAvailable,
    constructorArgumentsMatched: constructorArgumentsAvailable
      ? constructorMatches
      : null,
    constructorRolesVerificationMethod:
      "exact journaled creation transaction plus immutable-patched runtime and role readback",
  };
}

function explorerResultText(payload) {
  return String(payload?.result ?? payload?.message ?? "");
}

function explorerVerificationSucceeded(payload) {
  const result = explorerResultText(payload);
  return (
    (String(payload?.status) === "1" && /verified|pass/i.test(result)) ||
    /already verified/i.test(result)
  ) && !/pending|queue/i.test(result);
}

export async function submitExplorerVerification(
  explorerApiUrl,
  factoryAddress,
  build,
  roles,
  {
    fetchImpl = globalThis.fetch,
    pollIntervalMs = 5_000,
    timeoutMs = 2 * 60_000,
    sleepImpl = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const requester = fetchImpl ?? globalThis.fetch;
  const submitUrl = new URL(explorerApiUrl);
  submitUrl.searchParams.set("module", "contract");
  submitUrl.searchParams.set("action", "verifysourcecode");
  const requestBody = {
    contractaddress: getAddress(factoryAddress),
    // Bradbury's ZKsync explorer accepts a JSON request body but its standard-
    // input controller JSON.parse()s this field before forwarding the object.
    sourceCode: JSON.stringify(build.compiled.input),
    codeformat: "solidity-standard-json-input",
    contractname: FACTORY_FULLY_QUALIFIED_NAME,
    compilerversion: BRADBURY_EXPLORER_SOLC_VERSION,
    evmVersion: "cancun",
    runs: 200,
    optimizationUsed: "1",
    constructorArguments: encodedFactoryConstructorArguments(roles),
  };
  let response;
  try {
    response = await requester(submitUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("Explorer source-verification submission was unreachable");
  }
  if (!response.ok) {
    fail(`Explorer source-verification submission returned HTTP ${response.status}`);
  }
  let submission;
  try {
    submission = await response.json();
  } catch {
    fail("Explorer source-verification submission returned invalid JSON");
  }
  if (explorerVerificationSucceeded(submission)) {
    return {
      submitted: true,
      verified: true,
      alreadyVerified: /already verified/i.test(explorerResultText(submission)),
      guid: null,
      polls: 0,
    };
  }
  if (String(submission?.status) !== "1") {
    fail("Explorer rejected the locked standard-json source submission");
  }
  const guid = explorerResultText(submission).trim();
  if (!guid || guid.length > 256) {
    fail("Explorer source-verification submission returned an invalid GUID");
  }

  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    const statusUrl = new URL(explorerApiUrl);
    statusUrl.searchParams.set("module", "contract");
    statusUrl.searchParams.set("action", "checkverifystatus");
    statusUrl.searchParams.set("guid", guid);
    let statusResponse;
    try {
      statusResponse = await requester(statusUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      fail("Explorer source-verification status endpoint was unreachable");
    }
    if (!statusResponse.ok) {
      fail(`Explorer source-verification status returned HTTP ${statusResponse.status}`);
    }
    let statusPayload;
    try {
      statusPayload = await statusResponse.json();
    } catch {
      fail("Explorer source-verification status returned invalid JSON");
    }
    polls += 1;
    if (explorerVerificationSucceeded(statusPayload)) {
      return {
        submitted: true,
        verified: true,
        alreadyVerified: /already verified/i.test(
          explorerResultText(statusPayload),
        ),
        guid,
        polls,
      };
    }
    const result = explorerResultText(statusPayload);
    if (!/pending|queue|in progress/i.test(result)) {
      fail("Explorer could not verify the locked factory source");
    }
  }
  fail("Explorer source verification did not complete before the timeout");
}

export async function waitForReceiptFinality(
  provider,
  receipt,
  timeoutMs,
  {
    pollIntervalMs = 1_000,
    sleepImpl = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const finalized = await provider.getBlock("finalized");
    if (finalized?.hash && finalized.number >= receipt.blockNumber) {
      const canonical = await provider.getBlock(receipt.blockNumber);
      if (!canonical?.hash || canonical.hash !== receipt.blockHash) {
        fail("Receipt block was not canonical at Bradbury finality");
      }
      return {
        finalizedBlockNumber: finalized.number,
        finalizedBlockHash: finalized.hash,
        receiptBlockFinalized: true,
      };
    }
    await sleepImpl(pollIntervalMs);
  }
  fail(`Transaction ${receipt.hash} did not reach Bradbury finality before timeout`);
}

export async function verifyReceipt(
  provider,
  txHash,
  expected,
  confirmations,
  timeoutMs,
  {
    requireFinality = true,
    finalityTimeoutMs = DEFAULT_FINALITY_TIMEOUT_MS,
  } = {},
) {
  const receipt = await provider.waitForTransaction(txHash, confirmations, timeoutMs);
  if (!receipt) fail(`Timed out waiting for transaction ${txHash}`);
  if (Number(receipt.status) !== 1) fail(`Transaction ${txHash} reverted`);
  const [transaction, block, actualConfirmations] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getBlock(receipt.blockNumber),
    receipt.confirmations(),
  ]);
  if (!transaction || !block?.hash) fail("Receipt transaction or block is missing");
  if (block.hash !== receipt.blockHash) fail("Receipt is not in the canonical block");
  if (actualConfirmations < confirmations) fail("Receipt has too few confirmations");
  if (transaction.chainId !== BRADBURY_CHAIN_ID) {
    fail("Receipt transaction has the wrong chain ID");
  }
  if (expected.from && getAddress(transaction.from) !== getAddress(expected.from)) {
    fail("Receipt transaction sender mismatch");
  }
  if (expected.to === null && transaction.to !== null) fail("Deployment transaction has a to address");
  if (expected.to && getAddress(transaction.to) !== getAddress(expected.to)) {
    fail("Receipt transaction target mismatch");
  }
  if (expected.data && keccak256(transaction.data) !== keccak256(expected.data)) {
    fail("Receipt transaction data mismatch");
  }
  if (expected.value !== undefined && transaction.value !== expected.value) {
    fail("Receipt transaction value mismatch");
  }
  const finality = requireFinality
    ? await waitForReceiptFinality(provider, receipt, finalityTimeoutMs)
    : {
        finalizedBlockNumber: null,
        finalizedBlockHash: null,
        receiptBlockFinalized: false,
      };
  const [finalReceipt, finalTransaction] = await Promise.all([
    provider.getTransactionReceipt(txHash),
    provider.getTransaction(txHash),
  ]);
  if (
    !finalReceipt ||
    !finalTransaction ||
    Number(finalReceipt.status) !== 1 ||
    finalReceipt.blockHash !== receipt.blockHash ||
    finalTransaction.blockHash !== receipt.blockHash
  ) {
    fail("Transaction or receipt changed after Bradbury finality");
  }
  return {
    receipt: finalReceipt,
    transaction: finalTransaction,
    evidence: {
      transactionHash: txHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      confirmations: actualConfirmations,
      status: Number(receipt.status),
      from: getAddress(transaction.from),
      to: transaction.to ? getAddress(transaction.to) : null,
      nonce: transaction.nonce,
      value: transaction.value.toString(),
      gasUsed: receipt.gasUsed.toString(),
      transactionDataKeccak256: keccak256(transaction.data),
      canonicalBlockMatched: true,
      ...finality,
    },
  };
}

export async function sendCheckedTransaction(
  label,
  signer,
  provider,
  request,
  config,
  onSubmitted,
  reviewed = undefined,
) {
  const existingEntries = effectiveJournalEntries(config.evidencePath);
  const existingSigned = existingEntries.filter(
    (entry) => entry.status === "signed",
  );
  const priorForLabel = existingSigned.find((entry) => entry.label === label);
  if (priorForLabel) {
    fail(
      `${label} already has signed hash ${priorForLabel.transactionHash}; reconcile or replay only that exact transaction`,
    );
  }
  if (existingSigned.length >= MAX_REHEARSAL_SIGNED_TRANSACTIONS) {
    fail("Signed transaction journal reached the reviewed sequence limit");
  }
  await readBradburyIdentity(provider);
  const from = await signer.getAddress();
  const estimate = reviewed?.estimate ??
    await provider.estimateGas({ ...request, from });
  const gasLimit = reviewed?.gasLimit ?? bufferedGas(estimate);
  const fees = reviewed?.fees ?? await feeCeiling(provider, gasLimit);
  const balance = await provider.getBalance(from);
  const value = request.value ?? 0n;
  const priorWorstCaseCost = existingSigned.reduce((total, entry) => {
    const prior = Transaction.from(entry.rawTransaction);
    assertNoAccessList(prior, "Journaled transaction");
    const priorPerGas = prior.maxFeePerGas ?? prior.gasPrice;
    if (priorPerGas === null) fail("Journaled transaction has no fee ceiling");
    return total + priorPerGas * prior.gasLimit + prior.value;
  }, 0n);
  const projectedWorstCaseCost = priorWorstCaseCost + fees.maximumGasCost + value;
  if (projectedWorstCaseCost > MAX_SEQUENCE_NATIVE_COST) {
    fail(
      `Signed sequence worst-case native cost ${projectedWorstCaseCost} exceeds the reviewed total ceiling`,
    );
  }
  if (balance < fees.maximumGasCost + value) {
    fail(`${label} signer balance is below the maximum transaction cost`);
  }
  const [latestNonce, pendingNonce] = await Promise.all([
    provider.getTransactionCount(from, "latest"),
    provider.getTransactionCount(from, "pending"),
  ]);
  if (latestNonce !== pendingNonce) {
    fail(`${label} signer has an unresolved pending transaction`);
  }
  const nonce = reviewed?.nonce ?? pendingNonce;
  if (nonce !== pendingNonce) {
    fail(`${label} reviewed nonce changed before signing`);
  }
  const exactRequest = {
    ...(request.to === null || request.to === undefined ? {} : { to: request.to }),
    data: request.data ?? "0x",
    value,
    gasLimit,
    nonce,
    chainId: BRADBURY_CHAIN_ID,
    ...exactFeeFields(fees),
  };
  const rawTransaction = await signer.signTransaction(exactRequest);
  const parsed = Transaction.from(rawTransaction);
  assertNoAccessList(parsed, `${label} signed transaction`);
  const transactionHash = keccak256(rawTransaction);
  if (
    parsed.hash !== transactionHash ||
    getAddress(parsed.from) !== getAddress(from) ||
    (parsed.to ? getAddress(parsed.to) : null) !==
      (request.to ? getAddress(request.to) : null) ||
    parsed.chainId !== BRADBURY_CHAIN_ID ||
    parsed.nonce !== nonce ||
    parsed.value !== value ||
    parsed.gasLimit !== gasLimit ||
    keccak256(parsed.data) !== keccak256(exactRequest.data)
  ) {
    fail(`${label} signed transaction does not match the reviewed intent`);
  }
  const expectedFeeFields = exactFeeFields(fees);
  if (
    parsed.type !== expectedFeeFields.type ||
    (expectedFeeFields.type === 2 &&
      (parsed.maxFeePerGas !== fees.maxFeePerGas ||
        parsed.maxPriorityFeePerGas !== fees.maxPriorityFeePerGas)) ||
    (expectedFeeFields.type === 0 &&
      (parsed.gasPrice !== fees.gasPrice ||
        parsed.maxFeePerGas !== null ||
        parsed.maxPriorityFeePerGas !== null))
  ) {
    fail(`${label} signed transaction type or fee fields changed after review`);
  }
  assertIntentConfirmation(config, config.requiredBroadcastConfirmation);
  await onSubmitted?.({
    label,
    status: "signed",
    transactionHash,
    rawTransaction,
    reviewedIntent: reviewed?.intent,
    exactTransaction: {
      from: getAddress(from),
      to: request.to ? getAddress(request.to) : null,
      nonce,
      chainId: BRADBURY_CHAIN_ID.toString(),
      value: value.toString(),
      gasLimit: gasLimit.toString(),
      fees: reviewedFeeIntent(fees),
      projectedSequenceNativeCost: projectedWorstCaseCost.toString(),
      transactionDataKeccak256: keccak256(exactRequest.data),
    },
    requiredBroadcastConfirmation: config.requiredBroadcastConfirmation,
  });
  await onSubmitted?.({
    label,
    status: "broadcast-attempt",
    transactionHash,
    target: request.to ?? null,
  });
  let transaction;
  try {
    transaction = await provider.broadcastTransaction(rawTransaction);
  } catch (error) {
    transaction = await provider.getTransaction(transactionHash);
    if (!transaction) {
      fail(
        `${label} broadcast outcome is ambiguous for ${transactionHash}; the signed transaction is journaled and only exact-hash recovery is allowed`,
      );
    }
  }
  if (transaction.hash !== transactionHash) {
    fail(`${label} provider returned a different transaction hash`);
  }
  await onSubmitted?.({
    label,
    status: "submitted",
    transactionHash,
    target: request.to ?? null,
  });
  const verified = await verifyReceipt(
    provider,
    transactionHash,
    {
      from,
      to: request.to ?? null,
      data: request.data,
      value,
    },
    config.confirmations,
    config.timeoutMs,
    {
      requireFinality: config.mode !== "rehearsal",
      finalityTimeoutMs: config.finalityTimeoutMs,
    },
  );
  await onSubmitted?.({
    label,
    status: "confirmed",
    transactionHash,
    receipt: verified.evidence,
  });
  return {
    label,
    ...verified.evidence,
    gasEstimate: estimate.toString(),
    maximumGasCost: fees.maximumGasCost.toString(),
  };
}

function requireEvent(
  receipt,
  expectedEmitter,
  contractInterface,
  expectedName,
  predicate = () => true,
) {
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(expectedEmitter)) continue;
    try {
      const parsed = contractInterface.parseLog(log);
      if (parsed?.name === expectedName && predicate(parsed.args)) return;
    } catch {
      // A transaction may contain logs emitted by another contract.
    }
  }
  fail(`Receipt is missing the expected ${expectedName} event`);
}

async function broadcastFactory(
  provider,
  signer,
  build,
  config,
  preflight,
  onSubmitted,
) {
  const checkpointLabel =
    config.mode === "rehearsal"
      ? "deploy-sacrificial-rehearsal-factory"
      : "deploy-production-factory";
  await readBradburyIdentity(provider);
  const currentNonce = await provider.getTransactionCount(config.binder, "pending");
  if (currentNonce !== preflight.nonce) fail("Binder pending nonce changed after preflight");
  if ((await provider.getCode(preflight.predictedAddress)) !== "0x") {
    fail("Predicted factory address gained code after preflight");
  }
  const transaction = await sendCheckedTransaction(
    checkpointLabel,
    signer,
    provider,
    { data: preflight.transactionData, value: 0n },
    config,
    async (entry) =>
      onSubmitted?.({ ...entry, predictedFactory: preflight.predictedAddress }),
    {
      estimate: preflight.estimate,
      gasLimit: preflight.gasLimit,
      fees: preflight.fees,
      nonce: preflight.nonce,
      intent: preflight.intent,
    },
  );
  if (transaction.nonce !== preflight.nonce) {
    fail("Signed deployment nonce differs from the reviewed preflight nonce");
  }
  const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
  if (!receipt?.contractAddress) fail("Finalized deployment receipt has no contract address");
  const contractAddress = getAddress(receipt.contractAddress);
  if (contractAddress !== preflight.predictedAddress) {
    fail("Receipt contract address differs from the preflight CREATE address");
  }
  return { address: contractAddress, receipt, evidence: transaction };
}

export async function reconcileFactoryDeploymentTransaction(
  provider,
  txHash,
  build,
  config,
) {
  const transaction = await provider.getTransaction(txHash);
  if (!transaction) fail(`Transaction ${txHash} was not found on Bradbury`);
  assertNoAccessList(transaction, "Reconciled deployment transaction");
  const factory = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
  );
  const expectedRequest = await factory.getDeployTransaction(
    config.binder,
    config.reserveSink,
  );
  if (getAddress(transaction.from) !== config.binder) {
    fail("Reconciled deployment sender is not the configured binder");
  }
  if (transaction.to !== null || transaction.value !== 0n) {
    fail("Reconciled transaction is not a zero-value contract creation");
  }
  if (keccak256(transaction.data) !== keccak256(expectedRequest.data)) {
    fail("Reconciled deployment calldata does not match the locked factory build");
  }
  if (transaction.chainId !== BRADBURY_CHAIN_ID) {
    fail("Reconciled deployment transaction has the wrong chain ID");
  }
  const predictedAddress = getCreateAddress({
    from: config.binder,
    nonce: transaction.nonce,
  });
  const existingReceipt = await provider.getTransactionReceipt(txHash);
  if (!existingReceipt) {
    return {
      pending: true,
      address: predictedAddress,
      evidence: {
        transactionHash: txHash,
        transactionFound: true,
        receiptFound: false,
        predictedAddress,
        senderMatched: true,
        deploymentDataMatched: true,
      },
    };
  }
  const verifiedReceipt = await verifyReceipt(
    provider,
    txHash,
    {
      from: config.binder,
      to: null,
      data: expectedRequest.data,
      value: 0n,
    },
    config.confirmations,
    config.timeoutMs,
  );
  if (!verifiedReceipt.receipt.contractAddress) {
    fail("Successful deployment receipt has no contract address");
  }
  const contractAddress = getAddress(verifiedReceipt.receipt.contractAddress);
  if (contractAddress !== predictedAddress) {
    fail("Reconciled receipt address differs from CREATE address derivation");
  }
  const verifiedFactory = await verifyFactoryAt(
    provider,
    contractAddress,
    build,
    config,
    { expectedArena: ZeroAddress },
  );
  return {
    pending: false,
    address: contractAddress,
    evidence: {
      ...verifiedReceipt.evidence,
      transactionFound: true,
      receiptFound: true,
      predictedAddress,
      senderMatched: true,
      deploymentDataMatched: true,
      factoryVerification: verifiedFactory.evidence,
    },
  };
}

async function readVaultState(vault) {
  const [
    factory,
    arena,
    reserveSink,
    recipient,
    amount,
    payoutIdHash,
    credited,
    withdrawn,
    totalArenaReceived,
    totalExcessRecovered,
    balance,
    locked,
    excess,
  ] = await Promise.all([
    vault.factory(),
    vault.arena(),
    vault.reserveSink(),
    vault.recipient(),
    vault.amount(),
    vault.payoutIdHash(),
    vault.credited(),
    vault.withdrawn(),
    vault.totalArenaReceived(),
    vault.totalExcessRecovered(),
    vault.runner?.provider?.getBalance?.(await vault.getAddress()) ??
      vault.runner.getBalance(await vault.getAddress()),
    vault.locked_principal(),
    vault.excess_available(),
  ]);
  return {
    factory: getAddress(factory),
    arena: getAddress(arena),
    reserveSink: getAddress(reserveSink),
    recipient: getAddress(recipient),
    amount,
    payoutIdHash,
    credited,
    withdrawn,
    totalArenaReceived,
    totalExcessRecovered,
    balance,
    locked,
    excess,
  };
}

function vaultStateEvidence(state) {
  return bigintFields(state);
}

async function assertNoPendingTransactions(provider, label, address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending"),
  ]);
  if (latest !== pending) {
    fail(
      `${label} has an unresolved pending transaction; reconcile its checkpoint hash before continuing`,
    );
  }
}

async function inspectRehearsalState(provider, build, config, factoryAddress) {
  const factory = new Contract(factoryAddress, build.factoryArtifact.abi, provider);
  const arena = getAddress(await factory.arena());
  if (arena !== ZeroAddress && arena !== config.binder) {
    fail("Sacrificial factory is bound to an unexpected arena");
  }
  if (arena === ZeroAddress) {
    return { arena, nextAction: "bind-sacrificial-arena" };
  }
  const predictedVault = getAddress(
    await factory.predict_vault(
      REHEARSAL_PAYOUT_ID,
      config.reserveSink,
      REHEARSAL_AMOUNT,
    ),
  );
  const actualVault = getAddress(await factory.vault_of(REHEARSAL_PAYOUT_ID));
  if (actualVault === ZeroAddress) {
    return {
      arena,
      predictedVault,
      nextAction: "prepare-one-wei-vault",
    };
  }
  if (actualVault !== predictedVault) fail("Prepared vault differs from prediction");
  const vault = new Contract(actualVault, build.vaultArtifact.abi, provider);
  const state = await readVaultState(vault);
  let nextAction;
  if (!state.credited) nextAction = "fund-exact-principal";
  else if (!state.withdrawn) nextAction = "recipient-withdraw";
  else if (state.totalArenaReceived === 1n) nextAction = "duplicate-fund-as-excess";
  else if (state.totalExcessRecovered === 0n) {
    nextAction = "permissionless-recover-excess";
  } else nextAction = "complete";
  return {
    arena,
    predictedVault,
    actualVault,
    vaultState: vaultStateEvidence(state),
    nextAction,
  };
}

export async function runRehearsal(
  provider,
  build,
  config,
  binderSigner,
  recipientSigner,
  factoryAddress,
  onSubmitted,
  eventFromBlock,
) {
  await Promise.all([
    assertNoPendingTransactions(provider, "binder", config.binder),
    assertNoPendingTransactions(provider, "rehearsal recipient", config.reserveSink),
  ]);
  const transactions = [];
  const factoryInterface = new Interface(build.factoryArtifact.abi);
  const vaultInterface = new Interface(build.vaultArtifact.abi);
  let factory = new Contract(factoryAddress, build.factoryArtifact.abi, provider);
  const currentArena = getAddress(await factory.arena());
  if (currentArena !== ZeroAddress && currentArena !== config.binder) {
    fail("Sacrificial factory is bound to an unexpected arena");
  }
  if (currentArena === ZeroAddress) {
    const transaction = await sendCheckedTransaction(
      "bind-sacrificial-arena",
      binderSigner,
      provider,
      {
        to: factoryAddress,
        data: factoryInterface.encodeFunctionData("bind_arena", [config.binder]),
      },
      config,
      onSubmitted,
    );
    transactions.push(transaction);
    const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
    requireEvent(receipt, factoryAddress, factoryInterface, "ArenaBound", (args) =>
      getAddress(args.arena) === config.binder,
    );
  }
  const verified = await verifyFactoryAt(provider, factoryAddress, build, config, {
    expectedArena: config.binder,
  });
  factory = verified.contract.connect(binderSigner);

  const predictedVault = await factory.predict_vault(
    REHEARSAL_PAYOUT_ID,
    config.reserveSink,
    REHEARSAL_AMOUNT,
  );
  let actualVault = getAddress(await factory.vault_of(REHEARSAL_PAYOUT_ID));
  if (actualVault === ZeroAddress) {
    if ((await provider.getCode(predictedVault)) !== "0x") {
      fail("Sacrificial predicted vault already contains code");
    }
    if ((await provider.getBalance(predictedVault)) !== 0n) {
      fail("Sacrificial predicted vault was pre-seeded");
    }
    const transaction = await sendCheckedTransaction(
      "prepare-one-wei-vault",
      binderSigner,
      provider,
      {
        to: factoryAddress,
        data: factoryInterface.encodeFunctionData("prepare", [
          REHEARSAL_PAYOUT_ID,
          config.reserveSink,
          REHEARSAL_AMOUNT,
        ]),
      },
      config,
      onSubmitted,
    );
    transactions.push(transaction);
    const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
    requireEvent(receipt, factoryAddress, factoryInterface, "PayoutPrepared", (args) =>
      getAddress(args.vault) === getAddress(predictedVault) &&
      getAddress(args.recipient) === config.reserveSink &&
      args.amount === REHEARSAL_AMOUNT,
    );
    actualVault = getAddress(await factory.vault_of(REHEARSAL_PAYOUT_ID));
  } else {
    const record = await factory.get_record(REHEARSAL_PAYOUT_ID);
    if (
      getAddress(record.vault) !== getAddress(predictedVault) ||
      getAddress(record.recipient) !== config.reserveSink ||
      record.amount !== REHEARSAL_AMOUNT ||
      !(await factory.is_prepared(
        REHEARSAL_PAYOUT_ID,
        config.reserveSink,
        REHEARSAL_AMOUNT,
      ))
    ) {
      fail("Existing sacrificial payout record does not match the rehearsal tuple");
    }
  }
  if (actualVault !== getAddress(predictedVault)) fail("Prepared vault differs from prediction");
  const vault = new Contract(actualVault, build.vaultArtifact.abi, provider);
  let state = await readVaultState(vault);
  const expectedPayoutIdHash = keccak256(toUtf8Bytes(REHEARSAL_PAYOUT_ID));
  if (
    state.factory !== getAddress(factoryAddress) ||
    state.arena !== config.binder ||
    state.reserveSink !== config.reserveSink ||
    state.recipient !== config.reserveSink ||
    state.amount !== REHEARSAL_AMOUNT ||
    state.payoutIdHash !== expectedPayoutIdHash ||
    state.totalArenaReceived > 2n ||
    state.totalExcessRecovered > 1n
  ) {
    fail("Sacrificial vault identity or counters do not match the rehearsal");
  }
  if (!state.credited) {
    if (
      state.withdrawn ||
      state.totalArenaReceived !== 0n ||
      state.totalExcessRecovered !== 0n ||
      state.balance !== 0n
    ) {
      fail("Uncredited sacrificial vault has unexpected prior state");
    }
    const transaction = await sendCheckedTransaction(
      "fund-exact-principal",
      binderSigner,
      provider,
      { to: actualVault, value: REHEARSAL_AMOUNT, data: "0x" },
      config,
      onSubmitted,
    );
    transactions.push(transaction);
    const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
    requireEvent(receipt, actualVault, vaultInterface, "PayoutCredited", (args) =>
      args.amount === REHEARSAL_AMOUNT,
    );
    state = await readVaultState(vault);
  }
  if (!state.withdrawn) {
    if (
      !state.credited ||
      state.totalArenaReceived !== 1n ||
      state.totalExcessRecovered !== 0n ||
      state.balance !== 1n ||
      state.locked !== 1n ||
      state.excess !== 0n
    ) {
      fail("Pre-withdrawal sacrificial state is not exact");
    }
    const transaction = await sendCheckedTransaction(
      "recipient-withdraw",
      recipientSigner,
      provider,
      {
        to: actualVault,
        data: vaultInterface.encodeFunctionData("withdraw"),
      },
      config,
      onSubmitted,
    );
    transactions.push(transaction);
    const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
    requireEvent(receipt, actualVault, vaultInterface, "PayoutWithdrawn", (args) =>
      getAddress(args.recipient) === config.reserveSink &&
      args.amount === REHEARSAL_AMOUNT,
    );
    state = await readVaultState(vault);
  }
  if (state.totalArenaReceived === 1n) {
    if (
      !state.credited ||
      !state.withdrawn ||
      state.totalExcessRecovered !== 0n ||
      state.balance !== 0n ||
      state.locked !== 0n ||
      state.excess !== 0n
    ) {
      fail("Pre-duplicate sacrificial state is not exact");
    }
    const transaction = await sendCheckedTransaction(
      "duplicate-fund-as-excess",
      binderSigner,
      provider,
      { to: actualVault, value: REHEARSAL_AMOUNT, data: "0x" },
      config,
      onSubmitted,
    );
    transactions.push(transaction);
    const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
    requireEvent(receipt, actualVault, vaultInterface, "ExcessReceived", (args) =>
      args.amount === REHEARSAL_AMOUNT && args.duplicate === true,
    );
    state = await readVaultState(vault);
  }
  if (state.totalExcessRecovered === 0n) {
    if (
      !state.credited ||
      !state.withdrawn ||
      state.totalArenaReceived !== 2n ||
      state.balance !== 1n ||
      state.locked !== 0n ||
      state.excess !== 1n
    ) {
      fail("Pre-recovery sacrificial state is not exact");
    }
    const transaction = await sendCheckedTransaction(
      "permissionless-recover-excess",
      binderSigner,
      provider,
      {
        to: actualVault,
        data: vaultInterface.encodeFunctionData("recover_excess"),
      },
      config,
      onSubmitted,
    );
    transactions.push(transaction);
    const receipt = await provider.getTransactionReceipt(transaction.transactionHash);
    requireEvent(receipt, actualVault, vaultInterface, "ExcessRecovered", (args) =>
      getAddress(args.reserveSink) === config.reserveSink &&
      args.amount === REHEARSAL_AMOUNT,
    );
    state = await readVaultState(vault);
  }
  if (
    state.factory !== getAddress(factoryAddress) ||
    state.arena !== config.binder ||
    state.reserveSink !== config.reserveSink ||
    state.recipient !== config.reserveSink ||
    state.amount !== REHEARSAL_AMOUNT ||
    !state.credited ||
    !state.withdrawn ||
    state.totalArenaReceived !== 2n ||
    state.totalExcessRecovered !== 1n ||
    state.balance !== 0n ||
    state.locked !== 0n ||
    state.excess !== 0n
  ) {
    fail("Sacrificial rehearsal final state is not exact");
  }

  const eventToBlock = await provider.getBlockNumber();
  const [boundEvents, preparedEvents, creditedEvents, withdrawnEvents, excessEvents, recoveredEvents] =
    await Promise.all([
      queryFilterInBradburyChunks(
        factory, factory.filters.ArenaBound(), eventFromBlock, eventToBlock,
      ),
      queryFilterInBradburyChunks(
        factory, factory.filters.PayoutPrepared(), eventFromBlock, eventToBlock,
      ),
      queryFilterInBradburyChunks(
        vault, vault.filters.PayoutCredited(), eventFromBlock, eventToBlock,
      ),
      queryFilterInBradburyChunks(
        vault, vault.filters.PayoutWithdrawn(), eventFromBlock, eventToBlock,
      ),
      queryFilterInBradburyChunks(
        vault, vault.filters.ExcessReceived(), eventFromBlock, eventToBlock,
      ),
      queryFilterInBradburyChunks(
        vault, vault.filters.ExcessRecovered(), eventFromBlock, eventToBlock,
      ),
    ]);
  if (
    boundEvents.length !== 1 ||
    preparedEvents.length !== 1 ||
    creditedEvents.length !== 1 ||
    withdrawnEvents.length !== 1 ||
    excessEvents.length !== 1 ||
    recoveredEvents.length !== 1
  ) {
    fail("Sacrificial rehearsal historical event counts are not exact");
  }
  if (
    getAddress(boundEvents[0].args.arena) !== config.binder ||
    getAddress(preparedEvents[0].args.vault) !== actualVault ||
    getAddress(preparedEvents[0].args.recipient) !== config.reserveSink ||
    preparedEvents[0].args.amount !== REHEARSAL_AMOUNT ||
    creditedEvents[0].args.amount !== REHEARSAL_AMOUNT ||
    getAddress(withdrawnEvents[0].args.recipient) !== config.reserveSink ||
    withdrawnEvents[0].args.amount !== REHEARSAL_AMOUNT ||
    excessEvents[0].args.amount !== REHEARSAL_AMOUNT ||
    excessEvents[0].args.duplicate !== true ||
    getAddress(recoveredEvents[0].args.reserveSink) !== config.reserveSink ||
    recoveredEvents[0].args.amount !== REHEARSAL_AMOUNT
  ) {
    fail("Sacrificial rehearsal historical event contents are not exact");
  }
  const signedByLabel = new Map(
    effectiveJournalEntries(config.evidencePath)
      .filter((entry) => entry.status === "signed")
      .map((entry) => [entry.label, entry.transactionHash]),
  );
  const expectedEventTransactions = [
    ["bind-sacrificial-arena", boundEvents[0]],
    ["prepare-one-wei-vault", preparedEvents[0]],
    ["fund-exact-principal", creditedEvents[0]],
    ["recipient-withdraw", withdrawnEvents[0]],
    ["duplicate-fund-as-excess", excessEvents[0]],
    ["permissionless-recover-excess", recoveredEvents[0]],
  ];
  for (const [label, event] of expectedEventTransactions) {
    const signedHash = signedByLabel.get(label);
    if (
      !signedHash ||
      typeof event.transactionHash !== "string" ||
      event.transactionHash.toLowerCase() !== signedHash.toLowerCase()
    ) {
      fail(`Sacrificial ${label} event is not tied to its exact signed transaction`);
    }
  }

  return {
    factory: verified.evidence,
    vault: { address: actualVault, state: vaultStateEvidence(state) },
    transactions,
    allExpectedEventsVerified: true,
    eventFromBlock,
    passed: true,
    warning: "This factory is sacrificial and MUST NOT be compiled into V8 or used in production.",
  };
}

function baseEvidence(config, build) {
  return {
    schema: EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    outcome: "started",
    mode: config.mode,
    broadcastRequested: config.broadcast,
    endpoint: endpointEvidence(config.rpcUrl, BRADBURY_RPC_URL),
    explorerApi: endpointEvidence(
      config.explorerApiUrl,
      BRADBURY_EXPLORER_API_URL,
    ),
    expectedChainId: BRADBURY_CHAIN_ID.toString(),
    expectedClient: "zksync-os/v0.21.0",
    roles: { binder: config.binder, reserveSink: config.reserveSink },
    buildLock: build.lock,
    factory: config.factory,
    reconciliationTransactionHash: config.txHash,
    anchorEligible: false,
  };
}

function evidenceJson(evidence) {
  return `${JSON.stringify(evidence, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2)}\n`;
}

export function assertEvidenceContainsNoSecrets(serialized, env = process.env) {
  const names = [
    "BRADBURY_EVM_KEYSTORE_JSON",
    "BRADBURY_EVM_KEYSTORE_B64",
    "BRADBURY_EVM_KEYSTORE_PASSWORD",
    "BRADBURY_EVM_RECIPIENT_KEYSTORE_JSON",
    "BRADBURY_EVM_RECIPIENT_KEYSTORE_B64",
    "BRADBURY_EVM_RECIPIENT_KEYSTORE_PASSWORD",
  ];
  for (const name of names) {
    const secret = env[name];
    if (secret && serialized.includes(secret)) {
      fail(`Evidence unexpectedly contains ${name}`);
    }
  }
}

export function writeEvidenceFile(filePath, evidence, overwrite, env = process.env) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    fail("Evidence parent directory must already exist");
  }
  const serialized = evidenceJson(evidence);
  assertEvidenceContainsNoSecrets(serialized, env);
  if (!overwrite && fs.existsSync(resolved)) {
    fail("Evidence file already exists");
  }
  const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    if (overwrite) {
      fs.renameSync(temporary, resolved);
    } else {
      // Linking the fully fsynced temporary inode gives a new evidence path
      // exclusive, atomic create semantics. A second process can never replace
      // the first run between the existence check above and publication here.
      fs.linkSync(temporary, resolved);
      fs.unlinkSync(temporary);
    }
    try {
      const directory = fs.openSync(parent, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(error?.code)
      ) {
        throw error;
      }
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary path may already have been renamed.
    }
    throw error;
  }
}

export function readEvidenceFile(filePath) {
  const resolved = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    fail(`Evidence ${resolved} is missing or invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object") fail("Evidence must be a JSON object");
  return parsed;
}

export function readCheckpointJournal(filePath) {
  const checkpointPath = `${path.resolve(filePath)}.checkpoints.jsonl`;
  const checkpointMetadata = lstatIfPresent(checkpointPath);
  if (!checkpointMetadata) return [];
  if (checkpointMetadata.isSymbolicLink()) {
    fail(`Checkpoint journal must not be a symbolic link: ${checkpointPath}`);
  }
  const descriptor = openRegularFileNoFollow(
    checkpointPath,
    fs.constants.O_RDONLY,
    0o600,
  );
  let text;
  try {
    text = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  if (text && !text.endsWith("\n")) {
    fail("Checkpoint journal has a torn final record and requires manual recovery");
  }
  const records = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        fail("Checkpoint journal contains invalid JSON");
      }
    });
  let previousEntryHash = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const { entryHash, ...unsigned } = record;
    if (
      record.schema !== JOURNAL_SCHEMA ||
      record.sequence !== index ||
      record.previousEntryHash !== previousEntryHash ||
      !/^([0-9a-f]{64})$/.test(String(entryHash ?? "")) ||
      sha256(canonicalJson(unsigned)) !== entryHash
    ) {
      fail(`Checkpoint journal integrity failed at sequence ${index}`);
    }
    previousEntryHash = entryHash;
  }
  return records;
}

export function appendDurableCheckpoint(filePath, entry, env = process.env) {
  if (!filePath) fail("A durable checkpoint path is required before signing");
  const checkpointPath = `${path.resolve(filePath)}.checkpoints.jsonl`;
  const records = readCheckpointJournal(filePath);
  const unsigned = {
    schema: JOURNAL_SCHEMA,
    sequence: records.length,
    previousEntryHash: records.at(-1)?.entryHash ?? null,
    recordedAt: new Date().toISOString(),
    entry: canonicalize(entry),
  };
  const envelope = {
    ...unsigned,
    entryHash: sha256(canonicalJson(unsigned)),
  };
  const serialized = `${JSON.stringify(envelope)}\n`;
  assertEvidenceContainsNoSecrets(serialized, env);
  const descriptor = openRegularFileNoFollow(
    checkpointPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return envelope;
}

function journalEntries(filePath) {
  return readCheckpointJournal(filePath).map((record) => record.entry);
}

function effectiveJournalEntries(filePath) {
  return journalEntries(filePath).flatMap((entry) =>
    entry.status === "provenance-import" ? [entry.importedEntry] : [entry],
  );
}

function evidenceFileSha256(filePath) {
  return sha256(fs.readFileSync(path.resolve(filePath)));
}

function provenanceFingerprint(filePath) {
  const journal = readCheckpointJournal(filePath);
  return {
    evidenceSha256: evidenceFileSha256(filePath),
    journalHeadHash: journal.at(-1)?.entryHash ?? null,
    journalEntries: journal.length,
  };
}

function importJournalProvenance(sourcePath, destinationPath, env) {
  const before = provenanceFingerprint(sourcePath);
  const sourceEntries = effectiveJournalEntries(sourcePath);
  for (const importedEntry of sourceEntries) {
    appendDurableCheckpoint(
      destinationPath,
      {
        status: "provenance-import",
        sourceEvidenceSha256: before.evidenceSha256,
        sourceJournalHeadHash: before.journalHeadHash,
        importedEntry,
        importedEntrySha256: sha256(canonicalJson(importedEntry)),
      },
      env,
    );
  }
  if (canonicalJson(provenanceFingerprint(sourcePath)) !== canonicalJson(before)) {
    fail("Rehearsal provenance changed while its journal was being imported");
  }
  return before;
}

function requireEvidenceCore(evidence, build, config, expectedMode) {
  if (
    evidence.schema !== EVIDENCE_SCHEMA ||
    evidence.mode !== expectedMode ||
    evidence.expectedChainId !== BRADBURY_CHAIN_ID.toString() ||
    getAddress(evidence.roles?.binder) !== config.binder ||
    getAddress(evidence.roles?.reserveSink) !== config.reserveSink ||
    canonicalJson(evidence.buildLock) !== canonicalJson(build.lock)
  ) {
    fail(`${expectedMode} evidence does not match the reviewed chain, roles, and build`);
  }
}

export async function requireRecordedTransactionFinality(provider, confirmedEntry) {
  const recorded = confirmedEntry.receipt;
  const transactionHash = confirmedEntry.transactionHash;
  if (!recorded || recorded.transactionHash !== transactionHash) {
    fail("Confirmed journal entry is missing its exact receipt evidence");
  }
  const [receipt, transaction, finalized] = await Promise.all([
    provider.getTransactionReceipt(transactionHash),
    provider.getTransaction(transactionHash),
    provider.getBlock("finalized"),
  ]);
  if (
    !receipt ||
    !transaction ||
    !finalized?.hash ||
    Number(receipt.status) !== 1 ||
    (receipt.hash ?? receipt.transactionHash) !== transactionHash ||
    transaction.hash !== transactionHash ||
    finalized.number < receipt.blockNumber ||
    receipt.blockHash !== recorded.blockHash ||
    transaction.blockHash !== receipt.blockHash ||
    receipt.blockNumber !== recorded.blockNumber ||
    getAddress(transaction.from) !== getAddress(recorded.from) ||
    (transaction.to ? getAddress(transaction.to) : null) !== recorded.to ||
    transaction.value.toString() !== recorded.value ||
    transaction.nonce !== recorded.nonce ||
    transaction.chainId !== BRADBURY_CHAIN_ID ||
    keccak256(transaction.data) !== recorded.transactionDataKeccak256
  ) {
    fail(`Journal transaction ${transactionHash} is not an exact finalized Bradbury receipt`);
  }
  const canonical = await provider.getBlock(receipt.blockNumber);
  if (!canonical?.hash || canonical.hash !== receipt.blockHash) {
    fail(`Journal transaction ${transactionHash} is not canonical at finality`);
  }
}

export async function requireFinalizedJournal(
  provider,
  evidencePath,
  expectedLabels,
  finalityTimeoutMs = DEFAULT_FINALITY_TIMEOUT_MS,
) {
  const entries = effectiveJournalEntries(evidencePath);
  const signed = entries.filter((entry) => entry.status === "signed");
  if (signed.length > MAX_REHEARSAL_SIGNED_TRANSACTIONS) {
    fail("Checkpoint journal exceeds the reviewed rehearsal transaction count");
  }
  const signedLabels = signed.map((entry) => entry.label);
  if (
    expectedLabels &&
    canonicalJson(signedLabels) !== canonicalJson(expectedLabels)
  ) {
    fail("Rehearsal journal does not contain the exact reviewed transaction sequence");
  }
  const confirmedEntries = entries.filter((entry) => entry.status === "confirmed");
  const lastConfirmed = confirmedEntries.reduce(
    (latest, entry) =>
      !latest || entry.receipt.blockNumber > latest.receipt.blockNumber
        ? entry
        : latest,
    undefined,
  );
  if (!lastConfirmed) fail("Rehearsal journal has no confirmed transactions");
  await waitForReceiptFinality(
    provider,
    {
      hash: lastConfirmed.transactionHash,
      blockNumber: lastConfirmed.receipt.blockNumber,
      blockHash: lastConfirmed.receipt.blockHash,
    },
    finalityTimeoutMs,
  );
  let sequenceWorstCaseCost = 0n;
  for (const signedEntry of signed) {
    if (
      typeof signedEntry.rawTransaction !== "string" ||
      keccak256(signedEntry.rawTransaction) !== signedEntry.transactionHash
    ) {
      fail("Journal signed transaction hash does not match its raw bytes");
    }
    const transaction = Transaction.from(signedEntry.rawTransaction);
    assertNoAccessList(transaction, "Journal signed transaction");
    const perGas = transaction.maxFeePerGas ?? transaction.gasPrice;
    if (
      transaction.hash !== signedEntry.transactionHash ||
      transaction.chainId !== BRADBURY_CHAIN_ID ||
      transaction.gasLimit <= 0n ||
      transaction.gasLimit > MAX_GAS_LIMIT ||
      perGas === null ||
      perGas <= 0n ||
      perGas > MAX_FEE_PER_GAS ||
      perGas * transaction.gasLimit > MAX_TRANSACTION_GAS_COST
    ) {
      fail("Journal signed transaction exceeds the reviewed chain, gas, or fee envelope");
    }
    sequenceWorstCaseCost += perGas * transaction.gasLimit + transaction.value;
    if (sequenceWorstCaseCost > MAX_SEQUENCE_NATIVE_COST) {
      fail("Journal signed sequence exceeds the reviewed total native-cost ceiling");
    }
    const confirmed = entries.find(
      (entry) =>
        entry.status === "confirmed" &&
        entry.transactionHash === signedEntry.transactionHash,
    );
    if (!confirmed) fail(`Signed transaction ${signedEntry.transactionHash} is not finalized`);
    await requireRecordedTransactionFinality(provider, confirmed);
  }
  return entries;
}

const REHEARSAL_TRANSACTION_LABELS = Object.freeze([
  "deploy-sacrificial-rehearsal-factory",
  "bind-sacrificial-arena",
  "prepare-one-wei-vault",
  "fund-exact-principal",
  "recipient-withdraw",
  "duplicate-fund-as-excess",
  "permissionless-recover-excess",
]);

async function buildRehearsalExpectedTransactions(
  build,
  config,
  factoryAddress,
) {
  const factoryInterface = new Interface(build.factoryArtifact.abi);
  const vaultInterface = new Interface(build.vaultArtifact.abi);
  const idHash = keccak256(toUtf8Bytes(REHEARSAL_PAYOUT_ID));
  const create2Domain = keccak256(
    toUtf8Bytes("LIQUIDITY_ARENA_PAYOUT_VAULT_CREATE2_V1"),
  );
  const salt = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [create2Domain, idHash],
    ),
  );
  const vaultCreationBytecode = `0x${build.vaultArtifact.evm.bytecode.object}`;
  const vaultConstructor = AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "uint256", "bytes32"],
    [
      config.binder,
      config.reserveSink,
      config.reserveSink,
      REHEARSAL_AMOUNT,
      idHash,
    ],
  );
  const predictedVault = getCreate2Address(
    factoryAddress,
    salt,
    keccak256(concat([vaultCreationBytecode, vaultConstructor])),
  );
  const deploymentFactory = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
  );
  const deploymentRequest = await deploymentFactory.getDeployTransaction(
    config.binder,
    config.reserveSink,
  );
  const expected = new Map([
    [
      "deploy-sacrificial-rehearsal-factory",
      {
        from: config.binder,
        to: null,
        value: 0n,
        data: deploymentRequest.data,
      },
    ],
    [
      "bind-sacrificial-arena",
      {
        from: config.binder,
        to: factoryAddress,
        value: 0n,
        data: factoryInterface.encodeFunctionData("bind_arena", [config.binder]),
      },
    ],
    [
      "prepare-one-wei-vault",
      {
        from: config.binder,
        to: factoryAddress,
        value: 0n,
        data: factoryInterface.encodeFunctionData("prepare", [
          REHEARSAL_PAYOUT_ID,
          config.reserveSink,
          REHEARSAL_AMOUNT,
        ]),
      },
    ],
    [
      "fund-exact-principal",
      { from: config.binder, to: predictedVault, value: REHEARSAL_AMOUNT, data: "0x" },
    ],
    [
      "recipient-withdraw",
      {
        from: config.reserveSink,
        to: predictedVault,
        value: 0n,
        data: vaultInterface.encodeFunctionData("withdraw"),
      },
    ],
    [
      "duplicate-fund-as-excess",
      { from: config.binder, to: predictedVault, value: REHEARSAL_AMOUNT, data: "0x" },
    ],
    [
      "permissionless-recover-excess",
      {
        from: config.binder,
        to: predictedVault,
        value: 0n,
        data: vaultInterface.encodeFunctionData("recover_excess"),
      },
    ],
  ]);
  return { predictedVault, expected };
}

async function requireRehearsalSignedIntents(
  provider,
  build,
  config,
  factoryAddress,
  entries,
) {
  const { predictedVault, expected } = await buildRehearsalExpectedTransactions(
    build,
    config,
    factoryAddress,
  );
  const hashes = {};
  for (const label of REHEARSAL_TRANSACTION_LABELS) {
    const matches = entries.filter(
      (entry) => entry.status === "signed" && entry.label === label,
    );
    if (matches.length !== 1) {
      fail(`Rehearsal provenance requires one exact signed ${label} transaction`);
    }
    const signed = matches[0];
    const transaction = Transaction.from(signed.rawTransaction);
    assertNoAccessList(transaction, `Rehearsal signed ${label} transaction`);
    const intent = expected.get(label);
    if (
      getAddress(transaction.from) !== getAddress(intent.from) ||
      (transaction.to ? getAddress(transaction.to) : null) !==
        (intent.to ? getAddress(intent.to) : null) ||
      transaction.value !== intent.value ||
      keccak256(transaction.data) !== keccak256(intent.data)
    ) {
      fail(`Rehearsal signed ${label} transaction does not match the reviewed intent`);
    }
    if (
      label === "deploy-sacrificial-rehearsal-factory" &&
      getCreateAddress({ from: transaction.from, nonce: transaction.nonce }) !==
        getAddress(factoryAddress)
    ) {
      fail("Sacrificial deployment signed intent does not derive the proven factory");
    }
    hashes[label] = signed.transactionHash;
  }
  return { predictedVault, hashes };
}

export async function requireRehearsalProvenance(
  provider,
  build,
  config,
  evidencePath,
  { requirePassed },
) {
  const fingerprintBefore = provenanceFingerprint(evidencePath);
  const rehearsalEvidence = readEvidenceFile(evidencePath);
  requireEvidenceCore(rehearsalEvidence, build, config, "rehearsal");
  const factoryAddress = requiredAddress(
    "rehearsal evidence factory",
    rehearsalEvidence.factory ??
      rehearsalEvidence.pendingTransaction?.predictedFactory,
  );
  const entries = effectiveJournalEntries(evidencePath);
  const deployment = entries.find(
    (entry) =>
      entry.status === "signed" &&
      entry.label === "deploy-sacrificial-rehearsal-factory" &&
      entry.predictedFactory === factoryAddress,
  );
  const deploymentConfirmed = entries.find(
    (entry) =>
      entry.status === "confirmed" &&
      entry.label === "deploy-sacrificial-rehearsal-factory" &&
      entry.transactionHash === deployment?.transactionHash,
  );
  if (!deployment || !deploymentConfirmed) {
    fail("Factory is not proven by the sacrificial rehearsal deployment journal");
  }
  if (
    !requirePassed &&
    config.fromBlock !== deploymentConfirmed.receipt?.blockNumber
  ) {
    fail("Rehearsal resume --from-block must equal the finalized sacrificial deployment block");
  }
  await requireRecordedTransactionFinality(provider, deploymentConfirmed);
  const factoryReader = new Contract(
    factoryAddress,
    build.factoryArtifact.abi,
    provider,
  );
  const currentArena = getAddress(await factoryReader.arena());
  if (currentArena !== ZeroAddress && currentArena !== config.binder) {
    fail("Sacrificial rehearsal factory is bound to an unexpected arena");
  }
  await verifyFactoryAt(provider, factoryAddress, build, config, {
    expectedArena: requirePassed ? config.binder : currentArena,
  });
  if (!requirePassed) {
    const signedLabels = entries
      .filter((entry) => entry.status === "signed")
      .map((entry) => entry.label);
    if (
      signedLabels.length === 0 ||
      signedLabels.length > REHEARSAL_TRANSACTION_LABELS.length ||
      canonicalJson(signedLabels) !== canonicalJson(
        REHEARSAL_TRANSACTION_LABELS.slice(0, signedLabels.length),
      )
    ) {
      fail("Rehearsal resume provenance is not an exact signed prefix of the reviewed sequence");
    }
    await requireFinalizedJournal(
      provider,
      evidencePath,
      signedLabels,
      config.finalityTimeoutMs,
    );
    const fingerprintAfter = provenanceFingerprint(evidencePath);
    if (canonicalJson(fingerprintAfter) !== canonicalJson(fingerprintBefore)) {
      fail("Rehearsal provenance changed while it was being verified");
    }
    return {
      evidence: rehearsalEvidence,
      factoryAddress,
      fingerprint: fingerprintAfter,
    };
  }
  if (
    !rehearsalEvidence.rehearsal?.passed ||
    !rehearsalEvidence.rehearsal?.allExpectedEventsVerified ||
    rehearsalEvidence.outcome !== "sacrificial-rehearsal-passed"
  ) {
    fail("Production requires a completely passed sacrificial rehearsal");
  }
  await requireFinalizedJournal(
      provider,
      evidencePath,
      REHEARSAL_TRANSACTION_LABELS,
      config.finalityTimeoutMs,
    );
  if (
    rehearsalEvidence.rehearsal.eventFromBlock !==
    deploymentConfirmed.receipt.blockNumber
  ) {
    fail("Passed rehearsal event provenance must start at its exact deployment block");
  }
  const signedIntent = await requireRehearsalSignedIntents(
    provider,
    build,
    config,
    factoryAddress,
    entries,
  );
  const state = await inspectRehearsalState(
    provider,
    build,
    config,
    factoryAddress,
  );
  if (state.nextAction !== "complete") fail("Sacrificial rehearsal state is not complete");
  await runRehearsal(
    provider,
    build,
    { ...config, evidencePath },
    provider,
    provider,
    factoryAddress,
    async () => fail("A completed rehearsal proof attempted a transaction"),
    rehearsalEvidence.rehearsal.eventFromBlock,
  );
  if (state.actualVault !== signedIntent.predictedVault) {
    fail("Completed rehearsal vault differs from its reviewed signed intents");
  }
  const fingerprintAfter = provenanceFingerprint(evidencePath);
  if (canonicalJson(fingerprintAfter) !== canonicalJson(fingerprintBefore)) {
    fail("Rehearsal provenance changed while it was being verified");
  }
  const finalizedTransactions = REHEARSAL_TRANSACTION_LABELS.map((label) => {
    const transactionHash = signedIntent.hashes[label];
    const confirmed = entries.find(
      (entry) =>
        entry.status === "confirmed" &&
        entry.label === label &&
        entry.transactionHash === transactionHash,
    );
    if (!confirmed?.receipt?.blockHash ||
        !Number.isSafeInteger(confirmed.receipt.blockNumber)) {
      fail(`Rehearsal ${label} is missing exact finalized block provenance`);
    }
    return {
      label,
      transactionHash,
      blockNumber: confirmed.receipt.blockNumber,
      blockHash: confirmed.receipt.blockHash,
    };
  });
  const authorization = {
    schema: "liquidity-arena-bradbury-rehearsal-authorization-v1",
    evidenceSha256: fingerprintAfter.evidenceSha256,
    journalHeadHash: fingerprintAfter.journalHeadHash,
    journalEntries: fingerprintAfter.journalEntries,
    factoryAddress,
    outcome: rehearsalEvidence.outcome,
    finalizedTransactions,
  };
  return {
    evidence: rehearsalEvidence,
    factoryAddress,
    fingerprint: fingerprintAfter,
    authorization,
  };
}

export async function validateJournaledFactoryDeployment(
  build,
  config,
  signed,
) {
  if (!signed?.rawTransaction) {
    fail("No exact signed transaction exists in the journal for this hash");
  }
  if (keccak256(signed.rawTransaction) !== config.txHash) {
    fail("Journaled raw transaction does not match --tx-hash");
  }
  const transaction = Transaction.from(signed.rawTransaction);
  assertNoAccessList(transaction, "Journaled factory deployment");
  const factory = new ContractFactory(build.factoryArtifact.abi, build.creationBytecode);
  const expected = await factory.getDeployTransaction(config.binder, config.reserveSink);
  const expectedMode = config.expectedMode ?? config.mode;
  if (
    getAddress(transaction.from) !== config.binder ||
    transaction.to !== null ||
    transaction.chainId !== BRADBURY_CHAIN_ID ||
    transaction.value !== 0n ||
    ![0, 2].includes(transaction.type) ||
    transaction.gasLimit <= 0n ||
    transaction.gasLimit > MAX_GAS_LIMIT ||
    keccak256(transaction.data) !== keccak256(expected.data)
  ) {
    fail("Journaled signed transaction is not the exact reviewed factory deployment");
  }
  const perGas = transaction.maxFeePerGas ?? transaction.gasPrice;
  if (
    perGas === null ||
    perGas <= 0n ||
    perGas > MAX_FEE_PER_GAS ||
    perGas * transaction.gasLimit > MAX_TRANSACTION_GAS_COST
  ) {
    fail("Journaled signed transaction exceeds the reviewed fee ceiling");
  }
  const exactFees = transaction.type === 2
    ? {
        type: 2,
        maxFeePerGas: transaction.maxFeePerGas.toString(),
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
        maximumGasCost: (perGas * transaction.gasLimit).toString(),
      }
    : {
        type: 0,
        gasPrice: transaction.gasPrice.toString(),
        maximumGasCost: (perGas * transaction.gasLimit).toString(),
      };
  const expectedIntent = {
    schema: "liquidity-arena-bradbury-signed-intent-v1",
    chainId: BRADBURY_CHAIN_ID.toString(),
    mode: expectedMode,
    binder: config.binder,
    reserveSink: config.reserveSink,
    buildLock: build.lock,
    ...(expectedMode === "production"
      ? { rehearsalAuthorization: config.rehearsalAuthorization }
      : {}),
    nonce: transaction.nonce,
    predictedAddress: getCreateAddress({
      from: transaction.from,
      nonce: transaction.nonce,
    }),
    to: null,
    value: "0",
    transactionDataKeccak256: keccak256(transaction.data),
    gasLimit: transaction.gasLimit.toString(),
    fees: exactFees,
  };
  if (
    (expectedMode === "production" && !config.rehearsalAuthorization) ||
    canonicalJson(signed.reviewedIntent) !== canonicalJson(expectedIntent) ||
    signed.requiredBroadcastConfirmation !==
      requiredIntentConfirmation(expectedIntent)
  ) {
    fail("Journaled deployment is not bound to its exact reviewed confirmation intent");
  }
  const expectedExactTransaction = {
    from: config.binder,
    to: null,
    nonce: transaction.nonce,
    chainId: BRADBURY_CHAIN_ID.toString(),
    value: "0",
    gasLimit: transaction.gasLimit.toString(),
    fees: exactFees,
    projectedSequenceNativeCost: exactFees.maximumGasCost,
    transactionDataKeccak256: keccak256(transaction.data),
  };
  if (canonicalJson(signed.exactTransaction) !== canonicalJson(expectedExactTransaction)) {
    fail("Journaled deployment exact transaction envelope is incomplete or altered");
  }
  return { signed, transaction, expectedIntent };
}

export async function validateJournaledRehearsalTransaction(
  provider,
  build,
  config,
  evidence,
  transactionHash,
) {
  if (evidence.mode !== "rehearsal" || config.mode !== "rehearsal") {
    fail("Post-deployment rehearsal recovery requires explicit --rehearse and rehearsal evidence");
  }
  const factoryAddress = requiredAddress(
    "rehearsal recovery factory",
    evidence.factory,
  );
  const entries = effectiveJournalEntries(config.evidencePath);
  const signedEntries = entries.filter((entry) => entry.status === "signed");
  const labels = signedEntries.map((entry) => entry.label);
  if (
    signedEntries.length < 2 ||
    signedEntries.length > REHEARSAL_TRANSACTION_LABELS.length ||
    canonicalJson(labels) !== canonicalJson(
      REHEARSAL_TRANSACTION_LABELS.slice(0, signedEntries.length),
    )
  ) {
    fail("Rehearsal recovery journal is not an exact signed prefix of the reviewed sequence");
  }
  const targetIndex = signedEntries.findIndex(
    (entry) => entry.transactionHash === transactionHash,
  );
  if (targetIndex <= 0) {
    fail("Rehearsal recovery hash is not a signed post-deployment transaction");
  }
  const deployment = signedEntries[0];
  await validateJournaledFactoryDeployment(
    build,
    {
      ...config,
      txHash: deployment.transactionHash,
      expectedMode: "rehearsal",
      rehearsalAuthorization: undefined,
    },
    deployment,
  );
  if (requiredAddress(
    "rehearsal deployment predicted factory",
    deployment.predictedFactory,
  ) !== factoryAddress) {
    fail("Rehearsal recovery factory differs from its exact deployment checkpoint");
  }
  const deploymentConfirmed = entries.find(
    (entry) =>
      entry.status === "confirmed" &&
      entry.transactionHash === deployment.transactionHash,
  );
  if (!Number.isSafeInteger(deploymentConfirmed?.receipt?.blockNumber)) {
    fail("Rehearsal recovery deployment is missing its exact confirmed block");
  }
  const resumeConfirmation = requiredIntentConfirmation({
    schema: "liquidity-arena-bradbury-rehearsal-resume-v1",
    chainId: BRADBURY_CHAIN_ID.toString(),
    factory: factoryAddress,
    binder: config.binder,
    reserveSink: config.reserveSink,
    fromBlock: deploymentConfirmed.receipt.blockNumber,
    buildLock: build.lock,
  });
  const allowedSequenceConfirmations = new Set([
    deployment.requiredBroadcastConfirmation,
    resumeConfirmation,
  ]);
  for (let index = 0; index < targetIndex; index += 1) {
    const prior = signedEntries[index];
    const confirmed = entries.find(
      (entry) =>
        entry.status === "confirmed" &&
        entry.transactionHash === prior.transactionHash,
    );
    if (!confirmed) {
      fail("Rehearsal recovery cannot skip an earlier unconfirmed signed transaction");
    }
    await requireRecordedTransactionFinality(provider, confirmed);
  }
  const targetAlreadyConfirmed = entries.some(
    (entry) =>
      entry.status === "confirmed" &&
      entry.transactionHash === transactionHash,
  );
  if (!targetAlreadyConfirmed && targetIndex !== signedEntries.length - 1) {
    fail("Rehearsal recovery target is not the latest unresolved signed transaction");
  }
  const { predictedVault, expected } = await buildRehearsalExpectedTransactions(
    build,
    config,
    factoryAddress,
  );
  let projectedSequenceNativeCost = 0n;
  for (let index = 0; index < signedEntries.length; index += 1) {
    const signed = signedEntries[index];
    if (
      typeof signed.rawTransaction !== "string" ||
      keccak256(signed.rawTransaction) !== signed.transactionHash
    ) {
      fail("Rehearsal recovery raw transaction does not match its journaled hash");
    }
    const transaction = Transaction.from(signed.rawTransaction);
    assertNoAccessList(transaction, `Rehearsal recovery ${signed.label}`);
    const perGas = transaction.maxFeePerGas ?? transaction.gasPrice;
    if (
      transaction.hash !== signed.transactionHash ||
      transaction.chainId !== BRADBURY_CHAIN_ID ||
      ![0, 2].includes(transaction.type) ||
      transaction.gasLimit <= 0n ||
      transaction.gasLimit > MAX_GAS_LIMIT ||
      perGas === null ||
      perGas <= 0n ||
      perGas > MAX_FEE_PER_GAS ||
      perGas * transaction.gasLimit > MAX_TRANSACTION_GAS_COST
    ) {
      fail("Rehearsal recovery transaction exceeds the reviewed chain, gas, or fee envelope");
    }
    projectedSequenceNativeCost +=
      perGas * transaction.gasLimit + transaction.value;
    if (projectedSequenceNativeCost > MAX_SEQUENCE_NATIVE_COST) {
      fail("Rehearsal recovery sequence exceeds the reviewed total native-cost ceiling");
    }
    if (index === 0) continue;
    const intent = expected.get(signed.label);
    if (
      !intent ||
      getAddress(transaction.from) !== getAddress(intent.from) ||
      getAddress(transaction.to) !== getAddress(intent.to) ||
      transaction.value !== intent.value ||
      keccak256(transaction.data) !== keccak256(intent.data)
    ) {
      fail(`Rehearsal recovery ${signed.label} is not the exact reviewed action`);
    }
    const exactFees = transaction.type === 2
      ? {
          type: 2,
          maxFeePerGas: transaction.maxFeePerGas.toString(),
          maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
          maximumGasCost: (perGas * transaction.gasLimit).toString(),
        }
      : {
          type: 0,
          gasPrice: transaction.gasPrice.toString(),
          maximumGasCost: (perGas * transaction.gasLimit).toString(),
        };
    const expectedExactTransaction = {
      from: getAddress(intent.from),
      to: getAddress(intent.to),
      nonce: transaction.nonce,
      chainId: BRADBURY_CHAIN_ID.toString(),
      value: intent.value.toString(),
      gasLimit: transaction.gasLimit.toString(),
      fees: exactFees,
      projectedSequenceNativeCost: projectedSequenceNativeCost.toString(),
      transactionDataKeccak256: keccak256(intent.data),
    };
    if (
      signed.reviewedIntent !== undefined ||
      !allowedSequenceConfirmations.has(signed.requiredBroadcastConfirmation) ||
      canonicalJson(signed.exactTransaction) !==
        canonicalJson(expectedExactTransaction)
    ) {
      fail(`Rehearsal recovery ${signed.label} checkpoint envelope is incomplete or altered`);
    }
  }
  const signed = signedEntries[targetIndex];
  const transaction = Transaction.from(signed.rawTransaction);
  return {
    signed,
    transaction,
    expected: expected.get(signed.label),
    factoryAddress,
    predictedVault,
    deployment,
  };
}

async function rebroadcastExactJournaledTransaction(
  provider,
  signed,
  config,
  checkpoint,
) {
  assertIntentConfirmation(config, signed.requiredBroadcastConfirmation);
  await checkpoint({
    label: signed.label,
    status: "broadcast-attempt",
    transactionHash: config.txHash,
    exactReplay: true,
  });
  try {
    const response = await provider.broadcastTransaction(signed.rawTransaction);
    if (response.hash !== config.txHash) fail("Replay returned a different hash");
  } catch (error) {
    if (error instanceof Error && error.message === "Replay returned a different hash") {
      throw error;
    }
    if (!(await provider.getTransaction(config.txHash))) {
      fail("Exact signed replay remains ambiguous; do not create a replacement transaction");
    }
  }
  await checkpoint({
    label: signed.label,
    status: "submitted",
    transactionHash: config.txHash,
    exactReplay: true,
  });
}

async function reconcileJournaledRehearsalTransaction(
  provider,
  recovered,
  config,
) {
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(config.txHash),
    provider.getTransactionReceipt(config.txHash),
  ]);
  if (receipt && !transaction) {
    fail("Rehearsal recovery found a receipt without its exact transaction envelope");
  }
  if (transaction) {
    const exact = recovered.transaction;
    assertNoAccessList(transaction, "Live rehearsal recovery transaction");
    if (
      transaction.hash !== config.txHash ||
      getAddress(transaction.from) !== getAddress(exact.from) ||
      (transaction.to ? getAddress(transaction.to) : null) !==
        (exact.to ? getAddress(exact.to) : null) ||
      transaction.chainId !== BRADBURY_CHAIN_ID ||
      transaction.nonce !== exact.nonce ||
      transaction.type !== exact.type ||
      transaction.value !== exact.value ||
      transaction.gasLimit !== exact.gasLimit ||
      transaction.maxFeePerGas !== exact.maxFeePerGas ||
      transaction.maxPriorityFeePerGas !== exact.maxPriorityFeePerGas ||
      (exact.type === 0 && transaction.gasPrice !== exact.gasPrice) ||
      keccak256(transaction.data) !== keccak256(exact.data)
    ) {
      fail("Live rehearsal recovery transaction differs from the exact journaled raw bytes");
    }
  }
  if (!transaction || !receipt) {
    return {
      pending: true,
      evidence: {
        transactionHash: config.txHash,
        transactionFound: Boolean(transaction),
        receiptFound: Boolean(receipt),
        exactSignedBytesValidated: true,
      },
    };
  }
  const verified = await verifyReceipt(
    provider,
    config.txHash,
    {
      from: recovered.expected.from,
      to: recovered.expected.to,
      data: recovered.expected.data,
      value: recovered.expected.value,
    },
    config.confirmations,
    config.timeoutMs,
    {
      requireFinality: true,
      finalityTimeoutMs: config.finalityTimeoutMs,
    },
  );
  return {
    pending: false,
    evidence: {
      ...verified.evidence,
      transactionFound: true,
      receiptFound: true,
      exactSignedBytesValidated: true,
      rehearsalLabel: recovered.signed.label,
      factory: recovered.factoryAddress,
      predictedVault: recovered.predictedVault,
    },
  };
}

export async function rebroadcastJournaledTransaction(provider, build, config, checkpoint) {
  const entries = effectiveJournalEntries(config.evidencePath);
  const signed = entries.find(
    (entry) =>
      entry.status === "signed" && entry.transactionHash === config.txHash,
  );
  await validateJournaledFactoryDeployment(build, config, signed);
  await rebroadcastExactJournaledTransaction(
    provider,
    signed,
    config,
    checkpoint,
  );
}

export async function runBradburyFactoryTool(
  argv,
  env = process.env,
  {
    providerFactory = (url) => new JsonRpcProvider(url),
    walletLoader = loadEncryptedWallet,
    fetchImpl,
  } = {},
) {
  const args = parseArguments(argv);
  if (args.help) return { help: true };
  const config = resolveConfiguration(args, env);
  const build = loadLockedPayoutBuild();
  if (config.broadcast || config.txHash) {
    requireProtectedOperationalPath(config.evidencePath, "Factory evidence");
    requireProtectedOperationalPath(
      `${config.evidencePath}.checkpoints.jsonl`,
      "Factory checkpoint journal",
    );
  }
  if (config.rehearsalEvidencePath) {
    requireProtectedOperationalPath(
      config.rehearsalEvidencePath,
      "Rehearsal evidence",
    );
    requireProtectedOperationalPath(
      `${config.rehearsalEvidencePath}.checkpoints.jsonl`,
      "Rehearsal checkpoint journal",
    );
  }
  let evidence = baseEvidence(config, build);
  const evidenceResolved = config.evidencePath
    ? path.resolve(config.evidencePath)
    : undefined;
  const checkpointResolved = evidenceResolved
    ? `${evidenceResolved}.checkpoints.jsonl`
    : undefined;
  const evidenceExists = Boolean(evidenceResolved && fs.existsSync(evidenceResolved));
  const journalExists = Boolean(
    checkpointResolved && fs.existsSync(checkpointResolved),
  );
  const recoveryRun = Boolean(config.txHash);
  if (config.overwriteEvidence && journalExists) {
    fail("Checkpoint journals are append-only and can never be overwritten");
  }
  if (recoveryRun && (!evidenceExists || !journalExists)) {
    fail("Signed recovery requires the original evidence and checkpoint journal");
  }
  if (config.broadcast && !recoveryRun && (evidenceExists || journalExists)) {
    fail("A new broadcast requires a new, exclusive evidence path");
  }
  if (!config.broadcast && !recoveryRun && evidenceExists && !config.overwriteEvidence) {
    fail("Evidence file already exists; use a new path or explicitly replace only a journal-free dry-run summary");
  }
  if (recoveryRun) {
    evidence = readEvidenceFile(config.evidencePath);
    readCheckpointJournal(config.evidencePath);
  }
  let evidenceWritten = evidenceExists;
  const persistEvidence = () => {
    if (!config.evidencePath) return;
    writeEvidenceFile(
      config.evidencePath,
      evidence,
      evidenceWritten || config.overwriteEvidence,
      env,
    );
    evidenceWritten = true;
  };
  const checkpoint = async (entry) => {
    appendDurableCheckpoint(config.evidencePath, entry, env);
    const { rawTransaction: _rawTransaction, ...publicEntry } = entry;
    evidence.transactionCheckpoints ??= [];
    evidence.transactionCheckpoints.push(publicEntry);
    if (["signed", "broadcast-attempt", "submitted"].includes(entry.status)) {
      evidence.outcome = "transaction-submitted-awaiting-confirmation";
      evidence.pendingTransaction = publicEntry;
      if (entry.status === "submitted") {
        process.stderr.write(
          `Submitted ${entry.label}: ${entry.transactionHash}. Never create a replacement; reconcile or replay only this signed hash.\n`,
        );
      }
    } else if (
      evidence.pendingTransaction?.transactionHash === entry.transactionHash
    ) {
      delete evidence.pendingTransaction;
    }
    persistEvidence();
  };
  let operationLock;
  let provider;

  try {
    if (config.broadcast || config.txHash) {
      operationLock = acquireBradburySignerLocks([
        config.binder,
        ...(config.mode === "rehearsal" ? [config.reserveSink] : []),
      ]);
    }
    if (config.broadcast && !recoveryRun) {
      persistEvidence();
      appendDurableCheckpoint(
        config.evidencePath,
        {
          status: "journal-opened",
          mode: config.mode,
          chainId: BRADBURY_CHAIN_ID.toString(),
          roles: evidence.roles,
          buildLock: build.lock,
        },
        env,
      );
    }
    provider = providerFactory(config.rpcUrl);
    evidence.network = await readBradburyIdentity(provider);
    await Promise.all([
      assertExternallyOwnedRole(provider, "binder", config.binder),
      assertExternallyOwnedRole(provider, "reserve sink", config.reserveSink),
    ]);
    evidence.rolesAreCodeFree = true;

    if (config.txHash) {
      requireEvidenceCore(evidence, build, config, evidence.mode);
      if (
        !["production", "rehearsal"].includes(evidence.mode) ||
        (evidence.mode === "rehearsal") !== (config.mode === "rehearsal")
      ) {
        fail("Transaction recovery mode must exactly match the original evidence; add --rehearse only for a rehearsal hash");
      }
      const recoveredSigned = effectiveJournalEntries(config.evidencePath).find(
        (entry) =>
          entry.status === "signed" &&
          entry.transactionHash === config.txHash,
      );
      if (!recoveredSigned) {
        fail("The recovery journal has no matching exact signed transaction");
      }
      const deploymentRecovery = [
        "deploy-production-factory",
        "deploy-sacrificial-rehearsal-factory",
      ].includes(recoveredSigned.label);
      if (!deploymentRecovery) {
        const recovered = await validateJournaledRehearsalTransaction(
          provider,
          build,
          config,
          evidence,
          config.txHash,
        );
        if (config.rebroadcastSigned) {
          config.requiredBroadcastConfirmation =
            recoveredSigned.requiredBroadcastConfirmation;
          await rebroadcastExactJournaledTransaction(
            provider,
            recoveredSigned,
            config,
            checkpoint,
          );
        }
        const reconciliation = await reconcileJournaledRehearsalTransaction(
          provider,
          recovered,
          config,
        );
        evidence.factory = recovered.factoryAddress;
        evidence.rehearsalTransactionReconciliation = reconciliation.evidence;
        if (reconciliation.pending) {
          evidence.outcome = "rehearsal-transaction-pending";
          evidence.pendingTransaction = {
            label: recoveredSigned.label,
            status: "pending",
            transactionHash: config.txHash,
            factory: recovered.factoryAddress,
            predictedVault: recovered.predictedVault,
          };
        } else {
          if (
            !effectiveJournalEntries(config.evidencePath).some(
              (entry) =>
                entry.status === "confirmed" &&
                entry.transactionHash === config.txHash,
            )
          ) {
            await checkpoint({
              label: recoveredSigned.label,
              status: "confirmed",
              transactionHash: config.txHash,
              receipt: reconciliation.evidence,
              exactReplay: config.rebroadcastSigned,
            });
          }
          evidence.rehearsalSnapshot = await inspectRehearsalState(
            provider,
            build,
            config,
            recovered.factoryAddress,
          );
          evidence.outcome = "rehearsal-transaction-reconciled";
          evidence.nextAction = evidence.rehearsalSnapshot.nextAction === "complete"
            ? "Revalidate the completed rehearsal proof before authorizing production."
            : `Resume the same sacrificial factory with --rehearse --factory ${recovered.factoryAddress}, its exact --from-block, and the original session as --rehearsal-evidence.`;
        }
      } else {
        config.expectedMode = evidence.mode;
        config.rehearsalAuthorization = evidence.mode === "production"
          ? validateRehearsalAuthorization(
              evidence.rehearsalProvenance?.authorization,
            )
          : undefined;
        await validateJournaledFactoryDeployment(
          build,
          config,
          recoveredSigned,
        );
        if (config.rebroadcastSigned) {
          config.requiredBroadcastConfirmation =
            recoveredSigned.requiredBroadcastConfirmation;
          await rebroadcastJournaledTransaction(
            provider,
            build,
            config,
            checkpoint,
          );
        }
        const reconciliation = await reconcileFactoryDeploymentTransaction(
          provider,
          config.txHash,
          build,
          config,
        );
        evidence.factory = reconciliation.address;
        evidence.transactionReconciliation = reconciliation.evidence;
        if (reconciliation.pending) {
          evidence.outcome = "deployment-transaction-pending";
          evidence.pendingTransaction = {
            label: recoveredSigned.label,
            status: "pending",
            transactionHash: config.txHash,
            predictedFactory: reconciliation.address,
          };
        } else {
          evidence.factoryVerification =
            reconciliation.evidence.factoryVerification;
          if (
            !effectiveJournalEntries(config.evidencePath).some(
              (entry) =>
                entry.status === "confirmed" &&
                entry.transactionHash === config.txHash,
            )
          ) {
            await checkpoint({
              label: recoveredSigned.label,
              status: "confirmed",
              transactionHash: config.txHash,
              receipt: reconciliation.evidence,
              exactReplay: config.rebroadcastSigned,
            });
          }
          if (evidence.mode === "production") {
            if (config.submitExplorerVerification) {
              evidence.explorerSubmission = await submitExplorerVerification(
                config.explorerApiUrl,
                reconciliation.address,
                build,
                config,
                { fetchImpl, timeoutMs: config.timeoutMs },
              );
            }
            evidence.explorerVerification = await inspectExplorerVerification(
              config.explorerApiUrl,
              reconciliation.address,
              config,
              { fetchImpl },
            );
            if (
              config.requireExplorerVerified &&
              !evidence.explorerVerification.sourceLockMatched
            ) {
              fail("Explorer source verification does not match the reviewed build lock");
            }
            evidence.anchorEligible = false;
            evidence.anchorBlocker =
              "Finalized rehearsal provenance, independent review, and the V8 source/CI gate remain external requirements.";
            evidence.outcome = "deployment-transaction-reconciled";
          } else {
            evidence.rehearsalSnapshot = await inspectRehearsalState(
              provider,
              build,
              config,
              reconciliation.address,
            );
            evidence.outcome = "sacrificial-deployment-transaction-reconciled";
            evidence.nextAction =
              `Resume the same sacrificial factory with --rehearse --factory ${reconciliation.address}, its exact --from-block, and this session as --rehearsal-evidence.`;
          }
        }
      }
    } else if (config.factory) {
      let expectedArena = ZeroAddress;
      if (config.mode === "rehearsal") {
        const candidate = new Contract(
          config.factory,
          build.factoryArtifact.abi,
          provider,
        );
        expectedArena = getAddress(await candidate.arena());
        if (expectedArena !== ZeroAddress && expectedArena !== config.binder) {
          fail("Sacrificial factory is bound to an unexpected arena");
        }
      }
      const verified = await verifyFactoryAt(
        provider,
        config.factory,
        build,
        config,
        { expectedArena },
      );
      evidence.factoryVerification = verified.evidence;
      if (config.submitExplorerVerification) {
        evidence.explorerSubmission = await submitExplorerVerification(
          config.explorerApiUrl,
          config.factory,
          build,
          config,
          { fetchImpl, timeoutMs: config.timeoutMs },
        );
      }
      evidence.explorerVerification = await inspectExplorerVerification(
        config.explorerApiUrl,
        config.factory,
        config,
        { fetchImpl },
      );
      if (config.requireExplorerVerified &&
          !evidence.explorerVerification.sourceLockMatched) {
        fail("Explorer source verification does not match the reviewed build lock");
      }
      if (config.mode === "rehearsal") {
        const resumeIntent = {
          schema: "liquidity-arena-bradbury-rehearsal-resume-v1",
          chainId: BRADBURY_CHAIN_ID.toString(),
          factory: config.factory,
          binder: config.binder,
          reserveSink: config.reserveSink,
          fromBlock: config.fromBlock,
          buildLock: build.lock,
        };
        config.requiredBroadcastConfirmation =
          requiredIntentConfirmation(resumeIntent);
        evidence.requiredBroadcastConfirmation =
          config.requiredBroadcastConfirmation;
        if (config.broadcast) {
          const provenance = await requireRehearsalProvenance(
            provider,
            build,
            config,
            config.rehearsalEvidencePath,
            { requirePassed: false },
          );
          if (provenance.factoryAddress !== config.factory) {
            fail("Rehearsal recovery factory differs from its signed provenance");
          }
          const importedFingerprint = importJournalProvenance(
            config.rehearsalEvidencePath,
            config.evidencePath,
            env,
          );
          if (
            canonicalJson(importedFingerprint) !==
            canonicalJson(provenance.fingerprint)
          ) {
            fail("Rehearsal provenance changed before journal import");
          }
          evidence.rehearsalProvenance = {
            ...importedFingerprint,
            factory: provenance.factoryAddress,
            fromBlock: config.fromBlock,
          };
          assertIntentConfirmation(config, config.requiredBroadcastConfirmation);
          persistEvidence();
        }
        evidence.anchorEligible = false;
        evidence.rehearsalSnapshot = await inspectRehearsalState(
          provider,
          build,
          config,
          config.factory,
        );
        if (!config.broadcast) {
          evidence.rehearsal = {
            passed: false,
            dryRunOnly: true,
            nextAction: evidence.rehearsalSnapshot.nextAction,
            instruction:
              "Re-run with --rehearse --factory, the same --from-block, and the explicit broadcast controls to reconcile.",
          };
        } else {
          const binderSigner = await walletLoader(
            env,
            "BRADBURY_EVM",
            config.binder,
            provider,
          );
          const recipientSigner = await walletLoader(
            env,
            "BRADBURY_EVM_RECIPIENT",
            config.reserveSink,
            provider,
          );
          evidence.rehearsal = await runRehearsal(
            provider,
            build,
            config,
            binderSigner,
            recipientSigner,
            config.factory,
            checkpoint,
            config.fromBlock,
          );
          await requireFinalizedJournal(
            provider,
            config.evidencePath,
            REHEARSAL_TRANSACTION_LABELS,
            config.finalityTimeoutMs,
          );
          evidence.outcome = "sacrificial-rehearsal-passed";
        }
      }
      if (config.mode === "readback") {
        evidence.anchorEligible = false;
        evidence.anchorBlocker =
          "Readback alone cannot attest rehearsal provenance or independent V8 review.";
        evidence.outcome = "verified";
      } else if (!config.broadcast) {
        evidence.outcome = "sacrificial-rehearsal-dry-run";
      }
    } else {
      let rehearsalProof;
      if (config.mode === "production" && config.rehearsalEvidencePath) {
        rehearsalProof = await requireRehearsalProvenance(
          provider,
          build,
          config,
          config.rehearsalEvidencePath,
          { requirePassed: true },
        );
        config.rehearsalAuthorization = rehearsalProof.authorization;
        evidence.rehearsalProvenance = {
          ...rehearsalProof.fingerprint,
          factory: rehearsalProof.factoryAddress,
          outcome: rehearsalProof.evidence.outcome,
          passed: true,
          authorization: rehearsalProof.authorization,
        };
      }
      const preflight = await preflightFactoryDeployment(
        provider,
        build,
        { ...config, rehearsalAuthorization: rehearsalProof?.authorization },
      );
      const productionAuthorizationReady =
        config.mode !== "production" || Boolean(rehearsalProof);
      evidence.preflight = productionAuthorizationReady
        ? preflight.evidence
        : {
            ...preflight.evidence,
            requiredBroadcastConfirmation: null,
            productionAuthorizationReady: false,
          };
      evidence.requiredBroadcastConfirmation = productionAuthorizationReady
        ? preflight.requiredBroadcastConfirmation
        : null;
      config.requiredBroadcastConfirmation = productionAuthorizationReady
        ? preflight.requiredBroadcastConfirmation
        : undefined;

      if (!config.broadcast) {
        evidence.outcome = "dry-run-passed";
        evidence.nextAction = config.mode === "rehearsal"
          ? `No transaction sent. Re-run with --rehearse --broadcast, a new evidence path, and BRADBURY_EVM_BROADCAST_CONFIRM=${preflight.requiredBroadcastConfirmation}.`
          : rehearsalProof
            ? `No transaction sent. Re-run with the same finalized --rehearsal-evidence, --broadcast, a new protected evidence path, and BRADBURY_EVM_BROADCAST_CONFIRM=${preflight.requiredBroadcastConfirmation}.`
            : "No transaction sent. This preliminary preflight has no usable production authorization. Complete a finalized rehearsal, then re-run with --rehearsal-evidence to obtain its provenance-bound confirmation.";
        if (config.mode === "rehearsal") {
          evidence.rehearsal = {
            payoutId: REHEARSAL_PAYOUT_ID,
            amountWei: REHEARSAL_AMOUNT.toString(),
            recipient: config.reserveSink,
            dryRunOnly: true,
            productionUseForbidden: true,
          };
        }
      } else {
        assertIntentConfirmation(config, preflight.requiredBroadcastConfirmation);
        persistEvidence();
        if (config.mode === "production") {
          if (!rehearsalProof?.authorization) {
            fail("Production signing requires an exact finalized rehearsal authorization");
          }
          if (rehearsalProof.factoryAddress === preflight.predictedAddress) {
            fail("Production factory address must differ from the sacrificial rehearsal factory");
          }
          persistEvidence();
        }
        if (
          rehearsalProof &&
          canonicalJson(provenanceFingerprint(config.rehearsalEvidencePath)) !==
            canonicalJson(rehearsalProof.fingerprint)
        ) {
          fail("Rehearsal provenance changed before production signer loading");
        }
        const binderSigner = await walletLoader(
          env,
          "BRADBURY_EVM",
          config.binder,
          provider,
        );
        const recipientSigner = config.mode === "rehearsal"
          ? await walletLoader(
              env,
              "BRADBURY_EVM_RECIPIENT",
              config.reserveSink,
              provider,
            )
          : undefined;
        const deployed = await broadcastFactory(
          provider,
          binderSigner,
          build,
          config,
          preflight,
          checkpoint,
        );
        evidence.deploymentReceipt = deployed.evidence;
        evidence.factory = deployed.address;
        evidence.networkAfterDeployment = await readBradburyIdentity(provider);
        const unbound = await verifyFactoryAt(
          provider,
          deployed.address,
          build,
          config,
          { expectedArena: ZeroAddress },
        );
        evidence.factoryVerification = unbound.evidence;

        if (config.mode === "rehearsal") {
          evidence.rehearsal = await runRehearsal(
            provider,
            build,
            config,
            binderSigner,
            recipientSigner,
            deployed.address,
            checkpoint,
            deployed.receipt.blockNumber,
          );
          await requireFinalizedJournal(
            provider,
            config.evidencePath,
            REHEARSAL_TRANSACTION_LABELS,
            config.finalityTimeoutMs,
          );
          evidence.outcome = "sacrificial-rehearsal-passed";
        } else {
          evidence.explorerSubmission = await submitExplorerVerification(
            config.explorerApiUrl,
            deployed.address,
            build,
            config,
            { fetchImpl, timeoutMs: config.timeoutMs },
          );
          evidence.explorerVerification = await inspectExplorerVerification(
            config.explorerApiUrl,
            deployed.address,
            config,
            { fetchImpl },
          );
          evidence.anchorEligible = false;
          evidence.anchorBlocker = evidence.explorerVerification.sourceLockMatched
            ? "Independent post-deployment review is still required before anchoring."
            : "Exact explorer source verification and independent post-deployment review are required before anchoring.";
          evidence.outcome = "production-factory-deployed-unbound";
        }
      }
    }

    evidence.completedAt = new Date().toISOString();
    persistEvidence();
    if (config.json) {
      const serialized = evidenceJson(evidence);
      assertEvidenceContainsNoSecrets(serialized, env);
      process.stdout.write(serialized);
    }
    return evidence;
  } catch (error) {
    const safeMessage = sanitizeOperationalError(error, [
      config.rpcUrl,
      config.explorerApiUrl,
    ]);
    evidence.outcome = "failed";
    evidence.error = safeMessage;
    evidence.completedAt = new Date().toISOString();
    if (config.evidencePath) {
      persistEvidence();
    }
    throw new Error(safeMessage);
  } finally {
    let releaseError;
    try { provider?.destroy?.(); } catch (error) { releaseError ??= error; }
    try { operationLock?.release(); } catch (error) { releaseError ??= error; }
    if (releaseError) {
      throw new Error(sanitizeOperationalError(releaseError, [
        config.rpcUrl,
        config.explorerApiUrl,
      ]));
    }
  }
}

export function factoryCliSummary(result) {
  const lines = [
    `${result.outcome}: ${result.factory ?? result.preflight?.predictedAddress ?? "no factory"}`,
  ];
  if (result.requiredBroadcastConfirmation) {
    lines.push(`requiredBroadcastConfirmation=${result.requiredBroadcastConfirmation}`);
  }
  if (result.nextAction) lines.push(`nextAction=${result.nextAction}`);
  return `${lines.join("\n")}\n`;
}

export function usage() {
  return `Bradbury EVM payout-factory deployment and readback\n\nUsage:\n  npm run --silent deploy:bradbury -- --binder <EOA> --reserve-sink <EOA> [options]\n\nDefault behavior is a credential-free, read-only production deployment preflight. A preliminary run prints its exact next action; once every production prerequisite is present, the dry-run also prints the single-use confirmation bound to its exact nonce, predicted address, bytecode, gas, and fee intent.\n\nOptions:\n  --rpc-url <url>                 Direct Bradbury RPC (default: ${BRADBURY_RPC_URL})\n  --explorer-api-url <url>        Block explorer API\n  --allow-custom-endpoints        Explicitly allow custom endpoints for writes\n  --binder <address>              Immutable one-time binder/deployer EOA\n  --reserve-sink <address>        Distinct immutable excess reserve/recipient EOA\n  --factory <address>             Verify an existing factory or resume a proven rehearsal\n  --tx-hash <hash>                Reconcile an exact deployment or post-CREATE rehearsal hash\n  --rebroadcast-signed            Replay only the journaled raw bytes for --tx-hash\n  --rehearse                      Use/recover the sacrificial 1-wei sequence; required with a rehearsal --tx-hash\n  --rehearsal-evidence <path>     Finalized rehearsal proof, or prior session when resuming\n  --from-block <number>           Exact sacrificial deployment block for rehearsal resume\n  --broadcast                     Permit the single-use signed intent\n  --submit-explorer-verification  Submit locked standard JSON for an existing production factory\n  --require-explorer-verified     Fail readback unless exact explorer sources match the lock\n  --confirmations <1-20>          Inclusion confirmations (default: ${DEFAULT_CONFIRMATIONS})\n  --timeout-ms <milliseconds>     Inclusion/API timeout (default: ${DEFAULT_TIMEOUT_MS})\n  --finality-timeout-ms <ms>      Bradbury finality timeout (default: ${DEFAULT_FINALITY_TIMEOUT_MS})\n  --evidence <path>               New atomic summary + append-only journal (required for broadcast)\n  --overwrite-evidence            Replace only a journal-free dry-run summary\n  --json                           Emit secret-free JSON to stdout; use npm --silent\n  --help                           Show this text\n\nEncrypted signer environment (new signed intents only):\n  BRADBURY_EVM_KEYSTORE_JSON or BRADBURY_EVM_KEYSTORE_B64\n  BRADBURY_EVM_KEYSTORE_PASSWORD\n\nRehearsal additionally requires the reserve recipient signer:\n  BRADBURY_EVM_RECIPIENT_KEYSTORE_JSON or BRADBURY_EVM_RECIPIENT_KEYSTORE_B64\n  BRADBURY_EVM_RECIPIENT_KEYSTORE_PASSWORD\n\nBroadcast requires the exact BRADBURY_EVM_BROADCAST_CONFIRM printed by the matching dry-run and a new --evidence path. Production also requires --rehearsal-evidence from a finalized passed sacrificial run. Rehearsal resume requires its prior proof but writes a new evidence session.\n\nA signed journal is never overwritten. If any rehearsal or deployment submission is ambiguous, reconcile its exact hash against the original evidence (add --rehearse for a post-CREATE rehearsal hash); use --rebroadcast-signed only to replay the identical raw bytes. Production remains unbound and never becomes anchor-eligible until separate V8 review and CI attest it.`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runBradburyFactoryTool(args);
  if (!args.includes("--json")) {
    process.stdout.write(factoryCliSummary(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Bradbury factory tool failed: ${String(error.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
