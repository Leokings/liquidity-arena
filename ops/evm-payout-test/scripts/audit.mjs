import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { compileContracts, repositoryRoot } from "./compiler.mjs";

const { output, diagnostics, artifact } = compileContracts();
assert.equal(
  diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
  0,
  "Solidity compilation must have no errors",
);

const productionSources = [
  "contracts/evm/LiquidityArenaPayoutVault.sol",
  "contracts/evm/LiquidityArenaPayoutFactory.sol",
];
const forbiddenTokens = [
  /\bdelegatecall\b/,
  /\bselfdestruct\b/,
  /\bcallcode\b/,
  /\btx\.origin\b/,
  /\bassembly\b/,
];

for (const relativePath of productionSources) {
  const source = fs.readFileSync(
    path.join(repositoryRoot, ...relativePath.split("/")),
    "utf8",
  );
  for (const forbidden of forbiddenTokens) {
    assert.equal(
      forbidden.test(source),
      false,
      `${relativePath} contains forbidden construct ${forbidden}`,
    );
  }
}

const factory = artifact(
  "contracts/evm/LiquidityArenaPayoutFactory.sol",
  "LiquidityArenaPayoutFactory",
);
const vault = artifact(
  "contracts/evm/LiquidityArenaPayoutVault.sol",
  "LiquidityArenaPayoutVault",
);

const factoryFunctions = new Set(
  factory.abi.filter((item) => item.type === "function").map((item) => item.name),
);
for (const required of [
  "is_bound",
  "protocol_version",
  "is_prepared",
  "vault_of",
  "is_credited",
  "is_withdrawn",
  "prepare",
]) {
  assert(factoryFunctions.has(required), `Factory ABI is missing ${required}`);
}

const prohibitedAuthorityFunctions = [
  "upgradeTo",
  "upgradeToAndCall",
  "setArena",
  "setReserveSink",
  "setRecipient",
  "setAmount",
  "drain",
  "sweep",
];
for (const prohibited of prohibitedAuthorityFunctions) {
  assert(!factoryFunctions.has(prohibited), `Factory exposes ${prohibited}`);
}

const vaultFunctions = new Set(
  vault.abi.filter((item) => item.type === "function").map((item) => item.name),
);
for (const required of [
  "withdraw",
  "recover_excess",
  "locked_principal",
  "excess_available",
  "record",
]) {
  assert(vaultFunctions.has(required), `Vault ABI is missing ${required}`);
}
for (const prohibited of prohibitedAuthorityFunctions) {
  assert(!vaultFunctions.has(prohibited), `Vault exposes ${prohibited}`);
}

const vaultStorage = vault.storageLayout.storage.map((entry) => entry.label);
assert.deepEqual(
  vaultStorage.sort(),
  [
    "_reentrancyState",
    "credited",
    "creditedAtBlock",
    "totalArenaReceived",
    "totalExcessRecovered",
    "withdrawn",
    "withdrawnAtBlock",
  ].sort(),
  "Vault storage must contain only delivery state; identity is immutable bytecode data",
);

const eip170RuntimeLimit = 24_576;
const eip3860InitcodeLimit = 49_152;
for (const [name, contract] of [
  ["factory", factory],
  ["vault", vault],
]) {
  assert(
    contract.evm.deployedBytecode.object.length / 2 <= eip170RuntimeLimit,
    `${name} exceeds the EIP-170 runtime bytecode limit`,
  );
  assert(
    contract.evm.bytecode.object.length / 2 <= eip3860InitcodeLimit,
    `${name} exceeds the EIP-3860 initcode limit`,
  );
}

const asts = Object.values(output.sources).map((source) => source.ast);
assert(asts.every(Boolean), "Every source must produce an AST");

console.log("Contract invariant audit passed (ABI, authority surface, storage, forbidden constructs)." );
