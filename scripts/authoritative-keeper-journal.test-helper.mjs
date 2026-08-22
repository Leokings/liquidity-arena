import {
  canonicalKeeperOperation,
  keeperAttemptOperationId,
} from '../keeper-journal/schema.mjs';

const NONTERMINAL = new Set([
  'PREPARED', 'SUBMITTED', 'FINALIZED_SUCCESS', 'QUARANTINED', 'STATE_SATISFIED_UNPROVEN',
]);

function publicOperation(operation) {
  return structuredClone(operation);
}

export function createMemoryAuthoritativeKeeperJournalClient({ hooks = {} } = {}) {
  const operations = new Map();
  const calls = [];
  let fencingToken = 0;
  let activeLease = null;
  let timestampIndex = 0;
  const timestamp = () => new Date(Date.UTC(2027, 0, 1, 0, 0, timestampIndex++)).toISOString();

  function assertLease(lease) {
    if (!activeLease || lease?.holderId !== activeLease.holderId
        || lease?.signerAddress !== activeLease.signerAddress
        || String(lease?.fencingToken) !== activeLease.fencingToken) {
      throw new Error('fake keeper lease rejected');
    }
  }

  function responseOperation(operation) {
    return { operation: publicOperation(operation) };
  }

  function attemptsFor(logicalOperationId) {
    return [...operations.values()]
      .filter((operation) => operation.logicalOperationId === logicalOperationId)
      .sort((left, right) => {
        const leftAttempt = BigInt(left.attemptNumber);
        const rightAttempt = BigInt(right.attemptNumber);
        if (leftAttempt === rightAttempt) return 0;
        return leftAttempt < rightAttempt ? 1 : -1;
      });
  }

  function newPreparedOperation(canonical, attemptNumber, retryOfOperationId) {
    const now = timestamp();
    return {
      operationId: keeperAttemptOperationId(canonical.operationId, attemptNumber),
      logicalOperationId: canonical.operationId,
      attemptNumber,
      retryOfOperationId,
      deploymentAlias: canonical.deploymentAlias,
      network: canonical.network,
      chainId: canonical.chainId,
      signerAddress: activeLease.signerAddress,
      contractAddress: canonical.contractAddress,
      subjectType: canonical.subjectType,
      subjectId: canonical.subjectId,
      method: canonical.method,
      args: [...canonical.args],
      valueAtto: canonical.valueAtto,
      state: 'PREPARED',
      transactionHash: null,
      lifecycleStatus: null,
      lifecycleObservedAt: null,
      stateReasonCode: null,
      quarantineReason: null,
      preparedAt: now,
      submittedAt: null,
      finalizedAt: null,
      verifiedAt: null,
      updatedAt: now,
      revision: '1',
      preparedFencingToken: activeLease.fencingToken,
    };
  }

  const client = {
    async health() {
      calls.push({ method: 'health', request: null });
      const override = await hooks.health?.();
      return override || {
        status: 'ready',
        service: 'liquidity-arena-keeper-journal',
        ready: true,
        network: 'bradbury',
        chainId: '4221',
        configuration: {
          databaseConfigured: true,
          authenticationConfigured: true,
          signerConfigured: true,
        },
        database: { configured: true, ready: true, schemaVersion: 5 },
      };
    },
    async acquireLease(request) {
      calls.push({ method: 'acquireLease', request: structuredClone(request) });
      await hooks.acquireLease?.(request);
      fencingToken += 1;
      activeLease = {
        holderId: request.holderId,
        signerAddress: request.signerAddress.toLowerCase(),
        fencingToken: String(fencingToken),
        expiresAt: timestamp(),
        newlyAcquired: true,
      };
      return { status: 'ok', action: 'LEASE_ACQUIRE', lease: { ...activeLease } };
    },
    async renewLease(request) {
      calls.push({ method: 'renewLease', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.renewLease?.(request);
      activeLease = { ...activeLease, expiresAt: timestamp(), newlyAcquired: false };
      return { status: 'ok', action: 'LEASE_RENEW', lease: { ...activeLease } };
    },
    async releaseLease(request) {
      calls.push({ method: 'releaseLease', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.releaseLease?.(request);
      activeLease = null;
      return { status: 'ok', action: 'LEASE_RELEASE', released: true };
    },
    async recover(request) {
      calls.push({ method: 'recover', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.recover?.(request);
      if (request.cursor !== null) throw new Error('fake journal only needs one recovery page');
      return {
        status: 'ok',
        action: 'RECOVER',
        operations: [...operations.values()]
          .filter((operation) => NONTERMINAL.has(operation.state))
          .map(publicOperation),
        page: { limit: request.limit, nextCursor: null },
      };
    },
    async prepareOperation(request) {
      calls.push({ method: 'prepareOperation', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.prepareOperation?.(request);
      const canonical = canonicalKeeperOperation(request.operation);
      const latest = attemptsFor(canonical.operationId)[0];
      const repeatableVerified = latest?.state === 'VERIFIED'
        && ['retry_prepare_payout', 'retry_payout'].includes(canonical.method);
      if (latest && latest.state !== 'FINALIZED_FAILURE' && !repeatableVerified) {
        return {
          status: 'ok',
          action: 'PREPARE',
          operation: publicOperation(latest),
          canBroadcast: false,
          inserted: false,
        };
      }
      const attemptNumber = latest
        ? (BigInt(latest.attemptNumber) + 1n).toString()
        : '1';
      const operation = newPreparedOperation(
        canonical,
        attemptNumber,
        latest?.operationId || null,
      );
      operations.set(operation.operationId, operation);
      return {
        status: 'ok',
        action: 'PREPARE',
        operation: publicOperation(operation),
        canBroadcast: true,
        inserted: true,
      };
    },
    async bindSubmission(request) {
      calls.push({ method: 'bindSubmission', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.bindSubmission?.(request);
      const operation = operations.get(request.operationId);
      if (!operation || operation.state !== 'PREPARED') throw new Error('fake bind rejected');
      operation.state = 'SUBMITTED';
      operation.transactionHash = request.transactionHash.toLowerCase();
      operation.submittedAt = timestamp();
      operation.updatedAt = operation.submittedAt;
      operation.revision = String(Number(operation.revision) + 1);
      return { status: 'ok', action: 'BIND_SUBMISSION', ...responseOperation(operation) };
    },
    async observeLifecycle(request) {
      calls.push({ method: 'observeLifecycle', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.observeLifecycle?.(request);
      const operation = operations.get(request.operationId);
      if (!operation || operation.state !== 'SUBMITTED') throw new Error('fake observe rejected');
      operation.lifecycleStatus = request.lifecycleStatus;
      operation.lifecycleObservedAt = timestamp();
      operation.updatedAt = operation.lifecycleObservedAt;
      operation.revision = String(Number(operation.revision) + 1);
      return { status: 'ok', action: 'OBSERVE_LIFECYCLE', ...responseOperation(operation) };
    },
    async transition(request) {
      calls.push({ method: 'transition', request: structuredClone(request) });
      assertLease(request.lease);
      await hooks.transition?.(request);
      const operation = operations.get(request.operationId);
      if (!operation) throw new Error('fake transition rejected');
      const sourceState = operation.state;
      if (sourceState === 'QUARANTINED' && request.targetState === 'FINALIZED_SUCCESS') {
        if (operation.quarantineReason !== 'RECEIPT_IDENTITY_AMBIGUOUS'
            || operation.stateReasonCode !== 'RECEIPT_IDENTITY_AMBIGUOUS'
            || operation.lifecycleStatus !== 'FINALIZED'
            || request.metadata?.transactionHash !== operation.transactionHash
            || request.metadata?.lifecycleStatus !== 'FINALIZED'
            || request.metadata?.receiptIdentityVerified !== true
            || request.metadata?.executionVerified !== true) {
          throw new Error('fake generic quarantine revalidation rejected');
        }
      } else if (sourceState === 'QUARANTINED' && request.targetState !== 'QUARANTINED') {
        throw new Error('fake mismatch quarantine is terminal');
      }
      operation.state = request.targetState;
      operation.stateReasonCode = request.reasonCode;
      if (request.targetState === 'QUARANTINED') {
        operation.quarantineReason = request.reasonCode;
      } else if (sourceState === 'QUARANTINED' && request.targetState === 'FINALIZED_SUCCESS') {
        operation.quarantineReason = null;
      }
      operation.updatedAt = timestamp();
      if (['FINALIZED_SUCCESS', 'FINALIZED_FAILURE'].includes(request.targetState)) {
        operation.lifecycleStatus = 'FINALIZED';
        operation.lifecycleObservedAt ||= operation.updatedAt;
        operation.finalizedAt = operation.updatedAt;
      }
      if (request.targetState === 'VERIFIED') operation.verifiedAt = operation.updatedAt;
      operation.revision = String(Number(operation.revision) + 1);
      return { status: 'ok', action: 'TRANSITION', ...responseOperation(operation) };
    },
  };

  function seedOperation({
    signerAddress,
    state = 'SUBMITTED',
    transactionHash,
    lifecycleStatus = null,
    stateReasonCode = null,
    quarantineReason = null,
    attemptNumber = '1',
    ...input
  }) {
    const canonical = canonicalKeeperOperation(input);
    const canonicalAttemptNumber = String(attemptNumber);
    const operationId = keeperAttemptOperationId(canonical.operationId, canonicalAttemptNumber);
    const retryOfOperationId = canonicalAttemptNumber === '1'
      ? null
      : keeperAttemptOperationId(
        canonical.operationId,
        (BigInt(canonicalAttemptNumber) - 1n).toString(),
      );
    const now = timestamp();
    operations.set(operationId, {
      operationId,
      logicalOperationId: canonical.operationId,
      attemptNumber: canonicalAttemptNumber,
      retryOfOperationId,
      deploymentAlias: canonical.deploymentAlias,
      network: canonical.network,
      chainId: canonical.chainId,
      signerAddress: signerAddress.toLowerCase(),
      contractAddress: canonical.contractAddress,
      subjectType: canonical.subjectType,
      subjectId: canonical.subjectId,
      method: canonical.method,
      args: [...canonical.args],
      valueAtto: canonical.valueAtto,
      state,
      transactionHash: transactionHash?.toLowerCase() ?? null,
      lifecycleStatus,
      lifecycleObservedAt: lifecycleStatus ? now : null,
      stateReasonCode,
      quarantineReason,
      preparedAt: now,
      submittedAt: transactionHash ? now : null,
      finalizedAt: ['FINALIZED_SUCCESS', 'FINALIZED_FAILURE'].includes(state) ? now : null,
      verifiedAt: null,
      updatedAt: now,
      revision: '1',
      preparedFencingToken: '0',
    });
    return operationId;
  }

  return { client, calls, operations, seedOperation };
}
