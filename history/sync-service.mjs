import { createHash } from 'node:crypto';

import { deploymentManifest } from './deployment-manifest.mjs';
import { HistoryError } from './errors.mjs';
import {
  canonicalSyncRequestHash,
  normalizeDeploymentState,
  normalizeEpochState,
} from './schema.mjs';

const SYNC_LEASE_SECONDS = 120;
const SYNC_DEADLINE_MS = 90_000;

function keyHash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fail(code, message, statusCode) {
  throw new HistoryError(code, message, { statusCode });
}

function proofTargetForAlias(deployments, alias) {
  const matches = deployments.filter((item) => item.alias === alias);
  const manifested = matches.find((item) => deploymentManifest(item).sourceMetadata.artifactMatched === true);
  return manifested || matches.find((item) => item.active) || matches[0] || null;
}

function selectedDeployments(configuration, requestedAliases) {
  const aliases = requestedAliases || [...new Set(configuration.deployments.map((item) => item.alias))];
  for (const alias of aliases) {
    if (!configuration.deployments.some((item) => item.alias === alias)) {
      fail('HISTORY_DEPLOYMENT_ALLOWLIST', `Deployment ${alias} is not configured on StudioNet.`, 400);
    }
  }
  return configuration.deployments.filter((item) => aliases.includes(item.alias));
}

function uniqueProofRequests(request, deployments) {
  const selectedAliases = new Set(deployments.map((item) => item.alias));
  const result = [];
  for (const proof of request.proofs) {
    if (!selectedAliases.has(proof.deployment)) {
      fail('HISTORY_PROOF_SCOPE', 'Proof deployment must also be selected for state synchronization.', 400);
    }
    result.push(Object.freeze({ ...proof, source: 'request' }));
  }
  if (request.includeKnownProofs) {
    for (const deployment of deployments) {
      const manifest = deploymentManifest(deployment);
      for (const proof of manifest.knownProofs) {
        result.push(Object.freeze({ ...proof, source: 'manifest' }));
      }
    }
  }
  const deduped = new Map();
  for (const item of result) {
    const key = `${item.deployment}:${item.hash}`;
    const previous = deduped.get(key);
    if (previous && previous.kind !== item.kind) {
      fail('HISTORY_PROOF_CONFLICT', 'The same proof hash has conflicting asserted kinds.', 400);
    }
    if (!previous || item.source === 'request') deduped.set(key, item);
  }
  const requested = [...deduped.values()].filter((item) => item.source === 'request');
  const known = [...deduped.values()].filter((item) => item.source !== 'request');
  return Object.freeze([...requested, ...known.slice(0, Math.max(0, 25 - requested.length))]);
}

async function beforeDeadline(promise, deadline, now) {
  const remaining = deadline - now();
  if (remaining <= 0) fail('HISTORY_SYNC_DEADLINE', 'History sync exceeded its whole-request deadline.', 504);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HistoryError(
          'HISTORY_SYNC_DEADLINE',
          'History sync exceeded its whole-request deadline.',
          { statusCode: 504 },
        )), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHistorySyncService({ repository, chain, now = Date.now } = {}) {
  if (!repository || !chain) throw new TypeError('History repository and StudioNet chain are required.');

  return Object.freeze({
    async sync({ request, idempotencyKey }) {
      if (repository.configured === false) {
        fail('HISTORY_UNCONFIGURED', 'Durable history is not configured.', 503);
      }
      const requestHash = canonicalSyncRequestHash(request);
      const hashedKey = keyHash(idempotencyKey);
      const deployments = selectedDeployments(chain.configuration, request.deployments);
      const claim = await repository.claimRun({
        keyHash: hashedKey,
        requestHash,
        deployments: [...new Set(deployments.map((item) => item.alias))],
        leaseSeconds: SYNC_LEASE_SECONDS,
      });
      if (claim.state === 'REPLAY') {
        return Object.freeze({ ...claim.summary, replayed: true });
      }
      if (claim.state === 'CONFLICT') {
        fail('HISTORY_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different request.', 409);
      }
      if (claim.state === 'BUSY' || claim.state === 'RUNNING') {
        fail('HISTORY_SYNC_BUSY', 'Another bounded history sync is already running.', 409);
      }
      const startedAt = now();
      const deadline = startedAt + SYNC_DEADLINE_MS;
      const syncedAt = new Date(startedAt).toISOString();
      const summary = {
        status: 'ok',
        dataScope: 'HOURLY_CONTRACT_EPOCHS',
        continuousVisualizationTicksStored: false,
        network: 'studionet',
        chainId: 61999,
        deploymentsSynced: 0,
        epochsSynced: 0,
        snapshotsSynced: 0,
        proofsVerified: 0,
        proofsAlreadyVerified: 0,
        manifestProofsSkipped: 0,
        requestedProofsRejected: 0,
        syncedAt,
      };
      try {
        let remainingEpochBudget = request.maxEpochs;
        for (let index = 0; index < deployments.length; index += 1) {
          if (now() >= deadline) fail('HISTORY_SYNC_DEADLINE', 'History sync exceeded its whole-request deadline.', 504);
          const deploymentsRemaining = deployments.length - index;
          const allocation = remainingEpochBudget > 0
            ? Math.max(1, Math.ceil(remainingEpochBudget / deploymentsRemaining))
            : 0;
          const deployment = deployments[index];
          const manifest = deploymentManifest(deployment);
          const raw = await beforeDeadline(
            chain.readDeployment(deployment.deploymentId, {
              maxEpochs: allocation,
              startOffset: request.startOffset,
            }),
            deadline,
            now,
          );
          const canonicalDeployment = normalizeDeploymentState({
            ...raw,
            deployment,
            manifest,
          });
          await repository.upsertDeployment(canonicalDeployment);
          summary.deploymentsSynced += 1;
          for (const rawEpoch of raw.epochs) {
            const epoch = normalizeEpochState({
              deployment,
              epoch: rawEpoch.epoch,
              assets: rawEpoch.assets,
              syncedAt,
            });
            await repository.upsertEpoch(epoch);
            summary.epochsSynced += 1;
            if (epoch.snapshot) summary.snapshotsSynced += 1;
          }
          remainingEpochBudget = Math.max(0, remainingEpochBudget - raw.epochs.length);
        }

        const proofs = uniqueProofRequests(request, deployments);
        for (const item of proofs) {
          if (now() >= deadline) fail('HISTORY_SYNC_DEADLINE', 'History sync exceeded its whole-request deadline.', 504);
          const deployment = proofTargetForAlias(deployments, item.deployment);
          if (!deployment) {
            if (item.source === 'request') fail('HISTORY_PROOF_SCOPE', 'Proof deployment is unavailable.', 400);
            summary.manifestProofsSkipped += 1;
            continue;
          }
          const existing = await repository.getProof(item.hash);
          if (existing) {
            if (existing.deployment_id !== deployment.deploymentId
              || existing.proof_kind !== item.kind || existing.status !== 'FINALIZED') {
              fail('HISTORY_PROOF_CONFLICT', 'Stored transaction proof identity conflicts with this request.', 409);
            }
            summary.proofsAlreadyVerified += 1;
            continue;
          }
          const manifest = deploymentManifest(deployment);
          let proof;
          try {
            proof = await beforeDeadline(chain.verifyProof({
              deploymentId: deployment.deploymentId,
              hash: item.hash,
              assertedKind: item.kind,
              expectedDeploymentHash: manifest.deploymentTransactionHash,
            }), deadline, now);
            if (proof.deploymentId !== deployment.deploymentId
              || proof.deploymentAlias !== deployment.alias
              || proof.transactionHash !== item.hash
              || proof.proofKind !== item.kind
              || proof.executionResult !== 'FINISHED_WITH_RETURN') {
              throw new HistoryError(
                'HISTORY_PROOF_IDENTITY',
                'Verified proof does not match the asserted allowlisted transaction identity.',
                { statusCode: 502 },
              );
            }
            if (proof.epochEndTimestamp !== null
              && !await repository.hasEpoch(proof.deploymentId, proof.epochEndTimestamp)) {
              throw new HistoryError(
                'HISTORY_PROOF_EPOCH_MISSING',
                'Verified transaction targets an epoch outside this bounded sync page.',
                { statusCode: 422 },
              );
            }
            await repository.upsertProof(proof);
            summary.proofsVerified += 1;
          } catch (error) {
            if (item.source === 'request') {
              summary.requestedProofsRejected += 1;
              throw error;
            }
            summary.manifestProofsSkipped += 1;
          }
        }
        const frozen = Object.freeze({ ...summary, replayed: false });
        await repository.completeRun({ keyHash: hashedKey, requestHash, summary: frozen });
        return frozen;
      } catch (error) {
        await repository.failRun({
          keyHash: hashedKey,
          requestHash,
          errorCode: error?.code || 'HISTORY_SYNC_FAILED',
        }).catch(() => {});
        throw error;
      }
    },
  });
}

export { SYNC_DEADLINE_MS, SYNC_LEASE_SECONDS };
