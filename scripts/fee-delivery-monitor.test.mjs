import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  monitorFeeDeliveriesOnce,
  normalizeFeeMonitorTargets,
} from './fee-delivery-monitor.mjs';
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
const TREASURY = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x4444444444444444444444444444444444444444';
const UNAUTHORIZED = '0x5555555555555555555555555555555555555555';
const AMOUNT = 4_000_000_000_000_000n;
const parentHash = `0x${'a'.repeat(64)}`;
const childHash = `0x${'b'.repeat(64)}`;

function config() {
  return normalizeV7KeeperConfig({
    network: 'studionet',
    contractAddress: CONTRACT,
    expected: {
      platformFeeBps: 200,
      ownerAddress: OWNER,
      keeperAddress: KEEPER,
      treasuryAddress: TREASURY,
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

function chainConfig(overrides = {}) {
  return {
    protocol_version: V7_PROTOCOL_VERSION,
    policy_version: V7_POLICY_VERSION,
    owner: OWNER,
    pending_owner: '0x0000000000000000000000000000000000000000',
    keeper: KEEPER,
    treasury: TREASURY,
    native_token_symbol: 'GEN',
    native_token_decimals: 18,
    current_platform_fee_bps: 200,
    default_platform_fee_bps: 200,
    max_platform_fee_bps: 500,
    epoch_min_stake_atto: '100000000000000000',
    epoch_max_stake_per_wallet_atto: '10000000000000000000',
    minimum_epoch_creation_lead_seconds: V7_MINIMUM_EPOCH_CREATION_LEAD_SECONDS,
    keeper_max_schedule_ahead_seconds: V7_KEEPER_MAX_SCHEDULE_AHEAD_SECONDS,
    owner_max_schedule_ahead_seconds: V7_OWNER_MAX_SCHEDULE_AHEAD_SECONDS,
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

function parentTransaction({ caller = OWNER, message = {}, ...overrides } = {}) {
  return {
    hash: parentHash,
    tx_id: parentHash,
    from_address: caller,
    sender: caller,
    to_address: CONTRACT,
    recipient: CONTRACT,
    type: 2n,
    value: 0n,
    status: 'FINALIZED',
    messages: [{
      messageType: 0n,
      recipient: TREASURY,
      value: AMOUNT,
      data: '',
      onAcceptance: false,
      ...message,
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
    to_address: TREASURY,
    recipient: TREASURY,
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
      callData: { method: 'withdraw_accrued_fees', args: [AMOUNT.toString()] },
    },
    ...overrides,
  };
}

function fakeOperator({
  parent,
  child,
  receipt,
  network = 'studionet',
  chainId = '0xf22f',
  onChainConfig,
} = {}) {
  const calls = { raw: [], waits: [], writes: 0 };
  const operator = {
    getNetworkInfo: async () => ({ alias: network }),
    getChainId: async () => chainId,
    getConfig: async () => onChainConfig ?? chainConfig(),
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
    waitFinalized: async (hash) => {
      calls.waits.push(hash);
      return receipt ?? parentReceipt();
    },
    getRawTransaction: async (hash) => {
      calls.raw.push(hash);
      if (hash === parentHash) return parent ?? parentTransaction();
      if (hash === childHash) return child ?? childTransaction();
      throw new Error(`unexpected transaction ${hash}`);
    },
    submitWrite: async () => {
      calls.writes += 1;
      throw new Error('read-only fee monitor attempted a write');
    },
  };
  return { operator, calls };
}

async function run(fake, targets = normalizeFeeMonitorTargets([parentHash])) {
  return monitorFeeDeliveriesOnce({
    config: config(),
    targets,
    operator: fake.operator,
    logger: () => {},
  });
}

test('owner fee withdrawal verifies one exact FINALIZED treasury delivery without writes', async () => {
  const fake = fakeOperator();
  const result = await run(fake);

  assert.equal(result.protocol, 'v7');
  assert.equal(result.network, 'studionet');
  assert.equal(result.deliveredCount, 1);
  assert.equal(result.reviewCount, 0);
  assert.deepEqual(result.results[0], {
    hash: parentHash,
    status: 'DELIVERED',
    childHash,
    operator: OWNER,
    treasury: TREASURY,
    amountAtto: AMOUNT.toString(),
  });
  assert.deepEqual(fake.calls.waits, [parentHash]);
  assert.deepEqual(fake.calls.raw, [parentHash, childHash]);
  assert.equal(fake.calls.writes, 0);
});

test('configured treasury is also an authorized fee-withdrawal caller', async () => {
  const fake = fakeOperator({ parent: parentTransaction({ caller: TREASURY }) });
  const result = await run(fake);
  assert.equal(result.deliveredCount, 1);
  assert.equal(result.results[0].operator, TREASURY);
  assert.equal(fake.calls.writes, 0);
});

test('targets normalize exact hashes, deduplicate, and reject empty input', () => {
  const targets = normalizeFeeMonitorTargets([parentHash.toUpperCase(), parentHash]);
  assert.deepEqual(targets, [{ hash: parentHash }]);
  assert.throws(() => normalizeFeeMonitorTargets([]), /at least one/i);
  assert.throws(() => normalizeFeeMonitorTargets(['0x1234']), /32-byte/i);
});

test('wrong network, chain, or configured V7 roles fail before transaction inspection', async () => {
  const wrongNetwork = fakeOperator({ network: 'testnet-bradbury' });
  await assert.rejects(run(wrongNetwork), /network must be exactly studionet/i);
  assert.equal(wrongNetwork.calls.waits.length, 0);

  const wrongChain = fakeOperator({ chainId: '0x1' });
  await assert.rejects(run(wrongChain), /not StudioNet chain/i);
  assert.equal(wrongChain.calls.waits.length, 0);

  const wrongRoles = fakeOperator({ onChainConfig: chainConfig({ treasury: UNAUTHORIZED }) });
  await assert.rejects(run(wrongRoles), /treasury must be/i);
  assert.equal(wrongRoles.calls.waits.length, 0);
});

test('parent receipt must prove the exact successful FINALIZED withdrawal and requested hash', async () => {
  const cases = [
    ['wrong hash', { transactionHash: `0x${'c'.repeat(64)}` }, /receipt hash/i],
    ['wrong method', {
      txDataDecoded: { type: 'call', callData: { method: 'claim', args: [AMOUNT.toString()] } },
    }, /not an exact withdraw_accrued_fees/i],
    ['wrong argument count', {
      txDataDecoded: {
        type: 'call', callData: { method: 'withdraw_accrued_fees', args: [AMOUNT.toString(), '1'] },
      },
    }, /not an exact withdraw_accrued_fees/i],
    ['zero amount', {
      txDataDecoded: { type: 'call', callData: { method: 'withdraw_accrued_fees', args: ['0'] } },
    }, /canonical positive integer/i],
    ['noncanonical amount', {
      txDataDecoded: { type: 'call', callData: { method: 'withdraw_accrued_fees', args: ['04'] } },
    }, /canonical positive integer/i],
    ['failed execution', { txExecutionResultName: 'FINISHED_WITH_ERROR' }, /finalized with/i],
    ['not finalized', { statusName: 'ACCEPTED' }, /not FINALIZED/i],
  ];
  for (const [label, overrides, pattern] of cases) {
    const fake = fakeOperator({ receipt: parentReceipt(overrides) });
    const result = await run(fake);
    assert.equal(result.reviewCount, 1, label);
    assert.match(result.results[0].message, pattern, label);
    assert.deepEqual(fake.calls.raw, [], label);
    assert.equal(fake.calls.writes, 0, label);
  }
});

test('parent caller, contract call envelope, message, and child count fail closed', async () => {
  const cases = [
    ['unauthorized caller', parentTransaction({ caller: UNAUTHORIZED }), /neither the configured owner nor treasury/i],
    ['wrong contract', parentTransaction({ recipient: UNAUTHORIZED, to_address: UNAUTHORIZED }), /contract recipient/i],
    ['wrong parent type', parentTransaction({ type: 0n }), /parent type must be 2/i],
    ['nonzero parent value', parentTransaction({ value: 1n }), /parent value must be 0/i],
    ['no message', parentTransaction({ messages: [] }), /exactly one transfer message/i],
    ['two messages', parentTransaction({ messages: [{}, {}] }), /exactly one transfer message/i],
    ['wrong message recipient', parentTransaction({ message: { recipient: OWNER } }), /message recipient/i],
    ['wrong message value', parentTransaction({ message: { value: AMOUNT + 1n } }), /message value must be/i],
    ['wrong message type', parentTransaction({ message: { messageType: 1n } }), /message type must be 0/i],
    ['acceptance transfer', parentTransaction({ message: { onAcceptance: true } }), /not deferred/i],
    ['message calldata', parentTransaction({ message: { data: '0x01' } }), /unexpected calldata/i],
    ['no child', parentTransaction({ triggered_transactions: [] }), /exactly one triggered child/i],
    ['two children', parentTransaction({
      triggered_transactions: [childHash, `0x${'c'.repeat(64)}`],
    }), /exactly one triggered child/i],
  ];
  for (const [label, parent, pattern] of cases) {
    const fake = fakeOperator({ parent });
    const result = await run(fake);
    assert.equal(result.reviewCount, 1, label);
    assert.match(result.results[0].message, pattern, label);
    assert.deepEqual(fake.calls.raw, [parentHash], label);
    assert.equal(fake.calls.writes, 0, label);
  }
});

test('child must prove exact contract provenance, parent link, finality trigger, value, and credit', async () => {
  const cases = [
    ['not finalized', { status: 'ACCEPTED' }, /not FINALIZED/i],
    ['wrong recipient', { recipient: OWNER, to_address: OWNER }, /treasury recipient/i],
    ['wrong sender', { sender: UNAUTHORIZED }, /child sender/i],
    ['wrong from', { from_address: UNAUTHORIZED }, /child from address/i],
    ['wrong origin', { origin_address: UNAUTHORIZED }, /child origin address/i],
    ['wrong parent', { triggered_by: `0x${'c'.repeat(64)}` }, /expected parent hash/i],
    ['acceptance trigger', { triggered_on: 'accepted' }, /not triggered on parent finalization/i],
    ['wrong type', { type: 2n }, /child type must be 0/i],
    ['wrong value', { value: AMOUNT - 1n }, /child value must be/i],
    ['not credited', { value_credited: false }, /did not credit/i],
  ];
  for (const [label, overrides, pattern] of cases) {
    const fake = fakeOperator({ child: childTransaction(overrides) });
    const result = await run(fake);
    assert.equal(result.reviewCount, 1, label);
    assert.match(result.results[0].message, pattern, label);
    assert.deepEqual(fake.calls.raw, [parentHash, childHash], label);
    assert.equal(fake.calls.writes, 0, label);
  }
});

test('conflicting raw aliases are ambiguous proof and remain REVIEW', async () => {
  const conflictingParent = fakeOperator({
    parent: parentTransaction({ fromAddress: UNAUTHORIZED }),
  });
  const parentResult = await run(conflictingParent);
  assert.equal(parentResult.reviewCount, 1);
  assert.match(parentResult.results[0].message, /conflicting addresses/i);
  assert.equal(conflictingParent.calls.writes, 0);

  const conflictingChild = fakeOperator({
    child: childTransaction({ toAddress: OWNER }),
  });
  const childResult = await run(conflictingChild);
  assert.equal(childResult.reviewCount, 1);
  assert.match(childResult.results[0].message, /treasury recipient/i);
  assert.equal(conflictingChild.calls.writes, 0);
});

test('missing child remains REVIEW and never becomes evidence for retry or re-emission', async () => {
  const fake = fakeOperator();
  fake.operator.getRawTransaction = async (hash) => {
    fake.calls.raw.push(hash);
    if (hash === parentHash) return parentTransaction();
    throw new Error('child transaction not indexed');
  };
  const result = await run(fake);
  assert.equal(result.reviewCount, 1);
  assert.match(result.results[0].message, /not indexed/i);
  assert.equal(result.results[0].childHash, childHash);
  assert.equal(fake.calls.writes, 0);
});

test('implementation exposes no write, retry, or transfer-emission path and help states guarantees', () => {
  const sourceUrl = new URL('./fee-delivery-monitor.mjs', import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  assert.doesNotMatch(source, /submitGenlayerWrite|\.submitWrite\s*\(|emit_transfer|withdrawAccruedFees/);
  const help = execFileSync(process.execPath, [fileURLToPath(sourceUrl), '--help'], { encoding: 'utf8' });
  assert.match(help, /V7-only and read-only/);
  assert.match(help, /value_credited=true/);
  assert.match(help, /never retries or re-emits/i);
});
