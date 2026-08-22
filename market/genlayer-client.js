import { Interface, keccak256, toUtf8Bytes } from 'ethers';

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PAYOUT_ID_PATTERN = /^[0-9a-f]{64}$/;

export const BRADBURY_CHAIN_ID = 4221;
export const BRADBURY_CHAIN_ID_HEX = '0x107d';

const FINALIZED_STATUS = 'FINALIZED';
const SUCCESSFUL_EXECUTION = 'FINISHED_WITH_RETURN';
const FINALITY_POLL_INTERVAL_MS = 5_000;
const FINALITY_POLL_RETRIES = 900;
const EVM_RECEIPT_POLL_INTERVAL_MS = 2_000;
const EVM_RECEIPT_POLL_RETRIES = 180;
const OBJECTIVES = new Set(['HIGH', 'LOW']);
const ASSETS = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
const PAYOUT_STATES = new Set(['PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN']);
const EIP6963_REQUEST_EVENT = 'eip6963:requestProvider';
const EIP6963_ANNOUNCE_EVENT = 'eip6963:announceProvider';
const LOCAL_WALLET_RPC_PATH = '/genlayer-rpc';
const WITHDRAW_SELECTOR = '0x3ccfd60b';
const AUDITED_PAYOUT_FACTORY = '0x944fdadd826c2a159c63cb100db174716ccd1317';
const FACTORY_INTERFACE = new Interface([
  'function protocol_version() view returns (string)',
  'function is_bound(address) view returns (bool)',
  'function is_prepared(string,address,uint256) view returns (bool)',
  'function vault_of(string) view returns (address)',
  'function reserveSink() view returns (address)',
]);
const VAULT_INTERFACE = new Interface([
  'function record() view returns (bytes32,address,address,address,uint256,bool,bool,uint256,uint256,uint256,uint256,uint256)',
]);

const BRADBURY_NETWORK = 'testnet-bradbury';
const NETWORKS = Object.freeze({
  [BRADBURY_NETWORK]: Object.freeze({
    exportName: 'testnetBradbury',
    connectName: 'testnetBradbury',
    label: 'BRADBURY',
    displayName: 'GenLayer Bradbury Testnet',
    chainId: BRADBURY_CHAIN_ID,
    chainIdHex: BRADBURY_CHAIN_ID_HEX,
    walletWagers: true,
    gasless: false,
  }),
});

export function normalizeGenLayerNetwork(network) {
  const normalized = String(network || '').trim().toLowerCase();
  if (['testnet-bradbury', 'bradbury', 'testnetbradbury'].includes(normalized)) {
    return BRADBURY_NETWORK;
  }
  return null;
}

export function isConfiguredAddress(address) {
  return ADDRESS_PATTERN.test(String(address || '')) && !ZERO_ADDRESS_PATTERN.test(String(address));
}

function isWalletProvider(value) {
  return Boolean(value && typeof value.request === 'function');
}

function isMetaMaskAnnouncement({ info } = {}) {
  return String(info?.rdns || '').toLowerCase() === 'io.metamask'
    || String(info?.name || '').toLowerCase() === 'metamask';
}

export async function selectInjectedWalletProvider(windowRef = globalThis.window, waitMs = 25) {
  if (!windowRef) return null;
  const announcements = [];
  const seen = new Set();
  const onAnnouncement = (event) => {
    const provider = event?.detail?.provider;
    if (!isWalletProvider(provider) || seen.has(provider)) return;
    seen.add(provider);
    announcements.push({ provider, info: event.detail.info || null });
  };
  if (typeof windowRef.addEventListener === 'function' && typeof windowRef.dispatchEvent === 'function') {
    windowRef.addEventListener(EIP6963_ANNOUNCE_EVENT, onAnnouncement);
    try {
      const RequestEvent = windowRef.Event || globalThis.Event;
      if (typeof RequestEvent === 'function') {
        windowRef.dispatchEvent(new RequestEvent(EIP6963_REQUEST_EVENT));
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } finally {
      windowRef.removeEventListener?.(EIP6963_ANNOUNCE_EVENT, onAnnouncement);
    }
  }
  const metaMask = announcements.find(isMetaMaskAnnouncement);
  if (metaMask) return { ...metaMask, source: 'eip6963' };
  const legacy = windowRef.ethereum;
  if (isWalletProvider(legacy)) {
    const announced = announcements.find(({ provider }) => provider === legacy);
    return { provider: legacy, info: announced?.info || null, source: announced ? 'eip6963-legacy' : 'legacy' };
  }
  return announcements[0] ? { ...announcements[0], source: 'eip6963' } : null;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || normalized === '::1'
    || normalized === '[::1]';
}

export function resolveGenLayerWalletRpcUrl(configuredUrl = '', locationRef = globalThis.window?.location) {
  const baseUrl = String(locationRef?.origin || '').trim();
  const candidate = baseUrl ? LOCAL_WALLET_RPC_PATH : String(configuredUrl || '').trim();
  if (!candidate) return null;
  let resolved;
  try { resolved = new URL(candidate, baseUrl || undefined); } catch {
    throw new TypeError('VITE_GENLAYER_WALLET_RPC must resolve to an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(resolved.protocol)) {
    throw new TypeError('VITE_GENLAYER_WALLET_RPC must resolve to an absolute HTTP(S) URL.');
  }
  if (resolved.protocol !== 'https:' && !isLoopbackHostname(resolved.hostname)) {
    throw new TypeError('VITE_GENLAYER_WALLET_RPC must use HTTPS outside localhost development.');
  }
  return resolved.href;
}

function chainIdNumber(value) {
  try { return Number(BigInt(value)); } catch { return Number.NaN; }
}

function walletNetworkDescriptor(network) {
  const descriptor = typeof network === 'string'
    ? NETWORKS[normalizeGenLayerNetwork(network)]
    : network;
  if (!descriptor?.walletWagers
    || descriptor.chainId !== BRADBURY_CHAIN_ID
    || String(descriptor.chainIdHex || '').toLowerCase() !== BRADBURY_CHAIN_ID_HEX
    || descriptor.connectName !== 'testnetBradbury'
    || descriptor.gasless !== false) {
    throw new Error('Only GenLayer Bradbury testnet is enabled for wallet transactions.');
  }
  return descriptor;
}

function genLayerChainParameters(chain, descriptor, walletRpcUrl = '') {
  const rpcUrls = chain?.rpcUrls?.default?.http;
  const nativeCurrency = chain?.nativeCurrency;
  if (Number(chain?.id) !== descriptor.chainId
    || chain?.testnet !== true
    || chain?.isStudio !== false
    || !Array.isArray(rpcUrls)
    || rpcUrls.length === 0
    || !nativeCurrency?.name
    || !nativeCurrency?.symbol
    || Number(nativeCurrency?.decimals) !== 18) {
    throw new Error('The GenLayer SDK returned an invalid Bradbury chain descriptor.');
  }
  const parameters = {
    chainId: descriptor.chainIdHex,
    chainName: chain.name,
    nativeCurrency,
    rpcUrls: walletRpcUrl ? [walletRpcUrl] : [...rpcUrls],
  };
  const explorerUrl = chain?.blockExplorers?.default?.url;
  if (explorerUrl) parameters.blockExplorerUrls = [explorerUrl];
  return parameters;
}

export async function ensureGenLayerWalletChain(provider, chain, network = BRADBURY_NETWORK, walletRpcUrl = '') {
  if (!isWalletProvider(provider)) throw new TypeError('A wallet provider is required.');
  const descriptor = walletNetworkDescriptor(network);
  const parameters = genLayerChainParameters(chain, descriptor, walletRpcUrl);
  try {
    await provider.request({ method: 'wallet_addEthereumChain', params: [parameters] });
  } catch (error) {
    if (Number(error?.code) === 4001) throw new Error('Bradbury network configuration was cancelled in the wallet.');
    // Some wallets reject re-adding an existing chain. A verified switch below
    // is authoritative, so this rejection is not itself a success or failure.
  }
  const current = await provider.request({ method: 'eth_chainId' });
  if (chainIdNumber(current) !== descriptor.chainId) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: descriptor.chainIdHex }],
      });
    } catch (error) {
      throw new Error(`Wallet could not switch to Bradbury chain ${descriptor.chainId}. ${error?.message || ''}`.trim());
    }
  }
  const verified = await provider.request({ method: 'eth_chainId' });
  if (chainIdNumber(verified) !== descriptor.chainId) {
    throw new Error(`Wallet network mismatch. Switch to Bradbury chain ${descriptor.chainId}.`);
  }
}

function atto(value, label, { positive = false } = {}) {
  let normalized;
  try { normalized = BigInt(value); } catch { throw new TypeError(`${label} must be an integer.`); }
  if (normalized < 0n || (positive && normalized === 0n)) {
    throw new RangeError(`${label} must be ${positive ? 'positive' : 'non-negative'}.`);
  }
  return normalized;
}

function epochEnd(value) {
  const normalized = atto(value, 'Epoch end timestamp', { positive: true });
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Epoch end timestamp is too large.');
  return normalized;
}

function objective(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!OBJECTIVES.has(normalized)) throw new RangeError('Objective must be HIGH or LOW.');
  return normalized;
}

function asset(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!ASSETS.has(normalized)) throw new RangeError('Asset is unsupported.');
  return normalized;
}

function pageValue(value, label, { minimum = 0, maximum = 50 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return normalized;
}

function transactionHash(value, label = 'Transaction hash') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(normalized)) throw new TypeError(`${label} must be a 32-byte hash.`);
  return normalized;
}

function payoutId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!PAYOUT_ID_PATTERN.test(normalized)) throw new TypeError('Payout ID must be 64 lowercase hex characters.');
  return normalized;
}

function payoutIdentity(raw, expectedId = '', expectedRecipient = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Payout readback is malformed.');
  const id = payoutId(raw.payout_id ?? raw.payoutId);
  if (expectedId && id !== payoutId(expectedId)) throw new Error('Payout readback returned a different ID.');
  const recipient = String(raw.recipient || '').trim().toLowerCase();
  if (!isConfiguredAddress(recipient)) throw new TypeError('Payout recipient is malformed.');
  if (expectedRecipient && recipient !== String(expectedRecipient).trim().toLowerCase()) {
    throw new Error('Payout recipient does not match the connected wallet.');
  }
  const state = String(raw.state || '').trim().toUpperCase();
  if (!PAYOUT_STATES.has(state)) throw new RangeError('Payout state is unsupported.');
  const amount = atto(raw.amount_atto ?? raw.amountAtto, 'Payout amount', { positive: true });
  return Object.freeze({ id, recipient, state, amount, raw });
}

function claimQuoteIdentity(raw, expectedEpoch, expectedObjective, expectedAccount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('V8 claim quote is malformed.');
  }
  const normalizedEpoch = epochEnd(raw.epoch_end_timestamp);
  const normalizedObjective = objective(raw.objective);
  const normalizedAccount = String(raw.account || '').trim().toLowerCase();
  if (normalizedEpoch !== epochEnd(expectedEpoch)
    || normalizedObjective !== objective(expectedObjective)
    || !isConfiguredAddress(normalizedAccount)
    || normalizedAccount !== String(expectedAccount || '').trim().toLowerCase()) {
    throw new Error('V8 claim quote does not match the requested wallet position.');
  }
  const idText = String(raw.payout_id || '').trim().toLowerCase();
  const state = String(raw.payout_state || '').trim().toUpperCase();
  if (Boolean(idText) !== Boolean(state)
    || (idText && (!PAYOUT_ID_PATTERN.test(idText) || !PAYOUT_STATES.has(state)))) {
    throw new Error('V8 claim quote payout identity is malformed.');
  }
  return Object.freeze({
    epoch: normalizedEpoch,
    objective: normalizedObjective,
    account: normalizedAccount,
    stake: atto(raw.stake_atto, 'Claim quote stake'),
    amount: atto(raw.amount_atto, 'Claim quote amount'),
    payoutId: idText,
    payoutState: state,
    raw,
  });
}

function addressBytes(value) {
  const address = String(value || '').trim();
  if (!isConfiguredAddress(address)) throw new TypeError('Account must be a non-zero address.');
  const bytes = new Uint8Array(20);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(address.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function shortenAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
}

function uniqueReceiptValue(values, label) {
  const unique = [...new Set(values
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim().toUpperCase()))];
  if (unique.length > 1) throw new Error(`GenLayer receipt reported conflicting ${label} values.`);
  return unique[0] || '';
}

export function assertFinalizedExecution(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('GenLayer did not return a finalized transaction receipt.');
  }
  const status = uniqueReceiptValue([receipt.status_name, receipt.statusName], 'status');
  if (status !== FINALIZED_STATUS) throw new Error(`GenLayer transaction is ${status || 'UNKNOWN'}, not FINALIZED.`);
  const execution = uniqueReceiptValue(
    [receipt.tx_execution_result_name, receipt.txExecutionResultName],
    'execution result',
  );
  if (execution !== SUCCESSFUL_EXECUTION) {
    throw new Error(`GenLayer finalized the transaction, but contract execution was ${execution || 'UNKNOWN'}.`);
  }
  return receipt;
}

export class GenLayerGateway {
  constructor({
    contractAddress = import.meta.env?.VITE_GENLAYER_V8_CONTRACT || '',
    network = import.meta.env?.VITE_GENLAYER_NETWORK || BRADBURY_NETWORK,
    walletRpcUrl = import.meta.env?.VITE_GENLAYER_WALLET_RPC || '',
    deploymentAlias = 'v8',
    protocolVersion = 'LIQUIDITY_ARENA_V8',
    newWagersEnabled = true,
    locationRef = globalThis.window?.location,
    provider = null,
    sdkLoader = null,
  } = {}) {
    this.contractAddress = String(contractAddress || '').trim();
    this.deploymentAlias = String(deploymentAlias || '').trim().toLowerCase();
    this.protocolVersion = String(protocolVersion || '').trim().toUpperCase();
    if (this.deploymentAlias !== 'v8' || this.protocolVersion !== 'LIQUIDITY_ARENA_V8') {
      throw new Error('Only the V8 deployment identity is allowlisted.');
    }
    this.newWagersEnabled = newWagersEnabled === true;
    this.requestedNetwork = network;
    this.network = normalizeGenLayerNetwork(network);
    this.configurationError = this.network ? null : `Unsupported GenLayer network "${network}".`;
    this.walletRpcUrl = walletRpcUrl;
    this.locationRef = locationRef;
    this.provider = provider;
    this.providerInfo = null;
    this.sdkLoader = sdkLoader;
    this.account = null;
    this.client = null;
    this.walletVerified = false;
    this.walletListeners = new Set();
    this.providerListenersInstalled = false;
    this._accountsChanged = () => this._invalidateWallet('ACCOUNT_CHANGED');
    this._chainChanged = () => this._invalidateWallet('CHAIN_CHANGED');
  }

  get networkLabel() { return this.network ? NETWORKS[this.network].label : 'UNSUPPORTED'; }
  get networkDescriptor() { return this.network ? NETWORKS[this.network] : null; }
  get configured() { return !this.configurationError && isConfiguredAddress(this.contractAddress); }
  get walletConfigured() { return this.configured && this.network === BRADBURY_NETWORK; }
  get wagerConfigured() { return this.walletConfigured && this.newWagersEnabled; }
  get connected() { return Boolean(this.account && this.client && this.walletVerified); }
  get accountLabel() { return shortenAddress(this.account); }

  _walletProvider() { return this.provider || globalThis.window?.ethereum || null; }

  async _loadSdk() {
    if (this.configurationError) throw new Error(this.configurationError);
    if (this.sdkLoader) return this.sdkLoader(this.network);
    const [{ createClient }, chains] = await Promise.all([import('genlayer-js'), import('genlayer-js/chains')]);
    const descriptor = NETWORKS[this.network];
    const chain = chains[descriptor.exportName];
    if (!chain) throw new Error(`The GenLayer SDK does not expose ${descriptor.exportName}.`);
    return { createClient, chain, descriptor };
  }

  onWalletChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Wallet listener must be a function.');
    this.walletListeners.add(listener);
    return () => this.walletListeners.delete(listener);
  }

  _installProviderListeners(provider) {
    if (this.providerListenersInstalled || typeof provider?.on !== 'function') return;
    provider.on('accountsChanged', this._accountsChanged);
    provider.on('chainChanged', this._chainChanged);
    this.providerListenersInstalled = true;
  }

  _invalidateWallet(reason) {
    const previousAccount = this.account;
    this.account = null;
    this.client = null;
    this.walletVerified = false;
    for (const listener of this.walletListeners) listener({ reason, previousAccount });
  }

  disconnect() { this._invalidateWallet('DISCONNECTED'); }

  destroy() {
    const provider = this._walletProvider();
    if (this.providerListenersInstalled && typeof provider?.removeListener === 'function') {
      provider.removeListener('accountsChanged', this._accountsChanged);
      provider.removeListener('chainChanged', this._chainChanged);
    }
    this.providerListenersInstalled = false;
    this.walletListeners.clear();
    this.account = null;
    this.client = null;
    this.walletVerified = false;
  }

  async connect() {
    if (!this.walletConfigured) {
      if (this.configurationError) throw new Error(this.configurationError);
      if (!this.configured) throw new Error('The Bradbury V8 contract address is not configured.');
      throw new Error('Bradbury wallet transactions are disabled.');
    }
    const selected = this.provider
      ? { provider: this.provider, info: this.providerInfo }
      : await selectInjectedWalletProvider();
    const provider = selected?.provider;
    if (!provider) throw new Error('A browser wallet such as MetaMask is required.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!isConfiguredAddress(accounts?.[0])) throw new Error('No valid wallet account was returned.');
    const { createClient, chain } = await this._loadSdk();
    const descriptor = walletNetworkDescriptor(this.networkDescriptor);
    const rpc = resolveGenLayerWalletRpcUrl(this.walletRpcUrl, this.locationRef);
    await ensureGenLayerWalletChain(provider, chain, descriptor, rpc);
    const client = createClient({ chain, account: accounts[0], provider });
    const [chainId, activeAccounts] = await Promise.all([
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_accounts' }),
    ]);
    if (chainIdNumber(chainId) !== BRADBURY_CHAIN_ID
      || String(activeAccounts?.[0] || '').toLowerCase() !== accounts[0].toLowerCase()) {
      throw new Error('Wallet account or Bradbury chain changed during connection.');
    }
    this.provider = provider;
    this.providerInfo = selected?.info || null;
    this.account = activeAccounts[0];
    this.client = client;
    this.walletVerified = true;
    this._installProviderListeners(provider);
    return {
      address: this.account,
      label: this.accountLabel,
      network: this.networkLabel,
      chainId: BRADBURY_CHAIN_ID,
      walletName: String(this.providerInfo?.name || '').trim() || null,
    };
  }

  async _assertConfiguredWallet(expectedAccount = this.account) {
    if (!this.connected) await this.connect();
    const provider = this._walletProvider();
    const client = this.client;
    const expected = String(expectedAccount || this.account || '').toLowerCase();
    const [chainId, accounts] = await Promise.all([
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_accounts' }),
    ]);
    if (chainIdNumber(chainId) !== BRADBURY_CHAIN_ID) {
      this._invalidateWallet('CHAIN_MISMATCH');
      throw new Error('Wallet network changed. Reconnect to Bradbury chain 4221.');
    }
    if (!isConfiguredAddress(accounts?.[0])
      || accounts[0].toLowerCase() !== expected
      || this.client !== client
      || this._walletProvider() !== provider) {
      this._invalidateWallet('ACCOUNT_MISMATCH');
      throw new Error('The active wallet account changed. Reconnect before moving test GEN.');
    }
    return { account: accounts[0], client, provider };
  }

  async _readClient() {
    if (!this.configured) throw new Error('The Bradbury V8 contract address is not configured.');
    if (!this.client) {
      const { createClient, chain } = await this._loadSdk();
      const endpoint = resolveGenLayerWalletRpcUrl(this.walletRpcUrl, this.locationRef);
      this.client = createClient(endpoint ? { chain, endpoint } : { chain });
    }
    return this.client;
  }

  async _addressArgument(account) {
    const { CalldataAddress } = await import('genlayer-js/types');
    return new CalldataAddress(addressBytes(account));
  }

  async _read(functionName, args = []) {
    const client = await this._readClient();
    return client.readContract({ address: this.contractAddress, functionName, args });
  }

  async readConfig() { return this._read('get_config'); }
  async readReserveState() { return this._read('get_delivery_reserve_state'); }
  async readEpoch(timestamp) { return this._read('get_epoch', [epochEnd(timestamp)]); }
  async readEpochAsset(timestamp, assetId) { return this._read('get_epoch_asset', [epochEnd(timestamp), asset(assetId)]); }
  async readObjective(timestamp, requestedObjective) { return this._read('get_objective', [epochEnd(timestamp), objective(requestedObjective)]); }

  async readEpochClaimQuote(timestamp, requestedObjective, account = this.account) {
    if (!account) return null;
    return this._read('get_claim_quote', [
      epochEnd(timestamp),
      objective(requestedObjective),
      await this._addressArgument(account),
    ]);
  }

  async readEpochPage(offset = 0, limit = 20) {
    return this._read('get_epoch_page', [
      pageValue(offset, 'Epoch page offset', { maximum: Number.MAX_SAFE_INTEGER }),
      pageValue(limit, 'Epoch page limit', { minimum: 1 }),
    ]);
  }

  async readRecentEpochIds(limit = 50) {
    const normalizedLimit = pageValue(limit, 'Recent epoch limit', { minimum: 1 });
    const first = await this.readEpochPage(0, 1);
    const total = Number(first?.total);
    if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('get_epoch_page returned a malformed total.');
    if (total === 0) return Object.freeze({ total: 0, epochEndTimestamps: Object.freeze([]) });
    const offset = Math.max(0, total - normalizedLimit);
    const page = offset === 0 && total === 1 ? first : await this.readEpochPage(offset, normalizedLimit);
    if (Number(page?.total) !== total || !Array.isArray(page?.epoch_ids)) {
      throw new TypeError('get_epoch_page returned inconsistent epoch IDs.');
    }
    return Object.freeze({
      total,
      epochEndTimestamps: Object.freeze(page.epoch_ids.map((id) => Number(epochEnd(id)))),
    });
  }

  async readLatestEpoch() {
    const recent = await this.readRecentEpochIds(1);
    if (recent.total === 0) return null;
    const timestamp = recent.epochEndTimestamps[0];
    return Object.freeze({ epochEndTimestamp: BigInt(timestamp), epoch: await this.readEpoch(timestamp), epochCount: recent.total });
  }

  async readPayout(id) { return this._read('get_payout', [payoutId(id)]); }

  async readPayoutPage(offset = 0, limit = 20) {
    return this._read('get_payout_page', [
      pageValue(offset, 'Payout page offset', { maximum: Number.MAX_SAFE_INTEGER }),
      pageValue(limit, 'Payout page limit', { minimum: 1 }),
    ]);
  }

  async readTransaction(hash) {
    return (await this._readClient()).getTransaction({ hash: transactionHash(hash) });
  }

  async readBalance(account = this.account) {
    if (!account) return null;
    const provider = this._walletProvider();
    if (!provider) return null;
    return atto(await provider.request({ method: 'eth_getBalance', params: [String(account), 'latest'] }), 'Wallet balance');
  }

  async _waitForSuccessfulFinalization(hash, client = this.client) {
    const receipt = await client.waitForTransactionReceipt({
      hash: transactionHash(hash),
      status: FINALIZED_STATUS,
      interval: FINALITY_POLL_INTERVAL_MS,
      retries: FINALITY_POLL_RETRIES,
    });
    return assertFinalizedExecution(receipt);
  }

  async _write(functionName, args, { value = 0n, expectedAccount = this.account, onSubmitted } = {}) {
    const { account, client } = await this._assertConfiguredWallet(expectedAccount);
    const hash = await client.writeContract({ address: this.contractAddress, functionName, args, value });
    const normalizedHash = transactionHash(hash);
    if (typeof onSubmitted === 'function') {
      onSubmitted(normalizedHash, Object.freeze({ account, contractAddress: this.contractAddress, functionName }));
    }
    try {
      const receipt = await this._waitForSuccessfulFinalization(normalizedHash, client);
      await this._assertConfiguredWallet(account);
      return Object.freeze({ hash: normalizedHash, receipt, account });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Bradbury transaction failed safely.');
      failure.hash = normalizedHash;
      throw failure;
    }
  }

  async placeEpochWager(timestamp, requestedObjective, assetId, stakeAtto, options = {}) {
    if (!this.newWagersEnabled) throw new Error('New wagers are disabled until the V8 deployment is configured.');
    const epochTimestamp = epochEnd(timestamp);
    const normalizedObjective = objective(requestedObjective);
    const normalizedAsset = asset(assetId);
    const amount = atto(stakeAtto, 'Wager amount', { positive: true });
    const { account } = await this._assertConfiguredWallet();
    const balance = await this.readBalance(account);
    if (balance === null || balance <= amount) throw new Error('Wallet balance must exceed the wager so GEN remains for Bradbury fees.');
    const before = await this.readEpochClaimQuote(epochTimestamp, normalizedObjective, account);
    const beforeQuote = claimQuoteIdentity(before, epochTimestamp, normalizedObjective, account);
    const beforeStake = beforeQuote.stake;
    const result = await this._write('enter', [epochTimestamp, normalizedObjective, normalizedAsset], {
      ...options,
      value: amount,
      expectedAccount: account,
    });
    const quote = await this.readEpochClaimQuote(epochTimestamp, normalizedObjective, account);
    const afterQuote = claimQuoteIdentity(quote, epochTimestamp, normalizedObjective, account);
    if (afterQuote.stake < beforeStake + amount
      || String(quote?.choice_asset_id || '').toUpperCase() !== normalizedAsset) {
      const error = new Error('The finalized wager could not be verified in V8 state.');
      error.hash = result.hash;
      throw error;
    }
    return Object.freeze({ ...result, entry: quote });
  }

  async claimEpoch(timestamp, requestedObjective, options = {}) {
    const epochTimestamp = epochEnd(timestamp);
    const normalizedObjective = objective(requestedObjective);
    const { account } = await this._assertConfiguredWallet();
    const quote = await this.readEpochClaimQuote(epochTimestamp, normalizedObjective, account);
    const signingQuote = claimQuoteIdentity(quote, epochTimestamp, normalizedObjective, account);
    if (quote.eligible !== true || quote.claimed === true || signingQuote.payoutId) {
      throw new Error('This wallet does not have an eligible unclaimed V8 position.');
    }
    const amount = atto(signingQuote.amount, 'Claim amount', { positive: true });
    const result = await this._write('claim', [epochTimestamp, normalizedObjective], {
      ...options,
      expectedAccount: account,
    });
    const after = await this.readEpochClaimQuote(epochTimestamp, normalizedObjective, account);
    const finalizedQuote = claimQuoteIdentity(after, epochTimestamp, normalizedObjective, account);
    const id = payoutId(finalizedQuote.payoutId);
    if (after?.eligible === true || after?.claimed === true
      || finalizedQuote.payoutState !== 'PREPARING'
      || finalizedQuote.stake !== signingQuote.stake
      || finalizedQuote.amount !== amount) {
      const error = new Error('The finalized claim did not create the expected immutable payout.');
      error.hash = result.hash;
      throw error;
    }
    const payout = await this.readPayout(id);
    const identity = payoutIdentity(payout, id, account);
    if (identity.amount !== amount || identity.state !== 'PREPARING') {
      const error = new Error('The V8 payout record does not match the verified claim intent.');
      error.hash = result.hash;
      throw error;
    }
    return Object.freeze({ ...result, quote: after, payout, payoutId: id, amountAtto: amount.toString() });
  }

  async _payoutWrite(id, functionName, expectedState, expectedAfter, options = {}) {
    const normalizedId = payoutId(id);
    const { account } = await this._assertConfiguredWallet();
    const before = await this.readPayout(normalizedId);
    const identity = payoutIdentity(before, normalizedId, account);
    if (identity.state !== expectedState) throw new Error(`Payout must be ${expectedState} before ${functionName}.`);
    const result = await this._write(functionName, [normalizedId], { ...options, expectedAccount: account });
    const payout = await this.readPayout(normalizedId);
    const after = payoutIdentity(payout, normalizedId, account);
    if (!new Set(expectedAfter).has(after.state)) {
      const error = new Error(`${functionName} finalized without the required payout state transition.`);
      error.hash = result.hash;
      throw error;
    }
    return Object.freeze({ ...result, payout, payoutId: normalizedId });
  }

  retryPreparePayout(id, options = {}) {
    return this._payoutWrite(id, 'retry_prepare_payout', 'PREPARING', ['PREPARING'], options);
  }

  dispatchPayout(id, options = {}) {
    return this._payoutWrite(id, 'dispatch_payout', 'PREPARING', ['DISPATCHED'], options);
  }

  retryPayout(id, options = {}) {
    return this._payoutWrite(id, 'retry_payout', 'DISPATCHED', ['DISPATCHED'], options);
  }

  confirmPayout(id, options = {}) {
    return this._payoutWrite(id, 'confirm_payout', 'DISPATCHED', ['FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'], options);
  }

  async refreshPayoutWithdrawal(id, options = {}) {
    const result = await this._payoutWrite(
      id,
      'refresh_payout_withdrawal',
      'FUNDED_IN_ESCROW',
      ['EOA_WITHDRAWN'],
      options,
    );
    const identity = payoutIdentity(result.payout, result.payoutId, result.account);
    const quote = await this.readEpochClaimQuote(
      result.payout.epoch_end_timestamp,
      result.payout.objective,
      result.account,
    );
    const verifiedQuote = claimQuoteIdentity(
      quote,
      result.payout.epoch_end_timestamp,
      result.payout.objective,
      result.account,
    );
    if (quote?.claimed !== true
      || atto(quote.claimed_atto, 'Claimed amount', { positive: true }) !== identity.amount
      || verifiedQuote.amount !== identity.amount
      || verifiedQuote.payoutId !== identity.id
      || verifiedQuote.payoutState !== 'EOA_WITHDRAWN') {
      const error = new Error('Withdrawal refresh did not verify exact claimed V8 state.');
      error.hash = result.hash;
      throw error;
    }
    return Object.freeze({ ...result, quote });
  }

  async activateTimeoutRefund(timestamp, options = {}) {
    const epochTimestamp = epochEnd(timestamp);
    const result = await this._write('activate_timeout_refund', [epochTimestamp], options);
    const epoch = await this.readEpoch(epochTimestamp);
    if (String(epoch?.status || '').toUpperCase() !== 'TIMED_OUT'
      || String(epoch?.result_status || '').toUpperCase() !== 'TIMEOUT') {
      const error = new Error('The finalized timeout refund could not be verified in V8 state.');
      error.hash = result.hash;
      throw error;
    }
    return Object.freeze({ ...result, epoch });
  }

  async _evmCall(to, data) {
    const { provider } = await this._assertConfiguredWallet();
    return provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  }

  async readPayoutVault(payout) {
    const identity = payoutIdentity(payout);
    await this._assertConfiguredWallet(identity.recipient);
    const vault = String(payout.vault || '').trim().toLowerCase();
    if (!isConfiguredAddress(vault)) throw new Error('Payout does not have a prepared EVM vault.');
    const config = await this.readConfig();
    const factory = String(config?.payout_vault_factory || '').trim().toLowerCase();
    if (String(config?.protocol_version || '').trim().toUpperCase() !== 'LIQUIDITY_ARENA_V8'
      || String(config?.payout_protocol_version || '').trim().toUpperCase() !== 'IDEMPOTENT_EVM_VAULT_V1'
      || config?.payouts_enabled !== true
      || factory !== AUDITED_PAYOUT_FACTORY) {
      throw new Error('V8 does not report the audited Bradbury payout factory.');
    }
    const [vaultCode, factoryCode] = await Promise.all([
      this._walletProvider().request({ method: 'eth_getCode', params: [vault, 'latest'] }),
      this._walletProvider().request({ method: 'eth_getCode', params: [factory, 'latest'] }),
    ]);
    if ([vaultCode, factoryCode].some((code) =>
      !/^0x[0-9a-f]+$/i.test(String(code)) || String(code).toLowerCase() === '0x')) {
      throw new Error('The audited factory or payout vault has no Bradbury EVM bytecode.');
    }
    const factoryCall = async (name, args = []) => FACTORY_INTERFACE.decodeFunctionResult(
      name,
      await this._evmCall(factory, FACTORY_INTERFACE.encodeFunctionData(name, args)),
    );
    const [protocolResult, boundResult, preparedResult, vaultResult, reserveSinkResult, vaultRecordResult] = await Promise.all([
      factoryCall('protocol_version'),
      factoryCall('is_bound', [this.contractAddress]),
      factoryCall('is_prepared', [identity.id, identity.recipient, identity.amount]),
      factoryCall('vault_of', [identity.id]),
      factoryCall('reserveSink'),
      this._evmCall(vault, VAULT_INTERFACE.encodeFunctionData('record')),
    ]);
    if (String(protocolResult[0]) !== 'IDEMPOTENT_EVM_VAULT_V1'
      || boundResult[0] !== true
      || preparedResult[0] !== true
      || String(vaultResult[0]).toLowerCase() !== vault) {
      throw new Error('The audited factory does not bind this exact V8 payout definition.');
    }
    const decoded = VAULT_INTERFACE.decodeFunctionResult('record', vaultRecordResult);
    const reserveSink = String(reserveSinkResult[0]).toLowerCase();
    if (!isConfiguredAddress(reserveSink)) throw new Error('The audited factory reserve sink is malformed.');
    const record = Object.freeze({
      vault,
      payoutIdHash: String(decoded[0]).toLowerCase(),
      arena: String(decoded[1]).toLowerCase(),
      recipient: String(decoded[2]).toLowerCase(),
      reserveSink: String(decoded[3]).toLowerCase(),
      amount: BigInt(decoded[4]),
      credited: decoded[5] === true,
      withdrawn: decoded[6] === true,
      creditedAtBlock: BigInt(decoded[7]),
      withdrawnAtBlock: BigInt(decoded[8]),
      balance: BigInt(decoded[9]),
      locked: BigInt(decoded[10]),
      excess: BigInt(decoded[11]),
      factory,
    });
    if (record.payoutIdHash !== keccak256(toUtf8Bytes(identity.id)).toLowerCase()
      || record.recipient !== identity.recipient
      || record.amount !== identity.amount
      || record.arena !== this.contractAddress.toLowerCase()
      || record.reserveSink !== reserveSink
      || record.locked !== (record.credited && !record.withdrawn ? record.amount : 0n)) {
      throw new Error('The EVM vault immutable identity does not match the V8 payout.');
    }
    return record;
  }

  async _waitForEvmReceipt(hash, { interval = EVM_RECEIPT_POLL_INTERVAL_MS, retries = EVM_RECEIPT_POLL_RETRIES } = {}) {
    const provider = this._walletProvider();
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [transactionHash(hash)] });
      if (receipt) return receipt;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('The EVM withdrawal remains pending; reopen this payout to resume verification.');
  }

  async inspectPayoutVaultWithdrawal(hash, payout) {
    const identity = payoutIdentity(payout);
    const { account, provider } = await this._assertConfiguredWallet(identity.recipient);
    const record = await this.readPayoutVault(payout);
    if (record.withdrawn) {
      return Object.freeze({ status: 'VAULT_WITHDRAWN', hash: null, receipt: null, record });
    }
    if (!hash) return Object.freeze({ status: 'READY', hash: null, receipt: null, record });

    const normalizedHash = transactionHash(hash, 'EVM withdrawal hash');
    const [transaction, receipt] = await Promise.all([
      provider.request({ method: 'eth_getTransactionByHash', params: [normalizedHash] }),
      provider.request({ method: 'eth_getTransactionReceipt', params: [normalizedHash] }),
    ]);
    if (!transaction && !receipt) {
      return Object.freeze({ status: 'DROPPED', hash: normalizedHash, receipt: null, record });
    }
    if (receipt
      && String(receipt.transactionHash || '').toLowerCase() === normalizedHash
      && BigInt(receipt.status ?? 0) === 0n) {
      return Object.freeze({ status: 'FAILED', hash: normalizedHash, receipt, record });
    }
    if (!transaction) {
      return Object.freeze({ status: 'PENDING', hash: normalizedHash, receipt, record });
    }
    const exactTransaction = String(transaction.hash || '').toLowerCase() === normalizedHash
      && String(transaction.from || '').toLowerCase() === account.toLowerCase()
      && String(transaction.to || '').toLowerCase() === record.vault
      && String(transaction.input ?? transaction.data ?? '').toLowerCase() === WITHDRAW_SELECTOR
      && BigInt(transaction.value || 0) === 0n;
    if (!exactTransaction) {
      return Object.freeze({ status: 'DROPPED', hash: normalizedHash, receipt, record });
    }
    if (!receipt) {
      return Object.freeze({ status: 'PENDING', hash: normalizedHash, receipt: null, record });
    }
    if (String(receipt.transactionHash || '').toLowerCase() !== normalizedHash
      || String(receipt.from || '').toLowerCase() !== account.toLowerCase()
      || String(receipt.to || '').toLowerCase() !== record.vault) {
      return Object.freeze({ status: 'DROPPED', hash: normalizedHash, receipt, record });
    }
    if (BigInt(receipt.status ?? 0) !== 1n) {
      return Object.freeze({ status: 'FAILED', hash: normalizedHash, receipt, record });
    }
    if (!receipt.blockHash
      || !receipt.blockNumber
      || String(transaction.blockHash || '').toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
      return Object.freeze({ status: 'PENDING', hash: normalizedHash, receipt, record });
    }
    const [finalizedBlock, canonicalBlock] = await Promise.all([
      provider.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] }),
      provider.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }),
    ]);
    if (canonicalBlock?.hash
      && String(canonicalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
      return Object.freeze({ status: 'DROPPED', hash: normalizedHash, receipt, record });
    }
    if (!finalizedBlock?.number
      || BigInt(finalizedBlock.number) < BigInt(receipt.blockNumber)
      || !canonicalBlock?.hash) {
      return Object.freeze({ status: 'PENDING', hash: normalizedHash, receipt, record });
    }
    await this._assertConfiguredWallet(account);
    const finalizedRecord = await this.readPayoutVault(payout);
    return Object.freeze({
      status: finalizedRecord.withdrawn ? 'FINALIZED' : 'PENDING',
      hash: normalizedHash,
      receipt,
      record: finalizedRecord,
    });
  }

  async verifyPayoutVaultWithdrawal(hash, payout, options = {}) {
    const normalizedHash = transactionHash(hash, 'EVM withdrawal hash');
    const identity = payoutIdentity(payout);
    const { account, provider } = await this._assertConfiguredWallet(identity.recipient);
    const vault = String(payout.vault || '').trim().toLowerCase();
    let transaction = await provider.request({ method: 'eth_getTransactionByHash', params: [normalizedHash] });
    let receipt;
    try {
      receipt = await this._waitForEvmReceipt(normalizedHash, options);
    } catch (error) {
      error.hash = normalizedHash;
      error.withdrawalStatus = 'PENDING';
      throw error;
    }
    transaction = await provider.request({ method: 'eth_getTransactionByHash', params: [normalizedHash] });
    if (!transaction
      || String(transaction.hash || '').toLowerCase() !== normalizedHash
      || String(transaction.from || '').toLowerCase() !== account.toLowerCase()
      || String(transaction.to || '').toLowerCase() !== vault
      || String(transaction.input ?? transaction.data ?? '').toLowerCase() !== WITHDRAW_SELECTOR
      || BigInt(transaction.value || 0) !== 0n) {
      const error = new Error('The EVM transaction does not exactly match this recipient-only vault withdrawal.');
      error.hash = normalizedHash;
      error.withdrawalStatus = 'DROPPED';
      throw error;
    }
    if (BigInt(receipt.status ?? 0) !== 1n) {
      const error = new Error('The EVM vault withdrawal reverted and can be retried from verified state.');
      error.hash = normalizedHash;
      error.withdrawalStatus = 'FAILED';
      throw error;
    }
    if (String(receipt.from || '').toLowerCase() !== account.toLowerCase()
      || String(receipt.to || '').toLowerCase() !== vault
      || String(receipt.transactionHash || '').toLowerCase() !== normalizedHash
      || !receipt.blockHash
      || String(transaction.blockHash || '').toLowerCase()
        !== String(receipt.blockHash || '').toLowerCase()) {
      const error = new Error('The EVM vault withdrawal receipt does not match the submitted transaction.');
      error.hash = normalizedHash;
      error.withdrawalStatus = 'DROPPED';
      throw error;
    }
    const [finalizedBlock, canonicalBlock] = await Promise.all([
      provider.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] }),
      provider.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }),
    ]);
    if (!finalizedBlock?.number
      || BigInt(finalizedBlock.number) < BigInt(receipt.blockNumber)
      || String(canonicalBlock?.hash || '').toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
      const error = new Error('The EVM withdrawal is not in the canonical finalized Bradbury chain.');
      error.hash = normalizedHash;
      error.withdrawalStatus = canonicalBlock?.hash ? 'DROPPED' : 'PENDING';
      throw error;
    }
    await this._assertConfiguredWallet(account);
    const record = await this.readPayoutVault(payout);
    if (!record.withdrawn) {
      const error = new Error('The finalized EVM transaction has not marked the vault withdrawn yet.');
      error.hash = normalizedHash;
      error.withdrawalStatus = 'PENDING';
      throw error;
    }
    return Object.freeze({ hash: normalizedHash, receipt, record });
  }

  async withdrawPayoutVault(payout, { onSubmitted, ...waitOptions } = {}) {
    const identity = payoutIdentity(payout);
    if (identity.state !== 'FUNDED_IN_ESCROW') throw new Error('Payout must be funded in escrow before withdrawal.');
    const { account, provider } = await this._assertConfiguredWallet(identity.recipient);
    const record = await this.readPayoutVault(payout);
    if (!record.credited) throw new Error('The exact payout has not been credited to its EVM vault.');
    if (record.withdrawn) {
      return Object.freeze({
        status: 'VAULT_WITHDRAWN',
        hash: null,
        receipt: null,
        record,
        alreadyWithdrawn: true,
      });
    }
    const live = await this.readPayout(identity.id);
    const liveIdentity = payoutIdentity(live, identity.id, account);
    if (liveIdentity.state !== 'FUNDED_IN_ESCROW'
      || String(live.vault || '').toLowerCase() !== record.vault) {
      throw new Error('Payout state changed before the EVM withdrawal could be signed.');
    }
    await this._assertConfiguredWallet(account);
    let submitted;
    try {
      submitted = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: record.vault, data: WITHDRAW_SELECTOR, value: '0x0' }],
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('The wallet rejected the EVM withdrawal request.');
      error.evmBroadcastAttempted = false;
      throw error;
    }
    let hash;
    try {
      hash = transactionHash(submitted, 'EVM withdrawal hash');
    } catch (error) {
      error.evmBroadcastUncertain = true;
      throw error;
    }
    if (typeof onSubmitted === 'function') onSubmitted(hash, Object.freeze({ account, vault: record.vault }));
    return this.verifyPayoutVaultWithdrawal(hash, live, waitOptions);
  }
}

export { shortenAddress };
