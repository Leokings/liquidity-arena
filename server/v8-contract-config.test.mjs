import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLiquidityArenaDeploymentConfig } from './deployment-config.mjs';
import {
  EXPECTED_V8_SCHEMA,
  EXPECTED_V8_SCHEMA_SHA256,
  validateLiquidityArenaV8Config,
  validateLiquidityArenaV8Reserve,
  validateLiquidityArenaV8Schema,
} from './v8-contract-config.mjs';
import { v8Config, v8Environment, v8Reserve } from './v8-test-fixtures.test-helper.mjs';

const expectations = loadLiquidityArenaDeploymentConfig(v8Environment()).v8Expectations;

test('V8 validator requires the exhaustive reviewed 25-method schema', () => {
  assert.equal(Object.keys(EXPECTED_V8_SCHEMA.methods).length, 25);
  assert.equal(EXPECTED_V8_SCHEMA_SHA256, 'c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4');
  assert.equal(validateLiquidityArenaV8Schema(EXPECTED_V8_SCHEMA).methodCount, 25);
  assert.throws(
    () => validateLiquidityArenaV8Schema({ ...EXPECTED_V8_SCHEMA, methods: { ...EXPECTED_V8_SCHEMA.methods, claim: undefined } }),
    /exact reviewed 25-method/,
  );
});

test('V8 config and reserve validation require active payout/risk and funded capacity', () => {
  const config = validateLiquidityArenaV8Config(v8Config(), expectations);
  assert.equal(config.payoutsEnabled, true);
  assert.equal(config.newRiskEnabled, true);
  assert.equal(validateLiquidityArenaV8Reserve(v8Reserve(), expectations).ready, true);
  assert.throws(() => validateLiquidityArenaV8Config(v8Config({ new_risk_enabled: false }), expectations), /not production-ready/);
  assert.throws(
    () => validateLiquidityArenaV8Reserve(v8Reserve({ available_reserve_atto: '2999999999999999999' }), expectations),
    /below/,
  );
  assert.throws(
    () => validateLiquidityArenaV8Config(v8Config({ unexpected_release_field: true }), expectations),
    /fields are not release-exact/,
  );
  assert.throws(
    () => validateLiquidityArenaV8Reserve(v8Reserve({ unexpected_release_field: true }), expectations),
    /fields are not release-exact/,
  );
});
