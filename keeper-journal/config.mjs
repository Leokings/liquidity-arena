import { createHash, timingSafeEqual } from 'node:crypto';

import { KeeperJournalError } from './errors.mjs';

export const KEEPER_JOURNAL_CHAIN_ID = '4221';
export const KEEPER_JOURNAL_NETWORK = 'bradbury';
export const KEEPER_JOURNAL_MAX_BODY_BYTES = 16 * 1024;
export const KEEPER_JOURNAL_MAX_PAGE = 50;
export const KEEPER_JOURNAL_MIN_LEASE_SECONDS = 60;
export const KEEPER_JOURNAL_MAX_LEASE_SECONDS = 900;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function environmentValue(environment, name) {
  return String(environment?.[name] || '');
}

export function keeperJournalDatabaseUrl(environment = process.env) {
  const value = environmentValue(environment, 'DATABASE_URL').trim();
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) {
      return '';
    }
    return value;
  } catch {
    return '';
  }
}

export function requireKeeperJournalSecret(environment = process.env) {
  const value = environmentValue(environment, 'KEEPER_JOURNAL_SECRET');
  const historySecret = environmentValue(environment, 'HISTORY_INGEST_SECRET');
  if (value !== value.trim() || value.length < 32 || value.length > 1024 || /[\r\n]/.test(value)
      || (historySecret.length > 0 && value === historySecret)) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_UNCONFIGURED',
      'Keeper transaction journal authentication is not configured.',
      { statusCode: 503 },
    );
  }
  return value;
}

export function requireKeeperJournalSignerAddress(environment = process.env) {
  const value = environmentValue(environment, 'KEEPER_JOURNAL_SIGNER_ADDRESS').trim().toLowerCase();
  if (!ADDRESS.test(value) || value === ZERO_ADDRESS) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_UNCONFIGURED',
      'Keeper transaction journal signer is not configured.',
      { statusCode: 503 },
    );
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function authorizedKeeperJournal(authorization, expectedSecret) {
  const match = /^Bearer ([^\r\n]+)$/.exec(String(authorization || ''));
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(expectedSecret));
}

export function keeperJournalConfigurationStatus(environment = process.env) {
  let authenticationConfigured = false;
  let signerConfigured = false;
  try {
    requireKeeperJournalSecret(environment);
    authenticationConfigured = true;
  } catch {}
  try {
    requireKeeperJournalSignerAddress(environment);
    signerConfigured = true;
  } catch {}
  return Object.freeze({
    databaseConfigured: Boolean(keeperJournalDatabaseUrl(environment)),
    authenticationConfigured,
    signerConfigured,
  });
}
