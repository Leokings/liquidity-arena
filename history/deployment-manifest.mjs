import v6Artifact from '../deployments/studionet-v6.json' with { type: 'json' };
import v7Artifact from '../deployments/studionet-v7.json' with { type: 'json' };

const HASH = /^0x[0-9a-fA-F]{64}$/;

function proof(deployment, hash, kind) {
  if (!HASH.test(String(hash || ''))) return null;
  return Object.freeze({ deployment, hash: String(hash).toLowerCase(), kind });
}

function v6KnownProofs(artifact) {
  const items = [proof('v6', artifact?.deployment?.transactionHash, 'DEPLOYMENT')];
  for (const epoch of artifact?.epochs || []) {
    items.push(proof('v6', epoch?.transactionHash, 'CREATE_EPOCH'));
  }
  const evidence = artifact?.livePaymentEvidence;
  items.push(proof('v6', evidence?.resolution?.transactionHash, 'RESOLVE_EPOCH'));
  for (const position of evidence?.positions || []) {
    items.push(proof('v6', position?.transactionHash, 'WAGER'));
  }
  for (const delivery of evidence?.deliveries || []) {
    items.push(proof('v6', delivery?.parentTransactionHash, 'CLAIM'));
    // Child hashes are never trusted as standalone proof targets. A verified
    // claim parent must derive and verify its only transfer child itself.
  }
  return Object.freeze(items.filter(Boolean));
}

const MANIFESTS = Object.freeze({
  v6: Object.freeze({
    address: String(v6Artifact.contractAddress || '').toLowerCase(),
    protocolVersion: v6Artifact.protocolVersion,
    deploymentTransactionHash: String(v6Artifact?.deployment?.transactionHash || '').toLowerCase(),
    sourceMetadata: Object.freeze({
      artifact: 'deployments/studionet-v6.json',
      sourcePath: v6Artifact.sourceFile,
      sourceSha256: v6Artifact.sourceSha256,
      artifactClaimsSourceMatchesDeployedCode: v6Artifact.sourceMatchesDeployedCode === true,
      deployedAt: v6Artifact.deployedAt,
    }),
    knownProofs: v6KnownProofs(v6Artifact),
  }),
  v7: Object.freeze({
    address: String(v7Artifact.contractAddress || '').toLowerCase(),
    protocolVersion: v7Artifact.protocolVersion,
    deploymentTransactionHash: String(v7Artifact.deploymentTransactionHash || '').toLowerCase(),
    sourceMetadata: Object.freeze({
      artifact: 'deployments/studionet-v7.json',
      sourcePath: v7Artifact?.source?.path,
      sourceSha256: v7Artifact?.source?.sha256,
      runner: v7Artifact?.source?.runner,
      deployedAt: v7Artifact.deployedAt,
      finalizedAt: v7Artifact.finalizedAt,
    }),
    knownProofs: Object.freeze([
      proof('v7', v7Artifact.deploymentTransactionHash, 'DEPLOYMENT'),
    ].filter(Boolean)),
  }),
});

export function deploymentManifest(deployment) {
  const manifest = MANIFESTS[deployment.alias];
  const artifactMatched = Boolean(
    manifest
    && manifest.address === deployment.addressKey
    && manifest.protocolVersion === deployment.protocolVersion,
  );
  return Object.freeze({
    deploymentTransactionHash: artifactMatched && HASH.test(manifest.deploymentTransactionHash)
      ? manifest.deploymentTransactionHash
      : null,
    sourceMetadata: Object.freeze({
      artifactMatched,
      ...(artifactMatched ? manifest.sourceMetadata : {}),
    }),
    knownProofs: artifactMatched ? manifest.knownProofs : Object.freeze([]),
  });
}
