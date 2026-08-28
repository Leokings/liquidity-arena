// Diagnostics are public in Actions logs. Never serialize an RPC error object:
// ethers errors can contain the entire signed transaction in their payload.
export function sanitizedDiagnosticText(value) {
  return String(value ?? '').slice(0, 8192)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|PRIVATE_KEY|MNEMONIC|KEYSTORE|CREDENTIAL|TOKEN)[A-Z0-9_]*\s*[:=][^\r\n]*/g, '[redacted]')
    .replace(/\b(?:authorization|bearer|credential|keystore|mnemonic|password|private[_ -]?key|secret|raw[_ -]?transaction|serialized[_ -]?transaction)\b[^\r\n]*/gi, '[redacted]')
    .replace(/\b(?:0x)?[0-9a-f]{64}\b/gi, '[redacted-64hex]')
    .replace(/\b(?:0x)?[0-9a-f]{65,}\b/gi, '[redacted-hex]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function publicBroadcastFailure(error) {
  const rpcError = error?.info?.error ?? error?.error ?? error;
  const code = String(error?.code ?? '');
  return Object.freeze({
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'RPC_BROADCAST_FAILED',
    ...(Number.isSafeInteger(rpcError?.code) ? { rpcCode: rpcError.code } : {}),
    message: sanitizedDiagnosticText(
      rpcError?.message ?? error?.shortMessage ?? error?.message ?? 'Broadcast request failed.',
    ).slice(0, 256),
  });
}

// Bradbury's admission limiter asks callers to retry an unadmitted envelope.
// No other RPC error (including a generic -32005) permits an immediate replay.
export function broadcastAdmissionRetryDelayMs(error) {
  const rpcError = error?.info?.error ?? error?.error ?? error;
  if (rpcError?.code !== -32005 || typeof rpcError?.message !== 'string') return null;
  const message = rpcError.message.slice(0, 4096);
  if (!/\btransaction gas rate limit exceeded: node is at capacity\b/i.test(message)) return null;
  const hint = message.match(/"retryAfterMs"\s*:\s*(-?\d+)(?=\s*[,}])/)
    ?? message.match(/\bretry in ~?(-?\d+)ms\b/i);
  const milliseconds = rpcError.data?.retryAfterMs ?? (hint ? Number(hint[1]) : NaN);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 30_000) return null;
  return milliseconds + 250;
}
