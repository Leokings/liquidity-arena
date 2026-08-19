import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STUDIONET_CHAIN_ID,
  GenLayerGateway,
  assertFinalizedExecution,
  ensureGenLayerWalletChain,
  isConfiguredAddress,
  parseRawGenLayerTransactionResponse,
  resolveGenLayerWalletRpcUrl,
  selectInjectedWalletProvider,
  verifyClaimTransferMessage,
  verifyRawClaimChildTransaction,
  verifyRawClaimParentTransaction,
} from './genlayer-client.js';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const CLAIM_PARENT_HASH = `0x${'ab'.repeat(32)}`;
const CLAIM_CHILD_HASH = `0x${'cd'.repeat(32)}`;
const CLAIM_ACCOUNT = '0x2222222222222222222222222222222222222222';
const RAW_CLAIM_AMOUNT = '100000000000000000';
const STUDIONET_CHAIN = Object.freeze({
  id: STUDIONET_CHAIN_ID,
  name: 'Genlayer Studio Network',
  rpcUrls: { default: { http: ['https://studio.genlayer.com/api'] } },
  nativeCurrency: { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
  blockExplorers: {
    default: { name: 'GenLayer Explorer', url: 'https://genlayer-explorer.vercel.app' },
  },
});

function rawRpcEnvelope(result, id = '1') {
  return `{"jsonrpc":"2.0","id":${id},"result":${result}}`;
}

function rawClaimParent({
  hash = CLAIM_PARENT_HASH,
  recipient = CLAIM_ACCOUNT,
  value = RAW_CLAIM_AMOUNT,
  status = 'FINALIZED',
  messages = null,
  children = `"${CLAIM_CHILD_HASH}"`,
  extraMessageFields = '',
} = {}) {
  const messageList = messages ?? `{"messageType":"0","recipient":"${recipient}","value":${value},"data":"","onAcceptance":false${extraMessageFields}}`;
  return rawRpcEnvelope(`{"hash":"${hash}","tx_id":"${hash}","status":"${status}","messages":[${messageList}],"triggered_transactions":[${children}]}`);
}

function rawClaimChild({
  hash = CLAIM_CHILD_HASH,
  parentHash = CLAIM_PARENT_HASH,
  recipient = CLAIM_ACCOUNT,
  value = RAW_CLAIM_AMOUNT,
  status = 'FINALIZED',
  contract = CONTRACT,
  type = '0',
  triggeredOn = 'finalized',
  valueCredited = 'true',
  includeValue = true,
  includeParentHash = true,
  includeTriggeredOn = true,
  includeType = true,
  includeValueCredited = true,
  includeSender = true,
  includeFromAddress = true,
  includeOriginAddress = true,
  extraFields = '',
} = {}) {
  const fields = [
    `"hash":"${hash}"`,
    `"tx_id":"${hash}"`,
    `"status":"${status}"`,
    `"to_address":"${recipient}"`,
    `"recipient":"${recipient}"`,
  ];
  if (includeSender) fields.push(`"sender":"${contract}"`);
  if (includeFromAddress) fields.push(`"from_address":"${contract}"`);
  if (includeOriginAddress) fields.push(`"origin_address":"${contract}"`);
  if (includeValue) fields.push(`"value":${value}`);
  if (includeType) fields.push(`"type":${type}`);
  if (includeParentHash) fields.push(`"triggered_by":"${parentHash}"`);
  if (includeTriggeredOn) fields.push(`"triggered_on":"${triggeredOn}"`);
  if (includeValueCredited) fields.push(`"value_credited":${valueCredited}`);
  return rawRpcEnvelope(`{${fields.join(',')}${extraFields}}`);
}

function studioFinalizedReceipt({
  statusName = 'FINALIZED',
  result = 6,
  resultName = 'MAJORITY_AGREE',
  leaderExecution = 'SUCCESS',
  leaderReturnStatus = 'return',
  leaders,
  rawError = null,
  errorCode = null,
} = {}) {
  const leaderReceipt = leaders ?? [{
    mode: 'leader',
    execution_result: leaderExecution,
    genvm_result: { raw_error: rawError, error_code: errorCode },
    result: { status: leaderReturnStatus, payload: { readable: 'null' } },
  }];
  return {
    status_name: statusName,
    result,
    result_name: resultName,
    consensus_data: { leader_receipt: leaderReceipt },
  };
}

function gatewayWithReadResults(results) {
  const calls = [];
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  gateway.client = {
    async readContract(call) {
      calls.push(call);
      if (results.length === 0) throw new Error('Unexpected readContract call');
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { gateway, calls };
}

test('only a non-zero 20-byte hex address is configured', () => {
  assert.equal(isConfiguredAddress('0x0000000000000000000000000000000000000000'), false);
  assert.equal(isConfiguredAddress(''), false);
  assert.equal(isConfiguredAddress('0x1234'), false);
  assert.equal(isConfiguredAddress('0x1111111111111111111111111111111111111111'), true);
  assert.equal(isConfiguredAddress('0xAaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'), true);
});

test('EIP-6963 discovery prefers MetaMask over an ambiguous legacy provider', async () => {
  const legacy = { request: async () => null };
  const compatibilityWallet = { request: async () => null, isMetaMask: true };
  const metaMask = { request: async () => null, isMetaMask: true };
  const listeners = new Map();
  const announcements = [
    { info: { name: 'Razor', rdns: 'io.razor' }, provider: legacy },
    { info: { name: 'OKX Wallet', rdns: 'com.okex.wallet' }, provider: compatibilityWallet },
    { info: { name: 'MetaMask', rdns: 'io.metamask' }, provider: metaMask },
  ];
  const fakeWindow = {
    ethereum: legacy,
    Event: class { constructor(type) { this.type = type; } },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatchEvent(event) {
      if (event.type !== 'eip6963:requestProvider') return;
      for (const detail of announcements) listeners.get('eip6963:announceProvider')?.({ detail });
    },
  };

  const selected = await selectInjectedWalletProvider(fakeWindow, 0);

  assert.equal(selected.provider, metaMask);
  assert.equal(selected.info.name, 'MetaMask');
  assert.equal(selected.source, 'eip6963');
});

test('wallet discovery falls back to the legacy injected provider', async () => {
  const legacy = { request: async () => null };
  const selected = await selectInjectedWalletProvider({ ethereum: legacy }, 0);
  assert.equal(selected.provider, legacy);
  assert.equal(selected.source, 'legacy');
});

test('browser RPC resolution always uses the same-origin hardened proxy', () => {
  assert.equal(
    resolveGenLayerWalletRpcUrl(
      'https://wallet-rpc.example/rpc',
      new URL('http://localhost:4400/market.html'),
    ),
    'http://localhost:4400/genlayer-rpc',
  );
  assert.equal(
    resolveGenLayerWalletRpcUrl(
      'https://wallet-rpc.example/rpc',
      new URL('https://arena.example/market.html'),
    ),
    'https://arena.example/genlayer-rpc',
  );
  assert.equal(
    resolveGenLayerWalletRpcUrl(
      '',
      new URL('https://arena.example/market.html'),
    ),
    'https://arena.example/genlayer-rpc',
  );
  assert.throws(
    () => resolveGenLayerWalletRpcUrl(
      'http://wallet-rpc.example/rpc',
      undefined,
    ),
    /must use HTTPS outside localhost/,
  );
});

test('transaction recovery validates hashes and reads lifecycle state without a wallet', async () => {
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  const calls = [];
  gateway.client = {
    async getTransaction(call) {
      calls.push(call);
      return { statusName: 'FINALIZED', txExecutionResultName: 'FINISHED_WITH_RETURN' };
    },
  };
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal((await gateway.readTransaction(hash)).statusName, 'FINALIZED');
  assert.deepEqual(calls, [{ hash }]);
  await assert.rejects(gateway.readTransaction('0x1234'), /32-byte/);
});

test('StudioNet is the only supported network and is the default', async () => {
  const unknown = new GenLayerGateway({ contractAddress: CONTRACT, network: 'typo-network' });
  assert.equal(unknown.configured, false);
  assert.equal(unknown.wagerConfigured, false);
  await assert.rejects(unknown.connect(), /Unsupported GenLayer network/);

  const studio = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  assert.equal(studio.configured, true);
  assert.equal(studio.walletConfigured, true);
  assert.equal(studio.wagerConfigured, true);
  const legacy = new GenLayerGateway({ contractAddress: CONTRACT, network: 'testnetBradbury' });
  assert.equal(legacy.configured, false);
  assert.equal(legacy.wagerConfigured, false);
  await assert.rejects(legacy.connect(), /Unsupported GenLayer network/);

  const defaultGateway = new GenLayerGateway({ contractAddress: CONTRACT });
  assert.equal(defaultGateway.network, 'studionet');
  assert.equal(defaultGateway.wagerConfigured, true);

  await assert.rejects(
    ensureGenLayerWalletChain(
      { request: async () => '0x107d' },
      { ...STUDIONET_CHAIN, id: 4221 },
      {
        connectName: 'testnetBradbury',
        label: 'LEGACY',
        chainId: 4221,
        chainIdHex: '0x107d',
        walletWagers: true,
      },
    ),
    /Only GenLayer StudioNet/,
  );
});

test('browser reads route through the same-origin GenLayer RPC adapter', async () => {
  const creations = [];
  const reads = [];
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://stale-build-value.example/rpc',
    locationRef: new URL('https://arena.example/market.html'),
    sdkLoader: async () => ({
      chain: STUDIONET_CHAIN,
      createClient(options) {
        creations.push(options);
        return {
          async readContract(call) {
            reads.push(call);
            return { configured: true };
          },
        };
      },
    }),
  });

  assert.deepEqual(await gateway.readConfig(), { configured: true });
  assert.equal(creations.length, 1);
  assert.equal(creations[0].chain, STUDIONET_CHAIN);
  assert.equal(creations[0].endpoint, 'https://arena.example/genlayer-rpc');
  assert.equal(reads[0].functionName, 'get_config');
});

test('wallet connection configures and verifies StudioNet chain 61999', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const calls = [];
  const creations = [];
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_chainId') return '0xf22f';
      if (request.method === 'wallet_addEthereumChain') return null;
      throw new Error(`Unexpected ${request.method}`);
    },
    on() {},
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://wallet-rpc.example/rpc',
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient(options) { creations.push(options); return {}; },
    }),
  });

  const connected = await gateway.connect();

  assert.equal(connected.chainId, STUDIONET_CHAIN_ID);
  assert.equal(connected.network, 'STUDIONET');
  assert.equal(gateway.connected, true);
  assert.equal(creations[0].provider, provider);
  const addRequest = calls.find(({ method }) => method === 'wallet_addEthereumChain');
  assert.deepEqual(addRequest.params, [{
    chainId: '0xf22f',
    chainName: 'Genlayer Studio Network',
    nativeCurrency: { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
    rpcUrls: ['https://wallet-rpc.example/rpc'],
    blockExplorerUrls: ['https://genlayer-explorer.vercel.app'],
  }]);
  assert.equal(calls.some(({ method }) => method === 'wallet_switchEthereumChain'), false);
});

test('StudioNet configuration rejects a mismatched SDK chain descriptor before creating a client', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  let createCalls = 0;
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    provider: {
      async request({ method }) {
        if (method === 'eth_requestAccounts') return [account];
        throw new Error(`Unexpected ${method}`);
      },
    },
    sdkLoader: async () => ({
      chain: { ...STUDIONET_CHAIN, id: 4221 },
      createClient() { createCalls += 1; return {}; },
    }),
  });

  await assert.rejects(gateway.connect(), /invalid STUDIONET chain descriptor/);
  assert.equal(createCalls, 0);
  assert.equal(gateway.connected, false);
});

test('wallet connection configures an active StudioNet chain with the selected RPC', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const methods = [];
  let addRequest;
  const provider = {
    async request(request) {
      const { method } = request;
      methods.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0xf22f';
      if (method === 'wallet_addEthereumChain') {
        addRequest = request;
        return null;
      }
      throw new Error(`Unexpected ${method}`);
    },
    on() {},
  };
  const creations = [];
  const client = {};
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://wallet-rpc.example/rpc',
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient(options) { creations.push(options); return client; },
    }),
  });
  const connected = await gateway.connect();
  assert.equal(connected.chainId, STUDIONET_CHAIN_ID);
  assert.equal(gateway.connected, true);
  assert.equal(creations[0].provider, provider);
  assert.equal(creations[0].account, account);
  assert.deepEqual(addRequest.params[0].rpcUrls, ['https://wallet-rpc.example/rpc']);
  assert.equal(methods.filter((method) => method === 'wallet_addEthereumChain').length, 1);
  assert.ok(methods.indexOf('wallet_addEthereumChain') < methods.indexOf('eth_chainId'));
  assert.equal(methods.includes('wallet_switchEthereumChain'), false);
  assert.equal(methods.includes('wallet_getSnaps'), false);
  assert.equal(methods.includes('wallet_requestSnaps'), false);
});

test('wrong-chain wallets configure the StudioNet RPC before switching', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const calls = [];
  let chainId = '0x1';
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_chainId') return chainId;
      if (request.method === 'wallet_addEthereumChain') return null;
      if (request.method === 'wallet_switchEthereumChain') {
        assert.deepEqual(request.params, [{ chainId: '0xf22f' }]);
        chainId = '0xf22f';
        return null;
      }
      throw new Error(`Unexpected ${request.method}`);
    },
    on() {},
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://wallet-rpc.example/rpc',
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient: () => ({}),
    }),
  });

  const connected = await gateway.connect();

  assert.equal(connected.chainId, STUDIONET_CHAIN_ID);
  const addRequest = calls.find(({ method }) => method === 'wallet_addEthereumChain');
  assert.deepEqual(addRequest.params[0].rpcUrls, ['https://wallet-rpc.example/rpc']);
  assert.equal(calls.filter(({ method }) => method === 'wallet_addEthereumChain').length, 1);
  assert.ok(calls.indexOf(addRequest) < calls.findIndex(({ method }) => method === 'wallet_switchEthereumChain'));
  assert.equal(calls.filter(({ method }) => method === 'wallet_switchEthereumChain').length, 1);
  assert.equal(calls.some(({ method }) => method === 'wallet_getSnaps'), false);
});

test('unknown StudioNet chains are added with exact GEN metadata and then switched', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const calls = [];
  let chainId = '0x1';
  let switchAttempts = 0;
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_chainId') return chainId;
      if (request.method === 'wallet_switchEthereumChain') {
        switchAttempts += 1;
        if (switchAttempts === 1) {
          throw Object.assign(new Error('Unknown chain'), {
            data: { originalError: { code: 4902, message: 'Unrecognized chain ID' } },
          });
        }
        chainId = request.params[0].chainId;
        return null;
      }
      if (request.method === 'wallet_addEthereumChain') return null;
      throw new Error(`Unexpected ${request.method}`);
    },
    on() {},
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://wallet-rpc.example/rpc',
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient: () => ({}),
    }),
  });

  await gateway.connect();

  const addRequest = calls.find(({ method }) => method === 'wallet_addEthereumChain');
  assert.deepEqual(addRequest.params, [{
    chainId: '0xf22f',
    chainName: 'Genlayer Studio Network',
    nativeCurrency: { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
    rpcUrls: ['https://wallet-rpc.example/rpc'],
    blockExplorerUrls: ['https://genlayer-explorer.vercel.app'],
  }]);
  assert.equal(calls.filter(({ method }) => method === 'wallet_addEthereumChain').length, 1);
  assert.equal(switchAttempts, 2);
  assert.equal(calls.some(({ method }) => method === 'wallet_getSnaps'), false);
});

test('a rejected StudioNet network switch fails closed and leaves the gateway disconnected', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const provider = {
    async request({ method }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 });
      }
      throw new Error(`Unexpected ${method}`);
    },
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient: () => ({}),
    }),
  });

  await assert.rejects(gateway.connect(), /network request was cancelled/);
  assert.equal(gateway.connected, false);
});

test('a rejected active-chain RPC migration fails closed and leaves the gateway disconnected', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const methods = [];
  const provider = {
    async request({ method }) {
      methods.push(method);
      if (method === 'eth_requestAccounts') return [account];
      if (method === 'wallet_addEthereumChain') {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 });
      }
      throw new Error(`Unexpected ${method}`);
    },
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://wallet-rpc.example/rpc',
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient: () => ({}),
    }),
  });

  await assert.rejects(gateway.connect(), /network request was cancelled/);
  assert.deepEqual(methods, ['eth_requestAccounts', 'wallet_addEthereumChain']);
  assert.equal(gateway.connected, false);
});

test('V6 wallet position reads encode account strings as GenVM address calldata', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const calls = [];
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  gateway.client = {
    async readContract(call) {
      calls.push(call);
      return {};
    },
  };

  await gateway.readEpochEntry(1_787_162_400, 'HIGH', account);
  await gateway.readEpochClaimQuote(1_787_162_400, 'LOW', account);

  assert.deepEqual(calls.map(({ functionName }) => functionName), ['get_entry', 'get_claim_quote']);
  for (const call of calls) {
    assert.equal(call.args[0], 1_787_162_400n);
    assert.match(call.args[1], /HIGH|LOW/);
    assert.equal(typeof call.args[2], 'object');
    assert.deepEqual([...call.args[2].bytes], Array(20).fill(0x22));
  }
});

test('V6 wallet position reads reject malformed account addresses before contract calls', async () => {
  let readCalls = 0;
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  gateway.client = { async readContract() { readCalls += 1; return {}; } };

  await assert.rejects(
    gateway.readEpochEntry(1_787_162_400, 'HIGH', '0x1234'),
    /20-byte 0x-prefixed address/,
  );
  await assert.rejects(
    gateway.readEpochClaimQuote(1_787_162_400, 'LOW', 'not-an-address'),
    /20-byte 0x-prefixed address/,
  );
  assert.equal(readCalls, 0);
});

test('a FINALIZED lifecycle receipt is rejected unless contract execution returned successfully', () => {
  assert.throws(
    () => assertFinalizedExecution({ statusName: 'FINALIZED', txExecutionResultName: 'FINISHED_WITH_ERROR' }),
    /contract execution was FINISHED_WITH_ERROR/,
  );
  assert.equal(
    assertFinalizedExecution({
      statusName: 'FINALIZED',
      resultName: 'AGREE',
      txExecutionResultName: 'FINISHED_WITH_RETURN',
    }).statusName,
    'FINALIZED',
  );
  assert.throws(
    () => assertFinalizedExecution({ txExecutionResultName: 'FINISHED_WITH_RETURN' }),
    /transaction is UNKNOWN, not FINALIZED/,
  );
});

test('StudioNet FINALIZED leader-return receipt is accepted as successful execution', () => {
  const receipt = studioFinalizedReceipt();
  assert.equal(assertFinalizedExecution(receipt), receipt);
});

test('StudioNet receipt validation ignores a quorum-cancelled validator after the authoritative leader', () => {
  const receipt = studioFinalizedReceipt({
    leaders: [
      {
        mode: 'leader',
        execution_result: 'SUCCESS',
        genvm_result: { raw_error: null, error_code: null },
        result: { status: 'return', payload: { readable: 'null' } },
      },
      {
        mode: 'validator',
        vote: 'idle',
        execution_result: 'ERROR',
        genvm_result: {
          raw_error: { fatal: false, causes: ['VALIDATOR_QUORUM_REACHED'] },
          error_code: 'VALIDATOR_QUORUM_REACHED',
        },
        result: { status: 'error' },
      },
    ],
  });

  assert.equal(assertFinalizedExecution(receipt), receipt);
});

test('StudioNet receipt validation fails closed on consensus and result errors', () => {
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ statusName: 'ACCEPTED' })),
    /transaction is ACCEPTED, not FINALIZED/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ resultName: 'MAJORITY_DISAGREE' })),
    /consensus result is MAJORITY_DISAGREE/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ result: 5 })),
    /result code is 5, not 6/,
  );
  const missingConsensus = studioFinalizedReceipt();
  delete missingConsensus.consensus_data;
  assert.throws(
    () => assertFinalizedExecution(missingConsensus),
    /did not report consensus_data/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ leaders: [] })),
    /did not report leader_receipt evidence/,
  );
});

test('StudioNet receipt validation rejects malformed, failed, or conflicting leader evidence', () => {
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ leaderExecution: 'ERROR' })),
    /execution_result is ERROR, not SUCCESS/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ leaderReturnStatus: 'error' })),
    /result.status is ERROR, not return/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ rawError: { cause: 'boom' } })),
    /reported a GenVM raw error/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({ errorCode: 'GENVM_ERROR' })),
    /reported a GenVM error code/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({
      leaders: [
        { mode: 'validator', execution_result: 'SUCCESS', result: { status: 'return' } },
        { mode: 'leader', execution_result: 'ERROR', result: { status: 'error' } },
      ],
    })),
    /leader_receipt\[1\] execution_result is ERROR/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({
      leaders: [
        { mode: 'leader', execution_result: 'SUCCESS', result: { status: 'return' } },
        { mode: 'leader', execution_result: 'SUCCESS', result: { status: 'return' } },
      ],
    })),
    /exactly one authoritative mode=leader entry; received 2/,
  );
  assert.throws(
    () => assertFinalizedExecution(studioFinalizedReceipt({
      leaders: [
        { mode: 'validator', execution_result: 'ERROR', result: { status: 'error' } },
      ],
    })),
    /exactly one authoritative mode=leader entry; received 0/,
  );
  assert.throws(
    () => assertFinalizedExecution({
      ...studioFinalizedReceipt(),
      txExecutionResultName: 'FINISHED_WITH_ERROR',
    }),
    /conflicting execution result evidence/,
  );
});

test('claim delivery validation fails closed for acceptance-time or malformed value messages', () => {
  const account = '0x2222222222222222222222222222222222222222';
  const base = {
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    messages: [{
      recipient: account,
      value: '200',
      data: '0x',
      messageType: 0,
      saltNonce: 0,
      onAcceptance: false,
    }],
  };
  const verified = verifyClaimTransferMessage(base, account, 200n);
  assert.equal(verified.valueAtto, 200n);
  assert.equal(verifyClaimTransferMessage({
    messages: [{
      messageType: '0',
      recipient: account,
      value: '200',
      data: '',
      onAcceptance: false,
    }],
  }, account, 200n).valueAtto, 200n);
  assert.throws(
    () => verifyClaimTransferMessage({
      ...base,
      messages: [{ ...base.messages[0], value: Number(RAW_CLAIM_AMOUNT) }],
    }, account, BigInt(RAW_CLAIM_AMOUNT)),
    /not an unsigned integer/,
  );
  assert.throws(
    () => verifyClaimTransferMessage({
      ...base,
      messages: [{ ...base.messages[0], value: '201' }],
    }, account, 200n),
    /does not exactly match the quoted payout/,
  );
  assert.throws(
    () => verifyClaimTransferMessage({
      ...base,
      messages: [{ ...base.messages[0], onAcceptance: true }],
    }, account, 200n),
    /finalization-only value transfer/,
  );
  assert.throws(
    () => verifyClaimTransferMessage({
      ...base,
      messages: [{ ...base.messages[0], data: '0x1234' }],
    }, account, 200n),
    /not a plain value transfer/,
  );
  assert.throws(
    () => verifyClaimTransferMessage({
      ...base,
      messages: [{ ...base.messages[0], messageType: '1' }],
    }, account, 200n),
    /not a plain value-transfer message type/,
  );
});

test('lossless raw proof accepts the real Studio integer and message shape', () => {
  const parent = parseRawGenLayerTransactionResponse(
    rawClaimParent(),
    CLAIM_PARENT_HASH,
  );
  assert.equal(typeof parent.messages[0].value, 'bigint');
  assert.equal(parent.messages[0].value, 100_000_000_000_000_000n);
  assert.deepEqual(
    verifyRawClaimParentTransaction(parent, {
      hash: CLAIM_PARENT_HASH,
      recipient: CLAIM_ACCOUNT,
      amountAtto: 100_000_000_000_000_000n,
      childHash: CLAIM_CHILD_HASH,
    }),
    {
      hash: CLAIM_PARENT_HASH,
      childHash: CLAIM_CHILD_HASH,
      amountAtto: 100_000_000_000_000_000n,
    },
  );

  const child = parseRawGenLayerTransactionResponse(rawClaimChild(), CLAIM_CHILD_HASH);
  assert.equal(child.value, 100_000_000_000_000_000n);
  assert.deepEqual(
    verifyRawClaimChildTransaction(child, {
      hash: CLAIM_CHILD_HASH,
      parentHash: CLAIM_PARENT_HASH,
      recipient: CLAIM_ACCOUNT,
      amountAtto: 100_000_000_000_000_000n,
      contractAddress: CONTRACT,
    }),
    {
      hash: CLAIM_CHILD_HASH,
      recipient: CLAIM_ACCOUNT,
      contractAddress: CONTRACT,
      amountAtto: 100_000_000_000_000_000n,
    },
  );
});

test('lossless raw proof rejects malformed, duplicate, and ambiguous JSON evidence', () => {
  const duplicateValue = rawClaimParent({
    messages: `{"messageType":"0","recipient":"${CLAIM_ACCOUNT}","value":${RAW_CLAIM_AMOUNT},"value":${RAW_CLAIM_AMOUNT},"data":"","onAcceptance":false}`,
  });
  assert.throws(
    () => parseRawGenLayerTransactionResponse(duplicateValue, CLAIM_PARENT_HASH),
    /duplicate object key "value"/,
  );
  assert.throws(
    () => parseRawGenLayerTransactionResponse(
      `{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1}}`,
      CLAIM_PARENT_HASH,
    ),
    /ambiguous/,
  );
  assert.throws(
    () => parseRawGenLayerTransactionResponse(rawClaimParent().replace('"id":1', '"id":"1"'), CLAIM_PARENT_HASH),
    /response ID does not match/,
  );
  assert.throws(
    () => parseRawGenLayerTransactionResponse('{"jsonrpc":"2.0","id":1', CLAIM_PARENT_HASH),
    /invalid JSON/,
  );
  assert.throws(
    () => parseRawGenLayerTransactionResponse(' '.repeat((512 * 1024) + 1), CLAIM_PARENT_HASH),
    /too large/,
  );
  assert.throws(
    () => parseRawGenLayerTransactionResponse(
      rawClaimParent({ value: '1'.repeat(129) }),
      CLAIM_PARENT_HASH,
    ),
    /integer token has too many digits/,
  );
  assert.throws(
    () => parseRawGenLayerTransactionResponse(
      rawRpcEnvelope(`{"hash":"${CLAIM_PARENT_HASH}","noise":[${Array(50_001).fill('null').join(',')}]}`),
      CLAIM_PARENT_HASH,
    ),
    /maximum node count exceeded/,
  );

  const ambiguousMessage = parseRawGenLayerTransactionResponse(
    rawClaimParent({ extraMessageFields: ',"on_acceptance":false' }),
    CLAIM_PARENT_HASH,
  );
  assert.throws(
    () => verifyRawClaimParentTransaction(ambiguousMessage, {
      hash: CLAIM_PARENT_HASH,
      recipient: CLAIM_ACCOUNT,
      amountAtto: RAW_CLAIM_AMOUNT,
      childHash: CLAIM_CHILD_HASH,
    }),
    /ambiguous claim message finality fields/,
  );
});

test('same-origin raw proof reads are stream-bounded before parsing', async () => {
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    locationRef: { origin: 'https://arena.example' },
    fetchImpl: async () => new Response(' '.repeat((512 * 1024) + 1), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    gateway._readRawTransactionProof(CLAIM_PARENT_HASH),
    /too large/,
  );
});

test('raw parent proof rejects wrong hashes, recipients, values, messages, and children', () => {
  const otherHash = `0x${'ef'.repeat(32)}`;
  const otherAccount = '0x3333333333333333333333333333333333333333';
  assert.throws(
    () => parseRawGenLayerTransactionResponse(rawClaimParent({ hash: otherHash }), CLAIM_PARENT_HASH),
    /does not match the requested hash/,
  );

  const cases = [
    [rawClaimParent({ recipient: otherAccount }), /recipient does not match/],
    [rawClaimParent({ value: '100000000000000001' }), /does not exactly match/],
    [rawClaimParent({ messages: '' }), /exactly one transfer message/],
    [rawClaimParent({
      messages: `{"messageType":"0","recipient":"${CLAIM_ACCOUNT}","value":${RAW_CLAIM_AMOUNT},"data":"","onAcceptance":false},{"messageType":"0","recipient":"${CLAIM_ACCOUNT}","value":${RAW_CLAIM_AMOUNT},"data":"","onAcceptance":false}`,
    }), /exactly one transfer message/],
    [rawClaimParent({ children: '' }), /exactly one triggered child/],
    [rawClaimParent({ children: `"${CLAIM_CHILD_HASH}","${otherHash}"` }), /exactly one triggered child/],
    [rawClaimParent({ children: `"${otherHash}"` }), /does not match the discovered child/],
  ];
  for (const [raw, pattern] of cases) {
    const transaction = parseRawGenLayerTransactionResponse(raw, CLAIM_PARENT_HASH);
    assert.throws(
      () => verifyRawClaimParentTransaction(transaction, {
        hash: CLAIM_PARENT_HASH,
        recipient: CLAIM_ACCOUNT,
        amountAtto: RAW_CLAIM_AMOUNT,
        childHash: CLAIM_CHILD_HASH,
      }),
      pattern,
    );
  }
});

test('raw child proof requires an exact finalized credited transfer from the claim contract', () => {
  const otherHash = `0x${'ef'.repeat(32)}`;
  const otherAccount = '0x3333333333333333333333333333333333333333';
  const cases = [
    [rawClaimChild({ status: 'ACCEPTED' }), /not FINALIZED/],
    [rawClaimChild({ recipient: otherAccount }), /recipient does not match/],
    [rawClaimChild({ value: '100000000000000001' }), /does not exactly match/],
    [rawClaimChild({ includeValue: false }), /missing claim child value/],
    [rawClaimChild({ parentHash: otherHash }), /expected parent hash/],
    [rawClaimChild({ includeParentHash: false }), /missing claim child parent hash/],
    [rawClaimChild({ triggeredOn: 'accepted' }), /not triggered on parent finalization/],
    [rawClaimChild({ includeTriggeredOn: false }), /missing claim child trigger finality/],
    [rawClaimChild({ type: '1' }), /not a native value-transfer transaction type/],
    [rawClaimChild({ includeType: false }), /missing claim child type/],
    [rawClaimChild({ valueCredited: 'false' }), /did not credit its exact value/],
    [rawClaimChild({ includeValueCredited: false }), /missing claim child value credit status/],
    [rawClaimChild({ extraFields: ',"valueCredited":true' }), /ambiguous claim child value credit status fields/],
    [rawClaimChild({ contract: otherAccount }), /does not match the claim contract/],
    [rawClaimChild({ includeSender: false }), /missing claim child sender/],
    [rawClaimChild({ includeFromAddress: false }), /missing claim child from address/],
    [rawClaimChild({ includeOriginAddress: false }), /missing claim child origin address/],
    [rawClaimChild({ extraFields: `,"fromAddress":"${otherAccount}"` }), /ambiguous claim child from address fields/],
  ];
  for (const [raw, pattern] of cases) {
    const transaction = parseRawGenLayerTransactionResponse(raw, CLAIM_CHILD_HASH);
    assert.throws(
      () => verifyRawClaimChildTransaction(transaction, {
        hash: CLAIM_CHILD_HASH,
        parentHash: CLAIM_PARENT_HASH,
        recipient: CLAIM_ACCOUNT,
        amountAtto: RAW_CLAIM_AMOUNT,
        contractAddress: CONTRACT,
      }),
      pattern,
    );
  }
  assert.throws(
    () => parseRawGenLayerTransactionResponse(rawClaimChild({ hash: otherHash }), CLAIM_CHILD_HASH),
    /does not match the requested hash/,
  );
});

test('claim delivery rejects an exposed child value above the exact quoted payout', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  gateway.client = {
    async getTransaction({ hash }) {
      if (hash === CLAIM_PARENT_HASH) {
        return {
          hash,
          statusName: 'FINALIZED',
          txExecutionResultName: 'FINISHED_WITH_RETURN',
          messages: [{
            recipient: account,
            value: '200',
            data: '0x',
            messageType: 0,
            saltNonce: 0,
            onAcceptance: false,
          }],
        };
      }
      assert.equal(hash, CLAIM_CHILD_HASH);
      return {
        hash,
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        recipient: account,
        value: '201',
      };
    },
    async getTriggeredTransactionIds({ hash }) {
      assert.equal(hash, CLAIM_PARENT_HASH);
      return [CLAIM_CHILD_HASH];
    },
    async waitForTransactionReceipt({ hash, status }) {
      assert.equal(hash, CLAIM_CHILD_HASH);
      assert.equal(status, 'FINALIZED');
      return { statusName: 'FINALIZED', txExecutionResultName: 'FINISHED_WITH_RETURN' };
    },
  };

  await assert.rejects(
    gateway.verifyClaimDelivery(CLAIM_PARENT_HASH, {
      recipient: account,
      minimumValueAtto: 200n,
      interval: 0,
      discoveryRetries: 0,
      finalityRetries: 0,
    }),
    (error) => error?.deliveryStatus === 'REVIEW'
      && error?.hash === CLAIM_PARENT_HASH
      && error?.childHash === CLAIM_CHILD_HASH
      && /does not exactly match the quoted payout/.test(error.message),
  );
});

test('claim delivery uses same-origin lossless proofs when Studio SDK values are unsafe numbers', async () => {
  const unsafeSdkValue = Number(RAW_CLAIM_AMOUNT);
  assert.equal(Number.isSafeInteger(unsafeSdkValue), false);
  const requests = [];
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    walletRpcUrl: 'https://untrusted-rpc.example/',
    locationRef: { origin: 'https://arena.example' },
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      requests.push({ url, options, request });
      const body = request.params[0] === CLAIM_PARENT_HASH
        ? rawClaimParent()
        : rawClaimChild();
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
  gateway.client = {
    async getTransaction({ hash }) {
      if (hash === CLAIM_PARENT_HASH) {
        return {
          hash,
          statusName: 'FINALIZED',
          txExecutionResultName: 'FINISHED_WITH_RETURN',
          messages: [{
            messageType: '0',
            recipient: CLAIM_ACCOUNT,
            value: unsafeSdkValue,
            data: '',
            onAcceptance: false,
          }],
        };
      }
      assert.equal(hash, CLAIM_CHILD_HASH);
      return {
        hash,
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        recipient: CLAIM_ACCOUNT,
        value: unsafeSdkValue,
      };
    },
    async getTriggeredTransactionIds({ hash }) {
      assert.equal(hash, CLAIM_PARENT_HASH);
      return [CLAIM_CHILD_HASH];
    },
    async waitForTransactionReceipt({ hash, status }) {
      assert.equal(hash, CLAIM_CHILD_HASH);
      assert.equal(status, 'FINALIZED');
      return { statusName: 'FINALIZED', txExecutionResultName: 'FINISHED_WITH_RETURN' };
    },
  };

  const delivery = await gateway.verifyClaimDelivery(CLAIM_PARENT_HASH, {
    recipient: CLAIM_ACCOUNT,
    minimumValueAtto: BigInt(RAW_CLAIM_AMOUNT),
    interval: 0,
    discoveryRetries: 0,
    finalityRetries: 0,
  });

  assert.equal(delivery.status, 'DELIVERED');
  assert.equal(delivery.childHash, CLAIM_CHILD_HASH);
  assert.equal(delivery.proofMode, 'RAW_SAME_ORIGIN');
  assert.equal(requests.length, 2);
  for (const { url, options, request } of requests) {
    assert.equal(url, 'https://arena.example/genlayer-rpc');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(request.id, 1);
    assert.equal(request.method, 'eth_getTransactionByHash');
  }
  assert.deepEqual(requests.map(({ request }) => request.params[0]), [
    CLAIM_PARENT_HASH,
    CLAIM_CHILD_HASH,
  ]);
});

test('claim delivery recovery stays in REVIEW until one exact child is provably finalized', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  gateway.client = {
    async getTransaction({ hash }) {
      assert.equal(hash, CLAIM_PARENT_HASH);
      return {
        hash,
        statusName: 'FINALIZED',
        txExecutionResultName: 'FINISHED_WITH_RETURN',
        messages: [{
          recipient: account,
          value: '200',
          data: '0x',
          messageType: 0,
          saltNonce: 0,
          onAcceptance: false,
        }],
      };
    },
    async getTriggeredTransactionIds() { return []; },
  };

  await assert.rejects(
    gateway.verifyClaimDelivery(CLAIM_PARENT_HASH, {
      recipient: account,
      minimumValueAtto: 200n,
      interval: 0,
      discoveryRetries: 0,
      finalityRetries: 0,
    }),
    (error) => error?.deliveryStatus === 'REVIEW'
      && error?.hash === CLAIM_PARENT_HASH
      && /no triggered transfer transaction/.test(error.message),
  );
});

test('V6 epoch reads use one exact-hour timestamp and objective-specific state', async () => {
  const { gateway, calls } = gatewayWithReadResults([
    { status: 'OPEN', result_status: 'PENDING' },
    { objective: 'HIGH', settlement_mode: 'PENDING' },
    [{ epoch_id: '1787162400' }],
  ]);

  assert.deepEqual(await gateway.readEpoch(1_787_162_400), {
    status: 'OPEN', result_status: 'PENDING',
  });
  assert.deepEqual(await gateway.readObjective('1787162400', 'high'), {
    objective: 'HIGH', settlement_mode: 'PENDING',
  });
  assert.deepEqual(await gateway.readEpochPage(0, 20), [{ epoch_id: '1787162400' }]);
  assert.deepEqual(calls.map(({ functionName, args }) => ({ functionName, args })), [
    { functionName: 'get_epoch', args: [1_787_162_400n] },
    { functionName: 'get_objective', args: [1_787_162_400n, 'HIGH'] },
    { functionName: 'get_epoch_page', args: [0, 20] },
  ]);
  await assert.rejects(() => gateway.readObjective(1_787_162_400, 'HIGHEST_RETURN'), /HIGH or LOW/);
  await assert.rejects(() => gateway.readEpochPage(0, 51), /between 1 and 50/);
});

test('recent V6 epoch IDs use a bounded tail page without probing missing epochs', async () => {
  const { gateway, calls } = gatewayWithReadResults([
    '75',
    { epoch_ids: ['1787151600', '1787155200'] },
  ]);

  assert.deepEqual(await gateway.readRecentEpochIds(50), {
    total: 75,
    epochEndTimestamps: [1_787_151_600, 1_787_155_200],
  });
  assert.deepEqual(calls.map(({ functionName, args }) => ({ functionName, args })), [
    { functionName: 'get_epoch_count', args: [] },
    { functionName: 'get_epoch_page', args: [25, 50] },
  ]);
  await assert.rejects(() => gateway.readRecentEpochIds(51), /between 1 and 50/);
});

test('V6 placeEpochWager sends objective, asset, and exact native StudioNet GEN value', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const amount = 500_000_000_000_000_000n;
  const provider = {
    async request({ method }) {
      if (method === 'eth_chainId') return '0xf22f';
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_getBalance') return `0x${amount.toString(16)}`;
      throw new Error(`Unexpected ${method}`);
    },
  };
  const calls = [];
  const gateway = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet', provider });
  gateway.account = account;
  gateway.walletVerified = true;
  let readCount = 0;
  gateway.client = {
    async readContract(call) {
      calls.push({ type: 'read', call });
      readCount += 1;
      return readCount === 1
        ? { choice_asset_id: '', stake_atto: '0' }
        : { choice_asset_id: 'BTC', stake_atto: amount.toString() };
    },
    async writeContract(call) {
      calls.push({ type: 'write', call });
      return `0x${'ef'.repeat(32)}`;
    },
    async waitForTransactionReceipt() { return studioFinalizedReceipt(); },
  };

  const result = await gateway.placeEpochWager(1_787_162_400, 'high', 'btc', amount);
  assert.equal(result.entry.stake_atto, amount.toString());
  const write = calls.find(({ type }) => type === 'write').call;
  assert.equal(write.functionName, 'enter');
  assert.deepEqual(write.args, [1_787_162_400n, 'HIGH', 'BTC']);
  assert.equal(write.value, amount);
});

test('legacy deployment gateway rejects new wagers before wallet or contract access', async () => {
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    deploymentAlias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    newWagersEnabled: false,
  });
  assert.equal(gateway.walletConfigured, true);
  assert.equal(gateway.wagerConfigured, false);
  await assert.rejects(
    () => gateway.placeEpochWager(1_787_162_400, 'HIGH', 'BTC', 1n),
    /disabled for this legacy deployment/,
  );
});

test('legacy V6 can connect and read while new wagers remain disabled', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const provider = {
    async request({ method }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0xf22f';
      if (method === 'wallet_addEthereumChain') return null;
      throw new Error(`Unexpected ${method}`);
    },
    on() {},
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    deploymentAlias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    newWagersEnabled: false,
    provider,
    sdkLoader: async () => ({
      descriptor: { connectName: 'studionet' },
      chain: STUDIONET_CHAIN,
      createClient: () => ({
        async readContract() {
          return { status: 'TIMED_OUT', result_status: 'TIMEOUT' };
        },
      }),
    }),
  });

  const connected = await gateway.connect();
  assert.equal(connected.address, account);
  assert.equal(gateway.connected, true);
  assert.deepEqual(await gateway.readEpoch(1_787_162_400), {
    status: 'TIMED_OUT',
    result_status: 'TIMEOUT',
  });
  await assert.rejects(
    () => gateway.placeEpochWager(1_787_162_400, 'HIGH', 'BTC', 1n),
    /disabled for this legacy deployment/,
  );
});

test('gateway rejects arbitrary or protocol-conflicting deployment identities', () => {
  assert.throws(() => new GenLayerGateway({
    contractAddress: CONTRACT,
    deploymentAlias: 'arbitrary',
    protocolVersion: 'LIQUIDITY_ARENA_V7',
  }), /not allowlisted/);
  assert.throws(() => new GenLayerGateway({
    contractAddress: CONTRACT,
    deploymentAlias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V7',
  }), /do not match/);
});

test('V6 claimEpoch is nonpayable and verifies the objective-specific claim and delivery', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const amount = 750_000_000_000_000_000n;
  const provider = { async request({ method }) {
    if (method === 'eth_chainId') return '0xf22f';
    if (method === 'eth_accounts') return [account];
    throw new Error(`Unexpected ${method}`);
  } };
  const calls = [];
  const submitted = [];
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    deploymentAlias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    newWagersEnabled: false,
    provider,
  });
  gateway.account = account;
  gateway.walletVerified = true;
  gateway.client = {
    async readContract(call) {
      calls.push({ type: 'read', call });
      if (call.functionName === 'get_claim_quote') {
        return { eligible: true, claimed: false, claim_amount_atto: amount.toString() };
      }
      return { claimed: true, claimed_amount_atto: amount.toString() };
    },
    async writeContract(call) { calls.push({ type: 'write', call }); return CLAIM_PARENT_HASH; },
    async waitForTransactionReceipt(call) {
      calls.push({ type: 'receipt', call });
      return studioFinalizedReceipt();
    },
  };
  gateway.verifyClaimDelivery = async (hash, options) => {
    assert.equal(hash, CLAIM_PARENT_HASH);
    assert.equal(options.recipient, account);
    assert.equal(options.minimumValueAtto, amount);
    return { status: 'DELIVERED', childHash: CLAIM_CHILD_HASH };
  };

  const result = await gateway.claimEpoch(1_787_162_400, 'low', {
    onSubmitted: (hash, submission) => submitted.push({ hash, submission }),
  });

  assert.equal(result.delivery.childHash, CLAIM_CHILD_HASH);
  assert.deepEqual(submitted, [{
    hash: CLAIM_PARENT_HASH,
    submission: {
      account,
      contractAddress: CONTRACT,
      epochEndTimestamp: '1787162400',
      objective: 'LOW',
    },
  }]);
  const write = calls.find(({ type }) => type === 'write').call;
  assert.equal(write.functionName, 'claim');
  assert.deepEqual(write.args, [1_787_162_400n, 'LOW']);
  assert.equal(write.value, 0n);
});

test('V6 claimEpoch rejects a finalized claimed amount above the exact quote', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const amount = 750_000_000_000_000_000n;
  const provider = { async request({ method }) {
    if (method === 'eth_chainId') return '0xf22f';
    if (method === 'eth_accounts') return [account];
    throw new Error(`Unexpected ${method}`);
  } };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    deploymentAlias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    newWagersEnabled: false,
    provider,
  });
  gateway.account = account;
  gateway.walletVerified = true;
  let readCount = 0;
  gateway.client = {
    async readContract() {
      readCount += 1;
      return readCount === 1
        ? { eligible: true, claimed: false, amount_atto: amount.toString() }
        : { claimed: true, claimed_atto: (amount + 1n).toString() };
    },
    async writeContract() { return CLAIM_PARENT_HASH; },
    async waitForTransactionReceipt() { return studioFinalizedReceipt(); },
  };
  let deliveryChecked = false;
  gateway.verifyClaimDelivery = async () => {
    deliveryChecked = true;
    throw new Error('Delivery verification should not run for inconsistent claim state.');
  };

  await assert.rejects(
    gateway.claimEpoch(1_787_162_400, 'low'),
    (error) => error?.hash === CLAIM_PARENT_HASH
      && /does not exactly match the quoted payout/.test(error.message),
  );
  assert.equal(deliveryChecked, false);
});

test('V6 timeout activation is permissionless and verifies irreversible timed-out state', async () => {
  const account = '0x2222222222222222222222222222222222222222';
  const provider = { async request({ method }) {
    if (method === 'eth_chainId') return '0xf22f';
    if (method === 'eth_accounts') return [account];
    throw new Error(`Unexpected ${method}`);
  } };
  const calls = [];
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'studionet',
    deploymentAlias: 'v6',
    protocolVersion: 'LIQUIDITY_ARENA_V6',
    newWagersEnabled: false,
    provider,
  });
  gateway.account = account;
  gateway.walletVerified = true;
  gateway.client = {
    async writeContract(call) { calls.push(call); return `0x${'12'.repeat(32)}`; },
    async waitForTransactionReceipt() { return studioFinalizedReceipt(); },
    async readContract() { return { status: 'TIMED_OUT', result_status: 'TIMEOUT' }; },
  };

  const result = await gateway.activateTimeoutRefund('1787162400');
  assert.equal(result.epoch.status, 'TIMED_OUT');
  assert.deepEqual(calls[0], {
    address: CONTRACT,
    functionName: 'activate_timeout_refund',
    args: [1_787_162_400n],
    value: 0n,
  });
});
