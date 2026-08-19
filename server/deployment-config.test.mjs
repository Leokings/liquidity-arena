import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLiquidityArenaDeploymentConfig } from './deployment-config.mjs';

const ACTIVE = '0xb2ae59aE641f571726Ae81E30080f8c2192b15EF';
const LEGACY = '0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1';
const OWNER = '0x3333333333333333333333333333333333333333';
const KEEPER = '0x4444444444444444444444444444444444444444';
const TREASURY = '0x5555555555555555555555555555555555555555';

function base(protocol = 'LIQUIDITY_ARENA_V6') {
  return {
    VITE_GENLAYER_NETWORK: 'studionet',
    VITE_GENLAYER_PROTOCOL: protocol,
    VITE_GENLAYER_CONTRACT: ACTIVE,
    GENLAYER_RPC_URL: 'https://studio.genlayer.com/api',
  };
}

function v7() {
  return {
    ...base('LIQUIDITY_ARENA_V7'),
    VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
    VITE_GENLAYER_V6_CONTRACT: LEGACY,
    VITE_GENLAYER_V7_CONTRACT: ACTIVE,
    GENLAYER_V7_OWNER: OWNER,
    GENLAYER_V7_KEEPER: KEEPER,
    GENLAYER_V7_TREASURY: TREASURY,
    GENLAYER_V7_MIN_STAKE_ATTO: '100000000000000000',
    GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO: '10000000000000000000',
  };
}

test('V6-only production configuration remains valid without any V7 environment', () => {
  const config = loadLiquidityArenaDeploymentConfig(base());
  assert.equal(config.expectedContractProtocol, 'LIQUIDITY_ARENA_V6');
  assert.equal(config.v7Expectations, null);
  assert.deepEqual(config.legacyV6Contracts, []);
  assert.equal(config.genLayerChainId, '0xf22f');
});

test('V7 deployment configuration binds active, role, stake, and legacy addresses exactly', () => {
  const config = loadLiquidityArenaDeploymentConfig(v7());
  assert.equal(config.expectedContractProtocol, 'LIQUIDITY_ARENA_V7');
  assert.equal(config.activeDeployment, 'v7');
  assert.equal(config.v6ContractAddress, LEGACY);
  assert.equal(config.v7ContractAddress, ACTIVE);
  assert.equal(config.contractAddress, ACTIVE);
  assert.deepEqual(config.legacyV6Contracts, [LEGACY]);
  assert.deepEqual(config.v7Expectations, {
    owner: OWNER,
    keeper: KEEPER,
    treasury: TREASURY,
    minimumStakeAtto: '100000000000000000',
    maximumStakePerWalletAtto: '10000000000000000000',
  });
});

test('canonical StudioNet address casing is preserved for RPC while comparisons ignore case', () => {
  const config = loadLiquidityArenaDeploymentConfig({
    ...v7(),
    VITE_GENLAYER_V7_CONTRACT: ACTIVE.toLowerCase(),
    VITE_GENLAYER_V6_CONTRACT: LEGACY,
  });
  assert.equal(config.contractAddress, ACTIVE);
  assert.equal(config.activeContract.address, ACTIVE);
  assert.equal(config.v7ContractAddress, ACTIVE.toLowerCase());
  assert.equal(config.v6ContractAddress, LEGACY);
});

test('V7 mode fails closed on missing roles, unsafe stakes, and an ambiguous legacy allowlist', () => {
  for (const [overrides, pattern] of [
    [{ GENLAYER_V7_OWNER: '' }, /GENLAYER_V7_OWNER is required/],
    [{ GENLAYER_V7_KEEPER: '0x0000000000000000000000000000000000000000' }, /non-zero/],
    [{ GENLAYER_V7_MIN_STAKE_ATTO: '1.5' }, /unsigned base-10/],
    [{
      GENLAYER_V7_MIN_STAKE_ATTO: '2',
      GENLAYER_V7_MAX_STAKE_PER_WALLET_ATTO: '1',
    }, /must be at least/],
    [{ GENLAYER_LEGACY_V6_CONTRACTS: LEGACY }, /duplicates/],
    [{ GENLAYER_LEGACY_V6_CONTRACTS: LEGACY.toLowerCase() }, /duplicates/],
    [{ GENLAYER_LEGACY_V6_CONTRACTS: ACTIVE }, /active contract/],
    [{ VITE_GENLAYER_ACTIVE_DEPLOYMENT: '' }, /ACTIVE_DEPLOYMENT/],
    [{ VITE_GENLAYER_V6_CONTRACT: '' }, /V6_CONTRACT/],
    [{ VITE_GENLAYER_V7_CONTRACT: LEGACY }, /must differ|match the active/],
  ]) {
    assert.throws(() => loadLiquidityArenaDeploymentConfig({ ...v7(), ...overrides }), pattern);
  }
});
