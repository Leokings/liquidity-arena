import { compileContracts } from "./compiler.mjs";

const { output, diagnostics } = compileContracts();
const contracts = Object.values(output.contracts).flatMap((source) =>
  Object.keys(source),
);
const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");

console.log(
  `Compiled ${contracts.length} contracts with solc ${output.compiler?.version ?? "0.8.28"}.`,
);
console.log(`Compiler errors: 0; warnings: ${warnings.length}.`);
for (const warning of warnings) {
  console.log(warning.formattedMessage.trim());
}
