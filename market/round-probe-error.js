export const ROUND_NOT_SCHEDULED_RPC_CODE = -32_001;
export const ROUND_NOT_SCHEDULED_RPC_MESSAGE = 'Bradbury round is not scheduled yet.';
export const ROUND_NOT_SCHEDULED_NOTICE = 'This round is not scheduled yet. Wagering remains disabled until it is available on-chain.';

function exactRoundNotScheduledCause(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'code,message'
    && value.code === ROUND_NOT_SCHEDULED_RPC_CODE
    && value.message === ROUND_NOT_SCHEDULED_RPC_MESSAGE;
}

/**
 * Accept either the adapter's exact JSON-RPC error or viem's exact wrapper.
 * Matching stays deliberately narrow so transport and contract faults never
 * become an apparently normal missing-round state.
 */
export function isRoundNotScheduledError(value) {
  if (exactRoundNotScheduledCause(value)) return true;
  return value instanceof Error
    && value.code === ROUND_NOT_SCHEDULED_RPC_CODE
    && value.details === ROUND_NOT_SCHEDULED_RPC_MESSAGE
    && exactRoundNotScheduledCause(value.cause);
}
