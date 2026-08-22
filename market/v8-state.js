export const V8_PROTOCOL = 'LIQUIDITY_ARENA_V8';
export const V8_POLICY = 'CRYPTO_SPOT_1M_MEDIAN_V1';
export const V8_PAYOUT_PROTOCOL = 'IDEMPOTENT_EVM_VAULT_V1';
export const V8_PAYOUT_FACTORY = '0x944fdadd826c2a159c63cb100db174716ccd1317';
export const V8_ASSETS = Object.freeze(['BTC', 'ETH', 'BNB', 'SOL', 'XRP']);
export const V8_VENUES = Object.freeze(['BINANCE', 'OKX', 'BYBIT', 'GATE', 'KUCOIN']);
export const V8_OBJECTIVES = Object.freeze(['HIGH', 'LOW']);
export const V8_PAYOUT_STATES = Object.freeze([
  'PREPARING', 'DISPATCHED', 'FUNDED_IN_ESCROW', 'EOA_WITHDRAWN',
]);

const EPOCH_STATUSES = new Set(['OPEN', 'RESOLVED', 'TIMED_OUT']);
const RESULT_STATUSES = new Set(['PENDING', 'DETERMINED', 'TIMEOUT']);
const PHASES = new Set([
  'SCHEDULED', 'WAGER_OPEN', 'BATTLE', 'PUBLICATION_DELAY', 'RESOLVABLE',
  'TIMEOUT_AVAILABLE', 'RESOLVED', 'TIMED_OUT',
]);
const SETTLEMENT_MODES = new Set([
  'PENDING', 'PARIMUTUEL', 'REFUND_TIE', 'REFUND_UNBACKED_WINNER',
  'REFUND_NO_LOSING_SIDE', 'REFUND_TIMEOUT',
]);
const OBJECTIVE_SET = new Set(V8_OBJECTIVES);
const PAYOUT_STATE_SET = new Set(V8_PAYOUT_STATES);
const PAYOUT_ID_PATTERN = /^[0-9a-f]{64}$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

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

function address(value, label, { allowZero = false } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized) || (!allowZero && /^0x0{40}$/.test(normalized))) {
    throw new TypeError(`${label} must be a ${allowZero ? '' : 'non-zero '}20-byte address.`);
  }
  return normalized;
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => String(item).trim().toUpperCase() !== expected[index])) {
    throw new RangeError(`${label} does not match the reviewed V8 order.`);
  }
  return Object.freeze([...expected]);
}

export function normalizeArenaConfig(raw, { expectedProtocol = V8_PROTOCOL } = {}) {
  object(raw, 'Arena config');
  const expected = text(expectedProtocol, 'expectedProtocol').toUpperCase();
  if (expected !== V8_PROTOCOL) throw new RangeError('Expected contract protocol must be V8.');
  if (text(raw.protocol_version, 'protocol_version').toUpperCase() !== V8_PROTOCOL) {
    throw new RangeError(`Contract protocol must be ${V8_PROTOCOL}.`);
  }
  if (text(raw.policy_version, 'policy_version').toUpperCase() !== V8_POLICY) {
    throw new RangeError(`Contract policy must be ${V8_POLICY}.`);
  }
  if (text(raw.payout_protocol_version, 'payout_protocol_version').toUpperCase()
    !== V8_PAYOUT_PROTOCOL) {
    throw new RangeError(`Payout protocol must be ${V8_PAYOUT_PROTOCOL}.`);
  }
  const currentPlatformFeeBps = integer(raw.current_platform_fee_bps, 'current_platform_fee_bps');
  if (currentPlatformFeeBps !== 200) throw new RangeError('V8 platform fee must be the fixed 2%.');
  for (const [field, expectedValue] of [
    ['minimum_epoch_creation_lead_seconds', 3_600],
    ['keeper_max_schedule_ahead_seconds', 93_600],
    ['wager_open_offset_seconds', 2_400],
    ['battle_open_offset_seconds', 1_200],
    ['resolution_publication_delay_seconds', 120],
    ['timeout_refund_delay_seconds', 86_400],
    ['minimum_qualified_venues', 3],
    ['max_payout_attempts', 3],
    ['payout_retry_delay_seconds', 3_600],
    ['validator_return_tolerance_ppb', 100_000],
  ]) {
    if (integer(raw[field], field) !== expectedValue) {
      throw new RangeError(`${field} must equal ${expectedValue}.`);
    }
  }
  if (raw.prepare_retries_capped !== false) {
    throw new RangeError('V8 prepare retries must remain idempotent and uncapped.');
  }
  if (text(raw.payout_finality, 'payout_finality').toUpperCase() !== 'FUNDED_IN_ESCROW'
    || text(raw.claimed_semantics, 'claimed_semantics').toUpperCase() !== 'EOA_WITHDRAWN') {
    throw new RangeError('V8 payout finality or claimed semantics changed.');
  }
  const payoutVaultFactory = address(raw.payout_vault_factory, 'payout_vault_factory');
  if (payoutVaultFactory !== V8_PAYOUT_FACTORY) {
    throw new RangeError(`V8 payout factory must be ${V8_PAYOUT_FACTORY}.`);
  }
  const epochMinStakeAtto = atto(raw.epoch_min_stake_atto, 'epoch_min_stake_atto');
  const epochMaxStakePerWalletAtto = atto(
    raw.epoch_max_stake_per_wallet_atto,
    'epoch_max_stake_per_wallet_atto',
  );
  if (epochMinStakeAtto <= 0n || epochMaxStakePerWalletAtto < epochMinStakeAtto) {
    throw new RangeError('V8 stake bounds are inconsistent.');
  }
  const payoutsEnabled = raw.payouts_enabled === true;
  const newRiskEnabled = raw.new_risk_enabled === true;
  if (newRiskEnabled && !payoutsEnabled) throw new RangeError('V8 cannot enable new risk before payouts.');
  return Object.freeze({
    protocolVersion: V8_PROTOCOL,
    policyVersion: V8_POLICY,
    payoutProtocolVersion: V8_PAYOUT_PROTOCOL,
    owner: address(raw.owner, 'owner'),
    keeper: address(raw.keeper, 'keeper'),
    treasury: address(raw.treasury, 'treasury'),
    payoutVaultFactory,
    payoutsEnabled,
    newRiskEnabled,
    currentPlatformFeeBps,
    epochMinStakeAtto,
    epochMaxStakePerWalletAtto,
    maxPayoutAttempts: 3,
    payoutRetryDelaySeconds: 3_600,
    minimumEpochCreationLeadSeconds: 3_600,
    keeperMaxScheduleAheadSeconds: 93_600,
    assetIds: exactArray(raw.asset_ids, V8_ASSETS, 'asset_ids'),
    venues: exactArray(raw.venues, V8_VENUES, 'venues'),
    objectives: exactArray(raw.supported_objectives, V8_OBJECTIVES, 'supported_objectives'),
    wagerOpenOffsetSeconds: 2_400,
    battleOpenOffsetSeconds: 1_200,
    resolutionPublicationDelaySeconds: 120,
    timeoutRefundDelaySeconds: 86_400,
    minimumQualifiedVenues: 3,
    validatorReturnTolerancePpb: 100_000,
  });
}

export function normalizeV8Objective(raw) {
  object(raw, 'V8 objective');
  const winnerAssetId = String(raw.winner_asset_id || '').trim().toUpperCase();
  if (winnerAssetId && winnerAssetId !== 'TIE' && !V8_ASSETS.includes(winnerAssetId)) {
    throw new RangeError('winner_asset_id is unsupported.');
  }
  const normalized = {
    epochId: text(raw.epoch_id, 'epoch_id'),
    objective: oneOf(raw.objective, OBJECTIVE_SET, 'objective'),
    settlementMode: oneOf(raw.settlement_mode, SETTLEMENT_MODES, 'settlement_mode'),
    winnerAssetId,
    winnerReturnPpb: signedInteger(raw.winner_return_ppb, 'winner_return_ppb'),
    payoutPoolAtto: atto(raw.payout_pool_atto, 'payout_pool_atto'),
    winningStakeAtto: atto(raw.winning_stake_atto, 'winning_stake_atto'),
    losingStakeAtto: atto(raw.losing_stake_atto, 'losing_stake_atto'),
    platformFeeAtto: atto(raw.platform_fee_atto, 'platform_fee_atto'),
    totalStakeAtto: atto(raw.total_stake_atto, 'total_stake_atto'),
    participantCount: integer(raw.participant_count, 'participant_count'),
    paidAtto: atto(raw.paid_atto, 'paid_atto'),
    fundedInEscrowAtto: atto(raw.funded_in_escrow_atto, 'funded_in_escrow_atto'),
    allocatedAtto: atto(raw.allocated_atto, 'allocated_atto'),
    remainingPayoutAtto: atto(raw.remaining_payout_atto, 'remaining_payout_atto'),
    unallocatedPayoutAtto: atto(raw.unallocated_payout_atto, 'unallocated_payout_atto'),
    allocatedNotFundedAtto: atto(raw.allocated_not_funded_atto, 'allocated_not_funded_atto'),
    fundedNotWithdrawnAtto: atto(raw.funded_not_withdrawn_atto, 'funded_not_withdrawn_atto'),
    unclaimedWinningStakeAtto: atto(
      raw.unclaimed_winning_stake_atto,
      'unclaimed_winning_stake_atto',
    ),
  };
  if (normalized.paidAtto > normalized.fundedInEscrowAtto
    || normalized.fundedInEscrowAtto > normalized.allocatedAtto
    || normalized.allocatedAtto > normalized.payoutPoolAtto
    || normalized.remainingPayoutAtto !== normalized.payoutPoolAtto - normalized.fundedInEscrowAtto
    || normalized.unallocatedPayoutAtto !== normalized.payoutPoolAtto - normalized.allocatedAtto
    || normalized.allocatedNotFundedAtto !== normalized.allocatedAtto - normalized.fundedInEscrowAtto
    || normalized.fundedNotWithdrawnAtto !== normalized.fundedInEscrowAtto - normalized.paidAtto
    || normalized.unclaimedWinningStakeAtto > normalized.winningStakeAtto) {
    throw new RangeError('V8 objective payout accounting is inconsistent.');
  }
  if (normalized.settlementMode === 'PARIMUTUEL'
    && (normalized.totalStakeAtto !== normalized.winningStakeAtto + normalized.losingStakeAtto
      || normalized.payoutPoolAtto + normalized.platformFeeAtto !== normalized.totalStakeAtto)) {
    throw new RangeError('V8 parimutuel objective accounting is inconsistent.');
  }
  if (normalized.settlementMode.startsWith('REFUND_')
    && (normalized.payoutPoolAtto !== normalized.totalStakeAtto
      || normalized.winningStakeAtto !== 0n
      || normalized.losingStakeAtto !== 0n
      || normalized.platformFeeAtto !== 0n)) {
    throw new RangeError('V8 refund objective accounting is inconsistent.');
  }
  return Object.freeze(normalized);
}

export function normalizeV8Epoch(raw) {
  object(raw, 'V8 epoch');
  const epochEndTimestamp = integer(raw.epoch_end_timestamp, 'epoch_end_timestamp', { minimum: 1 });
  if (epochEndTimestamp % 3_600 !== 0) throw new RangeError('V8 epoch must end on an exact UTC hour.');
  const expected = {
    wager_opens_timestamp: epochEndTimestamp - 2_400,
    wager_closes_timestamp: epochEndTimestamp - 1_200,
    battle_starts_timestamp: epochEndTimestamp - 1_200,
    resolution_available_timestamp: epochEndTimestamp + 120,
    timeout_refund_available_timestamp: epochEndTimestamp + 86_400,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (integer(raw[field], field) !== value) throw new RangeError(`${field} is inconsistent with V8.`);
  }
  if (text(raw.policy_version, 'policy_version').toUpperCase() !== V8_POLICY) {
    throw new RangeError(`Epoch policy must be ${V8_POLICY}.`);
  }
  const qualifiedVenues = Array.isArray(raw.qualified_venues)
    ? raw.qualified_venues.map((venue) => text(venue, 'qualified venue').toUpperCase())
    : [];
  if (new Set(qualifiedVenues).size !== qualifiedVenues.length
    || qualifiedVenues.some((venue) => !V8_VENUES.includes(venue))
    || integer(raw.venue_count, 'venue_count') !== qualifiedVenues.length) {
    throw new RangeError('Epoch qualified venue list is malformed.');
  }
  const fee = integer(raw.platform_fee_bps_snapshot, 'platform_fee_bps_snapshot');
  if (fee !== 200) throw new RangeError('Epoch fee snapshot must be 2%.');
  return Object.freeze({
    epochId: text(raw.epoch_id, 'epoch_id'),
    epochEndTimestamp,
    wagerOpensTimestamp: expected.wager_opens_timestamp,
    wagerClosesTimestamp: expected.wager_closes_timestamp,
    battleStartsTimestamp: expected.battle_starts_timestamp,
    resolutionAvailableTimestamp: expected.resolution_available_timestamp,
    timeoutRefundAvailableTimestamp: expected.timeout_refund_available_timestamp,
    status: oneOf(raw.status, EPOCH_STATUSES, 'status'),
    resultStatus: oneOf(raw.result_status, RESULT_STATUSES, 'result_status'),
    phase: oneOf(raw.phase, PHASES, 'phase'),
    policyVersion: V8_POLICY,
    platformFeeBpsSnapshot: fee,
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
    high: normalizeV8Objective(raw.high),
    low: normalizeV8Objective(raw.low),
  });
}

export function normalizeV8ClaimQuote(raw) {
  object(raw, 'V8 claim quote');
  const payoutId = String(raw.payout_id || '').trim().toLowerCase();
  if (payoutId && !PAYOUT_ID_PATTERN.test(payoutId)) throw new TypeError('payout_id is malformed.');
  const payoutState = String(raw.payout_state || '').trim().toUpperCase();
  if (Boolean(payoutId) !== Boolean(payoutState)
    || (payoutState && !PAYOUT_STATE_SET.has(payoutState))) {
    throw new RangeError('Claim quote payout identity and state are inconsistent.');
  }
  const choiceAssetId = String(raw.choice_asset_id || '').trim().toUpperCase();
  if (choiceAssetId && !V8_ASSETS.includes(choiceAssetId)) throw new RangeError('Position asset is unsupported.');
  const normalized = {
    epochEndTimestamp: integer(raw.epoch_end_timestamp, 'epoch_end_timestamp', { minimum: 1 }),
    objective: oneOf(raw.objective, OBJECTIVE_SET, 'objective'),
    account: address(raw.account, 'account'),
    choiceAssetId,
    stakeAtto: atto(raw.stake_atto, 'stake_atto'),
    settlementMode: oneOf(raw.settlement_mode, SETTLEMENT_MODES, 'settlement_mode'),
    eligible: raw.eligible === true,
    claimed: raw.claimed === true,
    claimedAtto: atto(raw.claimed_atto, 'claimed_atto'),
    escrowFundedAtto: atto(raw.escrow_funded_atto, 'escrow_funded_atto'),
    amountAtto: atto(raw.amount_atto, 'amount_atto'),
    includesRoundingRemainder: raw.includes_rounding_remainder === true,
    payoutId,
    payoutState,
  };
  if (normalized.claimed !== (normalized.payoutState === 'EOA_WITHDRAWN')) {
    throw new RangeError('Claimed semantics must match the EOA_WITHDRAWN payout stage.');
  }
  if (normalized.payoutId) {
    if (normalized.eligible
      || normalized.amountAtto <= 0n
      || normalized.claimedAtto !== (normalized.claimed ? normalized.amountAtto : 0n)
      || normalized.escrowFundedAtto !== (
        ['FUNDED_IN_ESCROW', 'EOA_WITHDRAWN'].includes(normalized.payoutState)
          ? normalized.amountAtto
          : 0n
      )) {
      throw new RangeError('Claim quote payout accounting is inconsistent with its stage.');
    }
  } else if (normalized.claimedAtto !== 0n || normalized.escrowFundedAtto !== 0n) {
    throw new RangeError('Claim quote has payout accounting without a payout ID.');
  }
  if (normalized.eligible !== (!normalized.claimed && !normalized.payoutId && normalized.amountAtto > 0n)) {
    throw new RangeError('Claim quote eligibility is inconsistent.');
  }
  return Object.freeze(normalized);
}

export function normalizeVerifiedClaimQuote(raw, { epochEndTimestamp, objective, account: expectedAccount } = {}) {
  const quote = normalizeV8ClaimQuote(raw);
  const expectedEpoch = integer(epochEndTimestamp, 'Expected claim epoch', { minimum: 1 });
  const expectedObjective = oneOf(objective, OBJECTIVE_SET, 'Expected claim objective');
  const normalizedAccount = address(expectedAccount, 'Expected claim account');
  if (quote.epochEndTimestamp !== expectedEpoch) throw new Error('Claim quote belongs to a different epoch.');
  if (quote.objective !== expectedObjective) throw new Error('Claim quote belongs to a different objective.');
  if (quote.account !== normalizedAccount) throw new Error('Claim quote belongs to a different wallet account.');
  return quote;
}

export function normalizeV8Payout(raw, { payoutId = '', recipient = '' } = {}) {
  object(raw, 'V8 payout');
  const normalizedId = String(raw.payout_id || '').trim().toLowerCase();
  if (!PAYOUT_ID_PATTERN.test(normalizedId)) throw new TypeError('Payout ID must be 64 lowercase hex characters.');
  if (payoutId && normalizedId !== String(payoutId).trim().toLowerCase()) {
    throw new Error('Payout readback returned a different payout ID.');
  }
  const normalizedRecipient = address(raw.recipient, 'payout recipient');
  if (recipient && normalizedRecipient !== address(recipient, 'expected payout recipient')) {
    throw new Error('Payout recipient does not match the connected wallet.');
  }
  const state = oneOf(raw.state, PAYOUT_STATE_SET, 'payout state');
  const kind = text(raw.kind, 'payout kind').toUpperCase();
  if (kind !== 'PLAYER') throw new RangeError('The browser only exposes recipient player payouts.');
  const vault = address(raw.vault, 'payout vault', { allowZero: state === 'PREPARING' });
  if (state !== 'PREPARING' && /^0x0{40}$/.test(vault)) throw new Error('Prepared payout has a zero vault.');
  if (state === 'PREPARING' && !/^0x0{40}$/.test(vault)) {
    throw new Error('A preparing payout cannot already expose an EVM vault.');
  }
  const epochEndTimestamp = integer(raw.epoch_end_timestamp, 'epoch_end_timestamp', { minimum: 1 });
  if (epochEndTimestamp % 3_600 !== 0) throw new Error('Player payout epoch is not an exact UTC hour.');
  const objective = oneOf(raw.objective, OBJECTIVE_SET, 'payout objective');
  const escrowWithdrawn = raw.escrow_withdrawn === true;
  if ((state === 'EOA_WITHDRAWN') !== escrowWithdrawn) {
    throw new Error('Payout withdrawal flag is inconsistent with its stage.');
  }
  const normalized = {
    payoutId: normalizedId,
    kind,
    recipient: normalizedRecipient,
    amountAtto: atto(raw.amount_atto, 'amount_atto'),
    epochEndTimestamp,
    objective,
    settlementMode: oneOf(raw.settlement_mode, SETTLEMENT_MODES, 'payout settlement mode'),
    state,
    prepareAttemptCount: integer(raw.prepare_attempt_count, 'prepare_attempt_count', { minimum: 1 }),
    attemptCount: integer(raw.attempt_count, 'attempt_count'),
    reserveRemainingAtto: atto(raw.reserve_remaining_atto, 'reserve_remaining_atto'),
    vault,
    createdAtTimestamp: integer(raw.created_at_timestamp, 'created_at_timestamp', { minimum: 1 }),
    lastPrepareTimestamp: integer(raw.last_prepare_timestamp, 'last_prepare_timestamp', { minimum: 1 }),
    lastDispatchTimestamp: integer(raw.last_dispatch_timestamp, 'last_dispatch_timestamp'),
    fundedAtTimestamp: integer(raw.funded_at_timestamp, 'funded_at_timestamp'),
    withdrawnAtTimestamp: integer(raw.withdrawn_at_timestamp, 'withdrawn_at_timestamp'),
    escrowWithdrawn,
  };
  if (normalized.amountAtto <= 0n || normalized.attemptCount > 3) {
    throw new RangeError('Payout amount or attempt count is inconsistent.');
  }
  if (normalized.lastPrepareTimestamp < normalized.createdAtTimestamp) {
    throw new RangeError('Payout preparation predates payout creation.');
  }
  const stageTimestampsValid = normalized.state === 'PREPARING'
    ? normalized.attemptCount === 0
      && normalized.lastDispatchTimestamp === 0
      && normalized.fundedAtTimestamp === 0
      && normalized.withdrawnAtTimestamp === 0
    : normalized.state === 'DISPATCHED'
      ? normalized.attemptCount >= 1
        && normalized.lastDispatchTimestamp >= normalized.lastPrepareTimestamp
        && normalized.fundedAtTimestamp === 0
        && normalized.withdrawnAtTimestamp === 0
      : normalized.state === 'FUNDED_IN_ESCROW'
        ? normalized.attemptCount >= 1
          && normalized.lastDispatchTimestamp >= normalized.lastPrepareTimestamp
          && normalized.fundedAtTimestamp >= normalized.lastDispatchTimestamp
          && normalized.withdrawnAtTimestamp === 0
          && normalized.reserveRemainingAtto === 0n
        : normalized.attemptCount >= 1
          && normalized.lastDispatchTimestamp >= normalized.lastPrepareTimestamp
          && normalized.fundedAtTimestamp >= normalized.lastDispatchTimestamp
          && normalized.withdrawnAtTimestamp >= normalized.fundedAtTimestamp
          && normalized.reserveRemainingAtto === 0n;
  if (!stageTimestampsValid) throw new RangeError('Payout timestamps are inconsistent with its stage.');
  return Object.freeze(normalized);
}

export function v8WagerGate({ epoch, entry = null, objective, assetId, amountAtto, nowSeconds }) {
  if (!epoch) return Object.freeze({ allowed: false, reason: 'Epoch is unavailable.' });
  const normalizedObjective = String(objective || '').trim().toUpperCase();
  const normalizedAsset = String(assetId || '').trim().toUpperCase();
  if (!V8_OBJECTIVES.includes(normalizedObjective) || !V8_ASSETS.includes(normalizedAsset)) {
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

export function v8ClaimGate(entry) {
  if (!entry) return Object.freeze({ allowed: false, reason: 'No position is loaded.' });
  if (entry.payoutId) return Object.freeze({ allowed: false, reason: 'Continue the existing payout below.' });
  if (entry.claimed) return Object.freeze({ allowed: false, reason: 'Payout was already withdrawn.' });
  if (!entry.eligible || entry.amountAtto <= 0n) {
    return Object.freeze({ allowed: false, reason: 'This position has no claimable payout or refund.' });
  }
  return Object.freeze({ allowed: true, reason: '' });
}

export function v8TimeoutGate(epoch, nowSeconds) {
  if (!epoch || epoch.status !== 'OPEN') {
    return Object.freeze({ allowed: false, reason: 'Epoch is not awaiting settlement.' });
  }
  const now = integer(nowSeconds, 'nowSeconds');
  if (now < epoch.timeoutRefundAvailableTimestamp) {
    return Object.freeze({ allowed: false, reason: 'The immutable 24-hour timeout has not elapsed.' });
  }
  return Object.freeze({ allowed: true, reason: '' });
}
