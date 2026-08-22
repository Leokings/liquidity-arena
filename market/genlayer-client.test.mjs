import assert from 'node:assert/strict';
import test from 'node:test';

import { Interface, keccak256, toUtf8Bytes } from 'ethers';

import {
  BRADBURY_CHAIN_ID,
  BRADBURY_CHAIN_ID_HEX,
  GenLayerGateway,
  assertFinalizedExecution,
  ensureGenLayerWalletChain,
  isConfiguredAddress,
  normalizeGenLayerNetwork,
  resolveGenLayerWalletRpcUrl,
  selectInjectedWalletProvider,
} from './genlayer-client.js';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const ACCOUNT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const VAULT = '0x4444444444444444444444444444444444444444';
const RESERVE = '0x5555555555555555555555555555555555555555';
const FACTORY = '0x944fdadd826c2a159c63cb100db174716ccd1317';
const HASH = `0x${'ab'.repeat(32)}`;
const PAYOUT_ID = 'cd'.repeat(32);
const EPOCH = 2_000_000_000;
const AMOUNT = '1000000000000000000';

const BRADBURY_CHAIN = Object.freeze({
  id: BRADBURY_CHAIN_ID,
  name: 'GenLayer Testnet Bradbury',
  testnet: true,
  isStudio: false,
  rpcUrls: { default: { http: ['https://rpc-bradbury.genlayer.com'] } },
  nativeCurrency: { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
  blockExplorers: {
    default: { name: 'GenLayer Explorer', url: 'https://explorer-bradbury.genlayer.com' },
  },
});

const FINAL_RECEIPT = Object.freeze({
  statusName: 'FINALIZED',
  txExecutionResultName: 'FINISHED_WITH_RETURN',
});

function quote(overrides = {}) {
  return {
    epoch_end_timestamp: EPOCH,
    objective: 'HIGH',
    account: ACCOUNT,
    choice_asset_id: 'BTC',
    stake_atto: AMOUNT,
    settlement_mode: 'WINNER',
    eligible: true,
    claimed: false,
    claimed_atto: '0',
    escrow_funded_atto: '0',
    amount_atto: AMOUNT,
    includes_rounding_remainder: false,
    payout_id: '',
    payout_state: '',
    ...overrides,
  };
}

function payout(state, overrides = {}) {
  return {
    payout_id: PAYOUT_ID,
    kind: 'PLAYER',
    recipient: ACCOUNT,
    amount_atto: AMOUNT,
    epoch_end_timestamp: EPOCH,
    objective: 'HIGH',
    wallet_key: ACCOUNT,
    stake_atto: AMOUNT,
    settlement_mode: 'WINNER',
    includes_rounding_remainder: false,
    state,
    prepare_attempt_count: 1,
    attempt_count: 1,
    reserve_remaining_atto: '0',
    vault: VAULT,
    created_at_timestamp: EPOCH,
    last_prepare_timestamp: EPOCH,
    last_dispatch_timestamp: EPOCH,
    funded_at_timestamp: EPOCH,
    withdrawn_at_timestamp: state === 'EOA_WITHDRAWN' ? EPOCH + 1 : 0,
    escrow_withdrawn: state === 'EOA_WITHDRAWN',
    ...overrides,
  };
}

function providerFor(account = ACCOUNT, overrides = {}) {
  const calls = [];
  const provider = {
    calls,
    async request(request) {
      calls.push(request);
      if (request.method === 'eth_chainId') return BRADBURY_CHAIN_ID_HEX;
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [account];
      if (request.method === 'eth_getBalance') return '0x1bc16d674ec80000';
      if (request.method === 'wallet_addEthereumChain') return null;
      throw new Error(`Unexpected provider request ${request.method}`);
    },
    on() {},
    ...overrides,
  };
  return provider;
}

function connectedGateway({ account = ACCOUNT, provider = providerFor(account), reads = [], read } = {}) {
  const calls = [];
  const writes = [];
  const client = {
    async readContract(call) {
      calls.push(call);
      if (read) return read(call, calls.length - 1);
      if (!reads.length) throw new Error(`Unexpected ${call.functionName}`);
      return reads.shift();
    },
    async writeContract(call) {
      writes.push(call);
      return HASH;
    },
    async waitForTransactionReceipt() { return FINAL_RECEIPT; },
    async getTransaction() { return FINAL_RECEIPT; },
  };
  const gateway = new GenLayerGateway({
    contractAddress: CONTRACT,
    network: 'testnet-bradbury',
    deploymentAlias: 'v8',
    protocolVersion: 'LIQUIDITY_ARENA_V8',
    provider,
  });
  gateway.account = account;
  gateway.client = client;
  gateway.walletVerified = true;
  return { gateway, client, calls, writes, provider };
}

test('only a non-zero 20-byte address configures V8', () => {
  assert.equal(isConfiguredAddress(''), false);
  assert.equal(isConfiguredAddress('0x0000000000000000000000000000000000000000'), false);
  assert.equal(isConfiguredAddress('0x1234'), false);
  assert.equal(isConfiguredAddress(CONTRACT), true);
});

test('wallet discovery prefers MetaMask and otherwise uses the injected provider', async () => {
  const fallback = { request: async () => null };
  const metaMask = { request: async () => null, isMetaMask: true };
  const listeners = new Map();
  const fakeWindow = {
    ethereum: fallback,
    Event: class { constructor(type) { this.type = type; } },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent({ type }) {
      if (type === 'eip6963:requestProvider') {
        listeners.get('eip6963:announceProvider')?.({
          detail: { info: { name: 'MetaMask', rdns: 'io.metamask' }, provider: metaMask },
        });
      }
    },
  };
  assert.equal((await selectInjectedWalletProvider(fakeWindow, 0)).provider, metaMask);
  assert.equal((await selectInjectedWalletProvider({ ethereum: fallback }, 0)).provider, fallback);
});

test('browser reads always use the same-origin hardened proxy', () => {
  assert.equal(
    resolveGenLayerWalletRpcUrl('https://ignored.example/rpc', new URL('https://arena.example/market.html')),
    'https://arena.example/genlayer-rpc',
  );
  assert.equal(
    resolveGenLayerWalletRpcUrl('', new URL('http://localhost:4400/market.html')),
    'http://localhost:4400/genlayer-rpc',
  );
  assert.throws(() => resolveGenLayerWalletRpcUrl('http://remote.example/rpc'), /HTTPS/);
});

test('Bradbury 4221 is added, selected, and verified before use', async () => {
  let activeChain = '0x1';
  const calls = [];
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === 'wallet_addEthereumChain') return null;
      if (request.method === 'wallet_switchEthereumChain') {
        activeChain = request.params[0].chainId;
        return null;
      }
      if (request.method === 'eth_chainId') return activeChain;
      throw new Error(`Unexpected ${request.method}`);
    },
  };
  await ensureGenLayerWalletChain(provider, BRADBURY_CHAIN, 'testnet-bradbury', 'https://arena.example/genlayer-rpc');
  const addition = calls.find(({ method }) => method === 'wallet_addEthereumChain');
  assert.deepEqual(addition.params[0], {
    chainId: '0x107d',
    chainName: BRADBURY_CHAIN.name,
    nativeCurrency: BRADBURY_CHAIN.nativeCurrency,
    rpcUrls: ['https://arena.example/genlayer-rpc'],
    blockExplorerUrls: [BRADBURY_CHAIN.blockExplorers.default.url],
  });
  assert.equal(calls.some(({ method }) => method === 'wallet_switchEthereumChain'), true);
  await assert.rejects(
    ensureGenLayerWalletChain(provider, { ...BRADBURY_CHAIN, id: 61999 }, 'testnet-bradbury'),
    /invalid Bradbury chain descriptor/,
  );
});

test('gateway is V8-only, Bradbury-only, and fails closed without an address', async () => {
  assert.throws(
    () => new GenLayerGateway({ contractAddress: CONTRACT, deploymentAlias: 'v7' }),
    /Only the V8 deployment identity/,
  );
  const wrongNetwork = new GenLayerGateway({ contractAddress: CONTRACT, network: 'studionet' });
  assert.equal(wrongNetwork.configured, false);
  await assert.rejects(wrongNetwork.connect(), /Unsupported GenLayer network/);
  const absent = new GenLayerGateway({ contractAddress: '', network: 'testnet-bradbury' });
  assert.equal(absent.wagerConfigured, false);
  await assert.rejects(absent.readConfig(), /V8 contract address is not configured/);
  assert.equal(normalizeGenLayerNetwork('testnet-bradbury'), 'testnet-bradbury');
  assert.equal(normalizeGenLayerNetwork('bradbury'), 'testnet-bradbury');
  assert.equal(new GenLayerGateway({ contractAddress: CONTRACT, network: 'bradbury' }).network, 'testnet-bradbury');
});

test('read surface uses only the final nine V8 view methods', async () => {
  const results = [
    { protocol_version: 'LIQUIDITY_ARENA_V8' },
    { available_reserve_atto: '1' },
    { epoch_id: String(EPOCH) },
    { asset_id: 'BTC' },
    { objective: 'HIGH' },
    quote(),
    { offset: 0, next_offset: 1, total: 1, epoch_ids: [String(EPOCH)] },
    payout('PREPARING'),
    { offset: 0, next_offset: 1, total: 1, payouts: [payout('PREPARING')] },
  ];
  const { gateway, calls } = connectedGateway({ reads: results });
  await gateway.readConfig();
  await gateway.readReserveState();
  await gateway.readEpoch(EPOCH);
  await gateway.readEpochAsset(EPOCH, 'BTC');
  await gateway.readObjective(EPOCH, 'HIGH');
  await gateway.readEpochClaimQuote(EPOCH, 'HIGH', ACCOUNT);
  await gateway.readEpochPage(0, 1);
  await gateway.readPayout(PAYOUT_ID);
  await gateway.readPayoutPage(0, 1);
  assert.deepEqual(calls.map(({ functionName }) => functionName), [
    'get_config',
    'get_delivery_reserve_state',
    'get_epoch',
    'get_epoch_asset',
    'get_objective',
    'get_claim_quote',
    'get_epoch_page',
    'get_payout',
    'get_payout_page',
  ]);
});

test('recent epochs page backward from get_epoch_page.total', async () => {
  const { gateway, calls } = connectedGateway({
    reads: [
      { offset: 0, next_offset: 1, total: 4, epoch_ids: ['100'] },
      { offset: 2, next_offset: 4, total: 4, epoch_ids: ['300', '400'] },
    ],
  });
  assert.deepEqual(await gateway.readRecentEpochIds(2), {
    total: 4,
    epochEndTimestamps: [300, 400],
  });
  assert.deepEqual(calls.map(({ functionName, args }) => [functionName, ...args]), [
    ['get_epoch_page', 0, 1],
    ['get_epoch_page', 2, 2],
  ]);
});

test('wager finality is verified by the V8 quote stake delta', async () => {
  const { gateway, writes } = connectedGateway({
    reads: [quote({ stake_atto: '5' }), quote({ stake_atto: '15' })],
  });
  const result = await gateway.placeEpochWager(EPOCH, 'HIGH', 'BTC', 10n);
  assert.equal(result.hash, HASH);
  assert.equal(result.entry.stake_atto, '15');
  assert.equal(writes[0].functionName, 'enter');
  assert.equal(writes[0].value, 10n);
});

test('claim creates a PREPARING payout instead of claiming direct delivery', async () => {
  const after = quote({
    eligible: false,
    payout_id: PAYOUT_ID,
    payout_state: 'PREPARING',
  });
  const { gateway, writes } = connectedGateway({
    reads: [quote(), after, payout('PREPARING')],
  });
  const result = await gateway.claimEpoch(EPOCH, 'HIGH');
  assert.equal(result.payoutId, PAYOUT_ID);
  assert.equal(result.payout.state, 'PREPARING');
  assert.equal(writes[0].functionName, 'claim');
});

test('all four V8 payout progress writes verify their stage transitions', async () => {
  const cases = [
    ['retryPreparePayout', 'PREPARING', 'PREPARING', 'retry_prepare_payout'],
    ['dispatchPayout', 'PREPARING', 'DISPATCHED', 'dispatch_payout'],
    ['retryPayout', 'DISPATCHED', 'DISPATCHED', 'retry_payout'],
    ['confirmPayout', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'confirm_payout'],
  ];
  for (const [method, before, after, functionName] of cases) {
    const { gateway, writes } = connectedGateway({ reads: [payout(before), payout(after)] });
    assert.equal((await gateway[method](PAYOUT_ID)).payout.state, after);
    assert.equal(writes[0].functionName, functionName);
  }
});

test('withdrawal refresh requires EOA_WITHDRAWN plus exact claimed quote accounting', async () => {
  const { gateway, writes } = connectedGateway({
    reads: [
      payout('FUNDED_IN_ESCROW'),
      payout('EOA_WITHDRAWN'),
      quote({
        eligible: false,
        claimed: true,
        claimed_atto: AMOUNT,
        payout_id: PAYOUT_ID,
        payout_state: 'EOA_WITHDRAWN',
      }),
    ],
  });
  const result = await gateway.refreshPayoutWithdrawal(PAYOUT_ID);
  assert.equal(result.quote.claimed, true);
  assert.equal(writes[0].functionName, 'refresh_payout_withdrawal');
});

test('a non-recipient cannot initiate or resume the recipient vault withdrawal', async () => {
  const provider = providerFor(OTHER);
  let sends = 0;
  const original = provider.request;
  provider.request = async (request) => {
    if (request.method === 'eth_sendTransaction') sends += 1;
    return original.call(provider, request);
  };
  const { gateway } = connectedGateway({ account: OTHER, provider });
  await assert.rejects(gateway.withdrawPayoutVault(payout('FUNDED_IN_ESCROW')), /account changed/i);
  assert.equal(sends, 0);
});

test('withdrawal inspection makes failed and dropped hashes retryable without duplicating a pending tx', async () => {
  const transaction = {
    hash: HASH,
    from: ACCOUNT,
    to: VAULT,
    input: '0x3ccfd60b',
    value: '0x0',
    blockHash: `0x${'ef'.repeat(32)}`,
  };
  for (const [receipt, expected] of [
    [{
      status: '0x0', from: ACCOUNT, to: VAULT, transactionHash: HASH,
      blockHash: transaction.blockHash, blockNumber: '0x10',
    }, 'FAILED'],
    [null, 'PENDING'],
  ]) {
    const provider = providerFor(ACCOUNT, {
      async request(request) {
        if (request.method === 'eth_chainId') return BRADBURY_CHAIN_ID_HEX;
        if (request.method === 'eth_accounts') return [ACCOUNT];
        if (request.method === 'eth_getTransactionByHash') return transaction;
        if (request.method === 'eth_getTransactionReceipt') return receipt;
        throw new Error(`Unexpected ${request.method}`);
      },
    });
    const { gateway } = connectedGateway({ provider });
    gateway.readPayoutVault = async () => Object.freeze({ vault: VAULT.toLowerCase(), withdrawn: false });
    assert.equal(
      (await gateway.inspectPayoutVaultWithdrawal(HASH, payout('FUNDED_IN_ESCROW'))).status,
      expected,
    );
  }

  const droppedProvider = providerFor(ACCOUNT, {
    async request(request) {
      if (request.method === 'eth_chainId') return BRADBURY_CHAIN_ID_HEX;
      if (request.method === 'eth_accounts') return [ACCOUNT];
      if (request.method === 'eth_getTransactionByHash'
        || request.method === 'eth_getTransactionReceipt') return null;
      throw new Error(`Unexpected ${request.method}`);
    },
  });
  const { gateway: droppedGateway } = connectedGateway({ provider: droppedProvider });
  droppedGateway.readPayoutVault = async () => Object.freeze({ vault: VAULT.toLowerCase(), withdrawn: false });
  assert.equal(
    (await droppedGateway.inspectPayoutVaultWithdrawal(HASH, payout('FUNDED_IN_ESCROW'))).status,
    'DROPPED',
  );

  const prunedFailureProvider = providerFor(ACCOUNT, {
    async request(request) {
      if (request.method === 'eth_chainId') return BRADBURY_CHAIN_ID_HEX;
      if (request.method === 'eth_accounts') return [ACCOUNT];
      if (request.method === 'eth_getTransactionByHash') return null;
      if (request.method === 'eth_getTransactionReceipt') {
        return { transactionHash: HASH, status: '0x0' };
      }
      throw new Error(`Unexpected ${request.method}`);
    },
  });
  const { gateway: prunedFailureGateway } = connectedGateway({ provider: prunedFailureProvider });
  prunedFailureGateway.readPayoutVault = async () => Object.freeze({ vault: VAULT.toLowerCase(), withdrawn: false });
  assert.equal(
    (await prunedFailureGateway.inspectPayoutVaultWithdrawal(HASH, payout('FUNDED_IN_ESCROW'))).status,
    'FAILED',
  );
});

test('verified vault state permits refresh when the recipient withdrew outside this journal', async () => {
  let hashReads = 0;
  const provider = providerFor(ACCOUNT, {
    async request(request) {
      if (request.method === 'eth_chainId') return BRADBURY_CHAIN_ID_HEX;
      if (request.method === 'eth_accounts') return [ACCOUNT];
      if (request.method === 'eth_getTransactionByHash'
        || request.method === 'eth_getTransactionReceipt') hashReads += 1;
      throw new Error(`Unexpected ${request.method}`);
    },
  });
  const { gateway } = connectedGateway({ provider });
  gateway.readPayoutVault = async () => Object.freeze({ vault: VAULT.toLowerCase(), credited: true, withdrawn: true });
  const inspected = await gateway.inspectPayoutVaultWithdrawal(HASH, payout('FUNDED_IN_ESCROW'));
  assert.equal(inspected.status, 'VAULT_WITHDRAWN');
  assert.equal(hashReads, 0);
  const recovered = await gateway.withdrawPayoutVault(payout('FUNDED_IN_ESCROW'));
  assert.equal(recovered.alreadyWithdrawn, true);
  assert.equal(recovered.hash, null);
});

test('recipient withdrawal signs only withdraw() on the fully verified audited vault', async () => {
  const factoryInterface = new Interface([
    'function protocol_version() view returns (string)',
    'function is_bound(address) view returns (bool)',
    'function is_prepared(string,address,uint256) view returns (bool)',
    'function vault_of(string) view returns (address)',
    'function reserveSink() view returns (address)',
  ]);
  const vaultInterface = new Interface([
    'function record() view returns (bytes32,address,address,address,uint256,bool,bool,uint256,uint256,uint256,uint256,uint256)',
  ]);
  let recordReads = 0;
  let sentRequest = null;
  const blockHash = `0x${'ef'.repeat(32)}`;
  const provider = providerFor(ACCOUNT);
  const baseRequest = provider.request;
  provider.request = async (request) => {
    provider.calls.push(request);
    if (request.method === 'eth_chainId') return BRADBURY_CHAIN_ID_HEX;
    if (request.method === 'eth_accounts') return [ACCOUNT];
    if (request.method === 'eth_getCode') return '0x60006000';
    if (request.method === 'eth_call') {
      const [{ to, data }] = request.params;
      if (to.toLowerCase() === VAULT.toLowerCase()) {
        recordReads += 1;
        const withdrawn = recordReads > 1;
        return vaultInterface.encodeFunctionResult('record', [
          keccak256(toUtf8Bytes(PAYOUT_ID)), CONTRACT, ACCOUNT, RESERVE, BigInt(AMOUNT),
          true, withdrawn, 10n, withdrawn ? 16n : 0n, withdrawn ? 0n : BigInt(AMOUNT),
          withdrawn ? 0n : BigInt(AMOUNT), 0n,
        ]);
      }
      const parsed = factoryInterface.parseTransaction({ data });
      const values = {
        protocol_version: ['IDEMPOTENT_EVM_VAULT_V1'],
        is_bound: [true],
        is_prepared: [true],
        vault_of: [VAULT],
        reserveSink: [RESERVE],
      };
      return factoryInterface.encodeFunctionResult(parsed.name, values[parsed.name]);
    }
    if (request.method === 'eth_sendTransaction') {
      sentRequest = request.params[0];
      return HASH;
    }
    if (request.method === 'eth_getTransactionReceipt') {
      return {
        status: '0x1',
        from: ACCOUNT,
        to: VAULT,
        transactionHash: HASH,
        blockHash,
        blockNumber: '0x10',
      };
    }
    if (request.method === 'eth_getTransactionByHash') {
      return {
        hash: HASH,
        from: ACCOUNT,
        to: VAULT,
        input: '0x3ccfd60b',
        value: '0x0',
        blockHash,
      };
    }
    if (request.method === 'eth_getBlockByNumber') {
      if (request.params[0] === 'finalized') return { number: '0x11', hash: `0x${'11'.repeat(32)}` };
      return { number: '0x10', hash: blockHash };
    }
    return baseRequest.call(provider, request);
  };
  const { gateway } = connectedGateway({
    provider,
    read({ functionName }) {
      if (functionName === 'get_config') return {
        protocol_version: 'LIQUIDITY_ARENA_V8',
        payout_protocol_version: 'IDEMPOTENT_EVM_VAULT_V1',
        payouts_enabled: true,
        payout_vault_factory: FACTORY,
      };
      if (functionName === 'get_payout') return payout('FUNDED_IN_ESCROW');
      throw new Error(`Unexpected ${functionName}`);
    },
  });

  const result = await gateway.withdrawPayoutVault(payout('FUNDED_IN_ESCROW'));
  assert.equal(result.hash, HASH);
  assert.equal(result.record.withdrawn, true);
  assert.deepEqual(sentRequest, {
    from: ACCOUNT,
    to: VAULT.toLowerCase(),
    data: '0x3ccfd60b',
    value: '0x0',
  });
});

test('finalized GenLayer writes require FINISHED_WITH_RETURN', () => {
  assert.equal(assertFinalizedExecution(FINAL_RECEIPT), FINAL_RECEIPT);
  assert.throws(
    () => assertFinalizedExecution({ statusName: 'FINALIZED', txExecutionResultName: 'CONTRACT_ERROR' }),
    /contract execution was CONTRACT_ERROR/,
  );
  assert.throws(
    () => assertFinalizedExecution({ statusName: 'PENDING', txExecutionResultName: 'FINISHED_WITH_RETURN' }),
    /not FINALIZED/,
  );
});
