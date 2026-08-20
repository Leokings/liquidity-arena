import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOpenEpoch,
  genlayerRetryAfterMilliseconds,
  runV7KeeperCli,
  runV7KeeperOnce,
  V7KeeperError,
  validateReceiptIdentity,
} from './v7-keeper.mjs';
import {
  normalizeV7KeeperConfig,
  plannedFutureEpochEnds,
  V7_ASSET_IDS,
  V7_POLICY_VERSION,
  V7_PROTOCOL_VERSION,
  V7_VENUES,
} from './v7-keeper-config.mjs';
import { keeperAttemptOperationId } from '../keeper-journal/schema.mjs';
import { createMemoryAuthoritativeKeeperJournalClient } from './authoritative-keeper-journal.test-helper.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const KEEPER = '0x3333333333333333333333333333333333333333';
const TREASURY = '0x4444444444444444444444444444444444444444';
const NOW = Date.UTC(2027, 0, 15, 10, 0, 0) / 1_000;

function config(overrides = {}) {
  const epochDefaults = {
    futureHours: 3,
    minimumCreationLeadSeconds: 7_200,
    minStakeGen: '0.1',
    maxStakePerWalletGen: '10',
  };
  const operatorDefaults = {
    pageSize: 50,
    scanIntervalMs: 0,
    readIntervalMs: 2_500,
    maxEpochReadsPerRun: 8,
    maxWritesPerRun: 12,
    readAttempts: 3,
    retryBaseMs: 0,
    finalityRetries: 2,
    finalityIntervalMs: 100,
    finalityWaitAttempts: 2,
    postStateAttempts: 3,
    postStateIntervalMs: 0,
  };
  return normalizeV7KeeperConfig({
    network: 'studionet',
    contractAddress: CONTRACT,
    expected: {
      platformFeeBps: 200,
      ownerAddress: OWNER,
      keeperAddress: KEEPER,
      treasuryAddress: TREASURY,
      ...(overrides.expected ?? {}),
    },
    epochs: { ...epochDefaults, ...(overrides.epochs ?? {}) },
    operator: { ...operatorDefaults, ...(overrides.operator ?? {}) },
  });
}

function chainConfig(overrides = {}) {
  return {
    protocol_version: V7_PROTOCOL_VERSION,
    policy_version: V7_POLICY_VERSION,
    owner: OWNER,
    pending_owner: `0x${'0'.repeat(40)}`,
    keeper: KEEPER,
    treasury: TREASURY,
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    current_platform_fee_bps: 200,
    default_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: 3_600,
    keeper_max_schedule_ahead_seconds: 26 * 3_600,
    owner_max_schedule_ahead_seconds: 31 * 24 * 3_600,
    wager_open_offset_seconds: 2_400,
    battle_open_offset_seconds: 1_200,
    resolution_publication_delay_seconds: 120,
    timeout_refund_delay_seconds: 86_400,
    minimum_qualified_venues: 3,
    validator_return_tolerance_ppb: 100_000,
    price_scale: 100_000_000,
    return_scale: 1_000_000_000,
    four_venue_median_policy: 'FLOOR_AVERAGE_OF_MIDDLE_TWO',
    rounding_policy: 'LAST_WINNING_CLAIMANT_RECEIVES_REMAINDER',
    supported_objectives: ['HIGH', 'LOW'],
    supported_settlement_modes: [
      'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
      'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
    ],
    transfer_finality: 'FINALIZED',
    ...overrides,
  };
}

function epochRecord(epochEndTimestamp, overrides = {}) {
  return {
    epoch_id: String(epochEndTimestamp),
    epoch_end_timestamp: epochEndTimestamp,
    wager_opens_timestamp: epochEndTimestamp - 2_400,
    wager_closes_timestamp: epochEndTimestamp - 1_200,
    battle_starts_timestamp: epochEndTimestamp - 1_200,
    resolution_available_timestamp: epochEndTimestamp + 120,
    timeout_refund_available_timestamp: epochEndTimestamp + 86_400,
    policy_version: V7_POLICY_VERSION,
    platform_fee_bps_snapshot: 200,
    min_stake_atto: '100000000000000000',
    max_stake_per_wallet_atto: '10000000000000000000',
    status: 'OPEN',
    result_status: 'PENDING',
    resolution_digest: '',
    high: { settlement_mode: 'PENDING' },
    low: { settlement_mode: 'PENDING' },
    ...overrides,
  };
}

function finalizedReceipt(hash, method, args, overrides = {}) {
  return {
    transactionHash: hash,
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    recipient: CONTRACT,
    txDataDecoded: { type: 'call', callData: { method, args: [...args] } },
    ...overrides,
  };
}

function fakeOperator({
  keeperConfig = config(),
  epochs = [],
  configOverride = {},
  receiptOverride,
  mutateWrite,
  journalHarness = createMemoryAuthoritativeKeeperJournalClient(),
} = {}) {
  const state = new Map(epochs.map((record) => [String(record.epoch_end_timestamp), { ...record }]));
  const calls = {
    submits: [], waits: [], statuses: [], pages: [], epochReads: [], configReads: 0,
  };
  const transactions = new Map();
  let hashIndex = 0;
  let writesInFlight = 0;
  let maximumWritesInFlight = 0;

  const defaultMutation = (method, args) => {
    const epochEnd = Number(args[0]);
    if (method === 'create_epoch') {
      state.set(String(epochEnd), epochRecord(epochEnd));
    } else if (method === 'resolve_epoch') {
      state.set(String(epochEnd), {
        ...state.get(String(epochEnd)),
        status: 'RESOLVED',
        result_status: 'DETERMINED',
        resolution_digest: `digest-${epochEnd}`,
      });
    } else {
      state.set(String(epochEnd), {
        ...state.get(String(epochEnd)),
        status: 'TIMED_OUT',
        result_status: 'TIMEOUT',
        resolution_digest: `timeout-${epochEnd}`,
        high: { settlement_mode: 'REFUND_TIMEOUT' },
        low: { settlement_mode: 'REFUND_TIMEOUT' },
      });
    }
  };

  const operator = {
    journalClient: journalHarness.client,
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'studionet' }),
    getAccountInfo: async () => ({ address: KEEPER, active: true, status: 'locked' }),
    getConfig: async () => {
      calls.configReads += 1;
      return chainConfig(configOverride);
    },
    getAssetCatalog: async () => ({
      assets: V7_ASSET_IDS.map((asset_id) => ({ asset_id, quote_asset: 'USDT' })),
    }),
    getVenueCatalog: async () => ({
      venues: [...V7_VENUES],
      adapters_immutable: true,
      candle_interval: '1m',
      start_price_rule: 'OPEN_AT_E_MINUS_20_MINUTES',
      end_price_rule: 'CLOSE_AT_E_MINUS_1_MINUTE',
    }),
    getOpenEpochCount: async () => [...state.values()].filter(({ status }) => status === 'OPEN').length,
    getOpenEpochPage: async (offset, limit) => {
      calls.pages.push([offset, limit]);
      const ids = [...state.entries()]
        .filter(([, record]) => record.status === 'OPEN')
        .map(([id]) => id)
        .sort((left, right) => Number(left) - Number(right));
      const page = ids.slice(offset, offset + limit);
      return {
        offset,
        next_offset: offset + page.length,
        total: ids.length,
        epoch_ids: page,
      };
    },
    getEpoch: async (epochEndTimestamp) => {
      calls.epochReads.push(epochEndTimestamp);
      const record = state.get(String(epochEndTimestamp));
      if (!record) throw new Error(`unknown epoch ${epochEndTimestamp}`);
      return structuredClone(record);
    },
    submitWrite: async (method, args, onTransactionHash) => {
      writesInFlight += 1;
      maximumWritesInFlight = Math.max(maximumWritesInFlight, writesInFlight);
      const hash = `0x${(++hashIndex).toString(16).padStart(64, '0')}`;
      calls.submits.push({ method, args: [...args], hash });
      transactions.set(hash, { method, args: [...args] });
      await onTransactionHash(hash);
      await (mutateWrite
        ? mutateWrite({ method, args, state, hash, defaultMutation })
        : defaultMutation(method, args));
      writesInFlight -= 1;
      return { transactionHash: hash };
    },
    waitFinalized: async (hash) => {
      calls.waits.push(hash);
      const transaction = transactions.get(hash);
      return receiptOverride
        ? receiptOverride({ hash, ...transaction })
        : finalizedReceipt(hash, transaction.method, transaction.args);
    },
    getTransactionStatus: async (hash) => {
      calls.statuses.push(hash);
      return 'FINALIZED';
    },
  };
  return {
    operator,
    calls,
    state,
    keeperConfig,
    journalHarness,
    maximumWritesInFlight: () => maximumWritesInFlight,
  };
}

const silentLogger = () => {};
const noSleep = async () => {};

test('dry-run plans three exact-hour epochs two hours ahead and submits nothing', async () => {
  const keeperConfig = config();
  const fake = fakeOperator({ keeperConfig });
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.deepEqual(result.targetEpochEnds, plannedFutureEpochEnds(keeperConfig, NOW));
  assert.deepEqual(result.actions.map((action) => action.type), ['CREATE', 'CREATE', 'CREATE']);
  assert.equal(result.execute, false);
  assert.equal(result.blocked, undefined);
  assert.deepEqual(fake.calls.submits, []);
});

test('exact resolution and timeout boundaries never overlap', () => {
  const epochEnd = NOW - 3_600;
  const epoch = epochRecord(epochEnd);
  assert.equal(classifyOpenEpoch(epoch, epochEnd + 119), null);
  assert.equal(classifyOpenEpoch(epoch, epochEnd + 120), 'RESOLVE');
  assert.equal(classifyOpenEpoch(epoch, epochEnd + 86_399), 'RESOLVE');
  assert.equal(classifyOpenEpoch(epoch, epochEnd + 86_400), 'TIMEOUT');
  assert.equal(classifyOpenEpoch({ ...epoch, status: 'RESOLVED' }, epochEnd + 90_000), null);
});

test('existing exact epochs and terminal settlements prevent duplicate writes', async () => {
  const keeperConfig = config();
  const targets = plannedFutureEpochEnds(keeperConfig, NOW);
  const dueEnd = NOW - 3_600;
  const fake = fakeOperator({
    keeperConfig,
    epochs: [
      ...targets.map((value) => epochRecord(value)),
      epochRecord(dueEnd, {
        status: 'RESOLVED',
        result_status: 'DETERMINED',
        resolution_digest: 'already-final',
      }),
    ],
  });
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.deepEqual(result.actions, []);
  assert.deepEqual(fake.calls.submits, []);
  assert.deepEqual(fake.calls.epochReads, []);
});

test('serialized execution creates ahead, times out only expired OPEN, and resolves due OPEN', async () => {
  const keeperConfig = config();
  const expiredEnd = NOW - 90_000;
  const resolvableEnd = NOW - 3_600;
  const fake = fakeOperator({
    keeperConfig,
    epochs: [epochRecord(expiredEnd), epochRecord(resolvableEnd)],
  });
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.deepEqual(fake.calls.submits.map(({ method }) => method), [
    'activate_timeout_refund', 'resolve_epoch',
    'create_epoch', 'create_epoch', 'create_epoch',
  ]);
  assert.deepEqual(fake.calls.submits[2].args, [String(result.targetEpochEnds[0])]);
  assert.equal(fake.maximumWritesInFlight(), 1);
  assert.equal(result.completed.length, 5);
  assert.equal(fake.state.get(String(expiredEnd)).status, 'TIMED_OUT');
  assert.equal(fake.state.get(String(resolvableEnd)).status, 'RESOLVED');
  assert.equal(fake.calls.waits.length, 5);
});

test('a contradictory ACCEPTED full receipt is quarantined and never treated as success', async () => {
  const keeperConfig = config();
  const fake = fakeOperator({
    keeperConfig,
    receiptOverride: ({ hash, method, args }) => finalizedReceipt(hash, method, args, {
      statusName: 'ACCEPTED',
    }),
  });

  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(result.completed.length, 0);
  assert.equal(result.pending[0].reason, 'RECEIPT_IDENTITY_AMBIGUOUS');
  assert.equal(result.skipped.length, 2);
  assert.equal(fake.calls.submits.length, 1);
  assert.equal([...fake.journalHarness.operations.values()][0].state, 'QUARANTINED');
});

test('exact FINALIZED execution failure becomes terminal FINALIZED_FAILURE evidence', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  const fake = fakeOperator({
    keeperConfig,
    mutateWrite: async () => {},
    receiptOverride: ({ hash, method, args }) => finalizedReceipt(hash, method, args, {
      txExecutionResultName: 'FINISHED_WITH_ERROR',
    }),
  });

  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(result.completed.length, 0);
  assert.equal(result.pending[0].reason, 'FINALIZED_EXECUTION_FAILED');
  assert.equal(fake.calls.submits.length, 1);
  assert.equal(fake.calls.waits.length, 1);
  assert.equal(fake.state.size, 0);
  assert.equal([...fake.journalHarness.operations.values()][0].state, 'FINALIZED_FAILURE');
  const transition = fake.journalHarness.calls.find(
    ({ method, request }) => method === 'transition'
      && request.targetState === 'FINALIZED_FAILURE',
  );
  assert.equal(transition.request.reasonCode, 'FINALIZED_EXECUTION_FAILED');
  assert.deepEqual(transition.request.metadata, {
    transactionHash: fake.calls.submits[0].hash,
    lifecycleStatus: 'FINALIZED',
    receiptIdentityVerified: true,
    executionVerified: true,
    executionSucceeded: false,
  });
});

test('a later run retries an exact FINALIZED_FAILURE as a new append-only attempt', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  let broadcastCount = 0;
  const fake = fakeOperator({
    keeperConfig,
    mutateWrite: async ({ method, args, defaultMutation }) => {
      broadcastCount += 1;
      if (broadcastCount > 1) defaultMutation(method, args);
    },
    receiptOverride: ({ hash, method, args }) => finalizedReceipt(hash, method, args, {
      txExecutionResultName: broadcastCount === 1
        ? 'FINISHED_WITH_ERROR'
        : 'FINISHED_WITH_RETURN',
    }),
  });

  const firstRun = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(firstRun.completed.length, 0);
  assert.equal(firstRun.pending[0].reason, 'FINALIZED_EXECUTION_FAILED');
  assert.equal(fake.calls.submits.length, 1);

  const firstAttempt = [...fake.journalHarness.operations.values()][0];
  const firstSnapshot = structuredClone(firstAttempt);
  assert.equal(firstAttempt.attemptNumber, '1');
  assert.equal(firstAttempt.operationId, firstAttempt.logicalOperationId);
  assert.equal(firstAttempt.retryOfOperationId, null);
  assert.equal(firstAttempt.state, 'FINALIZED_FAILURE');

  const secondRun = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(secondRun.pending.length, 0);
  assert.equal(secondRun.completed.length, 1);
  assert.equal(fake.calls.submits.length, 2);

  const attempts = [...fake.journalHarness.operations.values()]
    .sort((left, right) => Number(left.attemptNumber) - Number(right.attemptNumber));
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], firstSnapshot);
  assert.equal(attempts[1].logicalOperationId, attempts[0].logicalOperationId);
  assert.equal(attempts[1].attemptNumber, '2');
  assert.equal(attempts[1].retryOfOperationId, attempts[0].operationId);
  assert.equal(
    attempts[1].operationId,
    keeperAttemptOperationId(attempts[0].logicalOperationId, '2'),
  );
  assert.notEqual(attempts[1].transactionHash, attempts[0].transactionHash);
  assert.equal(attempts[1].state, 'VERIFIED');

  const boundAttemptIds = fake.journalHarness.calls
    .filter(({ method }) => method === 'bindSubmission')
    .map(({ request }) => request.operationId);
  assert.deepEqual(boundAttemptIds, attempts.map(({ operationId }) => operationId));
});

test('lightweight lifecycle polling reaches FINALIZED without resubmitting the recorded hash', async () => {
  const keeperConfig = config({
    epochs: { futureHours: 1 },
    operator: { finalityRetries: 7 },
  });
  const fake = fakeOperator({ keeperConfig });
  let statusAttempts = 0;
  const retryDelays = [];
  fake.operator.getTransactionStatus = async () => {
    statusAttempts += 1;
    return statusAttempts <= 6 ? 'PENDING' : 'FINALIZED';
  };

  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: async (delayMs) => retryDelays.push(delayMs),
  });
  assert.equal(result.completed.length, 1);
  assert.equal(statusAttempts, 7);
  assert.equal(retryDelays.filter((delayMs) => delayMs === 100).length, 6);
  assert.equal(fake.calls.submits.length, 1);
  assert.equal(fake.calls.submits[0].hash, result.completed[0].transactionHash);
});

test('receipt identity must prove FINALIZED success for the exact contract method and arguments', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const valid = finalizedReceipt(hash, 'resolve_epoch', [String(NOW)]);
  assert.equal(validateReceiptIdentity(valid, CONTRACT, 'resolve_epoch', [String(NOW)]), valid);
  assert.throws(() => validateReceiptIdentity(
    { ...valid, recipient: OWNER },
    CONTRACT,
    'resolve_epoch',
    [String(NOW)],
  ), /does not prove resolve_epoch/);
  assert.throws(() => validateReceiptIdentity(
    valid,
    CONTRACT,
    'activate_timeout_refund',
    [String(NOW)],
  ), /does not prove activate_timeout_refund/);
});

test('post-state reads retry after FINALIZED and require the intended terminal state', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  let postReadsRemaining = 2;
  const fake = fakeOperator({
    keeperConfig,
    mutateWrite: async ({ method, args, state, defaultMutation }) => {
      if (method === 'create_epoch') {
        const finalRecord = epochRecord(Number(args[0]));
        state.set(String(args[0]), { ...finalRecord, status: 'UNEXPECTED_INDEXER_VALUE' });
        fake.operator.getEpoch = async (epochEndTimestamp) => {
          if (postReadsRemaining > 0) {
            postReadsRemaining -= 1;
            return { ...finalRecord, status: 'UNEXPECTED_INDEXER_VALUE' };
          }
          state.set(String(epochEndTimestamp), finalRecord);
          return structuredClone(finalRecord);
        };
      } else defaultMutation(method, args);
    },
  });

  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(result.completed.length, 1);
  assert.equal(postReadsRemaining, 0);
});

test('transient read failures retry, while a policy mismatch fails before any write', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  const retrying = fakeOperator({ keeperConfig });
  const originalGetConfig = retrying.operator.getConfig;
  let failuresRemaining = 2;
  retrying.operator.getConfig = async () => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error('temporary RPC failure');
    }
    return originalGetConfig();
  };
  await runV7KeeperOnce({
    config: keeperConfig,
    operator: retrying.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(failuresRemaining, 0);

  const mismatched = fakeOperator({
    keeperConfig,
    configOverride: { policy_version: 'WRONG_POLICY' },
  });
  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: mismatched.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), /policy_version must be CRYPTO_SPOT_1M_MEDIAN_V1/);
  assert.deepEqual(mismatched.calls.submits, []);
});

test('StudioNet -32029 backoff honors retry_after_seconds exactly', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  const fake = fakeOperator({ keeperConfig });
  const originalGetConfig = fake.operator.getConfig;
  let failuresRemaining = 1;
  fake.operator.getConfig = async () => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      const error = new Error(
        'RPC error code -32029: {"retry_after_seconds":7}',
      );
      error.code = -32029;
      error.details = { retry_after_seconds: 7 };
      throw error;
    }
    return originalGetConfig();
  };
  const waits = [];
  const events = [];
  await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: (event) => { events.push(event); },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(genlayerRetryAfterMilliseconds({
    stderr: 'error code -32029: {"retry_after_seconds":7}',
  }), 7_000);
  assert.equal(genlayerRetryAfterMilliseconds(new Error('ordinary transport error')), null);
  assert.equal(waits[0], 2_500);
  assert.equal(waits[1], 7_000);
  assert.deepEqual(events.find(({ event }) => event === 'V7_KEEPER_RATE_LIMIT_BACKOFF'), {
    event: 'V7_KEEPER_RATE_LIMIT_BACKOFF',
    label: 'get_config',
    retryAfterSeconds: 7,
  });
});

test('bounded open-index scanning reconciles OPEN epochs older than 30 hours', async () => {
  const keeperConfig = config({
    epochs: { futureHours: 1 },
    operator: {
      pageSize: 2,
      scanIntervalMs: 0,
      maxWritesPerRun: 3,
    },
  });
  const oldOpenEnd = NOW - (72 * 3_600);
  const records = [
    epochRecord(oldOpenEnd),
    ...Array.from({ length: 7 }, (_unused, index) => epochRecord(
      NOW - (7 - index) * 3_600,
      {
        status: 'RESOLVED',
        result_status: 'DETERMINED',
        resolution_digest: `digest-${index}`,
      },
    )),
  ];
  const fake = fakeOperator({ keeperConfig, epochs: records });
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.equal(result.knownEpochCount, 1);
  assert.deepEqual(fake.calls.pages, [[0, 1]]);
  assert.deepEqual(result.actions, [
    { type: 'TIMEOUT', epochEndTimestamp: oldOpenEnd },
    { type: 'CREATE', epochEndTimestamp: plannedFutureEpochEnds(keeperConfig, NOW)[0] },
  ]);
});

test('due-epoch reads are oldest-first and bounded per keeper run', async () => {
  const keeperConfig = config({
    epochs: { futureHours: 1 },
    operator: { maxEpochReadsPerRun: 2 },
  });
  const dueEnds = Array.from(
    { length: 5 },
    (_unused, index) => NOW - (5 - index) * 3_600,
  );
  const fake = fakeOperator({
    keeperConfig,
    epochs: dueEnds.map((epochEnd) => epochRecord(epochEnd)),
  });
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.deepEqual(fake.calls.epochReads, dueEnds.slice(0, 2));
  assert.equal(result.deferredEpochReadCount, 3);
  assert.equal(result.deferredActionCount, 3);
  assert.deepEqual(result.actions.map(({ type }) => type), ['RESOLVE', 'RESOLVE', 'CREATE']);
});

test('all preflight, page, and epoch reads share one quota-aware pacing lane', async () => {
  const keeperConfig = config({
    epochs: { futureHours: 1 },
    operator: { pageSize: 2, readIntervalMs: 2_500 },
  });
  const records = Array.from({ length: 3 }, (_unused, index) => epochRecord(
    NOW - (index + 1) * 3_600,
  ));
  const fake = fakeOperator({ keeperConfig, epochs: records });
  const waits = [];
  await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.deepEqual(fake.calls.pages, [[0, 2], [2, 1]]);
  assert.equal(waits.length, 9);
  assert.ok(waits.every((milliseconds) => milliseconds === 2_500));
});

test('execute requires the dedicated keeper and rejects the owner before any write', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  const fake = fakeOperator({ keeperConfig });
  fake.operator.getAccountInfo = async () => ({ address: OWNER, active: true, status: 'unlocked' });

  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), (error) => {
    assert.equal(error.code, 'KEEPER_MISMATCH');
    return true;
  });
  assert.deepEqual(fake.calls.submits, []);
});

test('every serialized write rechecks the dedicated keeper after local account drift', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const fake = fakeOperator({
    keeperConfig,
    mutateWrite: async ({ method, args, defaultMutation }) => {
      defaultMutation(method, args);
      fake.operator.getAccountInfo = async () => ({
        address: OWNER,
        active: true,
        status: 'unlocked',
      });
    },
  });

  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), (error) => {
    assert.equal(error.code, 'ACTION_FAILURES');
    assert.equal(error.details.summary.completed.length, 1);
    assert.equal(error.details.summary.failures.length, 1);
    assert.equal(error.details.summary.failures[0].code, 'KEEPER_MISMATCH');
    return true;
  });
  assert.equal(fake.calls.submits.length, 1);
});

test('role or immutable stake drift fails closed before any write', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  for (const configOverride of [
    { keeper: OWNER },
    { treasury: OWNER },
    { epoch_min_stake_atto: '1' },
    { keeper_max_schedule_ahead_seconds: 1 },
  ]) {
    const fake = fakeOperator({ keeperConfig, configOverride });
    await assert.rejects(() => runV7KeeperOnce({
      config: keeperConfig,
      operator: fake.operator,
      execute: true,
      nowEpochSeconds: NOW,
      logger: silentLogger,
      sleep: noSleep,
    }), /must be|keeper|treasury/);
    assert.deepEqual(fake.calls.submits, []);
  }
});

test('authoritative PREPARE failure permits zero broadcasts', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const journalHarness = createMemoryAuthoritativeKeeperJournalClient({
    hooks: {
      prepareOperation: async () => { throw new Error('Neon unavailable'); },
    },
  });
  const fake = fakeOperator({ keeperConfig, journalHarness });

  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), (error) => {
    assert.equal(error.code, 'ACTION_FAILURES');
    assert.match(error.details.summary.failures[0].message, /Neon unavailable/);
    return true;
  });
  assert.equal(fake.calls.submits.length, 0);
});

test('journal schema readiness fails before lease acquisition and every broadcast', async () => {
  const keeperConfig = config({ epochs: { futureHours: 1 } });
  const journalHarness = createMemoryAuthoritativeKeeperJournalClient({
    hooks: {
      health: async () => ({
        status: 'degraded',
        service: 'liquidity-arena-keeper-journal',
        ready: false,
        network: 'studionet',
        chainId: '61999',
        configuration: {
          databaseConfigured: true,
          authenticationConfigured: true,
          signerConfigured: true,
        },
        database: { configured: true, ready: false, schemaVersion: 2 },
      }),
    },
  });
  const fake = fakeOperator({ keeperConfig, journalHarness });

  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), (error) => {
    assert.equal(error.code, 'KEEPER_JOURNAL_NOT_READY');
    return true;
  });
  assert.deepEqual(journalHarness.calls.map(({ method }) => method), ['health']);
  assert.equal(fake.calls.submits.length, 0);
});

test('hash binding failure leaves PREPARED authority and stops after the first broadcast', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const journalHarness = createMemoryAuthoritativeKeeperJournalClient({
    hooks: {
      bindSubmission: async () => { throw new Error('Neon bind unavailable'); },
    },
  });
  const fake = fakeOperator({ keeperConfig, journalHarness });

  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), (error) => {
    assert.equal(error.code, 'ACTION_FAILURES');
    assert.match(error.details.summary.failures[0].message, /Neon bind unavailable/);
    return true;
  });
  assert.equal(fake.calls.submits.length, 1);
  assert.equal([...journalHarness.operations.values()][0].state, 'PREPARED');
  assert.equal([...journalHarness.operations.values()][0].transactionHash, null);
});

test('a PREPARED operation without a durable hash blocks planning and every write', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const target = plannedFutureEpochEnds(keeperConfig, NOW)[0];
  const journalHarness = createMemoryAuthoritativeKeeperJournalClient();
  journalHarness.seedOperation({
    signerAddress: KEEPER,
    state: 'PREPARED',
    deploymentAlias: 'v7',
    chainId: '61999',
    contractAddress: CONTRACT,
    method: 'create_epoch',
    args: [String(target)],
    valueAtto: '0',
    epochEndTimestamp: String(target),
  });
  const fake = fakeOperator({ keeperConfig, journalHarness });
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.equal(result.blocked, true);
  assert.equal(result.pending[0].reason, 'PREPARED_WITHOUT_DURABLE_HASH');
  assert.deepEqual(result.actions, []);
  assert.deepEqual(fake.calls.submits, []);
  assert.deepEqual(fake.calls.pages, []);
});

test('UNKNOWN lifecycle blocks all writes without consulting a full receipt', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const target = plannedFutureEpochEnds(keeperConfig, NOW)[0];
  const hash = `0x${'9'.repeat(64)}`;
  const journalHarness = createMemoryAuthoritativeKeeperJournalClient();
  journalHarness.seedOperation({
    signerAddress: KEEPER,
    state: 'SUBMITTED',
    transactionHash: hash,
    deploymentAlias: 'v7',
    chainId: '61999',
    contractAddress: CONTRACT,
    method: 'create_epoch',
    args: [String(target)],
    valueAtto: '0',
    epochEndTimestamp: String(target),
  });
  const fake = fakeOperator({ keeperConfig, journalHarness });
  fake.operator.getTransactionStatus = async () => 'UNKNOWN';
  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.equal(result.pending[0].reason, 'LIFECYCLE_UNKNOWN');
  assert.deepEqual(fake.calls.submits, []);
  assert.deepEqual(fake.calls.waits, []);
});

test('raw FINALIZED with an unindexed full receipt blocks the second planned write', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const fake = fakeOperator({ keeperConfig });
  fake.operator.waitFinalized = async () => { throw new Error('transaction not found'); };

  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].reason, 'FINALIZED_RECEIPT_NOT_INDEXED');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'BLOCKED_BY_NONTERMINAL_OPERATION');
  assert.equal(fake.calls.submits.length, 1);
  assert.equal([...fake.journalHarness.operations.values()][0].state, 'SUBMITTED');
  assert.equal([...fake.journalHarness.operations.values()][0].lifecycleStatus, 'FINALIZED');
});

test('full receipt hash mismatch is quarantined with exact bounded evidence', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  const fake = fakeOperator({
    keeperConfig,
    receiptOverride: ({ hash, method, args }) => finalizedReceipt(hash, method, args, {
      transactionHash: `0x${'f'.repeat(64)}`,
    }),
  });

  const result = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(result.pending[0].reason, 'RECEIPT_HASH_MISMATCH');
  assert.equal(result.skipped.length, 1);
  assert.equal(fake.calls.submits.length, 1);
  assert.equal([...fake.journalHarness.operations.values()][0].state, 'QUARANTINED');
  const transition = fake.journalHarness.calls.find(
    ({ method, request }) => method === 'transition' && request.targetState === 'QUARANTINED',
  );
  assert.deepEqual(transition.request.metadata, {
    transactionHash: fake.calls.submits[0].hash,
    lifecycleStatus: 'FINALIZED',
    receiptIdentityVerified: false,
    ambiguityCode: 'RECEIPT_HASH_MISMATCH',
  });
});

test('method, argument, and malformed identity receipts get distinct quarantine evidence', async () => {
  const cases = [
    {
      code: 'RECEIPT_METHOD_MISMATCH',
      override: ({ hash, args }) => finalizedReceipt(hash, 'resolve_epoch', args),
    },
    {
      code: 'RECEIPT_ARGUMENTS_MISMATCH',
      override: ({ hash, method }) => finalizedReceipt(hash, method, [String(NOW)]),
    },
    {
      code: 'RECEIPT_IDENTITY_AMBIGUOUS',
      override: ({ hash, method, args }) => finalizedReceipt(hash, method, args, {
        txDataDecoded: null,
      }),
    },
  ];
  for (const { code, override } of cases) {
    const keeperConfig = config({ epochs: { futureHours: 1 } });
    const fake = fakeOperator({ keeperConfig, receiptOverride: override });
    const result = await runV7KeeperOnce({
      config: keeperConfig,
      operator: fake.operator,
      execute: true,
      nowEpochSeconds: NOW,
      logger: silentLogger,
      sleep: noSleep,
    });
    assert.equal(result.pending[0].reason, code);
    assert.equal([...fake.journalHarness.operations.values()][0].state, 'QUARANTINED');
    const transition = fake.journalHarness.calls.find(
      ({ method, request }) => method === 'transition' && request.targetState === 'QUARANTINED',
    );
    assert.equal(transition.request.reasonCode, code);
    assert.equal(transition.request.metadata.ambiguityCode, code);
    assert.equal(transition.request.metadata.receiptIdentityVerified, false);
  }
});

test('a failed lease heartbeat prevents every later write', async () => {
  const keeperConfig = config({ epochs: { futureHours: 2 } });
  let renewals = 0;
  let heartbeat;
  const journalHarness = createMemoryAuthoritativeKeeperJournalClient({
    hooks: {
      renewLease: async () => {
        renewals += 1;
        if (renewals === 4) throw new Error('lease renewal unavailable');
      },
    },
  });
  const fake = fakeOperator({ keeperConfig, journalHarness });
  fake.operator.getTransactionStatus = async () => {
    heartbeat();
    await new Promise((resolve) => setImmediate(resolve));
    return 'FINALIZED';
  };

  await assert.rejects(() => runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
    journalSessionOptions: {
      heartbeatMs: 1,
      setIntervalImpl: (callback) => {
        heartbeat = callback;
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    },
  }), (error) => {
    assert.equal(error.code, 'KEEPER_JOURNAL_LEASE_LOST');
    return true;
  });
  assert.equal(fake.calls.submits.length, 1);
});

test('a receipt invisible beyond 315 seconds is recovered across runs without resubmission', async () => {
  const keeperConfig = config({
    epochs: { futureHours: 2 },
    operator: {
      retryBaseMs: 5_000,
      finalityIntervalMs: 5_000,
      finalityRetries: 65,
    },
  });
  const targets = plannedFutureEpochEnds(keeperConfig, NOW);
  let firstHash;
  let rawFinalized = false;
  const fake = fakeOperator({
    keeperConfig,
    mutateWrite: async ({ method, args, hash, defaultMutation }) => {
      if (!firstHash) {
        firstHash = hash;
        return;
      }
      defaultMutation(method, args);
    },
  });
  fake.operator.getTransactionStatus = async () => (rawFinalized ? 'FINALIZED' : 'PENDING');
  const delays = [];

  const firstRun = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(firstRun.pending.length, 1);
  assert.equal(firstRun.completed.length, 0);
  assert.equal(firstRun.skipped.length, 1);
  assert.equal(fake.calls.submits.length, 1);
  assert.ok(delays.filter((value) => value === 5_000)
    .reduce((total, value) => total + value, 0) > 315_000);
  assert.equal([...fake.journalHarness.operations.values()][0].transactionHash, firstHash);

  const secondRun = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(secondRun.pending.length, 1);
  assert.equal(secondRun.pending[0].transactionHash, firstHash);
  assert.equal(secondRun.blocked, true);
  assert.equal(fake.calls.submits.length, 1);

  fake.state.set(String(targets[0]), epochRecord(targets[0]));
  fake.state.set(String(targets[1]), epochRecord(targets[1]));
  rawFinalized = true;
  const thirdRun = await runV7KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(thirdRun.recovered.length, 1);
  assert.equal(thirdRun.recovered[0].transactionHash, firstHash);
  assert.equal(fake.calls.submits.length, 1);
  assert.equal([...fake.journalHarness.operations.values()][0].state, 'VERIFIED');
});

test('V7 CLI rejects a blocked summary only after the keeper run has emitted it', async () => {
  const blockedSummary = Object.freeze({
    execute: true,
    blocked: true,
    pending: Object.freeze([{ reason: 'FINALIZED_RECEIPT_NOT_INDEXED' }]),
    failures: Object.freeze([]),
  });
  const order = [];
  const environment = Object.freeze({ KEEPER_JOURNAL_SECRET: 'test-secret' });
  const keeperConfig = Object.freeze({ network: 'studionet' });
  const operator = Object.freeze({});
  const journalClient = Object.freeze({});

  await assert.rejects(
    () => runV7KeeperCli(['--config', 'unused.json', '--execute'], {
      environment,
      loadConfig: (path) => {
        assert.equal(path, 'unused.json');
        return keeperConfig;
      },
      createOperator: (options) => {
        assert.deepEqual(options, { config: keeperConfig, environment });
        return operator;
      },
      createJournalClient: (receivedEnvironment) => {
        assert.equal(receivedEnvironment, environment);
        return journalClient;
      },
      runOnce: async (options) => {
        assert.deepEqual(options, {
          config: keeperConfig,
          execute: true,
          operator,
          journalClient,
        });
        order.push('blocked-summary-emitted');
        return blockedSummary;
      },
    }),
    (error) => {
      order.push('cli-rejected');
      assert.ok(error instanceof V7KeeperError);
      assert.equal(error.code, 'RUN_BLOCKED');
      assert.equal(error.details.summary, blockedSummary);
      return true;
    },
  );
  assert.deepEqual(order, ['blocked-summary-emitted', 'cli-rejected']);
});
