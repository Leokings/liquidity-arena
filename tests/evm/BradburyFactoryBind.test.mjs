import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
  ContractFactory,
  Interface,
  Transaction,
  Wallet,
  ZeroAddress,
  getBytes,
  keccak256,
} from "ethers";
import { abi as genlayerAbi } from "genlayer-js";
import { CalldataAddress } from "genlayer-js/types";
import { network } from "../../ops/evm-payout-test/scripts/hardhat-test-runtime.mjs";

import {
  BIND_CONFIRMATION_PREFIX,
  BIND_NETWORK,
  V8_BIND_REQUEST_SCHEMA,
  acquireBindLock,
  bindCliSummary,
  bindUsage,
  captureJsonDocument,
  createBindProof,
  loadV8BindRequest,
  parseBindArguments,
  preflightFactoryBind,
  resolveBindConfiguration,
  runBradburyBindTool,
  validateUnboundFactoryEvidence,
  validateFinalizedV8Deployment,
} from "../../ops/evm-payout-test/scripts/bradbury-bind.mjs";
import {
  BRADBURY_RPC_URL,
  MAX_FEE_PER_GAS,
  MAX_SEQUENCE_NATIVE_COST,
  acquireBradburySignerLocks,
  appendDurableCheckpoint,
  preflightFactoryDeployment,
  readCheckpointJournal,
  protectedEvmEvidenceRoot,
  requireProtectedOperationalPath,
  sendCheckedTransaction,
  verifyFactoryAt,
  writeEvidenceFile,
} from "../../ops/evm-payout-test/scripts/bradbury-factory.mjs";
import {
  loadLockedPayoutBuild,
} from "../../ops/evm-payout-test/scripts/payout-build-lock.mjs";
import {
  EXPECTED_V8_SCHEMA_SHA256,
  EXPECTED_V8_SCHEMA,
  BRADBURY_CONSENSUS_ADDRESS,
  NEW_TRANSACTION_TOPIC,
  PAYOUT_PROTOCOL_VERSION,
  V8_POLICY_VERSION,
  V8_PROTOCOL_VERSION,
  loadAndValidateBindProof,
  buildExpectedConfigReadback,
  buildExpectedReserveReadback,
  normalizeConfig,
  acquireOwnerLock,
  operationalEvidenceRoot,
  ownerLockPathFor,
  sha256,
} from "../../ops/bradbury-v8/harness.mjs";

const OWNER_AND_BINDER = "0x797d3b25fb2cca0ff93f60df1910267f3822d655";
const RESERVE = "0x87e94edab4418e8a9ea37c0fab0675cf0602a9f2";
const FACTORY = "0x4444444444444444444444444444444444444444";
const ARENA = "0x7777777777777777777777777777777777777777";
const TREASURY = "0x3333333333333333333333333333333333333333";
const KEEPER = "0x2222222222222222222222222222222222222222";
const GENLAYER_HASH = `0x${"ab".repeat(32)}`;
const EVM_HASH = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"de".repeat(32)}`;
const RUNTIME_SHA256 = "ef".repeat(32);
const REHEARSAL_LABELS = [
  "deploy-sacrificial-rehearsal-factory",
  "bind-sacrificial-arena",
  "prepare-one-wei-vault",
  "fund-exact-principal",
  "recipient-withdraw",
  "duplicate-fund-as-excess",
  "permissionless-recover-excess",
];

function fakeRehearsalAuthorization() {
  return {
    schema: "liquidity-arena-bradbury-rehearsal-authorization-v1",
    evidenceSha256: "91".repeat(32),
    journalHeadHash: "92".repeat(32),
    journalEntries: 22,
    factoryAddress: Wallet.createRandom().address,
    outcome: "sacrificial-rehearsal-passed",
    finalizedTransactions: REHEARSAL_LABELS.map((label, index) => ({
      label,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      blockNumber: index + 1,
      blockHash: `0x${(index + 101).toString(16).padStart(64, "0")}`,
    })),
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arena-bind-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function protectedEvidencePath(t, name) {
  const root = protectedEvmEvidenceRoot();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "bind-path-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function validBindRequest(overrides = {}) {
  const request = {
    schema: V8_BIND_REQUEST_SCHEMA,
    version: 1,
    network: BIND_NETWORK,
    chainId: 4221,
    configFingerprint: "11".repeat(32),
    sourcePath: "contracts/LiquidityArenaV8.release.py",
    sourceSha256: "12".repeat(32),
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    deploymentGenLayerTransactionHash: GENLAYER_HASH,
    deploymentEvmTransactionHash: EVM_HASH,
    deploymentEvmReceiptBlockHash: BLOCK_HASH,
    deploymentEvmReceiptBlockNumber: "0x2a",
    deploymentGenLayerReceiptStatus: "FINALIZED",
    deploymentGenLayerExecutionResult: "FINISHED_WITH_RETURN",
    deploymentGenLayerExecutionSuccess: true,
    deploymentEvmFinalityVerified: false,
    deploymentEvmFinalityRequiredBeforeBind: true,
    leaderOnly: false,
    arenaAddress: ARENA,
    ownerAddress: OWNER_AND_BINDER,
    constructorArguments: {
      treasuryAddress: TREASURY,
      keeperAddress: KEEPER,
      epochMinStakeAtto: "100000000000000000",
      epochMaxStakePerWalletAtto: "10000000000000000000",
      payoutFactoryAddress: FACTORY,
    },
    factoryAddress: FACTORY,
    binderAddress: OWNER_AND_BINDER,
    reserveSinkAddress: RESERVE,
    v8ProtocolVersion: V8_PROTOCOL_VERSION,
    payoutProtocolVersion: PAYOUT_PROTOCOL_VERSION,
    factoryRuntimeBytecodeSha256: RUNTIME_SHA256,
    exactDeploymentReadback: true,
    cutsOverApplication: false,
    cutsOverDatabase: false,
    verifiedAt: new Date().toISOString(),
  };
  return { ...request, ...overrides };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function harnessConfig() {
  return normalizeConfig({
    version: 1,
    network: BIND_NETWORK,
    chainId: 4221,
    sourcePath: "contracts/LiquidityArenaV8.release.py",
    sourceSha256: "12".repeat(32),
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    ownerAccountName: "bradbury-owner",
    expected: {
      ownerAddress: OWNER_AND_BINDER,
      keeperAddress: KEEPER,
      treasuryAddress: TREASURY,
      payoutFactoryAddress: FACTORY,
      factoryBinderAddress: OWNER_AND_BINDER,
      reserveSinkAddress: RESERVE,
      factoryRuntimeBytecodeSha256: RUNTIME_SHA256,
      protocolVersion: V8_PROTOCOL_VERSION,
      policyVersion: V8_POLICY_VERSION,
      payoutProtocolVersion: PAYOUT_PROTOCOL_VERSION,
      epochMinStakeAtto: "100000000000000000",
      epochMaxStakePerWalletAtto: "10000000000000000000",
      platformFeeBps: 200,
    },
    reserve: { initialFundingAtto: "3000000000000000000" },
    operator: {
      finalityRetries: 900,
      finalityIntervalMs: 5000,
      maxEvmGasLimit: "30000000",
      maxEvmGasPriceWei: "1000000000",
    },
  });
}

function rawHarnessConfigForSource(sourceSha256, roles = {}) {
  const owner = roles.owner ?? OWNER_AND_BINDER;
  const binder = roles.binder ?? OWNER_AND_BINDER;
  const reserve = roles.reserveSink ?? RESERVE;
  const factory = roles.factoryAddress ?? FACTORY;
  const runtimeSha256 = roles.runtimeSha256 ?? RUNTIME_SHA256;
  return {
    version: 1,
    network: BIND_NETWORK,
    chainId: 4221,
    sourcePath: "contracts/LiquidityArenaV8.release.py",
    sourceSha256,
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    ownerAccountName: "bradbury-owner",
    expected: {
      ownerAddress: owner,
      keeperAddress: KEEPER,
      treasuryAddress: TREASURY,
      payoutFactoryAddress: factory,
      factoryBinderAddress: binder,
      reserveSinkAddress: reserve,
      factoryRuntimeBytecodeSha256: runtimeSha256,
      protocolVersion: V8_PROTOCOL_VERSION,
      policyVersion: V8_POLICY_VERSION,
      payoutProtocolVersion: PAYOUT_PROTOCOL_VERSION,
      epochMinStakeAtto: "100000000000000000",
      epochMaxStakePerWalletAtto: "10000000000000000000",
      platformFeeBps: 200,
    },
    reserve: { initialFundingAtto: "3000000000000000000" },
    operator: {
      finalityRetries: 900,
      finalityIntervalMs: 5000,
      maxEvmGasLimit: "30000000",
      maxEvmGasPriceWei: "1000000000",
    },
  };
}

function deploymentOuterCalldata(config, source) {
  const constructor = genlayerAbi.calldata.makeCalldataObject(undefined, [
    new CalldataAddress(getBytes(config.expected.treasuryAddress)),
    new CalldataAddress(getBytes(config.expected.keeperAddress)),
    BigInt(config.expected.epochMinStakeAtto),
    BigInt(config.expected.epochMaxStakePerWalletAtto),
    new CalldataAddress(getBytes(config.expected.payoutFactoryAddress)),
  ], undefined);
  const inner = genlayerAbi.transactions.serialize([
    source,
    genlayerAbi.calldata.encode(constructor),
    false,
  ]);
  const outer = new Interface([
    "function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)",
  ]);
  return outer.encodeFunctionData("addTransaction", [
    config.expected.ownerAddress,
    "0x0000000000000000000000000000000000000000",
    5n,
    3n,
    inner,
    4_600n,
  ]);
}

function addressTopic(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function v8ValidationFixture(t, roles = {}) {
  const projectRoot = temporaryDirectory(t);
  const owner = roles.owner ?? OWNER_AND_BINDER;
  const binder = roles.binder ?? OWNER_AND_BINDER;
  const reserveSink = roles.reserveSink ?? RESERVE;
  const factoryAddress = roles.factoryAddress ?? FACTORY;
  const arenaAddress = roles.arenaAddress ?? ARENA;
  const runtimeSha256 = roles.runtimeSha256 ?? RUNTIME_SHA256;
  const source = [
    "AUDITED_PAYOUT_FACTORY_CHAIN_ID = 4_221",
    `AUDITED_PAYOUT_FACTORY_4221 = "${factoryAddress}"`,
    "",
  ].join("\n");
  fs.mkdirSync(path.join(projectRoot, "contracts"));
  fs.writeFileSync(
    path.join(projectRoot, "contracts", "LiquidityArenaV8.release.py"),
    source,
    "utf8",
  );
  const rawConfig = rawHarnessConfigForSource(sha256(source), {
    owner,
    binder,
    reserveSink,
    factoryAddress,
    runtimeSha256,
  });
  const config = normalizeConfig(rawConfig);
  const configPath = path.join(projectRoot, "v8-config.json");
  writeJson(configPath, rawConfig);
  const requestPath = path.join(projectRoot, "bind-request.json");
  writeJson(requestPath, validBindRequest({
    configFingerprint: config.fingerprint,
    sourceSha256: sha256(source),
    arenaAddress: arenaAddress.toLowerCase(),
    ownerAddress: owner.toLowerCase(),
    constructorArguments: {
      ...validBindRequest().constructorArguments,
      payoutFactoryAddress: factoryAddress.toLowerCase(),
    },
    factoryAddress: factoryAddress.toLowerCase(),
    binderAddress: binder.toLowerCase(),
    reserveSinkAddress: reserveSink.toLowerCase(),
    factoryRuntimeBytecodeSha256: runtimeSha256,
  }));
  const request = loadV8BindRequest(requestPath);
  const deploymentReceipt = {
    hash: GENLAYER_HASH,
    statusName: "FINALIZED",
    txExecutionResultName: "FINISHED_WITH_RETURN",
    sender: owner,
    recipient: arenaAddress,
    value: "0",
    txDataDecoded: {
      type: "deploy",
      leaderOnly: false,
      code: source,
      constructorArgs: {
        args: [
          TREASURY,
          KEEPER,
          rawConfig.expected.epochMinStakeAtto,
          rawConfig.expected.epochMaxStakePerWalletAtto,
          factoryAddress,
        ],
        kwargs: {},
      },
      contractAddress: arenaAddress,
    },
  };
  const reader = {
    async waitFinalized() { return deploymentReceipt; },
    async transaction() { return { hash: GENLAYER_HASH }; },
    async code() { return source; },
    async schema() { return EXPECTED_V8_SCHEMA; },
    async call(_address, method) {
      if (method === "get_config") {
        return buildExpectedConfigReadback(config, {
          payoutsEnabled: false,
          newRiskEnabled: false,
        });
      }
      if (method === "get_delivery_reserve_state") {
        return buildExpectedReserveReadback(config, {
          payoutsEnabled: false,
          newRiskEnabled: false,
          availableReserveAtto: "0",
        });
      }
      if (method === "get_epoch_page") {
        return { offset: "0", next_offset: "0", total: "0", epoch_ids: [] };
      }
      if (method === "get_payout_page") {
        return { offset: "0", next_offset: "0", total: "0", payouts: [] };
      }
      throw new Error(`unexpected V8 read ${method}`);
    },
  };
  const rawReceipt = {
    transactionHash: EVM_HASH,
    status: "0x1",
    blockHash: BLOCK_HASH,
    blockNumber: "0x2a",
    logs: [{
      address: BRADBURY_CONSENSUS_ADDRESS,
      topics: [
        NEW_TRANSACTION_TOPIC,
        GENLAYER_HASH,
        addressTopic(arenaAddress),
        addressTopic(owner),
      ],
      data: "0x",
      transactionHash: EVM_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: "0x2a",
      logIndex: "0x0",
    }],
  };
  const rawTransaction = {
    hash: EVM_HASH,
    from: owner,
    to: BRADBURY_CONSENSUS_ADDRESS,
    blockHash: BLOCK_HASH,
    blockNumber: "0x2a",
    chainId: "0x107d",
    value: "0x0",
    input: deploymentOuterCalldata(config, source),
  };
  const blocks = {
    finalized: { number: "0x2b", hash: `0x${"fa".repeat(32)}` },
    "0x2a": { number: "0x2a", hash: BLOCK_HASH },
  };
  const provider = {
    async send(method, params) {
      if (method === "eth_getTransactionReceipt") return rawReceipt;
      if (method === "eth_getTransactionByHash") return rawTransaction;
      if (method === "eth_getBlockByNumber") return blocks[params[0]];
      throw new Error(`unexpected EVM read ${method}`);
    },
  };
  return {
    projectRoot,
    configPath,
    requestPath,
    config,
    request,
    source,
    deploymentReceipt,
    reader,
    rawReceipt,
    rawTransaction,
    blocks,
    provider,
  };
}

function reviewedLocalProvider(targetProvider) {
  let broadcastMode = "normal";
  let broadcastObserver = () => {};
  let v8EvmProvider;
  const rawV8Methods = new Set([
    "eth_getTransactionReceipt",
    "eth_getTransactionByHash",
    "eth_getBlockByNumber",
  ]);
  const provider = new Proxy(targetProvider, {
    get(target, property) {
      if (property === "send") {
        return async (method, parameters) => {
          if (method === "eth_chainId") return "0x107d";
          if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
          if (v8EvmProvider && rawV8Methods.has(method)) {
            return v8EvmProvider.send(method, parameters);
          }
          return target.send(method, parameters);
        };
      }
      if (property === "getNetwork") return async () => ({ chainId: 4221n });
      if (property === "getFeeData") {
        return async () => ({
          gasPrice: 100_000_000n,
          maxFeePerGas: 100_000_000n,
          maxPriorityFeePerGas: 0n,
        });
      }
      if (property === "getBlock") {
        return async (tag) => target.getBlock(tag === "finalized" ? "latest" : tag);
      }
      if (property === "getTransaction") {
        return async (hash) => {
          const transaction = await target.getTransaction(hash);
          return transaction ? { ...transaction, chainId: 4221n } : null;
        };
      }
      if (property === "broadcastTransaction") {
        return async (rawTransaction) => {
          await broadcastObserver(rawTransaction);
          if (broadcastMode === "reject-before-accept") {
            throw new Error("simulated connection close before acceptance");
          }
          const response = await target.broadcastTransaction(rawTransaction);
          if (broadcastMode === "accept-then-close") {
            throw new Error("simulated connection close after acceptance");
          }
          return response;
        };
      }
      if (property === "destroy") return () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    provider,
    setBroadcastMode(value) { broadcastMode = value; },
    setBroadcastObserver(value) { broadcastObserver = value ?? (() => {}); },
    setV8EvmProvider(value) { v8EvmProvider = value; },
  };
}

async function localProductionFactoryFixture(t) {
  const { ethers } = await network.create("hardhat");
  const reviewed = reviewedLocalProvider(ethers.provider);
  const [funder] = await ethers.getSigners();
  const binder = Wallet.createRandom().connect(reviewed.provider);
  const reserve = Wallet.createRandom().connect(reviewed.provider);
  await (await funder.sendTransaction({
    to: binder.address,
    value: 10n * 10n ** 18n,
  })).wait();
  const roles = {
    binder: binder.address,
    reserveSink: reserve.address,
  };
  const build = loadLockedPayoutBuild();
  const protectedRoot = protectedEvmEvidenceRoot();
  fs.mkdirSync(protectedRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(protectedRoot, "bind-e2e-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidencePath = path.join(directory, "factory-evidence.json");
  appendDurableCheckpoint(evidencePath, {
    status: "journal-opened",
    mode: "production",
    chainId: "4221",
    roles,
    buildLock: build.lock,
  }, {});
  const rehearsalAuthorization = fakeRehearsalAuthorization();
  const preflight = await preflightFactoryDeployment(
    reviewed.provider,
    build,
    { ...roles, mode: "production", rehearsalAuthorization },
  );
  const deployed = await sendCheckedTransaction(
    "deploy-production-factory",
    binder,
    reviewed.provider,
    { to: null, data: preflight.transactionData, value: 0n },
    {
      mode: "production",
      evidencePath,
      confirmations: 1,
      timeoutMs: 60_000,
      finalityTimeoutMs: 5 * 60_000,
      requiredBroadcastConfirmation: preflight.requiredBroadcastConfirmation,
      broadcastConfirmation: preflight.requiredBroadcastConfirmation,
    },
    async (entry) => appendDurableCheckpoint(evidencePath, entry, {}),
    {
      estimate: preflight.estimate,
      gasLimit: preflight.gasLimit,
      fees: preflight.fees,
      nonce: preflight.nonce,
      intent: preflight.intent,
    },
  );
  const verified = await verifyFactoryAt(
    reviewed.provider,
    preflight.predictedAddress,
    build,
    roles,
  );
  const evidence = {
    schema: "liquidity-arena-bradbury-factory-evidence-v2",
    mode: "production",
    outcome: "production-factory-deployed-unbound",
    expectedChainId: "4221",
    roles,
    buildLock: build.lock,
    factory: preflight.predictedAddress,
    rehearsalProvenance: {
      passed: true,
      outcome: "sacrificial-rehearsal-passed",
      evidenceSha256: rehearsalAuthorization.evidenceSha256,
      journalHeadHash: rehearsalAuthorization.journalHeadHash,
      journalEntries: rehearsalAuthorization.journalEntries,
      factory: rehearsalAuthorization.factoryAddress,
      authorization: rehearsalAuthorization,
    },
    deploymentReceipt: deployed,
    factoryVerification: verified.evidence,
  };
  writeEvidenceFile(evidencePath, evidence, false, {});
  const code = await reviewed.provider.getCode(preflight.predictedAddress);
  return {
    directory,
    reviewed,
    provider: reviewed.provider,
    binder,
    reserve,
    roles,
    build,
    evidencePath,
    evidence,
    factoryAddress: preflight.predictedAddress,
    runtimeSha256: sha256(Buffer.from(code.slice(2), "hex")),
  };
}

test("bind CLI is explicit, credential-free, and uses the shared custom-endpoints spelling", () => {
  const base = [
    "--factory-evidence", "factory.json",
    "--v8-bind-request", "request.json",
    "--v8-config", "v8-config.json",
  ];
  const dryRun = resolveBindConfiguration(parseBindArguments(base), {});
  assert.equal(dryRun.broadcast, false);
  assert.equal(dryRun.rpcUrl, BRADBURY_RPC_URL);
  assert.throws(
    () => resolveBindConfiguration(parseBindArguments(base.slice(0, 4)), {}),
    /--v8-config is required/,
  );
  assert.throws(
    () => resolveBindConfiguration(parseBindArguments([...base, "--broadcast"]), {}),
    /require --evidence/,
  );
  assert.throws(
    () => resolveBindConfiguration(parseBindArguments(base), {
      BRADBURY_EVM_PRIVATE_KEY: "forbidden",
    }),
    /Raw private-key/,
  );
  assert.throws(
    () => parseBindArguments([...base, "--allow-custom-endpoint"]),
    /Unknown option/,
  );
  assert.doesNotThrow(() =>
    parseBindArguments([...base, "--allow-custom-endpoints"]));
  assert.match(bindUsage(), /--allow-custom-endpoints/);
  assert.match(bindUsage(), /npm run --silent bind:bradbury/);
  const summary = bindCliSummary({
    outcome: "bind-dry-run-passed",
    factoryAddress: FACTORY,
    requiredBindConfirmation: "AUTHORIZE_EXACT_BIND",
    nextAction: "review before broadcast",
  });
  assert.match(summary, /requiredBindConfirmation=AUTHORIZE_EXACT_BIND/);
  assert.match(summary, /nextAction=review before broadcast/);
});

test("bind path validation rejects derived journal collisions before execution", () => {
  const base = [
    "--factory-evidence", "factory.json",
    "--v8-bind-request", "request.json",
    "--v8-config", "v8-config.json",
    "--evidence", "bind.json",
    "--bind-proof", "bind.json.checkpoints.jsonl",
    "--broadcast",
  ];
  assert.throws(
    () => resolveBindConfiguration(parseBindArguments(base), {
      BRADBURY_EVM_BIND_CONFIRM: "placeholder",
    }),
    /paths must be distinct/,
  );
});

test("clean CI installs both shared harness and nested EVM dependency locks", () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(rootPackage.devDependencies.ethers, "6.17.0");
  assert.equal(rootPackage.dependencies["genlayer-js"], "1.1.8");
  assert.match(
    workflow,
    /cache-dependency-path:[\s\S]*package-lock\.json[\s\S]*ops\/evm-payout-test\/package-lock\.json/,
  );
  assert.match(
    workflow,
    /Install locked shared Bradbury harness dependencies[\s\S]*run: npm ci/,
  );
});

test("sanitized bind request is exact and permits the reviewed owner-equals-binder role", (t) => {
  const directory = temporaryDirectory(t);
  const requestPath = path.join(directory, "request.json");
  writeJson(requestPath, validBindRequest());
  const request = loadV8BindRequest(requestPath);
  assert.equal(request.ownerAddress, request.binderAddress);
  assert.equal(request.deploymentEvmFinalityVerified, false);
  assert.equal(request.deploymentEvmFinalityRequiredBeforeBind, true);

  writeJson(requestPath, validBindRequest({ unexpected: true }));
  assert.throws(() => loadV8BindRequest(requestPath), /fields do not match/);
  writeJson(requestPath, validBindRequest({ deploymentEvmFinalityVerified: true }));
  assert.throws(() => loadV8BindRequest(requestPath), /not an exact finalized/);
  writeJson(requestPath, validBindRequest({ reserveSinkAddress: OWNER_AND_BINDER }));
  assert.throws(() => loadV8BindRequest(requestPath), /only owner and binder may coincide/);
  writeJson(requestPath, validBindRequest({ ownerAddress: TREASURY }));
  assert.throws(
    () => loadV8BindRequest(requestPath),
    /requires the V8 owner and one-time factory binder to be the same EOA/,
  );
  writeJson(requestPath, validBindRequest({ arenaAddress: Wallet.createRandom().address }));
  assert.throws(
    () => loadV8BindRequest(requestPath),
    /canonical lowercase artifact encoding/,
  );
});

test("V8 bind provenance tolerates finalized constructor omission only with exact outer calldata", async (t) => {
  const fixture = v8ValidationFixture(t);
  delete fixture.deploymentReceipt.txDataDecoded.constructorArgs;
  const proof = await validateFinalizedV8Deployment(
    fixture.provider,
    fixture.request,
    fixture.configPath,
    {
      v8ReaderFactory: () => fixture.reader,
      projectRoot: fixture.projectRoot,
    },
  );
  assert.equal(proof.genlayerTransactionHash, GENLAYER_HASH);
  assert.equal(proof.evmTransactionHash, EVM_HASH);
  assert.equal(proof.evmReceiptBlockHash, BLOCK_HASH);
  assert.equal(proof.evmFinalizedBlockNumber, "0x2b");
  assert.equal(proof.exactLiveReadback, true);
});

test("V8 request and config validation stay bound to one hash-first byte snapshot", async (t) => {
  const configFixture = v8ValidationFixture(t);
  const originalWaitFinalized = configFixture.reader.waitFinalized.bind(
    configFixture.reader,
  );
  configFixture.reader.waitFinalized = async (...args) => {
    fs.appendFileSync(configFixture.configPath, "\n", "utf8");
    return originalWaitFinalized(...args);
  };
  await assert.rejects(
    validateFinalizedV8Deployment(
      configFixture.provider,
      configFixture.request,
      configFixture.configPath,
      {
        v8ReaderFactory: () => configFixture.reader,
        projectRoot: configFixture.projectRoot,
      },
    ),
    /config or source changed while exact deployment was being validated/,
  );

  const requestOwner = Wallet.createRandom().address;
  const requestFixture = v8ValidationFixture(t, {
    owner: requestOwner,
    binder: requestOwner,
    reserveSink: Wallet.createRandom().address,
    factoryAddress: Wallet.createRandom().address,
    arenaAddress: Wallet.createRandom().address,
  });
  const replacement = JSON.parse(
    fs.readFileSync(requestFixture.requestPath, "utf8"),
  );
  const captured = captureJsonDocument(
    requestFixture.requestPath,
    "V8 bind request",
  );
  fs.appendFileSync(requestFixture.requestPath, "\n", "utf8");
  assert.equal(
    loadV8BindRequest(requestFixture.requestPath, {
      capturedDocument: captured,
    }).arenaAddress,
    requestFixture.request.arenaAddress,
  );

  const protectedRoot = protectedEvmEvidenceRoot();
  fs.mkdirSync(protectedRoot, { recursive: true });
  const operationDirectory = fs.mkdtempSync(
    path.join(protectedRoot, "request-snapshot-test-"),
  );
  t.after(() => fs.rmSync(operationDirectory, { recursive: true, force: true }));
  // Restore an exact request, then mutate it only after runBradburyBindTool has
  // captured its bytes but before any factory proof or signer can be reached.
  writeJson(requestFixture.requestPath, replacement);
  const fullProvider = {
    async send(method, params) {
      if (method === "eth_chainId") return "0x107d";
      if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
      return requestFixture.provider.send(method, params);
    },
    async getNetwork() { return { chainId: 4221n }; },
    async getBlock() {
      return { number: 100, hash: `0x${"81".repeat(32)}`, gasLimit: 30_000_000n };
    },
    destroy() {},
  };
  let signerLoads = 0;
  await assert.rejects(
    runBradburyBindTool(
      [
        "--factory-evidence", path.join(operationDirectory, "factory.json"),
        "--v8-bind-request", requestFixture.requestPath,
        "--v8-config", requestFixture.configPath,
      ],
      {},
      {
        providerFactory: () => {
          fs.appendFileSync(requestFixture.requestPath, "\n", "utf8");
          return fullProvider;
        },
        walletLoader: async () => {
          signerLoads += 1;
          throw new Error("signer must not load");
        },
        v8ReaderFactory: () => requestFixture.reader,
        v8ProjectRoot: requestFixture.projectRoot,
      },
    ),
    /bind request, config, or source changed during exact deployment validation/,
  );
  assert.equal(signerLoads, 0);
});

test("nonfinal, reorged, wrong-calldata, wrong-source, and wrong-constructor V8 proofs fail closed", async (t) => {
  const protectedRoot = protectedEvmEvidenceRoot();
  fs.mkdirSync(protectedRoot, { recursive: true });
  const operationDirectory = fs.mkdtempSync(path.join(protectedRoot, "v8-reject-test-"));
  t.after(() => fs.rmSync(operationDirectory, { recursive: true, force: true }));
  let caseIndex = 0;
  for (const [label, mutate, pattern] of [
    [
      "nonfinal EVM receipt",
      (fixture) => { fixture.blocks.finalized.number = "0x29"; },
      /has not reached Bradbury EVM finality/,
    ],
    [
      "reorged EVM receipt",
      (fixture) => { fixture.blocks["0x2a"].hash = `0x${"00".repeat(32)}`; },
      /not canonical at finality/,
    ],
    [
      "wrong outer calldata",
      (fixture) => { fixture.rawTransaction.input = "0x1234"; },
      /outer calldata|consensus calldata/,
    ],
    [
      "wrong deployed source",
      (fixture) => { fixture.deploymentReceipt.txDataDecoded.code += "# drift\n"; },
      /exact full-consensus V8 source deployment/,
    ],
    [
      "wrong constructor",
      (fixture) => {
        fixture.deploymentReceipt.txDataDecoded.constructorArgs.args[1] =
          OWNER_AND_BINDER;
      },
      /constructor arguments/,
    ],
  ]) {
    const isolatedOwner = Wallet.createRandom().address;
    const fixture = v8ValidationFixture(t, {
      owner: isolatedOwner,
      binder: isolatedOwner,
      reserveSink: Wallet.createRandom().address,
      factoryAddress: Wallet.createRandom().address,
      arenaAddress: Wallet.createRandom().address,
    });
    mutate(fixture);
    await assert.rejects(
      validateFinalizedV8Deployment(
        fixture.provider,
        fixture.request,
        fixture.configPath,
        {
          v8ReaderFactory: () => fixture.reader,
          projectRoot: fixture.projectRoot,
        },
      ),
      pattern,
      label,
    );
    let signerLoads = 0;
    const fullProvider = {
      async send(method, params) {
        if (method === "eth_chainId") return "0x107d";
        if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
        return fixture.provider.send(method, params);
      },
      async getNetwork() { return { chainId: 4221n }; },
      async getBlock() {
        return { number: 1, hash: `0x${"71".repeat(32)}`, gasLimit: 30_000_000n };
      },
      destroy() {},
    };
    const prefix = path.join(operationDirectory, `case-${caseIndex}`);
    caseIndex += 1;
    await assert.rejects(
      runBradburyBindTool(
        [
          "--factory-evidence", `${prefix}-factory.json`,
          "--v8-bind-request", fixture.requestPath,
          "--v8-config", fixture.configPath,
          "--evidence", `${prefix}-bind.json`,
          "--bind-proof", `${prefix}-proof.json`,
          "--broadcast",
        ],
        { BRADBURY_EVM_BIND_CONFIRM: "not-a-valid-confirmation" },
        {
          providerFactory: () => fullProvider,
          walletLoader: async () => {
            signerLoads += 1;
            throw new Error("signer must not load");
          },
          v8ReaderFactory: () => fixture.reader,
          v8ProjectRoot: fixture.projectRoot,
        },
      ),
      pattern,
      `${label} full producer rejection`,
    );
    assert.equal(signerLoads, 0, `${label} must fail before signer loading`);
  }
});

test("factory bind lock serializes writes and verifies ownership on release", (t) => {
  const isolatedFactory = Wallet.createRandom().address;
  const first = acquireBindLock(isolatedFactory, "12".repeat(32));
  t.after(() => {
    try { fs.unlinkSync(first.lockPath); } catch {}
  });
  assert.equal(fs.existsSync(first.lockPath), true);
  assert.throws(
    () => acquireBindLock(isolatedFactory, "12".repeat(32)),
    /Exclusive canonical factory bind lock/,
  );
  first.release();
  assert.equal(fs.existsSync(first.lockPath), false);
});

test("factory bind lock removes a newly created lock when durable initialization fails", () => {
  const isolatedFactory = Wallet.createRandom().address;
  let attemptedLockPath;
  const fileSystem = {
    ...fs,
    openSync(...args) {
      attemptedLockPath = args[0];
      return fs.openSync(...args);
    },
    writeFileSync() {
      throw new Error("fault-injected lock write failure");
    },
  };
  assert.throws(
    () => acquireBindLock(isolatedFactory, "13".repeat(32), { fileSystem }),
    /Exclusive canonical factory bind lock/,
  );
  assert.ok(attemptedLockPath);
  assert.equal(fs.existsSync(attemptedLockPath), false);
});

test("factory bind lock rejects a dangling symlink without exporting its ownership record", (t) => {
  const isolatedFactory = Wallet.createRandom().address.toLowerCase();
  const lockDirectory = path.join(operationalEvidenceRoot(), "locks");
  const lockPath = path.join(
    lockDirectory,
    `factory-4221-${isolatedFactory.slice(2)}.lock`,
  );
  const outsideTarget = path.join(
    temporaryDirectory(t),
    "exported-bind-lock.json",
  );
  fs.mkdirSync(lockDirectory, { recursive: true });
  fs.symlinkSync(outsideTarget, lockPath, "file");
  t.after(() => {
    try { fs.unlinkSync(lockPath); } catch {}
  });

  assert.throws(
    () => acquireBindLock(isolatedFactory, "14".repeat(32)),
    /alias|symbolic link|junction/,
  );
  assert.equal(fs.existsSync(outsideTarget), false);
});

test("EVM factory and bind operations contend on the harness canonical owner lock", (t) => {
  const address = Wallet.createRandom().address.toLowerCase();
  const harnessConfig = { expected: { ownerAddress: address } };
  const lockPath = ownerLockPathFor(harnessConfig);
  t.after(() => {
    try { fs.unlinkSync(lockPath); } catch {}
  });
  const harnessLock = acquireOwnerLock(harnessConfig);
  assert.throws(
    () => acquireBradburySignerLocks([address]),
    /exclusive Bradbury owner lock already exists/,
  );
  harnessLock.release();

  const evmLock = acquireBradburySignerLocks([address]);
  assert.equal(evmLock.lockPaths[0], lockPath);
  assert.throws(
    () => acquireOwnerLock(harnessConfig),
    /exclusive Bradbury owner lock already exists/,
  );
  const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  writeJson(lockPath, { ...record, token: crypto.randomUUID() });
  assert.throws(() => evmLock.release(), /ownership does not match/);
});

test("independent integration identities can hold canonical locks concurrently", (t) => {
  const firstOwner = Wallet.createRandom().address;
  const secondOwner = Wallet.createRandom().address;
  const firstFactory = Wallet.createRandom().address;
  const secondFactory = Wallet.createRandom().address;
  const locks = [
    acquireBradburySignerLocks([firstOwner]),
    acquireBradburySignerLocks([secondOwner]),
    acquireBindLock(firstFactory, "31".repeat(32)),
    acquireBindLock(secondFactory, "32".repeat(32)),
  ];
  t.after(() => {
    for (const lock of locks) {
      for (const lockPath of lock.lockPaths ?? [lock.lockPath]) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  });
  assert.notEqual(locks[0].lockPaths[0], locks[1].lockPaths[0]);
  assert.notEqual(locks[2].lockPath, locks[3].lockPath);
  for (const lock of locks.reverse()) lock.release();
});

test("signed evidence is confined to protected storage and rejects hard-link aliases", (t) => {
  const outside = path.join(temporaryDirectory(t), "outside.json");
  assert.throws(
    () => requireProtectedOperationalPath(outside, "test evidence"),
    /must stay inside protected operational storage/,
  );
  const root = protectedEvmEvidenceRoot();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "path-safety-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidate = path.join(directory, "new-evidence.json");
  assert.equal(
    requireProtectedOperationalPath(candidate, "test evidence"),
    path.resolve(candidate),
  );
  const original = path.join(directory, "original.json");
  const alias = path.join(directory, "hardlink.json");
  writeJson(original, { test: true });
  fs.linkSync(original, alias);
  assert.throws(
    () => requireProtectedOperationalPath(alias, "test evidence"),
    /must not be hard-linked/,
  );
});

test("dangling journal symlinks cannot export signed checkpoints", (t) => {
  const evidencePath = protectedEvidencePath(t, "dangling-journal.json");
  const checkpointPath = `${evidencePath}.checkpoints.jsonl`;
  const outsideDirectory = temporaryDirectory(t);
  const outsideTarget = path.join(outsideDirectory, "exported-raw-journal.jsonl");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.symlinkSync(outsideTarget, checkpointPath, "file");
  assert.throws(
    () => requireProtectedOperationalPath(checkpointPath, "checkpoint journal"),
    /alias/,
  );
  assert.throws(
    () => appendDurableCheckpoint(evidencePath, { status: "signed", rawTransaction: "0x1234" }),
    /unaliased regular file|symbolic link|ELOOP/,
  );
  assert.equal(fs.existsSync(outsideTarget), false);
});

test("finalized production factory evidence proves the exact live unbound runtime and roles", async (t) => {
  const factory = await localProductionFactoryFixture(t);
  const arenaAddress = Wallet.createRandom().address.toLowerCase();
  const requestFixture = v8ValidationFixture(t, {
    owner: factory.roles.binder,
    binder: factory.roles.binder,
    reserveSink: factory.roles.reserveSink,
    factoryAddress: factory.factoryAddress,
    runtimeSha256: factory.runtimeSha256,
    arenaAddress,
  });
  const proof = await validateUnboundFactoryEvidence(
    factory.provider,
    factory.build,
    factory.evidencePath,
    requestFixture.request,
    5 * 60_000,
  );
  assert.equal(proof.factoryAddress, factory.factoryAddress);
  assert.equal(proof.binder, factory.roles.binder);
  assert.equal(proof.reserveSink, factory.roles.reserveSink);
  assert.equal(proof.finalizedArena, ZeroAddress);
  assert.equal(proof.runtimeSha256, factory.runtimeSha256);
  assert.equal(proof.verification.eip1967ProxySlotsZero, true);
  assert.equal(proof.fingerprint.journalEntries, 5);

  const wrongRequest = {
    ...requestFixture.request,
    reserveSinkAddress: Wallet.createRandom().address,
  };
  await assert.rejects(
    validateUnboundFactoryEvidence(
      factory.provider,
      factory.build,
      factory.evidencePath,
      wrongRequest,
      5 * 60_000,
    ),
    /roles do not match/,
  );
  const substituted = JSON.parse(JSON.stringify(factory.evidence));
  substituted.rehearsalProvenance.evidenceSha256 = "00".repeat(32);
  writeEvidenceFile(factory.evidencePath, substituted, true, {});
  await assert.rejects(
    validateUnboundFactoryEvidence(
      factory.provider,
      factory.build,
      factory.evidencePath,
      requestFixture.request,
      5 * 60_000,
    ),
    /rehearsal authorization is internally inconsistent/,
  );
});

test("bind lifecycle durably journals before send, recovers by exact raw replay, and is idempotent", async (t) => {
  const factory = await localProductionFactoryFixture(t);
  const arenaAddress = Wallet.createRandom().address.toLowerCase();
  const v8 = v8ValidationFixture(t, {
    owner: factory.roles.binder,
    binder: factory.roles.binder,
    reserveSink: factory.roles.reserveSink,
    factoryAddress: factory.factoryAddress,
    runtimeSha256: factory.runtimeSha256,
    arenaAddress,
  });
  factory.reviewed.setV8EvmProvider(v8.provider);
  const common = [
    "--factory-evidence", factory.evidencePath,
    "--v8-bind-request", v8.requestPath,
    "--v8-config", v8.configPath,
    "--confirmations", "1",
    "--timeout-ms", "60000",
    "--finality-timeout-ms", "300000",
  ];
  const injected = {
    providerFactory: () => factory.provider,
    walletLoader: async () => assert.fail("dry-run/recovery must not load a signer"),
    v8ReaderFactory: () => v8.reader,
    v8ProjectRoot: v8.projectRoot,
  };
  const customRpc = "https://rpc.example/private/operator-path";
  const dryRun = await runBradburyBindTool(
    [...common, "--rpc-url", customRpc],
    {},
    injected,
  );
  assert.equal(dryRun.outcome, "bind-dry-run-passed");
  assert.deepEqual(dryRun.endpoint, {
    custom: true,
    origin: "https://rpc.example",
    sha256: sha256(customRpc),
  });
  assert.equal(JSON.stringify(dryRun).includes("private/operator-path"), false);

  const evidencePath = path.join(factory.directory, "bind-evidence.json");
  const proofPath = path.join(factory.directory, "bind-proof.json");
  const broadcastArgs = [
    ...common,
    "--evidence", evidencePath,
    "--bind-proof", proofPath,
    "--broadcast",
  ];
  let observedRaw;
  factory.reviewed.setBroadcastMode("reject-before-accept");
  factory.reviewed.setBroadcastObserver(async (rawTransaction) => {
    observedRaw = rawTransaction;
    const entries = readCheckpointJournal(evidencePath).map((record) => record.entry);
    const signed = entries.find((entry) => entry.status === "signed");
    assert.equal(signed.rawTransaction, rawTransaction);
    assert.equal(keccak256(rawTransaction), signed.transactionHash);
    assert.equal(
      entries.some((entry) => entry.status === "broadcast-attempt"),
      true,
    );
  });
  await assert.rejects(
    runBradburyBindTool(
      broadcastArgs,
      { BRADBURY_EVM_BIND_CONFIRM: dryRun.requiredBindConfirmation },
      {
        ...injected,
        walletLoader: async () => factory.binder,
      },
    ),
    /broadcast outcome is ambiguous/,
  );
  assert.ok(observedRaw);
  const firstJournal = readCheckpointJournal(evidencePath)
    .map((record) => record.entry);
  const signedEntries = firstJournal.filter((entry) => entry.status === "signed");
  assert.equal(signedEntries.length, 1);
  const signed = signedEntries[0];
  assert.equal(signed.rawTransaction, observedRaw);
  assert.equal(Transaction.from(observedRaw).to, factory.factoryAddress);

  let replayRaw;
  factory.reviewed.setBroadcastMode("normal");
  factory.reviewed.setBroadcastObserver(async (rawTransaction) => {
    replayRaw = rawTransaction;
  });
  const recovered = await runBradburyBindTool(
    [
      ...common,
      "--evidence", evidencePath,
      "--bind-proof", proofPath,
      "--tx-hash", signed.transactionHash,
      "--broadcast",
      "--rebroadcast-signed",
    ],
    {
      BRADBURY_EVM_BIND_CONFIRM: dryRun.requiredBindConfirmation,
      BRADBURY_EVM_KEYSTORE_PASSWORD: "bind-secret-marker",
    },
    injected,
  );
  assert.equal(replayRaw, observedRaw);
  assert.equal(recovered.outcome, "production-factory-bound-to-finalized-v8");
  assert.equal(
    readCheckpointJournal(evidencePath)
      .map((record) => record.entry)
      .filter((entry) => entry.status === "signed").length,
    1,
  );
  const proof = loadAndValidateBindProof(proofPath, v8.config, arenaAddress);
  assert.equal(proof.bindTransactionHash, signed.transactionHash);
  const bound = await verifyFactoryAt(
    factory.provider,
    factory.factoryAddress,
    factory.build,
    factory.roles,
    { expectedArena: arenaAddress },
  );
  assert.equal(bound.evidence.views.arena.toLowerCase(), arenaAddress);

  factory.reviewed.setBroadcastObserver(async () =>
    assert.fail("read-only idempotent recovery must not broadcast"));
  const idempotent = await runBradburyBindTool(
    [
      ...common,
      "--evidence", evidencePath,
      "--bind-proof", proofPath,
      "--tx-hash", signed.transactionHash,
    ],
    {},
    injected,
  );
  assert.equal(idempotent.outcome, "production-factory-bound-to-finalized-v8");

  await assert.rejects(
    validateUnboundFactoryEvidence(
      factory.provider,
      factory.build,
      factory.evidencePath,
      { ...v8.request, arenaAddress: Wallet.createRandom().address },
      5 * 60_000,
      { allowBoundArena: true },
    ),
    /bound only to the proven V8/,
  );
});

test("accepted-then-closed bind reconciles the one signed hash without replacement", async (t) => {
  const factory = await localProductionFactoryFixture(t);
  const arenaAddress = Wallet.createRandom().address.toLowerCase();
  const v8 = v8ValidationFixture(t, {
    owner: factory.roles.binder,
    binder: factory.roles.binder,
    reserveSink: factory.roles.reserveSink,
    factoryAddress: factory.factoryAddress,
    runtimeSha256: factory.runtimeSha256,
    arenaAddress,
  });
  factory.reviewed.setV8EvmProvider(v8.provider);
  const common = [
    "--factory-evidence", factory.evidencePath,
    "--v8-bind-request", v8.requestPath,
    "--v8-config", v8.configPath,
    "--confirmations", "1",
    "--timeout-ms", "60000",
    "--finality-timeout-ms", "300000",
  ];
  const dependencies = {
    providerFactory: () => factory.provider,
    walletLoader: async () => factory.binder,
    v8ReaderFactory: () => v8.reader,
    v8ProjectRoot: v8.projectRoot,
  };
  const dryRun = await runBradburyBindTool(common, {}, {
    ...dependencies,
    walletLoader: async () => assert.fail("dry-run must not load signer"),
  });
  const evidencePath = path.join(factory.directory, "accepted-bind.json");
  const proofPath = path.join(factory.directory, "accepted-proof.json");
  let broadcastCalls = 0;
  factory.reviewed.setBroadcastMode("accept-then-close");
  factory.reviewed.setBroadcastObserver(async () => { broadcastCalls += 1; });
  const result = await runBradburyBindTool(
    [
      ...common,
      "--evidence", evidencePath,
      "--bind-proof", proofPath,
      "--broadcast",
    ],
    {
      BRADBURY_EVM_BIND_CONFIRM: dryRun.requiredBindConfirmation,
      BRADBURY_EVM_KEYSTORE_PASSWORD: "bind-secret-marker",
    },
    dependencies,
  );
  assert.equal(result.outcome, "production-factory-bound-to-finalized-v8");
  assert.equal(broadcastCalls, 1);
  const entries = readCheckpointJournal(evidencePath).map((record) => record.entry);
  assert.equal(entries.filter((entry) => entry.status === "signed").length, 1);
  assert.equal(entries.filter((entry) => entry.status === "confirmed").length, 1);
  assert.equal(
    entries.some((entry) => entry.status === "broadcast-attempt"),
    true,
  );
});

test("bind failure evidence and thrown errors redact custom endpoint paths", async (t) => {
  const factory = await localProductionFactoryFixture(t);
  const arenaAddress = Wallet.createRandom().address.toLowerCase();
  const v8 = v8ValidationFixture(t, {
    owner: factory.roles.binder,
    binder: factory.roles.binder,
    reserveSink: factory.roles.reserveSink,
    factoryAddress: factory.factoryAddress,
    runtimeSha256: factory.runtimeSha256,
    arenaAddress,
  });
  factory.reviewed.setV8EvmProvider(v8.provider);
  const common = [
    "--factory-evidence", factory.evidencePath,
    "--v8-bind-request", v8.requestPath,
    "--v8-config", v8.configPath,
    "--confirmations", "1",
    "--timeout-ms", "60000",
    "--finality-timeout-ms", "300000",
  ];
  const dependencies = {
    providerFactory: () => factory.provider,
    v8ReaderFactory: () => v8.reader,
    v8ProjectRoot: v8.projectRoot,
  };
  const dryRun = await runBradburyBindTool(common, {}, {
    ...dependencies,
    walletLoader: async () => assert.fail("dry-run must not load signer"),
  });
  const endpoint = "https://rpc.example/private-token-path";
  const evidencePath = path.join(factory.directory, "redacted-bind.json");
  const proofPath = path.join(
    factory.directory,
    "new-proof-parent",
    "redacted-proof.json",
  );
  const providerWithFailingDestroy = new Proxy(factory.provider, {
    get(target, property) {
      if (property === "destroy") {
        return () => {
          throw new Error(`provider cleanup failed at ${endpoint}`);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const error = await runBradburyBindTool(
    [
      ...common,
      "--rpc-url", endpoint,
      "--allow-custom-endpoints",
      "--evidence", evidencePath,
      "--bind-proof", proofPath,
      "--broadcast",
    ],
    {
      BRADBURY_EVM_BIND_CONFIRM: dryRun.requiredBindConfirmation,
      BRADBURY_EVM_KEYSTORE_PASSWORD: "bind-secret-marker",
    },
    {
      ...dependencies,
      providerFactory: () => providerWithFailingDestroy,
      walletLoader: async () => {
        assert.equal(fs.statSync(path.dirname(proofPath)).isDirectory(), true);
        throw new Error(`keystore service failed at ${endpoint}`);
      },
    },
  ).then(
    () => assert.fail("fault-injected wallet loader must fail"),
    (caught) => caught,
  );
  assert.equal(String(error.message).includes("private-token-path"), false);
  assert.equal(inspect(error, { depth: 8 }).includes("private-token-path"), false);
  assert.equal(String(error.stack).includes("private-token-path"), false);
  assert.equal(fs.readFileSync(evidencePath, "utf8").includes("private-token-path"), false);
  assert.equal(fs.readFileSync(evidencePath, "utf8").includes("bind-secret-marker"), false);
  assert.equal(
    readCheckpointJournal(evidencePath)
      .map((record) => record.entry)
      .some((entry) => entry.status === "signed"),
    false,
  );
  const signerLock = acquireBradburySignerLocks([factory.roles.binder]);
  const bindLock = acquireBindLock(
    factory.factoryAddress,
    captureJsonDocument(v8.requestPath).sha256,
  );
  bindLock.release();
  signerLock.release();
});

test("bind preflight fixes exact calldata, nonce, fee envelope, and single-use confirmation", async () => {
  const request = {
    ...validBindRequest(),
    arenaAddress: Wallet.createRandom().address,
    fileSha256: "22".repeat(32),
  };
  const factoryProof = {
    factoryAddress: Wallet.createRandom().address,
    binder: Wallet.createRandom().address,
    reserveSink: Wallet.createRandom().address,
    runtimeSha256: RUNTIME_SHA256,
    fingerprint: {
      evidenceSha256: "33".repeat(32),
      journalHeadHash: "44".repeat(32),
      journalEntries: 5,
    },
    finalizedBlockNumber: 100,
    finalizedBlockHash: `0x${"55".repeat(32)}`,
    finalizedArena: "0x0000000000000000000000000000000000000000",
  };
  const v8Deployment = { configFileSha256: "66".repeat(32) };
  const provider = {
    async getTransactionCount(_address, tag) { return tag === "latest" ? 7 : 7; },
    async estimateGas() { return 50_000n; },
    async getBalance() { return 10n ** 20n; },
    async getBlock() {
      return { number: 100, hash: `0x${"77".repeat(32)}`, gasLimit: 30_000_000n };
    },
    async getFeeData() {
      return {
        gasPrice: 100_000_000n,
        maxFeePerGas: 100_000_000n,
        maxPriorityFeePerGas: 0n,
      };
    },
    async call() { return "0x"; },
  };
  const result = await preflightFactoryBind(
    provider,
    { factoryArtifact: { abi: ["function bind_arena(address)"] } },
    factoryProof,
    request,
    v8Deployment,
  );
  const parsed = new Interface(["function bind_arena(address)"]).parseTransaction({
    data: result.data,
  });
  assert.equal(parsed.name, "bind_arena");
  assert.equal(parsed.args[0], request.arenaAddress);
  assert.equal(result.intent.nonce, 7);
  assert.equal(result.intent.v8BindRequestSha256, request.fileSha256);
  assert.ok(BigInt(result.intent.fees.maximumGasCost) <= MAX_SEQUENCE_NATIVE_COST);
  assert.match(result.confirmation, new RegExp(`^${BIND_CONFIRMATION_PREFIX}[0-9A-F]{64}$`));

  await assert.rejects(
    preflightFactoryBind(
      {
        ...provider,
        async getFeeData() {
          return {
            gasPrice: MAX_FEE_PER_GAS + 1n,
            maxFeePerGas: MAX_FEE_PER_GAS + 1n,
            maxPriorityFeePerGas: 0n,
          };
        },
      },
      { factoryArtifact: { abi: ["function bind_arena(address)"] } },
      factoryProof,
      request,
      v8Deployment,
    ),
    /per-gas ceiling/,
  );
});

test("bind proof output is the exact shape independently consumed by the V8 harness", (t) => {
  const directory = temporaryDirectory(t);
  const proofPath = path.join(directory, "bind-proof.json");
  const config = harnessConfig();
  const proof = createBindProof(
    {
      factoryAddress: FACTORY,
      binder: OWNER_AND_BINDER,
      reserveSink: RESERVE,
      runtimeSha256: RUNTIME_SHA256,
    },
    { arenaAddress: ARENA },
    EVM_HASH,
    new Date().toISOString(),
  );
  writeJson(proofPath, proof);
  const consumed = loadAndValidateBindProof(proofPath, config, ARENA);
  assert.equal(consumed.bindReceiptStatus, "FINALIZED");
  assert.equal(consumed.bindExecutionSuccess, true);
  assert.equal(consumed.boundArenaReadback, ARENA);
  assert.deepEqual(
    Object.keys(proof).sort(),
    [
      "version", "network", "chainId", "factoryAddress", "arenaAddress",
      "binderAddress", "reserveSinkAddress", "protocolVersion",
      "factoryRuntimeBytecodeSha256", "bindTransactionHash",
      "bindReceiptStatus", "bindExecutionSuccess", "boundArenaReadback",
      "verifiedAt",
    ].sort(),
  );
});
