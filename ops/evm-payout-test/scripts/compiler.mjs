import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import solc from "solc";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(scriptDirectory, "..");
export const repositoryRoot = path.resolve(packageRoot, "../..");

const sourceFiles = [
  "contracts/evm/LiquidityArenaPayoutVault.sol",
  "contracts/evm/LiquidityArenaPayoutFactory.sol",
  "tests/evm/contracts/AdversarialRecipients.sol",
];

export function compileContracts() {
  const sources = Object.fromEntries(
    sourceFiles.map((relativePath) => [
      relativePath,
      {
        content: fs.readFileSync(
          path.join(repositoryRoot, ...relativePath.split("/")),
          "utf8",
        ),
      },
    ]),
  );

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "storageLayout",
          ],
          "": ["ast"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const diagnostics = output.errors ?? [];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((diagnostic) => diagnostic.formattedMessage).join("\n"));
  }

  return {
    output,
    diagnostics,
    artifact(sourceName, contractName) {
      const contract = output.contracts?.[sourceName]?.[contractName];
      if (!contract) {
        throw new Error(`Missing compiled contract ${sourceName}:${contractName}`);
      }
      return contract;
    },
  };
}
