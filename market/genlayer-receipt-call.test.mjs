import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeGenLayerReceiptCall } from './genlayer-receipt-call.js';

test('StudioNet readable calldata decodes its omitted object comma and trailing array comma', () => {
  const call = decodeGenLayerReceiptCall({
    data: {
      calldata: {
        readable: '{"args":[1787166000,"HIGH","BTC",]"method":"enter"}',
      },
    },
  });
  assert.deepEqual(call, {
    method: 'enter',
    args: ['1787166000', 'HIGH', 'BTC'],
  });
});

test('receipt call decoder rejects duplicate and conflicting call identities', () => {
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: '{"args":[]"method":"claim""method":"enter"}' } },
    }),
    /duplicate object key/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      txDataDecoded: { type: 'call', callData: { method: 'claim', args: ['1', 'LOW'] } },
      data: { calldata: { readable: '{"args":[1,"LOW",]"method":"enter"}' } },
    }),
    /conflicting decoded call evidence/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      txDataDecoded: { type: 'call', callData: { method: 'enter', args: ['1', 'HIGH', 'BTC'] } },
      data: { calldata: { readable: '{"args":[1,"LOW","BTC",]"method":"enter"}' } },
    }),
    /conflicting decoded call evidence/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      txDataDecoded: { type: 'call', callData: { method: 'enter', args: ['1'] } },
      tx_data_decoded: { type: 'call', callData: { method: 'enter', args: ['1'] } },
    }),
    /ambiguous decoded call fields/,
  );
});

test('receipt call decoder accepts equal native and StudioNet identities after exact canonicalization', () => {
  const call = decodeGenLayerReceiptCall({
    txDataDecoded: { type: 'call', callData: { method: 'enter', args: ['1787166000', 'HIGH', 'BTC'] } },
    data: { calldata: { readable: '{"args":[1787166000,"HIGH","BTC",]"method":"enter"}' } },
  });
  assert.deepEqual(call, {
    method: 'enter',
    args: ['1787166000', 'HIGH', 'BTC'],
  });
});

test('receipt call decoder bounds untrusted StudioNet readable calldata', () => {
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: `{"args":["${'x'.repeat(17 * 1024)}"]"method":"enter"}` } },
    }),
    /exceeds its byte limit/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: `{"args":[${'['.repeat(20)}0${']'.repeat(20)}]"method":"enter"}` } },
    }),
    /nested too deeply/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: `{"args":[${Array.from({ length: 257 }, () => '0').join(',')}]"method":"enter"}` } },
    }),
    /too many values/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: `{"args":[${'1'.repeat(129)}]"method":"enter"}` } },
    }),
    /oversized number/,
  );
});

test('receipt call decoder rejects prototype keys, unknown fields, and non-canonical numbers', () => {
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: '{"args":[]"method":"claim""__proto__":null}' } },
    }),
    /unknown decoded call fields/,
  );
  assert.throws(
    () => decodeGenLayerReceiptCall({
      data: { calldata: { readable: '{"args":[]"method":"claim""extra":true}' } },
    }),
    /unknown decoded call fields/,
  );
  for (const number of ['1.0', '1e3']) {
    assert.throws(
      () => decodeGenLayerReceiptCall({
        data: { calldata: { readable: `{"args":[${number}]"method":"enter"}` } },
      }),
      /expected comma|expected an object member/,
    );
  }
});
