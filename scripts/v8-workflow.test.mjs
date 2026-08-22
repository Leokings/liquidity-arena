import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);

function workflow(name) {
  return readFileSync(new URL(`.github/workflows/${name}`, ROOT), 'utf8').replace(/\r\n/g, '\n');
}

function assertProtectedMainGate(source, secretPattern) {
  assert.match(source, /if: >-\n\s+github\.repository == 'Leokings\/liquidity-arena' &&\n\s+github\.ref == 'refs\/heads\/main' &&\n\s+github\.ref_name == 'main'/);
  const explicitGate = source.indexOf('- name: Enforce protected main before secrets');
  const firstSecret = source.search(secretPattern);
  assert.ok(explicitGate > 0, 'explicit protected-main gate is missing');
  assert.ok(firstSecret > explicitGate, 'a secret-bearing expression appears before the protected-main gate');
  const gateBlock = source.slice(explicitGate, source.indexOf('\n      - ', explicitGate + 1));
  assert.doesNotMatch(gateBlock, /\$\{\{\s*(?:secrets|vars)\./);
  assert.match(gateBlock, /ACTUAL_REF: \$\{\{ github\.ref \}\}/);
  assert.match(gateBlock, /ACTUAL_REF_NAME: \$\{\{ github\.ref_name \}\}/);
}

test('V8 keeper refuses arbitrary workflow_dispatch refs before exposing its keystore', () => {
  const source = workflow('bradbury-v8-keeper.yml');
  assert.match(source, /workflow_dispatch:/);
  assertProtectedMainGate(source, /\$\{\{\s*secrets\.V8_KEEPER_KEYSTORE_B64\s*\}\}/);
  assert.match(source, /V8_KEEPER_KEYSTORE_B64: \$\{\{ secrets\.V8_KEEPER_KEYSTORE_B64 \}\}/);
});

test('V8 watchdog also gates its journal secret to protected main', () => {
  const source = workflow('bradbury-v8-ops-watchdog.yml');
  assertProtectedMainGate(source, /\$\{\{\s*secrets\.KEEPER_JOURNAL_SECRET\s*\}\}/);
});
