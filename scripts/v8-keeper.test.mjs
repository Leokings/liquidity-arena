import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertV8ContractConfiguration,
  assertActionPostState,
  assertV8Schema,
  classifyOpenEpoch,
  classifyPayoutAction,
  plannedPayoutScanRanges,
  runV8KeeperOnce,
  V8_FACTORY_VIEW_ABI,
  V8_KEEPER_ABI,
  validateReceiptIdentity,
} from './v8-keeper.mjs';
import {
  normalizeV8KeeperConfig,
  V8_AUDITED_PAYOUT_FACTORY,
  V8_POLICY_VERSION,
  V8_PROTOCOL_VERSION,
} from './v8-keeper-config.mjs';
import { canonicalKeeperOperation } from '../keeper-journal/schema.mjs';
import { createMemoryAuthoritativeKeeperJournalClient } from './authoritative-keeper-journal.test-helper.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const KEEPER = '0x3333333333333333333333333333333333333333';
const TREASURY = '0x4444444444444444444444444444444444444444';
const PAYOUT = 'a'.repeat(64);
const NOW = Date.UTC(2027, 0, 15, 10, 0, 0) / 1000;

function config(operator = {}) {
  return normalizeV8KeeperConfig({
    network: 'testnet-bradbury',
    chainId: 4221,
    contractAddress: CONTRACT,
    expected: {
      ownerAddress: OWNER,
      keeperAddress: KEEPER,
      treasuryAddress: TREASURY,
      payoutFactoryAddress: V8_AUDITED_PAYOUT_FACTORY,
    },
    epochs: {
      futureHours: 2,
      minimumCreationLeadSeconds: 7200,
      minStakeGen: '0.1',
      maxStakePerWalletGen: '10',
    },
    operator: {
      pageSize: 50,
      maxEpochReadsPerRun: 12,
      maxPayoutReadsPerRun: 50,
      maxWritesPerRun: 5,
      readAttempts: 1,
      retryBaseMs: 0,
      finalityRetries: 1,
      finalityIntervalMs: 100,
      postStateAttempts: 1,
      postStateIntervalMs: 0,
      ...operator,
    },
  });
}

function chainConfig(overrides = {}) {
  return {
    protocol_version: V8_PROTOCOL_VERSION,
    policy_version: V8_POLICY_VERSION,
    owner: OWNER,
    keeper: KEEPER,
    treasury: TREASURY,
    payout_vault_factory: V8_AUDITED_PAYOUT_FACTORY,
    payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
    payouts_enabled: true,
    new_risk_enabled: true,
    max_payout_attempts: 3,
    prepare_retries_capped: false,
    payout_retry_delay_seconds: 3600,
    current_platform_fee_bps: 200,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: 3600,
    keeper_max_schedule_ahead_seconds: 93600,
    wager_open_offset_seconds: 2400,
    battle_open_offset_seconds: 1200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86400,
    minimum_qualified_venues: 3,
    asset_ids: ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'],
    venues: ['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN'],
    supported_objectives: ['HIGH', 'LOW'],
    validator_return_tolerance_ppb: 100000,
    payout_finality: 'FUNDED_IN_ESCROW',
    claimed_semantics: 'EOA_WITHDRAWN',
    ...overrides,
  };
}

function reserveState() {
  return {
    treasury: TREASURY,
    payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
    payouts_enabled: true,
    new_risk_enabled: true,
    max_payout_attempts: 3,
    retry_delay_seconds: 3600,
    current_platform_fee_bps: 200,
    player_liability_atto: '0',
    accrued_platform_fees_atto: '0',
    reserved_platform_fees_atto: '0',
    funded_platform_fees_atto: '0',
    withdrawn_platform_fees_atto: '0',
    available_reserve_atto: '3000000000000000000',
    committed_reserve_atto: '0',
    required_available_reserve_atto: '0',
    reserved_player_payouts_atto: '0',
  };
}

function epochRecord(end, overrides = {}) {
  return {
    epoch_end_timestamp: end,
    wager_opens_timestamp: end - 2400,
    wager_closes_timestamp: end - 1200,
    battle_starts_timestamp: end - 1200,
    resolution_available_timestamp: end + 120,
    timeout_refund_available_timestamp: end + 86400,
    policy_version: V8_POLICY_VERSION,
    platform_fee_bps_snapshot: 200,
    min_stake_atto: '100000000000000000',
    max_stake_per_wallet_atto: '10000000000000000000',
    status: 'OPEN',
    result_status: 'PENDING',
    resolution_digest: '',
    ...overrides,
  };
}

function payoutRecord(overrides = {}) {
  return {
    payout_id: PAYOUT,
    kind: 'PLAYER',
    recipient: OWNER,
    amount_atto: '100000000000000000',
    state: 'PREPARING',
    prepare_attempt_count: 1,
    attempt_count: 0,
    last_prepare_timestamp: NOW,
    last_dispatch_timestamp: 0,
    escrow_withdrawn: false,
    ...overrides,
  };
}

test('keeper pins the exhaustive V8 ABI and immutable contract configuration', () => {
  assert.equal(Object.keys(V8_KEEPER_ABI.methods).length, 25);
  assert.equal(V8_FACTORY_VIEW_ABI.length, 3);
  assert.ok(V8_FACTORY_VIEW_ABI.every((entry) => entry.includes(' view returns ')));
  assert.equal(V8_FACTORY_VIEW_ABI.some((entry) => /function\s+withdraw\s*\(/.test(entry)), false);
  assert.equal(assertV8Schema(structuredClone(V8_KEEPER_ABI)).methods.get_payout_page.readonly, true);
  const added = structuredClone(V8_KEEPER_ABI);
  added.methods.legacy_claim = { ...added.methods.claim };
  assert.throws(() => assertV8Schema(added), /25-method V8 ABI/);
  const roles = assertV8ContractConfiguration(config(), chainConfig());
  assert.equal(roles.keeper, KEEPER);
  assert.equal(roles.newRiskEnabled, true);
  assert.throws(() => assertV8ContractConfiguration(config(), chainConfig({ payout_vault_factory: TREASURY })), /payout_vault_factory/);
});

test('payout classifier uses only V8 permissionless stages plus keeper-authorized retry', () => {
  const prepared = { prepared: true, credited: false, withdrawn: false };
  const missing = { prepared: false, credited: false, withdrawn: false };
  assert.deepEqual(classifyPayoutAction(payoutRecord(), NOW, prepared), { type: 'DISPATCH', payoutId: PAYOUT });
  assert.equal(classifyPayoutAction(payoutRecord(), NOW, missing), null);
  assert.deepEqual(classifyPayoutAction(payoutRecord({ last_prepare_timestamp: NOW - 3600 }), NOW, missing), { type: 'RETRY_PREPARE', payoutId: PAYOUT });
  assert.deepEqual(classifyPayoutAction(payoutRecord({ state: 'DISPATCHED', attempt_count: 1, last_dispatch_timestamp: NOW }), NOW, { prepared: true, credited: true, withdrawn: false }), { type: 'CONFIRM', payoutId: PAYOUT });
  assert.equal(classifyPayoutAction(payoutRecord({ state: 'DISPATCHED', attempt_count: 1, last_dispatch_timestamp: NOW }), NOW, prepared), null);
  assert.deepEqual(classifyPayoutAction(payoutRecord({ state: 'DISPATCHED', attempt_count: 1, last_dispatch_timestamp: NOW - 3600 }), NOW, prepared), { type: 'RETRY_PAYOUT', payoutId: PAYOUT });
  assert.deepEqual(classifyPayoutAction(payoutRecord({ state: 'FUNDED_IN_ESCROW', attempt_count: 1, last_dispatch_timestamp: NOW - 3600 }), NOW, { prepared: true, credited: true, withdrawn: true }), { type: 'REFRESH', payoutId: PAYOUT });
  assert.equal(classifyPayoutAction(payoutRecord({ state: 'FUNDED_IN_ESCROW', attempt_count: 1 }), NOW, { prepared: true, credited: true, withdrawn: false }), null);
  assert.equal(classifyPayoutAction(payoutRecord({ state: 'EOA_WITHDRAWN', attempt_count: 1 }), NOW, { prepared: true, credited: true, withdrawn: true }), null);
  assert.throws(
    () => classifyPayoutAction(payoutRecord(), NOW, { prepared: false, credited: true, withdrawn: false }),
    /withdrawn => credited => prepared/,
  );
  assert.throws(
    () => classifyPayoutAction(payoutRecord(), NOW, { prepared: true, credited: false, withdrawn: true }),
    /withdrawn => credited => prepared/,
  );
});

test('payout post-state verification accepts every monotonic successor state', () => {
  const preparing = { state: 'PREPARING', prepareAttemptCount: 2, attemptCount: 0 };
  const dispatched = { state: 'DISPATCHED', prepareAttemptCount: 2, attemptCount: 2 };
  const funded = { state: 'FUNDED_IN_ESCROW', prepareAttemptCount: 2, attemptCount: 2 };
  const withdrawn = { state: 'EOA_WITHDRAWN', prepareAttemptCount: 2, attemptCount: 2, escrow_withdrawn: true };
  for (const successor of [preparing, dispatched, funded, withdrawn]) {
    assert.equal(assertActionPostState({ type: 'RETRY_PREPARE' }, successor), 'PAYOUT_PREPARE_RETRIED');
  }
  for (const successor of [dispatched, funded, withdrawn]) {
    assert.equal(assertActionPostState({ type: 'DISPATCH' }, successor), 'PAYOUT_DISPATCHED');
    assert.equal(assertActionPostState({ type: 'RETRY_PAYOUT' }, successor), 'PAYOUT_RETRIED');
  }
  for (const successor of [funded, withdrawn]) {
    assert.equal(assertActionPostState({ type: 'CONFIRM' }, successor), 'PAYOUT_FUNDED');
  }
  assert.equal(assertActionPostState({ type: 'REFRESH' }, withdrawn), 'PAYOUT_WITHDRAWN');
  assert.throws(
    () => assertActionPostState({ type: 'DISPATCH' }, preparing),
    /post-state is not satisfied/,
  );
});

test('journal identities separate Bradbury epoch and payout subjects', () => {
  const epoch = canonicalKeeperOperation({
    deploymentAlias: 'v8', chainId: '4221', contractAddress: CONTRACT,
    subjectType: 'epoch', subjectId: '1800000000', method: 'create_epoch',
    args: ['1800000000'], valueAtto: '0',
  });
  const payout = canonicalKeeperOperation({
    deploymentAlias: 'v8', chainId: '4221', contractAddress: CONTRACT,
    subjectType: 'payout', subjectId: PAYOUT, method: 'dispatch_payout',
    args: [PAYOUT], valueAtto: '0',
  });
  assert.equal(epoch.network, 'bradbury');
  assert.notEqual(epoch.operationId, payout.operationId);
  assert.throws(() => canonicalKeeperOperation({ ...payout, deploymentAlias: 'v7' }), /unexpected fields|v8/);
});

test('open epoch classifier resolves before timeout and activates timeout afterward', () => {
  const epoch = epochRecord(NOW - 120);
  assert.equal(classifyOpenEpoch(epoch, NOW), 'RESOLVE');
  assert.equal(classifyOpenEpoch({ ...epoch, timeout_refund_available_timestamp: NOW }, NOW), 'TIMEOUT');
  assert.equal(classifyOpenEpoch({ ...epoch, status: 'RESOLVED' }, NOW), null);
});

test('dry run scans final ABI pages and plans payout work before new risk', async () => {
  const state = payoutRecord();
  const operator = {
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig(),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({ offset, next_offset: offset, total: 0, epoch_ids: [] }),
    getPayoutPage: async (offset, limit) => ({ offset, next_offset: offset + Math.min(limit, 1 - offset), total: 1, payouts: offset === 0 ? [state] : [] }),
    getPayoutRailState: async () => ({ prepared: true, credited: false, withdrawn: false }),
  };
  const result = await runV8KeeperOnce({ config: config(), operator, nowEpochSeconds: NOW, logger: () => {}, sleep: async () => {} });
  assert.equal(result.actions[0].type, 'DISPATCH');
  assert.equal(result.actions.filter(({ type }) => type === 'CREATE').length, 2);
  assert.equal(result.execute, false);
});

test('keeper refuses a Bradbury alias without the exact chain ID', async () => {
  const operator = {
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury' }),
  };
  await assert.rejects(
    runV8KeeperOnce({ config: config(), operator, nowEpochSeconds: NOW, logger: () => {}, sleep: async () => {} }),
    /active network must be testnet-bradbury\/4221/,
  );
});

test('payout reconciliation scans the bounded newest tail in contract-sized pages', async () => {
  const calls = [];
  const total = 121;
  const payouts = Array.from({ length: total }, (_, index) => payoutRecord({
    payout_id: index.toString(16).padStart(64, '0'),
    state: 'EOA_WITHDRAWN',
    attempt_count: 1,
    last_dispatch_timestamp: NOW,
    escrow_withdrawn: true,
  }));
  const operator = {
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({ offset, next_offset: offset, total: 0, epoch_ids: [] }),
    getPayoutPage: async (offset, limit) => {
      calls.push([offset, limit]);
      const next = Math.min(total, offset + limit);
      return { offset, next_offset: next, total, payouts: payouts.slice(offset, next) };
    },
  };
  const result = await runV8KeeperOnce({
    config: config({ maxPayoutReadsPerRun: 120 }),
    operator,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
  });
  assert.equal(result.scannedPayoutCount, 120);
  assert.deepEqual(calls, [[0, 1], [1, 50], [51, 50], [101, 20]]);
});

test('durable fenced payout rotation revisits the entire old backlog while retaining a hot tail', () => {
  const total = 1_001;
  const budget = 500;
  const olderTotal = 751;
  const visitedOlder = new Set();
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const ranges = plannedPayoutScanRanges(total, budget, String(ordinal));
    assert.equal(ranges.reduce((sum, range) => sum + range.limit, 0), budget);
    assert.deepEqual(ranges.at(-1), { offset: olderTotal, limit: 250, lane: 'TAIL' });
    for (const range of ranges.filter(({ lane }) => lane === 'ROTATING')) {
      for (let index = range.offset; index < range.offset + range.limit; index += 1) visitedOlder.add(index);
    }
  }
  assert.equal(visitedOlder.size, olderTotal);
  assert.deepEqual(plannedPayoutScanRanges(10, 4), [{ offset: 6, limit: 4, lane: 'TAIL' }]);
});

test('epoch reconciliation reads the newest due epochs first', async () => {
  const epochIds = Array.from({ length: 60 }, (_, index) => NOW - (60 - index) * 3600);
  const reads = [];
  const operator = {
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset, limit) => {
      const next = Math.min(epochIds.length, offset + limit);
      return { offset, next_offset: next, total: epochIds.length, epoch_ids: epochIds.slice(offset, next) };
    },
    getEpoch: async (epochEndTimestamp) => {
      reads.push(epochEndTimestamp);
      return epochRecord(epochEndTimestamp, { status: 'RESOLVED' });
    },
    getPayoutPage: async (offset) => ({ offset, next_offset: offset, total: 0, payouts: [] }),
  };
  await runV8KeeperOnce({
    config: config({ maxEpochReadsPerRun: 3 }),
    operator,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
  });
  assert.deepEqual(reads, epochIds.slice(-3).reverse());
});

test('execute PREPARE-binds and verifies a permissionless dispatch without vault withdrawal', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  let payout = payoutRecord();
  let submitted;
  const hash = `0x${'1'.padStart(64, '0')}`;
  const operator = {
    journalClient: journal.client,
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({ offset, next_offset: offset, total: 0, epoch_ids: [] }),
    getPayoutPage: async (offset, limit) => ({ offset, next_offset: offset + Math.min(limit, 1 - offset), total: 1, payouts: offset === 0 ? [structuredClone(payout)] : [] }),
    getPayout: async () => structuredClone(payout),
    getPayoutRailState: async () => ({ prepared: true, credited: false, withdrawn: false }),
    submitWrite: async (method, args, onHash) => {
      submitted = { method, args: [...args] };
      await onHash(hash);
      payout = payoutRecord({ state: 'DISPATCHED', attempt_count: 1, last_dispatch_timestamp: NOW });
    },
    getTransactionStatus: async () => 'FINALIZED',
    waitFinalized: async () => ({
      transactionHash: hash,
      statusName: 'FINALIZED',
      txExecutionResultName: 'FINISHED_WITH_RETURN',
      recipient: CONTRACT,
      txDataDecoded: { type: 'call', callData: { method: 'dispatch_payout', args: [PAYOUT] } },
    }),
  };
  const result = await runV8KeeperOnce({
    config: config({ maxWritesPerRun: 1 }),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
    journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
  });
  assert.deepEqual(submitted, { method: 'dispatch_payout', args: [PAYOUT] });
  assert.equal(result.completed[0].status, 'PAYOUT_DISPATCHED');
  assert.equal(result.payoutRotationOrdinal, '1');
  assert.equal([...journal.operations.values()][0].subjectType, 'payout');
  assert.equal([...journal.operations.values()][0].state, 'VERIFIED');
  assert.equal(submitted.method.includes('withdraw'), false);
});

test('recovery verifies FINALIZED_SUCCESS after a concurrent payout successor transition', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const hash = `0x${'3'.padStart(64, '0')}`;
  const operationId = journal.seedOperation({
    deploymentAlias: 'v8',
    chainId: '4221',
    contractAddress: CONTRACT,
    subjectType: 'payout',
    subjectId: PAYOUT,
    method: 'dispatch_payout',
    args: [PAYOUT],
    valueAtto: '0',
    signerAddress: KEEPER,
    state: 'FINALIZED_SUCCESS',
    transactionHash: hash,
    lifecycleStatus: 'FINALIZED',
  });
  const successor = payoutRecord({
    state: 'FUNDED_IN_ESCROW',
    attempt_count: 1,
    last_dispatch_timestamp: NOW,
  });
  const operator = {
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({ offset, next_offset: offset, total: 0, epoch_ids: [] }),
    getPayoutPage: async (offset) => ({ offset, next_offset: offset, total: 0, payouts: [] }),
    getPayout: async () => structuredClone(successor),
  };
  const result = await runV8KeeperOnce({
    config: config(),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
    journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
  });
  assert.equal(result.recovered[0].type, 'DISPATCH');
  assert.equal(result.recovered[0].status, 'PAYOUT_DISPATCHED');
  assert.equal(journal.operations.get(operationId).state, 'VERIFIED');
});

test('recovery polls UNKNOWN and ACCEPTED until the exact submitted epoch is finalized', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const hash = `0x${'4'.padStart(64, '0')}`;
  const epochEndTimestamp = (Math.floor(NOW / 3600) + 3) * 3600;
  const operationId = journal.seedOperation({
    deploymentAlias: 'v8',
    chainId: '4221',
    contractAddress: CONTRACT,
    subjectType: 'epoch',
    subjectId: String(epochEndTimestamp),
    method: 'create_epoch',
    args: [String(epochEndTimestamp)],
    valueAtto: '0',
    signerAddress: KEEPER,
    state: 'SUBMITTED',
    transactionHash: hash,
    lifecycleStatus: 'UNKNOWN',
  });
  const statuses = ['UNKNOWN', 'ACCEPTED', 'FINALIZED'];
  let statusReads = 0;
  let submitCalls = 0;
  const epoch = epochRecord(epochEndTimestamp, { status: 'OPEN' });
  const operator = {
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({
      offset,
      next_offset: offset === 0 ? 1 : offset,
      total: 1,
      epoch_ids: offset === 0 ? [String(epochEndTimestamp)] : [],
    }),
    getEpoch: async () => structuredClone(epoch),
    getPayoutPage: async (offset) => ({ offset, next_offset: offset, total: 0, payouts: [] }),
    getTransactionStatus: async () => statuses[statusReads++],
    waitFinalized: async () => ({
      transactionHash: hash,
      statusName: 'FINALIZED',
      txExecutionResultName: 'FINISHED_WITH_RETURN',
      recipient: CONTRACT,
      txDataDecoded: {
        type: 'call',
        callData: { method: 'create_epoch', args: [String(epochEndTimestamp)] },
      },
    }),
    submitWrite: async () => { submitCalls += 1; },
  };
  const result = await runV8KeeperOnce({
    config: config({ finalityRetries: 3, finalityIntervalMs: 100 }),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
    journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
  });
  assert.equal(statusReads, 3);
  assert.equal(submitCalls, 0);
  assert.equal(result.blocked, false);
  assert.equal(result.recovered[0].status, 'EPOCH_OPEN');
  assert.equal(journal.operations.get(operationId).state, 'VERIFIED');
  assert.equal(journal.operations.get(operationId).transactionHash, hash);
});

test('receipt validation rejects any contract, method, or payout ID mismatch', () => {
  const receipt = {
    transactionHash: `0x${'2'.padStart(64, '0')}`,
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    recipient: CONTRACT,
    txDataDecoded: { type: 'call', callData: { method: 'confirm_payout', args: [PAYOUT] } },
  };
  assert.equal(validateReceiptIdentity(receipt, CONTRACT, 'confirm_payout', [PAYOUT]), receipt);
  assert.throws(() => validateReceiptIdentity(receipt, CONTRACT, 'confirm_payout', ['b'.repeat(64)]), /does not prove/);
});
