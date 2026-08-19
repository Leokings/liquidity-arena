import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTIVITY_STORAGE_KEY,
  loadClaimActivityFile,
  monitorClaimDeliveriesOnce,
  normalizeClaimMonitorTargets,
} from './claim-delivery-monitor.mjs';
import {
  normalizeV6KeeperConfig,
  V6_ASSET_IDS,
  V6_POLICY_VERSION,
  V6_PROTOCOL_VERSION,
  V6_VENUES,
} from './v6-keeper-config.mjs';
import {
  normalizeV7KeeperConfig,
  V7_ASSET_IDS,
  V7_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS,
  V7_MINIMUM_EPOCH_CREATION_LEAD_SECONDS,
  V7_OWNER_MAX_SCHEDULE_AHEAD_SECONDS,
  V7_POLICY_VERSION,
  V7_PROTOCOL_VERSION,
  V7_VENUES,
} from './v7-keeper-config.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const CLAIMANT = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x4444444444444444444444444444444444444444';
const EPOCH = 1_800_000_000;
const AMOUNT = 198_000_000_000_000_000n;
const parentHash = `0x${'a'.repeat(64)}`;
const childHash = `0x${'b'.repeat(64)}`;

function config() {
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
      pageSize: 50,
      scanIntervalMs: 0,
      maxWritesPerRun: 12,
      readAttempts: 2,
      retryBaseMs: 0,
      finalityRetries: 2,
      finalityIntervalMs: 100,
      finalityWaitAttempts: 2,
      postStateAttempts: 2,
      postStateIntervalMs: 0,
    },
  });
}

function v7Config() {
  return normalizeV7KeeperConfig({
    network: 'studionet',
    contractAddress: CONTRACT,
    expected: {
      platformFeeBps: 200,
      ownerAddress: OWNER,
      keeperAddress: KEEPER,
      treasuryAddress: OWNER,
    },
    epochs: {
      futureHours: 24,
      minimumCreationLeadSeconds: 7_200,
      minStakeGen: '0.1',
      maxStakePerWalletGen: '10',
    },
    operator: {
      readIntervalMs: 2_500,
      finalityRetries: 2,
      finalityIntervalMs: 100,
    },
  });
}

function chainConfig() {
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
  };
}

function v7ChainConfig() {
  return {
    ...chainConfig(),
    protocol_version: V7_PROTOCOL_VERSION,
    policy_version: V7_POLICY_VERSION,
    owner: OWNER,
    pending_owner: '0x0000000000000000000000000000000000000000',
    keeper: KEEPER,
    treasury: OWNER,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: V7_MINIMUM_EPOCH_CREATION_LEAD_SECONDS,
    keeper_max_schedule_ahead_seconds: V7_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS,
    owner_max_schedule_ahead_seconds: V7_OWNER_MAX_SCHEDULE_AHEAD_SECONDS,
  };
}

function parentTransaction(overrides = {}) {
  return {
    hash: parentHash,
    tx_id: parentHash,
    from_address: CLAIMANT,
    sender: CLAIMANT,
    to_address: CONTRACT,
    recipient: CONTRACT,
    type: 2n,
    value: 0n,
    status: 'FINALIZED',
    messages: [{
      messageType: 0n,
      recipient: CLAIMANT,
      value: AMOUNT,
      data: '',
      onAcceptance: false,
    }],
    triggered_transactions: [childHash],
    ...overrides,
  };
}

function childTransaction(overrides = {}) {
  return {
    hash: childHash,
    tx_id: childHash,
    from_address: CONTRACT,
    sender: CONTRACT,
    origin_address: CONTRACT,
    to_address: CLAIMANT,
    recipient: CLAIMANT,
    type: 0n,
    value: AMOUNT,
    status: 'FINALIZED',
    triggered_by: parentHash,
    triggered_on: 'finalized',
    value_credited: true,
    ...overrides,
  };
}

function parentReceipt(overrides = {}) {
  return {
    transactionHash: parentHash,
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    recipient: CONTRACT,
    txDataDecoded: {
      type: 'call',
      callData: { method: 'claim', args: [String(EPOCH), 'HIGH'] },
    },
    ...overrides,
  };
}

function fakeOperator({ parent, child, receipt, chainId = '0xf22f', protocol = 'v6' } = {}) {
  const calls = { raw: [], waits: [], writes: 0 };
  const operator = {
    getNetworkInfo: async () => ({ alias: 'studionet' }),
    getChainId: async () => chainId,
    getConfig: async () => (protocol === 'v7' ? v7ChainConfig() : chainConfig()),
    getAssetCatalog: async () => ({
      assets: (protocol === 'v7' ? V7_ASSET_IDS : V6_ASSET_IDS)
        .map((asset_id) => ({ asset_id, quote_asset: 'USDT' })),
    }),
    getVenueCatalog: async () => ({
      venues: [...(protocol === 'v7' ? V7_VENUES : V6_VENUES)],
      adapters_immutable: true,
      candle_interval: '1m',
      start_price_rule: 'OPEN_AT_E_MINUS_20_MINUTES',
      end_price_rule: 'CLOSE_AT_E_MINUS_1_MINUTE',
    }),
    waitFinalized: async (hash) => {
      calls.waits.push(hash);
      return receipt ?? parentReceipt();
    },
    getRawTransaction: async (hash) => {
      calls.raw.push(hash);
      if (hash === parentHash) return parent ?? parentTransaction();
      if (hash === childHash) return child ?? childTransaction();
      throw new Error(`unexpected hash ${hash}`);
    },
    submitWrite: async () => {
      calls.writes += 1;
      throw new Error('read-only monitor attempted a write');
    },
  };
  return { operator, calls };
}

const silentLogger = () => {};

test('bare recorded parent hash verifies exact FINALIZED parent and credited child delivery', async () => {
  const monitorConfig = config();
  const targets = normalizeClaimMonitorTargets({
    parentHashes: [parentHash.toUpperCase()],
    contractAddress: CONTRACT,
  });
  const fake = fakeOperator();
  const result = await monitorClaimDeliveriesOnce({
    config: monitorConfig,
    targets,
    operator: fake.operator,
    logger: silentLogger,
  });

  assert.equal(result.deliveredCount, 1);
  assert.equal(result.reviewCount, 0);
  assert.deepEqual(result.results[0], {
    hash: parentHash,
    status: 'DELIVERED',
    childHash,
    account: CLAIMANT,
    amountAtto: AMOUNT.toString(),
    epochEndTimestamp: String(EPOCH),
    objective: 'HIGH',
  });
  assert.deepEqual(fake.calls.raw, [parentHash, childHash]);
  assert.equal(fake.calls.writes, 0);
});

test('explicit V7 selector verifies the same exact FINALIZED parent and credited child proof', async () => {
  const monitorConfig = v7Config();
  const targets = normalizeClaimMonitorTargets({
    parentHashes: [parentHash],
    contractAddress: CONTRACT,
    protocol: 'v7',
  });
  const fake = fakeOperator({ protocol: 'v7' });
  const result = await monitorClaimDeliveriesOnce({
    config: monitorConfig,
    targets,
    operator: fake.operator,
    protocol: 'v7',
    logger: silentLogger,
  });

  assert.equal(result.protocol, 'v7');
  assert.equal(result.deliveredCount, 1);
  assert.deepEqual(result.results[0], {
    hash: parentHash,
    status: 'DELIVERED',
    childHash,
    account: CLAIMANT,
    amountAtto: AMOUNT.toString(),
    epochEndTimestamp: String(EPOCH),
    objective: 'HIGH',
  });
  assert.deepEqual(fake.calls.raw, [parentHash, childHash]);
  assert.equal(fake.calls.writes, 0);
});

test('browser activity JSON is consumed, non-claim records are ignored, and expectations bind proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'liquidity-arena-activity-'));
  const path = join(directory, 'activity.json');
  try {
    const records = [{
      hash: parentHash,
      type: 'CLAIM',
      status: 'REVIEW',
      account: CLAIMANT,
      contractAddress: CONTRACT,
      deploymentAlias: 'v6',
      roundId: String(EPOCH),
      objective: 'HIGH',
      amountAtto: AMOUNT.toString(),
      childHash,
      deliveryStatus: 'REVIEW',
    }, {
      hash: `0x${'c'.repeat(64)}`,
      type: 'WAGER',
      account: CLAIMANT,
      contractAddress: CONTRACT,
    }];
    writeFileSync(path, JSON.stringify({ [ACTIVITY_STORAGE_KEY]: JSON.stringify(records) }));
    const loaded = loadClaimActivityFile(path);
    const targets = normalizeClaimMonitorTargets({
      activityRecords: loaded,
      contractAddress: CONTRACT,
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].hash, parentHash);
    assert.equal(targets[0].account, CLAIMANT);
    assert.equal(targets[0].amountAtto, AMOUNT);
    assert.equal(targets[0].childHash, childHash);
    assert.equal(targets[0].epochEndTimestamp, String(EPOCH));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('activity deployment metadata is filtered by the exact V6/V7 selector', () => {
  const v6Record = {
    hash: `0x${'c'.repeat(64)}`,
    type: 'CLAIM',
    account: CLAIMANT,
    contractAddress: CONTRACT,
    deploymentAlias: 'v6',
    protocolVersion: V6_PROTOCOL_VERSION,
    amountAtto: AMOUNT.toString(),
  };
  const v7Record = {
    hash: parentHash,
    type: 'CLAIM',
    account: CLAIMANT,
    contractAddress: CONTRACT,
    deploymentAlias: 'v7',
    protocolVersion: V7_PROTOCOL_VERSION,
    amountAtto: AMOUNT.toString(),
  };
  const targets = normalizeClaimMonitorTargets({
    activityRecords: [v6Record, v7Record],
    contractAddress: CONTRACT,
    protocol: 'v7',
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].hash, parentHash);

  assert.throws(
    () => normalizeClaimMonitorTargets({
      activityRecords: [{
        ...v7Record,
        deploymentAlias: 'v6',
      }],
      contractAddress: CONTRACT,
      protocol: 'v7',
    }),
    /deploymentAlias and protocolVersion conflict/,
  );
});

test('FINALIZED child without value_credited=true is REVIEW and never causes a payout retry', async () => {
  const targets = normalizeClaimMonitorTargets({ parentHashes: [parentHash], contractAddress: CONTRACT });
  const fake = fakeOperator({ child: childTransaction({ value_credited: false }) });
  const result = await monitorClaimDeliveriesOnce({
    config: config(),
    targets,
    operator: fake.operator,
    logger: silentLogger,
  });

  assert.equal(result.deliveredCount, 0);
  assert.equal(result.reviewCount, 1);
  assert.match(result.results[0].message, /did not credit/i);
  assert.equal(fake.calls.writes, 0);
});

test('missing or delayed child remains REVIEW instead of treating absence as retry evidence', async () => {
  const targets = normalizeClaimMonitorTargets({ parentHashes: [parentHash], contractAddress: CONTRACT });
  const fake = fakeOperator({ parent: parentTransaction({ triggered_transactions: [] }) });
  const result = await monitorClaimDeliveriesOnce({
    config: config(),
    targets,
    operator: fake.operator,
    logger: silentLogger,
  });

  assert.equal(result.reviewCount, 1);
  assert.match(result.results[0].message, /exactly one child/i);
  assert.equal(fake.calls.raw.length, 1);
  assert.equal(fake.calls.writes, 0);
});

test('activity amount, account, child, epoch, and objective cannot conflict with chain proof', async () => {
  const base = {
    hash: parentHash,
    type: 'CLAIM',
    account: CLAIMANT,
    contractAddress: CONTRACT,
    deploymentAlias: 'v6',
    amountAtto: (AMOUNT + 1n).toString(),
    childHash,
    roundId: String(EPOCH),
    objective: 'HIGH',
  };
  const targets = normalizeClaimMonitorTargets({
    activityRecords: [base],
    contractAddress: CONTRACT,
  });
  const fake = fakeOperator();
  const result = await monitorClaimDeliveriesOnce({
    config: config(),
    targets,
    operator: fake.operator,
    logger: silentLogger,
  });
  assert.equal(result.reviewCount, 1);
  assert.match(result.results[0].message, /amount does not match/i);
  assert.equal(fake.calls.writes, 0);
});

test('wrong chain or wrong parent call identity fails closed', async () => {
  const targets = normalizeClaimMonitorTargets({ parentHashes: [parentHash], contractAddress: CONTRACT });
  const wrongChain = fakeOperator({ chainId: '0x1' });
  await assert.rejects(
    monitorClaimDeliveriesOnce({
      config: config(), targets, operator: wrongChain.operator, logger: silentLogger,
    }),
    /not StudioNet chain/,
  );

  const wrongCall = fakeOperator({ receipt: parentReceipt({
    txDataDecoded: { type: 'call', callData: { method: 'enter', args: [String(EPOCH), 'HIGH'] } },
  }) });
  const result = await monitorClaimDeliveriesOnce({
    config: config(), targets, operator: wrongCall.operator, logger: silentLogger,
  });
  assert.equal(result.reviewCount, 1);
  assert.match(result.results[0].message, /not an exact claim/i);
  assert.equal(wrongCall.calls.raw.length, 0);
});

test('monitor implementation has no transaction-submission capability', () => {
  const source = readFileSync(new URL('./claim-delivery-monitor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /submitGenlayerWrite|\.submitWrite\s*\(|emit_transfer/);
});

test('protocol selection fails closed and public help covers V6 and V7', () => {
  assert.throws(
    () => normalizeClaimMonitorTargets({
      parentHashes: [parentHash],
      contractAddress: CONTRACT,
      protocol: 'v8',
    }),
    /exactly v6 or v7/,
  );
  const help = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./claim-delivery-monitor.mjs', import.meta.url)), '--help'],
    { encoding: 'utf8' },
  );
  assert.match(help, /V6 or V7/);
  assert.match(help, /--protocol <v6\|v7>/);
  assert.match(help, /value_credited=true/);
});
