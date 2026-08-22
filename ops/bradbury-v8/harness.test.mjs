import assert from 'node:assert/strict';
import {
  closeSync, existsSync, fsyncSync, mkdtempSync, mkdirSync, openSync, readFileSync,
  renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Interface, Wallet, getBytes, id, keccak256 } from 'ethers';
import { abi as genlayerAbi } from 'genlayer-js';
import { CalldataAddress } from 'genlayer-js/types';

import {
  BRADBURY_ALIAS,
  BRADBURY_CHAIN_ID,
  BRADBURY_CONSENSUS_ADDRESS,
  BIND_REQUEST_SCHEMA,
  ACTIVATION_TERMINAL_STAGE,
  MAX_BRADBURY_DEPLOY_SOURCE_BYTES,
  MAX_BRADBURY_OUTER_CALLDATA_BYTES,
  MAX_TRANSACTION_GAS_COST_ATTO,
  NEW_TRANSACTION_TOPIC,
  EXPECTED_V8_SCHEMA,
  EXPECTED_V8_SCHEMA_SHA256,
  PAYOUT_PROTOCOL_VERSION,
  V8_POLICY_VERSION,
  V8_PROTOCOL_VERSION,
  assertExactCallReceipt,
  assertExactConfigReadback,
  assertExactDeploymentReceipt,
  assertExactEvmSubmissionReceipt,
  assertExactPauseAccountingIdentity,
  assertExactPlannedConsensusCalldata,
  assertExactReserveReadback,
  assertExactSchema,
  assertExactSignedEvmEnvelope,
  assertSuccessfulFinalizedReceipt,
  assertFreshSignerAccountPreflight,
  assertLiveAccountingIdentity,
  assertPauseAccountingContinuity,
  assertProtectedOperationalPath,
  activationTerminalReadback,
  acquireOwnerLock,
  acquireStateLock,
  buildExpectedConfigReadback,
  buildExpectedReserveReadback,
  bindRequestPathFor,
  ensureBindRequestArtifact,
  loadState,
  newState,
  normalizeConfig,
  normalizePauseAccountingIdentity,
  operationalEvidenceRoot,
  prepareOperation,
  reconcileEvmSubmission,
  readAndVerifyPauseState,
  recordEvmReceiptEvidence,
  recordSignedOperation,
  recordSubmittedOperation,
  resolveKeychainSecretWithFallback,
  sha256,
  signAfterFreshAccountPreflight,
  stateLockPathFor,
  statePathFor,
  helpText,
  validateBindRequestArtifact,
  verifyLocalCandidate,
  verifyFactoryBindOnBradbury,
  writeStateAtomic,
} from './harness.mjs';

const OWNER = `0x${'11'.repeat(20)}`;
const KEEPER = `0x${'22'.repeat(20)}`;
const TREASURY = `0x${'33'.repeat(20)}`;
const FACTORY = `0x${'44'.repeat(20)}`;
const BINDER = OWNER;
const OTHER_BINDER = `0x${'55'.repeat(20)}`;
const SINK = `0x${'66'.repeat(20)}`;
const CONTRACT = `0x${'77'.repeat(20)}`;
const GEN_HASH = `0x${'ab'.repeat(32)}`;
const EVM_HASH = `0x${'cd'.repeat(32)}`;
const BYTECODE_HASH = 'ef'.repeat(32);
const SOURCE_HASH = '12'.repeat(32);
const BLOCK_HASH = `0x${'de'.repeat(32)}`;
const REPLAY_WALLET = new Wallet(`0x${'01'.repeat(32)}`);
const ADD_TRANSACTION_INTERFACE = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);
const FACTORY_INTERFACE = new Interface([
  'function binder() view returns (address)',
  'function reserveSink() view returns (address)',
  'function arena() view returns (address)',
  'function protocol_version() view returns (string)',
  'function bind_arena(address arenaGhost)',
  'event ArenaBound(address indexed arena)',
]);

function rawConfig(overrides = {}) {
  const result = {
    version: 1,
    network: BRADBURY_ALIAS,
    chainId: BRADBURY_CHAIN_ID,
    sourcePath: 'contracts/LiquidityArenaV8.release.py',
    sourceSha256: SOURCE_HASH,
    schemaSha256: EXPECTED_V8_SCHEMA_SHA256,
    ownerAccountName: 'bradbury-owner',
    expected: {
      ownerAddress: OWNER,
      keeperAddress: KEEPER,
      treasuryAddress: TREASURY,
      payoutFactoryAddress: FACTORY,
      factoryBinderAddress: BINDER,
      reserveSinkAddress: SINK,
      factoryRuntimeBytecodeSha256: BYTECODE_HASH,
      protocolVersion: V8_PROTOCOL_VERSION,
      policyVersion: V8_POLICY_VERSION,
      payoutProtocolVersion: PAYOUT_PROTOCOL_VERSION,
      epochMinStakeAtto: '100000000000000000',
      epochMaxStakePerWalletAtto: '10000000000000000000',
      platformFeeBps: 200,
    },
    reserve: { initialFundingAtto: '3000000000000000000' },
    operator: {
      finalityRetries: 900,
      finalityIntervalMs: 5000,
      maxEvmGasLimit: '30000000',
      maxEvmGasPriceWei: '1000000000',
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'expected') result.expected = { ...result.expected, ...value };
    else if (key === 'reserve') result.reserve = { ...result.reserve, ...value };
    else if (key === 'operator') result.operator = { ...result.operator, ...value };
    else result[key] = value;
  }
  return result;
}

function liveAccountingIdentity(config, {
  newRiskEnabled = true,
  availableReserveAtto = '1000',
  committedReserveAtto = '600',
  epochCount = 4,
  payoutCount = 3,
} = {}) {
  return assertLiveAccountingIdentity({
    reserveReadback: {
      treasury: config.expected.treasuryAddress,
      current_platform_fee_bps: 200,
      payout_protocol_version: PAYOUT_PROTOCOL_VERSION,
      payouts_enabled: true,
      new_risk_enabled: newRiskEnabled,
      player_liability_atto: '100',
      accrued_platform_fees_atto: '10',
      reserved_platform_fees_atto: '20',
      funded_platform_fees_atto: '30',
      withdrawn_platform_fees_atto: '5',
      available_reserve_atto: availableReserveAtto,
      committed_reserve_atto: committedReserveAtto,
      required_available_reserve_atto: '210',
      reserved_player_payouts_atto: '40',
      max_payout_attempts: 3,
      prepare_retries_capped: false,
      retry_delay_seconds: 3600,
    },
    epochPage: accountingPage('epoch_ids', epochCount),
    payoutPage: accountingPage('payouts', payoutCount),
  }, config, { newRiskEnabled });
}

function accountingPage(itemsField, total) {
  const count = BigInt(total);
  return {
    offset: 0,
    next_offset: count === 0n ? 0 : 1,
    total,
    [itemsField]: count === 0n ? [] : [itemsField === 'epoch_ids' ? '1' : {}],
  };
}

function pauseReadbackReader(config, source, accounting, extra = {}) {
  const calls = {
    get_config: buildExpectedConfigReadback(config, {
      payoutsEnabled: true,
      newRiskEnabled: accounting.reserve.new_risk_enabled,
    }),
    get_delivery_reserve_state: accounting.reserve,
    get_epoch_page: accountingPage('epoch_ids', accounting.epochCount),
    get_payout_page: accountingPage('payouts', accounting.payoutCount),
  };
  return {
    code: async () => source,
    schema: async () => EXPECTED_V8_SCHEMA,
    call: async (_address, method) => calls[method],
    ...extra,
  };
}

function finalizedReceipt(overrides = {}) {
  return {
    hash: GEN_HASH,
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    sender: OWNER,
    recipient: CONTRACT,
    value: '0',
    txDataDecoded: {
      type: 'call',
      callData: { method: 'pause_new_risk', args: [] },
      leaderOnly: false,
    },
    ...overrides,
  };
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function evmSubmissionReceipt(evmTransactionHash, overrides = {}) {
  const log = {
    address: BRADBURY_CONSENSUS_ADDRESS,
    topics: [
      NEW_TRANSACTION_TOPIC,
      GEN_HASH,
      addressTopic(CONTRACT),
      addressTopic(OWNER),
    ],
    data: '0x',
    transactionHash: evmTransactionHash,
    blockHash: BLOCK_HASH,
    blockNumber: '0x2a',
    logIndex: '0x0',
  };
  return {
    transactionHash: evmTransactionHash,
    status: '0x1',
    blockHash: BLOCK_HASH,
    blockNumber: '0x2a',
    logs: [log],
    ...overrides,
  };
}

async function signedReplayFixture(value = 0n, validUntilOverride) {
  const local = { source: 'reviewed-v8-source\n' };
  const config = normalizeConfig(rawConfig({
    sourceSha256: sha256(local.source),
    expected: {
      ownerAddress: REPLAY_WALLET.address,
      factoryBinderAddress: REPLAY_WALLET.address,
    },
    operator: { finalityRetries: 2, finalityIntervalMs: 100 },
  }));
  const action = 'pause';
  const state = { contractAddress: CONTRACT };
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const data = outerAddTransaction({
    action,
    config,
    source: local.source,
    overrides: {
      validUntil: validUntilOverride ?? BigInt(nowSeconds + 3_600),
    },
  });
  const signedEvmTransaction = await REPLAY_WALLET.signTransaction({
    chainId: BRADBURY_CHAIN_ID,
    type: 0,
    to: BRADBURY_CONSENSUS_ADDRESS,
    nonce: 7,
    gasLimit: 200_000,
    gasPrice: 1,
    value,
    data,
  });
  const pauseAccountingIdentity = liveAccountingIdentity(config, { newRiskEnabled: true });
  return {
    config,
    action,
    state,
    local,
    operation: {
      status: 'SIGNED',
      nonce: 'operation-nonce',
      signedEvmTransaction,
      evmTransactionHash: keccak256(signedEvmTransaction),
      senderNonce: '7',
      ownerNonceLatestAtSign: '7',
      ownerNoncePendingAtSign: '7',
      ownerPendingBalanceAtSign: '10000000000000000000',
      maximumTransactionCostAtSign: (value + 200_000n).toString(),
      consensusCalldataSha256: sha256(Buffer.from(data.slice(2), 'hex')),
      pauseAccountingIdentity,
      transactionHash: null,
    },
  };
}

function calldataAddress(address) {
  return new CalldataAddress(getBytes(address));
}

function plannedInnerData(action, config, source, overrides = {}) {
  const leaderOnly = overrides.leaderOnly ?? false;
  if (action === 'deploy') {
    return genlayerAbi.transactions.serialize([
      overrides.source ?? source,
      genlayerAbi.calldata.encode(genlayerAbi.calldata.makeCalldataObject(undefined, [
        calldataAddress(config.expected.treasuryAddress),
        calldataAddress(config.expected.keeperAddress),
        BigInt(config.expected.epochMinStakeAtto),
        BigInt(config.expected.epochMaxStakePerWalletAtto),
        calldataAddress(config.expected.payoutFactoryAddress),
      ], undefined)),
      leaderOnly,
    ]);
  }
  const method = overrides.method ?? {
    fund: 'fund_delivery_reserve',
    activate: 'activate_payouts',
    pause: 'pause_new_risk',
  }[action];
  return genlayerAbi.transactions.serialize([
    genlayerAbi.calldata.encode(genlayerAbi.calldata.makeCalldataObject(method, [], undefined)),
    leaderOnly,
  ]);
}

function outerAddTransaction({ action, config, source, overrides = {} }) {
  const recipient = action === 'deploy' ? `0x${'0'.repeat(40)}` : CONTRACT;
  return ADD_TRANSACTION_INTERFACE.encodeFunctionData('addTransaction', [
    config.expected.ownerAddress,
    recipient,
    5n,
    3n,
    plannedInnerData(action, config, source, overrides),
    overrides.validUntil ?? 4_600n,
  ]);
}

test('configuration requires exact Bradbury, explicit roles, factory, source, and schema hashes', () => {
  const config = normalizeConfig(rawConfig());
  assert.equal(config.network, 'testnet-bradbury');
  assert.equal(config.chainId, 4221);
  assert.equal(config.expected.payoutFactoryAddress, FACTORY);
  assert.equal(config.expected.ownerAddress, OWNER);
  assert.equal(config.expected.factoryBinderAddress, OWNER);
  assert.equal(config.reserve.initialFundingAtto, '3000000000000000000');

  for (const [label, change, pattern] of [
    ['network', { network: 'studionet' }, /network must be exactly testnet-bradbury/i],
    ['chain', { chainId: 61999 }, /chainId/i],
    ['source hash', { sourceSha256: 'pending' }, /sourceSha256/i],
    ['schema hash', { schemaSha256: '00'.repeat(32) }, /schemaSha256/i],
    ['zero factory', { expected: { payoutFactoryAddress: `0x${'0'.repeat(40)}` } }, /nonzero/i],
    ['implicit owner', { expected: { ownerAddress: '' } }, /ownerAddress is required/i],
    ['owner/binder mismatch', { expected: { factoryBinderAddress: OTHER_BINDER } }, /must be the same reviewed EOA/i],
    ['zero funding', { reserve: { initialFundingAtto: '0' } }, /must be positive/i],
    ['gas product', { operator: { maxEvmGasPriceWei: '1000000001' } }, /hard 0\.03 GEN/i],
    ['unknown field', { surprise: true }, /unknown fields/i],
  ]) {
    assert.throws(() => normalizeConfig(rawConfig(change)), pattern, label);
  }
  assert.equal(
    BigInt(config.operator.maxEvmGasLimit) * BigInt(config.operator.maxEvmGasPriceWei),
    MAX_TRANSACTION_GAS_COST_ATTO,
  );
});

test('an unavailable headless keychain silently uses the encrypted-keystore fallback', async () => {
  const signerSource = readFileSync(
    new URL('./signer-child.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(signerSource, /^import\s+keytar\s+from\s+['"]keytar['"];?$/m);
  assert.match(signerSource, /await import\(['"]keytar['"]\)/);

  let fallbackReads = 0;
  const secret = await resolveKeychainSecretWithFallback(
    async () => { throw new Error('Secret Service backend leaked detail'); },
    async () => {
      fallbackReads += 1;
      return 'injected-encrypted-keystore-key';
    },
  );
  assert.equal(secret, 'injected-encrypted-keystore-key');
  assert.equal(fallbackReads, 1);

  let rejection;
  try {
    await resolveKeychainSecretWithFallback(
      async () => { throw new Error('Secret Service backend leaked detail'); },
      async () => { throw new Error('generic encrypted-keystore refusal'); },
    );
  } catch (error) {
    rejection = error;
  }
  assert.match(rejection?.message ?? '', /generic encrypted-keystore refusal/i);
  assert.doesNotMatch(rejection?.message ?? '', /Secret Service backend leaked detail/i);
});

test('fresh signing requires a quiescent exact nonce and sufficient pending balance', async () => {
  const config = normalizeConfig(rawConfig());
  const gasLimit = 200_000n;
  const gasPrice = 1_000_000_000n;
  const maximumCost = gasLimit * gasPrice;
  const transactionRequest = {
    nonce: 7,
    gas: gasLimit,
    gasPrice,
    value: 0n,
    to: BRADBURY_CONSENSUS_ADDRESS,
    data: '0x1234',
  };
  const readerFor = ({
    latest = '0x7', pending = '0x7', balance = maximumCost,
    estimate = gasLimit, estimateError = false,
  } = {}) => ({
    evmRequest: async (method, params) => {
      if (method === 'eth_estimateGas') {
        assert.deepEqual(params, [{
          from: OWNER,
          to: BRADBURY_CONSENSUS_ADDRESS,
          data: transactionRequest.data,
          value: '0x0',
        }]);
        if (estimateError) throw new Error('BlockPubdataLimitReached');
        return `0x${BigInt(estimate).toString(16)}`;
      }
      assert.equal(params[0], OWNER);
      if (method === 'eth_getTransactionCount' && params[1] === 'latest') return latest;
      if (method === 'eth_getTransactionCount' && params[1] === 'pending') return pending;
      if (method === 'eth_getBalance' && params[1] === 'pending') {
        return `0x${BigInt(balance).toString(16)}`;
      }
      throw new Error('unexpected account preflight request');
    },
  });

  let signs = 0;
  const exact = await signAfterFreshAccountPreflight({
    reader: readerFor(),
    ownerAddress: OWNER,
    transactionRequest,
    config,
    expectedValueAtto: '0',
    signImpl: async () => { signs += 1; return '0xsigned'; },
  });
  assert.equal(signs, 1);
  assert.equal(exact.accountPreflight.senderNonce, '7');
  assert.equal(exact.accountPreflight.ownerNonceLatestAtSign, '7');
  assert.equal(exact.accountPreflight.ownerNoncePendingAtSign, '7');
  assert.equal(exact.accountPreflight.maximumTransactionCostAtSign, maximumCost.toString());
  assert.deepEqual(exact.gasEstimate, { gas: gasLimit.toString(), calldataBytes: 2 });

  for (const [label, reader, request, pattern] of [
    ['Bradbury estimate failure', readerFor({ estimateError: true }), transactionRequest, /200,000 fallback is prohibited/i],
    ['SDK fallback/drift', readerFor({ estimate: gasLimit - 1n }), transactionRequest, /does not exactly match/i],
    ['pending owner transaction', readerFor({ pending: '0x8' }), transactionRequest, /pending EVM transaction/i],
    ['SDK nonce drift', readerFor(), { ...transactionRequest, nonce: 8 }, /nonce does not equal/i],
    ['insufficient balance', readerFor({ balance: maximumCost - 1n }), transactionRequest, /balance cannot cover/i],
    ['conflicting gas aliases', readerFor(), { ...transactionRequest, gasLimit: gasLimit + 1n }, /gas and gasLimit conflict/i],
  ]) {
    signs = 0;
    await assert.rejects(() => signAfterFreshAccountPreflight({
      reader,
      ownerAddress: OWNER,
      transactionRequest: request,
      config,
      expectedValueAtto: '0',
      signImpl: async () => { signs += 1; return '0xmust-not-sign'; },
    }), pattern, label);
    assert.equal(signs, 0, `${label} must perform zero signatures`);
  }
});

test('signed envelope independently enforces the hard 0.03 GEN gas ceiling', async () => {
  const reviewed = normalizeConfig(rawConfig({
    expected: {
      ownerAddress: REPLAY_WALLET.address,
      factoryBinderAddress: REPLAY_WALLET.address,
    },
  }));
  const unsafeCaps = {
    ...reviewed,
    operator: {
      ...reviewed.operator,
      maxEvmGasLimit: '100000000',
      maxEvmGasPriceWei: '1000000000',
    },
  };
  const data = outerAddTransaction({
    action: 'pause',
    config: reviewed,
    source: 'reviewed-v8-source\n',
  });
  const signedEvmTransaction = await REPLAY_WALLET.signTransaction({
    chainId: BRADBURY_CHAIN_ID,
    type: 0,
    to: BRADBURY_CONSENSUS_ADDRESS,
    nonce: 7,
    gasLimit: 30_000_001n,
    gasPrice: 1_000_000_000n,
    value: 0,
    data,
  });
  assert.throws(() => assertExactSignedEvmEnvelope({
    signedEvmTransaction,
    evmTransactionHash: keccak256(signedEvmTransaction),
    senderNonce: '7',
    ownerNonceLatestAtSign: '7',
    ownerNoncePendingAtSign: '7',
    consensusCalldataSha256: sha256(Buffer.from(data.slice(2), 'hex')),
  }, unsafeCaps), /fee caps/i);
});

test('activation enables payout rails while risk stays paused and no resume command exists', () => {
  const config = normalizeConfig(rawConfig());
  assert.equal(ACTIVATION_TERMINAL_STAGE, 'PAYOUTS_ACTIVE_RISK_PAUSED');
  assert.deepEqual(activationTerminalReadback(config), {
    payoutsEnabled: true,
    newRiskEnabled: false,
    availableReserveAtto: config.reserve.initialFundingAtto,
  });
  const help = helpText();
  assert.match(help, /harness\.mjs activate --config/i);
  assert.doesNotMatch(help, /activate-pause/i);
  assert.doesNotMatch(help, /harness\.mjs resume/i);

  const source = readFileSync(
    new URL('../../contracts/LiquidityArenaV8.release.py', import.meta.url),
  );
  const example = JSON.parse(readFileSync(
    new URL('./config.example.json', import.meta.url),
    'utf8',
  ));
  assert.equal(sha256(source), example.sourceSha256);
  const activation = source.toString('utf8').match(
    /def activate_payouts\(self\).*?(?=\n\s*@gl\.public\.write)/s,
  )?.[0];
  assert.ok(activation, 'activate_payouts source block');
  assert.match(activation, /self\.payouts_enabled=True/);
  assert.match(activation, /self\.new_risk_enabled=False/);
  assert.doesNotMatch(activation, /self\.new_risk_enabled=True/);
});

test('finalized deployment bind request is strict, sanitized, and atomically create-once', () => {
  const config = normalizeConfig(rawConfig());
  const local = { sourceHash: SOURCE_HASH };
  const operation = {
    status: 'SUBMITTED',
    transactionHash: GEN_HASH,
    evmTransactionHash: EVM_HASH,
    evmReceiptBlockHash: BLOCK_HASH,
    evmReceiptBlockNumber: '0x2a',
    // This replayable evidence is deliberately present on state but must not
    // cross the sanitized bind-request boundary.
    signedEvmTransaction: `0x${'99'.repeat(128)}`,
  };
  const expected = { config, local, operation, arenaAddress: CONTRACT };
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-bind-request-'));
  const statePath = join(root, 'state.json');

  const first = ensureBindRequestArtifact(statePath, expected);
  assert.equal(first.created, true);
  assert.equal(first.artifactPath, bindRequestPathFor(statePath));
  assert.equal(first.artifact.schema, BIND_REQUEST_SCHEMA);
  assert.equal(first.artifact.deploymentGenLayerReceiptStatus, 'FINALIZED');
  assert.equal(first.artifact.deploymentGenLayerExecutionResult, 'FINISHED_WITH_RETURN');
  assert.equal(first.artifact.deploymentGenLayerExecutionSuccess, true);
  assert.equal(first.artifact.deploymentEvmFinalityVerified, false);
  assert.equal(first.artifact.deploymentEvmFinalityRequiredBeforeBind, true);
  assert.equal(first.artifact.ownerAddress, OWNER);
  assert.equal(first.artifact.factoryAddress, FACTORY);
  assert.equal(first.artifact.constructorArguments.payoutFactoryAddress, FACTORY);
  assert.equal(first.artifact.exactDeploymentReadback, true);
  assert.equal(first.artifact.cutsOverApplication, false);
  assert.equal(first.artifact.cutsOverDatabase, false);
  const publishedSchema = JSON.parse(readFileSync(
    new URL('./bind-request.schema.json', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(
    [...publishedSchema.required].sort(),
    Object.keys(first.artifact).sort(),
  );
  for (const [field, definition] of Object.entries(publishedSchema.properties)) {
    if (Object.hasOwn(definition, 'const')) {
      assert.deepEqual(first.artifact[field], definition.const, `${field} schema constant`);
    }
  }
  const persisted = readFileSync(first.artifactPath, 'utf8');
  assert.equal(persisted.includes(operation.signedEvmTransaction), false);
  assert.equal(persisted.includes('signedEvmTransaction'), false);
  assert.equal(existsSync(`${first.artifactPath}.tmp`), false);

  const second = ensureBindRequestArtifact(statePath, expected);
  assert.equal(second.created, false);
  assert.equal(readFileSync(first.artifactPath, 'utf8'), persisted);
  assert.deepEqual(second.artifact, first.artifact);

  for (const mutate of [
    (artifact) => { artifact.sourceSha256 = '00'.repeat(32); },
    (artifact) => { artifact.configFingerprint = '00'.repeat(32); },
    (artifact) => { artifact.deploymentGenLayerTransactionHash = EVM_HASH; },
    (artifact) => { artifact.deploymentGenLayerReceiptStatus = 'ACCEPTED'; },
    (artifact) => { artifact.deploymentGenLayerExecutionSuccess = false; },
    (artifact) => { artifact.deploymentEvmFinalityVerified = true; },
    (artifact) => { artifact.deploymentEvmFinalityRequiredBeforeBind = false; },
    (artifact) => { artifact.ownerAddress = KEEPER; },
    (artifact) => { artifact.factoryAddress = TREASURY; },
    (artifact) => { artifact.arenaAddress = TREASURY; },
    (artifact) => { artifact.constructorArguments.keeperAddress = OWNER; },
    (artifact) => { artifact.unreviewed = true; },
  ]) {
    const changed = structuredClone(first.artifact);
    mutate(changed);
    assert.throws(
      () => validateBindRequestArtifact(changed, expected),
      /bind request|sanitized finalized V8 bind request/i,
    );
  }
});

test('delegated bind proof is independently reverified from finalized Bradbury EVM state', async () => {
  const runtimeCode = '0x6001600055';
  const config = normalizeConfig(rawConfig({
    expected: { factoryRuntimeBytecodeSha256: sha256(Buffer.from(runtimeCode.slice(2), 'hex')) },
  }));
  const bindHash = GEN_HASH;
  const bindBlockHash = BLOCK_HASH;
  const bindInput = FACTORY_INTERFACE.encodeFunctionData('bind_arena', [CONTRACT]);
  const arenaBoundTopic = id('ArenaBound(address)').toLowerCase();
  const receipt = {
    transactionHash: bindHash,
    status: '0x1',
    from: BINDER,
    to: FACTORY,
    blockHash: bindBlockHash,
    blockNumber: '0x20',
    logs: [{
      address: FACTORY,
      topics: [arenaBoundTopic, addressTopic(CONTRACT)],
      data: '0x',
      transactionHash: bindHash,
      blockHash: bindBlockHash,
      blockNumber: '0x20',
    }],
  };
  const transaction = {
    hash: bindHash,
    from: BINDER,
    to: FACTORY,
    blockHash: bindBlockHash,
    blockNumber: '0x20',
    chainId: '0x107d',
    value: '0x0',
    input: bindInput,
  };
  const responses = new Map([
    ['eth_getTransactionReceipt', receipt],
    ['eth_getTransactionByHash', transaction],
    ['finalized', { number: '0x30', hash: `0x${'f0'.repeat(32)}` }],
    ['0x20', { number: '0x20', hash: bindBlockHash }],
    ['eth_getCode', runtimeCode],
    ['binder', FACTORY_INTERFACE.encodeFunctionResult('binder', [BINDER])],
    ['reserveSink', FACTORY_INTERFACE.encodeFunctionResult('reserveSink', [SINK])],
    ['arena', FACTORY_INTERFACE.encodeFunctionResult('arena', [CONTRACT])],
    ['protocol_version', FACTORY_INTERFACE.encodeFunctionResult(
      'protocol_version',
      [PAYOUT_PROTOCOL_VERSION],
    )],
  ]);
  const reader = {
    evmRequest: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return responses.get(params[0]);
      if (method === 'eth_call') {
        const parsed = FACTORY_INTERFACE.parseTransaction({ data: params[0].data });
        return responses.get(parsed.name);
      }
      return responses.get(method);
    },
  };
  const proof = { bindTransactionHash: bindHash };
  const exact = await verifyFactoryBindOnBradbury(reader, proof, config, CONTRACT);
  assert.equal(exact.arena, CONTRACT);
  assert.equal(exact.factoryRuntimeBytecodeSha256, config.expected.factoryRuntimeBytecodeSha256);

  responses.set('eth_getCode', '0x6000');
  await assert.rejects(
    () => verifyFactoryBindOnBradbury(reader, proof, config, CONTRACT),
    /runtime bytecode SHA-256/i,
  );
  responses.set('eth_getCode', runtimeCode);
  responses.set('arena', FACTORY_INTERFACE.encodeFunctionResult('arena', [OWNER]));
  await assert.rejects(
    () => verifyFactoryBindOnBradbury(reader, proof, config, CONTRACT),
    /roles, arena, or protocol/i,
  );
});

test('local source gate requires the exact configured hash, Bradbury allowlist, and literal factory anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-source-'));
  mkdirSync(join(root, 'contracts'));
  const source = `SUPPORTED_ESCROW_CHAIN_IDS = (4_221,)\nAUDITED_PAYOUT_FACTORY_4221 = "${FACTORY}"\n`;
  writeFileSync(join(root, 'contracts', 'LiquidityArenaV8.release.py'), source);
  const config = normalizeConfig(rawConfig({ sourceSha256: sha256(source) }));
  assert.equal(verifyLocalCandidate(config, { projectRoot: root }).source, source);

  const oversized = `${source}${'#'.repeat(MAX_BRADBURY_DEPLOY_SOURCE_BYTES)}`;
  writeFileSync(join(root, 'contracts', 'LiquidityArenaV8.release.py'), oversized);
  const oversizedConfig = normalizeConfig(rawConfig({ sourceSha256: sha256(oversized) }));
  assert.throws(
    () => verifyLocalCandidate(oversizedConfig, { projectRoot: root }),
    /Bradbury deploy artifacts must be at most 45000 bytes/i,
  );

  const zeroAnchor = source.replace(`"${FACTORY}"`, 'ZERO_ADDRESS_TEXT');
  writeFileSync(join(root, 'contracts', 'LiquidityArenaV8.release.py'), zeroAnchor);
  const zeroConfig = normalizeConfig(rawConfig({ sourceSha256: sha256(zeroAnchor) }));
  assert.throws(
    () => verifyLocalCandidate(zeroConfig, { projectRoot: root }),
    /zero-address release candidate cannot be broadcast/i,
  );
});

test('schema readback is exhaustive and rejects an added, removed, or changed method', () => {
  assert.equal(Object.keys(EXPECTED_V8_SCHEMA.methods).length, 25);
  assert.doesNotThrow(() => assertExactSchema(structuredClone(EXPECTED_V8_SCHEMA)));
  const added = structuredClone(EXPECTED_V8_SCHEMA);
  added.methods.force_funded = { params: [], kwparams: {}, readonly: false, ret: 'null', payable: false };
  assert.throws(() => assertExactSchema(added), /schema readback/i);
  const changed = structuredClone(EXPECTED_V8_SCHEMA);
  changed.methods.fund_delivery_reserve.payable = false;
  assert.throws(() => assertExactSchema(changed), /schema readback/i);
  const removed = structuredClone(EXPECTED_V8_SCHEMA);
  delete removed.methods.pause_new_risk;
  assert.throws(() => assertExactSchema(removed), /schema readback/i);
});

test('pre-sign gate proves exact addTransaction source, method, and full-consensus bytes', () => {
  const config = normalizeConfig(rawConfig());
  const local = { source: 'reviewed-v8-source\n' };
  const state = { contractAddress: CONTRACT };
  const exactPause = outerAddTransaction({ action: 'pause', config, source: local.source });
  assert.doesNotThrow(() => assertExactPlannedConsensusCalldata(exactPause, {
    action: 'pause', config, state, local, nowSeconds: 1_000,
  }));
  const exactDeploy = outerAddTransaction({ action: 'deploy', config, source: local.source });
  assert.doesNotThrow(() => assertExactPlannedConsensusCalldata(exactDeploy, {
    action: 'deploy', config, state: { contractAddress: null }, local, nowSeconds: 1_000,
  }));
  assert.ok((exactDeploy.length - 2) / 2 < MAX_BRADBURY_OUTER_CALLDATA_BYTES);

  const sourceCeilingOverflow = 'x'.repeat(MAX_BRADBURY_DEPLOY_SOURCE_BYTES + 1);
  const sourceCeilingData = outerAddTransaction({
    action: 'deploy', config, source: sourceCeilingOverflow,
  });
  assert.throws(() => assertExactPlannedConsensusCalldata(sourceCeilingData, {
    action: 'deploy',
    config,
    state: { contractAddress: null },
    local: { source: sourceCeilingOverflow },
    nowSeconds: 1_000,
  }), /planned V8 source.*Bradbury ceiling/i);

  const calldataCeilingOverflow = 'x'.repeat(MAX_BRADBURY_OUTER_CALLDATA_BYTES);
  const calldataCeilingData = outerAddTransaction({
    action: 'deploy', config, source: calldataCeilingOverflow,
  });
  assert.throws(() => assertExactPlannedConsensusCalldata(calldataCeilingData, {
    action: 'deploy',
    config,
    state: { contractAddress: null },
    local: { source: calldataCeilingOverflow },
    nowSeconds: 1_000,
  }), /outer Bradbury calldata.*operational ceiling/i);

  const mutations = [
    outerAddTransaction({
      action: 'pause', config, source: local.source, overrides: { method: 'activate_payouts' },
    }),
    outerAddTransaction({
      action: 'pause', config, source: local.source, overrides: { leaderOnly: true },
    }),
    outerAddTransaction({
      action: 'deploy', config, source: local.source, overrides: { source: `${local.source}#` },
    }),
    `${exactPause.slice(0, -1)}${exactPause.endsWith('0') ? '1' : '0'}`,
  ];
  assert.throws(() => assertExactPlannedConsensusCalldata(mutations[0], {
    action: 'pause', config, state, local, nowSeconds: 1_000,
  }), /transaction bytes differ/i);
  assert.throws(() => assertExactPlannedConsensusCalldata(mutations[1], {
    action: 'pause', config, state, local, nowSeconds: 1_000,
  }), /transaction bytes differ/i);
  assert.throws(() => assertExactPlannedConsensusCalldata(mutations[2], {
    action: 'deploy', config, state: { contractAddress: null }, local, nowSeconds: 1_000,
  }), /transaction bytes differ/i);
  assert.throws(() => assertExactPlannedConsensusCalldata(mutations[3], {
    action: 'pause', config, state, local, nowSeconds: 1_000,
  }), /canonical exact-byte|validity window|transaction bytes differ/i);
});

test('FINALIZED lifecycle without successful execution or the exact hash is rejected', () => {
  assert.doesNotThrow(() => assertSuccessfulFinalizedReceipt(finalizedReceipt(), GEN_HASH));
  assert.throws(
    () => assertSuccessfulFinalizedReceipt(finalizedReceipt({ statusName: 'ACCEPTED' }), GEN_HASH),
    /not FINALIZED/i,
  );
  assert.throws(
    () => assertSuccessfulFinalizedReceipt(finalizedReceipt({
      txExecutionResultName: 'FINISHED_WITH_ERROR',
    }), GEN_HASH),
    /contract execution was FINISHED_WITH_ERROR/i,
  );
  assert.throws(
    () => assertSuccessfulFinalizedReceipt(finalizedReceipt(), `0x${'ff'.repeat(32)}`),
    /hash does not match/i,
  );
  const conflicting = finalizedReceipt({ transactionHash: `0x${'ee'.repeat(32)}` });
  assert.throws(() => assertSuccessfulFinalizedReceipt(conflicting, GEN_HASH), /conflicting/i);
});

test('write receipt requires exact signer, recipient, method, arguments, and value', () => {
  assert.doesNotThrow(() => assertExactCallReceipt(finalizedReceipt(), {
    hash: GEN_HASH,
    sender: OWNER,
    contractAddress: CONTRACT,
    method: 'pause_new_risk',
    args: [],
    valueAtto: '0',
  }));
  for (const [label, receipt, pattern] of [
    ['sender', finalizedReceipt({ sender: KEEPER }), /sender/i],
    ['recipient', finalizedReceipt({ recipient: FACTORY }), /recipient/i],
    ['method', finalizedReceipt({
      txDataDecoded: { type: 'call', callData: { method: 'activate_payouts', args: [] } },
    }), /does not prove call/i],
    ['leader-only', finalizedReceipt({
      txDataDecoded: {
        type: 'call', leaderOnly: true, callData: { method: 'pause_new_risk', args: [] },
      },
    }), /does not prove call/i],
    ['value', finalizedReceipt({ value: '1' }), /value/i],
  ]) {
    assert.throws(() => assertExactCallReceipt(receipt, {
      hash: GEN_HASH,
      sender: OWNER,
      contractAddress: CONTRACT,
      method: 'pause_new_risk',
      valueAtto: '0',
    }), pattern, label);
  }
});

test('deployment receipt proves successful full-consensus source, constructor, and contract address', () => {
  const config = normalizeConfig(rawConfig());
  const source = 'reviewed-v8-source\n';
  const receipt = finalizedReceipt({
    recipient: CONTRACT,
    txDataDecoded: {
      type: 'deploy',
      code: source,
      constructorArgs: {
        args: [
          `addr#${TREASURY.slice(2)}`,
          `addr#${KEEPER.slice(2)}`,
          config.expected.epochMinStakeAtto,
          config.expected.epochMaxStakePerWalletAtto,
          `addr#${FACTORY.slice(2)}`,
        ],
        kwargs: {},
      },
      leaderOnly: false,
      contractAddress: CONTRACT,
    },
  });
  assert.equal(assertExactDeploymentReceipt(receipt, {
    hash: GEN_HASH,
    source,
    config,
  }), CONTRACT);
  assert.throws(() => assertExactDeploymentReceipt({
    ...receipt,
    txDataDecoded: { ...receipt.txDataDecoded, code: `${source}# changed` },
  }, { hash: GEN_HASH, source, config }), /exact full-consensus V8 source/i);
  assert.throws(() => assertExactDeploymentReceipt({
    ...receipt,
    txDataDecoded: { ...receipt.txDataDecoded, contractAddress: FACTORY },
  }, { hash: GEN_HASH, source, config }), /conflicting contract addresses/i);

  const sdkShaped = {
    ...receipt,
    txDataDecoded: {
      ...receipt.txDataDecoded,
      constructorArgs: new Map([
        ['args', receipt.txDataDecoded.constructorArgs.args],
        ['kwargs', new Map()],
      ]),
    },
  };
  assert.equal(assertExactDeploymentReceipt(sdkShaped, {
    hash: GEN_HASH,
    source,
    config,
  }), CONTRACT);
});

test('actual SDK Map call decoding and absent GenLayer value use signed outer EVM evidence', async () => {
  const { config, operation } = await signedReplayFixture(0n);
  assert.throws(() => assertExactSignedEvmEnvelope({
    ...operation,
    ownerNoncePendingAtSign: '8',
  }, config), /quiescent owner nonce/i);
  assert.throws(() => assertExactSignedEvmEnvelope({
    ...operation,
    maximumTransactionCostAtSign: '199999',
  }, config), /pending-balance evidence/i);
  const receipt = finalizedReceipt({
    sender: config.expected.ownerAddress,
    txDataDecoded: {
      type: 'call',
      leaderOnly: false,
      callData: new Map([['method', 'pause_new_risk']]),
    },
  });
  delete receipt.value;
  assert.doesNotThrow(() => assertExactCallReceipt(receipt, {
    hash: GEN_HASH,
    sender: config.expected.ownerAddress,
    contractAddress: CONTRACT,
    method: 'pause_new_risk',
    valueAtto: '0',
    signedOperation: operation,
    config,
  }));

  const funded = await signedReplayFixture(1n);
  assert.throws(() => assertExactCallReceipt(receipt, {
    hash: GEN_HASH,
    sender: funded.config.expected.ownerAddress,
    contractAddress: CONTRACT,
    method: 'pause_new_risk',
    valueAtto: '0',
    signedOperation: funded.operation,
    config: funded.config,
  }), /outer EVM call value/i);
});

test('get_config and reserve readbacks reject every mismatch and unknown field', () => {
  const config = normalizeConfig(rawConfig());
  const flags = {
    payoutsEnabled: true,
    newRiskEnabled: false,
    availableReserveAtto: config.reserve.initialFundingAtto,
  };
  const exactConfig = buildExpectedConfigReadback(config, flags);
  const exactReserve = buildExpectedReserveReadback(config, flags);
  assert.doesNotThrow(() => assertExactConfigReadback(exactConfig, config, flags));
  assert.doesNotThrow(() => assertExactReserveReadback(exactReserve, config, flags));

  assert.throws(() => assertExactConfigReadback({
    ...exactConfig,
    owner: KEEPER,
  }, config, flags), /get_config readback/i);
  assert.throws(() => assertExactConfigReadback({
    ...exactConfig,
    force_funded: true,
  }, config, flags), /get_config readback/i);
  assert.throws(() => assertExactReserveReadback({
    ...exactReserve,
    available_reserve_atto: '2999999999999999999',
  }, config, flags), /reserve_state readback/i);
  assert.throws(() => assertExactReserveReadback({
    ...exactReserve,
    mystery_reserve: '1',
  }, config, flags), /reserve_state readback/i);
});

test('pause readback accepts live canary accounting but enforces every cross-view identity', async () => {
  const config = normalizeConfig(rawConfig());
  const reserveReadback = {
    treasury: TREASURY,
    current_platform_fee_bps: 200,
    payout_protocol_version: PAYOUT_PROTOCOL_VERSION,
    payouts_enabled: true,
    new_risk_enabled: false,
    player_liability_atto: '100',
    accrued_platform_fees_atto: '10',
    reserved_platform_fees_atto: '20',
    funded_platform_fees_atto: '30',
    withdrawn_platform_fees_atto: '5',
    available_reserve_atto: '1000',
    committed_reserve_atto: '600',
    required_available_reserve_atto: '210',
    reserved_player_payouts_atto: '40',
    max_payout_attempts: 3,
    prepare_retries_capped: false,
    retry_delay_seconds: 3600,
  };
  const live = {
    reserveReadback,
    epochPage: accountingPage('epoch_ids', 4),
    payoutPage: accountingPage('payouts', 3),
  };
  const exact = assertLiveAccountingIdentity(live, config, { newRiskEnabled: false });
  assert.equal(exact.epochCount, '4');
  assert.equal(exact.payoutCount, '3');
  assert.match(exact.sha256, /^[0-9a-f]{64}$/);

  const unpausedReserve = { ...reserveReadback, new_risk_enabled: true };
  const unpaused = assertLiveAccountingIdentity({
    ...live,
    reserveReadback: unpausedReserve,
  }, config, { newRiskEnabled: true });
  const continuity = assertPauseAccountingContinuity(unpaused, exact);
  assert.equal(continuity.before.reserve.new_risk_enabled, true);
  assert.equal(continuity.after.reserve.new_risk_enabled, false);
  assert.deepEqual(assertExactPauseAccountingIdentity(unpaused, unpaused), unpaused);
  assert.deepEqual(normalizePauseAccountingIdentity(unpaused), unpaused);
  assert.doesNotThrow(
    () => assertPauseAccountingContinuity(
      unpaused,
      liveAccountingIdentity(config, {
        newRiskEnabled: false,
        availableReserveAtto: '1001',
      }),
    ),
  );
  const otherTreasuryConfig = normalizeConfig(rawConfig({
    expected: { treasuryAddress: OTHER_BINDER },
  }));
  assert.throws(
    () => assertPauseAccountingContinuity(
      unpaused,
      liveAccountingIdentity(otherTreasuryConfig, { newRiskEnabled: false }),
    ),
    /immutable accounting policy continuity/i,
  );
  assert.throws(
    () => assertPauseAccountingContinuity(exact, exact),
    /risk true-to-false transition/i,
  );
  assert.throws(
    () => normalizePauseAccountingIdentity({ ...unpaused, sha256: '00'.repeat(32) }),
    /hash does not match/i,
  );

  for (const [label, changed, pattern] of [
    ['reserved player liability', {
      ...live,
      reserveReadback: {
        ...reserveReadback,
        player_liability_atto: '39',
        reserved_player_payouts_atto: '40',
      },
    }, /reserved player payouts exceed/i],
    ['required identity', {
      ...live,
      reserveReadback: { ...reserveReadback, required_available_reserve_atto: '211' },
    }, /required reserve.*identity/i],
    ['capacity', {
      ...live,
      reserveReadback: { ...reserveReadback, available_reserve_atto: '209' },
    }, /available reserve.*below/i],
    ['fee withdrawal', {
      ...live,
      reserveReadback: { ...reserveReadback, withdrawn_platform_fees_atto: '31' },
    }, /withdrawn platform fees exceed/i],
    ['unknown reserve', {
      ...live,
      reserveReadback: { ...reserveReadback, surprise: '1' },
    }, /live reserve field identity/i],
  ]) {
    assert.throws(
      () => assertLiveAccountingIdentity(changed, config, { newRiskEnabled: false }),
      pattern,
      label,
    );
  }

  const source = 'reviewed live-canary V8 source\n';
  const pauseConfig = normalizeConfig(rawConfig({ sourceSha256: sha256(source) }));
  const values = {
    get_config: buildExpectedConfigReadback(pauseConfig, {
      payoutsEnabled: true,
      newRiskEnabled: false,
    }),
    get_delivery_reserve_state: reserveReadback,
    get_epoch_page: accountingPage('epoch_ids', 4),
    get_payout_page: accountingPage('payouts', 3),
  };
  const verified = await readAndVerifyPauseState({
    code: async () => source,
    schema: async () => EXPECTED_V8_SCHEMA,
    call: async (_address, method) => values[method],
  }, CONTRACT, { source }, pauseConfig, { newRiskEnabled: false });
  assert.equal(verified.address, CONTRACT);
  assert.equal(verified.accounting.epochCount, '4');
  assert.equal(verified.accounting.reserve.player_liability_atto, '100');
});

test('signed raw EVM transaction and exact event binding are durable before SUBMITTED is legal', async () => {
  const fixture = await signedReplayFixture();
  const { config, operation } = fixture;
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-state-'));
  const statePath = join(root, 'state.json');
  let state = writeStateAtomic(statePath, {
    ...newState(config), stage: ACTIVATION_TERMINAL_STAGE, contractAddress: CONTRACT,
  });
  const pauseAccountingIdentity = liveAccountingIdentity(config);
  state = prepareOperation(statePath, state, 'pause', { pauseAccountingIdentity });
  const nonce = state.operations.pause.nonce;
  assert.deepEqual(state.operations.pause.pauseAccountingIdentity, pauseAccountingIdentity);
  assert.throws(
    () => recordSubmittedOperation(statePath, state, 'pause', nonce, GEN_HASH),
    /EVM-confirmed/i,
  );
  state = recordSignedOperation(statePath, state, 'pause', nonce, {
    signedEvmTransaction: operation.signedEvmTransaction,
    evmTransactionHash: operation.evmTransactionHash,
    senderNonce: 7,
    ownerNonceLatestAtSign: 7,
    ownerNoncePendingAtSign: 7,
    ownerPendingBalanceAtSign: '10000000000000000000',
    maximumTransactionCostAtSign: '200000',
  });
  assert.equal(state.operations.pause.status, 'SIGNED');
  assert.equal(state.operations.pause.evmTransactionHash, operation.evmTransactionHash);
  assert.equal(state.operations.pause.senderNonce, '7');
  assert.equal(
    JSON.parse(readFileSync(statePath, 'utf8')).operations.pause.signedEvmTransaction,
    operation.signedEvmTransaction,
  );
  assert.throws(
    () => recordSubmittedOperation(statePath, state, 'pause', nonce, GEN_HASH),
    /EVM-confirmed/i,
  );
  state = recordEvmReceiptEvidence(statePath, state, 'pause', nonce, {
    evmTransactionHash: operation.evmTransactionHash,
    genlayerTransactionHash: GEN_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: '0x2a',
    eventTopic: NEW_TRANSACTION_TOPIC,
    logIndex: '0x0',
  });
  assert.equal(state.operations.pause.status, 'EVM_CONFIRMED');
  assert.throws(
    () => recordSubmittedOperation(statePath, state, 'pause', nonce, `0x${'ff'.repeat(32)}`),
    /does not match the exact Bradbury EVM event/i,
  );
  state = recordSubmittedOperation(statePath, state, 'pause', nonce, GEN_HASH);
  assert.equal(state.operations.pause.status, 'SUBMITTED');
  assert.equal(loadState(statePath, config).operations.pause.transactionHash, GEN_HASH);
  assert.throws(
    () => prepareOperation(statePath, state, 'pause', { pauseAccountingIdentity }),
    /unresolved operation.*SUBMITTED/i,
  );
});

test('pending activation blocks a defense pause operation until reconciliation', () => {
  const config = normalizeConfig(rawConfig());
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-state-'));
  const statePath = join(root, 'state.json');
  const pending = writeStateAtomic(statePath, {
    ...newState(config),
    stage: 'ACTIVATION_SUBMITTED',
    contractAddress: CONTRACT,
    operations: {
      activate: {
        status: 'SUBMITTED',
        nonce: 'activation-operation',
        transactionHash: GEN_HASH,
      },
    },
  });
  assert.throws(
    () => prepareOperation(statePath, pending, 'pause'),
    /unresolved operation.*activate:SUBMITTED.*before preparing pause/i,
  );
  assert.equal(loadState(statePath, config).stage, 'ACTIVATION_SUBMITTED');
  assert.equal(loadState(statePath, config).operations.pause, undefined);
});

test('exclusive state and owner locks serialize all broadcasts across configs and paths', () => {
  const config = normalizeConfig(rawConfig());
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-lock-'));
  const statePath = join(root, 'one.json');
  const stateLock = acquireStateLock(statePath);
  try {
    assert.throws(() => acquireStateLock(statePath), /exclusive state lock already exists/i);
    const persisted = JSON.parse(readFileSync(stateLock.lockPath, 'utf8'));
    assert.equal(persisted.statePath, resolve(statePath));
    assert.equal(persisted.pid, process.pid);
  } finally {
    stateLock.release();
  }
  const nextStateLock = acquireStateLock(statePath);
  nextStateLock.release();

  const ownerLock = acquireOwnerLock(config);
  try {
    const sameOwnerDifferentConfig = normalizeConfig(rawConfig({
      reserve: { initialFundingAtto: '4000000000000000000' },
    }));
    assert.throws(
      () => acquireOwnerLock(sameOwnerDifferentConfig),
      /exclusive Bradbury owner lock already exists/i,
    );
  } finally {
    ownerLock.release();
  }

  const stalePath = stateLockPathFor(join(root, 'stale.json'));
  writeFileSync(stalePath, '{"version":1}\n');
  assert.throws(
    () => acquireStateLock(join(root, 'stale.json')),
    /verify the owning process before manual stale-lock removal/i,
  );
  unlinkSync(stalePath);
});

test('asynchronous CLI actions remain awaited inside the exclusive-lock lifetime', () => {
  const source = readFileSync(new URL('./harness.mjs', import.meta.url), 'utf8');
  for (const action of [
    'statusAction(context)',
    'deployAction(context, options)',
    'fundAction(context, options)',
    'activateAction(context, options)',
    'reconcileAction(context, options)',
    'emergencyPauseAction(context, options)',
  ]) {
    assert.ok(source.includes(`return await ${action};`));
  }
});

test('all platforms keep replayable state inside one protected ignored operational root', () => {
  const config = normalizeConfig(rawConfig());
  const simulated = operationalEvidenceRoot({
    platform: 'win32',
    localAppData: 'C:\\Users\\reviewer\\AppData\\Local',
  });
  assert.equal(
    simulated.toLowerCase(),
    'c:\\users\\reviewer\\appdata\\local\\liquidityarena\\bradbury-v8',
  );
  if (process.platform === 'win32') {
    const root = operationalEvidenceRoot();
    const defaultState = statePathFor(resolve('config.json'), config, null);
    assert.ok(defaultState.toLowerCase().startsWith(`${root.toLowerCase()}\\state\\`));
    assert.throws(
      () => statePathFor(resolve('config.json'), config, join(tmpdir(), 'outside-state.json')),
      /must stay inside the protected operational state root/i,
    );
  }
  const posixRoot = '/home/reviewer/.local/share/liquidity-arena/bradbury-v8';
  assert.equal(
    statePathFor('/repo/ops/bradbury-v8/config.json', config, null, {
      platform: 'linux',
      evidenceRoot: posixRoot,
    }),
    `${posixRoot}/state/v8-${config.fingerprint.slice(0, 16)}.json`,
  );
  assert.equal(
    statePathFor('/repo/ops/bradbury-v8/config.json', config, `${posixRoot}/state/custom.json`, {
      platform: 'linux',
      evidenceRoot: posixRoot,
    }),
    `${posixRoot}/state/custom.json`,
  );
  assert.throws(
    () => statePathFor('/repo/ops/bradbury-v8/config.json', config, '/repo/state.json', {
      platform: 'linux',
      evidenceRoot: posixRoot,
    }),
    /must stay inside the protected operational state root/i,
  );
});

test('state and lock paths reject a Windows junction or POSIX symlink escape before writes', () => {
  const config = normalizeConfig(rawConfig());
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-alias-'));
  const evidenceRoot = join(root, 'protected');
  const outsideState = join(root, 'outside-state');
  const outsideLocks = join(root, 'outside-locks');
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(outsideState, { recursive: true });
  mkdirSync(outsideLocks, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const stateRoot = join(evidenceRoot, 'state');
  const lockRoot = join(evidenceRoot, 'locks');
  symlinkSync(outsideState, stateRoot, linkType);
  symlinkSync(outsideLocks, lockRoot, linkType);

  const escapedState = join(stateRoot, 'escaped.json');
  assert.throws(
    () => statePathFor(resolve('config.json'), config, escapedState, {
      platform: process.platform,
      evidenceRoot,
    }),
    /symbolic link|junction|aliased/i,
  );
  assert.throws(
    () => writeStateAtomic(escapedState, {
      ...newState(config),
      operations: { pause: { signedEvmTransaction: '0xfeed' } },
    }),
    /symbolic link|junction|aliased/i,
  );
  assert.throws(
    () => acquireStateLock(escapedState),
    /symbolic link|junction|aliased/i,
  );
  assert.throws(
    () => assertProtectedOperationalPath(
      join(lockRoot, `owner-${BRADBURY_CHAIN_ID}-${OWNER.slice(2)}.lock`),
      lockRoot,
      { field: 'test owner lock path' },
    ),
    /symbolic link|junction|aliased/i,
  );
  assert.equal(existsSync(join(outsideState, 'escaped.json')), false);
  assert.equal(existsSync(join(outsideState, 'escaped.json.lock')), false);
  assert.equal(existsSync(join(outsideLocks, `owner-${BRADBURY_CHAIN_ID}-${OWNER.slice(2)}.lock`)), false);

  const danglingEvidenceRoot = join(root, 'dangling-protected');
  const removedTarget = join(root, 'removed-target');
  mkdirSync(danglingEvidenceRoot, { recursive: true });
  mkdirSync(removedTarget, { recursive: true });
  const danglingStateRoot = join(danglingEvidenceRoot, 'state');
  symlinkSync(removedTarget, danglingStateRoot, linkType);
  rmdirSync(removedTarget);
  assert.throws(
    () => statePathFor(
      resolve('config.json'),
      config,
      join(danglingStateRoot, 'escaped.json'),
      { platform: process.platform, evidenceRoot: danglingEvidenceRoot },
    ),
    /symbolic link|junction|aliased/i,
  );
});

test('exact Bradbury EVM receipt binds one EVM hash to one GenLayer transaction id', () => {
  const exact = evmSubmissionReceipt(EVM_HASH);
  const evidence = assertExactEvmSubmissionReceipt(exact, { evmTransactionHash: EVM_HASH });
  assert.equal(evidence.evmTransactionHash, EVM_HASH);
  assert.equal(evidence.genlayerTransactionHash, GEN_HASH);
  assert.equal(evidence.blockHash, BLOCK_HASH);

  assert.throws(() => assertExactEvmSubmissionReceipt(
    evmSubmissionReceipt(`0x${'ee'.repeat(32)}`),
    { evmTransactionHash: EVM_HASH },
  ), /does not belong to the exact pre-signed transaction/i);
  assert.throws(() => assertExactEvmSubmissionReceipt({
    ...exact,
    logs: [exact.logs[0], { ...exact.logs[0], logIndex: '0x1' }],
  }, { evmTransactionHash: EVM_HASH }), /exactly one supported consensus event; found 2/i);
  assert.throws(() => assertExactEvmSubmissionReceipt({
    ...exact,
    status: '0x0',
  }, { evmTransactionHash: EVM_HASH }), /not successful/i);
});

test('SIGNED crash recovery inspects first and never sends without explicit broadcast', async () => {
  const fixture = await signedReplayFixture();
  const { config, operation, action, state, local } = fixture;
  let sends = 0;
  const result = await reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    broadcast: false,
    reader: {
      evmReceipt: async () => null,
      sendSignedEvmTransaction: async () => { sends += 1; },
    },
  });
  assert.equal(result, null);
  assert.equal(sends, 0);
});

test('send accepted before SUBMITTED is recovered from the exact EVM hash without replay', async () => {
  const fixture = await signedReplayFixture();
  const { config, operation, action, state, local } = fixture;
  let sends = 0;
  const evidence = await reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    broadcast: true,
    reader: {
      evmReceipt: async () => evmSubmissionReceipt(operation.evmTransactionHash),
      sendSignedEvmTransaction: async () => { sends += 1; },
    },
  });
  assert.equal(evidence.genlayerTransactionHash, GEN_HASH);
  assert.equal(sends, 0);
});

test('expired signed intent can finalize from its receipt but can never be replayed', async () => {
  const fixture = await signedReplayFixture(0n, 4_600n);
  const {
    config, operation, action, state, local,
  } = fixture;
  let sends = 0;
  const evidence = await reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    broadcast: true,
    reader: {
      evmReceipt: async () => evmSubmissionReceipt(operation.evmTransactionHash),
      sendSignedEvmTransaction: async () => { sends += 1; },
    },
  });
  assert.equal(evidence.genlayerTransactionHash, GEN_HASH);
  assert.equal(sends, 0);

  await assert.rejects(() => reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    broadcast: true,
    reader: {
      evmReceipt: async () => null,
      sendSignedEvmTransaction: async () => { sends += 1; },
    },
  }), /validity window/i);
  assert.equal(sends, 0);
});

test('raw replay is idempotent and reuses only the exact stored signed bytes', async () => {
  const fixture = await signedReplayFixture();
  const { config, operation, action, state, local } = fixture;
  let receiptCalls = 0;
  let replayedRaw = null;
  const evidence = await reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    broadcast: true,
    sleepImpl: async () => {},
    reader: pauseReadbackReader(config, local.source, operation.pauseAccountingIdentity, {
      evmReceipt: async () => {
        receiptCalls += 1;
        return receiptCalls === 1
          ? null
          : evmSubmissionReceipt(operation.evmTransactionHash);
      },
      sendSignedEvmTransaction: async (raw) => {
        replayedRaw = raw;
        throw new Error('already known');
      },
    }),
  });
  assert.equal(replayedRaw, operation.signedEvmTransaction);
  assert.equal(evidence.evmTransactionHash, operation.evmTransactionHash);
  assert.equal(receiptCalls, 2);
});

test('raw replay and receipt mismatch or ambiguity refuse reconciliation', async () => {
  const fixture = await signedReplayFixture();
  const { config, operation, action, state, local } = fixture;
  await assert.rejects(() => reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    broadcast: true,
    reader: pauseReadbackReader(config, local.source, operation.pauseAccountingIdentity, {
      evmReceipt: async () => null,
      sendSignedEvmTransaction: async () => `0x${'ff'.repeat(32)}`,
    }),
  }), /different EVM transaction hash/i);

  const ambiguous = evmSubmissionReceipt(operation.evmTransactionHash);
  ambiguous.logs.push({ ...ambiguous.logs[0], logIndex: '0x1' });
  await assert.rejects(() => reconcileEvmSubmission({
    config,
    operation,
    action,
    state,
    local,
    reader: { evmReceipt: async () => ambiguous },
  }), /exactly one supported consensus event; found 2/i);

  const wrongValue = await signedReplayFixture(1n);
  let wrongValueSends = 0;
  await assert.rejects(() => reconcileEvmSubmission({
    config: wrongValue.config,
    operation: wrongValue.operation,
    action: wrongValue.action,
    state: wrongValue.state,
    local: wrongValue.local,
    broadcast: true,
    reader: {
      evmReceipt: async () => null,
      sendSignedEvmTransaction: async () => { wrongValueSends += 1; },
    },
  }), /signed EVM value does not match/i);
  assert.equal(wrongValueSends, 0);
});

test('state is fingerprint-bound and permanently prohibits app/database cutover markers', () => {
  const config = normalizeConfig(rawConfig());
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-state-'));
  const statePath = resolve(root, 'state.json');
  writeStateAtomic(statePath, newState(config));
  const wrong = normalizeConfig(rawConfig({ reserve: { initialFundingAtto: '4' } }));
  assert.throws(() => loadState(statePath, wrong), /does not belong/i);
  const poisoned = { ...newState(config), cutsOverApplication: true };
  writeFileSync(statePath, `${JSON.stringify(poisoned)}\n`);
  assert.throws(() => loadState(statePath, config), /prohibited.*cutover/i);
});

test('SIGNED state bytes are fsynced before atomic publication can return to the SDK', () => {
  const config = normalizeConfig(rawConfig());
  const root = mkdtempSync(join(tmpdir(), 'bradbury-v8-fsync-'));
  const statePath = join(root, 'state.json');
  const events = [];
  writeStateAtomic(statePath, newState(config), {
    openImpl: (...args) => { events.push(`open:${args[1]}`); return openSync(...args); },
    writeImpl: (...args) => { events.push('write'); return writeFileSync(...args); },
    fsyncImpl: (...args) => { events.push('fsync'); return fsyncSync(...args); },
    closeImpl: (...args) => { events.push('close'); return closeSync(...args); },
    renameImpl: (...args) => { events.push('rename'); return renameSync(...args); },
  });
  assert.ok(events.indexOf('write') < events.indexOf('fsync'));
  assert.ok(events.indexOf('fsync') < events.indexOf('rename'));

  const refusedPath = join(root, 'refused.json');
  let renamed = false;
  assert.throws(() => writeStateAtomic(refusedPath, newState(config), {
    fsyncImpl: () => { throw new Error('injected flush failure'); },
    renameImpl: (...args) => { renamed = true; return renameSync(...args); },
  }), /unable to persist state atomically.*flush failure/i);
  assert.equal(renamed, false);
  assert.equal(existsSync(refusedPath), false);
});
