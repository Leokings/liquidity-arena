import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  HISTORY_MAX_PROOFS,
  HISTORY_MAX_PUBLIC_PAGE,
  HISTORY_MAX_SYNC_EPOCHS,
} from './config.mjs';
import { HistoryError } from './errors.mjs';

export const HISTORY_ASSETS = Object.freeze(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
export const HISTORY_VENUES = Object.freeze(['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN']);
export const HISTORY_DEPLOYMENTS = Object.freeze(['v6', 'v7']);
export const HISTORY_PROOF_KINDS = Object.freeze([
  'DEPLOYMENT',
  'CREATE_EPOCH',
  'RESOLVE_EPOCH',
  'ACTIVATE_TIMEOUT_REFUND',
  'WAGER',
  'CLAIM',
  'FEE_WITHDRAWAL',
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DIGEST = /^(?:0x)?[0-9a-fA-F]{64}$/;
const MAX_U256 = (1n << 256n) - 1n;
const DEPLOYMENT_SET = new Set(HISTORY_DEPLOYMENTS);
const PROOF_KIND_SET = new Set(HISTORY_PROOF_KINDS);
const ASSET_SET = new Set(HISTORY_ASSETS);
const SETTLEMENT_MODES = new Set([
  'PENDING',
  'PARIMUTUEL',
  'REFUND_TIE',
  'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE',
  'REFUND_UNDETERMINED',
  'REFUND_TIMEOUT',
]);

function fail(code, message, statusCode = 400) {
  throw new HistoryError(code, message, { statusCode });
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('HISTORY_SCHEMA', `${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label, { required = allowed } = {}) {
  const object = plainObject(value, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) fail('HISTORY_SCHEMA', `${label} contains unsupported field ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail('HISTORY_SCHEMA', `${label}.${key} is required.`);
  }
  return object;
}

function boundedInteger(value, label, { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  let number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    number = Number(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) number = Number(parsed);
  }
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail('HISTORY_SCHEMA', `${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function decimalInteger(value, label, { positive = false, signed = false } = {}) {
  let text;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) text = String(value);
  else text = String(value ?? '').trim();
  const pattern = signed ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(text)) fail('HISTORY_SCHEMA', `${label} must be a decimal integer.`);
  const number = BigInt(text);
  if ((!signed && number < 0n) || (positive && number === 0n) || number > MAX_U256) {
    fail('HISTORY_SCHEMA', `${label} is outside its allowed integer range.`);
  }
  return number.toString();
}

function address(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ADDRESS.test(normalized) || /^0x0{40}$/.test(normalized)) {
    fail('HISTORY_SCHEMA', `${label} must be a non-zero 20-byte address.`);
  }
  return normalized;
}

function optionalAddress(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || /^0x0{40}$/.test(normalized) ? null : address(normalized, label);
}

function deploymentIdentity(deployment) {
  const addressKey = address(deployment?.address, 'deployment contract address');
  const deploymentId = `studionet:${addressKey}`;
  if (deployment?.addressKey !== addressKey || deployment?.deploymentId !== deploymentId) {
    fail(
      'HISTORY_CHAIN_IDENTITY',
      'StudioNet deployment identity does not match its configured RPC address.',
      502,
    );
  }
  return Object.freeze({ addressKey, deploymentId });
}

function transactionHash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH.test(normalized)) fail('HISTORY_SCHEMA', `${label} must be a 32-byte transaction hash.`);
  return normalized;
}

function textEnum(value, allowed, label) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!allowed.has(normalized)) fail('HISTORY_SCHEMA', `${label} has an unsupported value.`);
  return normalized;
}

function canonicalJson(value, depth = 0) {
  if (depth > 20) fail('HISTORY_SCHEMA', 'History JSON exceeds the maximum nesting depth.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('HISTORY_SCHEMA', 'History JSON contains a non-finite number.');
    return Number.isSafeInteger(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail('HISTORY_SCHEMA', 'History JSON array is too large.');
    return value.map((item) => canonicalJson(item, depth + 1));
  }
  const object = plainObject(value, 'history JSON value');
  const keys = Object.keys(object).sort();
  if (keys.length > 100) fail('HISTORY_SCHEMA', 'History JSON object is too large.');
  return Object.fromEntries(keys.map((key) => [key, canonicalJson(object[key], depth + 1)]));
}

function resolutionDigest(value) {
  return bytesToHex(keccak_256(utf8ToBytes(JSON.stringify(canonicalJson(value)))));
}

function base64Cursor(value) {
  return Buffer.from(JSON.stringify({ version: 1, ...value }), 'utf8').toString('base64url');
}

function decodeCursor(value, view) {
  const encoded = String(value || '');
  if (!encoded) return null;
  if (encoded.length > 256 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail('HISTORY_CURSOR', 'History cursor is malformed.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    fail('HISTORY_CURSOR', 'History cursor is malformed.');
  }
  if (view === 'deployments') {
    exactKeys(parsed, ['version', 'view', 'deploymentFilter', 'deploymentId'], 'deployment cursor');
    if (parsed.version !== 1 || parsed.view !== 'deployments' || parsed.deploymentFilter !== null) {
      fail('HISTORY_CURSOR', 'Deployment cursor context is invalid.');
    }
    const deploymentId = String(parsed.deploymentId || '').toLowerCase();
    if (!/^studionet:0x[0-9a-f]{40}$/.test(deploymentId)) fail('HISTORY_CURSOR', 'Deployment cursor is invalid.');
    return Object.freeze({ deploymentId });
  }
  if (view === 'proofs') {
    exactKeys(parsed, ['version', 'view', 'deploymentFilter', 'transactionHash'], 'proof cursor');
    const deploymentFilter = String(parsed.deploymentFilter || '').toLowerCase();
    if (parsed.version !== 1 || parsed.view !== 'proofs' || !DEPLOYMENT_SET.has(deploymentFilter)) {
      fail('HISTORY_CURSOR', 'Proof cursor context is invalid.');
    }
    const hash = String(parsed.transactionHash || '').toLowerCase();
    if (!HASH.test(hash)) fail('HISTORY_CURSOR', 'Proof cursor transaction hash is invalid.');
    return Object.freeze({ transactionHash: hash, deploymentFilter });
  }
  exactKeys(parsed, ['version', 'view', 'deploymentFilter', 'epochEndTimestamp', 'deploymentId'], 'epoch cursor');
  if (parsed.version !== 1 || parsed.view !== 'epochs') fail('HISTORY_CURSOR', 'Epoch cursor context is invalid.');
  const epochEndTimestamp = decimalInteger(parsed.epochEndTimestamp, 'cursor epoch', { positive: true });
  const deploymentFilter = parsed.deploymentFilter === null ? null : String(parsed.deploymentFilter || '').toLowerCase();
  if (deploymentFilter !== null && !DEPLOYMENT_SET.has(deploymentFilter)) fail('HISTORY_CURSOR', 'Epoch cursor filter is invalid.');
  const deploymentId = String(parsed.deploymentId || '').toLowerCase();
  if (!/^studionet:0x[0-9a-f]{40}$/.test(deploymentId)) fail('HISTORY_CURSOR', 'Epoch cursor deployment is invalid.');
  return Object.freeze({ epochEndTimestamp, deploymentId, deploymentFilter });
}

export function encodeHistoryCursor(value, view = 'epochs', deploymentFilter = null) {
  if (!value) return null;
  if (view === 'deployments') {
    return base64Cursor({ view, deploymentFilter: null, deploymentId: value.deploymentId });
  }
  if (view === 'proofs') {
    return base64Cursor({ view, deploymentFilter, transactionHash: value.transactionHash });
  }
  return base64Cursor({
    epochEndTimestamp: String(value.epochEndTimestamp),
    view,
    deploymentFilter,
    deploymentId: value.deploymentId,
  });
}

export function parsePublicHistoryQuery(requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl || '/api/history'), 'http://localhost');
  const allowed = new Set(['view', 'deployment', 'limit', 'cursor']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      fail('HISTORY_QUERY', 'History query contains an unsupported or repeated parameter.');
    }
  }
  const view = String(url.searchParams.get('view') || 'epochs').toLowerCase();
  if (!['epochs', 'deployments', 'proofs'].includes(view)) {
    fail('HISTORY_QUERY', 'History view must be epochs, deployments, or proofs.');
  }
  const rawDeployment = String(url.searchParams.get('deployment') || '').toLowerCase();
  const deployment = rawDeployment || null;
  if (deployment && !DEPLOYMENT_SET.has(deployment)) fail('HISTORY_QUERY', 'History deployment must be v6 or v7.');
  if (view === 'deployments' && deployment) fail('HISTORY_QUERY', 'Deployment history does not accept a deployment filter.');
  if (view === 'proofs' && !deployment) fail('HISTORY_QUERY', 'Proof history requires a deployment filter.');
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null
    ? 20
    : boundedInteger(rawLimit, 'history limit', { minimum: 1, maximum: HISTORY_MAX_PUBLIC_PAGE });
  const cursor = decodeCursor(url.searchParams.get('cursor'), view);
  if (cursor && view !== 'deployments' && cursor.deploymentFilter !== deployment) {
    fail('HISTORY_CURSOR', 'History cursor does not match the deployment filter.');
  }
  return Object.freeze({ view, deployment, limit, cursor });
}

function normalizedProofRequest(value, index) {
  const object = exactKeys(value, ['deployment', 'hash', 'kind'], `proofs[${index}]`);
  const deployment = String(object.deployment || '').toLowerCase();
  if (!DEPLOYMENT_SET.has(deployment)) fail('HISTORY_SCHEMA', `proofs[${index}].deployment must be v6 or v7.`);
  const kind = String(object.kind || '').toUpperCase();
  if (!PROOF_KIND_SET.has(kind)) fail('HISTORY_SCHEMA', `proofs[${index}].kind is unsupported.`);
  return Object.freeze({ deployment, hash: transactionHash(object.hash, `proofs[${index}].hash`), kind });
}

export function parseHistorySyncBody(value) {
  const object = exactKeys(
    value ?? {},
    ['deployments', 'startOffset', 'maxEpochs', 'proofs', 'includeKnownProofs'],
    'history sync request',
    { required: [] },
  );
  let deployments = object.deployments ?? null;
  if (deployments !== null) {
    if (!Array.isArray(deployments) || deployments.length < 1 || deployments.length > 2) {
      fail('HISTORY_SCHEMA', 'deployments must contain one or two aliases.');
    }
    deployments = deployments.map((valueAtIndex, index) => {
      const alias = String(valueAtIndex || '').toLowerCase();
      if (!DEPLOYMENT_SET.has(alias)) fail('HISTORY_SCHEMA', `deployments[${index}] must be v6 or v7.`);
      return alias;
    });
    if (new Set(deployments).size !== deployments.length) fail('HISTORY_SCHEMA', 'deployments must not contain duplicates.');
    deployments.sort();
  }
  const startOffset = object.startOffset === undefined
    ? null
    : boundedInteger(object.startOffset, 'startOffset', { minimum: 0, maximum: 1_000_000 });
  const maxEpochs = object.maxEpochs === undefined
    ? HISTORY_MAX_SYNC_EPOCHS
    : boundedInteger(object.maxEpochs, 'maxEpochs', { minimum: 1, maximum: HISTORY_MAX_SYNC_EPOCHS });
  if (object.proofs !== undefined && !Array.isArray(object.proofs)) fail('HISTORY_SCHEMA', 'proofs must be an array.');
  const proofs = (object.proofs || []).map(normalizedProofRequest);
  if (proofs.length > HISTORY_MAX_PROOFS) fail('HISTORY_SCHEMA', `At most ${HISTORY_MAX_PROOFS} proofs may be requested.`);
  const proofKeys = proofs.map((item) => `${item.deployment}:${item.hash}`);
  if (new Set(proofKeys).size !== proofKeys.length) fail('HISTORY_SCHEMA', 'proofs must not contain duplicate hashes per deployment.');
  proofs.sort((left, right) => `${left.deployment}:${left.hash}`.localeCompare(`${right.deployment}:${right.hash}`));
  const includeKnownProofs = object.includeKnownProofs === undefined ? true : object.includeKnownProofs;
  if (typeof includeKnownProofs !== 'boolean') fail('HISTORY_SCHEMA', 'includeKnownProofs must be boolean.');
  return Object.freeze({
    deployments: deployments ? Object.freeze(deployments) : null,
    startOffset,
    maxEpochs,
    proofs: Object.freeze(proofs),
    includeKnownProofs,
  });
}

export function canonicalSyncRequestHash(request) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(request)), 'utf8').digest('hex');
}

export function normalizedIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    fail('HISTORY_IDEMPOTENCY', 'Idempotency-Key must be 8-128 URL-safe ASCII characters.');
  }
  return key;
}

function normalizedCatalog(catalog) {
  const root = exactKeys(catalog, ['assets'], 'asset catalog');
  if (!Array.isArray(root.assets) || root.assets.length !== HISTORY_ASSETS.length) {
    fail('HISTORY_CHAIN_SCHEMA', 'StudioNet asset catalog must contain the fixed five-asset basket.', 502);
  }
  const assets = root.assets.map((raw, index) => {
    const item = exactKeys(raw, ['asset_id', 'label', 'quote_asset'], `asset catalog[${index}]`);
    if (String(item.asset_id) !== HISTORY_ASSETS[index] || String(item.quote_asset) !== 'USDT') {
      fail('HISTORY_CHAIN_SCHEMA', 'StudioNet asset catalog order or quote asset is invalid.', 502);
    }
    const label = String(item.label || '').trim();
    if (!label || label.length > 80) fail('HISTORY_CHAIN_SCHEMA', 'StudioNet asset label is invalid.', 502);
    return Object.freeze({ asset_id: HISTORY_ASSETS[index], label, quote_asset: 'USDT' });
  });
  return Object.freeze({ assets: Object.freeze(assets) });
}

function normalizedVenueCatalog(catalog) {
  const root = exactKeys(
    catalog,
    ['venues', 'adapters_immutable', 'candle_interval', 'start_price_rule', 'end_price_rule'],
    'venue catalog',
  );
  if (!Array.isArray(root.venues) || root.venues.length !== HISTORY_VENUES.length
    || root.venues.some((venue, index) => String(venue) !== HISTORY_VENUES[index])) {
    fail('HISTORY_CHAIN_SCHEMA', 'StudioNet venue catalog is not the fixed five-venue allowlist.', 502);
  }
  if (root.adapters_immutable !== true || root.candle_interval !== '1m'
    || root.start_price_rule !== 'OPEN_AT_E_MINUS_20_MINUTES'
    || root.end_price_rule !== 'CLOSE_AT_E_MINUS_1_MINUTE') {
    fail('HISTORY_CHAIN_SCHEMA', 'StudioNet venue policy metadata is invalid.', 502);
  }
  return Object.freeze(canonicalJson(root));
}

export function normalizeDeploymentState({ deployment, config, assetCatalog, venueCatalog, epochCount, manifest }) {
  const identity = deploymentIdentity(deployment);
  const protocol = String(config?.protocol_version || '').trim().toUpperCase();
  if (protocol !== deployment.protocolVersion || config?.policy_version !== deployment.policyVersion) {
    fail('HISTORY_CHAIN_IDENTITY', `StudioNet ${deployment.alias} contract identity does not match its allowlist.`, 502);
  }
  const owner = address(config.owner, 'contract owner');
  const treasury = address(config.treasury, 'contract treasury');
  const keeper = deployment.alias === 'v7' ? address(config.keeper, 'contract keeper') : null;
  if (config.native_token_symbol !== 'GEN' || boundedInteger(config.native_token_decimals, 'token decimals') !== 18
    || config.transfer_finality !== 'FINALIZED') {
    fail('HISTORY_CHAIN_SCHEMA', 'StudioNet contract payment policy is invalid.', 502);
  }
  const count = boundedInteger(epochCount, 'epoch count', { minimum: 0, maximum: 1_000_000 });
  const normalizedAssets = normalizedCatalog(assetCatalog);
  const normalizedVenues = normalizedVenueCatalog(venueCatalog);
  return Object.freeze({
    alias: deployment.alias,
    network: 'studionet',
    chainId: 61999,
    contractAddress: identity.addressKey,
    protocolVersion: protocol,
    policyVersion: deployment.policyVersion,
    owner,
    keeper,
    treasury,
    active: deployment.active === true,
    epochCount: count,
    deploymentId: identity.deploymentId,
    deploymentTransactionHash: manifest?.deploymentTransactionHash || null,
    sourceMetadata: canonicalJson(manifest?.sourceMetadata || {}),
    contractConfig: canonicalJson(config),
    assetCatalog: normalizedAssets,
    venueCatalog: normalizedVenues,
  });
}

function objectiveState(raw, expectedObjective, epochEndTimestamp) {
  const keys = [
    'epoch_id', 'objective', 'settlement_mode', 'winner_asset_id', 'winner_return_ppb',
    'payout_pool_atto', 'winning_stake_atto', 'losing_stake_atto', 'platform_fee_atto',
    'total_stake_atto', 'participant_count', 'paid_atto', 'remaining_payout_atto',
    'unclaimed_winning_stake_atto',
  ];
  const item = exactKeys(raw, keys, `${expectedObjective} objective`);
  if (String(item.epoch_id) !== String(epochEndTimestamp) || item.objective !== expectedObjective) {
    fail('HISTORY_CHAIN_SCHEMA', `${expectedObjective} objective targets the wrong epoch.`, 502);
  }
  const settlementMode = textEnum(item.settlement_mode, SETTLEMENT_MODES, `${expectedObjective} settlement mode`);
  const winner = String(item.winner_asset_id || '').toUpperCase();
  if (winner && winner !== 'TIE' && !ASSET_SET.has(winner)) {
    fail('HISTORY_CHAIN_SCHEMA', `${expectedObjective} winner asset is invalid.`, 502);
  }
  const normalized = {
    epoch_id: String(epochEndTimestamp),
    objective: expectedObjective,
    settlement_mode: settlementMode,
    winner_asset_id: winner,
    winner_return_ppb: boundedInteger(item.winner_return_ppb, `${expectedObjective} winner return`),
    payout_pool_atto: decimalInteger(item.payout_pool_atto, `${expectedObjective} payout pool`),
    winning_stake_atto: decimalInteger(item.winning_stake_atto, `${expectedObjective} winning stake`),
    losing_stake_atto: decimalInteger(item.losing_stake_atto, `${expectedObjective} losing stake`),
    platform_fee_atto: decimalInteger(item.platform_fee_atto, `${expectedObjective} platform fee`),
    total_stake_atto: decimalInteger(item.total_stake_atto, `${expectedObjective} total stake`),
    participant_count: boundedInteger(item.participant_count, `${expectedObjective} participant count`, { minimum: 0 }),
    paid_atto: decimalInteger(item.paid_atto, `${expectedObjective} paid amount`),
    remaining_payout_atto: decimalInteger(item.remaining_payout_atto, `${expectedObjective} remaining payout`),
    unclaimed_winning_stake_atto: decimalInteger(
      item.unclaimed_winning_stake_atto,
      `${expectedObjective} unclaimed winning stake`,
    ),
  };
  if (BigInt(normalized.paid_atto) + BigInt(normalized.remaining_payout_atto) !== BigInt(normalized.payout_pool_atto)) {
    fail('HISTORY_CHAIN_SCHEMA', `${expectedObjective} payout accounting is inconsistent.`, 502);
  }
  return Object.freeze(normalized);
}

function winner(vector, direction) {
  const scores = vector.map((item) => item.return_ppb);
  const winningScore = direction === 'HIGH' ? Math.max(...scores) : Math.min(...scores);
  const winners = vector.filter((item) => item.return_ppb === winningScore);
  return Object.freeze({ assetId: winners.length === 1 ? winners[0].asset_id : 'TIE', returnPpb: winningScore });
}

function normalizedAssetVector(rawAssets, venueCount) {
  if (!Array.isArray(rawAssets) || rawAssets.length !== HISTORY_ASSETS.length) {
    fail('HISTORY_CHAIN_SCHEMA', 'Determined epoch does not expose all five asset records.', 502);
  }
  return Object.freeze(rawAssets.map((raw, index) => {
    const item = exactKeys(
      raw,
      ['asset_id', 'label', 'return_ppb', 'venue_returns_ppb', 'high_stake_atto', 'low_stake_atto'],
      `epoch asset[${index}]`,
    );
    const assetId = String(item.asset_id || '').toUpperCase();
    if (assetId !== HISTORY_ASSETS[index]) fail('HISTORY_CHAIN_SCHEMA', 'Epoch asset vector is out of order.', 502);
    if (!Array.isArray(item.venue_returns_ppb) || item.venue_returns_ppb.length !== venueCount) {
      fail('HISTORY_CHAIN_SCHEMA', `${assetId} venue return vector length is invalid.`, 502);
    }
    const venueReturns = item.venue_returns_ppb.map((value, venueIndex) => boundedInteger(
      value,
      `${assetId} venue return[${venueIndex}]`,
    ));
    const sorted = [...venueReturns].sort((left, right) => left - right);
    const median = sorted.length % 2 === 1
      ? sorted[Math.floor(sorted.length / 2)]
      : Math.floor((sorted[(sorted.length / 2) - 1] + sorted[sorted.length / 2]) / 2);
    const returnPpb = boundedInteger(item.return_ppb, `${assetId} return`);
    if (returnPpb !== median) fail('HISTORY_CHAIN_SCHEMA', `${assetId} median return is inconsistent.`, 502);
    return Object.freeze({
      asset_id: assetId,
      label: String(item.label || '').slice(0, 80),
      return_ppb: returnPpb,
      venue_returns_ppb: Object.freeze(venueReturns),
      high_stake_atto: decimalInteger(item.high_stake_atto, `${assetId} high stake`),
      low_stake_atto: decimalInteger(item.low_stake_atto, `${assetId} low stake`),
    });
  }));
}

export function normalizeEpochState({ deployment, epoch, assets = [], syncedAt }) {
  const identity = deploymentIdentity(deployment);
  const epochKeys = [
    'epoch_id', 'epoch_end_timestamp', 'wager_opens_timestamp', 'wager_closes_timestamp',
    'battle_starts_timestamp', 'resolution_available_timestamp', 'timeout_refund_available_timestamp',
    'created_at_timestamp', 'creator', 'status', 'result_status', 'phase', 'policy_version',
    'platform_fee_bps_snapshot', 'min_stake_atto', 'max_stake_per_wallet_atto',
    'qualified_venues', 'venue_count', 'high_winner_asset_id', 'high_winner_return_ppb',
    'low_winner_asset_id', 'low_winner_return_ppb', 'resolved_at_timestamp', 'resolution_digest',
    'platform_fee_accrued_atto', 'high', 'low',
  ];
  const item = exactKeys(epoch, epochKeys, 'epoch state');
  const end = boundedInteger(item.epoch_end_timestamp, 'epoch end', { minimum: 1 });
  if (end % 3600 !== 0 || String(item.epoch_id) !== String(end)) {
    fail('HISTORY_CHAIN_SCHEMA', 'Epoch identifier is not an exact UTC hour.', 502);
  }
  const schedule = {
    wagerOpensTimestamp: boundedInteger(item.wager_opens_timestamp, 'wager opens', { minimum: 1 }),
    wagerClosesTimestamp: boundedInteger(item.wager_closes_timestamp, 'wager closes', { minimum: 1 }),
    battleStartsTimestamp: boundedInteger(item.battle_starts_timestamp, 'battle starts', { minimum: 1 }),
    resolutionAvailableTimestamp: boundedInteger(item.resolution_available_timestamp, 'resolution available', { minimum: 1 }),
    timeoutRefundAvailableTimestamp: boundedInteger(item.timeout_refund_available_timestamp, 'timeout refund available', { minimum: 1 }),
  };
  if (schedule.wagerOpensTimestamp !== end - 2400
    || schedule.wagerClosesTimestamp !== end - 1200
    || schedule.battleStartsTimestamp !== end - 1200
    || schedule.resolutionAvailableTimestamp !== end + 120
    || schedule.timeoutRefundAvailableTimestamp !== end + 86400) {
    fail('HISTORY_CHAIN_SCHEMA', 'Epoch schedule does not match the immutable hourly policy.', 502);
  }
  const createdAtTimestamp = boundedInteger(item.created_at_timestamp, 'created timestamp', { minimum: 1 });
  if (createdAtTimestamp > end - 3600) {
    fail('HISTORY_CHAIN_SCHEMA', 'Epoch creation timestamp violates its minimum one-hour lead.', 502);
  }
  const status = textEnum(item.status, new Set(['OPEN', 'RESOLVED', 'UNDETERMINED', 'TIMED_OUT']), 'epoch status');
  const resultStatus = textEnum(item.result_status, new Set(['PENDING', 'DETERMINED', 'UNDETERMINED', 'TIMEOUT']), 'epoch result status');
  const expectedResultForStatus = {
    OPEN: 'PENDING',
    RESOLVED: 'DETERMINED',
    UNDETERMINED: 'UNDETERMINED',
    TIMED_OUT: 'TIMEOUT',
  }[status];
  if (resultStatus !== expectedResultForStatus) {
    fail('HISTORY_CHAIN_SCHEMA', 'Epoch status and result status are inconsistent.', 502);
  }
  const high = objectiveState(item.high, 'HIGH', end);
  const low = objectiveState(item.low, 'LOW', end);
  const venueCount = boundedInteger(item.venue_count, 'venue count', { minimum: 0, maximum: 5 });
  if (!Array.isArray(item.qualified_venues) || item.qualified_venues.length !== venueCount) {
    fail('HISTORY_CHAIN_SCHEMA', 'Qualified venue count is inconsistent.', 502);
  }
  const qualifiedVenues = item.qualified_venues.map(String);
  let lastVenueIndex = -1;
  for (const venue of qualifiedVenues) {
    const current = HISTORY_VENUES.indexOf(venue);
    if (current <= lastVenueIndex) fail('HISTORY_CHAIN_SCHEMA', 'Qualified venues are duplicated or out of order.', 502);
    lastVenueIndex = current;
  }
  let snapshot = null;
  let expectedDigest = '';
  if (resultStatus === 'DETERMINED') {
    if (status !== 'RESOLVED' || venueCount < 3) fail('HISTORY_CHAIN_SCHEMA', 'Determined epoch final state is inconsistent.', 502);
    const vector = normalizedAssetVector(assets, venueCount);
    const expectedHigh = winner(vector, 'HIGH');
    const expectedLow = winner(vector, 'LOW');
    if (String(item.high_winner_asset_id) !== expectedHigh.assetId
      || boundedInteger(item.high_winner_return_ppb, 'high winner return') !== expectedHigh.returnPpb
      || String(item.low_winner_asset_id) !== expectedLow.assetId
      || boundedInteger(item.low_winner_return_ppb, 'low winner return') !== expectedLow.returnPpb
      || high.winner_asset_id !== expectedHigh.assetId
      || low.winner_asset_id !== expectedLow.assetId) {
      fail('HISTORY_CHAIN_SCHEMA', 'Epoch winners do not match the five-asset return vector.', 502);
    }
    expectedDigest = resolutionDigest({
      policy_version: deployment.policyVersion,
      status: 'DETERMINED',
      epoch_end_timestamp: end,
      qualified_venues: qualifiedVenues,
      venue_count: venueCount,
      assets: vector.map((entry) => ({
        asset_id: entry.asset_id,
        return_ppb: entry.return_ppb,
        venue_returns_ppb: entry.venue_returns_ppb,
      })),
      high_winner_asset_id: expectedHigh.assetId,
      high_winner_return_ppb: expectedHigh.returnPpb,
      low_winner_asset_id: expectedLow.assetId,
      low_winner_return_ppb: expectedLow.returnPpb,
    });
    const digest = String(item.resolution_digest || '').replace(/^0x/, '').toLowerCase();
    if (!DIGEST.test(digest)) fail('HISTORY_CHAIN_SCHEMA', 'Determined epoch resolution digest is invalid.', 502);
    if (digest !== expectedDigest) fail('HISTORY_CHAIN_SCHEMA', 'Determined epoch resolution digest does not match its canonical five-asset vector.', 502);
    snapshot = Object.freeze({
      resultStatus,
      assetVector: vector,
      highWinnerAssetId: expectedHigh.assetId,
      highWinnerReturnPpb: expectedHigh.returnPpb,
      lowWinnerAssetId: expectedLow.assetId,
      lowWinnerReturnPpb: expectedLow.returnPpb,
      qualifiedVenues: Object.freeze(qualifiedVenues),
      resolutionDigest: digest,
      sourceMetadata: Object.freeze({
        authority: 'GENLAYER_STUDIONET_FINALIZED_CONTRACT_STATE',
        policyVersion: deployment.policyVersion,
        syncedAt,
      }),
    });
  } else if (resultStatus === 'UNDETERMINED') {
    expectedDigest = resolutionDigest({
      policy_version: deployment.policyVersion,
      status: 'UNDETERMINED',
      epoch_end_timestamp: end,
      qualified_venues: qualifiedVenues,
      venue_count: venueCount,
      assets: [],
      high_winner_asset_id: '',
      high_winner_return_ppb: 0,
      low_winner_asset_id: '',
      low_winner_return_ppb: 0,
    });
  } else if (resultStatus === 'TIMEOUT') {
    expectedDigest = resolutionDigest({
      epoch_end_timestamp: end,
      policy_version: deployment.policyVersion,
      status: 'TIMEOUT',
    });
  }
  if (assets.length !== 0 && resultStatus !== 'DETERMINED') {
    fail('HISTORY_CHAIN_SCHEMA', 'Non-determined epoch must not be assigned a market vector.', 502);
  }
  const rawDigest = String(item.resolution_digest || '').replace(/^0x/, '').toLowerCase();
  if (rawDigest && !DIGEST.test(rawDigest)) fail('HISTORY_CHAIN_SCHEMA', 'Epoch resolution digest is invalid.', 502);
  if (expectedDigest && rawDigest !== expectedDigest) fail('HISTORY_CHAIN_SCHEMA', 'Epoch resolution digest does not match canonical StudioNet state.', 502);
  const resolvedAtTimestamp = boundedInteger(item.resolved_at_timestamp, 'resolved timestamp', { minimum: 0 });
  if ((status === 'OPEN' && (resolvedAtTimestamp !== 0 || rawDigest))
    || (status !== 'OPEN' && (resolvedAtTimestamp === 0 || !rawDigest))) {
    fail('HISTORY_CHAIN_SCHEMA', 'Epoch terminal timestamp or digest is inconsistent with its status.', 502);
  }
  if ((['RESOLVED', 'UNDETERMINED'].includes(status)
      && (resolvedAtTimestamp < schedule.resolutionAvailableTimestamp
        || resolvedAtTimestamp >= schedule.timeoutRefundAvailableTimestamp))
    || (status === 'TIMED_OUT' && resolvedAtTimestamp < schedule.timeoutRefundAvailableTimestamp)) {
    fail('HISTORY_CHAIN_SCHEMA', 'Epoch terminal timestamp is outside its permitted settlement window.', 502);
  }
  return Object.freeze({
    deploymentAlias: deployment.alias,
    deploymentId: identity.deploymentId,
    contractAddress: identity.addressKey,
    epochEndTimestamp: String(end),
    policyVersion: deployment.policyVersion,
    status,
    resultStatus,
    phase: String(item.phase || '').slice(0, 40),
    ...schedule,
    createdAtTimestamp: String(createdAtTimestamp),
    resolvedAtTimestamp: resolvedAtTimestamp || null,
    creatorAddress: optionalAddress(item.creator, 'epoch creator'),
    resolutionDigest: rawDigest || null,
    qualifiedVenues: Object.freeze(qualifiedVenues),
    venueCount,
    platformFeeBps: boundedInteger(item.platform_fee_bps_snapshot, 'platform fee bps', { minimum: 0, maximum: 10_000 }),
    platformFeeAccruedAtto: decimalInteger(item.platform_fee_accrued_atto, 'platform fee accrued'),
    minimumStakeAtto: decimalInteger(item.min_stake_atto, 'minimum stake', { positive: true }),
    maximumStakePerWalletAtto: decimalInteger(item.max_stake_per_wallet_atto, 'maximum wallet stake', { positive: true }),
    highObjective: high,
    lowObjective: low,
    sourceMetadata: Object.freeze({
      authority: 'GENLAYER_STUDIONET_CONTRACT_STATE',
      contractAddress: identity.addressKey,
      protocolVersion: deployment.protocolVersion,
      policyVersion: deployment.policyVersion,
    }),
    finalityMetadata: Object.freeze({
      chainId: 61999,
      network: 'studionet',
      stateReadAt: syncedAt,
      settlementTransfersTriggerOn: 'FINALIZED',
    }),
    snapshot,
  });
}

export { canonicalJson, transactionHash };
