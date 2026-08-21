export const V6_PROTOCOL = 'LIQUIDITY_ARENA_V6';
export const V7_PROTOCOL = 'LIQUIDITY_ARENA_V7';
export const V6_POLICY = 'CRYPTO_SPOT_1M_MEDIAN_V1';
export const V6_ASSETS = Object.freeze(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
export const V6_VENUES = Object.freeze(['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN']);
export const V6_OBJECTIVES = Object.freeze(['HIGH', 'LOW']);

const EPOCH_STATUSES = new Set(['OPEN', 'RESOLVED', 'UNDETERMINED', 'TIMED_OUT']);
const RESULT_STATUSES = new Set(['PENDING', 'DETERMINED', 'UNDETERMINED', 'TIMEOUT']);
const PHASES = new Set([
  'SCHEDULED', 'WAGER_OPEN', 'BATTLE', 'PUBLICATION_DELAY', 'RESOLVABLE',
  'TIMEOUT_AVAILABLE', 'RESOLVED', 'UNDETERMINED', 'TIMED_OUT',
]);
const SETTLEMENT_MODES = new Set([
  'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE', 'REFUND_UNDETERMINED', 'REFUND_TIMEOUT',
]);

function text(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string.`);
  return normalized;
}

function oneOf(value, values, label) {
  const normalized = text(value, label).toUpperCase();
  if (!values.has(normalized)) throw new RangeError(`${label} is unsupported.`);
  return normalized;
}

function integer(value, label, { minimum = 0 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new TypeError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return normalized;
}

function signedInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) throw new TypeError(`${label} must be a safe integer.`);
  return normalized;
}

function atto(value, label) {
  try {
    const normalized = BigInt(value);
    if (normalized < 0n) throw new Error('negative');
    return normalized;
  } catch {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => String(item).trim().toUpperCase() !== expected[index])) {
    throw new RangeError(`${label} does not match the reviewed V6 order.`);
  }
  return Object.freeze([...expected]);
}

function address(value, label) {
  const normalized = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalized) || /^0x0{40}$/i.test(normalized)) {
    throw new TypeError(`${label} must be a non-zero 20-byte address.`);
  }
  return normalized;
}

export function normalizeArenaConfig(raw, { expectedProtocol = V6_PROTOCOL } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Arena config must be an object.');
  }
  const expected = text(expectedProtocol, 'expectedProtocol').toUpperCase();
  if (expected !== V6_PROTOCOL && expected !== V7_PROTOCOL) {
    throw new RangeError('Expected contract protocol is not allowlisted.');
  }
  const protocolVersion = text(raw.protocol_version, 'protocol_version').toUpperCase();
  if (protocolVersion !== expected) {
    throw new RangeError(`Contract protocol must be ${expected}.`);
  }
  const policyVersion = text(raw.policy_version, 'policy_version').toUpperCase();
  if (policyVersion !== V6_POLICY) throw new RangeError(`Contract policy must be ${V6_POLICY}.`);
  const currentPlatformFeeBps = integer(raw.current_platform_fee_bps, 'current_platform_fee_bps');
  const maxPlatformFeeBps = integer(raw.max_platform_fee_bps, 'max_platform_fee_bps');
  if (currentPlatformFeeBps > 500 || maxPlatformFeeBps !== 500) {
    throw new RangeError('V6 platform fee must stay within its immutable 5% cap.');
  }
  for (const [field, expected] of [
    ['native_token_decimals', 18],
    ['default_platform_fee_bps', 200],
    ['wager_open_offset_seconds', 2_400],
    ['battle_open_offset_seconds', 1_200],
    ['resolution_publication_delay_seconds', 120],
    ['timeout_refund_delay_seconds', 86_400],
    ['minimum_qualified_venues', 3],
  ]) {
    if (integer(raw[field], field) !== expected) throw new RangeError(`${field} must equal ${expected}.`);
  }
  if (text(raw.native_token_symbol, 'native_token_symbol').toUpperCase() !== 'GEN') {
    throw new RangeError('V6 native token must be GEN.');
  }
  if (text(raw.transfer_finality, 'transfer_finality').toUpperCase() !== 'FINALIZED') {
    throw new RangeError('V6 transfers must be FINALIZED-only.');
  }
  const objectives = exactArray(raw.supported_objectives, V6_OBJECTIVES, 'supported_objectives');
  const modes = new Set((Array.isArray(raw.supported_settlement_modes)
    ? raw.supported_settlement_modes
    : []).map((mode) => String(mode).trim().toUpperCase()));
  for (const mode of SETTLEMENT_MODES) {
    if (!modes.has(mode)) throw new RangeError(`supported_settlement_modes is missing ${mode}.`);
  }
  const owner = address(raw.owner, 'owner');
  const treasury = address(raw.treasury, 'treasury');
  const keeper = protocolVersion === V7_PROTOCOL ? address(raw.keeper, 'keeper') : null;
  return Object.freeze({
    protocolVersion,
    policyVersion,
    currentPlatformFeeBps,
    maxPlatformFeeBps,
    objectives,
    nativeTokenSymbol: 'GEN',
    nativeTokenDecimals: 18,
    wagerOpenOffsetSeconds: 2_400,
    battleOpenOffsetSeconds: 1_200,
    resolutionPublicationDelaySeconds: 120,
    timeoutRefundDelaySeconds: 86_400,
    minimumQualifiedVenues: 3,
    owner,
    keeper,
    treasury,
  });
}

export function normalizeV6Config(raw, options = {}) {
  return normalizeArenaConfig(raw, { expectedProtocol: options.expectedProtocol || V6_PROTOCOL });
}

export function normalizeV6Objective(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('V6 objective must be an object.');
  }
  const objective = oneOf(raw.objective, new Set(V6_OBJECTIVES), 'objective');
  const settlementMode = oneOf(raw.settlement_mode, SETTLEMENT_MODES, 'settlement_mode');
  const winnerAssetId = String(raw.winner_asset_id || '').trim().toUpperCase();
  if (winnerAssetId && winnerAssetId !== 'TIE' && !V6_ASSETS.includes(winnerAssetId)) {
    throw new RangeError('winner_asset_id is unsupported.');
  }
  return Object.freeze({
    epochId: text(raw.epoch_id, 'epoch_id'),
    objective,
    settlementMode,
    winnerAssetId,
    winnerReturnPpb: signedInteger(raw.winner_return_ppb, 'winner_return_ppb'),
    payoutPoolAtto: atto(raw.payout_pool_atto, 'payout_pool_atto'),
    winningStakeAtto: atto(raw.winning_stake_atto, 'winning_stake_atto'),
    losingStakeAtto: atto(raw.losing_stake_atto, 'losing_stake_atto'),
    platformFeeAtto: atto(raw.platform_fee_atto, 'platform_fee_atto'),
    totalStakeAtto: atto(raw.total_stake_atto, 'total_stake_atto'),
    participantCount: integer(raw.participant_count, 'participant_count'),
    paidAtto: atto(raw.paid_atto, 'paid_atto'),
    remainingPayoutAtto: atto(raw.remaining_payout_atto, 'remaining_payout_atto'),
    unclaimedWinningStakeAtto: atto(
      raw.unclaimed_winning_stake_atto,
      'unclaimed_winning_stake_atto',
    ),
  });
}

export function normalizeV6Epoch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('V6 epoch must be an object.');
  }
  const epochEndTimestamp = integer(raw.epoch_end_timestamp, 'epoch_end_timestamp', { minimum: 1 });
  if (epochEndTimestamp % 3_600 !== 0) throw new RangeError('V6 epoch must end on an exact UTC hour.');
  const expected = {
    wager_opens_timestamp: epochEndTimestamp - 2_400,
    wager_closes_timestamp: epochEndTimestamp - 1_200,
    battle_starts_timestamp: epochEndTimestamp - 1_200,
    resolution_available_timestamp: epochEndTimestamp + 120,
    timeout_refund_available_timestamp: epochEndTimestamp + 86_400,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (integer(raw[field], field) !== value) throw new RangeError(`${field} is inconsistent with the hourly V6 schedule.`);
  }
  const status = oneOf(raw.status, EPOCH_STATUSES, 'status');
  const resultStatus = oneOf(raw.result_status, RESULT_STATUSES, 'result_status');
  const phase = oneOf(raw.phase, PHASES, 'phase');
  if (text(raw.policy_version, 'policy_version').toUpperCase() !== V6_POLICY) {
    throw new RangeError(`Epoch policy must be ${V6_POLICY}.`);
  }
  const qualifiedVenues = Array.isArray(raw.qualified_venues)
    ? raw.qualified_venues.map((venue) => text(venue, 'qualified venue').toUpperCase())
    : [];
  if (new Set(qualifiedVenues).size !== qualifiedVenues.length
    || qualifiedVenues.some((venue) => !V6_VENUES.includes(venue))
    || integer(raw.venue_count, 'venue_count') !== qualifiedVenues.length) {
    throw new RangeError('Epoch qualified venue list is malformed.');
  }
  const platformFeeBpsSnapshot = integer(raw.platform_fee_bps_snapshot, 'platform_fee_bps_snapshot');
  if (platformFeeBpsSnapshot > 500) throw new RangeError('Epoch fee snapshot exceeds 5%.');
  return Object.freeze({
    epochId: text(raw.epoch_id, 'epoch_id'),
    epochEndTimestamp,
    wagerOpensTimestamp: expected.wager_opens_timestamp,
    wagerClosesTimestamp: expected.wager_closes_timestamp,
    battleStartsTimestamp: expected.battle_starts_timestamp,
    resolutionAvailableTimestamp: expected.resolution_available_timestamp,
    timeoutRefundAvailableTimestamp: expected.timeout_refund_available_timestamp,
    status,
    resultStatus,
    phase,
    policyVersion: V6_POLICY,
    platformFeeBpsSnapshot,
    minStakeAtto: atto(raw.min_stake_atto, 'min_stake_atto'),
    maxStakePerWalletAtto: atto(raw.max_stake_per_wallet_atto, 'max_stake_per_wallet_atto'),
    qualifiedVenues: Object.freeze(qualifiedVenues),
    venueCount: qualifiedVenues.length,
    highWinnerAssetId: String(raw.high_winner_asset_id || '').trim().toUpperCase(),
    highWinnerReturnPpb: signedInteger(raw.high_winner_return_ppb, 'high_winner_return_ppb'),
    lowWinnerAssetId: String(raw.low_winner_asset_id || '').trim().toUpperCase(),
    lowWinnerReturnPpb: signedInteger(raw.low_winner_return_ppb, 'low_winner_return_ppb'),
    resolvedAtTimestamp: integer(raw.resolved_at_timestamp, 'resolved_at_timestamp'),
    resolutionDigest: String(raw.resolution_digest || '').trim(),
    platformFeeAccruedAtto: atto(raw.platform_fee_accrued_atto, 'platform_fee_accrued_atto'),
    high: normalizeV6Objective(raw.high),
    low: normalizeV6Objective(raw.low),
  });
}

export function normalizeV6Entry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('V6 entry must be an object.');
  }
  const choiceAssetId = String(raw.choice_asset_id || '').trim().toUpperCase();
  if (choiceAssetId && !V6_ASSETS.includes(choiceAssetId)) throw new RangeError('Entry asset is unsupported.');
  return Object.freeze({
    epochEndTimestamp: integer(raw.epoch_end_timestamp, 'epoch_end_timestamp', { minimum: 1 }),
    objective: oneOf(raw.objective, new Set(V6_OBJECTIVES), 'objective'),
    account: String(raw.account || '').trim(),
    choiceAssetId,
    stakeAtto: atto(raw.stake_atto, 'stake_atto'),
    settlementMode: oneOf(raw.settlement_mode, SETTLEMENT_MODES, 'settlement_mode'),
    eligible: raw.eligible === true,
    claimed: raw.claimed === true,
    claimedAtto: atto(raw.claimed_atto, 'claimed_atto'),
    amountAtto: atto(raw.amount_atto, 'amount_atto'),
    includesRoundingRemainder: raw.includes_rounding_remainder === true,
  });
}

export function normalizeVerifiedClaimQuote(raw, {
  epochEndTimestamp,
  objective,
  account: expectedAccount,
} = {}) {
  const expectedEpoch = integer(epochEndTimestamp, 'Expected claim epoch', { minimum: 1 });
  const expectedObjective = oneOf(objective, new Set(V6_OBJECTIVES), 'Expected claim objective');
  const normalizedAccount = address(expectedAccount, 'Expected claim account');
  const quote = normalizeV6Entry(raw);
  if (quote.epochEndTimestamp !== expectedEpoch) {
    throw new Error('Claim quote belongs to a different epoch.');
  }
  if (quote.objective !== expectedObjective) {
    throw new Error('Claim quote belongs to a different objective.');
  }
  if (quote.account.toLowerCase() !== normalizedAccount.toLowerCase()) {
    throw new Error('Claim quote belongs to a different wallet account.');
  }
  return quote;
}

export function v6WagerGate({ epoch, entry = null, objective, assetId, amountAtto, nowSeconds }) {
  if (!epoch) return Object.freeze({ allowed: false, reason: 'Epoch is unavailable.' });
  const normalizedObjective = String(objective || '').trim().toUpperCase();
  const normalizedAsset = String(assetId || '').trim().toUpperCase();
  if (!V6_OBJECTIVES.includes(normalizedObjective) || !V6_ASSETS.includes(normalizedAsset)) {
    return Object.freeze({ allowed: false, reason: 'Select a valid objective and asset.' });
  }
  if (epoch.status !== 'OPEN') return Object.freeze({ allowed: false, reason: 'Epoch is already settled.' });
  const now = integer(nowSeconds, 'nowSeconds');
  if (now < epoch.wagerOpensTimestamp) return Object.freeze({ allowed: false, reason: 'Wagering has not opened.' });
  if (now >= epoch.wagerClosesTimestamp) return Object.freeze({ allowed: false, reason: 'Wagering is closed.' });
  let amount;
  try { amount = atto(amountAtto, 'amountAtto'); } catch { return Object.freeze({ allowed: false, reason: 'Enter a valid stake.' }); }
  if (amount < epoch.minStakeAtto) return Object.freeze({ allowed: false, reason: 'Stake is below the epoch minimum.' });
  const current = entry?.stakeAtto ?? 0n;
  if (entry?.choiceAssetId && entry.choiceAssetId !== normalizedAsset) {
    return Object.freeze({ allowed: false, reason: 'Top-ups must use the same asset.' });
  }
  if (current + amount > epoch.maxStakePerWalletAtto) {
    return Object.freeze({ allowed: false, reason: 'Stake would exceed the wallet cap.' });
  }
  return Object.freeze({ allowed: true, reason: '' });
}

export function v6ClaimGate(entry) {
  if (!entry) return Object.freeze({ allowed: false, reason: 'No position is loaded.' });
  if (entry.claimed) return Object.freeze({ allowed: false, reason: 'Position was already claimed.' });
  if (!entry.eligible || entry.amountAtto <= 0n) {
    return Object.freeze({ allowed: false, reason: 'This position has no claimable payout or refund.' });
  }
  return Object.freeze({ allowed: true, reason: '' });
}

export function v6TimeoutGate(epoch, nowSeconds) {
  if (!epoch || epoch.status !== 'OPEN') {
    return Object.freeze({ allowed: false, reason: 'Epoch is not awaiting settlement.' });
  }
  const now = integer(nowSeconds, 'nowSeconds');
  if (now < epoch.timeoutRefundAvailableTimestamp) {
    return Object.freeze({ allowed: false, reason: 'The immutable 24-hour timeout has not elapsed.' });
  }
  return Object.freeze({ allowed: true, reason: '' });
}
