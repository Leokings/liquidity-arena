import assert from 'node:assert/strict';
import test from 'node:test';

import handler from './healthz.mjs';

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; },
  };
}

test('liveness identifies only Bradbury chain 4221 and V8', () => {
  const res = response();
  handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    status: 'ok',
    service: 'liquidity-arena',
    network: 'testnet-bradbury',
    chainId: 4_221,
    deployment: 'v8',
  });
});

test('liveness permits HEAD only in addition to GET', () => {
  const head = response();
  handler({ method: 'HEAD' }, head);
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');

  const post = response();
  handler({ method: 'POST' }, post);
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});
