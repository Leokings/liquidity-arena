import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  firstEligibleEpochEnd,
  loadV8KeeperConfig,
  normalizeV8KeeperConfig,
  plannedFutureEpochEnds,
  V8_AUDITED_PAYOUT_FACTORY,
  V8_PUBLIC_METHODS,
} from './v8-keeper-config.mjs';

const ENVIRONMENT = Object.freeze({
  V8_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
  V8_OWNER_ADDRESS: '0x2222222222222222222222222222222222222222',
  V8_KEEPER_ADDRESS: '0x3333333333333333333333333333333333333333',
  V8_TREASURY_ADDRESS: '0x4444444444444444444444444444444444444444',
});

function raw(overrides = {}) {
  return {
    version: 1,
    network: 'testnet-bradbury',
    chainId: 4221,
    contractAddress: '${V8_CONTRACT_ADDRESS}',
    expected: {
      ownerAddress: '${V8_OWNER_ADDRESS}',
      keeperAddress: '${V8_KEEPER_ADDRESS}',
      treasuryAddress: '${V8_TREASURY_ADDRESS}',
      payoutFactoryAddress: V8_AUDITED_PAYOUT_FACTORY,
      ...(overrides.expected || {}),
    },
    epochs: {
      futureHours: 3,
      minimumCreationLeadSeconds: 7200,
      minStakeGen: '0.1',
      maxStakePerWalletGen: '10',
      ...(overrides.epochs || {}),
    },
    operator: { maxWritesPerRun: 8, ...(overrides.operator || {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['expected', 'epochs', 'operator'].includes(key))),
  };
}

test('V8 config is exact Bradbury, fixed factory/fee, and 25-method release', () => {
  const config = normalizeV8KeeperConfig(raw(), { environment: ENVIRONMENT });
  assert.equal(config.network, 'testnet-bradbury');
  assert.equal(config.chainId, 4221);
  assert.equal(config.contractAddress, ENVIRONMENT.V8_CONTRACT_ADDRESS);
  assert.equal(config.expected.payoutFactoryAddress, V8_AUDITED_PAYOUT_FACTORY);
  assert.equal(config.expected.platformFeeBps, 200);
  assert.equal(config.epochs.minStakeAtto, '100000000000000000');
  assert.equal(config.epochs.maxStakePerWalletAtto, '10000000000000000000');
  assert.equal(config.operator.maxEpochReadsPerRun, 50);
  assert.equal(config.operator.maxPayoutReadsPerRun, 500);
  assert.equal(V8_PUBLIC_METHODS.length, 25);
  assert.equal(new Set(V8_PUBLIC_METHODS).size, 25);
});

test('V8 config rejects another network, chain, factory, fee, or unknown field', () => {
  for (const value of [
    raw({ network: 'studionet' }),
    raw({ chainId: 61999 }),
    raw({ expected: { payoutFactoryAddress: '0x5555555555555555555555555555555555555555' } }),
    raw({ expected: { platformFeeBps: 201 } }),
    { ...raw(), legacyClaimRoute: true },
  ]) assert.throws(() => normalizeV8KeeperConfig(value, { environment: ENVIRONMENT }), /Bradbury V8 keeper configuration/);
});

test('future epochs are exact hours within the keeper horizon', () => {
  const config = normalizeV8KeeperConfig(raw(), { environment: ENVIRONMENT });
  const now = Date.UTC(2027, 0, 15, 10, 17, 0) / 1000;
  assert.equal(firstEligibleEpochEnd(now, 7200), Date.UTC(2027, 0, 15, 13, 0, 0) / 1000);
  assert.deepEqual(plannedFutureEpochEnds(config, now), [
    Date.UTC(2027, 0, 15, 13, 0, 0) / 1000,
    Date.UTC(2027, 0, 15, 14, 0, 0) / 1000,
    Date.UTC(2027, 0, 15, 15, 0, 0) / 1000,
  ]);
});

test('config loader resolves only explicit V8 environment placeholders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'v8-keeper-config-'));
  const path = join(directory, 'config.json');
  try {
    writeFileSync(path, JSON.stringify(raw()), 'utf8');
    const config = loadV8KeeperConfig(path, { environment: ENVIRONMENT });
    assert.equal(config.expected.keeperAddress, ENVIRONMENT.V8_KEEPER_ADDRESS);
    assert.throws(() => loadV8KeeperConfig(path, { environment: {} }), /V8_CONTRACT_ADDRESS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
