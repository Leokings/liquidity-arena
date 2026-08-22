import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
  ContractFactory,
  HDNodeWallet,
  Interface,
  Transaction,
  Wallet,
  getCreateAddress,
  keccak256,
} from "ethers";
import { network } from "../../ops/evm-payout-test/scripts/hardhat-test-runtime.mjs";

import {
  BRADBURY_CLIENT_PATTERN,
  BRADBURY_EXPLORER_SOLC_VERSION,
  BRADBURY_RPC_URL,
  BROADCAST_CONFIRMATION_PREFIX,
  FACTORY_FULLY_QUALIFIED_NAME,
  MAX_FEE_PER_GAS,
  MAX_SEQUENCE_NATIVE_COST,
  appendDurableCheckpoint,
  assertEvidenceContainsNoSecrets,
  factoryCliSummary,
  inspectExplorerVerification,
  parseArguments,
  preflightFactoryDeployment,
  protectedEvmEvidenceRoot,
  rebroadcastJournaledTransaction,
  reconcileFactoryDeploymentTransaction,
  requireRehearsalProvenance,
  resolveConfiguration,
  runBradburyFactoryTool,
  runRehearsal,
  sendCheckedTransaction,
  submitExplorerVerification,
  validateBradburyIdentity,
  validateCredentialFreeUrl,
  validateJournaledFactoryDeployment,
  verifyFactoryAt,
  waitForReceiptFinality,
  writeEvidenceFile,
  readCheckpointJournal,
  readEvidenceFile,
  requiredIntentConfirmation,
  usage,
} from "../../ops/evm-payout-test/scripts/bradbury-factory.mjs";
import {
  PAYOUT_BUILD_LOCK,
  loadLockedPayoutBuild,
  materializeFactoryRuntime,
} from "../../ops/evm-payout-test/scripts/payout-build-lock.mjs";

const BINDER = "0x797d3b25fb2cca0ff93f60df1910267f3822d655";
const RESERVE = "0x87e94edab4418e8a9ea37c0fab0675cf0602a9f2";

function configArgs(extra = []) {
  return ["--binder", BINDER, "--reserve-sink", RESERVE, ...extra];
}

function temporaryEvidence(t, name = "evidence.json") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arena-bradbury-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function protectedEvidence(t, name = "evidence.json") {
  const root = protectedEvmEvidenceRoot();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "factory-recovery-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

const REHEARSAL_LABELS = [
  "deploy-sacrificial-rehearsal-factory",
  "bind-sacrificial-arena",
  "prepare-one-wei-vault",
  "fund-exact-principal",
  "recipient-withdraw",
  "duplicate-fund-as-excess",
  "permissionless-recover-excess",
];

function fakeFinalizedRehearsalAuthorization() {
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

test("reviewed payout source, compiler input, and bytecode locks compile exactly", () => {
  const build = loadLockedPayoutBuild();
  assert.equal(build.compiled.compilerVersion, PAYOUT_BUILD_LOCK.solcVersion);
  assert.ok(build.creationBytecode.startsWith("0x60"));
  const first = materializeFactoryRuntime(build, {
    binder: BINDER,
    reserveSink: RESERVE,
  });
  const second = materializeFactoryRuntime(build, {
    binder: RESERVE,
    reserveSink: BINDER,
  });
  assert.notEqual(first, second);
  assert.equal(first.length, build.runtimeTemplate.length);
});

test("CLI parser and secure configuration reject ambiguous or unsafe deployment", () => {
  assert.throws(() => parseArguments(["--broadcast", "--broadcast"]), /Duplicate/);
  assert.throws(() => parseArguments(["--private-key", "secret"]), /Unknown/);
  assert.throws(
    () => validateCredentialFreeUrl("http://rpc.example", "RPC"),
    /must use https/,
  );
  assert.throws(
    () => validateCredentialFreeUrl("https://user:pass@rpc.example", "RPC"),
    /must not contain credentials/,
  );
  assert.throws(
    () =>
      resolveConfiguration(
        parseArguments(["--binder", BINDER, "--reserve-sink", BINDER]),
        {},
      ),
    /must be distinct/,
  );
  assert.throws(
    () => resolveConfiguration(parseArguments(configArgs(["--broadcast"])), {}),
    /requires --evidence/,
  );
  assert.throws(
    () =>
      resolveConfiguration(parseArguments(configArgs(["--broadcast"])), {
        BRADBURY_EVM_EVIDENCE_PATH: "factory-evidence.json",
      }),
    /requires --rehearsal-evidence/,
  );
  assert.throws(
    () =>
      resolveConfiguration(parseArguments(configArgs()), {
        BRADBURY_EVM_PRIVATE_KEY: "forbidden",
      }),
    /Raw private-key/,
  );

  const dryRun = resolveConfiguration(parseArguments(configArgs()), {});
  assert.equal(dryRun.broadcast, false);
  assert.equal(dryRun.rpcUrl, BRADBURY_RPC_URL);
  const broadcast = resolveConfiguration(parseArguments(configArgs(["--rehearse", "--broadcast"])), {
    BRADBURY_EVM_BROADCAST_CONFIRM: `${BROADCAST_CONFIRMATION_PREFIX}TEST`,
    BRADBURY_EVM_EVIDENCE_PATH: "factory-evidence.json",
  });
  assert.equal(broadcast.broadcast, true);
  assert.throws(
    () =>
      resolveConfiguration(
        parseArguments(configArgs(["--rehearse", "--broadcast", "--overwrite-evidence"])),
        { BRADBURY_EVM_EVIDENCE_PATH: "factory-evidence.json" },
      ),
    /overwrite-evidence is forbidden/,
  );
  assert.throws(
    () =>
      resolveConfiguration(
        parseArguments(configArgs([
          "--rehearse",
          "--factory",
          Wallet.createRandom().address,
          "--from-block",
          "1",
          "--broadcast",
        ])),
        { BRADBURY_EVM_EVIDENCE_PATH: "new.json" },
      ),
    /requires --rehearsal-evidence/,
  );
  assert.throws(
    () =>
      resolveConfiguration(
        parseArguments(configArgs([
          "--rehearse",
          "--broadcast",
          "--rpc-url",
          "https://rpc.example/token/path",
        ])),
        { BRADBURY_EVM_EVIDENCE_PATH: "factory-evidence.json" },
      ),
    /canonical Bradbury endpoints/,
  );
});

test("Bradbury identity is pinned to chain 4221 and the reviewed zkSync OS client", () => {
  validateBradburyIdentity("0x107d", "zksync-os/v0.21.0");
  validateBradburyIdentity(4221, "zksync-os/v0.21.0/linux-amd64");
  assert.match("zksync-os/v0.21.0", BRADBURY_CLIENT_PATTERN);
  assert.throws(
    () => validateBradburyIdentity("0x7a69", "zksync-os/v0.21.0"),
    /Refusing chain/,
  );
  assert.throws(
    () => validateBradburyIdentity("0x107d", "Geth/v1.15.0"),
    /unexpected Bradbury client/,
  );
  assert.throws(
    () => validateBradburyIdentity("0x107d", "zksync-os/v0.22.0"),
    /unexpected Bradbury client/,
  );
});

test("local deployment preflight simulates and verifies immutable-patched runtime", async () => {
  const { ethers } = await network.create("hardhat");
  const [binder, reserve] = await ethers.getSigners();
  const roles = {
    binder: await binder.getAddress(),
    reserveSink: await reserve.getAddress(),
  };
  const build = loadLockedPayoutBuild();
  const reviewedProvider = new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "getFeeData") {
        return async () => ({
          gasPrice: 100_000_000n,
          maxFeePerGas: 100_000_000n,
          maxPriorityFeePerGas: 0n,
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const preflight = await preflightFactoryDeployment(
    reviewedProvider,
    build,
    roles,
  );
  assert.equal(preflight.evidence.creationCallRuntimeMatched, true);
  assert.equal(await ethers.provider.getCode(preflight.predictedAddress), "0x");
  assert.ok(BigInt(preflight.evidence.gasLimit) > BigInt(preflight.evidence.gasEstimate));
  assert.match(
    preflight.requiredBroadcastConfirmation,
    new RegExp(`^${BROADCAST_CONFIRMATION_PREFIX}[0-9A-F]{64}$`),
  );
  assert.equal(
    preflight.requiredBroadcastConfirmation,
    requiredIntentConfirmation(preflight.intent),
  );
});

test("default production dry-run is credential-free and never asks for a keystore", async () => {
  const build = loadLockedPayoutBuild();
  const roles = { binder: BINDER, reserveSink: RESERVE };
  const expectedRuntime = materializeFactoryRuntime(build, roles);
  const provider = {
    async send(method) {
      if (method === "eth_chainId") return "0x107d";
      if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
      throw new Error(`unexpected RPC method ${method}`);
    },
    async getNetwork() {
      return { chainId: 4221n };
    },
    async getBlock() {
      return {
        number: 123,
        hash: `0x${"12".repeat(32)}`,
        gasLimit: 30_000_000n,
      };
    },
    async getCode() {
      return "0x";
    },
    async getTransactionCount() {
      return 7;
    },
    async estimateGas() {
      return 1_506_290n;
    },
    async getBalance() {
      return 10n ** 20n;
    },
    async getFeeData() {
      return {
        gasPrice: 1_000_000n,
        maxFeePerGas: 2_000_000n,
        maxPriorityFeePerGas: 100_000n,
      };
    },
    async call() {
      return expectedRuntime;
    },
    destroy() {},
  };
  const result = await runBradburyFactoryTool(configArgs(), {}, {
    providerFactory: () => provider,
  });
  assert.equal(result.outcome, "dry-run-passed");
  assert.equal(result.broadcastRequested, false);
  assert.equal(result.preflight.creationCallRuntimeMatched, true);
});

test("factory readback verifies exact code and views and rejects wrong immutables", async () => {
  const { ethers } = await network.create("hardhat");
  const [binder, reserve] = await ethers.getSigners();
  const roles = {
    binder: await binder.getAddress(),
    reserveSink: await reserve.getAddress(),
  };
  const build = loadLockedPayoutBuild();
  const deployer = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
    binder,
  );
  const factory = await deployer.deploy(roles.binder, roles.reserveSink);
  await factory.waitForDeployment();
  const address = await factory.getAddress();
  const verified = await verifyFactoryAt(
    ethers.provider,
    address,
    build,
    roles,
  );
  assert.equal(verified.evidence.runtimeMatched, true);
  assert.equal(verified.evidence.views.arena, ethers.ZeroAddress);
  await assert.rejects(
    verifyFactoryAt(ethers.provider, address, build, {
      binder: roles.reserveSink,
      reserveSink: roles.binder,
    }),
    /runtime mismatch/,
  );
});

test("a checkpointed production deployment transaction can be reconciled exactly", async () => {
  const { ethers } = await network.create("hardhat");
  const [binder, reserve] = await ethers.getSigners();
  const roles = {
    binder: await binder.getAddress(),
    reserveSink: await reserve.getAddress(),
  };
  const build = loadLockedPayoutBuild();
  const deployer = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
    binder,
  );
  const factory = await deployer.deploy(roles.binder, roles.reserveSink);
  const deployment = factory.deploymentTransaction();
  await deployment.wait();
  const wrappedProvider = new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "getTransaction") {
        return async (hash) => {
          const transaction = await target.getTransaction(hash);
          return transaction ? { ...transaction, chainId: 4221n } : null;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await reconcileFactoryDeploymentTransaction(
    wrappedProvider,
    deployment.hash,
    build,
    { ...roles, confirmations: 1, timeoutMs: 60_000 },
  );
  assert.equal(result.pending, false);
  assert.equal(result.address, await factory.getAddress());
  assert.equal(result.evidence.factoryVerification.runtimeMatched, true);
  assert.equal(result.evidence.deploymentDataMatched, true);
});

test("sacrificial rehearsal completes and safely reconciles from exact state", async (t) => {
  const { ethers } = await network.create("hardhat");
  const mnemonic = "test test test test test test test test test test test junk";
  const binder = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    "m/44'/60'/0'/0/0",
  ).connect(ethers.provider);
  const reserve = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    "m/44'/60'/0'/0/1",
  ).connect(ethers.provider);
  const roles = {
    binder: await binder.getAddress(),
    reserveSink: await reserve.getAddress(),
  };
  const build = loadLockedPayoutBuild();
  const deployer = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
    binder,
  );
  const factory = await deployer.deploy(roles.binder, roles.reserveSink);
  const deploymentReceipt = await factory.deploymentTransaction().wait();
  const address = await factory.getAddress();
  const wrappedProvider = new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "send") {
        return async (method, parameters) => {
          if (method === "eth_chainId") return "0x107d";
          if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
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
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const binderWallet = binder.connect(wrappedProvider);
  const reserveWallet = reserve.connect(wrappedProvider);
  const evidencePath = temporaryEvidence(t);
  appendDurableCheckpoint(evidencePath, {
    status: "journal-opened",
    mode: "rehearsal",
  });
  const config = {
    ...roles,
    mode: "rehearsal",
    confirmations: 1,
    timeoutMs: 60_000,
    finalityTimeoutMs: 5 * 60_000,
    evidencePath,
    requiredBroadcastConfirmation: "TEST_REHEARSAL_CONFIRMATION",
    broadcastConfirmation: "TEST_REHEARSAL_CONFIRMATION",
  };
  const checkpoints = [];
  const checkpoint = async (entry) => {
    appendDurableCheckpoint(evidencePath, entry);
    checkpoints.push(entry);
  };
  const first = await runRehearsal(
    wrappedProvider,
    build,
    config,
    binderWallet,
    reserveWallet,
    address,
    checkpoint,
    deploymentReceipt.blockNumber,
  );
  assert.equal(first.passed, true);
  assert.equal(first.transactions.length, 6);
  assert.equal(first.vault.state.totalArenaReceived, "2");
  assert.equal(first.vault.state.totalExcessRecovered, "1");
  assert.equal(checkpoints.filter((item) => item.status === "submitted").length, 6);
  assert.equal(checkpoints.filter((item) => item.status === "confirmed").length, 6);

  const reconciled = await runRehearsal(
    wrappedProvider,
    build,
    config,
    binderWallet,
    reserveWallet,
    address,
    async () => assert.fail("completed rehearsal must not submit again"),
    deploymentReceipt.blockNumber,
  );
  assert.equal(reconciled.passed, true);
  assert.equal(reconciled.transactions.length, 0);
});

test("production provenance accepts only the finalized exact signed rehearsal sequence", async (t) => {
  const { ethers } = await network.create("hardhat");
  const mnemonic = "test test test test test test test test test test test junk";
  const baseBinder = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    "m/44'/60'/0'/0/0",
  );
  const baseReserve = HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    "m/44'/60'/0'/0/1",
  );
  const roles = {
    binder: baseBinder.address,
    reserveSink: baseReserve.address,
  };
  const wrappedProvider = new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "send") {
        return async (method, parameters) => {
          if (method === "eth_chainId") return "0x107d";
          if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
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
        return async (tag) =>
          target.getBlock(tag === "finalized" ? "latest" : tag);
      }
      if (property === "getTransaction") {
        return async (hash) => {
          const transaction = await target.getTransaction(hash);
          return transaction ? { ...transaction, chainId: 4221n } : null;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const binder = baseBinder.connect(wrappedProvider);
  const reserve = baseReserve.connect(wrappedProvider);
  const build = loadLockedPayoutBuild();
  const evidencePath = temporaryEvidence(t, "passed-rehearsal.json");
  appendDurableCheckpoint(evidencePath, {
    status: "journal-opened",
    mode: "rehearsal",
    chainId: "4221",
    roles,
    buildLock: build.lock,
  });
  const preflight = await preflightFactoryDeployment(
    wrappedProvider,
    build,
    { ...roles, mode: "rehearsal" },
  );
  const config = {
    ...roles,
    mode: "rehearsal",
    confirmations: 1,
    timeoutMs: 60_000,
    finalityTimeoutMs: 5 * 60_000,
    evidencePath,
    requiredBroadcastConfirmation: preflight.requiredBroadcastConfirmation,
    broadcastConfirmation: preflight.requiredBroadcastConfirmation,
  };
  const checkpoint = async (entry) => appendDurableCheckpoint(evidencePath, entry);
  const deployment = await sendCheckedTransaction(
    "deploy-sacrificial-rehearsal-factory",
    binder,
    wrappedProvider,
    { data: preflight.transactionData, value: 0n },
    config,
    async (entry) => checkpoint({
      ...entry,
      predictedFactory: preflight.predictedAddress,
    }),
    {
      estimate: preflight.estimate,
      gasLimit: preflight.gasLimit,
      fees: preflight.fees,
      nonce: preflight.nonce,
      intent: preflight.intent,
    },
  );
  const deploymentReceipt = await wrappedProvider.getTransactionReceipt(
    deployment.transactionHash,
  );
  assert.equal(deploymentReceipt.contractAddress, preflight.predictedAddress);
  const rehearsal = await runRehearsal(
    wrappedProvider,
    build,
    config,
    binder,
    reserve,
    preflight.predictedAddress,
    checkpoint,
    deploymentReceipt.blockNumber,
  );
  assert.equal(rehearsal.passed, true);
  writeEvidenceFile(
    evidencePath,
    {
      schema: "liquidity-arena-bradbury-factory-evidence-v2",
      outcome: "sacrificial-rehearsal-passed",
      mode: "rehearsal",
      expectedChainId: "4221",
      roles,
      buildLock: build.lock,
      factory: preflight.predictedAddress,
      rehearsal,
    },
    false,
    {},
  );
  const proof = await requireRehearsalProvenance(
    wrappedProvider,
    build,
    config,
    evidencePath,
    { requirePassed: true },
  );
  assert.equal(proof.factoryAddress, preflight.predictedAddress);
  assert.match(proof.fingerprint.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.match(proof.fingerprint.journalHeadHash, /^[0-9a-f]{64}$/);
  assert.equal(proof.authorization.finalizedTransactions.length, 7);
  assert.deepEqual(
    proof.authorization.finalizedTransactions.map((item) => item.label),
    REHEARSAL_LABELS,
  );
  const productionPreflight = await preflightFactoryDeployment(
    wrappedProvider,
    build,
    {
      ...roles,
      mode: "production",
      rehearsalAuthorization: proof.authorization,
    },
  );
  assert.deepEqual(
    productionPreflight.intent.rehearsalAuthorization,
    proof.authorization,
  );
  const substitutedAuthorization = {
    ...proof.authorization,
    evidenceSha256: "00".repeat(32),
  };
  const substitutedPreflight = await preflightFactoryDeployment(
    wrappedProvider,
    build,
    {
      ...roles,
      mode: "production",
      rehearsalAuthorization: substitutedAuthorization,
    },
  );
  assert.notEqual(
    substitutedPreflight.requiredBroadcastConfirmation,
    productionPreflight.requiredBroadcastConfirmation,
  );

  const shifted = readEvidenceFile(evidencePath);
  shifted.rehearsal.eventFromBlock += 1;
  writeEvidenceFile(evidencePath, shifted, true, {});
  await assert.rejects(
    requireRehearsalProvenance(
      wrappedProvider,
      build,
      config,
      evidencePath,
      { requirePassed: true },
    ),
    /event provenance must start at its exact deployment block/,
  );
});

test("explorer readback locks exact standard-json source while constructor roles use deployment proof", async () => {
  const build = loadLockedPayoutBuild();
  const responseFor = (
    sourceCode,
    {
      contractName = FACTORY_FULLY_QUALIFIED_NAME,
      constructorArguments = "",
    } = {},
  ) => ({
    ok: true,
    async json() {
      return {
        status: "1",
        result: [
          {
            SourceCode: JSON.stringify(sourceCode),
            ContractName: contractName,
            CompilerVersion: BRADBURY_EXPLORER_SOLC_VERSION,
            OptimizationUsed: "1",
            Runs: "200",
            EVMVersion: "cancun",
            ConstructorArguments: constructorArguments,
          },
        ],
      };
    },
  });
  const fetchImpl = async () => responseFor(build.compiled.input);
  const result = await inspectExplorerVerification(
    "https://explorer.example/api",
    Wallet.createRandom().address,
    { binder: BINDER, reserveSink: RESERVE },
    { fetchImpl },
  );
  assert.equal(result.verified, true);
  assert.equal(result.sourceLockMatched, true);
  assert.equal(result.constructorArgumentsAvailable, false);
  assert.equal(result.constructorArgumentsMatched, null);

  const firstSourcePath = Object.keys(build.compiled.input.sources)[0];
  const mismatchedInput = structuredClone(build.compiled.input);
  mismatchedInput.sources[firstSourcePath].content += "\n// mismatch";
  const mismatch = await inspectExplorerVerification(
    "https://explorer.example/api",
    Wallet.createRandom().address,
    { binder: BINDER, reserveSink: RESERVE },
    { fetchImpl: async () => responseFor(mismatchedInput) },
  );
  assert.equal(mismatch.verified, true);
  assert.equal(mismatch.sourceLockMatched, false);

  const simpleName = await inspectExplorerVerification(
    "https://explorer.example/api",
    Wallet.createRandom().address,
    { binder: BINDER, reserveSink: RESERVE },
    {
      fetchImpl: async () => responseFor(build.compiled.input, {
        contractName: "LiquidityArenaPayoutFactory",
      }),
    },
  );
  assert.equal(simpleName.sourceLockMatched, false);

  const wrongConstructor = await inspectExplorerVerification(
    "https://explorer.example/api",
    Wallet.createRandom().address,
    { binder: BINDER, reserveSink: RESERVE },
    {
      fetchImpl: async () => responseFor(build.compiled.input, {
        constructorArguments: "00".repeat(64),
      }),
    },
  );
  assert.equal(wrongConstructor.constructorArgumentsAvailable, true);
  assert.equal(wrongConstructor.constructorArgumentsMatched, false);
  assert.equal(wrongConstructor.sourceLockMatched, false);
});

test("explorer submission sends locked standard JSON and polls its GUID", async () => {
  const build = loadLockedPayoutBuild();
  const requests = [];
  let statusPolls = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const action = new URL(url).searchParams.get("action");
    if (action === "verifysourcecode") {
      return {
        ok: true,
        async json() {
          return { status: "1", result: "verification-guid-123" };
        },
      };
    }
    assert.equal(action, "checkverifystatus");
    assert.equal(new URL(url).searchParams.get("guid"), "verification-guid-123");
    statusPolls += 1;
    return {
      ok: true,
      async json() {
        return statusPolls === 1
          ? { status: "0", result: "Pending in queue" }
          : { status: "1", result: "Pass - Verified" };
      },
    };
  };
  const result = await submitExplorerVerification(
    "https://explorer.example/api",
    Wallet.createRandom().address,
    build,
    { binder: BINDER, reserveSink: RESERVE },
    {
      fetchImpl,
      pollIntervalMs: 0,
      timeoutMs: 10_000,
      sleepImpl: async () => {},
    },
  );
  assert.equal(result.verified, true);
  assert.equal(result.guid, "verification-guid-123");
  assert.equal(result.polls, 2);
  const submission = requests[0];
  assert.equal(new URL(submission.url).searchParams.get("action"), "verifysourcecode");
  assert.equal(submission.options.method, "POST");
  const body = JSON.parse(submission.options.body);
  assert.equal(body.codeformat, "solidity-standard-json-input");
  assert.equal(
    body.contractname,
    FACTORY_FULLY_QUALIFIED_NAME,
  );
  assert.equal(typeof body.sourceCode, "string");
  assert.deepEqual(JSON.parse(body.sourceCode), build.compiled.input);
  assert.equal(body.compilerversion, BRADBURY_EXPLORER_SOLC_VERSION);
  assert.equal(body.evmVersion, "cancun");
  assert.equal(body.optimizationUsed, "1");
  assert.equal(body.runs, 200);
  assert.equal(body.constructorArguments.startsWith("0x"), false);
});

test("machine-readable evidence rejects every supported keystore secret", () => {
  const env = {
    BRADBURY_EVM_KEYSTORE_JSON: "encrypted-json-marker",
    BRADBURY_EVM_KEYSTORE_B64: "encrypted-base64-marker",
    BRADBURY_EVM_KEYSTORE_PASSWORD: "password-marker",
    BRADBURY_EVM_RECIPIENT_KEYSTORE_JSON: "recipient-json-marker",
    BRADBURY_EVM_RECIPIENT_KEYSTORE_B64: "recipient-base64-marker",
    BRADBURY_EVM_RECIPIENT_KEYSTORE_PASSWORD: "recipient-password-marker",
  };
  assert.doesNotThrow(() =>
    assertEvidenceContainsNoSecrets(JSON.stringify({ address: BINDER }), env),
  );
  for (const secret of Object.values(env)) {
    assert.throws(
      () => assertEvidenceContainsNoSecrets(JSON.stringify({ leaked: secret }), env),
      /Evidence unexpectedly contains/,
    );
  }
});

function checkedTransactionProvider({
  wallet,
  onBroadcast = async () => assert.fail("broadcast must not be reached"),
  onGetTransaction = async () => null,
  maxFeePerGas = 100_000_000n,
} = {}) {
  let feeReads = 0;
  return {
    get feeReads() {
      return feeReads;
    },
    async send(method) {
      if (method === "eth_chainId") return "0x107d";
      if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
      throw new Error(`unexpected RPC method ${method}`);
    },
    async getNetwork() {
      return { chainId: 4221n };
    },
    async getBlock(tag) {
      return {
        number: tag === "finalized" ? 100 : 101,
        hash: `0x${"44".repeat(32)}`,
        gasLimit: 30_000_000n,
      };
    },
    async estimateGas() {
      return 21_000n;
    },
    async getFeeData() {
      feeReads += 1;
      return {
        gasPrice: maxFeePerGas,
        maxFeePerGas,
        maxPriorityFeePerGas: 0n,
      };
    },
    async getBalance() {
      return 10n ** 20n;
    },
    async getTransactionCount() {
      return 0;
    },
    async broadcastTransaction(raw) {
      return onBroadcast(raw);
    },
    async getTransaction(hash) {
      return onGetTransaction(hash);
    },
    wallet,
  };
}

async function interruptedRehearsalFixture(t, name, crashBoundary) {
  const { ethers } = await network.create("hardhat");
  const [funder] = await ethers.getSigners();
  const baseBinder = Wallet.createRandom();
  const baseReserve = Wallet.createRandom();
  let forbidBroadcast = false;
  const observedRaw = [];
  const provider = new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "send") {
        return async (method, parameters) => {
          if (method === "eth_chainId") return "0x107d";
          if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
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
          if (forbidBroadcast) assert.fail("read-only rehearsal recovery must not broadcast");
          observedRaw.push(rawTransaction);
          return target.broadcastTransaction(rawTransaction);
        };
      }
      if (property === "destroy") return () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const binder = baseBinder.connect(provider);
  const reserve = baseReserve.connect(provider);
  await (await funder.sendTransaction({
    to: binder.address,
    value: 10n * 10n ** 18n,
  })).wait();
  await (await funder.sendTransaction({
    to: reserve.address,
    value: 10n * 10n ** 18n,
  })).wait();
  const roles = { binder: binder.address, reserveSink: reserve.address };
  const build = loadLockedPayoutBuild();
  const evidencePath = protectedEvidence(t, name);
  appendDurableCheckpoint(evidencePath, {
    status: "journal-opened",
    mode: "rehearsal",
    chainId: "4221",
    roles,
    buildLock: build.lock,
  }, {});
  const preflight = await preflightFactoryDeployment(
    provider,
    build,
    { ...roles, mode: "rehearsal" },
  );
  const operationConfig = {
    ...roles,
    mode: "rehearsal",
    evidencePath,
    confirmations: 1,
    timeoutMs: 60_000,
    finalityTimeoutMs: 5 * 60_000,
    requiredBroadcastConfirmation: preflight.requiredBroadcastConfirmation,
    broadcastConfirmation: preflight.requiredBroadcastConfirmation,
  };
  const deployment = await sendCheckedTransaction(
    "deploy-sacrificial-rehearsal-factory",
    binder,
    provider,
    { to: null, data: preflight.transactionData, value: 0n },
    operationConfig,
    async (entry) => appendDurableCheckpoint(
      evidencePath,
      { ...entry, predictedFactory: preflight.predictedAddress },
      {},
    ),
    {
      estimate: preflight.estimate,
      gasLimit: preflight.gasLimit,
      fees: preflight.fees,
      nonce: preflight.nonce,
      intent: preflight.intent,
    },
  );
  const deploymentReceipt = await provider.getTransactionReceipt(
    deployment.transactionHash,
  );
  observedRaw.length = 0;
  const bindData = new Interface(build.factoryArtifact.abi)
    .encodeFunctionData("bind_arena", [roles.binder]);
  await assert.rejects(
    sendCheckedTransaction(
      "bind-sacrificial-arena",
      binder,
      provider,
      { to: preflight.predictedAddress, data: bindData, value: 0n },
      operationConfig,
      async (entry) => {
        if (entry.status === "confirmed" && crashBoundary === "after-acceptance") {
          throw new Error("simulated crash before bind confirmation checkpoint");
        }
        appendDurableCheckpoint(evidencePath, entry, {});
        if (entry.status === "broadcast-attempt" && crashBoundary === "before-send") {
          throw new Error("simulated crash after signed bind fsync before send");
        }
      },
    ),
    crashBoundary === "before-send"
      ? /after signed bind fsync before send/
      : /before bind confirmation checkpoint/,
  );
  const signed = readCheckpointJournal(evidencePath)
    .map((record) => record.entry)
    .find((entry) =>
      entry.status === "signed" && entry.label === "bind-sacrificial-arena");
  assert.ok(signed);
  writeEvidenceFile(evidencePath, {
    schema: "liquidity-arena-bradbury-factory-evidence-v2",
    mode: "rehearsal",
    outcome: "transaction-submitted-awaiting-confirmation",
    expectedChainId: "4221",
    roles,
    buildLock: build.lock,
    factory: preflight.predictedAddress,
    deploymentReceipt: deployment,
  }, false, {});
  return {
    provider,
    binder,
    reserve,
    roles,
    build,
    evidencePath,
    factoryAddress: preflight.predictedAddress,
    deploymentBlock: deploymentReceipt.blockNumber,
    signed,
    observedRaw,
    setForbidBroadcast(value) { forbidBroadcast = value; },
  };
}

test("atomic evidence and hash-chained journals never overwrite recovery history", async (t) => {
  const evidencePath = temporaryEvidence(t);
  writeEvidenceFile(evidencePath, { schema: "first", value: 1 }, false, {});
  writeEvidenceFile(evidencePath, { schema: "second", value: 2 }, true, {});
  assert.deepEqual(readEvidenceFile(evidencePath), { schema: "second", value: 2 });
  appendDurableCheckpoint(evidencePath, { status: "signed", transactionHash: `0x${"11".repeat(32)}` });
  appendDurableCheckpoint(evidencePath, { status: "submitted", transactionHash: `0x${"11".repeat(32)}` });
  const journal = readCheckpointJournal(evidencePath);
  assert.equal(journal.length, 2);
  assert.equal(journal[1].previousEntryHash, journal[0].entryHash);
  assert.equal(
    fs.readdirSync(path.dirname(evidencePath)).some((name) => name.includes(".tmp-")),
    false,
  );
  await assert.rejects(
    async () =>
      runBradburyFactoryTool(
        configArgs(["--evidence", evidencePath, "--overwrite-evidence"]),
        {},
      ),
    /append-only/,
  );
});

test("a signed transaction is durable before any RPC broadcast and binds exact fees", async (t) => {
  const evidencePath = temporaryEvidence(t);
  appendDurableCheckpoint(evidencePath, { status: "journal-opened" });
  const wallet = Wallet.createRandom();
  let broadcasts = 0;
  const provider = checkedTransactionProvider({
    wallet,
    onBroadcast: async () => {
      broadcasts += 1;
      assert.fail("fault injection must stop before RPC broadcast");
    },
  });
  const confirmation = "TEST_EXACT_SIGNED_INTENT";
  await assert.rejects(
    sendCheckedTransaction(
      "fault-injected-deployment",
      wallet,
      provider,
      { to: Wallet.createRandom().address, data: "0x", value: 0n },
      {
        mode: "production",
        evidencePath,
        confirmations: 1,
        timeoutMs: 60_000,
        finalityTimeoutMs: 5 * 60_000,
        requiredBroadcastConfirmation: confirmation,
        broadcastConfirmation: confirmation,
      },
      async (entry) => {
        appendDurableCheckpoint(evidencePath, entry);
        if (entry.status === "broadcast-attempt") {
          throw new Error("injected checkpoint boundary stop");
        }
      },
    ),
    /injected checkpoint boundary stop/,
  );
  assert.equal(broadcasts, 0);
  assert.equal(provider.feeReads, 1);
  const signed = readCheckpointJournal(evidencePath)
    .map((record) => record.entry)
    .find((entry) => entry.status === "signed");
  assert.ok(signed);
  assert.equal(keccak256(signed.rawTransaction), signed.transactionHash);
  const decoded = Transaction.from(signed.rawTransaction);
  assert.equal(decoded.maxFeePerGas, 100_000_000n);
  assert.equal(decoded.maxPriorityFeePerGas, 0n);
  assert.equal(decoded.chainId, 4221n);
});

test("unsupported transaction types, access lists, and fee drift stop before broadcast journaling", async (t) => {
  const cases = [
    {
      name: "EIP-2930 type 1",
      sign(wallet, request) {
        const { maxFeePerGas, maxPriorityFeePerGas, type, ...base } = request;
        return wallet.signTransaction({
          ...base,
          type: 1,
          gasPrice: 1_000_000_000_000n,
        });
      },
    },
    {
      name: "EIP-4844 type 3",
      sign(wallet, request) {
        return wallet.signTransaction({
          ...request,
          type: 3,
          maxFeePerBlobGas: 100_000_000n,
          blobVersionedHashes: [`0x01${"00".repeat(31)}`],
        });
      },
    },
    {
      name: "EIP-1559 access list drift",
      sign(wallet, request) {
        return wallet.signTransaction({
          ...request,
          accessList: [{
            address: Wallet.createRandom().address,
            storageKeys: [],
          }],
        });
      },
      error: /unreviewed access list/,
    },
    {
      name: "EIP-1559 fee drift",
      sign(wallet, request) {
        return wallet.signTransaction({
          ...request,
          maxFeePerGas: request.maxFeePerGas + 1n,
        });
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const evidencePath = temporaryEvidence(t, `${scenario.name.replaceAll(" ", "-")}.json`);
      appendDurableCheckpoint(evidencePath, { status: "journal-opened" });
      const wallet = Wallet.createRandom();
      let broadcasts = 0;
      const provider = checkedTransactionProvider({
        wallet,
        onBroadcast: async () => {
          broadcasts += 1;
          assert.fail("invalid signed fee envelope must never reach RPC broadcast");
        },
      });
      const signer = {
        getAddress: () => wallet.address,
        signTransaction: (request) => scenario.sign(wallet, request),
      };
      const confirmation = "TEST_EXACT_FEE_ENVELOPE";
      await assert.rejects(
        sendCheckedTransaction(
          "fee-envelope-regression",
          signer,
          provider,
          { to: Wallet.createRandom().address, data: "0x", value: 0n },
          {
            mode: "production",
            evidencePath,
            confirmations: 1,
            timeoutMs: 60_000,
            finalityTimeoutMs: 5 * 60_000,
            requiredBroadcastConfirmation: confirmation,
            broadcastConfirmation: confirmation,
          },
          async (entry) => appendDurableCheckpoint(evidencePath, entry),
        ),
        scenario.error ?? /signed transaction type or fee fields changed after review/,
      );
      assert.equal(broadcasts, 0);
      assert.equal(
        readCheckpointJournal(evidencePath)
          .map((record) => record.entry)
          .some((entry) => ["signed", "broadcast-attempt", "submitted"].includes(entry.status)),
        false,
      );
    });
  }
});

test("ambiguous submission cannot sign or broadcast a replacement", async (t) => {
  const evidencePath = temporaryEvidence(t);
  appendDurableCheckpoint(evidencePath, { status: "journal-opened" });
  const wallet = Wallet.createRandom();
  let broadcasts = 0;
  const provider = checkedTransactionProvider({
    wallet,
    onBroadcast: async () => {
      broadcasts += 1;
      throw new Error("accepted then transport closed");
    },
  });
  const config = {
    mode: "production",
    evidencePath,
    confirmations: 1,
    timeoutMs: 60_000,
    finalityTimeoutMs: 5 * 60_000,
    requiredBroadcastConfirmation: "TEST_AMBIGUOUS_INTENT",
    broadcastConfirmation: "TEST_AMBIGUOUS_INTENT",
  };
  const request = { to: Wallet.createRandom().address, data: "0x", value: 0n };
  const checkpoint = async (entry) => appendDurableCheckpoint(evidencePath, entry);
  await assert.rejects(
    sendCheckedTransaction("ambiguous", wallet, provider, request, config, checkpoint),
    /outcome is ambiguous/,
  );
  assert.equal(broadcasts, 1);
  await assert.rejects(
    sendCheckedTransaction("ambiguous", wallet, provider, request, config, checkpoint),
    /already has signed hash/,
  );
  assert.equal(broadcasts, 1);
});

test("recovery replays only exact reviewed deployment bytes and enforces the fee cap", async (t) => {
  const build = loadLockedPayoutBuild();
  const wallet = Wallet.createRandom();
  const reserveSink = Wallet.createRandom().address;
  const factory = new ContractFactory(
    build.factoryArtifact.abi,
    build.creationBytecode,
  );
  const deployment = await factory.getDeployTransaction(
    wallet.address,
    reserveSink,
  );
  const rehearsalAuthorization = fakeFinalizedRehearsalAuthorization();

  async function journalDeployment(
    evidencePath,
    maxFeePerGas,
    { accessList = [] } = {},
  ) {
    const nonce = 3;
    const gasLimit = 1_500_000n;
    const rawTransaction = await wallet.signTransaction({
      data: deployment.data,
      value: 0n,
      gasLimit,
      nonce,
      chainId: 4221n,
      type: 2,
      maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      accessList,
    });
    const transactionHash = keccak256(rawTransaction);
    const reviewedIntent = {
      schema: "liquidity-arena-bradbury-signed-intent-v1",
      chainId: "4221",
      mode: "production",
      binder: wallet.address,
      reserveSink,
      buildLock: build.lock,
      rehearsalAuthorization,
      nonce,
      predictedAddress: getCreateAddress({ from: wallet.address, nonce }),
      to: null,
      value: "0",
      transactionDataKeccak256: keccak256(deployment.data),
      gasLimit: gasLimit.toString(),
      fees: {
        type: 2,
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: "0",
        maximumGasCost: (maxFeePerGas * gasLimit).toString(),
      },
    };
    const confirmation = requiredIntentConfirmation(reviewedIntent);
    appendDurableCheckpoint(evidencePath, {
      label: "deploy-production-factory",
      status: "signed",
      transactionHash,
      rawTransaction,
      reviewedIntent,
      exactTransaction: {
        from: wallet.address,
        to: null,
        nonce,
        chainId: "4221",
        value: "0",
        gasLimit: gasLimit.toString(),
        fees: reviewedIntent.fees,
        projectedSequenceNativeCost:
          (maxFeePerGas * gasLimit).toString(),
        transactionDataKeccak256: keccak256(deployment.data),
      },
      requiredBroadcastConfirmation: confirmation,
    });
    return { rawTransaction, transactionHash, confirmation };
  }

  const evidencePath = temporaryEvidence(t, "recovery.json");
  const reviewed = await journalDeployment(evidencePath, 100_000_000n);
  const broadcastBytes = [];
  const checkpoint = async (entry) => appendDurableCheckpoint(evidencePath, entry);
  await rebroadcastJournaledTransaction(
    {
      async broadcastTransaction(rawTransaction) {
        broadcastBytes.push(rawTransaction);
        return { hash: keccak256(rawTransaction) };
      },
      async getTransaction() { return null; },
    },
    build,
    {
      evidencePath,
      txHash: reviewed.transactionHash,
      binder: wallet.address,
      reserveSink,
      expectedMode: "production",
      rehearsalAuthorization,
      broadcastConfirmation: reviewed.confirmation,
    },
    checkpoint,
  );
  assert.deepEqual(broadcastBytes, [reviewed.rawTransaction]);
  assert.deepEqual(
    readCheckpointJournal(evidencePath)
      .map((record) => record.entry.status),
    ["signed", "broadcast-attempt", "submitted"],
  );
  const signedEntry = readCheckpointJournal(evidencePath)[0].entry;
  await assert.rejects(
    validateJournaledFactoryDeployment(
      build,
      {
        evidencePath,
        txHash: reviewed.transactionHash,
        binder: wallet.address,
        reserveSink,
        expectedMode: "production",
        rehearsalAuthorization,
      },
      {
        ...signedEntry,
        reviewedIntent: { ...signedEntry.reviewedIntent, unexpected: true },
      },
    ),
    /exact reviewed confirmation intent/,
  );

  const overCapPath = temporaryEvidence(t, "over-cap.json");
  const overCap = await journalDeployment(overCapPath, MAX_FEE_PER_GAS + 1n);
  let overCapBroadcasts = 0;
  await assert.rejects(
    rebroadcastJournaledTransaction(
      {
        async broadcastTransaction() {
          overCapBroadcasts += 1;
          return { hash: overCap.transactionHash };
        },
        async getTransaction() { return null; },
      },
      build,
      {
        evidencePath: overCapPath,
        txHash: overCap.transactionHash,
        binder: wallet.address,
        reserveSink,
        expectedMode: "production",
        rehearsalAuthorization,
        broadcastConfirmation: overCap.confirmation,
      },
      async () => assert.fail("fee rejection must happen before checkpointing"),
    ),
    /fee ceiling/,
  );
  assert.equal(overCapBroadcasts, 0);

  const accessListPath = temporaryEvidence(t, "access-list.json");
  const accessList = await journalDeployment(
    accessListPath,
    100_000_000n,
    {
      accessList: [{
        address: Wallet.createRandom().address,
        storageKeys: [],
      }],
    },
  );
  let accessListBroadcasts = 0;
  await assert.rejects(
    rebroadcastJournaledTransaction(
      {
        async broadcastTransaction() {
          accessListBroadcasts += 1;
          return { hash: accessList.transactionHash };
        },
        async getTransaction() { return null; },
      },
      build,
      {
        evidencePath: accessListPath,
        txHash: accessList.transactionHash,
        binder: wallet.address,
        reserveSink,
        expectedMode: "production",
        rehearsalAuthorization,
        broadcastConfirmation: accessList.confirmation,
      },
      async () => assert.fail("access-list rejection must happen before checkpointing"),
    ),
    /unreviewed access list/,
  );
  assert.equal(accessListBroadcasts, 0);
});

test("read-only factory recovery validates the original raw intent and appends confirmation without replay", async (t) => {
  const { ethers } = await network.create("hardhat");
  const baseBinder = Wallet.createRandom();
  const baseReserve = Wallet.createRandom();
  let forbidBroadcast = false;
  const provider = new Proxy(ethers.provider, {
    get(target, property) {
      if (property === "send") {
        return async (method, parameters) => {
          if (method === "eth_chainId") return "0x107d";
          if (method === "web3_clientVersion") return "zksync-os/v0.21.0";
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
          if (forbidBroadcast) assert.fail("read-only recovery must not broadcast");
          return target.broadcastTransaction(rawTransaction);
        };
      }
      if (property === "destroy") return () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const binder = baseBinder.connect(provider);
  const reserve = baseReserve.connect(provider);
  const [funder] = await ethers.getSigners();
  await (await funder.sendTransaction({
    to: binder.address,
    value: 10n * 10n ** 18n,
  })).wait();
  const roles = {
    binder: binder.address,
    reserveSink: reserve.address,
  };
  const build = loadLockedPayoutBuild();
  const rehearsalAuthorization = fakeFinalizedRehearsalAuthorization();
  const evidencePath = protectedEvidence(t, "original-deployment.json");
  appendDurableCheckpoint(evidencePath, {
    status: "journal-opened",
    mode: "production",
    chainId: "4221",
    roles,
    buildLock: build.lock,
  }, {});
  const preflight = await preflightFactoryDeployment(provider, build, {
    ...roles,
    mode: "production",
    rehearsalAuthorization,
  });
  await assert.rejects(
    sendCheckedTransaction(
      "deploy-production-factory",
      binder,
      provider,
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
      async (entry) => {
        if (entry.status === "confirmed") {
          throw new Error("simulated crash before confirmed journal append");
        }
        appendDurableCheckpoint(
          evidencePath,
          { ...entry, predictedFactory: preflight.predictedAddress },
          {},
        );
      },
      {
        estimate: preflight.estimate,
        gasLimit: preflight.gasLimit,
        fees: preflight.fees,
        nonce: preflight.nonce,
        intent: preflight.intent,
      },
    ),
    /simulated crash/,
  );
  const signed = readCheckpointJournal(evidencePath)
    .map((record) => record.entry)
    .find((entry) => entry.status === "signed");
  assert.ok(signed);
  writeEvidenceFile(evidencePath, {
    schema: "liquidity-arena-bradbury-factory-evidence-v2",
    mode: "production",
    outcome: "transaction-submitted-awaiting-confirmation",
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
  }, false, {});
  forbidBroadcast = true;
  const result = await runBradburyFactoryTool(
    [
      "--binder", roles.binder,
      "--reserve-sink", roles.reserveSink,
      "--tx-hash", signed.transactionHash,
      "--evidence", evidencePath,
      "--confirmations", "1",
      "--timeout-ms", "60000",
      "--finality-timeout-ms", "300000",
    ],
    {},
    {
      providerFactory: () => provider,
      fetchImpl: async () => ({
        ok: true,
        async json() { return { status: "0", result: [{ SourceCode: "" }] }; },
      }),
    },
  );
  assert.equal(result.outcome, "deployment-transaction-reconciled");
  const recoveredEntries = readCheckpointJournal(evidencePath)
    .map((record) => record.entry);
  assert.equal(recoveredEntries.filter((entry) => entry.status === "signed").length, 1);
  assert.equal(recoveredEntries.filter((entry) => entry.status === "confirmed").length, 1);
  assert.equal(
    recoveredEntries.find((entry) => entry.status === "confirmed").exactReplay,
    false,
  );
});

test("landed post-CREATE rehearsal transaction backfills its exact confirmation without replay", async (t) => {
  const fixture = await interruptedRehearsalFixture(
    t,
    "accepted-bind-recovery.json",
    "after-acceptance",
  );
  assert.equal(fixture.observedRaw.length, 1);
  assert.equal(fixture.observedRaw[0], fixture.signed.rawTransaction);
  fixture.setForbidBroadcast(true);
  const result = await runBradburyFactoryTool(
    [
      "--binder", fixture.roles.binder,
      "--reserve-sink", fixture.roles.reserveSink,
      "--rehearse",
      "--tx-hash", fixture.signed.transactionHash,
      "--evidence", fixture.evidencePath,
      "--confirmations", "1",
      "--timeout-ms", "60000",
      "--finality-timeout-ms", "300000",
    ],
    {},
    {
      providerFactory: () => fixture.provider,
      walletLoader: async () => assert.fail("read-only recovery must not load a signer"),
    },
  );
  assert.equal(result.outcome, "rehearsal-transaction-reconciled");
  assert.equal(result.rehearsalSnapshot.nextAction, "prepare-one-wei-vault");
  const entries = readCheckpointJournal(fixture.evidencePath)
    .map((record) => record.entry);
  assert.equal(
    entries.filter((entry) => entry.label === "bind-sacrificial-arena" &&
      entry.status === "signed").length,
    1,
  );
  const confirmed = entries.find((entry) =>
    entry.label === "bind-sacrificial-arena" && entry.status === "confirmed");
  assert.ok(confirmed);
  assert.equal(confirmed.transactionHash, fixture.signed.transactionHash);
  assert.equal(confirmed.exactReplay, false);
  assert.equal(fixture.observedRaw.length, 1);
});

test("rehearsal resume rejects a signed but unconfirmed imported prefix before signer loading", async (t) => {
  const fixture = await interruptedRehearsalFixture(
    t,
    "unconfirmed-prefix.json",
    "before-send",
  );
  const resumedEvidencePath = protectedEvidence(t, "unconfirmed-prefix-resume.json");
  let signerLoads = 0;
  const resumeIntent = {
    schema: "liquidity-arena-bradbury-rehearsal-resume-v1",
    chainId: "4221",
    factory: fixture.factoryAddress,
    binder: fixture.roles.binder,
    reserveSink: fixture.roles.reserveSink,
    fromBlock: fixture.deploymentBlock,
    buildLock: fixture.build.lock,
  };
  await assert.rejects(
    runBradburyFactoryTool(
      [
        "--binder", fixture.roles.binder,
        "--reserve-sink", fixture.roles.reserveSink,
        "--rehearse",
        "--factory", fixture.factoryAddress,
        "--from-block", String(fixture.deploymentBlock),
        "--rehearsal-evidence", fixture.evidencePath,
        "--evidence", resumedEvidencePath,
        "--broadcast",
        "--confirmations", "1",
        "--timeout-ms", "60000",
        "--finality-timeout-ms", "300000",
      ],
      {
        BRADBURY_EVM_BROADCAST_CONFIRM: requiredIntentConfirmation(resumeIntent),
      },
      {
        providerFactory: () => fixture.provider,
        walletLoader: async () => {
          signerLoads += 1;
          throw new Error("signer must not load");
        },
      },
    ),
    /not finalized/,
  );
  assert.equal(signerLoads, 0);
});

test("missing post-CREATE rehearsal bind replays exact bytes then resumes without resigning it", async (t) => {
  const fixture = await interruptedRehearsalFixture(
    t,
    "missing-bind-recovery.json",
    "before-send",
  );
  assert.equal(fixture.observedRaw.length, 0);
  fixture.setForbidBroadcast(true);
  const recoveryArgs = [
    "--binder", fixture.roles.binder,
    "--reserve-sink", fixture.roles.reserveSink,
    "--rehearse",
    "--tx-hash", fixture.signed.transactionHash,
    "--evidence", fixture.evidencePath,
    "--confirmations", "1",
    "--timeout-ms", "60000",
    "--finality-timeout-ms", "300000",
  ];
  const pending = await runBradburyFactoryTool(
    recoveryArgs,
    {},
    {
      providerFactory: () => fixture.provider,
      walletLoader: async () => assert.fail("read-only recovery must not load a signer"),
    },
  );
  assert.equal(pending.outcome, "rehearsal-transaction-pending");
  assert.equal(pending.rehearsalTransactionReconciliation.transactionFound, false);
  assert.equal(fixture.observedRaw.length, 0);

  fixture.setForbidBroadcast(false);
  const replayed = await runBradburyFactoryTool(
    [...recoveryArgs, "--broadcast", "--rebroadcast-signed"],
    {
      BRADBURY_EVM_BROADCAST_CONFIRM:
        fixture.signed.requiredBroadcastConfirmation,
    },
    {
      providerFactory: () => fixture.provider,
      walletLoader: async () => assert.fail("exact replay must not load a signer"),
    },
  );
  assert.equal(replayed.outcome, "rehearsal-transaction-reconciled");
  assert.deepEqual(fixture.observedRaw, [fixture.signed.rawTransaction]);
  const recoveredEntries = readCheckpointJournal(fixture.evidencePath)
    .map((record) => record.entry);
  assert.equal(
    recoveredEntries.filter((entry) => entry.label === "bind-sacrificial-arena" &&
      entry.status === "signed").length,
    1,
  );
  assert.equal(
    recoveredEntries.filter((entry) => entry.label === "bind-sacrificial-arena" &&
      entry.status === "confirmed").length,
    1,
  );

  const resumedEvidencePath = protectedEvidence(t, "resumed-rehearsal.json");
  const resumeIntent = {
    schema: "liquidity-arena-bradbury-rehearsal-resume-v1",
    chainId: "4221",
    factory: fixture.factoryAddress,
    binder: fixture.roles.binder,
    reserveSink: fixture.roles.reserveSink,
    fromBlock: fixture.deploymentBlock,
    buildLock: fixture.build.lock,
  };
  const resumed = await runBradburyFactoryTool(
    [
      "--binder", fixture.roles.binder,
      "--reserve-sink", fixture.roles.reserveSink,
      "--rehearse",
      "--factory", fixture.factoryAddress,
      "--from-block", String(fixture.deploymentBlock),
      "--rehearsal-evidence", fixture.evidencePath,
      "--evidence", resumedEvidencePath,
      "--broadcast",
      "--confirmations", "1",
      "--timeout-ms", "60000",
      "--finality-timeout-ms", "300000",
    ],
    {
      BRADBURY_EVM_BROADCAST_CONFIRM: requiredIntentConfirmation(resumeIntent),
    },
    {
      providerFactory: () => fixture.provider,
      walletLoader: async (_env, prefix, expectedAddress) => {
        if (prefix === "BRADBURY_EVM") {
          assert.equal(expectedAddress, fixture.roles.binder);
          return fixture.binder;
        }
        assert.equal(prefix, "BRADBURY_EVM_RECIPIENT");
        assert.equal(expectedAddress, fixture.roles.reserveSink);
        return fixture.reserve;
      },
      fetchImpl: async () => ({
        ok: true,
        async json() { return { status: "0", result: [{ SourceCode: "" }] }; },
      }),
    },
  );
  assert.equal(resumed.outcome, "sacrificial-rehearsal-passed");
  const effectiveEntries = readCheckpointJournal(resumedEvidencePath)
    .map((record) => record.entry)
    .flatMap((entry) =>
      entry.status === "provenance-import" ? [entry.importedEntry] : [entry]);
  const signedEntries = effectiveEntries.filter((entry) => entry.status === "signed");
  assert.deepEqual(signedEntries.map((entry) => entry.label), REHEARSAL_LABELS);
  assert.equal(
    signedEntries.filter((entry) => entry.label === "bind-sacrificial-arena").length,
    1,
  );
  assert.equal(
    signedEntries.find((entry) => entry.label === "bind-sacrificial-arena")
      .transactionHash,
    fixture.signed.transactionHash,
  );
  const resumedRecoveryPath = protectedEvidence(
    t,
    "resumed-transaction-recovery-copy.json",
  );
  fs.copyFileSync(resumedEvidencePath, resumedRecoveryPath);
  fs.copyFileSync(
    `${resumedEvidencePath}.checkpoints.jsonl`,
    `${resumedRecoveryPath}.checkpoints.jsonl`,
  );
  const lastSigned = signedEntries.at(-1);
  fixture.setForbidBroadcast(true);
  const resumedRecovery = await runBradburyFactoryTool(
    [
      "--binder", fixture.roles.binder,
      "--reserve-sink", fixture.roles.reserveSink,
      "--rehearse",
      "--tx-hash", lastSigned.transactionHash,
      "--evidence", resumedRecoveryPath,
      "--confirmations", "1",
      "--timeout-ms", "60000",
      "--finality-timeout-ms", "300000",
    ],
    {},
    {
      providerFactory: () => fixture.provider,
      walletLoader: async () => assert.fail("read-only resumed recovery must not load a signer"),
    },
  );
  assert.equal(resumedRecovery.outcome, "rehearsal-transaction-reconciled");
  assert.equal(resumedRecovery.rehearsalSnapshot.nextAction, "complete");
  assert.equal(
    readCheckpointJournal(resumedRecoveryPath)
      .map((record) => record.entry)
      .flatMap((entry) =>
        entry.status === "provenance-import" ? [entry.importedEntry] : [entry])
      .filter((entry) => entry.status === "signed").length,
    7,
  );
});

test("whole-sequence worst-case native cost includes prior signed journal entries", async (t) => {
  const evidencePath = temporaryEvidence(t);
  appendDurableCheckpoint(evidencePath, { status: "journal-opened" });
  const wallet = Wallet.createRandom();
  for (let nonce = 0; nonce < 5; nonce += 1) {
    const rawTransaction = await wallet.signTransaction({
      to: Wallet.createRandom().address,
      value: 0n,
      data: "0x",
      gasLimit: 6_000_000n,
      nonce,
      chainId: 4221n,
      type: 2,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: 0n,
    });
    appendDurableCheckpoint(evidencePath, {
      label: `prior-${nonce}`,
      status: "signed",
      transactionHash: keccak256(rawTransaction),
      rawTransaction,
    });
  }
  assert.equal(MAX_SEQUENCE_NATIVE_COST, 30_000_000_000_000_000n);
  let broadcasts = 0;
  const provider = checkedTransactionProvider({
    wallet,
    onBroadcast: async () => {
      broadcasts += 1;
    },
  });
  await assert.rejects(
    sendCheckedTransaction(
      "next",
      wallet,
      provider,
      { to: Wallet.createRandom().address, data: "0x", value: 0n },
      {
        mode: "rehearsal",
        evidencePath,
        confirmations: 1,
        timeoutMs: 60_000,
        finalityTimeoutMs: 5 * 60_000,
        requiredBroadcastConfirmation: "TEST_TOTAL_CAP",
        broadcastConfirmation: "TEST_TOTAL_CAP",
      },
      async () => {},
    ),
    /whole|sequence worst-case native cost|total ceiling/i,
  );
  assert.equal(broadcasts, 0);
});

test("finality waits for the finalized tag and rejects a reorged receipt block", async () => {
  const receipt = {
    hash: `0x${"22".repeat(32)}`,
    blockNumber: 10,
    blockHash: `0x${"33".repeat(32)}`,
  };
  let finalizedReads = 0;
  const provider = {
    async getBlock(tag) {
      if (tag === "finalized") {
        finalizedReads += 1;
        return {
          number: finalizedReads === 1 ? 9 : 10,
          hash: `0x${"55".repeat(32)}`,
        };
      }
      assert.equal(tag, 10);
      return { number: 10, hash: receipt.blockHash };
    },
  };
  const proof = await waitForReceiptFinality(provider, receipt, 60_000, {
    pollIntervalMs: 0,
    sleepImpl: async () => {},
  });
  assert.equal(proof.receiptBlockFinalized, true);
  assert.equal(finalizedReads, 2);

  await assert.rejects(
    waitForReceiptFinality(
      {
        async getBlock(tag) {
          return tag === "finalized"
            ? { number: 10, hash: `0x${"66".repeat(32)}` }
            : { number: 10, hash: `0x${"77".repeat(32)}` };
        },
      },
      receipt,
      60_000,
      { pollIntervalMs: 0, sleepImpl: async () => {} },
    ),
    /not canonical at Bradbury finality/,
  );
});

test("custom endpoint path credentials are redacted from dry-run evidence", async () => {
  const build = loadLockedPayoutBuild();
  const roles = { binder: BINDER, reserveSink: RESERVE };
  const expectedRuntime = materializeFactoryRuntime(build, roles);
  const provider = {
    async send(method) {
      return method === "eth_chainId" ? "0x107d" : "zksync-os/v0.21.0";
    },
    async getNetwork() { return { chainId: 4221n }; },
    async getBlock() { return { number: 1, hash: `0x${"88".repeat(32)}`, gasLimit: 30_000_000n }; },
    async getCode() { return "0x"; },
    async getTransactionCount() { return 1; },
    async estimateGas() { return 1_506_290n; },
    async getBalance() { return 10n ** 20n; },
    async getFeeData() { return { gasPrice: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }; },
    async call() { return expectedRuntime; },
    destroy() {},
  };
  const result = await runBradburyFactoryTool(
    configArgs(["--rpc-url", "https://rpc.example/private-token-path"]),
    {},
    { providerFactory: () => provider },
  );
  assert.deepEqual(result.endpoint.origin, "https://rpc.example");
  assert.equal(JSON.stringify(result).includes("private-token-path"), false);
  assert.match(usage(), /npm run --silent deploy:bradbury/);
  assert.match(usage(), /deployment or post-CREATE rehearsal hash/);
  assert.match(usage(), /add --rehearse for a post-CREATE rehearsal hash/);
});

test("factory failure evidence and thrown errors redact custom endpoint paths", async (t) => {
  const evidencePath = temporaryEvidence(t, "redacted-failure.json");
  const endpoint = "https://rpc.example/private-token-path";
  const provider = {
    async send() {
      throw new Error(`connection failed at ${endpoint}`);
    },
    async getNetwork() { return { chainId: 4221n }; },
    async getBlock() {
      return { number: 1, hash: `0x${"88".repeat(32)}`, gasLimit: 30_000_000n };
    },
    destroy() {},
  };
  const error = await runBradburyFactoryTool(
    configArgs(["--rpc-url", endpoint, "--evidence", evidencePath]),
    {},
    { providerFactory: () => provider },
  ).then(
    () => assert.fail("fault-injected endpoint must fail"),
    (caught) => caught,
  );
  assert.equal(String(error.message).includes("private-token-path"), false);
  assert.equal(inspect(error, { depth: 8 }).includes("private-token-path"), false);
  assert.equal(String(error.stack).includes("private-token-path"), false);
  assert.equal(fs.readFileSync(evidencePath, "utf8").includes("private-token-path"), false);
});

test("default factory CLI summary exposes authorization and next action", () => {
  const summary = factoryCliSummary({
    outcome: "dry-run",
    preflight: { predictedAddress: "0x1111111111111111111111111111111111111111" },
    requiredBroadcastConfirmation: "AUTHORIZE_EXACT_INTENT",
    nextAction: "review before broadcast",
  });
  assert.match(summary, /requiredBroadcastConfirmation=AUTHORIZE_EXACT_INTENT/);
  assert.match(summary, /nextAction=review before broadcast/);
});
