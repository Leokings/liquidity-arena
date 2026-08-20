import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOpenEpoch,
  runV6KeeperOnce,
  V6KeeperError,
  validateReceiptIdentity,
} from './v6-keeper.mjs';
import {
  normalizeV6KeeperConfig,
  plannedFutureEpochEnds,
  V6_ASSET_IDS,
  V6_POLICY_VERSION,
  V6_PROTOCOL_VERSION,
  V6_VENUES,
} from './v6-keeper-config.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
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
    maxWritesPerRun: 12,
    readAttempts: 3,
    retryBaseMs: 0,
    finalityRetries: 2,
    finalityIntervalMs: 100,
    finalityWaitAttempts: 2,
    postStateAttempts: 3,
    postStateIntervalMs: 0,
  };
  return normalizeV6KeeperConfig({
    network: 'studionet',
    contractAddress: CONTRACT,
    expected: { platformFeeBps: 200, ...(overrides.expected ?? {}) },
    epochs: { ...epochDefaults, ...(overrides.epochs ?? {}) },
    operator: { ...operatorDefaults, ...(overrides.operator ?? {}) },
  });
}

function chainConfig(overrides = {}) {
  return {
    protocol_version: V6_PROTOCOL_VERSION,
    policy_version: V6_POLICY_VERSION,
    owner: OWNER,
    treasury: OWNER,
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    current_platform_fee_bps: 200,
    default_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
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
    policy_version: V6_POLICY_VERSION,
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
} = {}) {
  const state = new Map(epochs.map((record) => [String(record.epoch_end_timestamp), { ...record }]));
  const calls = {
    submits: [], waits: [], pages: [], epochReads: [], configReads: 0,
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
    canSignLockedAccount: true,
    getNetworkInfo: async () => ({ alias: 'studionet' }),
    getAccountInfo: async () => ({ address: OWNER, active: true, status: 'locked' }),
    getConfig: async () => {
      calls.configReads += 1;
      return chainConfig(configOverride);
    },
    getAssetCatalog: async () => ({
      assets: V6_ASSET_IDS.map((asset_id) => ({ asset_id, quote_asset: 'USDT' })),
    }),
    getVenueCatalog: async () => ({
      venues: [...V6_VENUES],
      adapters_immutable: true,
      candle_interval: '1m',
      start_price_rule: 'OPEN_AT_E_MINUS_20_MINUTES',
      end_price_rule: 'CLOSE_AT_E_MINUS_1_MINUTE',
    }),
    getEpochCount: async () => state.size,
    getEpochPage: async (offset, limit) => {
      calls.pages.push([offset, limit]);
      const ids = [...state.keys()].sort((left, right) => Number(left) - Number(right));
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
      onTransactionHash(hash);
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
  };
  return { operator, calls, state, keeperConfig, maximumWritesInFlight: () => maximumWritesInFlight };
}

const silentLogger = () => {};
const noSleep = async () => {};

test('dry-run plans three exact-hour epochs two hours ahead and submits nothing', async () => {
  const keeperConfig = config();
  const fake = fakeOperator({ keeperConfig });
  const result = await runV6KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.deepEqual(result.targetEpochEnds, plannedFutureEpochEnds(keeperConfig, NOW));
  assert.deepEqual(result.actions.map((action) => action.type), ['CREATE', 'CREATE', 'CREATE']);
  assert.equal(result.execute, false);
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

test('legacy V6 scheduler rejects execution before any write', async () => {
  const keeperConfig = config();
  const fake = fakeOperator({ keeperConfig });

  await assert.rejects(() => runV6KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), (error) => {
    assert.ok(error instanceof V6KeeperError);
    assert.equal(error.code, 'V6_EXECUTION_DISABLED');
    return true;
  });
  assert.deepEqual(fake.calls.submits, []);
  assert.deepEqual(fake.calls.waits, []);
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
  await runV6KeeperOnce({
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
  await assert.rejects(() => runV6KeeperOnce({
    config: keeperConfig,
    operator: mismatched.operator,
    execute: true,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  }), /policy_version must be CRYPTO_SPOT_1M_MEDIAN_V1/);
  assert.deepEqual(mismatched.calls.submits, []);
});

test('complete paginated history scanning reconciles OPEN epochs older than 30 hours', async () => {
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
  const result = await runV6KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: noSleep,
  });

  assert.equal(result.knownEpochCount, 8);
  assert.deepEqual(fake.calls.pages, [[0, 2], [2, 2], [4, 2], [6, 2]]);
  assert.deepEqual(result.actions, [
    { type: 'TIMEOUT', epochEndTimestamp: oldOpenEnd },
    { type: 'CREATE', epochEndTimestamp: plannedFutureEpochEnds(keeperConfig, NOW)[0] },
  ]);
});

test('full history reconciliation paces bounded page and epoch reads', async () => {
  const keeperConfig = config({
    epochs: { futureHours: 1 },
    operator: { pageSize: 2, scanIntervalMs: 17 },
  });
  const records = Array.from({ length: 3 }, (_unused, index) => epochRecord(
    NOW - (index + 1) * 3_600,
    {
      status: 'RESOLVED',
      result_status: 'DETERMINED',
      resolution_digest: `digest-${index}`,
    },
  ));
  const fake = fakeOperator({ keeperConfig, epochs: records });
  const waits = [];
  await runV6KeeperOnce({
    config: keeperConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    logger: silentLogger,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.deepEqual(fake.calls.pages, [[0, 2], [2, 1]]);
  assert.deepEqual(waits, [17, 17, 17]);
});
