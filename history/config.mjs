import { createHash, timingSafeEqual } from 'node:crypto';

import { loadLiquidityArenaDeploymentConfig } from '../server/deployment-config.mjs';
import { HistoryError } from './errors.mjs';

export const HISTORY_MAX_PUBLIC_PAGE = 50;
export const HISTORY_MAX_SYNC_EPOCHS = 10;
export const HISTORY_MAX_SYNC_PAYOUTS = 25;
export const HISTORY_MAX_PROOFS = 25;
export const HISTORY_MAX_REQUEST_BYTES = 16 * 1024;
export const HISTORY_SYNC_RATE_LIMIT = 8;
export const HISTORY_SYNC_RATE_WINDOW_MS = 60_000;

function environmentSecret(environment, name) {
  return String(environment?.[name] || '').trim();
}

export function historyConfigurationStatus(environment = process.env) {
  let chainConfigured = true;
  try {
    loadLiquidityArenaDeploymentConfig(environment);
  } catch {
    chainConfigured = false;
  }
  const secret = environmentSecret(environment, 'HISTORY_INGEST_SECRET');
  const rawDatabaseUrl = environmentSecret(environment, 'DATABASE_URL');
  let databaseConfigured = false;
  try {
    const parsed = new URL(rawDatabaseUrl);
    databaseConfigured = ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && !parsed.hash;
  } catch {
    databaseConfigured = false;
  }
  return Object.freeze({
    databaseConfigured,
    ingestConfigured: secret.length >= 32 && secret.length <= 1024,
    chainConfigured,
  });
}

export function requireHistoryIngestSecret(environment = process.env) {
  const secret = environmentSecret(environment, 'HISTORY_INGEST_SECRET');
  if (secret.length < 32 || secret.length > 1024) {
    throw new HistoryError(
      'HISTORY_INGEST_UNCONFIGURED',
      'History ingestion is not configured.',
      { statusCode: 503 },
    );
  }
  return secret;
}

function secretDigest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function authorizedHistoryIngest(authorization, expectedSecret) {
  const match = /^Bearer ([^\r\n]+)$/.exec(String(authorization || ''));
  if (!match) return false;
  return timingSafeEqual(secretDigest(match[1]), secretDigest(expectedSecret));
}

export function loadHistoryChainConfiguration(environment = process.env) {
  const config = loadLiquidityArenaDeploymentConfig(environment);
  const address = config.v8ContractAddress;
  const addressKey = address.toLowerCase();
  const deployment = Object.freeze({
    alias: 'v8',
    address,
    addressKey,
    deploymentId: `testnet-bradbury:${addressKey}`,
    protocolVersion: 'LIQUIDITY_ARENA_V8',
    policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
    payoutProtocolVersion: 'IDEMPOTENT_EVM_VAULT_V1',
    expectations: config.v8Expectations,
    active: true,
  });
  return Object.freeze({
    network: 'testnet-bradbury',
    keeperNetwork: 'bradbury',
    chainId: 4_221,
    rpcUrl: config.genLayerRpcUrl,
    deployments: Object.freeze([deployment]),
  });
}
