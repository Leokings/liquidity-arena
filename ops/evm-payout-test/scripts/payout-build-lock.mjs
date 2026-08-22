import crypto from "node:crypto";

import { getAddress, keccak256 } from "ethers";

import {
  compilePayoutContracts,
  payoutSourceFiles,
} from "./compiler.mjs";

export const FACTORY_SOURCE =
  "contracts/evm/LiquidityArenaPayoutFactory.sol";
export const FACTORY_NAME = "LiquidityArenaPayoutFactory";
export const VAULT_SOURCE = "contracts/evm/LiquidityArenaPayoutVault.sol";
export const VAULT_NAME = "LiquidityArenaPayoutVault";
export const PAYOUT_PROTOCOL_VERSION = "IDEMPOTENT_EVM_VAULT_V1";

// These values deliberately bind the deployment utility to the reviewed build.
// A source or toolchain change requires an explicit review and lock update.
export const PAYOUT_BUILD_LOCK = Object.freeze({
  solcVersion: "0.8.28+commit.7893614a.Emscripten.clang",
  compilerInputSha256:
    "abbd5e06e656ab37d169bf53547b0af94299fbb592d364cacc2e65636b9e92c3",
  creationBytecodeKeccak256:
    "0xd8877da795863c07b7b37cd0b1c44ec41af880a2d0d8fcb1cfeb8395734a93df",
  runtimeTemplateKeccak256:
    "0xc32c1a8f3d2bea7b9dd3df3e36cdf818ef5bd5fe9de853fa23e732b1958d0e61",
  sourceSha256: Object.freeze({
    "contracts/evm/LiquidityArenaPayoutFactory.sol":
      "a909278713106f099ad86c46be717e1f03ec1027142cdee75c96fc200ea800eb",
    "contracts/evm/LiquidityArenaPayoutVault.sol":
      "4ae314c6ffcacb19ee686b35e042ee726259819a92b3dbc35283396fdb000362",
  }),
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${label} does not match the reviewed payout build lock (expected ${expected}, received ${actual})`,
    );
  }
}

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visitor);
    } else if (value && typeof value === "object") {
      walkAst(value, visitor);
    }
  }
}

function immutableNamesByAstId(compiled) {
  const names = new Map();
  const ast = compiled.output.sources?.[FACTORY_SOURCE]?.ast;
  walkAst(ast, (node) => {
    if (
      node.nodeType === "VariableDeclaration" &&
      node.stateVariable === true &&
      node.mutability === "immutable"
    ) {
      names.set(String(node.id), node.name);
    }
  });
  return names;
}

function addressWord(value) {
  return getAddress(value).slice(2).toLowerCase().padStart(64, "0");
}

export function materializeFactoryRuntime(build, { binder, reserveSink }) {
  const runtime = build.factoryArtifact.evm.deployedBytecode.object;
  if (!runtime || !/^[0-9a-fA-F]+$/.test(runtime)) {
    throw new Error("Compiled factory runtime bytecode is missing or invalid");
  }

  const values = {
    binder: addressWord(binder),
    reserveSink: addressWord(reserveSink),
  };
  const names = immutableNamesByAstId(build.compiled);
  const references =
    build.factoryArtifact.evm.deployedBytecode.immutableReferences ?? {};
  const bytes = Buffer.from(runtime, "hex");
  const seen = new Set();

  for (const [astId, locations] of Object.entries(references)) {
    const name = names.get(String(astId));
    if (!(name in values)) {
      throw new Error(`Unrecognized factory immutable AST id ${astId}`);
    }
    seen.add(name);
    const replacement = Buffer.from(values[name], "hex");
    for (const { start, length } of locations) {
      if (length !== replacement.length) {
        throw new Error(
          `Unexpected ${name} immutable width ${length}; expected ${replacement.length}`,
        );
      }
      replacement.copy(bytes, start);
    }
  }

  for (const name of Object.keys(values)) {
    if (!seen.has(name)) {
      throw new Error(`Compiled runtime has no immutable references for ${name}`);
    }
  }
  return `0x${bytes.toString("hex")}`;
}

export function loadLockedPayoutBuild() {
  const compiled = compilePayoutContracts();
  requireEqual("solc version", compiled.compilerVersion, PAYOUT_BUILD_LOCK.solcVersion);

  for (const sourcePath of payoutSourceFiles) {
    const content = compiled.input.sources[sourcePath]?.content;
    if (typeof content !== "string") {
      throw new Error(`Locked source ${sourcePath} is missing`);
    }
    requireEqual(
      `${sourcePath} SHA-256`,
      sha256(content),
      PAYOUT_BUILD_LOCK.sourceSha256[sourcePath],
    );
  }

  requireEqual(
    "compiler input SHA-256",
    sha256(JSON.stringify(compiled.input)),
    PAYOUT_BUILD_LOCK.compilerInputSha256,
  );

  const factoryArtifact = compiled.artifact(FACTORY_SOURCE, FACTORY_NAME);
  const vaultArtifact = compiled.artifact(VAULT_SOURCE, VAULT_NAME);
  const creationBytecode = `0x${factoryArtifact.evm.bytecode.object}`;
  const runtimeTemplate = `0x${factoryArtifact.evm.deployedBytecode.object}`;
  requireEqual(
    "factory creation bytecode keccak256",
    keccak256(creationBytecode),
    PAYOUT_BUILD_LOCK.creationBytecodeKeccak256,
  );
  requireEqual(
    "factory runtime template keccak256",
    keccak256(runtimeTemplate),
    PAYOUT_BUILD_LOCK.runtimeTemplateKeccak256,
  );

  return {
    compiled,
    factoryArtifact,
    vaultArtifact,
    creationBytecode,
    runtimeTemplate,
    lock: PAYOUT_BUILD_LOCK,
  };
}
