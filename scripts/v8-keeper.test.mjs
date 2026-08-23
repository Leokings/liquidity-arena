import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertV8ContractConfiguration,
  assertActionPostState,
  assertAuditedRetryNonceGate,
  assertV8Schema,
  classifyOpenEpoch,
  classifyPayoutAction,
  isProvablyEmptyEpoch,
  plannedDueEpochIds,
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

function emptyObjective(epochEndTimestamp, objective, overrides = {}) {
  return {
    epoch_id: String(epochEndTimestamp),
    objective,
    settlement_mode: 'PENDING',
    winner_asset_id: '',
    winner_return_ppb: '0',
    payout_pool_atto: '0',
    winning_stake_atto: '0',
    losing_stake_atto: '0',
    platform_fee_atto: '0',
    total_stake_atto: '0',
    participant_count: '0',
    paid_atto: '0',
    funded_in_escrow_atto: '0',
    allocated_atto: '0',
    remaining_payout_atto: '0',
    unallocated_payout_atto: '0',
    allocated_not_funded_atto: '0',
    funded_not_withdrawn_atto: '0',
    unclaimed_winning_stake_atto: '0',
    ...overrides,
  };
}

function provablyEmptyEpoch(end, overrides = {}) {
  return epochRecord(end, {
    high: emptyObjective(end, 'HIGH'),
    low: emptyObjective(end, 'LOW'),
    ...overrides,
  });
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

function acceptedReceipt({ transactionHash, method, args, recipient = CONTRACT } = {}) {
  return {
    transactionHash,
    statusName: 'ACCEPTED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    recipient,
    txDataDecoded: { type: 'call', callData: { method, args: [...args] } },
  };
}

function emptyExecutionOperator(overrides = {}) {
  return {
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig(),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({
      offset, next_offset: offset, total: 0, epoch_ids: [],
    }),
    getPayoutPage: async (offset) => ({
      offset, next_offset: offset, total: 0, payouts: [],
    }),
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

test('audited retry nonce gate requires exact latest and pending signer nonces', async () => {
  let reads = 0;
  const operator = {
    getBradburySignerNonces: async () => {
      reads += 1;
      return { latestNonce: '73', pendingNonce: '73' };
    },
  };
  assert.deepEqual(
    await assertAuditedRetryNonceGate({ operator, auditedRetryNonce: '73' }),
    { latestNonce: '73', pendingNonce: '73' },
  );
  assert.equal(reads, 1);
  assert.equal(await assertAuditedRetryNonceGate({ operator, auditedRetryNonce: null }), null);
  assert.equal(reads, 1);
  await assert.rejects(
    assertAuditedRetryNonceGate({
      operator: { getBradburySignerNonces: async () => ({ latestNonce: '74', pendingNonce: '74' }) },
      auditedRetryNonce: '73',
    }),
    /nonce changed/,
  );
  await assert.rejects(
    assertAuditedRetryNonceGate({
      operator: { getBradburySignerNonces: async () => ({ latestNonce: '73', pendingNonce: '74' }) },
      auditedRetryNonce: '73',
    }),
    /nonce changed/,
  );
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

test('exact zero-liability epochs stay open and are reconsidered when stake appears', () => {
  const end = NOW - 120;
  const empty = provablyEmptyEpoch(end);
  assert.equal(isProvablyEmptyEpoch(empty), true);
  assert.equal(classifyOpenEpoch(empty, NOW), null);
  assert.equal(classifyOpenEpoch({ ...empty, timeout_refund_available_timestamp: NOW }, NOW), null);

  const funded = structuredClone(empty);
  funded.high.total_stake_atto = '100000000000000000';
  funded.high.participant_count = '1';
  assert.equal(isProvablyEmptyEpoch(funded), false);
  assert.equal(classifyOpenEpoch(funded, NOW), 'RESOLVE');

  const malformed = structuredClone(empty);
  delete malformed.low.unclaimed_winning_stake_atto;
  assert.equal(isProvablyEmptyEpoch(malformed), false);
  assert.equal(classifyOpenEpoch(malformed, NOW), 'RESOLVE');

  const mismatched = structuredClone(empty);
  mismatched.low.objective = 'HIGH';
  assert.equal(isProvablyEmptyEpoch(mismatched), false);
  assert.equal(classifyOpenEpoch(mismatched, NOW), 'RESOLVE');
});

test('planner rechecks skipped empty epochs and prioritizes missing coverage once stake appears', async () => {
  const dueEnd = NOW - 3_600;
  let dueEpoch = provablyEmptyEpoch(dueEnd);
  const operator = emptyExecutionOperator({
    getEpochPage: async (offset, limit) => ({
      offset,
      next_offset: offset + Math.min(limit, 1 - offset),
      total: 1,
      epoch_ids: offset === 0 ? [String(dueEnd)] : [],
    }),
    getEpoch: async () => structuredClone(dueEpoch),
  });
  const options = {
    config: config({ maxWritesPerRun: 5 }),
    operator,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
  };
  const emptyPlan = await runV8KeeperOnce(options);
  assert.equal(emptyPlan.actions.some(({ type }) => type === 'RESOLVE' || type === 'TIMEOUT'), false);
  assert.ok(emptyPlan.actions.every(({ type }) => type === 'CREATE'));

  dueEpoch = structuredClone(dueEpoch);
  dueEpoch.low.total_stake_atto = '100000000000000000';
  dueEpoch.low.participant_count = '1';
  const fundedPlan = await runV8KeeperOnce(options);
  assert.equal(fundedPlan.actions[0].type, 'CREATE');
  assert.ok(fundedPlan.actions.some(({ type, epochEndTimestamp }) => type === 'RESOLVE' && epochEndTimestamp === dueEnd));
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
  assert.equal(result.actions[0].type, 'CREATE');
  assert.ok(result.actions.some(({ type }) => type === 'DISPATCH'));
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

test('durable epoch rotation keeps a recent lane and cannot starve old funded rounds', () => {
  const epochIds = Array.from({ length: 60 }, (_, index) => NOW - (60 - index) * 3_600);
  const budget = 12;
  const recent = epochIds.slice(-6);
  const visitedOlder = new Set();
  for (let ordinal = 1; ordinal <= 9; ordinal += 1) {
    const selected = plannedDueEpochIds(epochIds, budget, String(ordinal));
    assert.equal(selected.length, budget);
    assert.ok(recent.every((epochId) => selected.includes(epochId)));
    for (const epochId of selected.filter((value) => !recent.includes(value))) visitedOlder.add(epochId);
  }
  assert.equal(visitedOlder.size, epochIds.length - recent.length);
  assert.deepEqual(plannedDueEpochIds(epochIds, 3), epochIds.slice(-3).reverse());
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

test('proven local pre-spawn failure is abandoned with telemetry and retried as attempt two', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  let payout = payoutRecord();
  const events = [];
  const hash = `0x${'f'.repeat(64)}`;
  const operator = emptyExecutionOperator({
    journalClient: journal.client,
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getPayoutPage: async (offset, limit) => ({
      offset,
      next_offset: offset + Math.min(limit, 1 - offset),
      total: 1,
      payouts: offset === 0 ? [structuredClone(payout)] : [],
    }),
    getPayout: async () => structuredClone(payout),
    getPayoutRailState: async () => ({ prepared: true, credited: false, withdrawn: false }),
    submitWrite: async () => {
      throw Object.assign(new Error('GenLayer process could not be started.'), {
        code: 'GENLAYER_PROCESS_NOT_STARTED',
        broadcastAttempted: false,
      });
    },
  });
  const options = {
    config: config({ maxWritesPerRun: 1 }),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: (event) => events.push(event),
    sleep: async () => {},
    journalSessionOptions: {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  };
  await assert.rejects(runV8KeeperOnce(options), (error) => error.code === 'ACTION_FAILURES');
  const first = [...journal.operations.values()][0];
  assert.equal(first.state, 'ABANDONED_PREHASH');
  assert.equal(first.transactionHash, null);
  assert.equal(first.stateReasonCode, 'DEFINITE_LOCAL_PRESPAWN_FAILURE');
  assert.equal(first.prehashAbandonmentEvidence.broadcastAttempted, false);
  assert.deepEqual(Object.keys(first.prehashAbandonmentEvidence).sort(), [
    'arguments', 'broadcastAttempted', 'contractAddress', 'evidenceVersion',
    'failureCode', 'failureMessage', 'logicalOperationId', 'lowerLevelErrorRetained',
    'method', 'operationId', 'preparedAt', 'subjectId', 'subjectType',
    'transactionHashObserved',
  ].sort());
  assert.deepEqual(
    events.filter(({ event }) => event === 'V8_KEEPER_PREHASH_SUBMIT_FAILURE')
      .map(({ failureCode, failureMessage }) => ({ failureCode, failureMessage })),
    [{
      failureCode: 'GENLAYER_PROCESS_NOT_STARTED',
      failureMessage: 'GenLayer process could not be started.',
    }],
  );

  operator.submitWrite = async (method, args, onHash) => {
    await onHash(hash);
    payout = payoutRecord({ state: 'DISPATCHED', attempt_count: 1, last_dispatch_timestamp: NOW });
  };
  operator.getTransactionStatus = async () => 'FINALIZED';
  operator.waitFinalized = async () => ({
    transactionHash: hash,
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    recipient: CONTRACT,
    txDataDecoded: { type: 'call', callData: { method: 'dispatch_payout', args: [PAYOUT] } },
  });
  const result = await runV8KeeperOnce(options);
  assert.equal(result.completed[0].status, 'PAYOUT_DISPATCHED');
  const attempts = [...journal.operations.values()];
  assert.deepEqual(attempts.map(({ attemptNumber }) => attemptNumber), ['1', '2']);
  assert.deepEqual(attempts.map(({ state }) => state), ['ABANDONED_PREHASH', 'VERIFIED']);
  assert.equal(attempts[1].retryOfOperationId, attempts[0].operationId);
});

test('ambiguous hashless CLI failure logs its cause and leaves PREPARED blocking', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const events = [];
  const operator = emptyExecutionOperator({
    journalClient: journal.client,
    getConfig: async () => chainConfig({ new_risk_enabled: false }),
    getPayoutPage: async (offset, limit) => ({
      offset,
      next_offset: offset + Math.min(limit, 1 - offset),
      total: 1,
      payouts: offset === 0 ? [payoutRecord()] : [],
    }),
    getPayout: async () => payoutRecord(),
    getPayoutRailState: async () => ({ prepared: true, credited: false, withdrawn: false }),
    submitWrite: async () => {
      throw Object.assign(new Error('GENLAYER_KEYSTORE_PASSWORD=hunter2\nCLI exited before printing a hash.'), {
        code: 'GENLAYER_PROCESS_ERROR',
        status: 1,
        stdout: 'Connecting to https://rpc.example.invalid with password=hunter2',
        stderr: `Authorization: Bearer very-secret-token\nmnemonic: alpha beta gamma delta\nRPC 503 for 0x${'a'.repeat(64)}; retry later`,
      });
    },
  });
  await assert.rejects(runV8KeeperOnce({
    config: config({ maxWritesPerRun: 1 }),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: (event) => events.push(event),
    sleep: async () => {},
    journalSessionOptions: {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  }), (error) => error.code === 'ACTION_FAILURES');
  const operation = [...journal.operations.values()][0];
  assert.equal(operation.state, 'PREPARED');
  assert.equal(operation.prehashAbandonedAt, null);
  const telemetry = events.find(({ event }) => event === 'V8_KEEPER_PREHASH_SUBMIT_FAILURE');
  assert.equal(telemetry.failureCode, 'GENLAYER_PROCESS_ERROR');
  assert.equal(telemetry.failureMessage, '[redacted] CLI exited before printing a hash.');
  assert.equal(telemetry.lowerLevelCategory, 'RETRYABLE_TRANSPORT');
  assert.equal(telemetry.lowerLevelReason, 'RPC_UNAVAILABLE');
  assert.equal(telemetry.processStatus, 1);
  assert.doesNotMatch(
    JSON.stringify({
      failureMessage: telemetry.failureMessage,
      lowerLevelCategory: telemetry.lowerLevelCategory,
      lowerLevelReason: telemetry.lowerLevelReason,
    }),
    /hunter2|rpc\.example\.invalid|a{64}|very-secret-token|alpha beta gamma/i,
  );
  assert.equal(telemetry.broadcastAttempted, null);
});

test('an abandoned retry attempt cannot authorize attempt three', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const input = {
    deploymentAlias: 'v8',
    chainId: '4221',
    contractAddress: CONTRACT,
    subjectType: 'epoch',
    subjectId: '1800000000',
    method: 'resolve_epoch',
    args: ['1800000000'],
    valueAtto: '0',
  };
  journal.seedOperation({ ...input, signerAddress: KEEPER, state: 'ABANDONED_PREHASH' });
  journal.seedOperation({
    ...input,
    signerAddress: KEEPER,
    state: 'ABANDONED_PREHASH',
    attemptNumber: '2',
  });
  const lease = (await journal.client.acquireLease({
    holderId: '123e4567-e89b-42d3-a456-426614174000',
    signerAddress: KEEPER,
    leaseSeconds: 900,
  })).lease;
  const prepared = await journal.client.prepareOperation({ lease, operation: input });
  assert.equal(prepared.canBroadcast, false);
  assert.equal(prepared.inserted, false);
  assert.equal(prepared.operation.attemptNumber, '2');
  assert.equal(journal.operations.size, 2);
});

test('production timing budget and structural gate sign at most one fresh write per run', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const hash = `0x${'2'.padStart(64, '0')}`;
  const startMs = Date.UTC(2027, 0, 15, 10, 0, 0);
  let nowMs = startMs;
  const submissions = [];
  const operator = {
    journalClient: journal.client,
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
    getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
    getSchema: async () => structuredClone(V8_KEEPER_ABI),
    getConfig: async () => chainConfig(),
    getReserveState: async () => reserveState(),
    getEpochPage: async (offset) => ({ offset, next_offset: offset, total: 0, epoch_ids: [] }),
    getEpoch: async (epochEndTimestamp) => epochRecord(epochEndTimestamp),
    getPayoutPage: async (offset) => ({ offset, next_offset: offset, total: 0, payouts: [] }),
    submitWrite: async (method, args, onHash) => {
      submissions.push({ method, args: [...args] });
      await onHash(hash);
    },
    getTransactionStatus: async () => {
      nowMs += 30 * 60 * 1_000;
      return 'FINALIZED';
    },
    waitFinalized: async () => ({
      transactionHash: hash,
      statusName: 'FINALIZED',
      txExecutionResultName: 'FINISHED_WITH_RETURN',
      recipient: CONTRACT,
      txDataDecoded: {
        type: 'call',
        callData: { method: submissions[0].method, args: submissions[0].args },
      },
    }),
  };
  const result = await runV8KeeperOnce({
    config: config({
      maxWritesPerRun: 2,
      finalityRetries: 480,
      finalityIntervalMs: 5_000,
      postStateAttempts: 5,
      postStateIntervalMs: 2_000,
    }),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
    deadlineAtMs: startMs + 45 * 60 * 1_000,
    clockMs: () => nowMs,
    journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
  });

  assert.equal(result.actions.length, 2);
  assert.equal(submissions.length, 1);
  assert.equal(result.completed.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'ONE_NEW_WRITE_PER_RUN');
  assert.equal(journal.operations.size, 1);
});

test('fifteen-minute ACCEPTED handoffs sustain hourly RESOLVE plus CREATE coverage at thirty-minute finality', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const hourMs = 3_600_000;
  const startMs = Date.UTC(2027, 0, 15, 10, 7, 0);
  let nowMs = startMs;
  let sequence = 0;
  const epochs = new Map();
  const transactions = new Map();
  const submissions = [];
  const hourStartSeconds = Math.floor(startMs / hourMs) * 3_600;
  for (const end of [
    hourStartSeconds - 3_600,
    hourStartSeconds + 3_600,
    hourStartSeconds + 7_200,
  ]) epochs.set(end, epochRecord(end));

  function applyFinalized(transaction) {
    if (transaction.applied) return;
    const epochEndTimestamp = Number(transaction.args[0]);
    if (transaction.method === 'create_epoch') {
      epochs.set(epochEndTimestamp, epochRecord(epochEndTimestamp));
    } else if (transaction.method === 'resolve_epoch') {
      epochs.set(epochEndTimestamp, epochRecord(epochEndTimestamp, {
        status: 'RESOLVED',
        result_status: 'DETERMINED',
        resolution_digest: `0x${'d'.repeat(64)}`,
      }));
    } else {
      throw new Error(`unexpected write ${transaction.method}`);
    }
    transaction.applied = true;
  }

  function settleFinalized() {
    for (const transaction of transactions.values()) {
      if (nowMs - transaction.submittedAtMs >= 30 * 60 * 1_000) {
        applyFinalized(transaction);
      }
    }
  }

  const operator = emptyExecutionOperator({
    getEpochPage: async (offset, limit) => {
      const ids = [...epochs.keys()].sort((left, right) => left - right).map(String);
      const items = ids.slice(offset, offset + limit);
      return {
        offset,
        next_offset: offset + items.length,
        total: ids.length,
        epoch_ids: items,
      };
    },
    getEpoch: async (epochEndTimestamp) => structuredClone(epochs.get(Number(epochEndTimestamp))),
    submitWrite: async (method, args, onHash) => {
      sequence += 1;
      const transactionHash = `0x${sequence.toString(16).padStart(64, '0')}`;
      const transaction = {
        transactionHash,
        method,
        args: args.map(String),
        submittedAtMs: nowMs,
        applied: false,
      };
      transactions.set(transactionHash, transaction);
      submissions.push(transaction);
      await onHash(transactionHash);
    },
    getTransactionStatus: async (transactionHash) => {
      const transaction = transactions.get(transactionHash);
      if (!transaction) throw new Error('unknown simulated transaction');
      if (nowMs - transaction.submittedAtMs >= 30 * 60 * 1_000) {
        applyFinalized(transaction);
        return 'FINALIZED';
      }
      return 'ACCEPTED';
    },
    getAcceptedReceipt: async (transactionHash) => {
      const transaction = transactions.get(transactionHash);
      return acceptedReceipt({
        transactionHash,
        method: transaction.method,
        args: transaction.args,
      });
    },
    waitFinalized: async (transactionHash) => {
      const transaction = transactions.get(transactionHash);
      applyFinalized(transaction);
      return {
        transactionHash,
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        recipient: CONTRACT,
        txDataDecoded: {
          type: 'call',
          callData: { method: transaction.method, args: transaction.args },
        },
      };
    },
  });

  for (let run = 0; run < 32; run += 1) {
    nowMs = startMs + run * 15 * 60 * 1_000;
    settleFinalized();
    if (new Date(nowMs).getUTCMinutes() === 7) {
      const currentHour = Math.floor(nowMs / hourMs) * 3_600;
      assert.equal(epochs.has(currentHour + 3_600), true);
      assert.equal(epochs.has(currentHour + 7_200), true);
    }
    const result = await runV8KeeperOnce({
      config: config({
        maxWritesPerRun: 5,
        finalityRetries: 480,
        finalityIntervalMs: 5_000,
        postStateAttempts: 5,
        postStateIntervalMs: 2_000,
      }),
      execute: true,
      operator,
      journalClient: journal.client,
      nowEpochSeconds: Math.floor(nowMs / 1_000),
      logger: () => {},
      sleep: async () => {},
      deadlineAtMs: nowMs + 45 * 60 * 1_000,
      clockMs: () => nowMs,
      journalSessionOptions: {
        setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
      },
    });
    assert.equal(result.blocked, false);
    assert.ok(result.accepted.length <= 2);
  }

  for (let hour = 1; hour < 8; hour += 1) {
    const lower = startMs + hour * hourMs;
    const upper = lower + hourMs;
    const hourly = submissions.filter(
      ({ submittedAtMs }) => submittedAtMs >= lower && submittedAtMs < upper,
    );
    assert.equal(hourly.filter(({ method }) => method === 'resolve_epoch').length, 1);
    assert.equal(hourly.filter(({ method }) => method === 'create_epoch').length, 1);
  }
  assert.ok(submissions.every(({ method }) => ['create_epoch', 'resolve_epoch'].includes(method)));
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

test('scheduled recovery probes lifecycle nonblocking and never rebroadcasts on status outage', async () => {
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
  const statuses = [
    new Error('temporary Bradbury status transport failure'),
    'UNKNOWN',
    new Error('temporary Bradbury status backend failure'),
    'ACCEPTED',
    'FINALIZED',
  ];
  let statusReads = 0;
  let submitCalls = 0;
  const sleeps = [];
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
    getTransactionStatus: async () => {
      const status = statuses[statusReads++];
      if (status instanceof Error) throw status;
      return status;
    },
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
    config: config({ finalityRetries: 5, finalityIntervalMs: 100 }),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
  });
  assert.equal(statusReads, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(submitCalls, 0);
  assert.equal(result.blocked, true);
  assert.equal(result.pending[0].reason, 'LIFECYCLE_STATUS_UNAVAILABLE');
  assert.equal(journal.operations.get(operationId).state, 'SUBMITTED');
  assert.equal(journal.operations.get(operationId).transactionHash, hash);
});

test('receipt-proven ACCEPTED handoff pipelines one independent subject and suppresses duplicates', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const firstEpoch = Math.ceil((NOW + 7_200) / 3_600) * 3_600;
  const secondEpoch = firstEpoch + 3_600;
  const firstHash = `0x${'8'.repeat(64)}`;
  const secondHash = `0x${'9'.repeat(64)}`;
  const firstOperationId = journal.seedOperation({
    deploymentAlias: 'v8', chainId: '4221', contractAddress: CONTRACT,
    subjectType: 'epoch', subjectId: String(firstEpoch), method: 'create_epoch',
    args: [String(firstEpoch)], valueAtto: '0', signerAddress: KEEPER,
    state: 'SUBMITTED', transactionHash: firstHash, lifecycleStatus: 'UNKNOWN',
  });
  const submissions = [];
  let finalizedReceiptReads = 0;
  const operator = emptyExecutionOperator({
    getTransactionStatus: async () => 'ACCEPTED',
    getAcceptedReceipt: async (transactionHash) => acceptedReceipt({
      transactionHash,
      method: 'create_epoch',
      args: [String(transactionHash === firstHash ? firstEpoch : secondEpoch)],
    }),
    submitWrite: async (method, args, onHash) => {
      submissions.push({ method, args: [...args] });
      await onHash(secondHash);
    },
    waitFinalized: async () => {
      finalizedReceiptReads += 1;
      throw new Error('ACCEPTED handoff must not wait for finality');
    },
  });
  const result = await runV8KeeperOnce({
    config: config({ maxWritesPerRun: 5 }), execute: true, operator,
    journalClient: journal.client, nowEpochSeconds: NOW, logger: () => {},
    sleep: async () => {},
    journalSessionOptions: {
      setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    },
  });

  assert.equal(result.blocked, false);
  assert.deepEqual(submissions, [{ method: 'create_epoch', args: [String(secondEpoch)] }]);
  assert.equal(result.suppressedActionCount, 1);
  assert.equal(result.skipped[0].reason, 'DURABLE_OPERATION_IN_FLIGHT');
  assert.equal(result.accepted.length, 2);
  assert.equal(finalizedReceiptReads, 0);
  const operations = [...journal.operations.values()];
  assert.deepEqual(operations.map((operation) => operation.pipelineSlot).sort(), [0, 1]);
  const successor = operations.find((operation) => operation.operationId !== firstOperationId);
  assert.equal(successor.handoffPredecessorOperationId, firstOperationId);
  assert.equal(successor.lifecycleStatus, 'ACCEPTED');
  assert.equal(successor.acceptanceEvidence.contractAddress, CONTRACT);
  assert.equal(successor.acceptanceEvidence.recipient, CONTRACT);
  assert.equal(successor.acceptanceEvidence.method, 'create_epoch');
  assert.deepEqual(successor.acceptanceEvidence.arguments, [String(secondEpoch)]);
  assert.equal(successor.acceptanceEvidence.txExecutionResultName, 'FINISHED_WITH_RETURN');
  assert.equal(journal.calls.filter(({ method }) => method === 'acceptHandoff').length, 3);

  let thirdSubmissions = 0;
  const capacityResult = await runV8KeeperOnce({
    config: config({ maxWritesPerRun: 5 }),
    execute: true,
    operator: emptyExecutionOperator({
      getTransactionStatus: async () => 'ACCEPTED',
      getAcceptedReceipt: async (transactionHash) => {
        const candidate = operations.find((entry) => entry.transactionHash === transactionHash);
        return acceptedReceipt({
          transactionHash,
          method: candidate.method,
          args: candidate.args,
        });
      },
      getPayoutPage: async (offset) => ({
        offset,
        next_offset: offset === 0 ? 1 : offset,
        total: 1,
        payouts: offset === 0 ? [payoutRecord()] : [],
      }),
      getPayoutRailState: async () => ({ prepared: true, credited: false, withdrawn: false }),
      submitWrite: async () => { thirdSubmissions += 1; },
    }),
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
    journalSessionOptions: {
      setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    },
  });
  assert.equal(capacityResult.blocked, false);
  assert.equal(thirdSubmissions, 0);
  assert.ok(capacityResult.skipped.some(
    ({ reason, payoutId }) => reason === 'KEEPER_PIPELINE_CAPACITY' && payoutId === PAYOUT,
  ));
});

test('an appeal regression from ACCEPTED preserves evidence but blocks every new signature', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const epoch = Math.ceil((NOW + 7_200) / 3_600) * 3_600;
  const hash = `0x${'a'.repeat(64)}`;
  const operationId = journal.seedOperation({
    deploymentAlias: 'v8', chainId: '4221', contractAddress: CONTRACT,
    subjectType: 'epoch', subjectId: String(epoch), method: 'create_epoch',
    args: [String(epoch)], valueAtto: '0', signerAddress: KEEPER,
    state: 'SUBMITTED', transactionHash: hash, lifecycleStatus: 'ACCEPTED',
  });
  const operation = journal.operations.get(operationId);
  operation.acceptedAt = '2027-01-15T09:55:00.000Z';
  operation.acceptanceRevalidatedAt = '2027-01-15T09:56:00.000Z';
  operation.acceptanceEvidence = {
    transactionHash: hash, contractAddress: CONTRACT, recipient: CONTRACT,
    method: 'create_epoch', arguments: [String(epoch)], lifecycleStatus: 'ACCEPTED',
    txExecutionResultName: 'FINISHED_WITH_RETURN', receiptIdentityVerified: true,
    executionVerified: true, executionSucceeded: true,
  };
  let submissions = 0;
  let acceptedReceiptReads = 0;
  const result = await runV8KeeperOnce({
    config: config(), execute: true,
    operator: emptyExecutionOperator({
      getTransactionStatus: async () => 'COMMITTING',
      getAcceptedReceipt: async () => { acceptedReceiptReads += 1; },
      submitWrite: async () => { submissions += 1; },
    }),
    journalClient: journal.client, nowEpochSeconds: NOW, logger: () => {},
    sleep: async () => {},
    journalSessionOptions: {
      setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.pending[0].reason, 'LIFECYCLE_NONFINAL');
  assert.equal(submissions, 0);
  assert.equal(acceptedReceiptReads, 0);
  assert.equal(operation.lifecycleStatus, 'COMMITTING');
  assert.equal(operation.acceptedAt, '2027-01-15T09:55:00.000Z');
  assert.equal(operation.acceptanceEvidence.transactionHash, hash);
});

test('status-only ACCEPTED with a mismatched receipt cannot mint handoff eligibility', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const epoch = Math.ceil((NOW + 7_200) / 3_600) * 3_600;
  const hash = `0x${'c'.repeat(64)}`;
  const operationId = journal.seedOperation({
    deploymentAlias: 'v8', chainId: '4221', contractAddress: CONTRACT,
    subjectType: 'epoch', subjectId: String(epoch), method: 'create_epoch',
    args: [String(epoch)], valueAtto: '0', signerAddress: KEEPER,
    state: 'SUBMITTED', transactionHash: hash, lifecycleStatus: 'UNKNOWN',
  });
  let submissions = 0;
  const result = await runV8KeeperOnce({
    config: config(), execute: true,
    operator: emptyExecutionOperator({
      getTransactionStatus: async () => 'ACCEPTED',
      getAcceptedReceipt: async () => acceptedReceipt({
        transactionHash: hash, method: 'resolve_epoch', args: [String(epoch)],
      }),
      submitWrite: async () => { submissions += 1; },
    }),
    journalClient: journal.client, nowEpochSeconds: NOW, logger: () => {},
    sleep: async () => {},
    journalSessionOptions: {
      setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.pending[0].reason, 'ACCEPTED_RECEIPT_UNPROVEN');
  assert.equal(submissions, 0);
  assert.equal(journal.operations.get(operationId).acceptedAt, null);
  assert.equal(journal.operations.get(operationId).acceptanceEvidence, null);
});

test('recovery revalidates only a finalized generic receipt-identity quarantine', async () => {
  const journal = createMemoryAuthoritativeKeeperJournalClient();
  const hash = `0x${'5'.padStart(64, '0')}`;
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
    state: 'QUARANTINED',
    transactionHash: hash,
    lifecycleStatus: 'FINALIZED',
    stateReasonCode: 'RECEIPT_IDENTITY_AMBIGUOUS',
    quarantineReason: 'RECEIPT_IDENTITY_AMBIGUOUS',
  });
  let submitCalls = 0;
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
    getEpoch: async () => epochRecord(epochEndTimestamp, { status: 'OPEN' }),
    getPayoutPage: async (offset) => ({ offset, next_offset: offset, total: 0, payouts: [] }),
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
    config: config(),
    execute: true,
    operator,
    journalClient: journal.client,
    nowEpochSeconds: NOW,
    logger: () => {},
    sleep: async () => {},
    journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
  });
  const operation = journal.operations.get(operationId);
  assert.equal(submitCalls, 0);
  assert.equal(result.blocked, false);
  assert.equal(result.recovered[0].status, 'EPOCH_OPEN');
  assert.equal(operation.state, 'VERIFIED');
  assert.equal(operation.stateReasonCode, null);
  assert.equal(operation.quarantineReason, null);
  const transitions = journal.calls.filter(({ method }) => method === 'transition');
  assert.deepEqual(transitions.map(({ request }) => request.targetState), [
    'FINALIZED_SUCCESS', 'VERIFIED',
  ]);
  assert.equal(transitions[0].request.metadata.transactionHash, hash);
});

test('receipt hash, contract, method, and argument mismatch quarantines remain terminal', async () => {
  for (const reason of [
    'RECEIPT_HASH_MISMATCH',
    'RECEIPT_CONTRACT_MISMATCH',
    'RECEIPT_METHOD_MISMATCH',
    'RECEIPT_ARGUMENTS_MISMATCH',
  ]) {
    const journal = createMemoryAuthoritativeKeeperJournalClient();
    const hash = `0x${'6'.padStart(64, '0')}`;
    const epochEndTimestamp = (Math.floor(NOW / 3600) + 3) * 3600;
    const operationId = journal.seedOperation({
      deploymentAlias: 'v8', chainId: '4221', contractAddress: CONTRACT,
      subjectType: 'epoch', subjectId: String(epochEndTimestamp), method: 'create_epoch',
      args: [String(epochEndTimestamp)], valueAtto: '0', signerAddress: KEEPER,
      state: 'QUARANTINED', transactionHash: hash, lifecycleStatus: 'FINALIZED',
      stateReasonCode: reason, quarantineReason: reason,
    });
    let receiptReads = 0;
    const result = await runV8KeeperOnce({
      config: config(),
      execute: true,
      operator: {
        canSignLockedAccount: true,
        getNetworkInfo: async () => ({ alias: 'testnet-bradbury', chainId: 4221 }),
        getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
        getSchema: async () => structuredClone(V8_KEEPER_ABI),
        getConfig: async () => chainConfig({ new_risk_enabled: false }),
        getReserveState: async () => reserveState(),
        waitFinalized: async () => { receiptReads += 1; },
      },
      journalClient: journal.client,
      nowEpochSeconds: NOW,
      logger: () => {},
      sleep: async () => {},
      journalSessionOptions: { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} },
    });
    assert.equal(result.blocked, true, reason);
    assert.equal(receiptReads, 0, reason);
    assert.equal(journal.operations.get(operationId).state, 'QUARANTINED', reason);
    assert.equal(journal.operations.get(operationId).quarantineReason, reason, reason);
    assert.equal(journal.calls.some(({ method }) => method === 'transition'), false, reason);
  }
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
