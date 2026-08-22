import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

import { Wallet, keccak256 } from 'ethers';
import { createAccount, createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { CalldataAddress } from 'genlayer-js/types';

import {
  ACTIVATION_TERMINAL_STAGE,
  BRADBURY_CHAIN_ID,
  BRADBURY_RPC_URL,
  assertExactPauseAccountingIdentity,
  assertExactSchema,
  assertExactPlannedConsensusCalldata,
  assertExactSignedEvmEnvelope,
  assertOwnerLockOwnership,
  assertStateLockOwnership,
  createBradburyReader,
  loadAndValidateBindProof,
  loadConfig,
  loadState,
  readAndVerifyDeployment,
  readAndVerifyPauseState,
  readAndVerifyResumePreSignState,
  reconcileEvmSubmission,
  recordEvmReceiptEvidence,
  recordSignedOperation,
  recordSubmittedOperation,
  resolveKeychainSecretWithFallback,
  sha256,
  signAfterFreshAccountPreflight,
  verifyLocalCandidate,
  verifyFactoryBindOnBradbury,
} from './harness.mjs';

const ADDRESS_PATTERN = /^0x[\da-f]{40}$/i;
const HASH_PATTERN = /^0x[\da-f]{64}$/i;
const MAX_PASSWORD_BYTES = 4_096;
const KEYCHAIN_SERVICE = 'genlayer-cli';

function fail(message) {
  throw new Error(`Bradbury V8 signer refused: ${message}`);
}

function parseArguments(argv) {
  const options = {
    action: null,
    configPath: null,
    statePath: null,
    nonce: null,
    bindProofPath: null,
    broadcast: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const option = args.shift();
    if (option === '--broadcast') options.broadcast = true;
    else if (['--action', '--config', '--state', '--nonce', '--bind-proof'].includes(option)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) fail(`${option} requires a value`);
      if (option === '--action') options.action = value;
      else if (option === '--config') options.configPath = value;
      else if (option === '--state') options.statePath = value;
      else if (option === '--nonce') options.nonce = value;
      else options.bindProofPath = value;
    } else fail(`unknown option ${option}`);
  }
  if (!options.broadcast) fail('the internal signer requires explicit --broadcast');
  if (!['deploy', 'fund', 'activate', 'pause', 'resume'].includes(options.action)) {
    fail('action must be deploy, fund, activate, pause, or resume');
  }
  if (!options.configPath || !options.statePath || !options.nonce) {
    fail('--config, --state, and --nonce are required');
  }
  return options;
}

async function readPasswordFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PASSWORD_BYTES) fail('password input is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function keystoreAddress(raw, field) {
  const address = String(raw || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[\da-f]{40}$/.test(address)) fail(`${field} is malformed`);
  return `0x${address}`;
}

async function loadSigningAccount(config) {
  let privateKey = await resolveKeychainSecretWithFallback(
    async () => {
      const keytarModule = await import('keytar');
      const keychain = keytarModule.default ?? keytarModule;
      if (typeof keychain?.getPassword !== 'function') return null;
      return keychain.getPassword(
        KEYCHAIN_SERVICE,
        `account:${config.ownerAccountName}`,
      );
    },
    async () => {
    let password = await readPasswordFromStdin();
    if (!password) fail(
      `account ${config.ownerAccountName} is locked and no keystore password arrived on stdin`,
    );
    const keystorePath = resolve(
      homedir(),
      '.genlayer',
      'keystores',
      `${config.ownerAccountName}.json`,
    );
    let encrypted;
    let parsed;
    try {
      encrypted = readFileSync(keystorePath, 'utf8');
      parsed = JSON.parse(encrypted);
    } catch {
      fail(`encrypted keystore for ${config.ownerAccountName} could not be read`);
    }
    if ((!parsed.crypto && !parsed.Crypto) || typeof parsed.address !== 'string') {
      fail(`account ${config.ownerAccountName} is not an encrypted Web3 keystore`);
    }
    if (keystoreAddress(parsed.address, 'keystore address') !== config.expected.ownerAddress) {
      fail('encrypted keystore address does not match expected.ownerAddress');
    }
    let wallet;
    try {
      wallet = await Wallet.fromEncryptedJson(encrypted, password);
    } catch {
      fail('encrypted keystore could not be decrypted');
    } finally {
      password = null;
      encrypted = null;
    }
    const decryptedPrivateKey = wallet.privateKey;
    wallet = null;
    return decryptedPrivateKey;
    },
  );
  let account;
  try {
    account = createAccount(privateKey);
  } finally {
    privateKey = null;
  }
  if (!ADDRESS_PATTERN.test(account.address)
    || account.address.toLowerCase() !== config.expected.ownerAddress) {
    fail('loaded signer does not match expected.ownerAddress');
  }
  return account;
}

function calldataAddress(address) {
  if (!ADDRESS_PATTERN.test(address)) fail('constructor address is malformed');
  return new CalldataAddress(Uint8Array.from(Buffer.from(address.slice(2), 'hex')));
}

function assertPinnedNetwork() {
  if (testnetBradbury.id !== BRADBURY_CHAIN_ID
    || testnetBradbury.rpcUrls.default.http[0] !== BRADBURY_RPC_URL
    || testnetBradbury.isStudio !== false
    || testnetBradbury.testnet !== true) {
    fail('pinned SDK chain is not exact Bradbury testnet');
  }
}

function statePreflight(state, action, nonce) {
  const operation = state.operations?.[action];
  if (!operation || operation.status !== 'PREPARED' || operation.nonce !== nonce) {
    fail('durable state does not authorize this exact prepared broadcast');
  }
  const expectedStage = {
    deploy: 'DEPLOY_PREPARED',
    fund: 'RESERVE_FUND_PREPARED',
    activate: 'ACTIVATION_PREPARED',
    pause: 'PAUSE_PREPARED',
    resume: 'RESUME_PREPARED',
  }[action];
  if (state.stage !== expectedStage) fail(`durable state is not ${expectedStage}`);
  if (action === 'deploy' && state.contractAddress !== null) {
    fail('deploy cannot target a state that already has a contract');
  }
  if (action === 'resume' && operation.preparedFromStage !== ACTIVATION_TERMINAL_STAGE) {
    fail('resume PREPARED state is not derived from the exact risk-paused terminal stage');
  }
  if (action !== 'deploy' && !ADDRESS_PATTERN.test(String(state.contractAddress || ''))) {
    fail(`${action} requires the exact recorded contract address`);
  }
}

async function livePreflight({ options, config, state, local, reader }) {
  if (options.action === 'deploy') {
    const schema = await reader.schemaForCode(local.source);
    assertExactSchema(schema);
    return;
  }
  if (['fund', 'activate'].includes(options.action)) {
    const proof = loadAndValidateBindProof(
      options.bindProofPath,
      config,
      state.contractAddress,
    );
    await verifyFactoryBindOnBradbury(reader, proof, config, state.contractAddress);
  }
  if (options.action === 'fund') {
    await readAndVerifyDeployment(reader, state.contractAddress, local, config, {
      payoutsEnabled: false,
      newRiskEnabled: false,
      availableReserveAtto: '0',
    });
  } else if (options.action === 'activate') {
    await readAndVerifyDeployment(reader, state.contractAddress, local, config, {
      payoutsEnabled: false,
      newRiskEnabled: false,
      availableReserveAtto: config.reserve.initialFundingAtto,
    });
  } else if (options.action === 'pause') {
    const current = await readAndVerifyPauseState(
      reader,
      state.contractAddress,
      local,
      config,
      { newRiskEnabled: true },
    );
    assertExactPauseAccountingIdentity(
      state.operations.pause.pauseAccountingIdentity,
      current.accounting,
    );
  } else if (options.action === 'resume') {
    await readAndVerifyResumePreSignState(
      reader,
      state.contractAddress,
      local,
      config,
      state.operations.resume,
    );
  }
}

function withDurablePreSign(account, {
  options,
  config,
  state,
  local,
  statePath,
  reader,
}) {
  const originalSign = account.signTransaction.bind(account);
  return {
    ...account,
    signTransaction: async (transactionRequest, signOptions) => {
      const planned = assertExactPlannedConsensusCalldata(transactionRequest.data, {
        action: options.action,
        config,
        state,
        local,
      });
      const expectedValue = options.action === 'fund'
        ? config.reserve.initialFundingAtto
        : '0';
      const beforeFreshAccountPreflight = options.action === 'resume'
        ? () => readAndVerifyResumePreSignState(
          reader,
          state.contractAddress,
          local,
          config,
          state.operations.resume,
        )
        : undefined;
      // Resume first rechecks its exact durable snapshot. The fresh account
      // gate then detects external-owner activity, pins the SDK nonce, caps
      // spend, and remains the final awaited network work before signing.
      const { signedEvmTransaction, accountPreflight } = await signAfterFreshAccountPreflight({
        reader,
        ownerAddress: config.expected.ownerAddress,
        transactionRequest,
        config,
        expectedValueAtto: expectedValue,
        beforeFreshAccountPreflight,
        signImpl: originalSign,
        signOptions,
      });
      const evmTransactionHash = keccak256(signedEvmTransaction);
      const envelope = assertExactSignedEvmEnvelope({
        signedEvmTransaction,
        evmTransactionHash,
        senderNonce: transactionRequest.nonce,
        ...accountPreflight,
        consensusCalldataSha256: sha256(Buffer.from(planned.data.slice(2), 'hex')),
      }, config);
      if (envelope.value.toString() !== expectedValue) {
        fail('signed outer EVM value does not match the exact operation plan');
      }
      if (envelope.data.toLowerCase() !== planned.data) {
        fail('signed outer EVM calldata differs from the exact reviewed operation');
      }
      const current = loadState(statePath, config);
      recordSignedOperation(statePath, current, options.action, options.nonce, {
        signedEvmTransaction,
        evmTransactionHash,
        senderNonce: transactionRequest.nonce,
        ...accountPreflight,
      });
      // The SDK cannot call eth_sendRawTransaction until this exact signed
      // payload and its deterministic EVM hash are durable on disk.
      return signedEvmTransaction;
    },
  };
}

async function broadcast(signingClient, action, state, local, config) {
  if (action === 'deploy') {
    return signingClient.deployContract({
      code: local.source,
      args: [
        calldataAddress(config.expected.treasuryAddress),
        calldataAddress(config.expected.keeperAddress),
        BigInt(config.expected.epochMinStakeAtto),
        BigInt(config.expected.epochMaxStakePerWalletAtto),
        calldataAddress(config.expected.payoutFactoryAddress),
      ],
      leaderOnly: false,
    });
  }
  const method = {
    fund: 'fund_delivery_reserve',
    activate: 'activate_payouts',
    pause: 'pause_new_risk',
    resume: 'resume_new_risk',
  }[action];
  return signingClient.writeContract({
    address: state.contractAddress,
    functionName: method,
    args: [],
    value: action === 'fund' ? BigInt(config.reserve.initialFundingAtto) : 0n,
    leaderOnly: false,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const lockToken = process.env.BRADBURY_V8_LOCK_TOKEN || '';
  const ownerLockToken = process.env.BRADBURY_V8_OWNER_LOCK_TOKEN || '';
  delete process.env.BRADBURY_V8_LOCK_TOKEN;
  delete process.env.BRADBURY_V8_OWNER_LOCK_TOKEN;
  assertPinnedNetwork();
  const loaded = loadConfig(options.configPath);
  const config = loaded.config;
  assertOwnerLockOwnership(config, ownerLockToken);
  assertStateLockOwnership(resolve(options.statePath), lockToken);
  const statePath = resolve(options.statePath);
  let state = loadState(statePath, config);
  statePreflight(state, options.action, options.nonce);
  const local = verifyLocalCandidate(config);
  const reader = createBradburyReader();
  await livePreflight({ options, config, state, local, reader });

  const baseAccount = await loadSigningAccount(config);
  const signingAccount = withDurablePreSign(baseAccount, {
    options,
    config,
    state,
    local,
    statePath,
    reader,
  });
  const signingClient = createClient({ chain: testnetBradbury, account: signingAccount });
  const transactionHash = await broadcast(
    signingClient,
    options.action,
    state,
    local,
    config,
  );
  if (!HASH_PATTERN.test(String(transactionHash || ''))) {
    fail('Bradbury SDK did not return an exact GenLayer transaction hash');
  }
  state = loadState(statePath, config);
  const operation = state.operations[options.action];
  const evidence = await reconcileEvmSubmission({
    reader,
    operation,
    config,
    action: options.action,
    state,
    local,
    broadcast: false,
  });
  if (!evidence) fail('the exact signed EVM transaction receipt is not inspectable');
  if (evidence.genlayerTransactionHash !== transactionHash.toLowerCase()) {
    fail('SDK GenLayer transaction id does not match the exact Bradbury EVM event');
  }
  state = recordEvmReceiptEvidence(
    statePath,
    state,
    options.action,
    options.nonce,
    evidence,
  );
  recordSubmittedOperation(
    statePath,
    state,
    options.action,
    options.nonce,
    evidence.genlayerTransactionHash,
  );
  process.stdout.write(`${JSON.stringify({
    event: 'BRADBURY_V8_TRANSACTION_SUBMITTED',
    action: options.action,
    nonce: options.nonce,
    transactionHash: transactionHash.toLowerCase(),
    signer: config.expected.ownerAddress,
    chainId: BRADBURY_CHAIN_ID,
  })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error && (
    error.message.startsWith('Bradbury V8 signer refused:')
      || error.message.startsWith('Bradbury V8 harness refused:')
  )
    ? error.message
    : 'Bradbury V8 signer refused: signing or broadcast failed; inspect the protected operational state and reconcile the exact pre-signed EVM hash';
  process.stderr.write(`${JSON.stringify({
    event: 'BRADBURY_V8_SIGNER_REFUSED',
    message,
  })}\n`);
  process.exitCode = 1;
});
