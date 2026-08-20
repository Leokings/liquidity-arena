import {
  keeperJournalConfigurationStatus,
  requireKeeperJournalSignerAddress,
} from './config.mjs';
import { KeeperJournalError } from './errors.mjs';
import {
  encodeRecoveryCursor,
  idempotencyKeyHash,
  requestFingerprint,
} from './schema.mjs';

function assertExpectedSigner(request, expectedSigner) {
  if (request.signerAddress !== expectedSigner) {
    throw new KeeperJournalError(
      'KEEPER_JOURNAL_SIGNER_MISMATCH',
      'Keeper journal request does not match the configured signer.',
      { statusCode: 409 },
    );
  }
}

export function createKeeperJournalService({
  repository,
  environment = process.env,
} = {}) {
  if (!repository) throw new TypeError('Keeper journal repository is required.');

  async function health() {
    const configuration = keeperJournalConfigurationStatus(environment);
    let database = Object.freeze({
      configured: configuration.databaseConfigured,
      ready: false,
      schemaVersion: null,
    });
    if (configuration.databaseConfigured) {
      try {
        database = await repository.health();
      } catch {}
    }
    const ready = configuration.databaseConfigured
      && configuration.authenticationConfigured
      && configuration.signerConfigured
      && database.ready === true;
    return Object.freeze({
      status: ready ? 'ready' : 'degraded',
      service: 'liquidity-arena-keeper-journal',
      ready,
      network: 'studionet',
      chainId: '61999',
      configuration,
      database,
    });
  }

  return Object.freeze({
    async execute({ request, idempotencyKey = null }) {
      if (request.action === 'HEALTH') return health();

      const expectedSigner = requireKeeperJournalSignerAddress(environment);
      assertExpectedSigner(request, expectedSigner);
      if (!idempotencyKey) {
        throw new KeeperJournalError(
          'KEEPER_JOURNAL_IDEMPOTENCY_KEY',
          'Idempotency-Key is required.',
          { statusCode: 400 },
        );
      }
      await repository.claimRequest({
        keyHash: idempotencyKeyHash(idempotencyKey),
        requestHash: requestFingerprint(request),
        action: request.action,
      });

      if (request.action === 'LEASE_ACQUIRE') {
        return Object.freeze({
          status: 'ok',
          action: request.action,
          lease: await repository.acquireLease(request),
        });
      }
      if (request.action === 'LEASE_RENEW') {
        return Object.freeze({
          status: 'ok',
          action: request.action,
          lease: await repository.renewLease(request),
        });
      }
      if (request.action === 'LEASE_RELEASE') {
        return Object.freeze({
          status: 'ok',
          action: request.action,
          ...(await repository.releaseLease(request)),
        });
      }
      if (request.action === 'PREPARE') {
        const prepared = await repository.prepare(request);
        return Object.freeze({
          status: 'ok',
          action: request.action,
          operation: prepared.operation,
          canBroadcast: prepared.canBroadcast === true,
          inserted: prepared.inserted === true,
        });
      }
      if (request.action === 'BIND_SUBMISSION') {
        return Object.freeze({
          status: 'ok',
          action: request.action,
          operation: await repository.bindSubmission(request),
        });
      }
      if (request.action === 'OBSERVE_LIFECYCLE') {
        return Object.freeze({
          status: 'ok',
          action: request.action,
          operation: await repository.observeLifecycle(request),
          receiptIdentityVerified: false,
        });
      }
      if (request.action === 'TRANSITION') {
        return Object.freeze({
          status: 'ok',
          action: request.action,
          operation: await repository.transition(request),
        });
      }
      if (request.action === 'RECOVER') {
        const rows = await repository.recover(request);
        const hasMore = rows.length > request.limit;
        const operations = rows.slice(0, request.limit);
        return Object.freeze({
          status: 'ok',
          action: request.action,
          operations: Object.freeze(operations),
          page: Object.freeze({
            limit: request.limit,
            nextCursor: hasMore && operations.length > 0
              ? encodeRecoveryCursor(operations.at(-1))
              : null,
          }),
        });
      }
      throw new KeeperJournalError(
        'KEEPER_JOURNAL_SCHEMA',
        'Unknown keeper journal action.',
        { statusCode: 400 },
      );
    },
  });
}
