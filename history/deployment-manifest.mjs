import v8Artifact from '../deployments/bradbury-v8.json' with { type: 'json' };
import {
  AUDITED_PAYOUT_FACTORY_4221,
  LIQUIDITY_ARENA_PAYOUT_PROTOCOL,
} from '../server/deployment-config.mjs';
import { EXPECTED_V8_SCHEMA_SHA256 } from '../server/v8-contract-config.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXPECTED_V8_SOURCE_SHA256 = '1e7545f8f0fd121d64f3565675ac8f541d0ba8274abbde60db0dd02d7d777db5';

function proof(hash) {
  if (!HASH.test(String(hash || ''))) return null;
  return Object.freeze({ deployment: 'v8', hash: String(hash).toLowerCase(), kind: 'DEPLOYMENT' });
}

export function deploymentManifest(deployment) {
  const artifactAddress = String(v8Artifact.contractAddress || '').toLowerCase();
  const artifactMatched = Boolean(
    ADDRESS.test(artifactAddress)
    && artifactAddress === deployment.addressKey
    && v8Artifact.deploymentAlias === 'v8'
    && v8Artifact.network === 'testnet-bradbury'
    && v8Artifact.chainId === 4_221
    && v8Artifact.protocolVersion === deployment.protocolVersion
    && v8Artifact.policyVersion === deployment.policyVersion
    && v8Artifact.payoutProtocolVersion === LIQUIDITY_ARENA_PAYOUT_PROTOCOL
    && v8Artifact.payoutProtocolVersion === deployment.payoutProtocolVersion
    && String(v8Artifact.payoutFactoryAddress || '').toLowerCase() === AUDITED_PAYOUT_FACTORY_4221
    && v8Artifact.schemaSha256 === EXPECTED_V8_SCHEMA_SHA256
    && v8Artifact.sourceSha256 === EXPECTED_V8_SOURCE_SHA256
    && v8Artifact.deploymentStatus === 'FINALIZED'
    && v8Artifact.active === true,
  );
  const deploymentProof = artifactMatched ? proof(v8Artifact.deploymentTransactionHash) : null;
  return Object.freeze({
    deploymentTransactionHash: deploymentProof?.hash || null,
    payoutFactoryAddress: artifactMatched ? v8Artifact.payoutFactoryAddress : null,
    schemaSha256: artifactMatched ? v8Artifact.schemaSha256 : null,
    sourceMetadata: Object.freeze({
      artifactMatched,
      ...(artifactMatched ? {
        artifact: 'deployments/bradbury-v8.json',
        sourcePath: v8Artifact.sourcePath,
        sourceSha256: v8Artifact.sourceSha256,
        deploymentStatus: v8Artifact.deploymentStatus,
      } : {}),
    }),
    knownProofs: Object.freeze(deploymentProof ? [deploymentProof] : []),
  });
}
