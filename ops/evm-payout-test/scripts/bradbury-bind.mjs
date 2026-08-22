import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Transaction,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  keccak256,
} from "ethers";

import {
  BRADBURY_CHAIN_ID,
  BRADBURY_RPC_URL,
  MAX_FEE_PER_GAS,
  MAX_SEQUENCE_NATIVE_COST,
  MAX_TRANSACTION_GAS_COST,
  acquireBradburySignerLocks,
  appendDurableCheckpoint,
  assertNoAccessList,
  assertEvidenceContainsNoSecrets,
  assertExternallyOwnedRole,
  bigintFields,
  bufferedGas,
  canonicalJson,
  endpointEvidence,
  feeCeiling,
  loadEncryptedWallet,
  readBradburyIdentity,
  readCheckpointJournal,
  readEvidenceFile,
  requireProtectedOperationalPath,
  reviewedFeeIntent,
  requireFinalizedJournal,
  sendCheckedTransaction,
  sha256,
  sanitizeOperationalError,
  validateCredentialFreeUrl,
  validateJournaledFactoryDeployment,
  validateRehearsalAuthorization,
  verifyFactoryAt,
  verifyReceipt,
  writeEvidenceFile,
} from "./bradbury-factory.mjs";
import {
  PAYOUT_PROTOCOL_VERSION,
  loadLockedPayoutBuild,
} from "./payout-build-lock.mjs";
import {
  BRADBURY_CONSENSUS_ADDRESS,
  EXPECTED_V8_SCHEMA_SHA256,
  V8_PROTOCOL_VERSION,
  assertExactDeploymentReceipt,
  assertExactEvmSubmissionReceipt,
  assertExactPlannedConsensusCalldata,
  assertProtectedOperationalPath,
  createBradburyReader,
  normalizeConfig as normalizeV8Config,
  operationalEvidenceRoot,
  readAndVerifyDeployment,
  verifyLocalCandidate,
} from "../../../ops/bradbury-v8/harness.mjs";

export const V8_BIND_REQUEST_SCHEMA =
  "liquidity-arena-bradbury-bind-request-v1";
export const BIND_EVIDENCE_SCHEMA =
  "liquidity-arena-bradbury-factory-bind-evidence-v1";
export const BIND_PROOF_VERSION = 1;
export const BIND_NETWORK = "testnet-bradbury";
export const BIND_TRANSACTION_LABEL = "bind-production-factory-to-v8";
export const BIND_CONFIRMATION_PREFIX = "AUTHORIZE_BRADBURY_V8_BIND_";

const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_FINALITY_TIMEOUT_MS = 45 * 60 * 1_000;
const FACTORY_EVIDENCE_SCHEMA =
  "liquidity-arena-bradbury-factory-evidence-v2";
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const V8_BIND_REQUEST_FIELDS = new Set([
  "schema",
  "version",
  "network",
  "chainId",
  "configFingerprint",
  "sourcePath",
  "sourceSha256",
  "schemaSha256",
  "deploymentGenLayerTransactionHash",
  "deploymentEvmTransactionHash",
  "deploymentEvmReceiptBlockHash",
  "deploymentEvmReceiptBlockNumber",
  "deploymentGenLayerReceiptStatus",
  "deploymentGenLayerExecutionResult",
  "deploymentGenLayerExecutionSuccess",
  "deploymentEvmFinalityVerified",
  "deploymentEvmFinalityRequiredBeforeBind",
  "leaderOnly",
  "arenaAddress",
  "ownerAddress",
  "constructorArguments",
  "factoryAddress",
  "binderAddress",
  "reserveSinkAddress",
  "v8ProtocolVersion",
  "payoutProtocolVersion",
  "factoryRuntimeBytecodeSha256",
  "exactDeploymentReadback",
  "cutsOverApplication",
  "cutsOverDatabase",
  "verifiedAt",
]);
const V8_CONSTRUCTOR_FIELDS = new Set([
  "treasuryAddress",
  "keeperAddress",
  "epochMinStakeAtto",
  "epochMaxStakePerWalletAtto",
  "payoutFactoryAddress",
]);
const BIND_PROOF_FIELDS = new Set([
  "version",
  "network",
  "chainId",
  "factoryAddress",
  "arenaAddress",
  "binderAddress",
  "reserveSinkAddress",
  "protocolVersion",
  "factoryRuntimeBytecodeSha256",
  "bindTransactionHash",
  "bindReceiptStatus",
  "bindExecutionSuccess",
  "boundArenaReadback",
  "verifiedAt",
]);

function fail(message) {
  throw new Error(message);
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

function requiredPath(label, value) {
  if (!value || typeof value !== "string") fail(`${label} is required`);
  return path.resolve(value);
}

function exactAddress(label, value) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    fail(`${label} must be a valid EVM address`);
  }
  if (address === ZeroAddress) fail(`${label} must not be the zero address`);
  return address;
}

function exactHash(label, value) {
  if (!HASH_PATTERN.test(String(value ?? ""))) {
    fail(`${label} must be a 32-byte transaction hash`);
  }
  return String(value).toLowerCase();
}

function exactSha256(label, value) {
  if (!SHA256_PATTERN.test(String(value ?? ""))) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return String(value);
}

function exactUtcTimestamp(label, value) {
  if (
    !ISO_UTC_PATTERN.test(String(value ?? "")) ||
    Number.isNaN(Date.parse(value)) ||
    Date.parse(value) > Date.now() + 5 * 60_000
  ) {
    fail(`${label} must be a valid UTC timestamp that is not in the future`);
  }
  return String(value);
}

function requireExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} fields do not match the reviewed schema`);
  }
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(path.resolve(filePath)));
}

export function captureJsonDocument(filePath, label = "JSON document") {
  const absolutePath = path.resolve(filePath);
  let bytes;
  let digest;
  let value;
  try {
    bytes = fs.readFileSync(absolutePath);
    digest = sha256(bytes);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} ${absolutePath} is missing or invalid JSON`);
  }
  return Object.freeze({
    absolutePath,
    sha256: digest,
    value,
  });
}

function journalFingerprint(evidencePath) {
  const journal = readCheckpointJournal(evidencePath);
  return {
    evidenceSha256: fileSha256(evidencePath),
    journalHeadHash: journal.at(-1)?.entryHash ?? null,
    journalEntries: journal.length,
  };
}

function rawJournalEntries(evidencePath) {
  return readCheckpointJournal(evidencePath).map((record) => record.entry);
}

export function acquireBindLock(
  factoryAddress,
  requestSha256,
  { fileSystem = fs } = {},
) {
  const normalizedFactory = exactAddress("factory lock address", factoryAddress)
    .toLowerCase();
  const evidenceRoot = operationalEvidenceRoot();
  const lockDirectory = path.resolve(evidenceRoot, "locks");
  assertProtectedOperationalPath(lockDirectory, evidenceRoot, {
    field: "factory bind lock directory",
  });
  fileSystem.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  assertProtectedOperationalPath(lockDirectory, evidenceRoot, {
    field: "factory bind lock directory",
  });
  const lockPath = path.resolve(
    lockDirectory,
    `factory-${BRADBURY_CHAIN_ID}-${normalizedFactory.slice(2)}.lock`,
  );
  assertProtectedOperationalPath(lockPath, evidenceRoot, {
    field: "factory bind lock path",
  });
  const token = crypto.randomUUID();
  let descriptor;
  let created = false;
  try {
    assertProtectedOperationalPath(lockPath, evidenceRoot, {
      field: "factory bind lock path",
    });
    descriptor = fileSystem.openSync(lockPath, "wx", 0o600);
    created = true;
    assertProtectedOperationalPath(lockPath, evidenceRoot, {
      field: "factory bind lock path",
    });
    fileSystem.writeFileSync(
      descriptor,
      `${JSON.stringify({
        version: 1,
        chainId: Number(BRADBURY_CHAIN_ID),
        factoryAddress: normalizedFactory,
        token,
        pid: process.pid,
        requestSha256: exactSha256("V8 bind request SHA-256", requestSha256),
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8" },
    );
    fileSystem.fsyncSync(descriptor);
  } catch {
    try { if (descriptor !== undefined) fileSystem.closeSync(descriptor); } catch {}
    if (created) {
      try { fileSystem.unlinkSync(lockPath); } catch {}
    }
    fail(
      `Exclusive canonical factory bind lock already exists or cannot be created: ${lockPath}. Verify the recorded PID is inactive and reconcile any signed hash before manual removal.`,
    );
  }
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      let recorded;
      try {
        recorded = JSON.parse(fileSystem.readFileSync(lockPath, "utf8"));
      } catch {
        fail("Factory bind lock disappeared or became unreadable while owned");
      }
      if (
        recorded?.version !== 1 ||
        recorded?.chainId !== Number(BRADBURY_CHAIN_ID) ||
        recorded?.factoryAddress !== normalizedFactory ||
        recorded?.token !== token
      ) {
        fail("Factory bind lock ownership changed while held");
      }
      try {
        fileSystem.closeSync(descriptor);
        fileSystem.unlinkSync(lockPath);
      } catch {
        fail("Factory bind lock could not be released safely");
      }
      released = true;
    },
  };
}

function canonicalPathIdentity(filePath) {
  let current = path.resolve(filePath);
  const missingSegments = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  const canonicalBase = fs.existsSync(current) ? fs.realpathSync(current) : current;
  const canonicalPath = path.resolve(canonicalBase, ...missingSegments).toLowerCase();
  if (missingSegments.length > 0 || !fs.existsSync(canonicalBase)) {
    return `path:${canonicalPath}`;
  }
  const metadata = fs.statSync(canonicalBase);
  return metadata.nlink > 1
    ? `linked-file:${metadata.dev}:${metadata.ino}`
    : `path:${canonicalPath}`;
}

function prepareProtectedOutputParent(filePath, label) {
  const resolved = requireProtectedOperationalPath(filePath, label);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  requireProtectedOperationalPath(resolved, label);
  try {
    const descriptor = fs.openSync(parent, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(error?.code)
    ) {
      throw error;
    }
  }
  return resolved;
}

export function parseBindArguments(argv) {
  const parsed = {
    broadcast: false,
    rebroadcastSigned: false,
    allowCustomEndpoints: false,
    json: false,
    help: false,
  };
  const valueOptions = new Map([
    ["--rpc-url", "rpcUrl"],
    ["--factory-evidence", "factoryEvidencePath"],
    ["--v8-bind-request", "v8BindRequestPath"],
    ["--v8-config", "v8ConfigPath"],
    ["--evidence", "evidencePath"],
    ["--bind-proof", "bindProofPath"],
    ["--tx-hash", "txHash"],
    ["--confirmations", "confirmations"],
    ["--timeout-ms", "timeoutMs"],
    ["--finality-timeout-ms", "finalityTimeoutMs"],
  ]);
  const flagOptions = new Map([
    ["--broadcast", "broadcast"],
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
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${option} requires a value`);
      parsed[valueOptions.get(option)] = value;
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

export function resolveBindConfiguration(args, env = process.env) {
  const factoryEvidencePath = requiredPath(
    "--factory-evidence",
    args.factoryEvidencePath,
  );
  const v8BindRequestPath = requiredPath(
    "--v8-bind-request",
    args.v8BindRequestPath,
  );
  const v8ConfigPath = requiredPath("--v8-config", args.v8ConfigPath);
  const evidencePath = args.evidencePath
    ? path.resolve(args.evidencePath)
    : undefined;
  const bindProofPath = args.bindProofPath
    ? path.resolve(args.bindProofPath)
    : undefined;
  const txHash = args.txHash === undefined
    ? undefined
    : exactHash("--tx-hash", args.txHash);
  if ((args.broadcast || txHash) && !evidencePath) {
    fail("Broadcast and recovery require --evidence");
  }
  if ((args.broadcast || txHash) && !bindProofPath) {
    fail("Broadcast and recovery require --bind-proof");
  }
  if (args.rebroadcastSigned && (!args.broadcast || !txHash)) {
    fail("--rebroadcast-signed requires --broadcast and --tx-hash");
  }
  if (args.broadcast && txHash && !args.rebroadcastSigned) {
    fail("A recovery broadcast requires --rebroadcast-signed");
  }
  if (args.broadcast && !txHash && !env.BRADBURY_EVM_BIND_CONFIRM) {
    fail("A fresh bind broadcast requires BRADBURY_EVM_BIND_CONFIRM from its dry-run");
  }
  if (env.BRADBURY_EVM_PRIVATE_KEY || env.BRADBURY_EVM_RECIPIENT_PRIVATE_KEY) {
    fail("Raw private-key environment variables are forbidden; use an encrypted keystore");
  }
  const rpcUrl = validateCredentialFreeUrl(
    args.rpcUrl ?? env.BRADBURY_EVM_RPC_URL ?? BRADBURY_RPC_URL,
    "Bradbury RPC URL",
  );
  if (
    rpcUrl !== BRADBURY_RPC_URL &&
    args.broadcast &&
    !args.allowCustomEndpoints
  ) {
    fail("A bind write requires the canonical Bradbury RPC unless --allow-custom-endpoints is explicit");
  }
  const confirmations = parseInteger(
    "confirmations",
    args.confirmations ?? DEFAULT_CONFIRMATIONS,
    1,
    20,
  );
  const timeoutMs = parseInteger(
    "timeout-ms",
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    60_000,
    30 * 60 * 1_000,
  );
  const finalityTimeoutMs = parseInteger(
    "finality-timeout-ms",
    args.finalityTimeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS,
    5 * 60_000,
    2 * 60 * 60 * 1_000,
  );
  const distinctPaths = [
    factoryEvidencePath,
    `${factoryEvidencePath}.checkpoints.jsonl`,
    v8BindRequestPath,
    v8ConfigPath,
    evidencePath,
    evidencePath ? `${evidencePath}.checkpoints.jsonl` : undefined,
    bindProofPath,
  ].filter(Boolean);
  if (new Set(distinctPaths.map(canonicalPathIdentity)).size !== distinctPaths.length) {
    fail("Factory evidence, journals, V8 request/config, bind evidence, and bind proof paths must be distinct");
  }
  return {
    broadcast: args.broadcast,
    rebroadcastSigned: args.rebroadcastSigned,
    factoryEvidencePath,
    v8BindRequestPath,
    v8ConfigPath,
    evidencePath,
    bindProofPath,
    txHash,
    rpcUrl,
    confirmations,
    timeoutMs,
    finalityTimeoutMs,
    json: args.json,
    broadcastConfirmation: env.BRADBURY_EVM_BIND_CONFIRM,
  };
}

export function loadV8BindRequest(
  filePath,
  { capturedDocument = captureJsonDocument(filePath, "V8 bind request") } = {},
) {
  if (capturedDocument.absolutePath !== path.resolve(filePath)) {
    fail("Captured V8 bind request path does not match its requested path");
  }
  const request = capturedDocument.value;
  requireExactFields(request, V8_BIND_REQUEST_FIELDS, "V8 bind request");
  requireExactFields(
    request.constructorArguments,
    V8_CONSTRUCTOR_FIELDS,
    "V8 bind request constructorArguments",
  );
  const exactDecimal = (label, value) => {
    if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ""))) {
      fail(`${label} must be a canonical decimal integer`);
    }
    return String(value);
  };
  const exactArtifactAddress = (label, value) => {
    const raw = String(value ?? "");
    if (raw !== raw.toLowerCase()) {
      fail(`${label} must use the canonical lowercase artifact encoding`);
    }
    return exactAddress(label, raw);
  };
  const evmBlockNumber = String(
    request.deploymentEvmReceiptBlockNumber ?? "",
  ).toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(evmBlockNumber)) {
    fail("V8 deployment EVM receipt block number is not a canonical quantity");
  }
  const normalized = {
    schema: request.schema,
    version: request.version,
    network: request.network,
    chainId: request.chainId,
    configFingerprint: exactSha256(
      "V8 bind request configFingerprint",
      request.configFingerprint,
    ),
    sourcePath: String(request.sourcePath ?? ""),
    sourceSha256: exactSha256(
      "V8 bind request sourceSha256",
      request.sourceSha256,
    ),
    schemaSha256: exactSha256(
      "V8 bind request schemaSha256",
      request.schemaSha256,
    ),
    deploymentGenLayerTransactionHash: exactHash(
      "V8 deployment GenLayer transaction hash",
      request.deploymentGenLayerTransactionHash,
    ),
    deploymentEvmTransactionHash: exactHash(
      "V8 deployment outer EVM transaction hash",
      request.deploymentEvmTransactionHash,
    ),
    deploymentEvmReceiptBlockHash: exactHash(
      "V8 deployment outer EVM receipt block hash",
      request.deploymentEvmReceiptBlockHash,
    ),
    deploymentEvmReceiptBlockNumber: evmBlockNumber,
    deploymentGenLayerReceiptStatus: request.deploymentGenLayerReceiptStatus,
    deploymentGenLayerExecutionResult: request.deploymentGenLayerExecutionResult,
    deploymentGenLayerExecutionSuccess:
      request.deploymentGenLayerExecutionSuccess,
    deploymentEvmFinalityVerified: request.deploymentEvmFinalityVerified,
    deploymentEvmFinalityRequiredBeforeBind:
      request.deploymentEvmFinalityRequiredBeforeBind,
    leaderOnly: request.leaderOnly,
    arenaAddress: exactArtifactAddress("V8 arena address", request.arenaAddress),
    ownerAddress: exactArtifactAddress("V8 owner address", request.ownerAddress),
    constructorArguments: {
      treasuryAddress: exactArtifactAddress(
        "V8 constructor treasury",
        request.constructorArguments.treasuryAddress,
      ),
      keeperAddress: exactArtifactAddress(
        "V8 constructor keeper",
        request.constructorArguments.keeperAddress,
      ),
      epochMinStakeAtto: exactDecimal(
        "V8 constructor minimum stake",
        request.constructorArguments.epochMinStakeAtto,
      ),
      epochMaxStakePerWalletAtto: exactDecimal(
        "V8 constructor wallet cap",
        request.constructorArguments.epochMaxStakePerWalletAtto,
      ),
      payoutFactoryAddress: exactArtifactAddress(
        "V8 constructor payout factory",
        request.constructorArguments.payoutFactoryAddress,
      ),
    },
    factoryAddress: exactArtifactAddress("V8 factory address", request.factoryAddress),
    binderAddress: exactArtifactAddress("V8 factory binder", request.binderAddress),
    reserveSinkAddress: exactArtifactAddress(
      "V8 reserve sink",
      request.reserveSinkAddress,
    ),
    v8ProtocolVersion: request.v8ProtocolVersion,
    payoutProtocolVersion: request.payoutProtocolVersion,
    factoryRuntimeBytecodeSha256: exactSha256(
      "V8 factory runtime SHA-256",
      request.factoryRuntimeBytecodeSha256,
    ),
    exactDeploymentReadback: request.exactDeploymentReadback,
    cutsOverApplication: request.cutsOverApplication,
    cutsOverDatabase: request.cutsOverDatabase,
    verifiedAt: exactUtcTimestamp("V8 deployment verifiedAt", request.verifiedAt),
  };
  if (
    normalized.schema !== V8_BIND_REQUEST_SCHEMA ||
    normalized.version !== 1 ||
    normalized.network !== BIND_NETWORK ||
    normalized.chainId !== Number(BRADBURY_CHAIN_ID) ||
    !normalized.sourcePath ||
    normalized.schemaSha256 !== EXPECTED_V8_SCHEMA_SHA256 ||
    normalized.deploymentGenLayerReceiptStatus !== "FINALIZED" ||
    normalized.deploymentGenLayerExecutionResult !== "FINISHED_WITH_RETURN" ||
    normalized.deploymentGenLayerExecutionSuccess !== true ||
    normalized.deploymentEvmFinalityVerified !== false ||
    normalized.deploymentEvmFinalityRequiredBeforeBind !== true ||
    normalized.leaderOnly !== false ||
    normalized.v8ProtocolVersion !== V8_PROTOCOL_VERSION ||
    normalized.payoutProtocolVersion !== PAYOUT_PROTOCOL_VERSION ||
    normalized.exactDeploymentReadback !== true ||
    normalized.cutsOverApplication !== false ||
    normalized.cutsOverDatabase !== false
  ) {
    fail("V8 bind request is not an exact finalized Bradbury V8 deployment proof");
  }
  const arena = normalized.arenaAddress.toLowerCase();
  const owner = normalized.ownerAddress.toLowerCase();
  const factory = normalized.factoryAddress.toLowerCase();
  const binder = normalized.binderAddress.toLowerCase();
  const reserve = normalized.reserveSinkAddress.toLowerCase();
  if (owner !== binder) {
    fail("This reviewed release requires the V8 owner and one-time factory binder to be the same EOA");
  }
  if (
    arena === owner || arena === factory || arena === binder || arena === reserve ||
    factory === owner || factory === binder || factory === reserve ||
    reserve === owner || reserve === binder
  ) {
    fail("V8, factory, and reserve roles must be distinct; only owner and binder may coincide");
  }
  return Object.freeze(normalized);
}

function exactEvmQuantity(label, value) {
  const quantity = String(value ?? "").toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(quantity)) {
    fail(`${label} must be a canonical EVM quantity`);
  }
  return quantity;
}

export async function validateFinalizedV8Deployment(
  provider,
  request,
  v8ConfigPath,
  {
    v8ReaderFactory = () => createBradburyReader(),
    projectRoot,
    capturedConfigDocument = captureJsonDocument(
      v8ConfigPath,
      "V8 deployment config",
    ),
  } = {},
) {
  if (capturedConfigDocument.absolutePath !== path.resolve(v8ConfigPath)) {
    fail("Captured V8 deployment config path does not match its requested path");
  }
  const config = normalizeV8Config(capturedConfigDocument.value);
  const local = verifyLocalCandidate(config, projectRoot ? { projectRoot } : {});
  const constructor = request.constructorArguments;
  if (
    config.fingerprint !== request.configFingerprint ||
    config.sourcePath !== request.sourcePath ||
    local.sourceHash !== request.sourceSha256 ||
    config.schemaSha256 !== request.schemaSha256 ||
    getAddress(config.expected.ownerAddress) !== request.ownerAddress ||
    getAddress(config.expected.treasuryAddress) !== constructor.treasuryAddress ||
    getAddress(config.expected.keeperAddress) !== constructor.keeperAddress ||
    config.expected.epochMinStakeAtto !== constructor.epochMinStakeAtto ||
    config.expected.epochMaxStakePerWalletAtto !==
      constructor.epochMaxStakePerWalletAtto ||
    getAddress(config.expected.payoutFactoryAddress) !==
      constructor.payoutFactoryAddress ||
    getAddress(config.expected.payoutFactoryAddress) !== request.factoryAddress ||
    getAddress(config.expected.factoryBinderAddress) !== request.binderAddress ||
    getAddress(config.expected.reserveSinkAddress) !== request.reserveSinkAddress ||
    config.expected.protocolVersion !== request.v8ProtocolVersion ||
    config.expected.payoutProtocolVersion !== request.payoutProtocolVersion ||
    config.expected.factoryRuntimeBytecodeSha256 !==
      request.factoryRuntimeBytecodeSha256
  ) {
    fail("V8 bind request does not match its exact reviewed config, source, and constructor");
  }

  const reader = v8ReaderFactory();
  const finalizedReceipt = await reader.waitFinalized(
    request.deploymentGenLayerTransactionHash,
    {
      ...config.operator,
      finalityRetries: 1,
      finalityIntervalMs: 0,
    },
  );
  const arenaAddress = assertExactDeploymentReceipt(finalizedReceipt, {
    hash: request.deploymentGenLayerTransactionHash,
    source: local.source,
    config,
  });
  if (getAddress(arenaAddress) !== request.arenaAddress) {
    fail("Live finalized GenLayer deployment address differs from the bind request");
  }
  const liveTransaction = await reader.transaction(
    request.deploymentGenLayerTransactionHash,
  );
  if (!liveTransaction || typeof liveTransaction !== "object") {
    fail("Finalized V8 GenLayer transaction could not be independently fetched");
  }
  await readAndVerifyDeployment(
    reader,
    request.arenaAddress,
    local,
    config,
    {
      payoutsEnabled: false,
      newRiskEnabled: false,
      availableReserveAtto: "0",
    },
  );

  const [rawReceipt, rawTransaction, finalizedBlock] = await Promise.all([
    provider.send("eth_getTransactionReceipt", [
      request.deploymentEvmTransactionHash,
    ]),
    provider.send("eth_getTransactionByHash", [
      request.deploymentEvmTransactionHash,
    ]),
    provider.send("eth_getBlockByNumber", ["finalized", false]),
  ]);
  if (!rawReceipt || !rawTransaction || !finalizedBlock) {
    fail("V8 deployment outer EVM transaction, receipt, or finalized block is missing");
  }
  const submission = assertExactEvmSubmissionReceipt(rawReceipt, {
    evmTransactionHash: request.deploymentEvmTransactionHash,
  });
  if (
    submission.genlayerTransactionHash !==
      request.deploymentGenLayerTransactionHash ||
    submission.blockHash !== request.deploymentEvmReceiptBlockHash ||
    submission.blockNumber !== request.deploymentEvmReceiptBlockNumber ||
    String(rawReceipt.status).toLowerCase() !== "0x1"
  ) {
    fail("Live V8 deployment EVM receipt differs from the sanitized bind request");
  }
  const finalizedNumber = BigInt(
    exactEvmQuantity("Bradbury finalized block number", finalizedBlock.number),
  );
  const receiptNumber = BigInt(request.deploymentEvmReceiptBlockNumber);
  if (finalizedNumber < receiptNumber) {
    fail("V8 deployment outer EVM receipt has not reached Bradbury EVM finality");
  }
  const canonicalBlock = await provider.send("eth_getBlockByNumber", [
    request.deploymentEvmReceiptBlockNumber,
    false,
  ]);
  if (
    !canonicalBlock ||
    String(canonicalBlock.hash).toLowerCase() !==
      request.deploymentEvmReceiptBlockHash ||
    exactEvmQuantity(
      "V8 deployment canonical block number",
      canonicalBlock.number,
    ) !== request.deploymentEvmReceiptBlockNumber
  ) {
    fail("V8 deployment outer EVM receipt block is not canonical at finality");
  }
  const transactionData = String(
    rawTransaction.input ?? rawTransaction.data ?? "",
  ).toLowerCase();
  if (
    String(rawTransaction.hash).toLowerCase() !==
      request.deploymentEvmTransactionHash ||
    getAddress(rawTransaction.from) !== request.ownerAddress ||
    getAddress(rawTransaction.to) !== getAddress(BRADBURY_CONSENSUS_ADDRESS) ||
    String(rawTransaction.blockHash).toLowerCase() !==
      request.deploymentEvmReceiptBlockHash ||
    exactEvmQuantity(
      "V8 deployment EVM transaction block number",
      rawTransaction.blockNumber,
    ) !== request.deploymentEvmReceiptBlockNumber ||
    BigInt(exactEvmQuantity("V8 deployment EVM chain ID", rawTransaction.chainId)) !==
      BRADBURY_CHAIN_ID ||
    BigInt(exactEvmQuantity("V8 deployment EVM value", rawTransaction.value)) !== 0n
  ) {
    fail("V8 deployment outer EVM transaction envelope is not exact");
  }
  assertExactPlannedConsensusCalldata(transactionData, {
    action: "deploy",
    config,
    state: null,
    local,
    requireUnexpired: false,
  });
  if (
    fileSha256(v8ConfigPath) !== capturedConfigDocument.sha256 ||
    fileSha256(local.sourcePath) !== local.sourceHash
  ) {
    fail("V8 config or source changed while exact deployment was being validated");
  }
  return {
    config,
    configFileSha256: capturedConfigDocument.sha256,
    sourcePath: local.sourcePath,
    sourceSha256: local.sourceHash,
    genlayerTransactionHash: request.deploymentGenLayerTransactionHash,
    evmTransactionHash: request.deploymentEvmTransactionHash,
    evmReceiptBlockHash: request.deploymentEvmReceiptBlockHash,
    evmReceiptBlockNumber: request.deploymentEvmReceiptBlockNumber,
    evmFinalizedBlockNumber: exactEvmQuantity(
      "Bradbury finalized block number",
      finalizedBlock.number,
    ),
    exactLiveReadback: true,
  };
}

function factoryRuntimeSha256(code) {
  return sha256(Buffer.from(code.slice(2), "hex"));
}

export async function validateUnboundFactoryEvidence(
  provider,
  build,
  evidencePath,
  request,
  finalityTimeoutMs = DEFAULT_FINALITY_TIMEOUT_MS,
  {
    allowBoundArena = false,
    anchorBlockNumber,
    anchorBlockHash,
  } = {},
) {
  const fingerprintBefore = journalFingerprint(evidencePath);
  const evidence = readEvidenceFile(evidencePath);
  if (
    evidence.schema !== FACTORY_EVIDENCE_SCHEMA ||
    evidence.mode !== "production" ||
    evidence.expectedChainId !== BRADBURY_CHAIN_ID.toString() ||
    !["production-factory-deployed-unbound", "deployment-transaction-reconciled"].includes(
      evidence.outcome,
    ) ||
    evidence.rehearsalProvenance?.passed !== true ||
    canonicalJson(evidence.buildLock) !== canonicalJson(build.lock)
  ) {
    fail("Factory evidence is not a finalized reviewed production deployment");
  }
  const factoryAddress = exactAddress("factory evidence address", evidence.factory);
  const binder = exactAddress("factory evidence binder", evidence.roles?.binder);
  const reserveSink = exactAddress(
    "factory evidence reserve sink",
    evidence.roles?.reserveSink,
  );
  if (
    factoryAddress !== request.factoryAddress ||
    binder !== request.binderAddress ||
    reserveSink !== request.reserveSinkAddress
  ) {
    fail("Factory evidence roles do not match the finalized V8 bind request");
  }
  const receiptEvidence =
    evidence.deploymentReceipt ?? evidence.transactionReconciliation;
  if (
    !receiptEvidence ||
    receiptEvidence.receiptBlockFinalized !== true ||
    Number(receiptEvidence.status) !== 1
  ) {
    fail("Factory evidence does not contain a finalized successful deployment receipt");
  }
  const rehearsalAuthorization = validateRehearsalAuthorization(
    evidence.rehearsalProvenance?.authorization,
  );
  if (
    rehearsalAuthorization.evidenceSha256 !==
      evidence.rehearsalProvenance?.evidenceSha256 ||
    rehearsalAuthorization.journalHeadHash !==
      evidence.rehearsalProvenance?.journalHeadHash ||
    rehearsalAuthorization.journalEntries !==
      evidence.rehearsalProvenance?.journalEntries ||
    rehearsalAuthorization.factoryAddress !==
      evidence.rehearsalProvenance?.factory ||
    evidence.rehearsalProvenance?.outcome !== "sacrificial-rehearsal-passed" ||
    evidence.rehearsalProvenance?.passed !== true
  ) {
    fail("Factory evidence rehearsal authorization is internally inconsistent");
  }
  const entries = await requireFinalizedJournal(
    provider,
    evidencePath,
    ["deploy-production-factory"],
    finalityTimeoutMs,
  );
  const signed = entries.find(
    (entry) =>
      entry.status === "signed" &&
      entry.label === "deploy-production-factory",
  );
  const transaction = Transaction.from(signed.rawTransaction);
  assertNoAccessList(transaction, "Production factory deployment journal");
  const factory = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
  );
  const expectedDeployment = await factory.getDeployTransaction(
    binder,
    reserveSink,
  );
  if (
    getAddress(transaction.from) !== binder ||
    transaction.to !== null ||
    transaction.value !== 0n ||
    transaction.chainId !== BRADBURY_CHAIN_ID ||
    keccak256(transaction.data) !== keccak256(expectedDeployment.data) ||
    getCreateAddress({ from: transaction.from, nonce: transaction.nonce }) !==
      factoryAddress
  ) {
    fail("Factory deployment journal is not the exact reviewed production CREATE intent");
  }
  await validateJournaledFactoryDeployment(
    build,
    {
      binder,
      reserveSink,
      txHash: signed.transactionHash,
      expectedMode: "production",
      rehearsalAuthorization,
    },
    signed,
  );
  await assertExternallyOwnedRole(provider, "factory binder", binder);
  const finalizedBlock = await provider.getBlock("finalized");
  if (!finalizedBlock?.hash) {
    fail("Bradbury finalized block is unavailable for factory validation");
  }
  let verificationBlock = finalizedBlock;
  if (anchorBlockNumber !== undefined || anchorBlockHash !== undefined) {
    if (!Number.isSafeInteger(anchorBlockNumber) || anchorBlockNumber < 0 ||
        !HASH_PATTERN.test(String(anchorBlockHash ?? "")) ||
        finalizedBlock.number < anchorBlockNumber) {
      fail("Recorded factory validation anchor is not finalized and well-formed");
    }
    const canonicalAnchor = await provider.getBlock(anchorBlockNumber);
    if (!canonicalAnchor?.hash ||
        canonicalAnchor.hash.toLowerCase() !== anchorBlockHash.toLowerCase()) {
      fail("Recorded factory validation anchor is no longer canonical");
    }
    verificationBlock = canonicalAnchor;
  }
  const factoryInterface = new Interface(build.factoryArtifact.abi);
  const arenaAt = async (blockNumber) => {
    const arenaResult = await provider.call(
      {
        to: factoryAddress,
        data: factoryInterface.encodeFunctionData("arena"),
        blockTag: blockNumber,
      },
    );
    const [recordedArena] = factoryInterface.decodeFunctionResult(
      "arena",
      arenaResult,
    );
    return getAddress(recordedArena);
  };
  const finalizedArena = await arenaAt(verificationBlock.number);
  if (anchorBlockNumber !== undefined && finalizedArena !== ZeroAddress) {
    fail("Recorded factory validation anchor was not unbound");
  }
  const currentFinalizedArena = verificationBlock.number === finalizedBlock.number
    ? finalizedArena
    : await arenaAt(finalizedBlock.number);
  if (
    currentFinalizedArena !== ZeroAddress &&
    (!allowBoundArena || currentFinalizedArena !== request.arenaAddress)
  ) {
    fail("Production factory is not unbound (or bound only to the proven V8) at finality");
  }
  const verified = await verifyFactoryAt(
    provider,
    factoryAddress,
    build,
    { binder, reserveSink },
    { expectedArena: finalizedArena, blockTag: verificationBlock.number },
  );
  if (currentFinalizedArena !== finalizedArena) {
    await verifyFactoryAt(
      provider,
      factoryAddress,
      build,
      { binder, reserveSink },
      { expectedArena: currentFinalizedArena, blockTag: finalizedBlock.number },
    );
  }
  const liveCode = await provider.getCode(factoryAddress, verificationBlock.number);
  const runtimeSha256 = factoryRuntimeSha256(liveCode);
  if (runtimeSha256 !== request.factoryRuntimeBytecodeSha256) {
    fail("Live factory runtime SHA-256 does not match the V8 bind request");
  }
  const fingerprintAfter = journalFingerprint(evidencePath);
  if (canonicalJson(fingerprintAfter) !== canonicalJson(fingerprintBefore)) {
    fail("Factory deployment evidence changed while it was being verified");
  }
  return {
    evidence,
    fingerprint: fingerprintAfter,
    factoryAddress,
    binder,
    reserveSink,
    runtimeSha256,
    finalizedArena,
    currentFinalizedArena,
    finalizedBlockNumber: verificationBlock.number,
    finalizedBlockHash: verificationBlock.hash,
    verification: verified.evidence,
  };
}

export async function preflightFactoryBind(
  provider,
  build,
  factoryProof,
  request,
  v8Deployment,
) {
  const factoryInterface = new Interface(build.factoryArtifact.abi);
  const data = factoryInterface.encodeFunctionData("bind_arena", [
    request.arenaAddress,
  ]);
  const [latestNonce, pendingNonce, estimate, balance, latestBlock] =
    await Promise.all([
      provider.getTransactionCount(factoryProof.binder, "latest"),
      provider.getTransactionCount(factoryProof.binder, "pending"),
      provider.estimateGas({
        from: factoryProof.binder,
        to: factoryProof.factoryAddress,
        data,
        value: 0n,
      }),
      provider.getBalance(factoryProof.binder),
      provider.getBlock("latest"),
    ]);
  if (latestNonce !== pendingNonce) {
    fail("Factory binder has an unresolved pending transaction");
  }
  const gasLimit = bufferedGas(estimate);
  if (!latestBlock?.hash || gasLimit > latestBlock.gasLimit) {
    fail("Buffered bind gas exceeds the latest Bradbury block gas limit");
  }
  const fees = await feeCeiling(provider, gasLimit);
  if (fees.maximumGasCost > MAX_SEQUENCE_NATIVE_COST) {
    fail("Bind maximum gas cost exceeds the reviewed sequence ceiling");
  }
  if (balance < fees.maximumGasCost) {
    fail("Factory binder balance is below the maximum bind cost");
  }
  const simulation = await provider.call({
    from: factoryProof.binder,
    to: factoryProof.factoryAddress,
    data,
    value: 0n,
    gasLimit,
  });
  if (simulation !== "0x") fail("bind_arena simulation returned unexpected data");
  const intent = {
    schema: "liquidity-arena-bradbury-v8-bind-intent-v1",
    chainId: BRADBURY_CHAIN_ID.toString(),
    factoryEvidence: factoryProof.fingerprint,
    factoryFinalizedBlockNumber: factoryProof.finalizedBlockNumber,
    factoryFinalizedBlockHash: factoryProof.finalizedBlockHash,
    factoryFinalizedArena: factoryProof.finalizedArena,
    v8BindRequestSha256: request.fileSha256,
    v8ConfigFingerprint: request.configFingerprint,
    v8SourceSha256: request.sourceSha256,
    v8SchemaSha256: request.schemaSha256,
    v8ConfigFileSha256: v8Deployment.configFileSha256,
    v8DeploymentGenLayerTransactionHash:
      request.deploymentGenLayerTransactionHash,
    v8DeploymentEvmTransactionHash: request.deploymentEvmTransactionHash,
    v8DeploymentEvmReceiptBlockHash:
      request.deploymentEvmReceiptBlockHash,
    v8DeploymentEvmReceiptBlockNumber:
      request.deploymentEvmReceiptBlockNumber,
    factoryAddress: factoryProof.factoryAddress,
    arenaAddress: request.arenaAddress,
    binderAddress: factoryProof.binder,
    reserveSinkAddress: factoryProof.reserveSink,
    protocolVersion: PAYOUT_PROTOCOL_VERSION,
    factoryRuntimeBytecodeSha256: factoryProof.runtimeSha256,
    nonce: pendingNonce,
    to: factoryProof.factoryAddress,
    value: "0",
    transactionDataKeccak256: keccak256(data),
    gasLimit: gasLimit.toString(),
    fees: reviewedFeeIntent(fees),
  };
  const confirmation = `${BIND_CONFIRMATION_PREFIX}${sha256(canonicalJson(intent)).toUpperCase()}`;
  return {
    data,
    nonce: pendingNonce,
    estimate,
    gasLimit,
    fees,
    balance,
    intent,
    confirmation,
    evidence: {
      binderLatestNonce: latestNonce,
      binderPendingNonce: pendingNonce,
      gasEstimate: estimate.toString(),
      gasLimit: gasLimit.toString(),
      binderBalance: balance.toString(),
      fees: bigintFields(fees),
      transactionDataKeccak256: keccak256(data),
      simulationSucceeded: true,
      requiredBindConfirmation: confirmation,
    },
  };
}

function assertExactArenaBoundEvent(receipt, factoryAddress, arenaAddress, factoryInterface) {
  const matches = [];
  for (const log of receipt.logs ?? []) {
    if (getAddress(log.address) !== factoryAddress) continue;
    try {
      const parsed = factoryInterface.parseLog(log);
      if (parsed?.name === "ArenaBound") matches.push(parsed);
    } catch {
      // Ignore unrelated factory logs, then require exactly one reviewed event.
    }
  }
  if (
    matches.length !== 1 ||
    getAddress(matches[0].args.arena) !== arenaAddress
  ) {
    fail("Bind receipt must contain exactly one exact ArenaBound(V8) event");
  }
}

export async function verifyFinalizedBind(
  provider,
  build,
  factoryProof,
  request,
  transactionHash,
  config,
) {
  const factoryInterface = new Interface(build.factoryArtifact.abi);
  const expectedData = factoryInterface.encodeFunctionData("bind_arena", [
    request.arenaAddress,
  ]);
  const verifiedReceipt = await verifyReceipt(
    provider,
    transactionHash,
    {
      from: factoryProof.binder,
      to: factoryProof.factoryAddress,
      data: expectedData,
      value: 0n,
    },
    config.confirmations,
    config.timeoutMs,
    { requireFinality: true, finalityTimeoutMs: config.finalityTimeoutMs },
  );
  assertExactArenaBoundEvent(
    verifiedReceipt.receipt,
    factoryProof.factoryAddress,
    request.arenaAddress,
    factoryInterface,
  );
  const bound = await verifyFactoryAt(
    provider,
    factoryProof.factoryAddress,
    build,
    { binder: factoryProof.binder, reserveSink: factoryProof.reserveSink },
    { expectedArena: request.arenaAddress },
  );
  const liveCode = await provider.getCode(factoryProof.factoryAddress);
  if (factoryRuntimeSha256(liveCode) !== factoryProof.runtimeSha256) {
    fail("Bound factory runtime changed after bind finality");
  }
  return { ...verifiedReceipt, factory: bound.evidence };
}

export function createBindProof(factoryProof, request, transactionHash, verifiedAt) {
  const proof = {
    version: BIND_PROOF_VERSION,
    network: BIND_NETWORK,
    chainId: Number(BRADBURY_CHAIN_ID),
    factoryAddress: factoryProof.factoryAddress.toLowerCase(),
    arenaAddress: request.arenaAddress.toLowerCase(),
    binderAddress: factoryProof.binder.toLowerCase(),
    reserveSinkAddress: factoryProof.reserveSink.toLowerCase(),
    protocolVersion: PAYOUT_PROTOCOL_VERSION,
    factoryRuntimeBytecodeSha256: factoryProof.runtimeSha256,
    bindTransactionHash: exactHash("bind transaction hash", transactionHash),
    bindReceiptStatus: "FINALIZED",
    bindExecutionSuccess: true,
    boundArenaReadback: request.arenaAddress.toLowerCase(),
    verifiedAt: exactUtcTimestamp("bind proof verifiedAt", verifiedAt),
  };
  requireExactFields(proof, BIND_PROOF_FIELDS, "bind proof");
  return proof;
}

function persistBindProof(filePath, proof) {
  if (fs.existsSync(filePath)) {
    const existing = readEvidenceFile(filePath);
    requireExactFields(existing, BIND_PROOF_FIELDS, "existing bind proof");
    exactUtcTimestamp("existing bind proof verifiedAt", existing.verifiedAt);
    const { verifiedAt: _existingVerifiedAt, ...existingCore } = existing;
    const { verifiedAt: _nextVerifiedAt, ...proofCore } = proof;
    if (canonicalJson(existingCore) !== canonicalJson(proofCore)) {
      fail("Bind proof output already exists with different evidence");
    }
    return existing;
  }
  writeEvidenceFile(filePath, proof, false, {});
  return proof;
}

function baseBindEvidence(config, factoryProof, request, v8Deployment) {
  return {
    schema: BIND_EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    outcome: "started",
    broadcastRequested: config.broadcast,
    endpoint: endpointEvidence(config.rpcUrl, BRADBURY_RPC_URL),
    expectedChainId: BRADBURY_CHAIN_ID.toString(),
    factoryAddress: factoryProof.factoryAddress,
    arenaAddress: request.arenaAddress,
    binderAddress: factoryProof.binder,
    reserveSinkAddress: factoryProof.reserveSink,
    protocolVersion: PAYOUT_PROTOCOL_VERSION,
    factoryRuntimeBytecodeSha256: factoryProof.runtimeSha256,
    factoryEvidence: factoryProof.fingerprint,
    factoryFinalizedBlockNumber: factoryProof.finalizedBlockNumber,
    factoryFinalizedBlockHash: factoryProof.finalizedBlockHash,
    factoryFinalizedArena: factoryProof.finalizedArena,
    v8BindRequest: {
      sha256: request.fileSha256,
      configFingerprint: request.configFingerprint,
      sourceSha256: request.sourceSha256,
      schemaSha256: request.schemaSha256,
      configFileSha256: v8Deployment.configFileSha256,
      deploymentGenLayerTransactionHash:
        request.deploymentGenLayerTransactionHash,
      deploymentEvmTransactionHash: request.deploymentEvmTransactionHash,
      deploymentEvmReceiptBlockHash: request.deploymentEvmReceiptBlockHash,
      deploymentEvmReceiptBlockNumber:
        request.deploymentEvmReceiptBlockNumber,
      evmFinalizedBlockNumber: v8Deployment.evmFinalizedBlockNumber,
      exactLiveReadback: v8Deployment.exactLiveReadback,
      verifiedAt: request.verifiedAt,
    },
  };
}

function validateRecoveryIntent(
  signed,
  build,
  factoryProof,
  request,
  v8Deployment,
  config,
) {
  if (!signed?.rawTransaction || signed.label !== BIND_TRANSACTION_LABEL) {
    fail("Bind recovery journal has no exact signed bind transaction");
  }
  if (keccak256(signed.rawTransaction) !== config.txHash) {
    fail("Bind recovery raw bytes do not match --tx-hash");
  }
  const transaction = Transaction.from(signed.rawTransaction);
  assertNoAccessList(transaction, "Bind recovery transaction");
  const factoryInterface = new Interface(build.factoryArtifact.abi);
  const expectedData = factoryInterface.encodeFunctionData("bind_arena", [
    request.arenaAddress,
  ]);
  const perGas = transaction.maxFeePerGas ?? transaction.gasPrice;
  if (
    transaction.hash !== config.txHash ||
    getAddress(transaction.from) !== factoryProof.binder ||
    getAddress(transaction.to) !== factoryProof.factoryAddress ||
    transaction.chainId !== BRADBURY_CHAIN_ID ||
    transaction.value !== 0n ||
    ![0, 2].includes(transaction.type) ||
    keccak256(transaction.data) !== keccak256(expectedData) ||
    transaction.gasLimit <= 0n ||
    perGas === null ||
    perGas <= 0n ||
    perGas > MAX_FEE_PER_GAS ||
    perGas * transaction.gasLimit > MAX_TRANSACTION_GAS_COST
  ) {
    fail("Journaled bind transaction is outside the exact reviewed intent or fee caps");
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
    schema: "liquidity-arena-bradbury-v8-bind-intent-v1",
    chainId: BRADBURY_CHAIN_ID.toString(),
    factoryEvidence: factoryProof.fingerprint,
    factoryFinalizedBlockNumber: factoryProof.finalizedBlockNumber,
    factoryFinalizedBlockHash: factoryProof.finalizedBlockHash,
    factoryFinalizedArena: ZeroAddress,
    v8BindRequestSha256: request.fileSha256,
    v8ConfigFingerprint: request.configFingerprint,
    v8SourceSha256: request.sourceSha256,
    v8SchemaSha256: request.schemaSha256,
    v8ConfigFileSha256: v8Deployment.configFileSha256,
    v8DeploymentGenLayerTransactionHash:
      request.deploymentGenLayerTransactionHash,
    v8DeploymentEvmTransactionHash: request.deploymentEvmTransactionHash,
    v8DeploymentEvmReceiptBlockHash:
      request.deploymentEvmReceiptBlockHash,
    v8DeploymentEvmReceiptBlockNumber:
      request.deploymentEvmReceiptBlockNumber,
    factoryAddress: factoryProof.factoryAddress,
    arenaAddress: request.arenaAddress,
    binderAddress: factoryProof.binder,
    reserveSinkAddress: factoryProof.reserveSink,
    protocolVersion: PAYOUT_PROTOCOL_VERSION,
    factoryRuntimeBytecodeSha256: factoryProof.runtimeSha256,
    nonce: transaction.nonce,
    to: factoryProof.factoryAddress,
    value: "0",
    transactionDataKeccak256: keccak256(transaction.data),
    gasLimit: transaction.gasLimit.toString(),
    fees: exactFees,
  };
  const expectedConfirmation = `${BIND_CONFIRMATION_PREFIX}${sha256(
    canonicalJson(expectedIntent),
  ).toUpperCase()}`;
  if (
    canonicalJson(signed.reviewedIntent) !== canonicalJson(expectedIntent) ||
    signed.requiredBroadcastConfirmation !== expectedConfirmation ||
    canonicalJson(signed.exactTransaction) !== canonicalJson({
      from: factoryProof.binder,
      to: factoryProof.factoryAddress,
      nonce: transaction.nonce,
      chainId: BRADBURY_CHAIN_ID.toString(),
      value: "0",
      gasLimit: transaction.gasLimit.toString(),
      fees: exactFees,
      projectedSequenceNativeCost: exactFees.maximumGasCost,
      transactionDataKeccak256: keccak256(transaction.data),
    })
  ) {
    fail("Journaled bind transaction is not bound to the reviewed cross-chain provenance");
  }
  return { transaction, confirmation: expectedConfirmation };
}

export async function runBradburyBindTool(
  argv,
  env = process.env,
  {
    providerFactory = (url) => new JsonRpcProvider(url),
    walletLoader = loadEncryptedWallet,
    v8ReaderFactory = () => createBradburyReader(),
    v8ProjectRoot,
  } = {},
) {
  const args = parseBindArguments(argv);
  if (args.help) return { help: true };
  const config = resolveBindConfiguration(args, env);
  const build = loadLockedPayoutBuild();
  const requestDocument = captureJsonDocument(
    config.v8BindRequestPath,
    "V8 bind request",
  );
  const requestBase = loadV8BindRequest(config.v8BindRequestPath, {
    capturedDocument: requestDocument,
  });
  const request = Object.freeze({
    ...requestBase,
    fileSha256: requestDocument.sha256,
  });
  requireProtectedOperationalPath(
    config.factoryEvidencePath,
    "Factory deployment evidence",
  );
  requireProtectedOperationalPath(
    `${config.factoryEvidencePath}.checkpoints.jsonl`,
    "Factory deployment checkpoint journal",
  );
  if (config.broadcast || config.txHash) {
    prepareProtectedOutputParent(config.evidencePath, "Bind evidence");
    prepareProtectedOutputParent(
      `${config.evidencePath}.checkpoints.jsonl`,
      "Bind checkpoint journal",
    );
    prepareProtectedOutputParent(config.bindProofPath, "Bind proof");
  }
  const operationRun = Boolean(config.broadcast || config.txHash);
  let signerLock;
  let bindLock;
  if (operationRun) {
    try {
      signerLock = acquireBradburySignerLocks([request.binderAddress]);
      bindLock = acquireBindLock(request.factoryAddress, request.fileSha256);
    } catch (error) {
      try { signerLock?.release(); } catch {}
      throw error;
    }
  }
  let provider;
  let evidence;
  let evidenceWritten = false;
  const recovery = Boolean(config.txHash);

  try {
    provider = providerFactory(config.rpcUrl);
    const network = await readBradburyIdentity(provider);
    const configDocument = captureJsonDocument(
      config.v8ConfigPath,
      "V8 deployment config",
    );
    const v8Deployment = await validateFinalizedV8Deployment(
      provider,
      request,
      config.v8ConfigPath,
      {
        v8ReaderFactory,
        projectRoot: v8ProjectRoot,
        capturedConfigDocument: configDocument,
      },
    );
    if (
      fileSha256(config.v8BindRequestPath) !== request.fileSha256 ||
      fileSha256(config.v8ConfigPath) !== v8Deployment.configFileSha256 ||
      fileSha256(v8Deployment.sourcePath) !== v8Deployment.sourceSha256
    ) {
      fail("V8 bind request, config, or source changed during exact deployment validation");
    }
    const recoveryEvidence = recovery
      ? readEvidenceFile(config.evidencePath)
      : undefined;
    const factoryProof = await validateUnboundFactoryEvidence(
      provider,
      build,
      config.factoryEvidencePath,
      request,
      config.finalityTimeoutMs,
      {
        allowBoundArena: recovery,
        anchorBlockNumber: recoveryEvidence?.factoryFinalizedBlockNumber,
        anchorBlockHash: recoveryEvidence?.factoryFinalizedBlockHash,
      },
    );
    const preflight = recovery
      ? undefined
      : await preflightFactoryBind(
          provider,
          build,
          factoryProof,
          request,
          v8Deployment,
        );
    const currentFactoryFingerprint = journalFingerprint(
      config.factoryEvidencePath,
    );
    const currentRequestSha256 = fileSha256(config.v8BindRequestPath);
    const currentV8ConfigSha256 = fileSha256(config.v8ConfigPath);
    if (
      canonicalJson(currentFactoryFingerprint) !==
      canonicalJson(factoryProof.fingerprint) ||
      currentRequestSha256 !== request.fileSha256 ||
      currentV8ConfigSha256 !== v8Deployment.configFileSha256 ||
      fileSha256(v8Deployment.sourcePath) !== v8Deployment.sourceSha256
    ) {
      fail("Bind prerequisites changed during preflight");
    }

    if (recovery) {
      if (!fs.existsSync(config.evidencePath)) {
        fail("Bind recovery requires the original evidence summary");
      }
      evidence = recoveryEvidence;
      if (
        evidence.schema !== BIND_EVIDENCE_SCHEMA ||
        evidence.factoryEvidence?.evidenceSha256 !==
          factoryProof.fingerprint.evidenceSha256 ||
        evidence.factoryEvidence?.journalHeadHash !==
          factoryProof.fingerprint.journalHeadHash ||
        evidence.v8BindRequest?.sha256 !== request.fileSha256 ||
        evidence.v8BindRequest?.configFileSha256 !==
          v8Deployment.configFileSha256 ||
        evidence.factoryAddress !== factoryProof.factoryAddress ||
        evidence.arenaAddress !== request.arenaAddress
      ) {
        fail("Bind recovery evidence does not match the exact current prerequisites");
      }
      readCheckpointJournal(config.evidencePath);
      evidenceWritten = true;
    } else {
      evidence = baseBindEvidence(
        config,
        factoryProof,
        request,
        v8Deployment,
      );
      if (
        config.evidencePath &&
        (fs.existsSync(config.evidencePath) ||
          fs.existsSync(`${config.evidencePath}.checkpoints.jsonl`))
      ) {
        fail("A fresh bind requires a new exclusive evidence path");
      }
      if (config.broadcast && fs.existsSync(config.bindProofPath)) {
        fail("A fresh bind requires a new exclusive bind-proof output path");
      }
    }

    const persistEvidence = () => {
      if (!config.evidencePath) return;
      writeEvidenceFile(config.evidencePath, evidence, evidenceWritten, env);
      evidenceWritten = true;
    };
    const checkpoint = async (entry) => {
      appendDurableCheckpoint(config.evidencePath, entry, env);
      const { rawTransaction: _rawTransaction, ...publicEntry } = entry;
      evidence.transactionCheckpoints ??= [];
      evidence.transactionCheckpoints.push(publicEntry);
      evidence.pendingTransaction = publicEntry;
      evidence.outcome = "bind-transaction-awaiting-finality";
      if (entry.status === "confirmed") delete evidence.pendingTransaction;
      persistEvidence();
    };

    evidence.network = network;
    if (preflight) {
      evidence.preflight = preflight.evidence;
      evidence.requiredBindConfirmation = preflight.confirmation;
    }
    if (!config.broadcast && !recovery) {
      evidence.outcome = "bind-dry-run-passed";
      evidence.nextAction =
        `No transaction sent. Review the exact V8 request and set BRADBURY_EVM_BIND_CONFIRM=${preflight.confirmation} before a fresh --broadcast with new evidence and proof paths.`;
      persistEvidence();
      if (config.json) {
        const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
        assertEvidenceContainsNoSecrets(serialized, env);
        process.stdout.write(serialized);
      }
      return evidence;
    }

    if (!recovery) {
      if (config.broadcastConfirmation !== preflight.confirmation) {
        fail(`Bind authorization mismatch; set BRADBURY_EVM_BIND_CONFIRM=${preflight.confirmation}`);
      }
      persistEvidence();
      appendDurableCheckpoint(config.evidencePath, {
        status: "journal-opened",
        mode: "production-bind",
        chainId: BRADBURY_CHAIN_ID.toString(),
        factoryAddress: factoryProof.factoryAddress,
        arenaAddress: request.arenaAddress,
        factoryEvidence: factoryProof.fingerprint,
        v8BindRequestSha256: request.fileSha256,
      }, env);
      const binderSigner = await walletLoader(
        env,
        "BRADBURY_EVM",
        factoryProof.binder,
        provider,
      );
      if (
        (await provider.getTransactionCount(factoryProof.binder, "pending")) !==
          preflight.nonce ||
        fileSha256(config.v8BindRequestPath) !== request.fileSha256 ||
        fileSha256(config.v8ConfigPath) !== v8Deployment.configFileSha256 ||
        fileSha256(v8Deployment.sourcePath) !== v8Deployment.sourceSha256 ||
        canonicalJson(journalFingerprint(config.factoryEvidencePath)) !==
          canonicalJson(factoryProof.fingerprint)
      ) {
        fail("Bind nonce or prerequisite evidence changed before signing");
      }
      await verifyFactoryAt(
        provider,
        factoryProof.factoryAddress,
        build,
        { binder: factoryProof.binder, reserveSink: factoryProof.reserveSink },
        { expectedArena: ZeroAddress },
      );
      const submitted = await sendCheckedTransaction(
        BIND_TRANSACTION_LABEL,
        binderSigner,
        provider,
        {
          to: factoryProof.factoryAddress,
          data: preflight.data,
          value: 0n,
        },
        {
          mode: "production-bind",
          evidencePath: config.evidencePath,
          confirmations: config.confirmations,
          timeoutMs: config.timeoutMs,
          finalityTimeoutMs: config.finalityTimeoutMs,
          requiredBroadcastConfirmation: preflight.confirmation,
          broadcastConfirmation: config.broadcastConfirmation,
        },
        checkpoint,
        {
          estimate: preflight.estimate,
          gasLimit: preflight.gasLimit,
          fees: preflight.fees,
          nonce: preflight.nonce,
          intent: preflight.intent,
        },
      );
      config.txHash = submitted.transactionHash;
    } else {
      const signed = rawJournalEntries(config.evidencePath).find(
        (entry) =>
          entry.status === "signed" &&
          entry.transactionHash === config.txHash,
      );
      const recovered = validateRecoveryIntent(
        signed,
        build,
        factoryProof,
        request,
        v8Deployment,
        config,
      );
      if (config.rebroadcastSigned) {
        if (config.broadcastConfirmation !== recovered.confirmation) {
          fail(`Bind replay authorization mismatch; set BRADBURY_EVM_BIND_CONFIRM=${recovered.confirmation}`);
        }
        await checkpoint({
          label: BIND_TRANSACTION_LABEL,
          status: "broadcast-attempt",
          transactionHash: config.txHash,
          exactReplay: true,
        });
        try {
          const response = await provider.broadcastTransaction(
            signed.rawTransaction,
          );
          if (response.hash !== config.txHash) {
            fail("Exact bind replay returned a different hash");
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Exact bind replay returned")
          ) {
            throw error;
          }
          if (!(await provider.getTransaction(config.txHash))) {
            fail("Exact bind replay remains ambiguous; never sign a replacement");
          }
        }
        await checkpoint({
          label: BIND_TRANSACTION_LABEL,
          status: "submitted",
          transactionHash: config.txHash,
          exactReplay: true,
        });
      } else if (!(await provider.getTransactionReceipt(config.txHash))) {
        evidence.outcome = "bind-transaction-pending";
        if (config.json) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
        return evidence;
      }
    }

    const finalized = await verifyFinalizedBind(
      provider,
      build,
      factoryProof,
      request,
      config.txHash,
      config,
    );
    if (
      !rawJournalEntries(config.evidencePath).some(
        (entry) =>
          entry.status === "confirmed" &&
          entry.transactionHash === config.txHash,
      )
    ) {
      await checkpoint({
        label: BIND_TRANSACTION_LABEL,
        status: "confirmed",
        transactionHash: config.txHash,
        receipt: finalized.evidence,
        exactReplay: recovery,
      });
    }
    let proof = createBindProof(
      factoryProof,
      request,
      config.txHash,
      new Date().toISOString(),
    );
    proof = persistBindProof(config.bindProofPath, proof);
    evidence.bindReceipt = finalized.evidence;
    evidence.boundFactoryVerification = finalized.factory;
    evidence.bindProof = proof;
    evidence.outcome = "production-factory-bound-to-finalized-v8";
    evidence.completedAt = new Date().toISOString();
    persistEvidence();
    if (config.json) {
      const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
      assertEvidenceContainsNoSecrets(serialized, env);
      process.stdout.write(serialized);
    }
    return evidence;
  } catch (error) {
    const safeMessage = sanitizeOperationalError(error, [config.rpcUrl]);
    if (evidence && config.evidencePath) {
      evidence.outcome = "failed";
      evidence.error = safeMessage;
      evidence.completedAt = new Date().toISOString();
      writeEvidenceFile(config.evidencePath, evidence, evidenceWritten, env);
    }
    throw new Error(safeMessage);
  } finally {
    let releaseError;
    try { provider?.destroy?.(); } catch (error) { releaseError ??= error; }
    try { bindLock?.release(); } catch (error) { releaseError ??= error; }
    try { signerLock?.release(); } catch (error) { releaseError ??= error; }
    if (releaseError) {
      throw new Error(sanitizeOperationalError(releaseError, [config.rpcUrl]));
    }
  }
}

export function bindCliSummary(result) {
  const lines = [
    `${result.outcome}: ${result.factoryAddress ?? "no factory"}`,
  ];
  if (result.requiredBindConfirmation) {
    lines.push(`requiredBindConfirmation=${result.requiredBindConfirmation}`);
  }
  if (result.nextAction) lines.push(`nextAction=${result.nextAction}`);
  return `${lines.join("\n")}\n`;
}

export function bindUsage() {
  return [
    "Bradbury one-time production factory bind to a finalized V8 deployment",
    "",
    "Usage:",
    "  npm run --silent bind:bradbury -- --factory-evidence <file> --v8-bind-request <file> --v8-config <file> [options]",
    "",
    "Default behavior is credential-free and read-only. It validates the finalized unbound production factory, sanitized bind request, exact V8 config/source/constructor/live GenLayer receipt/readbacks, canonical finalized outer EVM receipt, pending nonce, simulation, and fee caps. The request is a sanitized pointer, never the replayable V8 harness state.",
    "",
    "Options:",
    `  --rpc-url <url>                 Direct Bradbury EVM RPC (default: ${BRADBURY_RPC_URL})`,
    "  --factory-evidence <file>       Finalized unbound production factory evidence + journal",
    "  --v8-bind-request <file>        Sanitized finalized V8 deployment proof (never raw harness state)",
    "  --v8-config <file>              Exact reviewed V8 harness configuration/source anchor",
    "  --evidence <file>               New bind summary + append-only signed journal",
    "  --bind-proof <file>             Exact proof consumed by the V8 harness after finality",
    "  --broadcast                     Permit one exact bind_arena(V8) signed intent",
    "  --tx-hash <hash>                Reconcile the exact signed bind hash",
    "  --rebroadcast-signed            Replay only the journaled byte-identical raw bind transaction",
    "  --allow-custom-endpoints        Explicitly allow noncanonical endpoints for a write",
    `  --confirmations <1-20>          Inclusion confirmations (default: ${DEFAULT_CONFIRMATIONS})`,
    `  --timeout-ms <milliseconds>     Inclusion timeout (default: ${DEFAULT_TIMEOUT_MS})`,
    `  --finality-timeout-ms <ms>      Bradbury finality timeout (default: ${DEFAULT_FINALITY_TIMEOUT_MS})`,
    "  --json                           Emit secret-free JSON; use npm --silent",
    "  --help                           Show this text",
    "",
    "Fresh broadcast requires BRADBURY_EVM_BIND_CONFIRM from the matching dry-run and the binder's encrypted BRADBURY_EVM keystore. No bare V8 address is accepted. A crash never authorizes another signature: reconcile --tx-hash, and use --rebroadcast-signed only for the exact stored raw bytes.",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${bindUsage()}\n`);
    return;
  }
  const result = await runBradburyBindTool(argv);
  if (!argv.includes("--json")) {
    process.stdout.write(bindCliSummary(result));
  }
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
