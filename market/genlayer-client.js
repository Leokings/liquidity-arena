const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const STUDIONET_CHAIN_ID = 61999;
export const STUDIONET_CHAIN_ID_HEX = '0xf22f';

const FINALIZED_STATUS = 'FINALIZED';
const FINALITY_POLL_INTERVAL_MS = 5000;
// Keep a conservative upper bound for StudioNet consensus and finality.
const FINALITY_POLL_RETRIES = 900;
// Triggered transactions are created asynchronously after the parent is
// finalized. Discovery is deliberately shorter than the finality window; a
// timed-out proof remains recoverable from the activity journal.
const CLAIM_CHILD_DISCOVERY_RETRIES = 60;
const CLAIM_CHILD_FINALITY_RETRIES = 900;
const SUCCESSFUL_EXECUTION = 'FINISHED_WITH_RETURN';
const STUDIO_SUCCESS_CONSENSUS_RESULT = 'MAJORITY_AGREE';
const STUDIO_SUCCESS_CONSENSUS_RESULT_CODE = 6;
const STUDIO_SUCCESS_EXECUTION_RESULT = 'SUCCESS';
const STUDIO_SUCCESS_RETURN_STATUS = 'RETURN';
const V6_OBJECTIVES = new Set(['HIGH', 'LOW']);
const V6_ASSETS = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
const EIP6963_REQUEST_EVENT = 'eip6963:requestProvider';
const EIP6963_ANNOUNCE_EVENT = 'eip6963:announceProvider';
const LOCAL_WALLET_RPC_PATH = '/genlayer-rpc';
const RAW_TRANSACTION_PROOF_REQUEST_ID = 1;
const RAW_TRANSACTION_PROOF_MAX_BYTES = 512 * 1024;
const RAW_JSON_MAX_DEPTH = 64;
const RAW_JSON_MAX_NODES = 50_000;
const RAW_JSON_MAX_INTEGER_DIGITS = 128;
const RAW_JSON_MAX_NUMBER_TOKEN_CHARS = 256;

export function isConfiguredAddress(address) {
  return ADDRESS_PATTERN.test(String(address || '')) && !ZERO_ADDRESS_PATTERN.test(String(address));
}

function isWalletProvider(value) {
  return Boolean(value && typeof value.request === 'function');
}

function isMetaMaskAnnouncement({ info } = {}) {
  const rdns = String(info?.rdns || '').toLowerCase();
  const name = String(info?.name || '').toLowerCase();
  return rdns === 'io.metamask'
    || name === 'metamask';
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
    const announcedLegacy = announcements.find(({ provider }) => provider === legacy);
    return {
      provider: legacy,
      info: announcedLegacy?.info || null,
      source: announcedLegacy ? 'eip6963-legacy' : 'legacy',
    };
  }
  return announcements[0] ? { ...announcements[0], source: 'eip6963' } : null;
}

const NETWORKS = Object.freeze({
  studionet: {
    exportName: 'studionet',
    connectName: 'studionet',
    label: 'STUDIONET',
    displayName: 'GenLayer Studio Network',
    chainId: STUDIONET_CHAIN_ID,
    chainIdHex: STUDIONET_CHAIN_ID_HEX,
    walletWagers: true,
    gasless: true,
  },
});

function shortenAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
}

function roundCount(value) {
  let normalized;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    normalized = BigInt(value.trim());
  } else {
    throw new TypeError('get_round_count returned a malformed count; expected a non-negative integer.');
  }

  if (normalized < 0n) {
    throw new TypeError('get_round_count returned a malformed count; expected a non-negative integer.');
  }
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('get_round_count exceeds the largest safe JavaScript integer.');
  }
  return Number(normalized);
}

function v6Objective(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!V6_OBJECTIVES.has(normalized)) {
    throw new RangeError('Objective must be HIGH or LOW.');
  }
  return normalized;
}

function v6Asset(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!V6_ASSETS.has(normalized)) {
    throw new RangeError('Asset must be BTC, ETH, BNB, SOL, or XRP.');
  }
  return normalized;
}

function epochEnd(value) {
  const normalized = atto(value, 'Epoch end timestamp', { positive: true });
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Epoch end timestamp exceeds the largest safe JavaScript integer.');
  }
  return normalized;
}

function pageValue(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return normalized;
}

function atto(value, label, { positive = false } = {}) {
  let normalized;
  if (typeof value === 'bigint') normalized = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) normalized = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value)) normalized = BigInt(value);
  else throw new TypeError(`${label} must be an integer bigint or decimal integer string.`);
  if (normalized < 0n || (positive && normalized === 0n)) {
    throw new RangeError(`${label} must be ${positive ? 'positive' : 'non-negative'}.`);
  }
  return normalized;
}

function chainIdNumber(value) {
  try {
    return Number(BigInt(value));
  } catch {
    return Number.NaN;
  }
}

function contractAddressBytes(value) {
  const address = String(value || '').trim();
  if (!ADDRESS_PATTERN.test(address)) {
    throw new TypeError('Wallet account must be a 20-byte 0x-prefixed address.');
  }
  const bytes = new Uint8Array(20);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(address.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function assertClaimQuoteIdentity(quote, { epochEndTimestamp, objective, account }) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    throw new TypeError('Claim quote must be an object with verifiable identity fields.');
  }

  let quotedEpoch;
  try {
    quotedEpoch = epochEnd(quote.epoch_end_timestamp);
  } catch {
    throw new TypeError('Claim quote returned an invalid epoch identity.');
  }
  if (quotedEpoch !== epochEndTimestamp) {
    throw new Error('Claim quote belongs to a different epoch.');
  }

  if (typeof quote.objective !== 'string' || quote.objective !== objective) {
    throw new Error('Claim quote belongs to a different objective.');
  }

  if (typeof quote.account !== 'string'
    || !ADDRESS_PATTERN.test(quote.account)
    || ZERO_ADDRESS_PATTERN.test(quote.account)) {
    throw new TypeError('Claim quote returned an invalid wallet account identity.');
  }
  if (typeof account !== 'string'
    || !ADDRESS_PATTERN.test(account)
    || ZERO_ADDRESS_PATTERN.test(account)
    || quote.account.toLowerCase() !== account.toLowerCase()) {
    throw new Error('Claim quote belongs to a different wallet account.');
  }
}

function walletRpcCode(error) {
  const queue = [error];
  const seen = new Set();
  while (queue.length > 0 && seen.size < 24) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = Number(current.code);
    if (Number.isInteger(code)) return code;
    for (const key of ['cause', 'error', 'data', 'originalError']) {
      if (current[key] && typeof current[key] === 'object') queue.push(current[key]);
    }
  }
  return Number.NaN;
}

function walletNetworkError(error, action, descriptor, chain, walletRpcUrl = '') {
  const code = walletRpcCode(error);
  const networkName = String(chain?.name || descriptor?.displayName || descriptor?.label || 'GenLayer');
  const chainId = Number(descriptor?.chainId);
  const defaultRpc = chain?.rpcUrls?.default?.http?.[0];
  const rpc = String(walletRpcUrl || defaultRpc || '').trim();
  if (code === 4001) {
    return new Error(`${networkName} network request was cancelled in the wallet.`);
  }
  if (code === -32601 || /method\s+not\s+found|unsupported method/i.test(String(error?.message || ''))) {
    return new Error(
      `This wallet cannot switch networks automatically. Add ${networkName} `
      + `(chain ${chainId}${rpc ? `, RPC ${rpc}` : ''}) and connect again.`,
    );
  }
  const detail = String(error?.message || '').trim();
  return new Error(
    `Wallet could not ${action} ${networkName} (chain ${chainId}).`
    + (detail ? ` ${detail}` : ''),
  );
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || normalized === '::1'
    || normalized === '[::1]';
}

export function resolveGenLayerWalletRpcUrl(
  configuredUrl = '',
  locationRef = globalThis.window?.location,
) {
  const baseUrl = String(locationRef?.origin || '').trim();
  // Browser traffic must stay on the application origin. Besides satisfying
  // the production CSP, this prevents a stale build-time RPC value from
  // bypassing the hardened /genlayer-rpc adapter.
  const candidate = baseUrl
    ? LOCAL_WALLET_RPC_PATH
    : String(configuredUrl || '').trim();
  if (!candidate) return null;

  let resolved;
  try {
    resolved = new URL(candidate, baseUrl || undefined);
  } catch {
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

function walletNetworkDescriptor(network) {
  const descriptor = typeof network === 'string' ? NETWORKS[network] : network;
  if (
    !descriptor?.walletWagers
    || descriptor.chainId !== STUDIONET_CHAIN_ID
    || String(descriptor.chainIdHex || '').toLowerCase() !== STUDIONET_CHAIN_ID_HEX
    || descriptor.connectName !== 'studionet'
    || !Number.isSafeInteger(descriptor.chainId)
    || descriptor.chainId <= 0
    || !/^0x[\da-f]+$/i.test(String(descriptor.chainIdHex || ''))
  ) {
    throw new Error('Only GenLayer StudioNet is enabled for wallet wagering.');
  }
  if (Number(BigInt(descriptor.chainIdHex)) !== descriptor.chainId) {
    throw new Error('The configured GenLayer network has inconsistent chain identifiers.');
  }
  return descriptor;
}

function genLayerChainParameters(chain, descriptor, walletRpcUrl = '') {
  const rpcUrls = chain?.rpcUrls?.default?.http;
  const nativeCurrency = chain?.nativeCurrency;
  if (
    Number(chain?.id) !== descriptor.chainId
    || !chain?.name
    || !Array.isArray(rpcUrls)
    || rpcUrls.length === 0
    || !nativeCurrency?.name
    || !nativeCurrency?.symbol
    || Number(nativeCurrency?.decimals) !== 18
  ) {
    throw new Error(`The GenLayer SDK returned an invalid ${descriptor.label} chain descriptor.`);
  }
  const parameters = {
    chainId: descriptor.chainIdHex,
    chainName: chain.name,
    nativeCurrency: {
      name: nativeCurrency.name,
      symbol: nativeCurrency.symbol,
      decimals: 18,
    },
    rpcUrls: walletRpcUrl ? [walletRpcUrl] : [...rpcUrls],
  };
  const explorerUrl = chain?.blockExplorers?.default?.url;
  if (explorerUrl) parameters.blockExplorerUrls = [explorerUrl];
  return parameters;
}

export async function ensureGenLayerWalletChain(
  provider,
  chain,
  network = 'studionet',
  walletRpcUrl = '',
) {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('The selected browser wallet does not expose an EIP-1193 provider.');
  }
  const descriptor = walletNetworkDescriptor(network);
  // Validate the SDK descriptor even when the wallet is already on the target
  // chain and no add-chain request is needed.
  const chainParameters = genLayerChainParameters(chain, descriptor, walletRpcUrl);
  const addChain = () => provider.request({
    method: 'wallet_addEthereumChain',
    params: [chainParameters],
  });
  let chainAdded = false;
  if (walletRpcUrl) {
    try {
      await addChain();
      chainAdded = true;
    } catch (error) {
      throw walletNetworkError(error, 'configure', descriptor, chain, walletRpcUrl);
    }
  }

  const currentChainId = await provider.request({ method: 'eth_chainId' });
  if (chainIdNumber(currentChainId) === descriptor.chainId) return;

  const switchRequest = {
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: descriptor.chainIdHex }],
  };
  try {
    await provider.request(switchRequest);
  } catch (error) {
    if (walletRpcCode(error) !== 4902) {
      throw walletNetworkError(error, 'switch to', descriptor, chain, walletRpcUrl);
    }
    try {
      if (!chainAdded) await addChain();
      await provider.request(switchRequest);
    } catch (addError) {
      throw walletNetworkError(addError, 'add or switch to', descriptor, chain, walletRpcUrl);
    }
  }

  const verifiedChainId = await provider.request({ method: 'eth_chainId' });
  if (chainIdNumber(verifiedChainId) !== descriptor.chainId) {
    throw new Error(
      `Wallet network mismatch. Switch to ${chain.name} (chain ${descriptor.chainId}).`,
    );
  }
}

function isPlainReceiptObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueReceiptValue(values, label) {
  const normalized = values
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => String(value).trim().toUpperCase());
  const unique = [...new Set(normalized)];
  if (unique.length > 1) {
    throw new Error(`GenLayer receipt reported conflicting ${label} values.`);
  }
  return unique[0] || '';
}

function oneReceiptObjectVariant(object, snakeName, camelName, label) {
  const snake = object[snakeName];
  const camel = object[camelName];
  if (snake !== undefined && camel !== undefined) {
    throw new Error(`GenLayer receipt reported conflicting ${label} objects.`);
  }
  const value = snake ?? camel;
  if (!isPlainReceiptObject(value)) {
    throw new Error(`GenLayer Studio receipt did not report ${label}.`);
  }
  return value;
}

function studioReceiptExecution(receipt) {
  const resultName = uniqueReceiptValue(
    [receipt.result_name, receipt.resultName],
    'result_name',
  );
  if (!resultName) throw new Error('GenLayer Studio receipt did not report result_name.');
  if (resultName !== STUDIO_SUCCESS_CONSENSUS_RESULT) {
    throw new Error(`GenLayer Studio receipt consensus result is ${resultName}, not MAJORITY_AGREE.`);
  }

  const rawResult = receipt.result;
  const numericResult = typeof rawResult === 'number'
    ? rawResult
    : (/^\d+$/.test(String(rawResult ?? '')) ? Number(rawResult) : Number.NaN);
  if (!Number.isSafeInteger(numericResult)) {
    throw new Error('GenLayer Studio receipt did not report a numeric result code.');
  }
  if (numericResult !== STUDIO_SUCCESS_CONSENSUS_RESULT_CODE) {
    throw new Error(
      `GenLayer Studio receipt result code is ${numericResult}, not `
      + `${STUDIO_SUCCESS_CONSENSUS_RESULT_CODE} (MAJORITY_AGREE).`,
    );
  }

  const consensus = oneReceiptObjectVariant(
    receipt,
    'consensus_data',
    'consensusData',
    'consensus_data',
  );
  const snakeLeaders = consensus.leader_receipt;
  const camelLeaders = consensus.leaderReceipt;
  if (snakeLeaders !== undefined && camelLeaders !== undefined) {
    throw new Error('GenLayer Studio receipt reported conflicting leader_receipt values.');
  }
  const rawLeaders = snakeLeaders ?? camelLeaders;
  const leaders = Array.isArray(rawLeaders) ? rawLeaders : [rawLeaders];
  if (rawLeaders === undefined || leaders.length === 0) {
    throw new Error('GenLayer Studio receipt did not report leader_receipt evidence.');
  }

  const authoritative = [];
  for (const [index, entry] of leaders.entries()) {
    if (!isPlainReceiptObject(entry)) {
      throw new Error(`GenLayer Studio leader_receipt[${index}] is malformed.`);
    }
    const mode = uniqueReceiptValue([entry.mode], `leader_receipt[${index}].mode`);
    if (!mode) throw new Error(`GenLayer Studio leader_receipt[${index}] did not report mode.`);
    if (mode === 'LEADER') authoritative.push({ index, entry });
  }
  if (authoritative.length !== 1) {
    throw new Error(
      `GenLayer Studio receipt must contain exactly one authoritative mode=leader entry; `
      + `received ${authoritative.length}.`,
    );
  }

  const [{ index, entry: leader }] = authoritative;
  const executionResult = uniqueReceiptValue(
    [leader.execution_result, leader.executionResult],
    `leader_receipt[${index}].execution_result`,
  );
  if (executionResult !== STUDIO_SUCCESS_EXECUTION_RESULT) {
    throw new Error(
      `GenLayer Studio leader_receipt[${index}] execution_result is `
      + `${executionResult || '(missing)'}, not SUCCESS.`,
    );
  }
  if (!isPlainReceiptObject(leader.result)) {
    throw new Error(`GenLayer Studio leader_receipt[${index}] did not report a result object.`);
  }
  const returnStatus = uniqueReceiptValue(
    [leader.result.status],
    `leader_receipt[${index}].result.status`,
  );
  if (returnStatus !== STUDIO_SUCCESS_RETURN_STATUS) {
    throw new Error(
      `GenLayer Studio leader_receipt[${index}] result.status is `
      + `${returnStatus || '(missing)'}, not return.`,
    );
  }

  const genvm = leader.genvm_result ?? leader.genvmResult;
  if (genvm !== undefined) {
    if (!isPlainReceiptObject(genvm)) {
      throw new Error(`GenLayer Studio leader_receipt[${index}].genvm_result is malformed.`);
    }
    const rawError = genvm.raw_error ?? genvm.rawError;
    const errorCode = genvm.error_code ?? genvm.errorCode;
    if (rawError !== undefined && rawError !== null) {
      throw new Error(`GenLayer Studio leader_receipt[${index}] reported a GenVM raw error.`);
    }
    if (errorCode !== undefined && errorCode !== null) {
      throw new Error(`GenLayer Studio leader_receipt[${index}] reported a GenVM error code.`);
    }
  }

  return SUCCESSFUL_EXECUTION;
}

export function assertFinalizedExecution(receipt) {
  if (!isPlainReceiptObject(receipt)) {
    throw new Error('GenLayer did not return a finalized transaction receipt.');
  }
  const statusName = uniqueReceiptValue(
    [receipt.status_name, receipt.statusName],
    'status_name',
  );
  if (statusName !== FINALIZED_STATUS) {
    throw new Error(`GenLayer transaction is ${statusName || 'UNKNOWN'}, not FINALIZED.`);
  }

  const nativeExecution = uniqueReceiptValue(
    [receipt.tx_execution_result_name, receipt.txExecutionResultName],
    'txExecutionResultName',
  );
  const hasStudioConsensus = receipt.consensus_data !== undefined
    || receipt.consensusData !== undefined;
  const hasStudioResult = receipt.result_name !== undefined
    || receipt.resultName !== undefined
    || receipt.result !== undefined;
  let studioExecution = '';
  if (hasStudioConsensus || (!nativeExecution && hasStudioResult)) {
    studioExecution = studioReceiptExecution(receipt);
  }
  if (nativeExecution && studioExecution && nativeExecution !== studioExecution) {
    throw new Error('GenLayer receipt reported conflicting execution result evidence.');
  }
  const execution = nativeExecution || studioExecution;
  if (execution !== SUCCESSFUL_EXECUTION) {
    const result = execution || 'UNKNOWN';
    throw new Error(`GenLayer finalized the transaction, but contract execution was ${result}.`);
  }
  return receipt;
}

function claimDeliveryError(message, { hash = null, childHash = null } = {}) {
  const error = new Error(message);
  if (hash) error.hash = hash;
  if (childHash) error.childHash = childHash;
  error.deliveryStatus = 'REVIEW';
  return error;
}

function normalizedTransactionHash(value, label = 'GenLayer transaction hash') {
  const hash = String(value || '').trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(hash)) {
    throw new TypeError(`${label} must be a 32-byte 0x-prefixed value.`);
  }
  return hash;
}

function messageInteger(value, label) {
  let normalized;
  if (typeof value === 'bigint') normalized = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) normalized = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) normalized = BigInt(value.trim());
  else throw new TypeError(`${label} is not an unsigned integer.`);
  if (normalized < 0n) throw new TypeError(`${label} is not an unsigned integer.`);
  return normalized;
}

class RawJsonNumber {
  constructor(raw) {
    this.raw = raw;
    Object.freeze(this);
  }
}

class LosslessJsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.nodeCount = 0;
    this.numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  }

  fail(message) {
    throw new TypeError(`Raw GenLayer transaction proof is invalid JSON: ${message}.`);
  }

  whitespace() {
    while (/[ \t\r\n]/.test(this.source[this.index] || '')) this.index += 1;
  }

  parse() {
    this.whitespace();
    const result = this.value(0);
    this.whitespace();
    if (this.index !== this.source.length) this.fail('unexpected trailing data');
    return result;
  }

  value(depth) {
    if (depth > RAW_JSON_MAX_DEPTH) this.fail('maximum nesting depth exceeded');
    this.nodeCount += 1;
    if (this.nodeCount > RAW_JSON_MAX_NODES) this.fail('maximum node count exceeded');
    this.whitespace();
    const token = this.source[this.index];
    if (token === '{') return this.object(depth + 1);
    if (token === '[') return this.array(depth + 1);
    if (token === '"') return this.string();
    if (token === 't' && this.source.slice(this.index, this.index + 4) === 'true') {
      this.index += 4;
      return true;
    }
    if (token === 'f' && this.source.slice(this.index, this.index + 5) === 'false') {
      this.index += 5;
      return false;
    }
    if (token === 'n' && this.source.slice(this.index, this.index + 4) === 'null') {
      this.index += 4;
      return null;
    }
    if (token === '-' || /\d/.test(token || '')) return this.number();
    this.fail('unexpected token');
    return undefined;
  }

  object(depth) {
    this.index += 1;
    const result = Object.create(null);
    const keys = new Set();
    this.whitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') this.fail('object key must be a string');
      const key = this.string();
      if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ':') this.fail('object key is missing a colon');
      this.index += 1;
      result[key] = this.value(depth);
      this.whitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ',') this.fail('object entries are not comma separated');
      this.index += 1;
      this.whitespace();
    }
    this.fail('unterminated object');
    return undefined;
  }

  array(depth) {
    this.index += 1;
    const result = [];
    this.whitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.source.length) {
      result.push(this.value(depth));
      this.whitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ',') this.fail('array entries are not comma separated');
      this.index += 1;
      this.whitespace();
    }
    this.fail('unterminated array');
    return undefined;
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (token === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.fail('malformed string');
        }
      }
      if (token === '\\') {
        this.index += 1;
        const escape = this.source[this.index];
        if (!escape || !/["\\/bfnrtu]/.test(escape)) this.fail('malformed string escape');
        if (escape === 'u') {
          const codepoint = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(codepoint)) this.fail('malformed unicode escape');
          this.index += 4;
        }
      } else if (token.charCodeAt(0) <= 0x1f) {
        this.fail('unescaped control character in string');
      }
      this.index += 1;
    }
    this.fail('unterminated string');
    return undefined;
  }

  number() {
    this.numberPattern.lastIndex = this.index;
    const match = this.numberPattern.exec(this.source);
    if (!match) this.fail('malformed number');
    const [raw] = match;
    this.index = this.numberPattern.lastIndex;
    if (raw.length > RAW_JSON_MAX_NUMBER_TOKEN_CHARS) {
      this.fail('numeric token is too long');
    }
    if (/[.eE]/.test(raw)) return new RawJsonNumber(raw);
    const unsignedDigits = raw[0] === '-' ? raw.slice(1) : raw;
    if (unsignedDigits.length > RAW_JSON_MAX_INTEGER_DIGITS) {
      this.fail('integer token has too many digits');
    }
    try {
      return BigInt(raw);
    } catch {
      this.fail('malformed integer');
      return undefined;
    }
  }
}

function singleRawField(object, names, label, { required = true } = {}) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length > 1) {
    throw new Error(`Raw GenLayer transaction proof has ambiguous ${label} fields.`);
  }
  if (present.length === 0) {
    if (required) throw new Error(`Raw GenLayer transaction proof is missing ${label}.`);
    return undefined;
  }
  return object[present[0]];
}

function exactTransactionIdentity(transaction, expectedHash, label) {
  if (!isPlainReceiptObject(transaction)) throw new Error(`Raw ${label} transaction is malformed.`);
  const hashes = ['hash', 'tx_id', 'txId']
    .filter((name) => Object.hasOwn(transaction, name))
    .map((name) => normalizedTransactionHash(transaction[name], `Raw ${label} ${name}`));
  if (hashes.length === 0) throw new Error(`Raw ${label} transaction does not report its hash.`);
  if (new Set(hashes).size !== 1) throw new Error(`Raw ${label} transaction reports conflicting hashes.`);
  if (hashes[0] !== expectedHash) throw new Error(`Raw ${label} transaction hash does not match the requested hash.`);
}

function exactFinalizedStatus(transaction, label) {
  const status = singleRawField(transaction, ['status', 'status_name', 'statusName'], `${label} status`);
  if (typeof status !== 'string' || status.trim().toUpperCase() !== FINALIZED_STATUS) {
    throw new Error(`Raw ${label} transaction is not FINALIZED.`);
  }
}

function exactRecipient(transaction, expectedRecipient, label, names = ['recipient', 'to_address', 'toAddress']) {
  const recipients = names
    .filter((name) => Object.hasOwn(transaction, name))
    .map((name) => String(transaction[name] || '').trim().toLowerCase());
  if (recipients.length === 0 || recipients.some((value) => !ADDRESS_PATTERN.test(value))) {
    throw new Error(`Raw ${label} transaction recipient is malformed.`);
  }
  if (new Set(recipients).size !== 1) throw new Error(`Raw ${label} transaction reports conflicting recipients.`);
  if (recipients[0] !== expectedRecipient) {
    throw new Error(`Raw ${label} transaction recipient does not match the submitting wallet.`);
  }
}

function exactRawAddressField(transaction, names, expectedAddress, label) {
  const value = singleRawField(transaction, names, label);
  const normalized = String(value || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`Raw ${label} is malformed.`);
  }
  if (normalized !== expectedAddress) {
    throw new Error(`Raw ${label} does not match the claim contract.`);
  }
  return normalized;
}

function canonicalRawMessage(message) {
  if (!isPlainReceiptObject(message)) throw new Error('Raw claim transfer message is malformed.');
  return {
    recipient: singleRawField(message, ['recipient'], 'claim message recipient'),
    value: singleRawField(message, ['value'], 'claim message value'),
    data: singleRawField(message, ['data'], 'claim message data'),
    messageType: singleRawField(message, ['messageType', 'message_type'], 'claim message type'),
    saltNonce: singleRawField(
      message,
      ['saltNonce', 'salt_nonce'],
      'claim message salt',
      { required: false },
    ),
    onAcceptance: singleRawField(message, ['onAcceptance', 'on_acceptance'], 'claim message finality'),
  };
}

export function parseRawGenLayerTransactionResponse(rawResponse, expectedHash) {
  const text = String(rawResponse || '');
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > RAW_TRANSACTION_PROOF_MAX_BYTES) {
    throw new RangeError('Raw GenLayer transaction proof response is too large.');
  }
  if (!text.trim()) throw new TypeError('Raw GenLayer transaction proof response is empty.');
  const envelope = new LosslessJsonParser(text).parse();
  if (!isPlainReceiptObject(envelope) || envelope.jsonrpc !== '2.0') {
    throw new Error('Raw GenLayer transaction proof has an invalid JSON-RPC envelope.');
  }
  if (envelope.id !== BigInt(RAW_TRANSACTION_PROOF_REQUEST_ID)) {
    throw new Error('Raw GenLayer transaction proof response ID does not match its request.');
  }
  const hasResult = Object.hasOwn(envelope, 'result');
  const hasError = Object.hasOwn(envelope, 'error');
  if (hasResult === hasError) throw new Error('Raw GenLayer transaction proof response is ambiguous.');
  if (hasError) throw new Error('Raw GenLayer transaction proof RPC returned an error.');
  const hash = normalizedTransactionHash(expectedHash, 'Raw transaction proof expected hash');
  exactTransactionIdentity(envelope.result, hash, 'proof');
  return envelope.result;
}

export function verifyRawClaimParentTransaction(
  transaction,
  { hash, recipient, amountAtto, childHash },
) {
  const expectedHash = normalizedTransactionHash(hash, 'Raw claim parent hash');
  const expectedChildHash = normalizedTransactionHash(childHash, 'Raw claim child hash');
  const account = String(recipient || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(account)) throw new TypeError('Raw claim recipient is invalid.');
  const expected = atto(amountAtto, 'Raw claim amount', { positive: true });
  exactTransactionIdentity(transaction, expectedHash, 'claim parent');
  exactFinalizedStatus(transaction, 'claim parent');
  if (!Array.isArray(transaction.messages) || transaction.messages.length !== 1) {
    throw new Error('Raw finalized claim must contain exactly one transfer message.');
  }
  verifyClaimTransferMessage(
    { messages: [canonicalRawMessage(transaction.messages[0])] },
    account,
    expected,
  );
  const triggered = singleRawField(
    transaction,
    ['triggered_transactions', 'triggeredTransactions'],
    'triggered transaction list',
  );
  if (!Array.isArray(triggered) || triggered.length !== 1) {
    throw new Error('Raw finalized claim must report exactly one triggered child transaction.');
  }
  const reportedChild = normalizedTransactionHash(triggered[0], 'Raw triggered claim child hash');
  if (reportedChild !== expectedChildHash) {
    throw new Error('Raw triggered claim child hash does not match the discovered child.');
  }
  return Object.freeze({ hash: expectedHash, childHash: reportedChild, amountAtto: expected });
}

export function verifyRawClaimChildTransaction(
  transaction,
  { hash, parentHash, recipient, amountAtto, contractAddress },
) {
  const expectedHash = normalizedTransactionHash(hash, 'Raw claim child hash');
  const expectedParentHash = normalizedTransactionHash(parentHash, 'Raw claim parent hash');
  const account = String(recipient || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(account)) throw new TypeError('Raw claim recipient is invalid.');
  const contract = String(contractAddress || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(contract)) throw new TypeError('Raw claim contract address is invalid.');
  const expected = atto(amountAtto, 'Raw claim amount', { positive: true });
  exactTransactionIdentity(transaction, expectedHash, 'claim child');
  exactFinalizedStatus(transaction, 'claim child');
  exactRecipient(transaction, account, 'claim child');
  exactRawAddressField(transaction, ['sender'], contract, 'claim child sender');
  exactRawAddressField(
    transaction,
    ['from_address', 'fromAddress'],
    contract,
    'claim child from address',
  );
  exactRawAddressField(
    transaction,
    ['origin_address', 'originAddress'],
    contract,
    'claim child origin address',
  );
  const triggeredBy = singleRawField(
    transaction,
    ['triggered_by', 'triggeredBy'],
    'claim child parent hash',
  );
  if (normalizedTransactionHash(triggeredBy, 'Raw claim child parent hash') !== expectedParentHash) {
    throw new Error('Raw claim child does not report the expected parent hash.');
  }
  const triggeredOn = singleRawField(
    transaction,
    ['triggered_on', 'triggeredOn'],
    'claim child trigger finality',
  );
  if (triggeredOn !== 'finalized') {
    throw new Error('Raw claim child was not triggered on parent finalization.');
  }
  if (messageInteger(singleRawField(transaction, ['type'], 'claim child type'), 'Raw claim child type') !== 0n) {
    throw new Error('Raw claim child is not a native value-transfer transaction type.');
  }
  const value = messageInteger(
    singleRawField(transaction, ['value'], 'claim child value'),
    'Raw claim child value',
  );
  if (value !== expected) {
    throw new Error('Raw claim child value does not exactly match the verified claimed amount.');
  }
  const valueCredited = singleRawField(
    transaction,
    ['value_credited', 'valueCredited'],
    'claim child value credit status',
  );
  if (valueCredited !== true) {
    throw new Error('Raw claim child did not credit its exact value to the recipient.');
  }
  return Object.freeze({
    hash: expectedHash,
    recipient: account,
    contractAddress: contract,
    amountAtto: expected,
  });
}

async function readBoundedResponseText(response, maxBytes) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RangeError('Raw GenLayer transaction proof response is too large.');
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Raw GenLayer transaction proof returned a malformed byte stream.');
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RangeError('Raw GenLayer transaction proof response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Raw GenLayer transaction proof response is not valid UTF-8.');
  }
}

function resolveRawTransactionProofUrl(locationRef) {
  const rawOrigin = String(locationRef?.origin || '').trim();
  if (!rawOrigin) return null;
  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new TypeError('The application origin is invalid for raw GenLayer transaction proof.');
  }
  if (origin.origin !== rawOrigin.replace(/\/$/, '')) {
    throw new TypeError('The application origin is ambiguous for raw GenLayer transaction proof.');
  }
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopbackHostname(origin.hostname))) {
    throw new TypeError('Raw GenLayer transaction proof requires HTTPS outside localhost development.');
  }
  const endpoint = new URL(LOCAL_WALLET_RPC_PATH, origin);
  if (endpoint.origin !== origin.origin || endpoint.pathname !== LOCAL_WALLET_RPC_PATH) {
    throw new Error('Raw GenLayer transaction proof must use the same-origin RPC adapter.');
  }
  return endpoint.href;
}

function emptyMessageData(value) {
  if (value === '' || value === '0x') return true;
  if (value instanceof Uint8Array) return value.byteLength === 0;
  return Array.isArray(value) && value.length === 0;
}

/**
 * Validate the SubmittedMessage emitted by claim(). genlayer-js 1.1.8 leaves
 * `messages` typed as unknown[], so every runtime field is checked here. The
 * Studio currently exposes the native value-transfer MessageType as zero. An
 * empty-data, exact-value message of that type to the submitting EOA is the
 * observable transfer shape, and the separately verified triggered transaction
 * proves that the message was processed.
 */
export function verifyClaimTransferMessage(transaction, recipient, minimumValueAtto) {
  const account = String(recipient || '').trim().toLowerCase();
  if (!ADDRESS_PATTERN.test(account)) throw new TypeError('Claim delivery recipient is invalid.');
  const expected = atto(minimumValueAtto, 'Claim delivery amount', { positive: true });
  if (!transaction || typeof transaction !== 'object' || !Array.isArray(transaction.messages)) {
    throw new Error('The finalized parent transaction does not expose emitted messages.');
  }
  if (transaction.messages.length !== 1) {
    throw new Error(`The finalized claim emitted ${transaction.messages.length} messages; exactly one is required.`);
  }
  const [message] = transaction.messages;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('The finalized claim emitted a malformed message.');
  }
  const messageRecipient = String(message.recipient || '').trim().toLowerCase();
  if (messageRecipient !== account) {
    throw new Error('The finalized claim message recipient does not match the submitting wallet.');
  }
  const valueAtto = messageInteger(message.value, 'Claim message value');
  if (valueAtto !== expected) {
    throw new Error('The finalized claim message value does not exactly match the verified claimed amount.');
  }
  if (!emptyMessageData(message.data)) {
    throw new Error('The finalized claim message contains call data and is not a plain value transfer.');
  }
  if (messageInteger(message.messageType, 'Claim message type') !== 0n) {
    throw new Error('The finalized claim message is not a plain value-transfer message type.');
  }
  if (message.saltNonce !== undefined) messageInteger(message.saltNonce, 'Claim message salt');
  if (message.onAcceptance !== false) {
    throw new Error('The claim message is not a finalization-only value transfer.');
  }
  return Object.freeze({ recipient: account, valueAtto, raw: message });
}

function transactionRecipient(transaction) {
  return String(transaction?.recipient || transaction?.to_address || '').trim().toLowerCase();
}

export class GenLayerGateway {
  constructor({
    contractAddress = import.meta.env?.VITE_GENLAYER_CONTRACT || '',
    network = import.meta.env?.VITE_GENLAYER_NETWORK || 'studionet',
    walletRpcUrl = import.meta.env?.VITE_GENLAYER_WALLET_RPC || '',
    deploymentAlias = '',
    protocolVersion = '',
    newWagersEnabled = true,
    locationRef = globalThis.window?.location,
    provider = null,
    sdkLoader = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.contractAddress = contractAddress;
    this.deploymentAlias = String(deploymentAlias || '').trim().toLowerCase() || null;
    this.protocolVersion = String(protocolVersion || '').trim().toUpperCase() || null;
    if (this.deploymentAlias && !['v6', 'v7'].includes(this.deploymentAlias)) {
      throw new Error('GenLayer deployment alias is not allowlisted.');
    }
    const aliasProtocol = this.deploymentAlias
      ? `LIQUIDITY_ARENA_${this.deploymentAlias.toUpperCase()}`
      : null;
    if (aliasProtocol && this.protocolVersion !== aliasProtocol) {
      throw new Error('GenLayer deployment alias and protocol do not match.');
    }
    this.newWagersEnabled = newWagersEnabled === true;
    this.requestedNetwork = network;
    this.network = NETWORKS[network] ? network : null;
    this.configurationError = this.network
      ? null
      : `Unsupported GenLayer network "${network}".`;
    this.provider = provider;
    this.fetchImpl = fetchImpl;
    this.walletRpcUrl = walletRpcUrl;
    this.locationRef = locationRef;
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

  get networkLabel() {
    return this.network ? NETWORKS[this.network].label : 'UNSUPPORTED';
  }

  get networkDescriptor() {
    return this.network ? NETWORKS[this.network] : null;
  }

  get configured() {
    return !this.configurationError && isConfiguredAddress(this.contractAddress);
  }

  get wagerConfigured() {
    return this.walletConfigured
      && this.newWagersEnabled;
  }

  get walletConfigured() {
    return this.configured
      && this.network === 'studionet'
      && this.networkDescriptor?.walletWagers === true;
  }

  get connected() {
    return Boolean(this.account && this.client && this.walletVerified);
  }

  get accountLabel() {
    return shortenAddress(this.account);
  }

  _walletProvider() {
    return this.provider || globalThis.window?.ethereum || null;
  }

  async _loadSdk() {
    if (this.configurationError) throw new Error(this.configurationError);
    if (this.sdkLoader) return this.sdkLoader(this.network);
    const [{ createClient }, chains] = await Promise.all([
      import('genlayer-js'),
      import('genlayer-js/chains'),
    ]);
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

  disconnect() {
    this._invalidateWallet('DISCONNECTED');
  }

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
      if (!this.configured) {
        throw new Error('A GenLayer contract address is not configured.');
      }
      throw new Error(`Test-GEN wallet transactions are not enabled on ${this.networkLabel}.`);
    }
    const selectedWallet = this.provider
      ? { provider: this.provider, info: this.providerInfo, source: 'configured' }
      : await selectInjectedWalletProvider();
    const provider = selectedWallet?.provider;
    if (!provider) {
      throw new Error('A browser wallet such as MetaMask is required to sign test-GEN wagers.');
    }
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts?.[0] || !ADDRESS_PATTERN.test(accounts[0])) {
      throw new Error('No valid wallet account was returned.');
    }
    const { createClient, chain } = await this._loadSdk();
    const descriptor = walletNetworkDescriptor(this.networkDescriptor);
    const walletRpcUrl = resolveGenLayerWalletRpcUrl(this.walletRpcUrl, this.locationRef);
    await ensureGenLayerWalletChain(provider, chain, descriptor, walletRpcUrl);
    const client = createClient({ chain, account: accounts[0], provider });

    const [chainId, activeAccounts] = await Promise.all([
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_accounts' }),
    ]);
    if (chainIdNumber(chainId) !== descriptor.chainId) {
      throw new Error(
        `Wallet network mismatch. Switch to ${chain.name} (chain ${descriptor.chainId}).`,
      );
    }
    if (!activeAccounts?.[0] || activeAccounts[0].toLowerCase() !== accounts[0].toLowerCase()) {
      throw new Error('The active wallet account changed during connection. Connect again.');
    }

    this.provider = provider;
    this.providerInfo = selectedWallet?.info || null;
    this.account = activeAccounts[0];
    this.client = client;
    this.walletVerified = true;
    this._installProviderListeners(provider);
    return {
      address: this.account,
      label: this.accountLabel,
      network: this.networkLabel,
      chainId: descriptor.chainId,
      walletName: String(this.providerInfo?.name || '').trim() || null,
    };
  }

  async _assertConfiguredWallet() {
    if (!this.connected) await this.connect();
    const descriptor = walletNetworkDescriptor(this.networkDescriptor);
    const provider = this._walletProvider();
    const [chainId, accounts] = await Promise.all([
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_accounts' }),
    ]);
    if (chainIdNumber(chainId) !== descriptor.chainId) {
      this._invalidateWallet('CHAIN_MISMATCH');
      throw new Error(
        `Wallet network changed. Reconnect to ${descriptor.label} (chain ${descriptor.chainId}).`,
      );
    }
    if (!accounts?.[0] || accounts[0].toLowerCase() !== this.account.toLowerCase()) {
      this._invalidateWallet('ACCOUNT_MISMATCH');
      throw new Error('The active wallet account changed. Reconnect before sending test GEN.');
    }
    return this.account;
  }

  async _assertWalletTransactionContext(expectedAccount) {
    const expected = String(expectedAccount || '');
    const provider = this._walletProvider();
    const client = this.client;
    if (!ADDRESS_PATTERN.test(expected)
      || ZERO_ADDRESS_PATTERN.test(expected)
      || !this.walletConfigured
      || !this.connected
      || !provider
      || this.account.toLowerCase() !== expected.toLowerCase()) {
      this._invalidateWallet('TRANSACTION_CONTEXT_CHANGED');
      throw new Error('The wallet connection changed before signing. Reconnect and verify the claim again.');
    }

    const descriptor = walletNetworkDescriptor(this.networkDescriptor);
    let chainId;
    let accounts;
    try {
      [chainId, accounts] = await Promise.all([
        provider.request({ method: 'eth_chainId' }),
        provider.request({ method: 'eth_accounts' }),
      ]);
    } catch {
      this._invalidateWallet('TRANSACTION_CONTEXT_UNVERIFIED');
      throw new Error('The wallet account and StudioNet network could not be reverified before signing.');
    }
    if (chainIdNumber(chainId) !== descriptor.chainId) {
      this._invalidateWallet('CHAIN_MISMATCH');
      throw new Error(
        `Wallet network changed before signing. Reconnect to ${descriptor.label} (chain ${descriptor.chainId}).`,
      );
    }
    const activeAccount = accounts?.[0];
    if (!activeAccount
      || !ADDRESS_PATTERN.test(activeAccount)
      || ZERO_ADDRESS_PATTERN.test(activeAccount)
      || activeAccount.toLowerCase() !== expected.toLowerCase()
      || !this.connected
      || this.client !== client
      || this._walletProvider() !== provider
      || this.account.toLowerCase() !== expected.toLowerCase()) {
      this._invalidateWallet('ACCOUNT_MISMATCH');
      throw new Error('The active wallet account changed before signing. Reconnect and verify the claim again.');
    }
    return client;
  }

  async _readClient() {
    if (!this.client) {
      const { createClient, chain } = await this._loadSdk();
      const endpoint = resolveGenLayerWalletRpcUrl(this.walletRpcUrl, this.locationRef);
      this.client = createClient(endpoint ? { chain, endpoint } : { chain });
    }
    return this.client;
  }

  _rawTransactionProofUrl() {
    return resolveRawTransactionProofUrl(this.locationRef);
  }

  async _readRawTransactionProof(hash, endpoint = this._rawTransactionProofUrl()) {
    const normalizedHash = normalizedTransactionHash(hash, 'Raw transaction proof hash');
    if (!endpoint) throw new Error('A same-origin raw transaction proof endpoint is unavailable.');
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('A fetch implementation is unavailable for raw transaction proof.');
    }
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: RAW_TRANSACTION_PROOF_REQUEST_ID,
          method: 'eth_getTransactionByHash',
          params: [normalizedHash],
        }),
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
      });
    } catch (error) {
      throw new Error(`Raw GenLayer transaction proof request failed. ${error?.message || ''}`.trim());
    }
    if (!response || response.ok !== true || typeof response.text !== 'function') {
      throw new Error(`Raw GenLayer transaction proof returned HTTP ${response?.status || 'ERROR'}.`);
    }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      throw new Error('Raw GenLayer transaction proof did not return JSON.');
    }
    const declaredLength = String(response.headers?.get?.('content-length') || '').trim();
    if (declaredLength) {
      if (!/^\d+$/.test(declaredLength)
        || BigInt(declaredLength) > BigInt(RAW_TRANSACTION_PROOF_MAX_BYTES)) {
        throw new Error('Raw GenLayer transaction proof response is too large or malformed.');
      }
    }
    return parseRawGenLayerTransactionResponse(
      await readBoundedResponseText(response, RAW_TRANSACTION_PROOF_MAX_BYTES),
      normalizedHash,
    );
  }

  async _contractAddressArgument(account) {
    const { CalldataAddress } = await import('genlayer-js/types');
    return new CalldataAddress(contractAddressBytes(account));
  }

  async readConfig() {
    if (!this.configured) return null;
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_config',
      args: [],
    });
  }

  async readAssetCatalog() {
    if (!this.configured) return null;
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_asset_catalog',
      args: [],
    });
  }

  async readVenueCatalog() {
    if (!this.configured) return null;
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_venue_catalog',
      args: [],
    });
  }

  async readEpoch(epochEndTimestamp) {
    if (!this.configured) return null;
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch',
      args: [epochEnd(epochEndTimestamp)],
    });
  }

  async readEpochAsset(epochEndTimestamp, assetId) {
    if (!this.configured) return null;
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch_asset',
      args: [epochEnd(epochEndTimestamp), v6Asset(assetId)],
    });
  }

  async readObjective(epochEndTimestamp, requestedObjective) {
    if (!this.configured) return null;
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_objective',
      args: [epochEnd(epochEndTimestamp), v6Objective(requestedObjective)],
    });
  }

  async readEpochEntry(epochEndTimestamp, requestedObjective, account = this.account) {
    if (!this.configured || !account) return null;
    const [client, addressArgument] = await Promise.all([
      this._readClient(),
      this._contractAddressArgument(account),
    ]);
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_entry',
      args: [epochEnd(epochEndTimestamp), v6Objective(requestedObjective), addressArgument],
    });
  }

  async readEpochClaimQuote(epochEndTimestamp, requestedObjective, account = this.account) {
    if (!this.configured || !account) return null;
    const [client, addressArgument] = await Promise.all([
      this._readClient(),
      this._contractAddressArgument(account),
    ]);
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_claim_quote',
      args: [epochEnd(epochEndTimestamp), v6Objective(requestedObjective), addressArgument],
    });
  }

  async readEpochPage(offset = 0, limit = 20) {
    if (!this.configured) return null;
    const normalizedOffset = pageValue(offset, 'Epoch page offset');
    const normalizedLimit = pageValue(limit, 'Epoch page limit', { minimum: 1, maximum: 50 });
    const client = await this._readClient();
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch_page',
      args: [normalizedOffset, normalizedLimit],
    });
  }

  async readRecentEpochIds(limit = 50) {
    if (!this.configured) return null;
    const normalizedLimit = pageValue(limit, 'Recent epoch limit', { minimum: 1, maximum: 50 });
    const client = await this._readClient();
    const total = roundCount(await client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch_count',
      args: [],
    }));
    if (total === 0) {
      return Object.freeze({ total, epochEndTimestamps: Object.freeze([]) });
    }
    const offset = Math.max(0, total - normalizedLimit);
    const page = await client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch_page',
      args: [offset, normalizedLimit],
    });
    if (!page || !Array.isArray(page.epoch_ids)) {
      throw new TypeError('get_epoch_page returned malformed epoch IDs.');
    }
    const epochEndTimestamps = page.epoch_ids.map((value) => Number(epochEnd(value)));
    return Object.freeze({ total, epochEndTimestamps: Object.freeze(epochEndTimestamps) });
  }

  async readLatestEpoch() {
    if (!this.configured) return null;
    const client = await this._readClient();
    const count = roundCount(await client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch_count',
      args: [],
    }));
    if (count === 0) return null;
    const index = count - 1;
    const rawEpochId = await client.readContract({
      address: this.contractAddress,
      functionName: 'get_epoch_id',
      args: [index],
    });
    const epochEndTimestamp = epochEnd(rawEpochId);
    const epoch = await this.readEpoch(epochEndTimestamp);
    return Object.freeze({
      epochEndTimestamp,
      epoch,
      epochCount: count,
      index,
    });
  }

  async readWalletPositionCount(account = this.account) {
    if (!this.configured || !account) return 0;
    const [client, addressArgument] = await Promise.all([
      this._readClient(),
      this._contractAddressArgument(account),
    ]);
    return roundCount(await client.readContract({
      address: this.contractAddress,
      functionName: 'get_wallet_position_count',
      args: [addressArgument],
    }));
  }

  async readWalletPosition(account = this.account, index = 0) {
    if (!this.configured || !account) return null;
    const normalizedIndex = pageValue(index, 'Wallet position index');
    const [client, addressArgument] = await Promise.all([
      this._readClient(),
      this._contractAddressArgument(account),
    ]);
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_wallet_position',
      args: [addressArgument, normalizedIndex],
    });
  }

  async readWalletPositionPage(account = this.account, offset = 0, limit = 20) {
    if (!this.configured || !account) return null;
    const normalizedOffset = pageValue(offset, 'Wallet position page offset');
    const normalizedLimit = pageValue(limit, 'Wallet position page limit', { minimum: 1, maximum: 50 });
    const [client, addressArgument] = await Promise.all([
      this._readClient(),
      this._contractAddressArgument(account),
    ]);
    return client.readContract({
      address: this.contractAddress,
      functionName: 'get_wallet_position_page',
      args: [addressArgument, normalizedOffset, normalizedLimit],
    });
  }

  async readTransaction(hash) {
    const normalizedHash = normalizedTransactionHash(hash);
    const client = await this._readClient();
    return client.getTransaction({ hash: normalizedHash });
  }

  async verifyClaimDelivery(parentHash, {
    recipient,
    minimumValueAtto,
    parentTransaction = null,
    expectedChildHash = null,
    onChildDiscovered = null,
    interval = FINALITY_POLL_INTERVAL_MS,
    discoveryRetries = CLAIM_CHILD_DISCOVERY_RETRIES,
    finalityRetries = CLAIM_CHILD_FINALITY_RETRIES,
  } = {}) {
    const hash = normalizedTransactionHash(parentHash, 'Claim parent transaction hash');
    const account = String(recipient || '').trim().toLowerCase();
    if (!ADDRESS_PATTERN.test(account)) throw new TypeError('Claim delivery recipient is invalid.');
    const expected = atto(minimumValueAtto, 'Claim delivery amount', { positive: true });
    for (const [value, label] of [
      [interval, 'Claim delivery poll interval'],
      [discoveryRetries, 'Claim child discovery retries'],
      [finalityRetries, 'Claim child finality retries'],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
    }

    let rawProofEndpoint;
    try {
      rawProofEndpoint = this._rawTransactionProofUrl();
    } catch (error) {
      throw claimDeliveryError(
        `Claim state is finalized, but the same-origin raw proof endpoint is invalid. ${error?.message || ''}`.trim(),
        { hash },
      );
    }

    const client = await this._readClient();
    const parent = parentTransaction || await client.getTransaction({ hash });
    if (String(parent?.statusName || parent?.status_name || '').toUpperCase() !== FINALIZED_STATUS) {
      throw claimDeliveryError('The claim parent transaction is not FINALIZED.', { hash });
    }
    try {
      assertFinalizedExecution(parent);
      if (!rawProofEndpoint) verifyClaimTransferMessage(parent, account, expected);
    } catch (error) {
      throw claimDeliveryError(
        `Claim state is finalized, but its value-transfer message could not be verified. ${error?.message || ''}`.trim(),
        { hash },
      );
    }

    if (typeof client.getTriggeredTransactionIds !== 'function') {
      throw claimDeliveryError(
        'Claim state is finalized, but this GenLayer RPC/SDK cannot prove its triggered transfer transaction.',
        { hash },
      );
    }

    let childHash = null;
    for (let attempt = 0; attempt <= discoveryRetries; attempt += 1) {
      let ids;
      try {
        ids = await client.getTriggeredTransactionIds({ hash });
      } catch (error) {
        throw claimDeliveryError(
          `Claim state is finalized, but the triggered transfer lookup failed. ${error?.message || ''}`.trim(),
          { hash },
        );
      }
      if (!Array.isArray(ids)) {
        throw claimDeliveryError('GenLayer returned a malformed triggered-transaction list for this claim.', { hash });
      }
      if (ids.length > 1) {
        throw claimDeliveryError(
          `The finalized claim has ${ids.length} triggered transactions; exactly one is required.`,
          { hash },
        );
      }
      if (ids.length === 1) {
        try {
          childHash = normalizedTransactionHash(ids[0], 'Claim transfer child hash');
        } catch (error) {
          throw claimDeliveryError(error.message, { hash });
        }
        break;
      }
      if (attempt < discoveryRetries) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
    if (!childHash) {
      throw claimDeliveryError(
        'Claim state is finalized, but no triggered transfer transaction was found within the bounded polling window.',
        { hash },
      );
    }
    if (expectedChildHash && normalizedTransactionHash(expectedChildHash, 'Expected claim child hash') !== childHash) {
      throw claimDeliveryError('The triggered transfer hash conflicts with the persisted claim child hash.', {
        hash,
        childHash,
      });
    }
    if (typeof onChildDiscovered === 'function') {
      onChildDiscovered(childHash, Object.freeze({ account, contractAddress: this.contractAddress }));
    }

    if (rawProofEndpoint) {
      try {
        const rawParent = await this._readRawTransactionProof(hash, rawProofEndpoint);
        verifyRawClaimParentTransaction(rawParent, {
          hash,
          recipient: account,
          amountAtto: expected,
          childHash,
        });
      } catch (error) {
        throw claimDeliveryError(
          `Claim state is finalized, but its lossless parent transfer proof failed. ${error?.message || ''}`.trim(),
          { hash, childHash },
        );
      }
    }

    let childReceipt;
    try {
      childReceipt = await client.waitForTransactionReceipt({
        hash: childHash,
        status: FINALIZED_STATUS,
        interval,
        retries: finalityRetries,
      });
    } catch (error) {
      throw claimDeliveryError(
        `The claim transfer child was found but did not reach FINALIZED within the bounded polling window. ${error?.message || ''}`.trim(),
        { hash, childHash },
      );
    }
    if (String(childReceipt?.statusName || childReceipt?.status_name || '').toUpperCase() !== FINALIZED_STATUS) {
      throw claimDeliveryError('The claim transfer child is not FINALIZED.', { hash, childHash });
    }
    if (childReceipt.txExecutionResultName
      && String(childReceipt.txExecutionResultName).toUpperCase() !== SUCCESSFUL_EXECUTION) {
      throw claimDeliveryError(
        `The claim transfer child finalized with ${childReceipt.txExecutionResultName}.`,
        { hash, childHash },
      );
    }

    let child;
    try {
      child = await client.getTransaction({ hash: childHash });
    } catch (error) {
      throw claimDeliveryError(
        `The finalized claim transfer child could not be read for recipient verification. ${error?.message || ''}`.trim(),
        { hash, childHash },
      );
    }
    if (String(child?.statusName || child?.status_name || '').toUpperCase() !== FINALIZED_STATUS) {
      throw claimDeliveryError('The claim transfer child readback is not FINALIZED.', { hash, childHash });
    }
    if (child.txExecutionResultName
      && String(child.txExecutionResultName).toUpperCase() !== SUCCESSFUL_EXECUTION) {
      throw claimDeliveryError(
        `The claim transfer child readback reports ${child.txExecutionResultName}.`,
        { hash, childHash },
      );
    }
    if (transactionRecipient(child) !== account) {
      throw claimDeliveryError(
        'The finalized claim transfer child recipient does not match the submitting wallet.',
        { hash, childHash },
      );
    }
    const reportedChildHash = child.hash || child.txId;
    if (reportedChildHash && normalizedTransactionHash(reportedChildHash, 'Claim transfer child readback hash') !== childHash) {
      throw claimDeliveryError('The claim transfer child readback hash does not match its triggered hash.', {
        hash,
        childHash,
      });
    }
    if (child.value !== undefined) {
      const unsafeSdkInteger = typeof child.value === 'number'
        && Number.isInteger(child.value)
        && child.value >= 0
        && !Number.isSafeInteger(child.value);
      if (!unsafeSdkInteger || !rawProofEndpoint) {
        if (messageInteger(child.value, 'Claim transfer child value') !== expected) {
          throw claimDeliveryError('The finalized claim transfer child value does not exactly match the verified claimed amount.', {
            hash,
            childHash,
          });
        }
      }
    }
    if (rawProofEndpoint) {
      try {
        const rawChild = await this._readRawTransactionProof(childHash, rawProofEndpoint);
        verifyRawClaimChildTransaction(rawChild, {
          hash: childHash,
          parentHash: hash,
          recipient: account,
          amountAtto: expected,
          contractAddress: this.contractAddress,
        });
      } catch (error) {
        throw claimDeliveryError(
          `The finalized claim transfer child failed its lossless raw proof. ${error?.message || ''}`.trim(),
          { hash, childHash },
        );
      }
    }
    return Object.freeze({
      status: 'DELIVERED',
      childHash,
      receipt: childReceipt,
      transaction: child,
      proofMode: rawProofEndpoint ? 'RAW_SAME_ORIGIN' : 'SDK_SAFE_INTEGER',
    });
  }

  async readBalance(account = this.account) {
    if (!account) return null;
    const provider = this._walletProvider();
    if (!provider) return null;
    const balance = await provider.request({ method: 'eth_getBalance', params: [String(account), 'latest'] });
    try {
      const normalized = BigInt(balance);
      if (normalized < 0n) throw new RangeError('negative balance');
      return normalized;
    } catch {
      throw new TypeError('Wallet returned a malformed native GEN balance.');
    }
  }

  async _waitForSuccessfulFinalization(hash, client = this.client) {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      status: FINALIZED_STATUS,
      interval: FINALITY_POLL_INTERVAL_MS,
      retries: FINALITY_POLL_RETRIES,
    });
    assertFinalizedExecution(receipt);
    return receipt;
  }

  async placeEpochWager(epochEndTimestamp, requestedObjective, assetId, stakeAtto, { onSubmitted } = {}) {
    if (!this.newWagersEnabled) {
      throw new Error('New wagers are disabled for this legacy deployment. Claims and timeout refunds remain available.');
    }
    const epochTimestamp = epochEnd(epochEndTimestamp);
    const normalizedObjective = v6Objective(requestedObjective);
    const normalizedAsset = v6Asset(assetId);
    const amount = atto(stakeAtto, 'Wager amount', { positive: true });
    const account = await this._assertConfiguredWallet();
    const balance = await this.readBalance(account);
    const requiresFeeReserve = this.networkDescriptor?.gasless !== true;
    if (balance === null || balance < amount || (requiresFeeReserve && balance === amount)) {
      throw new Error(
        requiresFeeReserve
          ? 'Wallet balance must exceed the wager so GEN remains available for network fees.'
          : 'Wallet balance must cover the wager amount.',
      );
    }
    const before = await this.readEpochEntry(epochTimestamp, normalizedObjective, account);
    const beforeStake = before ? atto(before.stake_atto ?? 0n, 'Existing stake') : 0n;
    const signingClient = await this._assertWalletTransactionContext(account);
    const hash = await signingClient.writeContract({
      address: this.contractAddress,
      functionName: 'enter',
      args: [epochTimestamp, normalizedObjective, normalizedAsset],
      value: amount,
    });
    try {
      if (typeof onSubmitted === 'function') {
        onSubmitted(hash, Object.freeze({
          account,
          contractAddress: this.contractAddress,
          epochEndTimestamp: epochTimestamp.toString(),
          objective: normalizedObjective,
        }));
      }
      const receipt = await this._waitForSuccessfulFinalization(hash, signingClient);
      const entry = await this.readEpochEntry(epochTimestamp, normalizedObjective, account);
      const verifiedStake = entry ? atto(entry.stake_atto ?? 0n, 'Verified stake') : 0n;
      if (!entry || verifiedStake < beforeStake + amount) {
        throw new Error('The finalized wager could not be verified in contract state.');
      }
      if (String(entry.choice_asset_id || '').trim().toUpperCase() !== normalizedAsset) {
        throw new Error('The finalized wager asset does not match the requested asset.');
      }
      return { hash, receipt, entry };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('StudioNet test-GEN wager failed safely.');
      failure.hash = hash;
      throw failure;
    }
  }

  async claimEpoch(epochEndTimestamp, requestedObjective, {
    onSubmitted,
    onDeliveryDiscovered,
  } = {}) {
    const epochTimestamp = epochEnd(epochEndTimestamp);
    const normalizedObjective = v6Objective(requestedObjective);
    const account = await this._assertConfiguredWallet();
    const quote = await this.readEpochClaimQuote(epochTimestamp, normalizedObjective, account);
    assertClaimQuoteIdentity(quote, {
      epochEndTimestamp: epochTimestamp,
      objective: normalizedObjective,
      account,
    });
    if (!quote || quote.eligible !== true || quote.claimed === true) {
      throw new Error('This wallet does not have an eligible unclaimed payout or refund.');
    }
    const quotedAmount = atto(
      quote.claim_amount_atto ?? quote.amount_atto ?? 0n,
      'Claim amount',
      { positive: true },
    );
    const signingClient = await this._assertWalletTransactionContext(account);
    const hash = await signingClient.writeContract({
      address: this.contractAddress,
      functionName: 'claim',
      args: [epochTimestamp, normalizedObjective],
      value: 0n,
    });
    let actualAmount = null;
    try {
      if (typeof onSubmitted === 'function') {
        onSubmitted(hash, Object.freeze({
          account,
          contractAddress: this.contractAddress,
          epochEndTimestamp: epochTimestamp.toString(),
          objective: normalizedObjective,
          quotedAmountAtto: quotedAmount.toString(),
        }));
      }
      const receipt = await this._waitForSuccessfulFinalization(hash, signingClient);
      const entry = await this.readEpochEntry(epochTimestamp, normalizedObjective, account);
      if (!entry || entry.claimed !== true) {
        throw new Error('The finalized claim could not be verified in contract state.');
      }
      actualAmount = atto(
        entry.claimed_amount_atto ?? entry.claimed_atto ?? 0n,
        'Finalized claimed amount',
        { positive: true },
      );
      if (actualAmount < quotedAmount) {
        throw new Error('The finalized claimed amount is below the amount verified immediately before signing.');
      }
      const delivery = await this.verifyClaimDelivery(hash, {
        recipient: account,
        minimumValueAtto: actualAmount,
        onChildDiscovered: typeof onDeliveryDiscovered === 'function'
          ? (childHash, submission) => onDeliveryDiscovered(childHash, Object.freeze({
              ...submission,
              quotedAmountAtto: quotedAmount.toString(),
              actualAmountAtto: actualAmount.toString(),
            }))
          : null,
      });
      return {
        hash,
        receipt,
        entry,
        quotedAmount,
        quotedAmountAtto: quotedAmount.toString(),
        actualAmount,
        actualAmountAtto: actualAmount.toString(),
        delivery,
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('StudioNet test-GEN claim failed safely.');
      failure.hash = hash;
      failure.quotedAmount = quotedAmount;
      failure.quotedAmountAtto = quotedAmount.toString();
      if (actualAmount !== null) {
        failure.actualAmount = actualAmount;
        failure.actualAmountAtto = actualAmount.toString();
      }
      throw failure;
    }
  }

  async activateTimeoutRefund(epochEndTimestamp, { onSubmitted } = {}) {
    const epochTimestamp = epochEnd(epochEndTimestamp);
    const account = await this._assertConfiguredWallet();
    const signingClient = await this._assertWalletTransactionContext(account);
    const hash = await signingClient.writeContract({
      address: this.contractAddress,
      functionName: 'activate_timeout_refund',
      args: [epochTimestamp],
      value: 0n,
    });
    try {
      if (typeof onSubmitted === 'function') {
        onSubmitted(hash, Object.freeze({
          account,
          contractAddress: this.contractAddress,
          epochEndTimestamp: epochTimestamp.toString(),
        }));
      }
      const receipt = await this._waitForSuccessfulFinalization(hash, signingClient);
      const epoch = await this.readEpoch(epochTimestamp);
      if (String(epoch?.status || '').trim().toUpperCase() !== 'TIMED_OUT'
        || String(epoch?.result_status || '').trim().toUpperCase() !== 'TIMEOUT') {
        throw new Error('The finalized timeout refund could not be verified in contract state.');
      }
      return { hash, receipt, epoch };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Timeout principal unlock failed safely.');
      failure.hash = hash;
      throw failure;
    }
  }
}

export { shortenAddress };
