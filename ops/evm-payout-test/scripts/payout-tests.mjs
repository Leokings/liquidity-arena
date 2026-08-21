import assert from "node:assert/strict";
import test from "node:test";

import { network } from "hardhat";

import { compileContracts } from "./compiler.mjs";

const compiled = compileContracts();
const factoryArtifact = compiled.artifact(
  "contracts/evm/LiquidityArenaPayoutFactory.sol",
  "LiquidityArenaPayoutFactory",
);
const vaultArtifact = compiled.artifact(
  "contracts/evm/LiquidityArenaPayoutVault.sol",
  "LiquidityArenaPayoutVault",
);
const revertingRecipientArtifact = compiled.artifact(
  "tests/evm/contracts/AdversarialRecipients.sol",
  "ToggleRevertingRecipient",
);
const reentrantRecipientArtifact = compiled.artifact(
  "tests/evm/contracts/AdversarialRecipients.sol",
  "ReentrantRecipient",
);

async function mine(result) {
  const transaction = await result;
  if (transaction && typeof transaction.wait === "function") {
    await transaction.wait();
  }
  return transaction;
}

function nestedHexValues(value, depth = 0, visited = new Set()) {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    return /^0x[0-9a-fA-F]+$/.test(value) ? [value] : [];
  }
  if (typeof value !== "object" || visited.has(value)) return [];
  visited.add(value);

  const values = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    try {
      values.push(...nestedHexValues(value[key], depth + 1, visited));
    } catch {
      // Some provider error accessors can throw; they are not required to decode.
    }
  }
  return values;
}

async function expectCustomError(action, contract, errorName) {
  try {
    await mine(action());
  } catch (error) {
    if (String(error).includes(errorName)) return;
    for (const candidate of nestedHexValues(error)) {
      try {
        const decoded = contract.interface.parseError(candidate);
        if (decoded?.name === errorName) return;
      } catch {
        // This hex value was calldata, a transaction hash, or another error.
      }
    }
    assert.fail(`Expected ${errorName}, received: ${String(error)}`);
  }
  assert.fail(`Expected transaction to revert with ${errorName}`);
}

async function deploy(ethers, artifact, signer, constructorArguments = []) {
  const contractFactory = new ethers.ContractFactory(
    artifact.abi,
    `0x${artifact.evm.bytecode.object}`,
    signer,
  );
  const contract = await contractFactory.deploy(...constructorArguments);
  await contract.waitForDeployment();
  return contract;
}

async function fixture({ bind = true } = {}) {
  const { ethers } = await network.create("hardhat");
  const [binder, arena, reserveSink, recipient, attacker, operator, other] =
    await ethers.getSigners();
  const factory = await deploy(ethers, factoryArtifact, binder, [
    await binder.getAddress(),
    await reserveSink.getAddress(),
  ]);
  if (bind) {
    await mine(factory.connect(binder).bind_arena(await arena.getAddress()));
  }
  return {
    ethers,
    factory,
    binder,
    arena,
    reserveSink,
    recipient,
    attacker,
    operator,
    other,
  };
}

async function prepareVault(context, payoutId, recipientAddress, amount) {
  const predicted = await context.factory.predict_vault(
    payoutId,
    recipientAddress,
    amount,
  );
  await mine(
    context.factory
      .connect(context.arena)
      .prepare(payoutId, recipientAddress, amount),
  );
  const actual = await context.factory.vault_of(payoutId);
  assert.equal(actual, predicted);
  const vault = new context.ethers.Contract(
    actual,
    vaultArtifact.abi,
    context.recipient,
  );
  return { predicted, actual, vault };
}

export function registerPayoutVaultTests() {
  test("immutable factory binding and protocol surface", async () => {
    const context = await fixture({ bind: false });
    const binderAddress = await context.binder.getAddress();
    const arenaAddress = await context.arena.getAddress();

    assert.equal(
      await context.factory.protocol_version(),
      "IDEMPOTENT_EVM_VAULT_V1",
    );
    assert.equal(await context.factory.is_bound(arenaAddress), false);
    await expectCustomError(
      () => context.factory.connect(context.attacker).bind_arena(arenaAddress),
      context.factory,
      "OnlyBinder",
    );
    await mine(context.factory.connect(context.binder).bind_arena(arenaAddress));
    assert.equal(await context.factory.is_bound(arenaAddress), true);
    assert.equal(await context.factory.is_bound(binderAddress), false);
    await expectCustomError(
      () => context.factory.connect(context.binder).bind_arena(binderAddress),
      context.factory,
      "AlreadyBound",
    );
  });

  test("only the bound arena can prepare a validated payout", async () => {
    const context = await fixture();
    const recipientAddress = await context.recipient.getAddress();
    const amount = context.ethers.parseEther("1");

    await expectCustomError(
      () =>
        context.factory
          .connect(context.attacker)
          .prepare("unauthorized", recipientAddress, amount),
      context.factory,
      "OnlyArena",
    );
    await expectCustomError(
      () =>
        context.factory
          .connect(context.arena)
          .prepare("", recipientAddress, amount),
      context.factory,
      "EmptyPayoutId",
    );
    await expectCustomError(
      () =>
        context.factory
          .connect(context.arena)
          .prepare("zero-recipient", context.ethers.ZeroAddress, amount),
      context.factory,
      "ZeroAddress",
    );
    await expectCustomError(
      () =>
        context.factory
          .connect(context.arena)
          .prepare("zero-amount", recipientAddress, 0),
      context.factory,
      "ZeroAmount",
    );
  });

  test("CREATE2 prediction survives hostile pre-seeding without creating credit", async () => {
    const context = await fixture();
    const recipientAddress = await context.recipient.getAddress();
    const payoutId = "preseeded-payout";
    const amount = context.ethers.parseEther("1");
    const preseed = context.ethers.parseEther("0.37");
    const predicted = await context.factory.predict_vault(
      payoutId,
      recipientAddress,
      amount,
    );

    assert.equal(await context.ethers.provider.getCode(predicted), "0x");
    await mine(
      context.attacker.sendTransaction({
        to: predicted,
        value: preseed,
      }),
    );
    assert.equal(await context.ethers.provider.getBalance(predicted), preseed);

    const { actual, vault } = await prepareVault(
      context,
      payoutId,
      recipientAddress,
      amount,
    );
    assert.equal(actual, predicted);
    assert.notEqual(await context.ethers.provider.getCode(actual), "0x");
    assert.equal(await vault.credited(), false);
    assert.equal(await vault.excess_available(), preseed);

    await expectCustomError(
      () =>
        context.attacker.sendTransaction({
          to: actual,
          value: amount,
        }),
      vault,
      "OnlyArena",
    );
    assert.equal(await vault.credited(), false);
    assert.equal(await context.ethers.provider.getBalance(actual), preseed);

    const reserveAddress = await context.reserveSink.getAddress();
    const reserveBefore = await context.ethers.provider.getBalance(reserveAddress);
    await mine(vault.connect(context.operator).recover_excess());
    const reserveAfter = await context.ethers.provider.getBalance(reserveAddress);
    assert.equal(reserveAfter - reserveBefore, preseed);
    assert.equal(await context.ethers.provider.getBalance(actual), 0n);
    assert.equal(await vault.credited(), false);
  });

  test("prepare is exactly idempotent and rejects ID redefinition", async () => {
    const context = await fixture();
    const recipientAddress = await context.recipient.getAddress();
    const otherAddress = await context.other.getAddress();
    const payoutId = "immutable-definition";
    const amount = context.ethers.parseEther("2");
    const { actual } = await prepareVault(
      context,
      payoutId,
      recipientAddress,
      amount,
    );

    await mine(
      context.factory
        .connect(context.arena)
        .prepare(payoutId, recipientAddress, amount),
    );
    assert.equal(await context.factory.vault_of(payoutId), actual);
    assert.equal(
      await context.factory.is_prepared(payoutId, recipientAddress, amount),
      true,
    );
    assert.equal(
      await context.factory.is_prepared(payoutId, otherAddress, amount),
      false,
    );
    await expectCustomError(
      () =>
        context.factory
          .connect(context.arena)
          .prepare(payoutId, otherAddress, amount),
      context.factory,
      "PayoutDefinitionMismatch",
    );
    await expectCustomError(
      () =>
        context.factory
          .connect(context.arena)
          .prepare(payoutId, recipientAddress, amount + 1n),
      context.factory,
      "PayoutDefinitionMismatch",
    );
  });

  test("wrong and duplicate arena dispatches become excess; only first exact value credits", async () => {
    const context = await fixture();
    const recipientAddress = await context.recipient.getAddress();
    const payoutId = "wrong-then-exact";
    const amount = context.ethers.parseEther("1");
    const wrong = context.ethers.parseEther("0.2");
    const { actual, vault } = await prepareVault(
      context,
      payoutId,
      recipientAddress,
      amount,
    );

    await mine(context.arena.sendTransaction({ to: actual, value: wrong }));
    assert.equal(await vault.credited(), false);
    assert.equal(await vault.excess_available(), wrong);

    await mine(context.arena.sendTransaction({ to: actual, value: amount }));
    assert.equal(await vault.credited(), true);
    assert.equal(await vault.locked_principal(), amount);
    assert.equal(
      await context.factory.is_credited(payoutId, recipientAddress, amount),
      true,
    );
    assert.equal(
      await context.factory.is_credited(payoutId, recipientAddress, amount + 1n),
      false,
    );

    await mine(context.arena.sendTransaction({ to: actual, value: amount }));
    assert.equal(await vault.credited(), true);
    assert.equal(await vault.locked_principal(), amount);
    assert.equal(await vault.excess_available(), wrong + amount);
    assert.equal(await vault.totalArenaReceived(), wrong + amount + amount);
  });

  test("only the immutable recipient can withdraw once and the record persists", async () => {
    const context = await fixture();
    const recipientAddress = await context.recipient.getAddress();
    const arenaAddress = await context.arena.getAddress();
    const reserveAddress = await context.reserveSink.getAddress();
    const payoutId = "one-pull-only";
    const amount = context.ethers.parseEther("1.25");
    const idHash = context.ethers.keccak256(context.ethers.toUtf8Bytes(payoutId));
    const { actual, vault } = await prepareVault(
      context,
      payoutId,
      recipientAddress,
      amount,
    );
    await mine(context.arena.sendTransaction({ to: actual, value: amount }));

    await expectCustomError(
      () => vault.connect(context.attacker).withdraw(),
      vault,
      "OnlyRecipient",
    );
    await mine(vault.connect(context.recipient).withdraw());
    assert.equal(await vault.credited(), true);
    assert.equal(await vault.withdrawn(), true);
    assert.equal(await vault.locked_principal(), 0n);
    assert.equal(await context.ethers.provider.getBalance(actual), 0n);
    assert.equal(
      await context.factory.is_withdrawn(payoutId, recipientAddress, amount),
      true,
    );
    await expectCustomError(
      () => vault.connect(context.recipient).withdraw(),
      vault,
      "AlreadyWithdrawn",
    );

    const record = await vault.record();
    assert.equal(record[0], idHash);
    assert.equal(record[1], arenaAddress);
    assert.equal(record[2], recipientAddress);
    assert.equal(record[3], reserveAddress);
    assert.equal(record[4], amount);
    assert.equal(record[5], true);
    assert.equal(record[6], true);
    assert(record[7] > 0n);
    assert(record[8] >= record[7]);
    assert.equal(record[9], 0n);
    assert.equal(record[10], 0n);
    assert.equal(record[11], 0n);
  });

  test("a reverting recipient cannot consume its withdrawal and can retry later", async () => {
    const context = await fixture();
    const hostileRecipient = await deploy(
      context.ethers,
      revertingRecipientArtifact,
      context.attacker,
    );
    const recipientAddress = await hostileRecipient.getAddress();
    const amount = context.ethers.parseEther("0.9");
    const { actual, vault } = await prepareVault(
      context,
      "reverting-recipient",
      recipientAddress,
      amount,
    );
    await mine(context.arena.sendTransaction({ to: actual, value: amount }));

    await expectCustomError(
      () => hostileRecipient.connect(context.attacker).pull(actual),
      vault,
      "NativeTransferFailed",
    );
    assert.equal(await vault.withdrawn(), false);
    assert.equal(await context.ethers.provider.getBalance(actual), amount);

    await mine(hostileRecipient.connect(context.attacker).setRejectNative(false));
    await mine(hostileRecipient.connect(context.attacker).pull(actual));
    assert.equal(await vault.withdrawn(), true);
    assert.equal(await hostileRecipient.received(), amount);
  });

  test("recipient reentrancy cannot produce a second withdrawal", async () => {
    const context = await fixture();
    const reentrantRecipient = await deploy(
      context.ethers,
      reentrantRecipientArtifact,
      context.attacker,
    );
    const recipientAddress = await reentrantRecipient.getAddress();
    const amount = context.ethers.parseEther("1.1");
    const { actual, vault } = await prepareVault(
      context,
      "reentrant-recipient",
      recipientAddress,
      amount,
    );
    await mine(context.arena.sendTransaction({ to: actual, value: amount }));

    await mine(reentrantRecipient.connect(context.attacker).pull(actual));
    assert.equal(await reentrantRecipient.received(), amount);
    assert.equal(await reentrantRecipient.receiveCount(), 1n);
    assert.equal(await reentrantRecipient.reentrySucceeded(), false);
    assert.equal(await vault.withdrawn(), true);
    assert.equal(await context.ethers.provider.getBalance(actual), 0n);
  });

  test("excess recovery is permissionless but can pay only the immutable reserve sink", async () => {
    const context = await fixture();
    const recipientAddress = await context.recipient.getAddress();
    const reserveAddress = await context.reserveSink.getAddress();
    const amount = context.ethers.parseEther("1");
    const wrong = context.ethers.parseEther("0.25");
    const { actual, vault } = await prepareVault(
      context,
      "excess-recovery",
      recipientAddress,
      amount,
    );

    await mine(context.arena.sendTransaction({ to: actual, value: wrong }));
    await mine(context.arena.sendTransaction({ to: actual, value: amount }));
    await mine(context.arena.sendTransaction({ to: actual, value: amount }));
    const expectedExcess = wrong + amount;
    assert.equal(await vault.excess_available(), expectedExcess);
    assert.equal(await vault.locked_principal(), amount);

    const reserveBefore = await context.ethers.provider.getBalance(reserveAddress);
    await mine(vault.connect(context.attacker).recover_excess());
    const reserveAfter = await context.ethers.provider.getBalance(reserveAddress);
    assert.equal(reserveAfter - reserveBefore, expectedExcess);
    assert.equal(await vault.totalExcessRecovered(), expectedExcess);
    assert.equal(await vault.locked_principal(), amount);
    assert.equal(await context.ethers.provider.getBalance(actual), amount);

    await mine(vault.connect(context.recipient).withdraw());
    assert.equal(await context.ethers.provider.getBalance(actual), 0n);
    await expectCustomError(
      () => vault.connect(context.operator).recover_excess(),
      vault,
      "NoExcess",
    );
  });
}
