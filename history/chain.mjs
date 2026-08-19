import {
  parseRawGenLayerTransactionResponse,
  verifyRawClaimChildTransaction,
  verifyRawClaimParentTransaction,
} from '../market/genlayer-client.js';
import { HistoryError } from './errors.mjs';
import { HISTORY_ASSETS, transactionHash } from './schema.mjs';

const FINALIZED = 'FINALIZED';
const SUCCESS = 'FINISHED_WITH_RETURN';
const MAX_RPC_BYTES = 512 * 1024;
const MAX_CONCURRENCY = 3;
const MAX_EPOCH_INDEX_WINDOW = 50;
const CALL_TIMEOUT_MS = 8_000;
const REQUEST_DEADLINE_MS = 75_000;
const RESOLUTION_PUBLICATION_DELAY_SECONDS = 120;
const METHOD_KIND = Object.freeze({
  create_epoch: 'CREATE_EPOCH',
  resolve_epoch: 'RESOLVE_EPOCH',
  activate_timeout_refund: 'ACTIVATE_TIMEOUT_REFUND',
  enter: 'WAGER',
  claim: 'CLAIM',
  withdraw_accrued_fees: 'FEE_WITHDRAWAL',
});

function fail(code, message, statusCode = 502, cause) {
  throw new HistoryError(code, message, { statusCode, cause });
}

function normalizedAddress(value, label) {
  const address = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) fail('HISTORY_PROOF', `${label} is malformed.`);
  return address;
}

function configuredDeploymentId(deployment) {
  const rpcAddress = String(deployment?.address || '').trim();
  const addressKey = rpcAddress.toLowerCase();
  const deploymentId = `studionet:${addressKey}`;
  if (!/^0x[0-9a-f]{40}$/.test(addressKey)
    || deployment?.addressKey !== addressKey
    || deployment?.deploymentId !== deploymentId) {
    throw new TypeError('History deployment must have one canonical RPC address and a matching lowercase identity.');
  }
  return deploymentId;
}

function singleField(object, names, label, { required = true } = {}) {
  const present = names.filter((name) => Object.hasOwn(object || {}, name));
  if (present.length > 1) fail('HISTORY_PROOF', `StudioNet proof has ambiguous ${label}.`);
  if (present.length === 0) {
    if (required) fail('HISTORY_PROOF', `StudioNet proof is missing ${label}.`);
    return undefined;
  }
  return object[present[0]];
}

function matchingAlias(object, names, label, normalize = String, { required = true } = {}) {
  const present = names.filter((name) => Object.hasOwn(object || {}, name));
  if (present.length === 0) {
    if (required) fail('HISTORY_PROOF', `StudioNet proof is missing ${label}.`);
    return undefined;
  }
  const values = present.map((name) => normalize(object[name]));
  if (new Set(values).size !== 1) fail('HISTORY_PROOF', `StudioNet proof reports conflicting ${label}.`);
  return values[0];
}

function rawInteger(value, label, { positive = false } = {}) {
  let amount;
  if (typeof value === 'bigint') amount = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) amount = BigInt(value);
  else if (/^\d+$/.test(String(value ?? ''))) amount = BigInt(String(value));
  else fail('HISTORY_PROOF', `${label} is not an unsigned integer.`);
  if (amount < 0n || (positive && amount === 0n)) fail('HISTORY_PROOF', `${label} is outside its allowed range.`);
  return amount;
}

function rawFinalized(transaction, label) {
  const status = matchingAlias(transaction, ['status', 'status_name', 'statusName'], `${label} status`, (value) => String(value).toUpperCase());
  if (status !== FINALIZED) fail('HISTORY_PROOF', `${label} is not FINALIZED.`);
}

function receiptFinalized(receipt, label) {
  const status = matchingAlias(receipt, ['statusName', 'status_name', 'status'], `${label} receipt status`, (value) => String(value).toUpperCase());
  if (status !== FINALIZED) fail('HISTORY_PROOF', `${label} receipt is not FINALIZED.`);
  const execution = matchingAlias(
    receipt,
    ['txExecutionResultName', 'tx_execution_result_name'],
    `${label} execution result`,
    (value) => String(value).toUpperCase(),
    { required: false },
  );
  if (execution && execution !== SUCCESS) fail('HISTORY_PROOF', `${label} execution did not succeed.`);
  return execution || null;
}

function receiptCall(receipt) {
  const decoded = receipt?.txDataDecoded ?? receipt?.tx_data_decoded;
  if (!decoded || decoded.type !== 'call' || !decoded.callData || typeof decoded.callData.method !== 'string'
    || !Array.isArray(decoded.callData.args)) {
    fail('HISTORY_PROOF', 'Finalized StudioNet transaction has no exact decoded contract call.');
  }
  return Object.freeze({
    method: decoded.callData.method,
    args: Object.freeze(decoded.callData.args.map((value) => String(value))),
  });
}

function exactContractRecipient(raw, contractAddress) {
  const recipient = matchingAlias(
    raw,
    ['recipient', 'to_address', 'toAddress'],
    'contract recipient',
    (value) => normalizedAddress(value, 'contract recipient'),
  );
  const allowlistedAddress = normalizedAddress(contractAddress, 'allowlisted contract address');
  if (recipient !== allowlistedAddress) fail('HISTORY_PROOF', 'Finalized call targets a contract outside the deployment allowlist.');
  return recipient;
}

function exactSender(raw) {
  return matchingAlias(
    raw,
    ['sender', 'from_address', 'fromAddress'],
    'transaction sender',
    (value) => normalizedAddress(value, 'transaction sender'),
  );
}

function epochFromCall(call) {
  if (call.method === 'withdraw_accrued_fees') return null;
  const raw = String(call.args[0] ?? '');
  if (!/^\d+$/.test(raw)) fail('HISTORY_PROOF', 'Finalized call has no canonical epoch argument.');
  const epoch = BigInt(raw);
  if (epoch <= 0n || epoch > BigInt(Number.MAX_SAFE_INTEGER) || epoch % 3600n !== 0n) {
    fail('HISTORY_PROOF', 'Finalized call epoch is not an exact UTC hour.');
  }
  return epoch.toString();
}

function validateCallArguments(call, deployment) {
  const epoch = epochFromCall(call);
  const objective = (value) => {
    if (!['HIGH', 'LOW'].includes(String(value || '').toUpperCase())) {
      fail('HISTORY_PROOF', 'Finalized call objective is invalid.');
    }
  };
  if (call.method === 'create_epoch') {
    const expectedLength = deployment.protocolVersion === 'LIQUIDITY_ARENA_V7' ? 1 : 3;
    if (call.args.length !== expectedLength) fail('HISTORY_PROOF', 'Finalized create_epoch arguments are invalid.');
    for (const [index, value] of call.args.entries()) {
      if (!/^\d+$/.test(value) || BigInt(value) <= 0n) fail('HISTORY_PROOF', `Finalized create_epoch argument ${index} is invalid.`);
    }
  } else if (call.method === 'resolve_epoch' || call.method === 'activate_timeout_refund') {
    if (call.args.length !== 1) fail('HISTORY_PROOF', `Finalized ${call.method} arguments are invalid.`);
  } else if (call.method === 'enter') {
    if (call.args.length !== 3) fail('HISTORY_PROOF', 'Finalized enter arguments are invalid.');
    objective(call.args[1]);
    if (!HISTORY_ASSETS.includes(String(call.args[2] || '').toUpperCase())) fail('HISTORY_PROOF', 'Finalized wager asset is invalid.');
  } else if (call.method === 'claim') {
    if (call.args.length !== 2) fail('HISTORY_PROOF', 'Finalized claim arguments are invalid.');
    objective(call.args[1]);
  } else if (call.method === 'withdraw_accrued_fees') {
    if (call.args.length !== 1 || !/^\d+$/.test(call.args[0]) || BigInt(call.args[0]) <= 0n) {
      fail('HISTORY_PROOF', 'Finalized fee withdrawal arguments are invalid.');
    }
  }
  return epoch;
}

async function boundedResponseText(response, maximumBytes = MAX_RPC_BYTES) {
  const declared = String(response?.headers?.get?.('content-length') || '');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    fail('HISTORY_RPC_SIZE', 'StudioNet RPC response is too large.');
  }
  if (!response?.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) fail('HISTORY_RPC_SIZE', 'StudioNet RPC response is too large.');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        fail('HISTORY_RPC_SIZE', 'StudioNet RPC response is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    fail('HISTORY_RPC_ENCODING', 'StudioNet RPC response is not valid UTF-8.', 502, error);
  } finally {
    reader.releaseLock?.();
  }
}

async function mapConcurrent(values, worker, concurrency = MAX_CONCURRENCY) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

export function createStudioNetHistoryChain({
  configuration,
  fetchImpl = globalThis.fetch,
  createClientImpl,
  now = Date.now,
  callTimeoutMs = CALL_TIMEOUT_MS,
  requestDeadlineMs = REQUEST_DEADLINE_MS,
} = {}) {
  if (!configuration || configuration.chainId !== 61999 || configuration.network !== 'studionet') {
    throw new TypeError('A StudioNet history chain configuration is required.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const endpoint = new URL(configuration.rpcUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError('History StudioNet RPC must be credential-free HTTPS.');
  }
  const byId = new Map(configuration.deployments.map((item) => [configuredDeploymentId(item), item]));
  if (byId.size !== configuration.deployments.length) {
    throw new TypeError('History deployments must have unique lowercase identities.');
  }
  let clientPromise;
  let networkVerified = false;

  const deadline = () => now() + requestDeadlineMs;
  function remaining(until) {
    const value = until - now();
    if (value <= 0) fail('HISTORY_SYNC_DEADLINE', 'History sync exceeded its whole-request deadline.', 504);
    return Math.min(callTimeoutMs, value);
  }

  async function timed(promise, until, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new HistoryError(
            'HISTORY_CHAIN_TIMEOUT',
            `${label} timed out.`,
            { statusCode: 504 },
          )), remaining(until));
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc(method, params, until, maximumBytes = MAX_RPC_BYTES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining(until));
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      fail('HISTORY_RPC_TRANSPORT', 'StudioNet RPC request failed.', 502, error);
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) fail('HISTORY_RPC_HTTP', `StudioNet RPC returned HTTP ${response?.status || 'ERROR'}.`);
    return boundedResponseText(response, maximumBytes);
  }

  async function verifyNetwork(until) {
    if (networkVerified) return;
    const text = await rpc('eth_chainId', [], until, 16 * 1024);
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch (error) {
      fail('HISTORY_RPC_JSON', 'StudioNet chain identity response is invalid JSON.', 502, error);
    }
    if (envelope?.jsonrpc !== '2.0' || envelope?.id !== 1
      || String(envelope?.result || '').toLowerCase() !== '0xf22f'
      || Object.hasOwn(envelope, 'error')) {
      fail('HISTORY_CHAIN_IDENTITY', 'History RPC is not StudioNet chain 0xf22f.');
    }
    networkVerified = true;
  }

  async function client() {
    clientPromise ||= Promise.resolve().then(async () => {
      if (createClientImpl) return createClientImpl({ endpoint: endpoint.href });
      const [{ createClient }, { studionet }] = await Promise.all([
        import('genlayer-js'),
        import('genlayer-js/chains'),
      ]);
      return createClient({ chain: studionet, endpoint: endpoint.href });
    });
    return clientPromise;
  }

  function deploymentById(deploymentId) {
    const deployment = byId.get(String(deploymentId || '').toLowerCase());
    if (!deployment) fail('HISTORY_DEPLOYMENT_ALLOWLIST', 'History deployment is not allowlisted.', 400);
    return deployment;
  }

  async function read(deployment, functionName, args, until) {
    const sdk = await client();
    return timed(sdk.readContract({
      address: deployment.address,
      functionName,
      args,
    }), until, `${deployment.alias}.${functionName}`);
  }

  async function readDeployment(deploymentId, { maxEpochs, startOffset }) {
    const until = deadline();
    await verifyNetwork(until);
    const deployment = deploymentById(deploymentId);
    const [config, assetCatalog, venueCatalog, rawCount] = await Promise.all([
      read(deployment, 'get_config', [], until),
      read(deployment, 'get_asset_catalog', [], until),
      read(deployment, 'get_venue_catalog', [], until),
      read(deployment, 'get_epoch_count', [], until),
    ]);
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      fail('HISTORY_CHAIN_SCHEMA', 'StudioNet epoch count is invalid.');
    }
    const scanOffset = startOffset === null
      ? Math.max(0, count - MAX_EPOCH_INDEX_WINDOW)
      : Math.min(startOffset, count);
    const scanLimit = Math.min(
      startOffset === null ? MAX_EPOCH_INDEX_WINDOW : maxEpochs,
      count - scanOffset,
    );
    let ids = [];
    let offset = scanOffset;
    if (scanLimit > 0) {
      const page = await read(deployment, 'get_epoch_page', [scanOffset, scanLimit], until);
      if (!page || Number(page.offset) !== scanOffset || Number(page.next_offset) !== scanOffset + scanLimit
        || Number(page.total) !== count || !Array.isArray(page.epoch_ids) || page.epoch_ids.length !== scanLimit) {
        fail('HISTORY_CHAIN_SCHEMA', 'StudioNet epoch page is inconsistent.');
      }
      ids = page.epoch_ids.map((value) => String(value));
      if (new Set(ids).size !== ids.length || ids.some((value) => !/^\d+$/.test(value))) {
        fail('HISTORY_CHAIN_SCHEMA', 'StudioNet epoch page contains malformed identifiers.');
      }
      if (startOffset === null) {
        // Keep scheduled projection work on epochs whose resolution may already
        // be published. V7 is deliberately seeded more than a day ahead, so a
        // raw tail page otherwise contains only future OPEN epochs and never
        // revisits the hourly epoch that has just become terminal.
        const latestResolvableEpoch = Math.floor(
          ((now() / 1_000) - RESOLUTION_PUBLICATION_DELAY_SECONDS) / 3_600,
        ) * 3_600;
        const selected = ids
          .map((epochEndTimestamp, index) => ({ epochEndTimestamp, index: scanOffset + index }))
          .filter(({ epochEndTimestamp }) => Number(epochEndTimestamp) <= latestResolvableEpoch)
          .slice(-maxEpochs);
        ids = selected.map(({ epochEndTimestamp }) => epochEndTimestamp);
        offset = selected[0]?.index ?? count;
      }
    }
    const epochs = await mapConcurrent(ids, async (epochEndTimestamp) => {
      const epochArgument = BigInt(epochEndTimestamp);
      const epoch = await read(deployment, 'get_epoch', [epochArgument], until);
      const determined = String(epoch?.result_status || '').toUpperCase() === 'DETERMINED';
      const assets = determined
        ? await mapConcurrent(HISTORY_ASSETS, (asset) => read(
          deployment,
          'get_epoch_asset',
          [epochArgument, asset],
          until,
        ))
        : [];
      return Object.freeze({ epoch, assets });
    });
    return Object.freeze({
      deployment,
      config,
      assetCatalog,
      venueCatalog,
      epochCount: count,
      offset,
      epochs: Object.freeze(epochs),
    });
  }

  async function rawTransaction(hash, until) {
    const normalized = transactionHash(hash, 'proof hash');
    const text = await rpc('eth_getTransactionByHash', [normalized], until);
    return parseRawGenLayerTransactionResponse(text, normalized);
  }

  async function finalizedReceipt(hash, until) {
    const sdk = await client();
    return timed(sdk.waitForTransactionReceipt({
      hash,
      status: FINALIZED,
      interval: 1,
      retries: 0,
    }), until, 'transaction finality proof');
  }

  async function verifyClaimChild({ rawParent, parentHash, contractAddress, epochEndTimestamp, until }) {
    const messages = rawParent.messages;
    if (!Array.isArray(messages) || messages.length !== 1) fail('HISTORY_PROOF', 'Finalized claim must emit exactly one transfer.');
    const message = messages[0];
    const recipient = normalizedAddress(singleField(message, ['recipient'], 'claim transfer recipient'), 'claim recipient');
    const claimant = exactSender(rawParent);
    if (!claimant || recipient !== claimant) {
      fail('HISTORY_PROOF', 'Claim transfer recipient does not match the finalized claimant.');
    }
    const amountAtto = rawInteger(singleField(message, ['value'], 'claim transfer value'), 'claim transfer value', { positive: true });
    const children = matchingAlias(
      rawParent,
      ['triggered_transactions', 'triggeredTransactions'],
      'claim child list',
      (value) => JSON.stringify(value),
    );
    const parsedChildren = JSON.parse(children);
    if (!Array.isArray(parsedChildren) || parsedChildren.length !== 1) fail('HISTORY_PROOF', 'Finalized claim must derive exactly one child transfer.');
    const childHash = transactionHash(parsedChildren[0], 'claim child hash');
    verifyRawClaimParentTransaction(rawParent, {
      hash: parentHash,
      recipient,
      amountAtto,
      childHash,
    });
    const [rawChild, childReceipt] = await Promise.all([
      rawTransaction(childHash, until),
      finalizedReceipt(childHash, until),
    ]);
    receiptFinalized(childReceipt, 'claim child');
    verifyRawClaimChildTransaction(rawChild, {
      hash: childHash,
      parentHash,
      recipient,
      amountAtto,
      contractAddress,
    });
    return Object.freeze({
      epochEndTimestamp,
      recipient,
      amountAtto: amountAtto.toString(),
      childHash,
    });
  }

  async function verifyProof(request) {
    const until = deadline();
    await verifyNetwork(until);
    const deployment = deploymentById(request.deploymentId);
    const hash = transactionHash(request.hash, 'proof hash');
    const [raw, receipt] = await Promise.all([
      rawTransaction(hash, until),
      finalizedReceipt(hash, until),
    ]);
    rawFinalized(raw, 'transaction');
    const executionResult = receiptFinalized(receipt, 'transaction');
    if (request.assertedKind === 'DEPLOYMENT') {
      if (hash !== request.expectedDeploymentHash) {
        fail('HISTORY_PROOF', 'Deployment proof hash does not match the bundled deployment manifest.', 400);
      }
      if (executionResult !== SUCCESS) fail('HISTORY_PROOF', 'Deployment transaction has no successful execution proof.');
      return Object.freeze({
        transactionHash: hash,
        deploymentId: deployment.deploymentId,
        deploymentAlias: deployment.alias,
        epochEndTimestamp: null,
        proofKind: 'DEPLOYMENT',
        method: null,
        arguments: Object.freeze([]),
        senderAddress: exactSender(raw),
        recipientAddress: null,
        parentTransactionHash: null,
        childTransactionHashes: Object.freeze([]),
        valueAtto: null,
        valueCredited: null,
        executionResult,
        proofMetadata: Object.freeze({
          authority: 'GENLAYER_STUDIONET_RPC',
          chainId: 61999,
          independentlyRederivedFromChain: true,
          independentOracle: false,
        }),
      });
    }
    const call = receiptCall(receipt);
    const derivedKind = METHOD_KIND[call.method];
    if (!derivedKind || derivedKind !== request.assertedKind) {
      fail('HISTORY_PROOF', 'Submitted proof kind does not match the finalized decoded chain method.', 400);
    }
    if (executionResult !== SUCCESS) fail('HISTORY_PROOF', 'Finalized contract call has no successful execution proof.');
    const recipientAddress = exactContractRecipient(raw, deployment.address);
    const senderAddress = exactSender(raw);
    const epochEndTimestamp = validateCallArguments(call, deployment);
    const transactionType = rawInteger(singleField(raw, ['type'], 'transaction type'), 'transaction type');
    if (transactionType !== 2n) fail('HISTORY_PROOF', 'Finalized contract call has the wrong transaction type.');
    const valueAtto = rawInteger(singleField(raw, ['value'], 'transaction value'), 'transaction value').toString();
    if ((derivedKind === 'WAGER' && BigInt(valueAtto) === 0n)
      || (derivedKind !== 'WAGER' && BigInt(valueAtto) !== 0n)) {
      fail('HISTORY_PROOF', 'Finalized contract call value does not match its method.');
    }
    let child = null;
    if (derivedKind === 'CLAIM') {
      child = await verifyClaimChild({
        rawParent: raw,
        parentHash: hash,
        contractAddress: deployment.address,
        epochEndTimestamp,
        until,
      });
    }
    return Object.freeze({
      transactionHash: hash,
      deploymentId: deployment.deploymentId,
      deploymentAlias: deployment.alias,
      epochEndTimestamp,
      proofKind: derivedKind,
      method: call.method,
      arguments: call.args,
      senderAddress,
      recipientAddress,
      parentTransactionHash: null,
      childTransactionHashes: Object.freeze(child ? [child.childHash] : []),
      valueAtto: child?.amountAtto ?? valueAtto,
      valueCredited: child ? true : null,
      executionResult,
      proofMetadata: Object.freeze({
        authority: 'GENLAYER_STUDIONET_RPC',
        chainId: 61999,
        independentlyRederivedFromChain: true,
        independentOracle: false,
        ...(child ? {
          payoutRecipient: child.recipient,
          payoutChildHash: child.childHash,
          payoutChildFinalizedAndCredited: true,
        } : {}),
      }),
    });
  }

  return Object.freeze({
    configuration,
    readDeployment,
    verifyProof,
  });
}
