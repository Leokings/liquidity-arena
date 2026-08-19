import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  expectedEpochRecord,
  firstEligibleEpochEnd,
  genDecimalToAtto,
  loadV6KeeperConfig,
  normalizeV6KeeperConfig,
  plannedFutureEpochEnds,
  V6_POLICY_VERSION,
  V6_PROTOCOL_VERSION,
} from './v6-keeper-config.mjs';

const CONTRACT = '0x1111111111111111111111111111111111111111';

function rawConfig(overrides = {}) {
  return {
    version: 1,
    network: 'studionet',
    contractAddress: CONTRACT,
    expected: {
      protocolVersion: V6_PROTOCOL_VERSION,
      policyVersion: V6_POLICY_VERSION,
      platformFeeBps: 200,
    },
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
      readAttempts: 3,
      retryBaseMs: 0,
      finalityRetries: 180,
      finalityIntervalMs: 5_000,
      finalityWaitAttempts: 3,
      postStateAttempts: 5,
      postStateIntervalMs: 0,
    },
    ...overrides,
  };
}

test('normalizes the StudioNet-only defaults and exact GEN atto amounts', () => {
  const config = normalizeV6KeeperConfig({
    network: 'studionet',
    contractAddress: CONTRACT,
  });

  assert.equal(config.expected.protocolVersion, 'LIQUIDITY_ARENA_V6');
  assert.equal(config.expected.policyVersion, 'CRYPTO_SPOT_1M_MEDIAN_V1');
  assert.equal(config.epochs.futureHours, 3);
  assert.equal(config.epochs.minimumCreationLeadSeconds, 7_200);
  assert.equal(config.operator.pageSize, 50);
  assert.equal(config.operator.finalityWaitAttempts, 7);
  assert.equal(config.operator.scanIntervalMs, 25);
  assert.equal(config.epochs.minStakeAtto, '100000000000000000');
  assert.equal(config.epochs.maxStakePerWalletAtto, '10000000000000000000');
  assert.equal(genDecimalToAtto('0.000000000000000001'), '1');
  assert.equal(genDecimalToAtto('12.345'), '12345000000000000000');
});

test('rejects imprecise amounts, a cap below minimum, and zero minimum', () => {
  assert.throws(() => genDecimalToAtto('0.0000000000000000001'), /at most 18 decimals/);
  assert.throws(() => genDecimalToAtto('1e-1'), /base-10 GEN amount/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    epochs: { ...rawConfig().epochs, minStakeGen: '0' },
  })), /must be positive/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    epochs: {
      ...rawConfig().epochs,
      minStakeGen: '2',
      maxStakePerWalletGen: '1',
    },
  })), /must be at least/);
});

test('requires StudioNet, the V6 protocol/policy, a valid address, and two-hour lead', () => {
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({ network: 'testnet-bradbury' })),
    /network must be exactly studionet/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    expected: { ...rawConfig().expected, protocolVersion: 'LIQUIDITY_ARENA_V5' },
  })), /protocolVersion must be exactly LIQUIDITY_ARENA_V6/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    expected: { ...rawConfig().expected, policyVersion: 'SOMETHING_ELSE' },
  })), /policyVersion must be exactly CRYPTO_SPOT_1M_MEDIAN_V1/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({ contractAddress: `0x${'0'.repeat(40)}` })),
    /nonzero 20-byte/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    epochs: { ...rawConfig().epochs, minimumCreationLeadSeconds: 7_199 },
  })), /between 7200/);
});

test('rejects unknown configuration fields and unsafe operational bounds', () => {
  assert.throws(() => normalizeV6KeeperConfig({ ...rawConfig(), surprise: true }),
    /unknown fields: surprise/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    operator: { ...rawConfig().operator, pageSize: 51 },
  })), /pageSize must be an integer between 1 and 50/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    operator: { ...rawConfig().operator, scanIntervalMs: 5_001 },
  })), /scanIntervalMs must be an integer between 0 and 5000/);
  assert.throws(() => normalizeV6KeeperConfig(rawConfig({
    operator: { ...rawConfig().operator, historyLimit: 50 },
  })), /unknown fields: historyLimit/);
});

test('resolves only the explicit contract environment token and fails closed when absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-keeper-config-'));
  const path = join(directory, 'keeper.json');
  writeFileSync(path, JSON.stringify({
    network: 'studionet',
    contractAddress: '${V6_CONTRACT_ADDRESS}',
  }));

  assert.throws(() => loadV6KeeperConfig(path, { environment: {} }),
    /V6_CONTRACT_ADDRESS is required/);
  const config = loadV6KeeperConfig(path, {
    environment: { V6_CONTRACT_ADDRESS: CONTRACT },
  });
  assert.equal(config.contractAddress, CONTRACT);
});

test('plans three exact UTC-hour epoch ends with at least two hours lead', () => {
  const config = normalizeV6KeeperConfig(rawConfig());
  const tenUtc = Date.UTC(2027, 0, 15, 10, 0, 0) / 1_000;

  assert.equal(firstEligibleEpochEnd(tenUtc, 7_200), tenUtc + 7_200);
  assert.deepEqual(plannedFutureEpochEnds(config, tenUtc), [
    tenUtc + 7_200,
    tenUtc + 10_800,
    tenUtc + 14_400,
  ]);
  assert.equal(firstEligibleEpochEnd(tenUtc + 1, 7_200), tenUtc + 10_800);
});

test('materializes the immutable 20/20/20 epoch schedule and stake policy', () => {
  const config = normalizeV6KeeperConfig(rawConfig());
  const epochEnd = Date.UTC(2027, 0, 15, 12, 0, 0) / 1_000;
  const record = expectedEpochRecord(config, epochEnd);

  assert.equal(record.wagerOpensTimestamp, epochEnd - 2_400);
  assert.equal(record.wagerClosesTimestamp, epochEnd - 1_200);
  assert.equal(record.resolutionAvailableTimestamp, epochEnd + 120);
  assert.equal(record.timeoutRefundAvailableTimestamp, epochEnd + 86_400);
  assert.equal(record.platformFeeBpsSnapshot, 200);
  assert.equal(record.minStakeAtto, '100000000000000000');
  assert.throws(() => expectedEpochRecord(config, epochEnd + 1), /exact UTC hour/);
});
