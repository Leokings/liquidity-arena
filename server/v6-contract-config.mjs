export const LIQUIDITY_ARENA_PROTOCOL = 'LIQUIDITY_ARENA_V6';
export const LIQUIDITY_ARENA_POLICY = 'CRYPTO_SPOT_1M_MEDIAN_V1';

const REQUIRED_SETTLEMENT_MODES = Object.freeze([
  'PENDING',
  'PARIMUTUEL',
  'REFUND_TIE',
  'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE',
  'REFUND_UNDETERMINED',
  'REFUND_TIMEOUT',
]);

function normalizedSet(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map((item) => String(item).trim().toUpperCase()));
}

function exactInteger(value, expected, label) {
  if (Number(value) !== expected) throw new Error(`${label} must equal ${expected}.`);
}

export function validateLiquidityArenaV6Config(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Liquidity Arena contract config must be an object.');
  }
  const protocolVersion = String(raw.protocol_version || '').trim().toUpperCase();
  const policyVersion = String(raw.policy_version || '').trim().toUpperCase();
  if (protocolVersion !== LIQUIDITY_ARENA_PROTOCOL) {
    throw new Error(`Contract protocol must be ${LIQUIDITY_ARENA_PROTOCOL}.`);
  }
  if (policyVersion !== LIQUIDITY_ARENA_POLICY) {
    throw new Error(`Contract policy must be ${LIQUIDITY_ARENA_POLICY}.`);
  }
  if (String(raw.native_token_symbol || '').trim().toUpperCase() !== 'GEN') {
    throw new Error('Contract native token must be GEN.');
  }
  exactInteger(raw.native_token_decimals, 18, 'native_token_decimals');
  exactInteger(raw.default_platform_fee_bps, 200, 'default_platform_fee_bps');
  exactInteger(raw.max_platform_fee_bps, 500, 'max_platform_fee_bps');
  exactInteger(raw.wager_open_offset_seconds, 2_400, 'wager_open_offset_seconds');
  exactInteger(raw.battle_open_offset_seconds, 1_200, 'battle_open_offset_seconds');
  exactInteger(
    raw.resolution_publication_delay_seconds,
    120,
    'resolution_publication_delay_seconds',
  );
  exactInteger(raw.timeout_refund_delay_seconds, 86_400, 'timeout_refund_delay_seconds');
  exactInteger(raw.minimum_qualified_venues, 3, 'minimum_qualified_venues');
  const currentFeeBps = Number(raw.current_platform_fee_bps);
  if (!Number.isInteger(currentFeeBps) || currentFeeBps < 0 || currentFeeBps > 500) {
    throw new Error('current_platform_fee_bps must be an integer between 0 and 500.');
  }
  if (String(raw.transfer_finality || '').trim().toUpperCase() !== 'FINALIZED') {
    throw new Error('Contract transfers must be FINALIZED-only.');
  }
  const objectives = normalizedSet(raw.supported_objectives);
  if (objectives.size !== 2 || !objectives.has('HIGH') || !objectives.has('LOW')) {
    throw new Error('Contract objectives must be exactly HIGH and LOW.');
  }
  const modes = normalizedSet(raw.supported_settlement_modes);
  for (const mode of REQUIRED_SETTLEMENT_MODES) {
    if (!modes.has(mode)) throw new Error(`Contract settlement modes are missing ${mode}.`);
  }
  return Object.freeze({
    protocolVersion,
    policyVersion,
    platformFeeBps: currentFeeBps,
  });
}
