import { createHash, timingSafeEqual } from 'node:crypto';

import { loadLiquidityArenaDeploymentConfig } from '../server/deployment-config.mjs';
import { HistoryError } from './errors.mjs';

export const HISTORY_MAX_PUBLIC_PAGE = 50;
export const HISTORY_MAX_SYNC_EPOCHS = 10;
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

function historyDeployment({ alias, address, protocolVersion, policyVersion, active }) {
  const canonicalAddress = String(address || '').trim();
  const addressKey = canonicalAddress.toLowerCase();
  return Object.freeze({
    alias,
    // StudioNet's contract lookup currently requires the configured address
    // casing, so this value is the RPC address and must not be normalized.
    address: canonicalAddress,
    // Persistence and allowlist identity remain case-insensitive and stable.
    addressKey,
    deploymentId: `studionet:${addressKey}`,
    protocolVersion,
    policyVersion,
    active,
  });
}

export function loadHistoryChainConfiguration(environment = process.env) {
  const deployment = loadLiquidityArenaDeploymentConfig(environment);
  const deployments = [];
  if (deployment.v6ContractAddress) {
    deployments.push(historyDeployment({
      alias: 'v6',
      address: deployment.v6ContractAddress,
      protocolVersion: 'LIQUIDITY_ARENA_V6',
      policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
      active: deployment.activeDeployment === 'v6',
    }));
  }
  for (const legacyAddress of deployment.legacyV6Contracts || []) {
    const addressKey = legacyAddress.toLowerCase();
    if (deployments.some((item) => item.addressKey === addressKey)) continue;
    deployments.push(historyDeployment({
      alias: 'v6',
      address: legacyAddress,
      protocolVersion: 'LIQUIDITY_ARENA_V6',
      policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
      active: false,
    }));
  }
  if (deployment.v7ContractAddress) {
    deployments.push(historyDeployment({
      alias: 'v7',
      address: deployment.v7ContractAddress,
      protocolVersion: 'LIQUIDITY_ARENA_V7',
      policyVersion: 'CRYPTO_SPOT_1M_MEDIAN_V1',
      active: deployment.activeDeployment === 'v7',
    }));
  }
  if (deployments.length === 0 || deployments.length > 10) {
    throw new HistoryError('HISTORY_CHAIN_CONFIG', 'History has no allowlisted deployment.', {
      statusCode: 503,
    });
  }
  return Object.freeze({
    network: 'studionet',
    chainId: 61999,
    rpcUrl: deployment.genLayerRpcUrl,
    deployments: Object.freeze(deployments),
  });
}
