import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  planV6DrainRun,
  runV6DrainOnce,
  V6DrainError,
} from './v6-drain.mjs';
import {
  normalizeV6KeeperConfig,
  V6_ASSET_IDS,
  V6_POLICY_VERSION,
  V6_PROTOCOL_VERSION,
  V6_VENUES,
} from './v6-keeper-config.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const PERMISSIONLESS_SIGNER = '0x3333333333333333333333333333333333333333';
const NOW = Date.UTC(2027, 0, 15, 10, 0, 0) / 1_000;

function config(overrides = {}) {
  return normalizeV6KeeperConfig({
    network: 'studionet',
    contractAddress: CONTRACT,
    expected: { platformFeeBps: 200 },
    epochs: {
      futureHours: 3,
      minimumCreationLeadSeconds: 7_200,
      minStakeGen: '0.1',
      maxStakePerWalletGen: '10',
    },
    operator: {
      pageSize: 2,
      scanIntervalMs: 0,
      maxWritesPerRun: 12,
      readAttempts: 2,
      retryBaseMs: 0,
      finalityRetries: 2,
      finalityIntervalMs: 100,
      finalityWaitAttempts: 2,
      postStateAttempts: 2,
      postStateIntervalMs: 0,
      ...(overrides.operator ?? {}),
    },
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
  epochs,
  receiptOverride,
  account = { address: PERMISSIONLESS_SIGNER, active: true, status: 'locked' },
  canSignLockedAccount = true,
  pageOverride,
} = {}) {
  const state = new Map(epochs.map((record) => [String(record.epoch_end_timestamp), structuredClone(record)]));
  const calls = { submits: [], waits: [], pages: [], epochReads: [], sequence: [] };
  const transactions = new Map();
  let hashIndex = 0;
  let writesInFlight = 0;
  let maximumWritesInFlight = 0;

  const operator = {
    canSignLockedAccount,
    getNetworkInfo: async () => ({ alias: 'studionet' }),
    getAccountInfo: async () => account,
    getConfig: async () => chainConfig(),
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
      const result = {
        offset,
        next_offset: offset + page.length,
        total: ids.length,
        epoch_ids: page,
      };
      return pageOverride ? pageOverride(result) : result;
    },
    getEpoch: async (epochEndTimestamp) => {
      calls.sequence.push(`read:${epochEndTimestamp}`);
      calls.epochReads.push(epochEndTimestamp);
      const record = state.get(String(epochEndTimestamp));
      if (!record) throw new Error(`unknown epoch ${epochEndTimestamp}`);
      return structuredClone(record);
    },
    submitWrite: async (method, args, onTransactionHash) => {
      writesInFlight += 1;
      maximumWritesInFlight = Math.max(maximumWritesInFlight, writesInFlight);
      calls.sequence.push(`submit:${method}:${args[0]}`);
      const hash = `0x${(++hashIndex).toString(16).padStart(64, '0')}`;
      calls.submits.push({ method, args: [...args], hash });
      transactions.set(hash, { method, args: [...args] });
      onTransactionHash(hash);
      const epochEnd = Number(args[0]);
      if (method === 'resolve_epoch') {
        state.set(String(epochEnd), {
          ...state.get(String(epochEnd)),
          status: 'RESOLVED',
          result_status: 'DETERMINED',
          resolution_digest: `digest-${epochEnd}`,
          high: { settlement_mode: 'PARIMUTUEL' },
          low: { settlement_mode: 'REFUND_UNBACKED_WINNER' },
        });
      } else if (method === 'activate_timeout_refund') {
        state.set(String(epochEnd), {
          ...state.get(String(epochEnd)),
          status: 'TIMED_OUT',
          result_status: 'TIMEOUT',
          resolution_digest: `timeout-${epochEnd}`,
          high: { settlement_mode: 'REFUND_TIMEOUT' },
          low: { settlement_mode: 'REFUND_TIMEOUT' },
        });
      } else {
        throw new Error(`unexpected drain method ${method}`);
      }
      writesInFlight -= 1;
      return { transactionHash: hash };
    },
    waitFinalized: async (hash) => {
      calls.sequence.push(`wait:${hash}`);
      calls.waits.push(hash);
      const transaction = transactions.get(hash);
      return receiptOverride
        ? receiptOverride({ hash, ...transaction })
        : finalizedReceipt(hash, transaction.method, transaction.args);
    },
  };
  return { operator, calls, state, maximumWritesInFlight: () => maximumWritesInFlight };
}

const noSleep = async () => {};
const silentLogger = () => {};

function sampleEpochs() {
  return [
    epochRecord(NOW - 2 * 86_400),
    epochRecord(NOW - 3_600),
    epochRecord(NOW + 3_600),
    epochRecord(NOW - 3 * 86_400, {
      status: 'RESOLVED',
      result_status: 'DETERMINED',
      resolution_digest: 'already-final',
      high: { settlement_mode: 'PARIMUTUEL' },
      low: { settlement_mode: 'PARIMUTUEL' },
    }),
  ];
}

test('drain scans the complete paged V6 snapshot and only plans timeout/resolve work', async () => {
  const drainConfig = config();
  const fake = fakeOperator({ epochs: sampleEpochs() });
  const result = await runV6DrainOnce({
    config: drainConfig,
    operator: fake.operator,
    nowEpochSeconds: NOW,
    sleep: noSleep,
    logger: silentLogger,
  });

  assert.equal(result.scannedEpochCount, 4);
  assert.equal(result.openEpochCount, 3);
  assert.deepEqual(result.actions, [
    { type: 'TIMEOUT', epochEndTimestamp: NOW - 2 * 86_400 },
    { type: 'RESOLVE', epochEndTimestamp: NOW - 3_600 },
  ]);
  assert.deepEqual(fake.calls.pages, [[0, 2], [2, 2]]);
  assert.deepEqual(fake.calls.submits, []);
});

test('any active StudioNet signer can execute and each exact write finalizes before the next', async () => {
  const fake = fakeOperator({ epochs: sampleEpochs() });
  const result = await runV6DrainOnce({
    config: config(),
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    sleep: noSleep,
    logger: silentLogger,
  });

  assert.equal(result.signer, PERMISSIONLESS_SIGNER);
  assert.notEqual(result.signer, OWNER);
  assert.deepEqual(fake.calls.submits.map(({ method }) => method), [
    'activate_timeout_refund',
    'resolve_epoch',
  ]);
  assert.equal(fake.maximumWritesInFlight(), 1);
  const firstWait = fake.calls.sequence.findIndex((entry) => entry.startsWith('wait:'));
  const secondSubmit = fake.calls.sequence.findIndex(
    (entry) => entry === `submit:resolve_epoch:${NOW - 3_600}`,
  );
  assert.ok(firstWait >= 0 && firstWait < secondSubmit);
  assert.deepEqual(result.completed.map(({ status }) => status), ['TIMED_OUT', 'RESOLVED']);
});

test('receipt propagation retries the recorded hash with finality-paced backoff', async () => {
  const fake = fakeOperator({ epochs: [epochRecord(NOW - 3_600)] });
  const originalWait = fake.operator.waitFinalized;
  const retryDelays = [];
  let waitAttempts = 0;
  fake.operator.waitFinalized = async (hash, policy) => {
    waitAttempts += 1;
    if (waitAttempts === 1) throw new Error('transaction not found');
    return originalWait(hash, policy);
  };

  const result = await runV6DrainOnce({
    config: config(),
    operator: fake.operator,
    execute: true,
    nowEpochSeconds: NOW,
    sleep: async (delayMs) => retryDelays.push(delayMs),
    logger: silentLogger,
  });

  assert.equal(result.completed.length, 1);
  assert.equal(waitAttempts, 2);
  assert.deepEqual(retryDelays, [100]);
  assert.equal(fake.calls.submits.length, 1);
});

test('locked signer without a password is rejected even though owner identity is irrelevant', async () => {
  const fake = fakeOperator({
    epochs: sampleEpochs(),
    canSignLockedAccount: false,
  });
  await assert.rejects(
    runV6DrainOnce({
      config: config(),
      operator: fake.operator,
      execute: true,
      nowEpochSeconds: NOW,
      sleep: noSleep,
      logger: silentLogger,
    }),
    (error) => error instanceof V6DrainError && error.code === 'ACCOUNT_LOCKED',
  );
  assert.equal(fake.calls.submits.length, 0);
});

test('a mismatched FINALIZED receipt fails closed before post-state can certify the action', async () => {
  const fake = fakeOperator({
    epochs: [epochRecord(NOW - 3_600)],
    receiptOverride: ({ hash, method, args }) => finalizedReceipt(hash, method, args, {
      recipient: OWNER,
    }),
  });
  await assert.rejects(
    runV6DrainOnce({
      config: config(),
      operator: fake.operator,
      execute: true,
      nowEpochSeconds: NOW,
      sleep: noSleep,
      logger: silentLogger,
    }),
    (error) => {
      assert.equal(error.code, 'ACTION_FAILURES');
      assert.equal(error.details.summary.failures.length, 1);
      assert.match(error.details.summary.failures[0].message, /does not prove resolve_epoch/);
      return true;
    },
  );
});

test('pagination ambiguity is rejected and the drain source has no epoch-creation call', async () => {
  const fake = fakeOperator({
    epochs: sampleEpochs(),
    pageOverride: (page) => ({ ...page, next_offset: page.offset }),
  });
  const context = {
    config: config(),
    operator: fake.operator,
    nowEpochSeconds: NOW,
    sleep: noSleep,
  };
  await assert.rejects(planV6DrainRun(context), /inconsistent snapshot pagination/);

  const source = readFileSync(new URL('./v6-drain.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /create_epoch/);
});
