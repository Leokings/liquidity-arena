import {
  MARKET_ASSETS,
  SyntheticMarketDriver,
  createSyntheticMarketHistory,
  getMarketAsset,
} from './index.js';
import { LiquidArena } from './arena.js';
import { createActivityStore } from './activity-store.js';
import { createDeploymentRegistry } from './deployment-registry.js';
import { GenLayerGateway, assertFinalizedExecution } from './genlayer-client.js';
import { formatAttoToGen, parseGenToAtto } from './gen-units.js';
import {
  LiveMarketDriver,
  WINDOW_QUERIES,
  createSharedEventSourceConstructor,
} from './live-driver.js';
import { EPOCH_PHASE, arenaEpochState, createEpoch } from './epoch-schedule.js';
import {
  canReuseFinalizedDisplayRound,
  canReuseFinalizedRoundVector,
  isTerminalRound,
  reconcileFinalizedRoundFrame,
  roundMatchesDisplayTarget,
  selectRoundTargets,
} from './finalized-round-frame.js';
import {
  V6_ASSETS,
  V6_POLICY,
  normalizeArenaConfig,
  normalizeV6Epoch,
  normalizeVerifiedClaimQuote,
  v6ClaimGate,
  v6TimeoutGate,
  v6WagerGate,
} from './v6-state.js';
import {
  clearWalletClaimIntentHref,
  normalizeWalletPositionPage,
  reconcileWalletPositionSnapshot,
  WalletPositionRetryError,
  walletClaimTarget,
  walletClaimIntentFromHref,
  walletClaimSummary,
  walletPositionPageWindow,
  walletPositionPresentation,
} from './wallet-positions.js';

const $ = (selector) => document.querySelector(selector);

const WINDOW_CONFIG = Object.freeze({
  ROUND: { label: 'ACTIVE ROUND', intervalMs: 60_000, pointCount: 180, returnLookback: 20 },
  '1H': { label: '1 HOUR', intervalMs: 30_000, pointCount: 160, returnLookback: 120 },
  '4H': { label: '4 HOURS', intervalMs: 120_000, pointCount: 180, returnLookback: 120 },
  '1D': { label: '1 DAY', intervalMs: 600_000, pointCount: 190, returnLookback: 144 },
  '1W': { label: '1 WEEK', intervalMs: 3_600_000, pointCount: 200, returnLookback: 168 },
});

const DEPLOYMENT_REGISTRY = createDeploymentRegistry(import.meta.env);
const ACTIVE_DEPLOYMENT = DEPLOYMENT_REGISTRY.active;
const EXPECTED_CONTRACT_PROTOCOL = ACTIVE_DEPLOYMENT.protocolVersion;
const TARGET_ARENA_WAGERING_MESSAGE = `Wagering requires the verified active ${EXPECTED_CONTRACT_PROTOCOL} StudioNet deployment.`;
const TARGET_V6_POLICY = V6_POLICY;
const ROUND_REFRESH_MS = 15_000;
const WALLET_HISTORY_READ_ATTEMPTS = 2;
const NETWORK_PRESENTATIONS = Object.freeze({
  studionet: Object.freeze({
    label: 'STUDIONET',
    name: 'StudioNet',
    explorerLabel: 'STUDIONET EXPLORER',
    explorerHome: 'https://explorer-studio.genlayer.com/',
    explorerTxBase: 'https://explorer-studio.genlayer.com/tx/',
    requiresFeeReserve: false,
    finalityNotice: 'StudioNet normally finalizes faster, but success is shown only after FINALIZED contract execution and state verification.',
  }),
});
const UNSUPPORTED_NETWORK_PRESENTATION = Object.freeze({
  label: 'GENLAYER',
  name: 'the configured GenLayer network',
  explorerLabel: 'GENLAYER EXPLORER',
  explorerHome: '#',
  explorerTxBase: '',
  requiresFeeReserve: true,
  finalityNotice: 'Success is shown only after FINALIZED contract execution and state verification.',
});
const TERMINAL_ROUND_STATUSES = new Set(['RESOLVED', 'UNDETERMINED', 'TIMED_OUT']);
const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex^="-"])',
].join(',');

const numberFormatters = new Map();

function colorOf(asset) {
  return asset?.visual?.primary || '#b9f35a';
}

function instrumentCode(asset) {
  if (!asset) return '';
  return asset.symbol.split('/')[0];
}

function badgeCode(asset) {
  return String(asset?.symbol || '').split('/')[0];
}

function formatPrice(asset) {
  const digits = Number.isInteger(asset.priceDecimals) ? asset.priceDecimals : 2;
  const key = `${digits}`;
  if (!numberFormatters.has(key)) {
    numberFormatters.set(key, new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }));
  }
  return numberFormatters.get(key).format(asset.price);
}

function signed(value, digits = 2, suffix = '%') {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}${suffix}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatElapsed(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 3) return 'JUST NOW';
  if (seconds < 60) return `${seconds}S AGO`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}H ${minutes}M AGO`;
  }
  return `${Math.floor(seconds / 86400)}D AGO`;
}

function cadenceLabel(market = {}) {
  const cadenceMs = Number(market.displayCadenceMs);
  const channel = String(market.channel || '');
  const transport = String(market.transport || '').toLowerCase();
  const fallback = String(market.quality || '').toLowerCase().includes('fallback')
    || channel.toLowerCase() === 'ticker.price'
    || transport.includes('ticker-price');
  const fallbackLabel = transport === 'binance-rest-ticker-price' ? 'REST FALLBACK' : 'FALLBACK';
  let cadence = '';
  if (Number.isFinite(cadenceMs) && cadenceMs > 0) {
    cadence = cadenceMs >= 1000 && cadenceMs % 1000 === 0
      ? `${cadenceMs / 1000}S`
      : `${cadenceMs}MS`;
  }
  if (fallback) return cadence ? `${cadence} ${fallbackLabel}` : fallbackLabel;
  if (cadence) return cadence;
  const fixedRate = channel.match(/^fixed_rate@(\d+)ms$/i);
  if (fixedRate) return `${fixedRate[1]}MS`;
  if (channel.toLowerCase() === 'real_time') return 'RT';
  return '';
}

function feedPresentation(frame) {
  const market = frame?.market || {};
  if (market.synthetic) return { label: 'DEMO FEED', state: 'demo' };

  const status = String(market.status || '').toLowerCase();
  const quality = String(market.quality || '').toLowerCase();
  const transport = String(market.transport || '').toLowerCase();
  const transportFailure = (market.streamConnected === false && status !== 'connecting')
    || ['error', 'offline', 'disconnected', 'recovering']
      .some((marker) => status.includes(marker) || quality.includes(marker));
  if (transportFailure) return { label: 'STALE FEED', state: 'stale' };
  // An old quote is expected when its market is closed. Prefer that truthful
  // state over age-based degradation while the transport itself remains live.
  if (market.allCarriedForwardOrClosed || status === 'closed') {
    return { label: 'MARKET CLOSED', state: 'closed' };
  }
  const degraded = market.fresh === false
    || ['degraded', 'stale'].some((marker) => status.includes(marker) || quality.includes(marker));
  if (degraded) return { label: 'STALE FEED', state: 'stale' };
  if (status === 'connecting' || transport === 'history' || quality.includes('history')) {
    return { label: 'CONNECTING…', state: 'connecting' };
  }

  const cadence = cadenceLabel(market);
  if (status.includes('no-history') || quality.includes('bootstrap')) {
    return { label: cadence ? `LIVE \u00B7 ${cadence} \u00B7 NO HISTORY` : 'LIVE \u00B7 NO HISTORY', state: 'live' };
  }
  return { label: cadence ? `LIVE \u00B7 ${cadence}` : 'LIVE FEED', state: 'live' };
}

function liveWindowPresentation(frame, feed = feedPresentation(frame)) {
  if (frame?.market?.synthetic) return { label: 'DEMO REPLAY', state: 'demo' };
  if (feed.state === 'closed') return { label: 'STREAM ON · MARKET CLOSED', state: 'closed' };
  if (feed.state === 'stale') return { label: 'STREAM RECONNECTING', state: 'stale' };
  if (feed.state === 'connecting') return { label: 'HISTORY BACKFILL', state: 'connecting' };
  if (String(frame?.market?.status || '').toLowerCase().includes('no-history')) {
    return { label: 'LIVE PRICES \u00B7 NO HISTORY', state: 'live' };
  }
  const cadence = cadenceLabel(frame?.market);
  return { label: cadence ? `LIVE PRICES · ${cadence}` : 'LIVE PRICES', state: 'live' };
}

function marketSessionLabel(value) {
  const session = String(value || '').trim();
  const known = {
    regular: 'REGULAR',
    premarket: 'PRE-MARKET',
    postmarket: 'POST-MARKET',
    overnight: 'OVERNIGHT',
    closed: 'CLOSED',
  };
  const normalized = session.replaceAll(/[_\s-]/g, '').toLowerCase();
  return known[normalized] || (session ? session.replaceAll(/([a-z])([A-Z])/g, '$1 $2').toUpperCase() : 'UNKNOWN');
}

function genuineUpdateAt(asset, frame) {
  const updatedAt = Number(asset?.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : frame?.timestamp;
}

function observationPresentation(frame, asset) {
  if (frame?.market?.synthetic) {
    const replayTime = new Date(frame.timestamp).toISOString().slice(11, 16);
    return {
      session: 'SIMULATED',
      age: `${replayTime} UTC \u00B7 REPLAY`,
      label: `SIMULATED REPLAY \u00B7 ${replayTime} UTC`,
      state: 'demo',
    };
  }

  const session = marketSessionLabel(asset?.marketSession);
  const age = formatElapsed(genuineUpdateAt(asset, frame));
  const feedState = feedPresentation(frame).state;
  const isHistory = frame?.market?.transport === 'history' || asset?.freshness === 'history';
  const noHistory = String(frame?.market?.status || '').toLowerCase().includes('no-history')
    || String(frame?.market?.quality || '').toLowerCase().includes('bootstrap');
  const carriedAsExpected = asset?.carriedForward && feedState !== 'stale';
  const isStale = feedState === 'stale' || asset?.stale || asset?.freshness === 'stale';
  const state = noHistory
    ? 'live'
    : isHistory
    ? (isStale ? 'stale' : 'history')
    : carriedAsExpected
      ? 'carried'
      : isStale ? 'stale' : 'live';
  const condition = isHistory
    ? (isStale ? 'STALE HISTORY SNAPSHOT' : 'HISTORY SNAPSHOT')
    : carriedAsExpected
      ? 'CARRIED FORWARD'
      : isStale ? 'STALE' : 'FRESH';
  const displayedCondition = noHistory ? 'LIVE \u00B7 NO HISTORY \u00B7 METRICS OFF' : condition;
  return {
    session,
    age,
    label: `${session} \u00B7 ${displayedCondition} \u00B7 ${isHistory ? 'CANDLE CLOSE' : 'LAST PRICE UPDATE'} ${age}`,
    state,
  };
}

function formatRoundTime(timestampSeconds) {
  if (!Number.isSafeInteger(timestampSeconds)) return '—';
  const date = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toISOString().replace('T', ' · ').slice(0, 18) + ' UTC';
}

function formatCountdown(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function contractAssetLabel(contractAssetId) {
  if (!contractAssetId) return '--';
  if (contractAssetId === 'TIE') return 'TIE';
  const asset = MARKET_ASSETS.find((candidate) => candidate.contractId === contractAssetId);
  return asset ? instrumentCode(asset).toUpperCase() : contractAssetId.replace(/_USD$/i, '');
}

function displayGen(value, maximumFractionDigits = 4) {
  return typeof value === 'bigint'
    ? `${formatAttoToGen(value, { maximumFractionDigits })} GEN`
    : '— GEN';
}

function prospectivePayout({
  totalPoolAtto,
  selectedPoolAtto,
  existingStakeAtto,
  addedStakeAtto,
  platformFeeBps,
}) {
  if (![totalPoolAtto, selectedPoolAtto, existingStakeAtto, addedStakeAtto].every((value) => typeof value === 'bigint')) {
    return null;
  }
  const winningPool = selectedPoolAtto + addedStakeAtto;
  const userWinningStake = existingStakeAtto + addedStakeAtto;
  if (winningPool <= 0n || userWinningStake <= 0n) return null;
  const losingPool = totalPoolAtto - selectedPoolAtto;
  if (losingPool <= 0n) return userWinningStake;
  const fee = losingPool * BigInt(Number(platformFeeBps) || 0) / 10_000n;
  const payoutPool = totalPoolAtto + addedStakeAtto - fee;
  return userWinningStake * payoutPool / winningPool;
}

function regimeFor(frame) {
  const feed = feedPresentation(frame);
  if (feed.state === 'stale') return 'FEED DEGRADED';
  if (feed.state === 'closed') return 'MARKET CLOSED';
  const averageVolatility = frame.assets.reduce((sum, asset) => sum + asset.volatilityPct, 0) / frame.assets.length;
  const spread = Math.max(...frame.assets.map((asset) => asset.returnPct)) - Math.min(...frame.assets.map((asset) => asset.returnPct));
  if (averageVolatility > 0.18) return 'VOLATILITY EXPANSION';
  if (spread > 1.4) return 'CRYPTO ROTATION';
  if (frame.leader.marginPct < 1.2) return 'BALANCED FLOW';
  return 'PRICE DISCOVERY';
}

function eventMessage(event, frame) {
  const asset = frame?.assets.find((entry) => entry.id === event.assetId);
  const name = asset?.shortName || asset?.symbol || 'The market';
  switch (event.kind) {
    case 'leader_change': return `${name} has overtaken the previous leader and now controls ${asset?.dominancePct.toFixed(1)}% of the arena.`;
    case 'shockwave': return `${name} territory is ${event.direction === 'up' ? 'expanding' : 'contracting'} as relative strength reprices.`;
    case 'breakout': return `${name} momentum has crossed the breakout threshold for this comparison window.`;
    case 'volatility_spike': return `${name} turbulence increased sharply; the liquid boundary is becoming less stable.`;
    default: return `${name} currently has the strongest normalized cross-market score.`;
  }
}

function v6RoundView(epoch, objective, deployment) {
  const objectiveRecord = objective === 'LOW' ? epoch.low : epoch.high;
  return Object.freeze({
    deploymentAlias: deployment.alias,
    contractAddress: deployment.address,
    protocolVersion: deployment.protocolVersion,
    roundId: epoch.epochId,
    epochId: epoch.epochId,
    epochEndTimestamp: epoch.epochEndTimestamp,
    objective,
    objectiveRecord,
    title: `${new Date(epoch.epochEndTimestamp * 1000).toISOString().slice(0, 13)}:00 UTC return battle`,
    status: epoch.status,
    phase: epoch.phase,
    resultStatus: epoch.resultStatus,
    settlementMode: objectiveRecord.settlementMode,
    assetIds: V6_ASSETS,
    entryOpensTimestamp: epoch.wagerOpensTimestamp,
    entryDeadlineTimestamp: epoch.wagerClosesTimestamp,
    battleStartsTimestamp: epoch.battleStartsTimestamp,
    resolutionTimestamp: epoch.epochEndTimestamp,
    resolutionAvailableTimestamp: epoch.resolutionAvailableTimestamp,
    emergencyRefundAvailableTimestamp: epoch.timeoutRefundAvailableTimestamp,
    minStakeAtto: epoch.minStakeAtto,
    maxStakePerWalletAtto: epoch.maxStakePerWalletAtto,
    totalStakeAtto: objectiveRecord.totalStakeAtto,
    participantCount: objectiveRecord.participantCount,
    payoutPoolAtto: objectiveRecord.payoutPoolAtto,
    platformFeeAtto: objectiveRecord.platformFeeAtto,
    platformFeeBps: epoch.platformFeeBpsSnapshot,
    winnerAssetId: objectiveRecord.winnerAssetId,
    winnerReturnPpb: objectiveRecord.winnerReturnPpb,
    qualifiedVenues: epoch.qualifiedVenues,
    venueCount: epoch.venueCount,
    resolutionDigest: epoch.resolutionDigest,
    wageringEnabled: epoch.status === 'OPEN' && epoch.phase === 'WAGER_OPEN',
    epoch,
  });
}

function v6AssetView(raw, objective) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Arena epoch asset is unavailable.');
  const assetId = String(raw.asset_id || '').trim().toUpperCase();
  if (!V6_ASSETS.includes(assetId)) throw new RangeError('Arena epoch asset is unsupported.');
  const totalStakeAtto = BigInt(objective === 'LOW' ? raw.low_stake_atto : raw.high_stake_atto);
  return Object.freeze({
    assetId,
    returnPpb: Number(raw.return_ppb),
    venueReturnsPpb: Object.freeze(Array.isArray(raw.venue_returns_ppb)
      ? raw.venue_returns_ppb.map(Number)
      : []),
    totalStakeAtto,
  });
}

class LiquidityArenaApp {
  constructor() {
    const pageParams = new URLSearchParams(location.search);
    this.deploymentSelectionError = null;
    try {
      this.deployment = DEPLOYMENT_REGISTRY.selectRoute(pageParams.get('deployment'), {
        rawAddress: pageParams.get('contract'),
      });
    } catch (error) {
      this.deployment = ACTIVE_DEPLOYMENT;
      this.deploymentSelectionError = error instanceof Error
        ? error.message
        : 'The requested deployment is not allowlisted.';
    }
    if (!this.deploymentSelectionError && pageParams.get('deployment') !== this.deployment.alias) {
      const canonicalUrl = new URL(location.href);
      canonicalUrl.searchParams.set('deployment', this.deployment.alias);
      history.replaceState(null, '', canonicalUrl);
    }
    this.window = 'ROUND';
    this.feedMode = pageParams.get('feed') === 'demo' ? 'demo' : 'live';
    this.rawFrame = null;
    this.frame = null;
    this.selectedId = 'btc';
    this.selectedPrediction = null;
    this.driver = null;
    this.roundDriver = null;
    this.roundFrame = null;
    this.sharedEventSourceImpl = createSharedEventSourceConstructor();
    this.toastTimer = null;
    this.liveReadyNotified = false;
    const requestedEpoch = String(pageParams.get('epoch') || '').trim();
    const requestedEpochNumber = /^\d{10}$/.test(requestedEpoch) ? Number(requestedEpoch) : null;
    this.explicitEpochEndTimestamp = Number.isSafeInteger(requestedEpochNumber)
      && requestedEpochNumber > 0
      && requestedEpochNumber % 3_600 === 0
      ? requestedEpochNumber
      : null;
    this.roundId = null;
    // `round` is the action target used by every money read/write. The
    // independently loaded display round controls only the ROUND scoreboard.
    this.round = null;
    this.displayRound = null;
    this.displayRoundAssets = Object.freeze([]);
    this.knownEpochEndTimestampsByDeployment = new Map();
    this.roundLoading = false;
    this.roundReadError = false;
    this.roundRequestId = 0;
    this.roundLoadPromise = null;
    this.submittingPrediction = false;
    this.pendingWagerHash = null;
    this.claimingWager = false;
    this.activatingEmergencyRefund = false;
    this.modalNotice = this.deploymentSelectionError;
    const requestedObjective = pageParams.get('objective');
    this.objectiveSelector = requestedObjective?.toLowerCase() === 'lowest'
      ? 'LOW'
      : 'HIGH';
    const routedClaimIntent = walletClaimIntentFromHref(location.href);
    this.pendingClaimIntent = !this.deploymentSelectionError
      && routedClaimIntent?.deploymentAlias === this.deployment.alias
      && routedClaimIntent?.epochEndTimestamp === this.explicitEpochEndTimestamp
      && routedClaimIntent?.objective === this.objectiveSelector
      ? routedClaimIntent
      : null;
    this.contractConfig = null;
    this.contractConfigsByDeployment = new Map();
    this.roundAsset = null;
    this.walletBalanceAtto = null;
    this.entry = null;
    this.claimQuote = null;
    this.onchainPositions = [];
    this.onchainPositionCount = 0;
    this.onchainPositionsByDeployment = new Map();
    this.onchainPositionCountsByDeployment = new Map();
    this.onchainHistoryErrorsByDeployment = new Map();
    this.onchainHistoryAccount = null;
    this.onchainHistoryLoading = false;
    this.onchainHistoryRequestId = 0;
    this.activityStore = createActivityStore();
    this.activityReconcilePromise = null;
    this.positionLoading = false;
    this.positionReadError = false;
    this.positionAuxiliaryReadError = '';
    this.roundAssetReadFailed = false;
    this.walletBalanceReadFailed = false;
    this.positionRequestId = 0;
    this.roundAssetRequestId = 0;
    this.walletConnectionPromise = null;
    this.gateways = new Map(DEPLOYMENT_REGISTRY.all.map((deployment) => [
      deployment.alias,
      new GenLayerGateway({
        contractAddress: deployment.address,
        deploymentAlias: deployment.alias,
        protocolVersion: deployment.protocolVersion,
        newWagersEnabled: deployment.newWagersEnabled,
      }),
    ]));
    this.gateway = this.gateways.get(this.deployment.alias);
    this.networkPresentation = NETWORK_PRESENTATIONS[this.gateway.network]
      || UNSUPPORTED_NETWORK_PRESENTATION;
    this.unsubscribeWallet = this.gateway.onWalletChange(() => this._handleWalletInvalidated());
    this.arena = new LiquidArena($('#arena-canvas'), {
      onSelect: (assetId) => this.selectAsset(assetId),
    });
    this.modalStack = [];
    this.modalRecords = new Map();
    this.modalIsolationSnapshot = null;
    this.redirectingModalFocus = false;

    this._bindEvents();
    if (this.pendingClaimIntent) {
      this._showModal('prediction-modal', { initialFocus: '#claim-reconnect' });
    }
    this._applyNetworkPresentation();
    this._renderPredictionChoices();
    this._updateContractUi();
    this.openWindow(this.window);
    this._updateClock();
    this.clockTimer = setInterval(() => this._updateClock(), 1000);
    this.roundRefreshTimer = setInterval(() => {
      if (this.feedMode === 'live' && this.gateway.configured) {
        void this._loadRound({ background: true });
      }
    }, ROUND_REFRESH_MS);
    void this._reconcileActivity();
    if (this.pendingClaimIntent) void this._resumeClaimIntent();
  }

  _bindEvents() {
    $('#timeframe-controls').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-window]');
      if (button) this.openWindow(button.dataset.window);
    });
    $('#feed-toggle').addEventListener('click', () => this.toggleFeed());

    const selectFromList = (event) => {
      const target = event.target.closest('[data-asset-id]');
      if (target) this.selectAsset(target.dataset.assetId);
    };
    $('#asset-list').addEventListener('click', selectFromList);
    $('#mobile-asset-strip').addEventListener('click', selectFromList);

    $('#play-button').addEventListener('click', () => this.togglePlayback());
    $('#timeline-slider').addEventListener('input', (event) => this.seek(Number(event.target.value) / 1000));
    $('#prediction-button').addEventListener('click', (event) => {
      void this.openPrediction(event.currentTarget);
    });
    $('#selected-orb').addEventListener('click', (event) => {
      void this.openPrediction(event.currentTarget);
    });
    $('#wallet-button').addEventListener('click', () => this.connectWallet());
    $('#submit-prediction').addEventListener('click', () => this.submitPrediction());
    $('#claim-wager').addEventListener('click', () => this.claimWager());
    $('#claim-reconnect')?.addEventListener('click', async () => {
      await this.connectWallet();
    });
    $('#position-refresh')?.addEventListener('click', async () => {
      try {
        await this._loadPositionState();
        this.modalNotice = 'Wallet position verification recovered.';
      } catch (error) {
        this.modalNotice = error instanceof Error
          ? error.message
          : 'Wallet position verification is still unavailable.';
      }
      this._renderPredictionState();
      this._focusClaimSection();
    });
    $('#unlock-refund').addEventListener('click', () => this.unlockEmergencyRefund());
    $('#load-more-positions')?.addEventListener('click', () => this._loadWalletHistory({ append: true }));
    const handleClaimNavigation = (event) => this._handleClaimNavigation(event);
    $('#activity-list')?.addEventListener('click', handleClaimNavigation);
    $('#claim-summary-actions')?.addEventListener('click', handleClaimNavigation);
    $('#wallet-history-errors')?.addEventListener('click', (event) => {
      const retry = event.target.closest('button[data-retry-deployment]');
      if (retry) void this._loadWalletHistory({ deploymentAlias: retry.dataset.retryDeployment });
    });
    $('#how-button').addEventListener('click', (event) => this.openHow(event.currentTarget));
    $('#battle-objective-controls')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-objective]');
      if (button) void this.selectObjective(button.dataset.objective);
    });
    $('#stake-amount').addEventListener('input', () => this._updateSubmitButton());
    $('#stake-presets').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-stake]');
      if (!button) return;
      $('#stake-amount').value = button.dataset.stake;
      this._updateSubmitButton();
    });

    document.querySelectorAll('[data-close-modal]').forEach((node) => {
      node.addEventListener('click', () => this.closePrediction());
    });
    document.querySelectorAll('[data-close-how]').forEach((node) => {
      node.addEventListener('click', () => this.closeHow());
    });
    document.addEventListener('keydown', (event) => this._handleModalKeydown(event), true);
    document.addEventListener('focusin', (event) => this._handleModalFocusIn(event), true);
    document.addEventListener('click', (event) => this._guardModalBackgroundClick(event), true);
    window.addEventListener('popstate', () => this._restoreRouteClaimIntent());
  }

  _modalRecord(modalId) {
    if (this.modalRecords.has(modalId)) return this.modalRecords.get(modalId);
    const layer = document.getElementById(modalId);
    const dialog = layer?.querySelector('[role="dialog"][aria-modal="true"]');
    if (!layer || !dialog) throw new Error(`Accessible modal ${modalId} is not available.`);
    const record = {
      id: modalId,
      layer,
      dialog,
      opener: null,
      generation: 0,
    };
    this.modalRecords.set(modalId, record);
    return record;
  }

  _activeModalRecord() {
    const modalId = this.modalStack.at(-1);
    if (!modalId) return null;
    const record = this._modalRecord(modalId);
    return record.layer.hidden ? null : record;
  }

  _setElementInert(element, inert) {
    element.toggleAttribute('inert', inert);
    if ('inert' in element) element.inert = inert;
  }

  _restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  _applyModalIsolation() {
    const root = $('#market-app');
    const active = this._activeModalRecord();
    if (!root) return;
    if (active && !this.modalIsolationSnapshot) {
      this.modalIsolationSnapshot = Array.from(root.children, (element) => ({
        element,
        inert: element.hasAttribute('inert') || Boolean(element.inert),
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    }
    if (!this.modalIsolationSnapshot) return;

    for (const original of this.modalIsolationSnapshot) {
      if (active) {
        const isolate = original.element !== active.layer;
        this._setElementInert(original.element, original.inert || isolate);
        if (isolate) original.element.setAttribute('aria-hidden', 'true');
        else this._restoreAttribute(original.element, 'aria-hidden', original.ariaHidden);
      } else {
        this._setElementInert(original.element, original.inert);
        this._restoreAttribute(original.element, 'aria-hidden', original.ariaHidden);
      }
    }
    if (!active) this.modalIsolationSnapshot = null;
  }

  _isElementVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    if (element.hidden || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden'
      && element.getClientRects().length > 0;
  }

  _focusableElements(record) {
    const candidates = Array.from(record.dialog.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
      .filter((element) => !element.matches(':disabled')
        && element.tabIndex >= 0
        && this._isElementVisible(element));
    return candidates.filter((element) => {
      if (!(element instanceof HTMLInputElement)
        || element.type !== 'radio'
        || !element.name) return true;
      const group = candidates.filter((candidate) => candidate instanceof HTMLInputElement
        && candidate.type === 'radio'
        && candidate.name === element.name);
      return element === (group.find((candidate) => candidate.checked) || group[0]);
    });
  }

  _focusModal(record, preferredTarget = null) {
    if (record !== this._activeModalRecord()) return;
    let target = preferredTarget;
    if (typeof target === 'string') target = record.layer.querySelector(target);
    if (!this._isElementVisible(target) || target.matches?.(':disabled')) {
      [target] = this._focusableElements(record);
    }
    if (!target) target = record.dialog;
    this.redirectingModalFocus = true;
    try {
      target.focus({ preventScroll: true });
    } finally {
      this.redirectingModalFocus = false;
    }
  }

  _queueModalFocus(record, preferredTarget = null) {
    const generation = record.generation;
    requestAnimationFrame(() => {
      if (record.generation !== generation || record !== this._activeModalRecord()) return;
      this._focusModal(record, preferredTarget);
    });
  }

  _showModal(modalId, { opener = null, initialFocus = null } = {}) {
    const record = this._modalRecord(modalId);
    const wasOpen = !record.layer.hidden && this.modalStack.includes(modalId);
    if (!wasOpen) {
      const candidate = opener || document.activeElement;
      record.opener = candidate instanceof HTMLElement
        && candidate !== document.body
        && candidate.isConnected
        && !record.layer.contains(candidate)
        ? candidate
        : null;
    }
    record.layer.hidden = false;
    record.generation += 1;
    const originalLayerState = this.modalIsolationSnapshot
      ?.find(({ element }) => element === record.layer);
    if (originalLayerState) {
      this._setElementInert(record.layer, originalLayerState.inert);
      this._restoreAttribute(record.layer, 'aria-hidden', originalLayerState.ariaHidden);
    }
    this.modalStack = this.modalStack.filter((id) => id !== modalId);
    this.modalStack.push(modalId);
    // Move focus before hiding the opener's branch from assistive technology;
    // Chromium otherwise rejects aria-hidden when that branch still owns focus.
    this._focusModal(record, initialFocus);
    this._applyModalIsolation();
    this._queueModalFocus(record, initialFocus);
    return record.generation;
  }

  _fallbackModalOpener(modalId) {
    const selectors = modalId === 'how-modal'
      ? ['#how-button', '#prediction-button', '#wallet-button']
      : ['#prediction-button', '#selected-orb', '#wallet-button'];
    return selectors.map((selector) => $(selector)).find((element) =>
      this._isElementVisible(element) && !element.matches(':disabled')) || null;
  }

  _hideModal(modalId) {
    const record = this._modalRecord(modalId);
    if (record.layer.hidden && !this.modalStack.includes(modalId)) return false;
    const opener = record.opener;
    record.opener = null;
    record.generation += 1;
    const closeGeneration = record.generation;
    record.layer.hidden = true;
    this.modalStack = this.modalStack.filter((id) => id !== modalId);
    this._applyModalIsolation();
    const underlying = this._activeModalRecord();

    requestAnimationFrame(() => {
      if (record.generation !== closeGeneration || !record.layer.hidden) return;
      if (underlying && underlying === this._activeModalRecord()) {
        if (this._isElementVisible(opener) && underlying.dialog.contains(opener)) {
          opener.focus({ preventScroll: true });
        } else {
          this._focusModal(underlying);
        }
        return;
      }
      const target = this._isElementVisible(opener) && !opener.matches(':disabled')
        ? opener
        : this._fallbackModalOpener(modalId);
      target?.focus({ preventScroll: true });
    });
    return true;
  }

  _handleModalKeydown(event) {
    const record = this._activeModalRecord();
    if (!record) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (record.id === 'prediction-modal') this.closePrediction();
      else if (record.id === 'how-modal') this.closeHow();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = this._focusableElements(record);
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = currentIndex < 0
      ? event.shiftKey ? focusable.length - 1 : 0
      : (currentIndex + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    event.preventDefault();
    event.stopPropagation();
    this._focusModal(record, focusable[nextIndex] || record.dialog);
  }

  _handleModalFocusIn(event) {
    const record = this._activeModalRecord();
    if (!record || this.redirectingModalFocus || record.dialog.contains(event.target)) return;
    this._focusModal(record);
  }

  _guardModalBackgroundClick(event) {
    const record = this._activeModalRecord();
    if (!record || record.layer.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  _updateClock() {
    $('#session-clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
    if (this.frame?.settlement?.finalized) {
      const targets = selectRoundTargets({
        nowMs: Date.now(),
        explicitEpochEndTimestamp: this.explicitEpochEndTimestamp,
      });
      if (!roundMatchesDisplayTarget(this.displayRound, targets)) {
        this._refreshDisplayedFrame();
      }
    }
    this._renderSelectedObservation();
    this._renderBattleCard();
  }

  _updateContractUi() {
    $('#round-network').textContent = this.gateway.networkLabel;
    this._renderPredictionState();
  }

  _applyNetworkPresentation() {
    const presentation = this.networkPresentation;
    const battleCard = $('#battle-card');
    if (battleCard) {
      battleCard.dataset.targetProtocol = this.deployment.protocolVersion;
      battleCard.dataset.deployment = this.deployment.alias;
      battleCard.dataset.contractAddress = this.deployment.address;
    }
    const description = document.querySelector('meta[name="description"]');
    if (description) {
      description.content = 'Liquidity Arena maps BTC, ETH, BNB, SOL and XRP in exact-hour, 20-minute return battles with transparent provisional evidence.';
    }
    const explorer = $('#network-explorer');
    if (explorer) {
      explorer.href = presentation.explorerHome;
      explorer.textContent = presentation.explorerLabel;
      explorer.hidden = presentation.explorerHome === '#';
    }
    const escrowCopy = $('#network-escrow-copy');
    if (escrowCopy) {
      const role = this.deployment.newWagersEnabled ? 'active' : 'legacy claim-only';
      escrowCopy.textContent = `${this.deployment.protocolVersion} is the ${role} deployment on ${presentation.name}. Claims and refunds are pull-based and transfer only after FINALIZED execution.`;
    }
  }

  _roundGate(contractAssetId = null) {
    if (this.deploymentSelectionError) {
      return {
        allowed: false,
        code: 'DEPLOYMENT_ROUTE_REJECTED',
        message: this.deploymentSelectionError,
      };
    }
    if (!this.deployment.newWagersEnabled) {
      return {
        allowed: false,
        code: 'LEGACY_CLAIM_ONLY',
        message: 'This V6 deployment is claim-only. New wagers are accepted only by the active V7 deployment.',
      };
    }
    if (this.gateway.network !== 'studionet') {
      return {
        allowed: false,
        code: 'STUDIONET_REQUIRED',
        message: 'Test-GEN wagers are enabled only on the verified StudioNet deployment.',
      };
    }
    const market = this.frame?.market;
    const noHistory = this.feedMode === 'live'
      && market?.synthetic === false
      && (String(market.status || '').toLowerCase().includes('no-history')
        || String(market.quality || '').toLowerCase().includes('bootstrap'));
    if (noHistory) {
      return {
        allowed: false,
        code: 'MARKET_HISTORY_UNAVAILABLE',
        message: 'Binance is streaming prices, but its candle history is unavailable. Market metrics and Test-GEN wagers stay disabled until a complete history backfill succeeds.',
      };
    }
    if (this.feedMode !== 'live' || this.frame?.market?.synthetic !== false) {
      return { allowed: false, code: 'LIVE_FEED_REQUIRED', message: 'Switch to the live feed before placing a wager.' };
    }
    if (!this.gateway.wagerConfigured || !this.contractConfig) {
      return { allowed: false, code: 'CONTRACT_UNAVAILABLE', message: TARGET_ARENA_WAGERING_MESSAGE };
    }
    if (this.roundLoading) return { allowed: false, code: 'ROUND_LOADING', message: 'Verifying the exact-hour epoch.' };
    if (this.roundReadError || !this.round) return { allowed: false, code: 'ROUND_UNAVAILABLE', message: this.modalNotice || 'The exact-hour epoch is unavailable.' };
    if (!contractAssetId || !this.round.assetIds.includes(contractAssetId)) {
      return { allowed: false, code: 'ASSET_UNAVAILABLE', message: 'This asset is not in the arena basket.' };
    }
    if (!this.round.wageringEnabled) {
      return { allowed: false, code: 'WAGER_CLOSED', message: `The epoch is ${this.round.phase.replaceAll('_', ' ').toLowerCase()}; wagers are accepted only during WAGER OPEN.` };
    }
    return { allowed: true, code: 'OPEN', message: '' };
  }

  _syncRoundState() {
    if (this.deploymentSelectionError || this.feedMode !== 'live' || !this.gateway.configured) {
      this.roundRequestId += 1;
      this.round = null;
      this.displayRound = null;
      this.displayRoundAssets = Object.freeze([]);
      this.roundLoading = false;
      this.roundReadError = false;
      this.roundLoadPromise = null;
      this.modalNotice = this.deploymentSelectionError;
      this.contractConfig = null;
      this._clearPositionState();
      this._renderPredictionState();
      return;
    }
    this._loadRound();
  }

  async _loadRound(options = {}) {
    if (this.roundLoadPromise) return this.roundLoadPromise;
    const loadPromise = this._readRound(options);
    this.roundLoadPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (this.roundLoadPromise === loadPromise) this.roundLoadPromise = null;
    }
  }

  async _readRound({ background = false } = {}) {
    const requestId = ++this.roundRequestId;
    const hasVerifiedRound = Boolean(this.round);
    let verifiedConfig = null;
    const targets = selectRoundTargets({
      nowMs: Date.now(),
      explicitEpochEndTimestamp: this.explicitEpochEndTimestamp,
    });
    if (!background) this.round = null;
    this.roundLoading = !background || !hasVerifiedRound;
    this.roundReadError = false;
    if (!background) this.modalNotice = null;
    this._renderPredictionState();
    try {
      const reuseVerifiedConfig = background && this.contractConfig !== null;
      const knownEpochs = this.knownEpochEndTimestampsByDeployment.get(this.deployment.alias) || null;
      const sameTarget = targets.actionEpochEndTimestamp === targets.displayEpochEndTimestamp;
      const reuseTerminalDisplay = !sameTarget && canReuseFinalizedDisplayRound(
        this.displayRound,
        this.displayRoundAssets,
        {
          epochEndTimestamp: targets.displayEpochEndTimestamp,
          objective: this.objectiveSelector,
          deploymentAlias: this.deployment.alias,
          protocolVersion: this.deployment.protocolVersion,
          contractAddress: this.deployment.address,
        },
      );
      const [configResult, roundResult, recentEpochsResult] = await Promise.allSettled([
        reuseVerifiedConfig ? Promise.resolve(null) : this.gateway.readConfig(),
        this.gateway.readEpoch(targets.actionEpochEndTimestamp),
        knownEpochs === null
          ? this.gateway.readRecentEpochIds(50)
          : Promise.resolve(null),
      ]);
      if (configResult.status === 'rejected') throw configResult.reason;
      verifiedConfig = reuseVerifiedConfig
        ? this.contractConfig
        : normalizeArenaConfig(configResult.value, {
          expectedProtocol: this.deployment.protocolVersion,
        });
      if (requestId !== this.roundRequestId) return null;
      this.contractConfig = verifiedConfig;
      this.contractConfigsByDeployment.set(this.deployment.alias, verifiedConfig);
      if (roundResult.status === 'rejected') throw roundResult.reason;
      const epoch = normalizeV6Epoch(roundResult.value);
      const round = v6RoundView(epoch, this.objectiveSelector, this.deployment);
      if (recentEpochsResult.status === 'fulfilled' && recentEpochsResult.value) {
        this.knownEpochEndTimestampsByDeployment.set(
          this.deployment.alias,
          new Set(recentEpochsResult.value.epochEndTimestamps),
        );
      }
      this.knownEpochEndTimestampsByDeployment
        .get(this.deployment.alias)?.add(targets.actionEpochEndTimestamp);

      let displayResult = { status: 'fulfilled', value: null };
      const shouldReadDisplay = !sameTarget && !reuseTerminalDisplay && (
        this.explicitEpochEndTimestamp !== null
        || this.knownEpochEndTimestampsByDeployment
          .get(this.deployment.alias)?.has(targets.displayEpochEndTimestamp)
      );
      if (shouldReadDisplay) {
        [displayResult] = await Promise.allSettled([
          this.gateway.readEpoch(targets.displayEpochEndTimestamp),
        ]);
      }

      let nextDisplayRound = reuseTerminalDisplay ? this.displayRound : null;
      let nextDisplayAssets = reuseTerminalDisplay
        ? this.displayRoundAssets
        : Object.freeze([]);
      const displayRaw = sameTarget
        ? roundResult.value
        : (displayResult.status === 'fulfilled' ? displayResult.value : null);
      if (reuseTerminalDisplay) {
        // The action epoch above remains live-polled. Only this distinct,
        // already-verified terminal scoreboard is immutable and reused.
      } else if (displayRaw) {
        try {
          nextDisplayRound = v6RoundView(
            normalizeV6Epoch(displayRaw),
            this.objectiveSelector,
            this.deployment,
          );
          if (isTerminalRound(nextDisplayRound) && nextDisplayRound.epoch.resultStatus === 'DETERMINED') {
            // When this is also the action epoch, its compact record was read
            // above. Reuse a complete agreeing vector instead of spending five
            // additional StudioNet calls.
            if (canReuseFinalizedRoundVector(
              this.displayRound,
              this.displayRoundAssets,
              nextDisplayRound,
            )) {
              nextDisplayAssets = this.displayRoundAssets;
            } else {
              const rawAssets = await Promise.all(V6_ASSETS.map((assetId) =>
                this.gateway.readEpochAsset(targets.displayEpochEndTimestamp, assetId)));
              nextDisplayAssets = Object.freeze(rawAssets.map((asset) =>
                v6AssetView(asset, this.objectiveSelector)));
            }
          }
        } catch {
          // Keep a previously verified copy of this same scoreboard epoch if
          // an individual background RPC request becomes temporarily flaky.
          if (this.displayRound?.epochEndTimestamp === targets.displayEpochEndTimestamp) {
            nextDisplayRound = this.displayRound;
            nextDisplayAssets = this.displayRoundAssets;
          } else {
            nextDisplayRound = null;
            nextDisplayAssets = Object.freeze([]);
          }
        }
      } else if (this.displayRound?.epochEndTimestamp === targets.displayEpochEndTimestamp) {
        nextDisplayRound = this.displayRound;
        nextDisplayAssets = this.displayRoundAssets;
      }
      if (requestId !== this.roundRequestId) return null;
      this.round = round;
      this.roundId = round.roundId;
      this.displayRound = nextDisplayRound;
      this.displayRoundAssets = nextDisplayAssets;
      this._refreshDisplayedFrame();
      // Pool, wallet and claim details are visible only inside this modal.
      // Avoid an otherwise permanent extra StudioNet read every 15 seconds
      // while the public market view is idle.
      if (!$('#prediction-modal').hidden) {
        try {
          await this._loadPositionState({ requestId });
        } catch {
          // Wallet-specific balance/position reads must not invalidate a round
          // whose configuration was already verified independently.
        }
      }
      return round;
    } catch (error) {
      if (requestId !== this.roundRequestId) return null;
      if (!background || this.round?.epochEndTimestamp !== targets.actionEpochEndTimestamp) {
        this.round = null;
      }
      if (!verifiedConfig) this.contractConfig = null;
      this._clearPositionState();
      this.roundReadError = true;
      if (!background || !hasVerifiedRound) {
        this.modalNotice = error instanceof Error
          ? error.message
          : 'The configured GenLayer contract could not be verified.';
      }
      return null;
    } finally {
      if (requestId === this.roundRequestId) {
        this.roundLoading = false;
        this._renderPredictionState();
      }
    }
  }

  _refreshDisplayedFrame() {
    if (!this.rawFrame || this.rawFrame.window !== 'ROUND' || this.window !== 'ROUND') {
      this._renderBattleCard();
      return;
    }
    let frame = this.rawFrame;
    try {
      const targets = selectRoundTargets({
        nowMs: Date.now(),
        explicitEpochEndTimestamp: this.explicitEpochEndTimestamp,
      });
      const displayRound = roundMatchesDisplayTarget(this.displayRound, targets)
        ? this.displayRound
        : null;
      frame = reconcileFinalizedRoundFrame(
        this.rawFrame,
        displayRound,
        this.displayRoundAssets,
      );
    } catch {
      // Never label an incomplete or internally inconsistent vector as final.
      frame = this.rawFrame;
    }
    this.frame = frame;
    if (!frame.assets.some((asset) => asset.id === this.selectedId)) this.selectedId = frame.leader.id;
    this.arena.setFrame(frame);
    this.arena.setSelected(this.selectedId);
    this.renderFrame();
  }

  _clearPositionState() {
    this.positionRequestId += 1;
    this.roundAssetRequestId += 1;
    this.roundAsset = null;
    this.walletBalanceAtto = null;
    this.entry = null;
    this.claimQuote = null;
    this.positionLoading = false;
    this.positionReadError = false;
    this.positionAuxiliaryReadError = '';
    this.roundAssetReadFailed = false;
    this.walletBalanceReadFailed = false;
  }

  _syncPositionAuxiliaryReadError() {
    const failures = [
      this.roundAssetReadFailed ? 'round asset' : '',
      this.walletBalanceReadFailed ? 'wallet balance' : '',
    ].filter(Boolean);
    this.positionAuxiliaryReadError = failures.length > 0
      ? `${failures.join(' and ')} could not be refreshed.`
      : '';
  }

  async _loadWalletHistory({ append = false, deploymentAlias = null } = {}) {
    if (!this.gateway.connected) {
      this.onchainPositions = [];
      this.onchainPositionCount = 0;
      this.onchainPositionsByDeployment.clear();
      this.onchainPositionCountsByDeployment.clear();
      this.onchainHistoryErrorsByDeployment.clear();
      this.onchainHistoryAccount = null;
      this.onchainHistoryLoading = false;
      this.onchainHistoryRequestId += 1;
      this._renderActivity();
      return;
    }
    if (this.onchainHistoryLoading) return;
    const account = this.gateway.account;
    if (this.onchainHistoryAccount !== account) {
      this.onchainPositions = [];
      this.onchainPositionCount = 0;
      this.onchainPositionsByDeployment.clear();
      this.onchainPositionCountsByDeployment.clear();
      this.onchainHistoryErrorsByDeployment.clear();
      this.onchainHistoryAccount = account;
    }
    const historyRequestId = ++this.onchainHistoryRequestId;
    this.onchainHistoryLoading = true;
    this._renderActivity();
    const requestedAlias = deploymentAlias;
    const deployments = requestedAlias
      ? [DEPLOYMENT_REGISTRY.get(requestedAlias)]
      : DEPLOYMENT_REGISTRY.all;
    await Promise.all(deployments.map(async (deployment) => {
      const historyGateway = this.gateways.get(deployment.alias);
      const previous = this.onchainPositionsByDeployment.get(deployment.alias) || [];
      const previousCount = this.onchainPositionCountsByDeployment.get(deployment.alias)
        ?? previous.length;
      try {
        let snapshot = null;
        let appendAttempt = append;
        for (let attempt = 0; attempt < WALLET_HISTORY_READ_ATTEMPTS; attempt += 1) {
          const count = await historyGateway.readWalletPositionCount(account);
          const effectiveAppend = appendAttempt && count === previousCount;
          const window = walletPositionPageWindow({
            total: count,
            loaded: effectiveAppend ? previous.length : 0,
          });
          const rawPage = window.limit > 0
            ? await historyGateway.readWalletPositionPage(account, window.offset, window.limit)
            : {
                account,
                offset: window.offset,
                next_offset: window.offset,
                total: count,
                positions: [],
              };
          try {
            const page = normalizeWalletPositionPage(rawPage, deployment, {
              account,
              offset: window.offset,
              limit: window.limit,
              expectedTotal: count,
            });
            snapshot = reconcileWalletPositionSnapshot({
              previousPositions: previous,
              previousCount,
              nextPage: page,
              observedCount: count,
              append: effectiveAppend,
            });
            break;
          } catch (error) {
            const retryable = error instanceof WalletPositionRetryError || error?.retryable === true;
            if (!retryable || attempt + 1 >= WALLET_HISTORY_READ_ATTEMPTS) throw error;
            if (error.refreshNewest) appendAttempt = false;
          }
        }
        if (!snapshot) throw new Error('Wallet position history could not be verified consistently.');
        if (historyRequestId !== this.onchainHistoryRequestId
          || !this.gateway.connected || this.gateway.account !== account) return;
        this.onchainPositionCountsByDeployment.set(deployment.alias, snapshot.count);
        this.onchainPositionsByDeployment.set(deployment.alias, snapshot.positions);
        this.onchainHistoryErrorsByDeployment.delete(deployment.alias);
      } catch (error) {
        if (historyRequestId !== this.onchainHistoryRequestId
          || !this.gateway.connected || this.gateway.account !== account) return;
        const snapshot = reconcileWalletPositionSnapshot({
          previousPositions: previous,
          previousCount,
          error,
        });
        this.onchainPositionCountsByDeployment.set(deployment.alias, snapshot.count);
        this.onchainPositionsByDeployment.set(deployment.alias, snapshot.positions);
        this.onchainHistoryErrorsByDeployment.set(
          deployment.alias,
          `${deployment.alias.toUpperCase()} position history could not be refreshed. Last verified rows remain visible.`,
        );
      }
    }));
    if (historyRequestId !== this.onchainHistoryRequestId) return;
    if (this.gateway.connected && this.gateway.account === account) this._rebuildWalletHistory();
    this.onchainHistoryLoading = false;
    this._renderActivity();
  }

  _rebuildWalletHistory() {
    this.onchainPositionCount = [...this.onchainPositionCountsByDeployment.values()]
      .reduce((sum, count) => sum + count, 0);
    this.onchainPositions = [...this.onchainPositionsByDeployment.values()]
      .flat()
      .sort((left, right) => right.epochEndTimestamp - left.epochEndTimestamp
        || left.deploymentAlias.localeCompare(right.deploymentAlias));
  }

  async _loadPositionState() {
    if (!this.round) return;
    const positionRequestId = ++this.positionRequestId;
    const roundAssetRequestId = ++this.roundAssetRequestId;
    const round = this.round;
    const account = this.gateway.connected ? this.gateway.account : null;
    this.positionLoading = true;
    this.positionReadError = false;
    this.positionAuxiliaryReadError = '';
    this.roundAssetReadFailed = false;
    this.walletBalanceReadFailed = false;
    this._renderPredictionState();
    try {
      const selectedAsset = getMarketAsset(this.selectedPrediction || this.selectedId);
      const fallbackAssetId = round.assetIds.find((assetId) =>
        MARKET_ASSETS.some((asset) => asset.contractId === assetId));
      const contractAssetId = round.assetIds.includes(selectedAsset?.contractId)
        ? selectedAsset.contractId
        : fallbackAssetId;
      const [assetResult, balanceResult, quoteResult] = await Promise.allSettled([
        contractAssetId
          ? this.gateway.readEpochAsset(round.epochEndTimestamp, contractAssetId)
          : Promise.resolve(null),
        account ? this.gateway.readBalance(account) : Promise.resolve(null),
        account
          ? this.gateway.readEpochClaimQuote(round.epochEndTimestamp, round.objective, account)
          : Promise.resolve(null),
      ]);
      if (positionRequestId !== this.positionRequestId) return;

      if (roundAssetRequestId === this.roundAssetRequestId) {
        try {
          if (assetResult.status !== 'fulfilled' || !assetResult.value) {
            this.roundAsset = null;
            this.roundAssetReadFailed = true;
          } else {
            this.roundAsset = v6AssetView(assetResult.value, round.objective);
            this.roundAssetReadFailed = false;
          }
        } catch {
          this.roundAsset = null;
          this.roundAssetReadFailed = true;
        }
      }
      this.walletBalanceAtto = balanceResult.status === 'fulfilled'
        && typeof balanceResult.value === 'bigint'
        ? balanceResult.value
        : null;
      this.walletBalanceReadFailed = this.walletBalanceAtto === null;
      this._syncPositionAuxiliaryReadError();

      if (account) {
        if (!this.gateway.connected || this.gateway.account?.toLowerCase() !== account.toLowerCase()) return;
        if (quoteResult.status === 'rejected') throw quoteResult.reason;
        if (!quoteResult.value) throw new Error('Wallet claim quote is unavailable.');
        const quote = normalizeVerifiedClaimQuote(quoteResult.value, {
          epochEndTimestamp: round.epochEndTimestamp,
          objective: round.objective,
          account,
        });
        this.entry = quote;
        this.claimQuote = quote;
      } else {
        this.entry = null;
        this.claimQuote = null;
      }
      this.positionReadError = false;
    } catch (error) {
      if (positionRequestId !== this.positionRequestId) return;
      this.entry = null;
      this.claimQuote = null;
      this.positionReadError = true;
      throw error;
    } finally {
      if (positionRequestId === this.positionRequestId) {
        this.positionLoading = false;
        this._renderPredictionState();
      }
    }
  }

  async _refreshRoundAsset() {
    if (!this.round) return;
    const requestId = ++this.roundAssetRequestId;
    const asset = getMarketAsset(this.selectedPrediction || this.selectedId);
    if (!asset?.contractId || !this.round.assetIds.includes(asset.contractId)) {
      this.roundAsset = null;
      this.roundAssetReadFailed = false;
      this._syncPositionAuxiliaryReadError();
      this._renderPredictionState();
      return;
    }
    try {
      const rawAsset = await this.gateway.readEpochAsset(this.round.epochEndTimestamp, asset.contractId);
      if (requestId !== this.roundAssetRequestId) return;
      this.roundAsset = v6AssetView(rawAsset, this.objectiveSelector);
      this.roundAssetReadFailed = false;
      this._syncPositionAuxiliaryReadError();
    } catch {
      if (requestId !== this.roundAssetRequestId) return;
      this.roundAsset = null;
      this.roundAssetReadFailed = true;
      this._syncPositionAuxiliaryReadError();
    } finally {
      if (requestId === this.roundAssetRequestId) this._renderPredictionState();
    }
  }

  _handleWalletInvalidated() {
    this._clearPositionState();
    this.onchainPositions = [];
    this.onchainPositionCount = 0;
    this.onchainPositionsByDeployment.clear();
    this.onchainPositionCountsByDeployment.clear();
    this.onchainHistoryErrorsByDeployment.clear();
    this.onchainHistoryAccount = null;
    this.onchainHistoryLoading = false;
    this.onchainHistoryRequestId += 1;
    $('#wallet-label').textContent = 'CONNECT GENLAYER';
    this.modalNotice = this.pendingClaimIntent
      ? `Reconnect to ${this.networkPresentation.name} to verify and claim this exact position.`
      : `Wallet account or network changed. Reconnect to ${this.networkPresentation.name} before moving test GEN.`;
    this._renderPredictionState();
  }

  _handleClaimNavigation(event) {
    const link = event.target.closest('a[data-claim-deployment][data-claim-epoch][data-claim-objective]');
    if (!link || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const intent = walletClaimIntentFromHref(link.href);
    if (!intent || intent.deploymentAlias !== this.deployment.alias) return;
    event.preventDefault();
    void this._openClaimIntent(intent);
  }

  async _openClaimIntent(intent, { updateRoute = true } = {}) {
    const url = new URL(location.href);
    url.searchParams.delete('contract');
    url.searchParams.set('feed', 'live');
    url.searchParams.set('deployment', intent.deploymentAlias);
    url.searchParams.set('epoch', String(intent.epochEndTimestamp));
    url.searchParams.set('objective', intent.objective === 'LOW' ? 'lowest' : 'highest');
    url.searchParams.set('claim', '1');
    const normalizedIntent = walletClaimIntentFromHref(url.href);
    if (!normalizedIntent || normalizedIntent.deploymentAlias !== this.deployment.alias) return;

    const staleLoad = this.roundLoadPromise;
    const targetChanged = this.explicitEpochEndTimestamp !== normalizedIntent.epochEndTimestamp
      || this.objectiveSelector !== normalizedIntent.objective;
    const feedChanged = this.feedMode !== 'live';
    const modalWasHidden = $('#prediction-modal').hidden;
    this.pendingClaimIntent = normalizedIntent;
    this.explicitEpochEndTimestamp = normalizedIntent.epochEndTimestamp;
    this.objectiveSelector = normalizedIntent.objective;
    if (modalWasHidden) {
      this._showModal('prediction-modal', { initialFocus: '#claim-reconnect' });
    }
    // Replace the current route so browser Back never revives stale in-memory
    // epoch/objective state while the wallet session remains on this page.
    if (updateRoute && url.href !== location.href) history.replaceState(null, '', url);

    if (targetChanged) {
      this.roundRequestId += 1;
      this.round = null;
      this.contractConfig = null;
      this.roundLoading = true;
      this.roundReadError = false;
      this._clearPositionState();
    }
    if (feedChanged) {
      this.feedMode = 'live';
      this.openWindow(this.window);
    } else {
      this._renderPredictionState();
    }
    if (staleLoad) {
      try {
        await staleLoad;
      } catch {
        // A superseded round read is replaced with the exact claim target below.
      }
    }
    if (this.pendingClaimIntent !== normalizedIntent) return;
    if (this.round?.epochEndTimestamp !== normalizedIntent.epochEndTimestamp
      || this.round?.objective !== normalizedIntent.objective) {
      await this._loadRound();
    } else if (modalWasHidden && this.gateway.connected) {
      try {
        await this._loadPositionState();
      } catch {
        // The modal retains its retry/reconnect state if this wallet read fails.
      }
    }
    if (this.pendingClaimIntent !== normalizedIntent) return;
    this.modalNotice = this.gateway.connected
      ? this.positionReadError
        ? `Opened ${this.deployment.alias.toUpperCase()} round ${normalizedIntent.epochEndTimestamp} ${normalizedIntent.objective}, but the wallet position could not be verified. Retry below; claiming remains disabled.`
        : `Opened ${this.deployment.alias.toUpperCase()} round ${normalizedIntent.epochEndTimestamp} ${normalizedIntent.objective}. Verify the amount below before claiming.`
      : `Reconnect your ${this.networkPresentation.name} wallet to verify and claim this exact ${normalizedIntent.objective} position.`;
    this._renderPredictionState();
    this._focusClaimSection();
  }

  async _resumeClaimIntent() {
    if (!this.pendingClaimIntent) return;
    await this._openClaimIntent(this.pendingClaimIntent, { updateRoute: false });
  }

  _restoreRouteClaimIntent() {
    const intent = walletClaimIntentFromHref(location.href);
    if (!intent) {
      this.pendingClaimIntent = null;
      this._renderPredictionState();
      return;
    }
    if (intent.deploymentAlias !== this.deployment.alias) {
      location.reload();
      return;
    }
    void this._openClaimIntent(intent, { updateRoute: false });
  }

  _clearClaimIntentRoute() {
    if (!this.pendingClaimIntent && !new URL(location.href).searchParams.has('claim')) return;
    this.pendingClaimIntent = null;
    history.replaceState(null, '', clearWalletClaimIntentHref(location.href));
  }

  _focusClaimSection() {
    const record = this._modalRecord('prediction-modal');
    const modalGeneration = record.generation;
    requestAnimationFrame(() => {
      if (record.generation !== modalGeneration || record !== this._activeModalRecord()) return;
      const section = $('#wallet-position');
      const reconnect = $('#claim-reconnect');
      const claim = $('#claim-wager');
      const refresh = $('#position-refresh');
      const focusTarget = reconnect && !reconnect.hidden
        ? reconnect
        : claim && !claim.disabled
          ? claim
          : refresh && !refresh.hidden ? refresh : section;
      section?.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      focusTarget?.focus({ preventScroll: true });
    });
  }

  async selectObjective(nextObjective) {
    if (!['HIGH', 'LOW'].includes(nextObjective) || nextObjective === this.objectiveSelector) return;
    this._clearClaimIntentRoute();
    const staleLoad = this.roundLoadPromise;
    this.objectiveSelector = nextObjective;
    // Invalidate any background read that started for the previous objective.
    // Wait for its shared promise to release before starting the requested read;
    // otherwise _loadRound() would reuse the stale LOW/HIGH request.
    this.roundRequestId += 1;
    const url = new URL(location.href);
    url.searchParams.set('objective', nextObjective === 'LOW' ? 'lowest' : 'highest');
    history.replaceState(null, '', url);
    this.round = null;
    this.contractConfig = null;
    this.roundLoading = true;
    this.roundReadError = false;
    this.modalNotice = null;
    this._clearPositionState();
    this._renderPredictionState();
    if (staleLoad) {
      try {
        await staleLoad;
      } catch {
        // The superseded read is intentionally ignored; the requested
        // objective gets a fresh authoritative read immediately below.
      }
    }
    if (this.objectiveSelector !== nextObjective) return;
    await this._loadRound();
  }

  _stakeValidation(contractAssetId = getMarketAsset(this.selectedPrediction)?.contractId) {
    let amount;
    try {
      amount = parseGenToAtto($('#stake-amount').value, { rejectZero: true });
    } catch (error) {
      return { allowed: false, amount: null, message: error.message };
    }
    const gate = v6WagerGate({
      epoch: this.round?.epoch,
      entry: this.entry,
      objective: this.objectiveSelector,
      assetId: contractAssetId,
      amountAtto: amount,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!gate.allowed) return { allowed: false, amount, message: gate.reason };
    if (this.walletBalanceAtto !== null) {
      const insufficient = this.networkPresentation.requiresFeeReserve
        ? this.walletBalanceAtto <= amount
        : this.walletBalanceAtto < amount;
      if (insufficient) {
        const message = this.networkPresentation.requiresFeeReserve
          ? 'Wallet balance must exceed the wager so GEN remains available for network fees.'
          : 'Wallet balance must cover the full test-GEN wager.';
        return { allowed: false, amount, message };
      }
    }
    return { allowed: true, amount, message: '' };
  }

  _walletClaimOverview() {
    const connected = Boolean(this.gateway.account);
    const positions = connected ? this.onchainPositions : [];
    const summary = walletClaimSummary(positions);
    const loadedCount = positions.length;
    const knownCount = connected ? this.onchainPositionCount : 0;
    const failedDeploymentCount = connected
      ? this.onchainHistoryErrorsByDeployment.size
      : 0;
    const incomplete = connected && knownCount > loadedCount;
    const refreshing = connected && this.onchainHistoryLoading;
    const uncertain = failedDeploymentCount > 0 || refreshing;
    const lowerBound = incomplete && !uncertain;
    const partial = incomplete || uncertain;
    return Object.freeze({
      summary,
      loadedCount,
      knownCount,
      failedDeploymentCount,
      incomplete,
      refreshing,
      uncertain,
      lowerBound,
      partial,
    });
  }

  _renderPrimaryPredictionCta(gate = this._roundGate(
    getMarketAsset(this.selectedPrediction || this.selectedId)?.contractId,
  )) {
    const button = $('#prediction-button');
    const kicker = $('#prediction-kicker');
    const label = $('#prediction-label');
    const availability = $('#prediction-availability');
    const overview = this._walletClaimOverview();
    const { summary } = overview;
    const historyNeedsAttention = overview.partial;
    button.disabled = Boolean(this.deploymentSelectionError)
      || (this.roundLoading && summary.count === 0 && !historyNeedsAttention);
    button.dataset.claimSummary = summary.count > 0
      ? (historyNeedsAttention ? 'partial' : 'ready')
      : (historyNeedsAttention ? 'check' : 'none');
    button.dataset.verification = overview.uncertain
      ? 'last-verified'
      : historyNeedsAttention
        ? 'partial'
        : 'verified';
    if (summary.count > 0) {
      const kinds = [
        summary.refundCount > 0
          ? `${summary.refundCount} REFUND${summary.refundCount === 1 ? '' : 'S'}`
          : '',
        summary.payoutCount > 0
          ? `${summary.payoutCount} PAYOUT${summary.payoutCount === 1 ? '' : 'S'}`
          : '',
      ].filter(Boolean);
      const countAndKinds = kinds.length === 1
        ? kinds[0]
        : `${summary.count} · ${kinds.join(' + ')}`;
      kicker.textContent = historyNeedsAttention
        ? `WALLET CLAIMS · ${overview.failedDeploymentCount > 0
          ? 'LAST VERIFIED / PARTIAL'
          : overview.refreshing
            ? 'LAST VERIFIED / REFRESHING'
            : 'PARTIAL HISTORY'}`
        : 'WALLET CLAIMS · VERIFIED ON-CHAIN';
      label.textContent = overview.uncertain
        ? `REVIEW ${countAndKinds} · ${displayGen(summary.amountAtto, 6)} LAST VERIFIED`
        : overview.lowerBound
          ? `CLAIM AT LEAST ${countAndKinds} · ≥${displayGen(summary.amountAtto, 6)}`
          : `CLAIM ${countAndKinds} · ${displayGen(summary.amountAtto, 6)}`;
      availability.textContent = overview.failedDeploymentCount > 0
        ? 'One or more deployment histories could not be refreshed. These claims are last verified; retry history before treating this as the complete wallet total.'
        : overview.refreshing
          ? 'Wallet history is refreshing. Displayed claim candidates are last verified and must be refreshed before treating them as currently available.'
          : overview.incomplete
            ? `Showing ${overview.loadedCount} of ${overview.knownCount} known positions. Open the claim panel to claim these rows or load older positions before treating the aggregate as complete.`
            : 'Verified refunds or payouts are ready. Open the claim panel and choose the exact position.';
      availability.dataset.state = historyNeedsAttention ? 'closed' : 'open';
      button.title = overview.uncertain
        ? `${summary.count} last-verified wallet claim candidate${summary.count === 1 ? '' : 's'}; refresh before signing`
        : historyNeedsAttention
          ? `${summary.count} loaded wallet claim${summary.count === 1 ? '' : 's'}; history is incomplete`
        : `${summary.count} wallet claim${summary.count === 1 ? '' : 's'} ready`;
      return;
    }
    if (historyNeedsAttention) {
      kicker.textContent = overview.failedDeploymentCount > 0
        ? 'WALLET CLAIMS · HISTORY RETRY REQUIRED'
        : overview.incomplete
          ? 'WALLET CLAIMS · PARTIAL HISTORY'
          : 'WALLET CLAIMS · REFRESHING';
      label.textContent = overview.failedDeploymentCount > 0
        ? 'CHECK / RETRY CLAIM HISTORY'
        : overview.incomplete
          ? `CHECK ${Math.max(0, overview.knownCount - overview.loadedCount)} OLDER POSITION${overview.knownCount - overview.loadedCount === 1 ? '' : 'S'} FOR CLAIMS`
          : 'CHECKING WALLET CLAIMS';
      availability.textContent = overview.failedDeploymentCount > 0
        ? 'A deployment history is unavailable, so zero loaded claims does not prove that no refund or payout exists. Open the claim panel and retry.'
        : overview.incomplete
          ? `Only ${overview.loadedCount} of ${overview.knownCount} known positions are loaded. Open the claim panel and load older rows before concluding there is nothing to claim.`
          : 'Wallet history is refreshing. Open the claim panel to watch verification progress.';
      availability.dataset.state = 'closed';
      button.title = 'Wallet claim history is incomplete; open to retry or load older positions';
      return;
    }
    kicker.textContent = `${this.deployment.alias.toUpperCase()} · ${this.objectiveSelector} RETURN · TEST GEN`;
    label.textContent = this.roundLoading
      ? 'VERIFYING EPOCH'
      : this.round?.wageringEnabled
        ? `PLACE ${this.deployment.alias.toUpperCase()} WAGER`
        : 'VIEW POSITION / CLAIM';
    availability.textContent = this.roundLoading
      ? `Reading the ${this.deployment.alias.toUpperCase()} epoch and exact contract configuration.`
      : gate.allowed
        ? `Wagering closes ${formatRoundTime(this.round.entryDeadlineTimestamp)}. Fee snapshot: ${(this.round.platformFeeBps / 100).toFixed(2)}% of the losing pool only.`
        : (this.modalNotice || gate.message);
    availability.dataset.state = gate.allowed ? 'open' : 'closed';
    button.removeAttribute('title');
  }

  _renderPredictionState() {
    const schedule = arenaEpochState(Date.now());
    const target = schedule.operationalEpoch;
    document.querySelectorAll('#battle-objective-controls button[data-objective]').forEach((button) => {
      const active = button.dataset.objective === this.objectiveSelector;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = this.roundLoading || Boolean(this.deploymentSelectionError);
    });
    const direction = this.objectiveSelector === 'LOW' ? 'lowest' : 'highest';
    $('#prediction-title').textContent = `Which asset finishes with the ${direction} return?`;
    $('#prediction-rule-copy').textContent = 'Choose one asset for this objective. Same-asset top-ups are allowed until the immutable wager close; switching assets is not.';
    $('#prediction-legend').textContent = `${this.objectiveSelector} RETURN PICK`;
    $('#how-resolution-title').textContent = `Live leaders are provisional; ${this.deployment.alias.toUpperCase()} settles funds`;
    $('#how-resolution-copy').textContent = `The live ROUND map uses Binance boundary data for immediate feedback. ${this.deployment.protocolVersion} independently evaluates ${TARGET_V6_POLICY} across five exchanges; only its FINALIZED result controls claims.`;
    const displayedEpoch = this.round?.epochEndTimestamp || Math.floor(target.battleEndMs / 1000);
    $('#round-id').textContent = `#${this.round?.roundId || target.epochId}`;
    $('#round-entry-deadline').textContent = formatRoundTime(this.round?.entryDeadlineTimestamp || Math.floor(target.wagerCloseMs / 1000));
    $('#round-resolution').textContent = formatRoundTime(this.round?.resolutionAvailableTimestamp || displayedEpoch + 120);
    $('#round-phase').textContent = this.round
      ? `${this.round.phase.replaceAll('_', ' ')} · ON-CHAIN`
      : `${schedule.operationalPhase.replaceAll('_', ' ')} · AWAITING CONTRACT`;

    const selectedContractId = getMarketAsset(this.selectedPrediction || this.selectedId)?.contractId;
    const gate = this._roundGate(selectedContractId);
    this._renderPrimaryPredictionCta(gate);

    document.querySelectorAll('input[name="prediction-asset"]').forEach((input) => {
      const asset = getMarketAsset(input.value);
      const assetAllowed = Boolean(this.round?.assetIds.includes(asset?.contractId));
      input.disabled = !gate.allowed || !assetAllowed || Boolean(
        this.entry?.choiceAssetId && this.entry.choiceAssetId !== asset?.contractId,
      );
      input.closest('.prediction-option')?.classList.toggle('unavailable', input.disabled);
      input.closest('.prediction-option')?.setAttribute('title', input.disabled ? gate.message : '');
    });

    const stake = this._stakeValidation(selectedContractId);
    const submit = $('#submit-prediction');
    submit.disabled = this.submittingPrediction || !gate.allowed || !stake.allowed || !this.selectedPrediction;
    submit.querySelector('span').textContent = this.submittingPrediction
      ? 'AWAITING FINALIZED EXECUTION…'
      : this.selectedPrediction
        ? `WAGER ${this.objectiveSelector} · ${instrumentCode(getMarketAsset(this.selectedPrediction))}`
        : 'SELECT AN ASSET';
    $('#stake-error').textContent = gate.allowed && !stake.allowed ? stake.message : '';
    $('#modal-status').textContent = (this.positionAuxiliaryReadError && this.claimQuote
        ? `Claim-critical position data remains verified; ${this.positionAuxiliaryReadError}`
        : '')
      || this.modalNotice
      || (gate.allowed ? this.networkPresentation.finalityNotice : gate.message);
    this._renderWagerFinancials(stake, selectedContractId);
    this._renderBattleCard();
  }

  _renderWagerFinancials(stake, selectedContractId) {
    $('#wallet-balance').textContent = displayGen(this.walletBalanceAtto, 6);
    $('#round-pool').textContent = displayGen(this.round?.totalStakeAtto, 6);
    const selectedPool = this.roundAsset && this.roundAsset.assetId === selectedContractId
      ? this.roundAsset.totalStakeAtto
      : null;
    $('#selected-pool').textContent = displayGen(selectedPool, 6);
    const existingStake = this.entry && this.entry.choiceAssetId === selectedContractId
      ? this.entry.stakeAtto
      : 0n;
    const estimate = this.round && stake.allowed && selectedPool !== null
      ? prospectivePayout({
          totalPoolAtto: this.round.totalStakeAtto,
          selectedPoolAtto: selectedPool,
          existingStakeAtto: existingStake,
          addedStakeAtto: stake.amount,
          platformFeeBps: this.round.platformFeeBps,
        })
      : null;
    $('#estimated-payout').textContent = displayGen(estimate, 6);

    const claim = this.positionLoading
      ? { allowed: false, reason: 'Verifying position.' }
      : this.positionReadError
        ? { allowed: false, reason: 'Position could not be verified.' }
        : v6ClaimGate(this.claimQuote);
    const position = $('#wallet-position');
    const claimButton = $('#claim-wager');
    const reconnectButton = $('#claim-reconnect');
    const positionRefresh = $('#position-refresh');
    const unlockButton = $('#unlock-refund');
    $('#position-choice').textContent = contractAssetLabel(this.entry?.choiceAssetId);
    $('#position-stake').textContent = displayGen(this.entry?.stakeAtto, 6);
    $('#position-claimable').textContent = displayGen(this.claimQuote?.amountAtto, 6);
    reconnectButton.hidden = !this.pendingClaimIntent || this.gateway.connected;
    reconnectButton.disabled = Boolean(this.walletConnectionPromise);
    reconnectButton.textContent = this.pendingClaimIntent
      ? `RECONNECT WALLET TO CLAIM ${this.pendingClaimIntent.objective} POSITION`
      : 'RECONNECT WALLET TO VERIFY & CLAIM';
    positionRefresh.hidden = !this.gateway.connected || !this.positionReadError;
    positionRefresh.disabled = this.positionLoading;
    claimButton.disabled = this.claimingWager || this.submittingPrediction || this.activatingEmergencyRefund || !claim.allowed;
    if (this.claimingWager) {
      position.dataset.state = 'pending';
      $('#position-state').textContent = 'VERIFYING DELIVERY';
      claimButton.textContent = 'WAITING FOR CLAIM + CHILD TRANSFER…';
    } else if (claim.allowed) {
      position.dataset.state = 'claimable';
      $('#position-state').textContent = this.claimQuote.settlementMode?.startsWith('REFUND_') ? 'REFUND AVAILABLE' : 'PAYOUT AVAILABLE';
      claimButton.textContent = `${this.claimQuote.settlementMode?.startsWith('REFUND_') ? 'CLAIM REFUND' : 'CLAIM PAYOUT'} · ${displayGen(this.claimQuote.amountAtto, 6)}`;
    } else {
      const hasPosition = (this.entry?.stakeAtto || 0n) > 0n;
      position.dataset.state = hasPosition ? 'position' : 'empty';
      $('#position-state').textContent = this.positionLoading
        ? 'VERIFYING'
        : this.entry?.claimed
          ? 'CLAIMED'
          : this.gateway.connected
            ? (hasPosition ? 'POSITION RECORDED' : 'NO POSITION')
            : this.pendingClaimIntent ? 'RECONNECT TO CLAIM' : 'CONNECT WALLET';
      claimButton.textContent = claim.reason.toUpperCase();
    }
    const emergency = this.round
      ? v6TimeoutGate(this.round.epoch, Math.floor(Date.now() / 1000))
      : { allowed: false, reason: 'Epoch is unavailable.' };
    unlockButton.hidden = !this.contractConfig
      || this.round?.status !== 'OPEN'
      || this.round?.phase !== 'TIMEOUT_AVAILABLE';
    unlockButton.disabled = this.activatingEmergencyRefund
      || this.claimingWager
      || this.submittingPrediction
      || !emergency.allowed;
    unlockButton.textContent = this.activatingEmergencyRefund
      ? 'FINALIZING PRINCIPAL UNLOCK…'
      : emergency.allowed
        ? 'UNLOCK PRINCIPAL REFUNDS'
        : emergency.reason.toUpperCase();
    this._renderActivity(claim);
  }

  _recordActivity(record) {
    try {
      this.activityStore.upsert({
        ...record,
        account: record.account || this.gateway.account,
        contractAddress: record.contractAddress || this.gateway.contractAddress,
        deploymentAlias: record.deploymentAlias || this.deployment.alias,
      });
    } catch {
      // Recovery UX must never interrupt the wallet transaction itself.
    }
    this._renderActivity();
  }

  async _reconcileActivity() {
    if (this.activityReconcilePromise || !this.gateway.configured) return this.activityReconcilePromise;
    const terminalFailures = new Set([
      'CANCELED', 'UNDETERMINED', 'VALIDATORS_TIMEOUT', 'LEADER_TIMEOUT',
    ]);
    const records = this.activityStore.list({ limit: 50 }).filter((record) => record.status !== 'FINALIZED'
      || (record.type === 'CLAIM' && record.deliveryStatus !== 'DELIVERED'));
    this.activityReconcilePromise = Promise.all(records.map(async (record) => {
      let deployment;
      try {
        deployment = DEPLOYMENT_REGISTRY.resolveIdentity({
          alias: record.deploymentAlias,
          address: record.contractAddress,
        });
      } catch {
        return;
      }
      const recordGateway = this.gateways.get(deployment.alias);
      if (!recordGateway?.configured) return;
      try {
        const transaction = await recordGateway.readTransaction(record.hash);
        const status = String(transaction?.statusName || transaction?.status_name || '').toUpperCase();
        let executionSucceeded = false;
        if (status === 'FINALIZED') {
          try {
            assertFinalizedExecution(transaction);
            executionSucceeded = true;
          } catch {
            executionSucceeded = false;
          }
        }
        if (status === 'FINALIZED' && executionSucceeded) {
          let verified = false;
          if (record.type === 'WAGER') {
            const entry = await recordGateway.readEpochEntry(
              Number(record.roundId),
              record.objective,
              record.account,
            );
            verified = BigInt(entry?.stake_atto || 0) > 0n
              && String(entry?.choice_asset_id || '').toUpperCase() === record.assetId;
          } else if (record.type === 'CLAIM') {
            const entry = await recordGateway.readEpochEntry(
              Number(record.roundId),
              record.objective,
              record.account,
            );
            const claimedAtto = BigInt(
              entry?.claimed_amount_atto ?? entry?.claimed_atto ?? 0,
            );
            const signingQuoteText = record.quotedAmountAtto ?? record.amountAtto;
            const signingQuoteAtto = signingQuoteText === null
              ? null
              : BigInt(signingQuoteText);
            const parentStateVerified = entry?.claimed === true
              && claimedAtto > 0n
              && (signingQuoteAtto === null || claimedAtto >= signingQuoteAtto);
            if (parentStateVerified) {
              try {
                const delivery = await recordGateway.verifyClaimDelivery(record.hash, {
                  recipient: record.account,
                  minimumValueAtto: claimedAtto,
                  parentTransaction: transaction,
                  expectedChildHash: record.childHash,
                  discoveryRetries: 0,
                  finalityRetries: 0,
                });
                this.activityStore.upsert({
                  ...record,
                  deploymentAlias: deployment.alias,
                  quotedAmountAtto: signingQuoteAtto?.toString() ?? null,
                  amountAtto: claimedAtto.toString(),
                  childHash: delivery.childHash,
                  deliveryStatus: 'DELIVERED',
                  status: 'FINALIZED',
                });
                return;
              } catch (error) {
                this.activityStore.upsert({
                  ...record,
                  deploymentAlias: deployment.alias,
                  quotedAmountAtto: signingQuoteAtto?.toString() ?? null,
                  amountAtto: claimedAtto.toString(),
                  childHash: error?.childHash || record.childHash,
                  deliveryStatus: 'REVIEW',
                  status: 'REVIEW',
                });
                return;
              }
            }
            if (entry?.claimed === true && claimedAtto > 0n) {
              this.activityStore.upsert({
                ...record,
                deploymentAlias: deployment.alias,
                quotedAmountAtto: signingQuoteAtto?.toString() ?? null,
                amountAtto: claimedAtto.toString(),
                deliveryStatus: 'REVIEW',
                status: 'REVIEW',
              });
              return;
            }
          } else if (record.type === 'TIMEOUT_REFUND') {
            const epoch = await recordGateway.readEpoch(Number(record.roundId));
            verified = String(epoch?.status || '').toUpperCase() === 'TIMED_OUT'
              && String(epoch?.result_status || '').toUpperCase() === 'TIMEOUT';
          }
          this.activityStore.upsert({
            ...record,
            deploymentAlias: deployment.alias,
            status: verified ? 'FINALIZED' : 'REVIEW',
          });
        } else if (status === 'FINALIZED' || terminalFailures.has(status)) {
          this.activityStore.upsert({ ...record, deploymentAlias: deployment.alias, status: 'REVIEW' });
        }
      } catch {
        // The hash remains visible for manual explorer recovery if RPC reads fail.
      }
    })).finally(() => {
      this.activityReconcilePromise = null;
      this._renderActivity();
    });
    return this.activityReconcilePromise;
  }

  _renderActivity(claim = null) {
    const list = $('#activity-list');
    const empty = $('#activity-empty');
    const reminder = $('#claim-reminder');
    if (!list || !empty || !reminder) return;
    const records = this.gateway.account ? this.activityStore.list({
      account: this.gateway.account,
      limit: 12,
    }) : [];
    const positions = this.gateway.account ? this.onchainPositions : [];
    const claimOverview = this._walletClaimOverview();
    const claimable = claimOverview.summary;
    const loadMore = $('#load-more-positions');
    if (loadMore) {
      const remaining = Math.max(0, this.onchainPositionCount - positions.length);
      const nextLoadCount = DEPLOYMENT_REGISTRY.all.reduce((sum, deployment) => {
        const deploymentPositions = this.onchainPositionsByDeployment.get(deployment.alias) || [];
        const deploymentCount = this.onchainPositionCountsByDeployment.get(deployment.alias)
          ?? deploymentPositions.length;
        return sum + walletPositionPageWindow({
          total: deploymentCount,
          loaded: deploymentPositions.length,
        }).limit;
      }, 0);
      loadMore.hidden = !this.gateway.account || remaining === 0;
      loadMore.disabled = this.onchainHistoryLoading;
      loadMore.dataset.loadCount = String(nextLoadCount);
      loadMore.textContent = this.onchainHistoryLoading
        ? `LOADING UP TO ${nextLoadCount} OLDER POSITION${nextLoadCount === 1 ? '' : 'S'}…`
        : `LOAD UP TO ${nextLoadCount} OLDER POSITION${nextLoadCount === 1 ? '' : 'S'} · ${remaining} REMAIN`;
    }
    const claimSummary = $('#claim-summary');
    const claimSummaryActions = $('#claim-summary-actions');
    claimSummary.hidden = claimable.count === 0;
    claimSummary.dataset.verification = claimOverview.uncertain
      ? 'last-verified'
      : claimOverview.incomplete
        ? 'partial'
        : 'verified';
    $('#claim-summary-total').textContent = claimOverview.uncertain
      ? `${displayGen(claimable.amountAtto, 6)} · LAST VERIFIED`
      : `${claimOverview.lowerBound ? '≥' : ''}${displayGen(claimable.amountAtto, 6)}`;
    const claimKinds = [
      claimable.refundCount > 0
        ? `${claimable.refundCount} refund${claimable.refundCount === 1 ? '' : 's'}`
        : '',
      claimable.payoutCount > 0
        ? `${claimable.payoutCount} payout${claimable.payoutCount === 1 ? '' : 's'}`
        : '',
    ].filter(Boolean).join(' + ');
    const claimSummaryCopy = claimable.count === 0
      ? ''
      : claimOverview.failedDeploymentCount > 0
        ? `${claimable.count} position${claimable.count === 1 ? ' was' : 's were'} last verified as claimable (${claimKinds}). Availability may have changed elsewhere; retry failed history, and every opened row gets an exact fresh quote before signing.`
        : claimOverview.refreshing
          ? `${claimable.count} last-verified position${claimable.count === 1 ? ' is' : 's are'} shown (${claimKinds}) while wallet history refreshes. Availability may have changed elsewhere; opening one refreshes its exact quote before signing.`
          : claimOverview.incomplete
            ? `${claimable.count} loaded position${claimable.count === 1 ? ' is' : 's are'} ready (${claimKinds}). This is a lower bound from ${claimOverview.loadedCount} of ${claimOverview.knownCount} known positions; load older rows for a complete aggregate.`
            : `${claimable.count} verified on-chain position${claimable.count === 1 ? ' is' : 's are'} ready (${claimKinds}). Each claim still requires your wallet confirmation.`;
    $('#claim-summary-copy').textContent = claimSummaryCopy;
    claimSummaryActions.replaceChildren();
    for (const entry of claimable.positions) {
      const positionDeployment = DEPLOYMENT_REGISTRY.get(entry.deploymentAlias);
      const presentation = walletPositionPresentation(entry, positionDeployment, location.href);
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      const action = document.createElement('a');
      action.className = 'claim-summary-action';
      action.href = presentation.href;
      action.dataset.claimDeployment = positionDeployment.alias;
      action.dataset.claimEpoch = String(presentation.claimTarget.epochEndTimestamp);
      action.dataset.claimObjective = presentation.claimTarget.objective;
      const claimKind = entry.settlementMode.startsWith('REFUND_') ? 'REFUND' : 'PAYOUT';
      const crossDeployment = positionDeployment.alias !== this.deployment.alias;
      action.textContent = crossDeployment
        ? `OPEN ${positionDeployment.alias.toUpperCase()} & RECONNECT TO CLAIM · ${displayGen(entry.amountAtto, 6)}`
        : `CLAIM ${claimKind} · ${displayGen(entry.amountAtto, 6)}`;
      action.setAttribute(
        'aria-label',
        crossDeployment
          ? `Open ${positionDeployment.alias.toUpperCase()} and reconnect to claim ${claimKind.toLowerCase()} of ${displayGen(entry.amountAtto, 6)} for ${contractAssetLabel(entry.choiceAssetId)} ${entry.objective}, round ${entry.epochEndTimestamp}`
          : `Claim ${claimKind.toLowerCase()} of ${displayGen(entry.amountAtto, 6)} for ${contractAssetLabel(entry.choiceAssetId)} ${entry.objective}, round ${entry.epochEndTimestamp}, ${positionDeployment.alias.toUpperCase()}`,
      );
      const detail = document.createElement('span');
      detail.textContent = `${positionDeployment.alias.toUpperCase()} · ${contractAssetLabel(entry.choiceAssetId)} ${entry.objective} · ROUND ${entry.epochEndTimestamp}`;
      row.append(action, detail);
      claimSummaryActions.append(row);
    }
    const historyErrors = $('#wallet-history-errors');
    historyErrors.replaceChildren();
    for (const [deploymentAlias, message] of this.onchainHistoryErrorsByDeployment) {
      const row = document.createElement('p');
      const copy = document.createElement('span');
      copy.textContent = message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.dataset.retryDeployment = deploymentAlias;
      retry.disabled = this.onchainHistoryLoading;
      retry.textContent = `RETRY ${deploymentAlias.toUpperCase()} HISTORY`;
      row.append(copy, retry);
      historyErrors.append(row);
    }
    historyErrors.hidden = this.onchainHistoryErrorsByDeployment.size === 0;
    list.replaceChildren();
    empty.hidden = records.length > 0 || positions.length > 0;
    reminder.hidden = claim?.allowed !== true;
    if (claim?.allowed === true) {
      reminder.textContent = this.claimQuote?.settlementMode?.startsWith('REFUND_')
        ? 'An on-chain principal refund is ready to claim.'
        : 'An on-chain payout is ready to claim.';
    }
    for (const record of records) {
      let recordDeployment = null;
      try {
        recordDeployment = DEPLOYMENT_REGISTRY.resolveIdentity({
          alias: record.deploymentAlias,
          address: record.contractAddress,
        });
      } catch {
        // Unknown local records retain their explorer link but gain no contract action.
      }
      const item = document.createElement('li');
      item.dataset.status = record.status.toLowerCase();
      const summary = document.createElement('span');
      const amount = record.amountAtto === null ? '' : ` · ${displayGen(BigInt(record.amountAtto), 6)}`;
      const delivery = record.type === 'CLAIM' && record.deliveryStatus
        ? ` · DELIVERY ${record.deliveryStatus}`
        : '';
      summary.textContent = `${recordDeployment?.alias.toUpperCase() || 'UNKNOWN DEPLOYMENT'} · ${record.type} · ${record.roundId || 'UNKNOWN ROUND'}${record.assetId ? ` · ${contractAssetLabel(record.assetId)}` : ''}${amount}${delivery}`;
      const link = document.createElement('a');
      link.href = `${this.networkPresentation.explorerTxBase}${record.hash}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${record.status} · ${record.hash.slice(0, 8)}…${record.hash.slice(-6)}`;
      link.title = `Open transaction ${record.hash} in the ${this.networkPresentation.name} explorer`;
      const actions = document.createElement('span');
      actions.className = 'activity-actions';
      actions.append(link);
      if (record.childHash) {
        const childLink = document.createElement('a');
        childLink.href = `${this.networkPresentation.explorerTxBase}${record.childHash}`;
        childLink.target = '_blank';
        childLink.rel = 'noopener noreferrer';
        childLink.textContent = `TRANSFER · ${record.childHash.slice(0, 8)}…${record.childHash.slice(-6)}`;
        childLink.title = `Open claim transfer ${record.childHash} in the ${this.networkPresentation.name} explorer`;
        actions.append(childLink);
      }
      if (record.roundId && recordDeployment) {
        const roundLink = document.createElement('a');
        const roundUrl = new URL(location.href);
        roundUrl.searchParams.delete('contract');
        roundUrl.searchParams.delete('claim');
        roundUrl.searchParams.set('feed', 'live');
        roundUrl.searchParams.set('deployment', recordDeployment.alias);
        roundUrl.searchParams.set('epoch', record.roundId);
        if (record.objective) {
          roundUrl.searchParams.set('objective', record.objective === 'LOW' ? 'lowest' : 'highest');
        }
        roundLink.href = roundUrl.href;
        roundLink.textContent = 'OPEN EPOCH';
        roundLink.title = `Open historical epoch ${record.roundId}`;
        actions.append(roundLink);
      }
      item.append(summary, actions);
      list.append(item);
    }
    for (const entry of positions) {
      const positionDeployment = DEPLOYMENT_REGISTRY.get(entry.deploymentAlias);
      const presentation = walletPositionPresentation(entry, positionDeployment, location.href);
      const item = document.createElement('li');
      item.dataset.status = presentation.dataStatus;
      const lastVerified = this.onchainHistoryErrorsByDeployment.has(entry.deploymentAlias);
      item.dataset.verification = lastVerified ? 'last-verified' : 'verified';
      const summary = document.createElement('span');
      summary.textContent = `${positionDeployment.alias.toUpperCase()} ${lastVerified ? 'LAST VERIFIED' : 'ON-CHAIN'} · ${entry.objective} · ${contractAssetLabel(entry.choiceAssetId)} · ${displayGen(entry.stakeAtto, 6)} · ${presentation.status}`;
      const actions = document.createElement('span');
      actions.className = 'activity-actions';
      const open = document.createElement('a');
      open.href = presentation.href;
      open.textContent = presentation.actionText;
      open.title = presentation.actionTitle;
      const claimIntent = walletClaimIntentFromHref(presentation.href);
      if (claimIntent) {
        open.className = 'wallet-position-action';
        open.dataset.claimDeployment = claimIntent.deploymentAlias;
        open.dataset.claimEpoch = String(claimIntent.epochEndTimestamp);
        open.dataset.claimObjective = claimIntent.objective;
        open.setAttribute(
          'aria-label',
          `${presentation.actionText.toLowerCase()} ${entry.objective} ${contractAssetLabel(entry.choiceAssetId)} position for round ${entry.epochEndTimestamp}`,
        );
      }
      actions.append(open);
      item.append(summary, actions);
      list.append(item);
    }
    this._renderPrimaryPredictionCta();
  }

  _renderBattleCard() {
    const card = $('#battle-card');
    if (!card) return;
    const now = Date.now();
    const schedule = arenaEpochState(now);
    const scoreEpoch = this.explicitEpochEndTimestamp
      ? createEpoch(this.explicitEpochEndTimestamp * 1_000)
      : schedule.displayEpoch;
    const operationalPhase = schedule.operationalPhase;
    // This card is the scoreboard for the visible liquid map. Wager timing for
    // the independently selected action epoch remains in the prediction panel.
    const cardEpoch = scoreEpoch;
    const countdownState = schedule.operationalCountdown;
    const roundFrame = !this.explicitEpochEndTimestamp
      && this.roundFrame?.epoch?.displayEpoch?.epochId === scoreEpoch.epochId
      ? this.roundFrame
      : (!this.explicitEpochEndTimestamp
        && this.frame?.window === 'ROUND'
        && this.frame?.epoch?.displayEpoch?.epochId === scoreEpoch.epochId
          ? this.frame
          : null);
    const frameAssets = roundFrame?.assets || [];
    const highIds = roundFrame?.returnLeaders?.high || [];
    const lowIds = roundFrame?.returnLeaders?.low || [];
    const leaderName = (ids) => ids.length
      ? ids.map((id) => instrumentCode(frameAssets.find((asset) => asset.id === id))).join(' / ')
      : '--';
    const highName = leaderName(highIds);
    const lowName = leaderName(lowIds);
    const highReturn = roundFrame?.returnLeaders?.highReturnPct;
    const lowReturn = roundFrame?.returnLeaders?.lowReturnPct;
    const evidenceStatuses = new Set(frameAssets.map((asset) => asset.round?.evidenceStatus).filter(Boolean));
    const evidenceStatus = operationalPhase === EPOCH_PHASE.WAGERING
      ? 'AWAITING_BATTLE'
      : evidenceStatuses.has('BASELINE_UNAVAILABLE')
        ? 'BASELINE_UNAVAILABLE'
        : (evidenceStatuses.size === 1 ? [...evidenceStatuses][0] : 'SYNCING_BOUNDARIES');
    const showLeaders = operationalPhase !== EPOCH_PHASE.WAGERING && Boolean(roundFrame);
    const stateLabel = {
      AWAITING_BATTLE: 'SCHEDULED',
      BASELINE_UNAVAILABLE: 'BASELINE MISSING',
      LIVE_ESTIMATE: 'LIVE ESTIMATE',
      AWAITING_END_CANDLE: 'AWAITING CANDLE',
      COMPLETED_CANDLE_PROVISIONAL: 'CANDLE PROVISIONAL',
      SYNCING_BOUNDARIES: 'SYNCING',
    }[evidenceStatus] || 'PROVISIONAL';

    const phaseLabel = this.explicitEpochEndTimestamp
      ? 'HISTORICAL ROUND · ON-CHAIN'
      : operationalPhase === EPOCH_PHASE.BUFFER
      ? `${operationalPhase.replaceAll('_', ' ')} · PREVIOUS ${schedule.displayPhase.replaceAll('_', ' ')}`
      : operationalPhase === EPOCH_PHASE.WAGERING
        ? 'WAGERING · PREVIOUS MAP HELD'
        : `${operationalPhase.replaceAll('_', ' ')} · 20M BATTLE`;
    $('#battle-type').textContent = phaseLabel;
    $('#battle-round-id').textContent = cardEpoch.epochId;
    $('#round-high-leader').textContent = showLeaders ? highName : '--';
    $('#round-low-leader').textContent = showLeaders ? lowName : '--';
    $('#round-high-return').textContent = showLeaders && Number.isFinite(highReturn) ? signed(highReturn, 4) : '--';
    $('#round-low-return').textContent = showLeaders && Number.isFinite(lowReturn) ? signed(lowReturn, 4) : '--';
    $('#battle-card-state-label').textContent = stateLabel;
    $('#battle-countdown-label').textContent = this.explicitEpochEndTimestamp
      ? 'HISTORICAL EPOCH'
      : countdownState.label;
    $('#battle-countdown').textContent = this.explicitEpochEndTimestamp
      ? 'ON-CHAIN'
      : countdownState.secondsRemaining === null
        ? 'PENDING'
        : formatCountdown(countdownState.secondsRemaining);
    $('#battle-countdown').setAttribute(
      'aria-label',
      `${countdownState.label}: ${$('#battle-countdown').textContent}`,
    );
    $('#battle-winner').textContent = 'BINANCE 1M';
    $('#battle-return').textContent = 'PROVISIONAL';

    const cardEpochEnd = Math.floor(cardEpoch.battleEndMs / 1000);
    const finalizedRound = this.displayRound?.epochEndTimestamp === cardEpochEnd
      && TERMINAL_ROUND_STATUSES.has(this.displayRound.status)
      ? this.displayRound
      : null;
    if (finalizedRound) {
      $('#round-high-leader').textContent = contractAssetLabel(finalizedRound.epoch.highWinnerAssetId) || '--';
      $('#round-low-leader').textContent = contractAssetLabel(finalizedRound.epoch.lowWinnerAssetId) || '--';
      $('#round-high-return').textContent = finalizedRound.epoch.resultStatus === 'DETERMINED'
        ? signed(finalizedRound.epoch.highWinnerReturnPpb / 10_000_000, 4)
        : '--';
      $('#round-low-return').textContent = finalizedRound.epoch.resultStatus === 'DETERMINED'
        ? signed(finalizedRound.epoch.lowWinnerReturnPpb / 10_000_000, 4)
        : '--';
      $('#battle-card-state-label').textContent = finalizedRound.epoch.resultStatus === 'DETERMINED'
        ? 'GENLAYER FINAL'
        : `${finalizedRound.epoch.resultStatus} · REFUND`;
      $('#battle-winner').textContent = `${finalizedRound.venueCount}/5 VENUE MEDIAN`;
      $('#battle-return').textContent = 'FINALIZED';
    }

    const phaseCopy = {
      [EPOCH_PHASE.EVIDENCE_GRACE]: 'The exact-hour endpoint is closed. Waiting for every completed 1m end candle; no result is final.',
      [EPOCH_PHASE.AWAITING_RESOLUTION]: `Completed-candle leaders remain provisional until the StudioNet ${this.deployment.alias.toUpperCase()} resolution is FINALIZED.`,
      [EPOCH_PHASE.WAGERING]: 'The next epoch is accepting verified StudioNet wagers. The previous ROUND map stays visible and resets only at the exact battle boundary.',
      [EPOCH_PHASE.BATTLE_LIVE]: 'Territories track signed return from the canonical battle-start candle open. HIGH and LOW leaders are provisional.',
    };
    const explanatoryPhase = operationalPhase === EPOCH_PHASE.WAGERING
      || operationalPhase === EPOCH_PHASE.BATTLE_LIVE
      ? operationalPhase
      : schedule.displayPhase;
    $('#battle-status').textContent = this.explicitEpochEndTimestamp
      ? `Historical ${this.deployment.alias.toUpperCase()} on-chain epoch selected. Its result remains the displayed ROUND until you leave this URL.`
      : phaseCopy[explanatoryPhase]
        || 'Buffering the next exact-hour epoch while the previous provisional result remains visible.';
    if (finalizedRound) {
      $('#battle-status').textContent = finalizedRound.epoch.resultStatus === 'DETERMINED'
        ? `GenLayer finalized the shared five-asset vector. ${finalizedRound.venueCount} exchange baskets qualified; this result controls both HIGH and LOW pools.`
        : `GenLayer finalized ${finalizedRound.epoch.resultStatus}. Both objectives use zero-fee principal refunds.`;
    }

    const stateByPhase = {
      [EPOCH_PHASE.BUFFER]: 'locked',
      [EPOCH_PHASE.WAGERING]: 'open',
      [EPOCH_PHASE.BATTLE_LIVE]: 'resolving',
      [EPOCH_PHASE.EVIDENCE_GRACE]: 'resolving',
      [EPOCH_PHASE.AWAITING_RESOLUTION]: 'locked',
    };
    card.dataset.state = finalizedRound
      ? (finalizedRound.epoch.resultStatus === 'DETERMINED' ? 'open' : 'locked')
      : this.explicitEpochEndTimestamp
        ? 'locked'
      : evidenceStatus === 'BASELINE_UNAVAILABLE'
      ? 'error'
      : (stateByPhase[operationalPhase] || stateByPhase[schedule.displayPhase] || 'loading');
  }

  openWindow(windowName) {
    if (!WINDOW_CONFIG[windowName]) return;
    this.window = windowName;
    const config = WINDOW_CONFIG[windowName];
    document.querySelectorAll('#timeframe-controls button').forEach((button) => {
      const active = button.dataset.window === windowName;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#window-label').textContent = config.label;
    $('#window-kind').textContent = windowName === 'ROUND' ? 'ROUND SCOREBOARD' : 'ROLLING CONTEXT';

    if (this.feedMode === 'live') {
      if (this.driver && this.driver !== this.roundDriver) this.driver.destroy();
      this.driver = null;
      this._openLive(windowName);
      this._syncRoundState();
      return;
    }
    for (const driver of new Set([this.driver, this.roundDriver].filter(Boolean))) driver.destroy();
    this.driver = null;
    this.roundDriver = null;
    this.roundFrame = null;
    const historyEndAt = windowName === 'ROUND'
      ? Math.floor(Date.now() / 60_000) * 60_000
      : Date.now();
    const history = createSyntheticMarketHistory({
      seed: `liquidity-arena-${windowName}`,
      pointCount: config.pointCount,
      intervalMs: config.intervalMs,
      window: windowName,
      returnLookback: config.returnLookback,
      momentumLookback: Math.max(4, Math.round(config.returnLookback / 6)),
      volatilityLookback: Math.max(8, Math.round(config.returnLookback / 4)),
      startAt: historyEndAt - (config.pointCount - 1) * config.intervalMs,
    });

    this.driver = new SyntheticMarketDriver({
      history,
      tickMs: 720,
      loop: true,
      autoStart: false,
      onFrame: (frame) => this.onFrame(frame),
      onEvent: (event) => this.onEvent(event),
    });
    this.driver.seek(Math.max(0, history.frames.length - 52));
    this.driver.start();
    $('#timeline-slider').disabled = false;
    $('#play-button').textContent = 'Ⅱ';
    $('#play-button').setAttribute('aria-label', 'Pause replay');
    this.toast(`${config.label} relative-strength window loaded.`);
    this._syncRoundState();
  }

  _openLive(windowName) {
    $('#feed-status').textContent = 'CONNECTING…';
    $('#feed-toggle').dataset.state = 'connecting';
    $('#timeline-slider').disabled = true;
    $('#replay-label').textContent = 'HISTORY BACKFILL';
    $('#play-button').textContent = 'Ⅱ';
    this.liveReadyNotified = false;
    const handleReadyFrame = (frame) => {
      this.onFrame(frame);
      const presentation = feedPresentation(frame);
      if (!this.liveReadyNotified && ['live', 'closed'].includes(presentation.state)) {
        this.liveReadyNotified = true;
        this.toast('Binance Spot stream connected.');
      }
    };
    if (!this.roundDriver) {
      this.roundDriver = new LiveMarketDriver({
        window: 'ROUND',
        EventSourceImpl: this.sharedEventSourceImpl,
        onFrame: (frame) => {
          this.roundFrame = frame;
          if (this.feedMode !== 'live') return;
          if (this.window === 'ROUND') handleReadyFrame(frame);
          else this._renderBattleCard();
        },
        onEvent: (event) => {
          if (this.window === 'ROUND') this.onEvent(event);
        },
        onError: (error) => {
          this.roundFrame = null;
          if (this.feedMode !== 'live') return;
          if (this.window === 'ROUND') {
            const message = `Binance ROUND feed unavailable; demo replay restored. ${error.message}`;
            this.feedMode = 'demo';
            this.openWindow('ROUND');
            this.toast(message);
          } else {
            this._renderBattleCard();
            this.toast(`ROUND evidence unavailable. Context stream remains active. ${error.message}`);
          }
        },
      });
    }
    if (windowName === 'ROUND') {
      this.driver = this.roundDriver;
      if (this.roundFrame) handleReadyFrame(this.roundFrame);
      return;
    }
    this.driver = new LiveMarketDriver({
      window: windowName,
      EventSourceImpl: this.sharedEventSourceImpl,
      onFrame: handleReadyFrame,
      onEvent: (event) => this.onEvent(event),
      onError: (error) => {
        const message = `Binance feed unavailable; demo replay restored. ${error.message}`;
        this.feedMode = 'demo';
        this.openWindow(this.window);
        this.toast(message);
      },
    });
  }

  toggleFeed() {
    this.feedMode = this.feedMode === 'live' ? 'demo' : 'live';
    this.openWindow(this.window);
  }

  onFrame(frame) {
    this.rawFrame = frame;
    let displayedFrame = frame;
    try {
      const targets = selectRoundTargets({
        nowMs: Date.now(),
        explicitEpochEndTimestamp: this.explicitEpochEndTimestamp,
      });
      const displayRound = roundMatchesDisplayTarget(this.displayRound, targets)
        ? this.displayRound
        : null;
      displayedFrame = reconcileFinalizedRoundFrame(
        frame,
        displayRound,
        this.displayRoundAssets,
      );
    } catch {
      // An incomplete/mismatched contract vector must never be painted as the
      // authoritative arena. The background poll will retry all five records.
      displayedFrame = frame;
    }
    this.frame = displayedFrame;
    if (!displayedFrame.assets.some((asset) => asset.id === this.selectedId)) {
      this.selectedId = displayedFrame.leader.id;
    }
    this.arena.setFrame(displayedFrame);
    this.arena.setSelected(this.selectedId);
    this.renderFrame();
  }

  onEvent(event) {
    if (!this.frame) return;
    this.arena.triggerEvent({ ...event, magnitude: event.severity === 'high' ? 1.45 : event.severity === 'medium' ? 1 : 0.65 });
    $('#event-time').textContent = new Date(event.timestamp).toISOString().slice(11, 16) + ' UTC';
    $('#event-title').textContent = event.title.toUpperCase();
    $('#event-copy').textContent = eventMessage(event, this.frame);
    $('#event-icon').textContent = event.direction === 'down' ? '↘' : event.kind === 'volatility_spike' ? '≋' : '↗';
    $('#event-icon').classList.toggle('negative', event.direction === 'down');
  }

  selectAsset(assetId) {
    if (!this.frame?.assets.some((asset) => asset.id === assetId)) return;
    this.selectedId = assetId;
    this.arena.setSelected(assetId);
    this.renderFrame();
    if (!$('#prediction-modal').hidden) void this._refreshRoundAsset();
  }

  renderFrame() {
    const frame = this.frame;
    if (!frame) return;
    const selected = frame.assets.find((asset) => asset.id === this.selectedId) || frame.assets[0];
    const leader = frame.assets.find((asset) => asset.id === frame.leader.id) || frame.assets[0];

    if (frame.window === 'ROUND') {
      if (frame.settlement?.finalized) {
        $('#arena-leader').textContent = `GENLAYER FINAL HIGH ${contractAssetLabel(frame.settlement.highWinnerAssetId)} ${signed(frame.settlement.highReturnPpb / 10_000_000, 4)} · LOW ${contractAssetLabel(frame.settlement.lowWinnerAssetId)} ${signed(frame.settlement.lowReturnPpb / 10_000_000, 4)}`;
        $('#view-explanation').innerHTML = `<strong>FINAL ROUND territory uses the GenLayer ${frame.settlement.deploymentAlias.toUpperCase()} five-exchange median vector.</strong> Return alone controls area and HIGH/LOW rank; live momentum and volatility continue to control liquid flow and turbulence.`;
        $('#orb-label').textContent = 'FINAL TERRITORY';
      } else {
        const high = frame.returnLeaders.high.map((id) => instrumentCode(frame.assets.find((asset) => asset.id === id))).join(' / ');
        const low = frame.returnLeaders.low.map((id) => instrumentCode(frame.assets.find((asset) => asset.id === id))).join(' / ');
        $('#arena-leader').textContent = `PROVISIONAL HIGH ${high} ${signed(frame.returnLeaders.highReturnPct, 4)} · LOW ${low} ${signed(frame.returnLeaders.lowReturnPct, 4)}`;
        $('#view-explanation').innerHTML = '<strong>ROUND territory is return-only.</strong> The previous result remains visible through BUFFER/WAGERING, then resets from the exact 1m candle open at battle start. Momentum controls flow; volatility controls turbulence.';
        $('#orb-label').textContent = 'ROUND TERRITORY';
      }
    } else {
      $('#arena-leader').textContent = `${leader.shortName.toUpperCase()} LEADS ${frame.window} RETURN · ${leader.dominancePct.toFixed(1)}%`;
      $('#view-explanation').innerHTML = `<strong>${escapeHtml(frame.window)} is rolling context.</strong> It never resets with an hourly ROUND and never determines the battle winner. Territory is still based only on signed return.`;
      $('#orb-label').textContent = `${frame.window} CONTEXT TERRITORY`;
    }
    $('#regime-label').textContent = regimeFor(frame);
    const feed = feedPresentation(frame);
    $('#feed-status').textContent = feed.label;
    $('#feed-toggle').dataset.state = feed.state;
    $('#feed-toggle').setAttribute('aria-label', `Market data status: ${feed.label}. Toggle demo or Binance market data.`);
    $('#feed-toggle').title = `${frame.market.source} · ${frame.market.status} · ${frame.market.quality}`;
    const liveWindow = liveWindowPresentation(frame, feed);
    $('#live-window-status').textContent = liveWindow.label;
    $('#live-window-note').dataset.state = liveWindow.state;
    $('#selected-source').textContent = frame.settlement?.finalized
      ? `GENLAYER ${frame.settlement.deploymentAlias.toUpperCase()} · 5-VENUE FINAL`
      : frame.market.source.toUpperCase();

    $('#asset-list').innerHTML = frame.assets.map((asset) => this._assetRow(asset)).join('');
    $('#mobile-asset-strip').innerHTML = frame.assets.map((asset) => `
      <button class="mobile-chip ${asset.id === this.selectedId ? 'active' : ''}" type="button"
        data-asset-id="${escapeHtml(asset.id)}" style="--asset-color:${colorOf(asset)}">
        ${escapeHtml(instrumentCode(asset))} · ${asset.dominancePct.toFixed(0)}%
      </button>
    `).join('');

    const color = colorOf(selected);
    document.documentElement.style.setProperty('--selected-color', color);
    $('#identity-swatch').style.setProperty('--selected-color', color);
    $('#selected-orb').style.setProperty('--orb-color', color);
    $('#orb-symbol').textContent = instrumentCode(selected);
    $('#orb-value').textContent = `${selected.dominancePct.toFixed(1)}%`;
    $('#selected-name').textContent = selected.name.toUpperCase();
    $('#selected-pair').textContent = selected.symbol.replace('/', ' / ');
    $('#selected-price').textContent = formatPrice(selected);
    $('#selected-unit').textContent = selected.unit.toUpperCase();
    const change = $('#selected-change');
    change.textContent = signed(selected.returnPct);
    change.className = selected.returnPct >= 0 ? 'positive' : 'negative';
    $('#selected-momentum').textContent = `${selected.trend.toUpperCase()} · ${signed(selected.momentumPct)}`;
    $('#selected-volatility').textContent = this._volatilityLabel(selected.volatilityPct);
    $('#selected-range').textContent = `${signed(Math.min(0, selected.returnPct - selected.volatilityPct), 2, '')} / ${signed(Math.max(0, selected.returnPct + selected.volatilityPct), 2, '')}`;
    this._renderSelectedObservation(selected);
    this.drawSpark(selected);

    if (this.driver.history) {
      const slider = $('#timeline-slider');
      const maxIndex = Math.max(1, this.driver.history.frames.length - 1);
      slider.value = String(Math.round(this.driver.index / maxIndex * 1000));
      const remaining = maxIndex - this.driver.index;
      $('#replay-label').textContent = remaining < 2 ? 'LIVE EDGE' : `${remaining} TICKS BACK`;
    } else {
      $('#replay-label').textContent = liveWindow.label;
    }
    this._renderPredictionState();
  }

  _renderSelectedObservation(asset = null) {
    const frame = this.frame;
    if (!frame) return;
    const selected = asset || frame.assets.find((entry) => entry.id === this.selectedId) || frame.assets[0];
    if (!selected) return;
    const observation = observationPresentation(frame, selected);
    $('#selected-session').textContent = observation.session;
    $('#selected-tick').textContent = observation.age;
    $('#selected-observation').textContent = observation.label;
    $('#selected-observation').dataset.state = observation.state;
  }

  _assetRow(asset) {
    const changeClass = asset.returnPct >= 0 ? 'positive' : 'negative';
    return `
      <button class="asset-row ${asset.id === this.selectedId ? 'active' : ''}" type="button"
        data-asset-id="${escapeHtml(asset.id)}" style="--asset-color:${colorOf(asset)};--share:${asset.dominancePct / 100}">
        <span class="asset-dot">${escapeHtml(badgeCode(asset).slice(0, 3))}</span>
        <span class="asset-copy"><strong>${escapeHtml(asset.shortName.toUpperCase())}</strong><span>${escapeHtml(asset.symbol)}</span></span>
        <span class="asset-numbers"><strong>${asset.dominancePct.toFixed(1)}%</strong><span class="${changeClass}">${signed(asset.returnPct)}</span></span>
      </button>
    `;
  }

  _volatilityLabel(value) {
    if (value > 0.22) return `ELEVATED · ${value.toFixed(2)}%`;
    if (value > 0.09) return `ACTIVE · ${value.toFixed(2)}%`;
    return `CALM · ${value.toFixed(2)}%`;
  }

  drawSpark(asset) {
    const canvas = $('#spark-canvas');
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    let values;
    if (this.driver.history) {
      const end = Math.max(0, this.driver.index);
      const start = Math.max(0, end - 42);
      values = this.driver.history.frames.slice(start, end + 1)
        .map((frame) => frame.assets.find((entry) => entry.id === asset.id)?.price)
        .filter(Number.isFinite);
    } else {
      // A live sparkline must cover the same return lookback that drives the
      // circular arena. For example, the 1W view needs 169 hourly closes for
      // its 168-interval return, not the old arbitrary 80-point tail.
      const returnLookback = WINDOW_QUERIES[this.frame?.window]?.returnLookback;
      const pointCount = Number.isInteger(returnLookback) ? returnLookback + 1 : 80;
      values = (this.driver.seriesByAsset?.get(asset.id) || []).slice(-pointCount);
    }
    if (values.length < 2) return;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    const padding = 3;
    const points = values.map((value, index) => ({
      x: padding + index / (values.length - 1) * (rect.width - padding * 2),
      y: padding + (1 - (value - min) / spread) * (rect.height - padding * 2),
    }));

    const gradient = context.createLinearGradient(0, 0, 0, rect.height);
    gradient.addColorStop(0, `${colorOf(asset)}55`);
    gradient.addColorStop(1, `${colorOf(asset)}00`);
    context.beginPath();
    context.moveTo(points[0].x, rect.height);
    for (const point of points) context.lineTo(point.x, point.y);
    context.lineTo(points.at(-1).x, rect.height);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.beginPath();
    points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = colorOf(asset);
    context.globalAlpha = 0.88;
    context.lineWidth = 1.25;
    context.stroke();
    context.globalAlpha = 1;
  }

  togglePlayback() {
    this.driver.setPaused(!this.driver.paused);
    const paused = this.driver.paused;
    $('#play-button').textContent = paused ? '▶' : 'Ⅱ';
    $('#play-button').setAttribute('aria-label', paused ? 'Play replay' : 'Pause replay');
  }

  seek(progress) {
    if (!this.driver.history) return;
    const index = Math.round(Math.max(0, Math.min(1, progress)) * (this.driver.history.frames.length - 1));
    this.driver.seek(index);
  }

  _renderPredictionChoices() {
    $('#prediction-assets').innerHTML = MARKET_ASSETS.map((asset) => `
      <label class="prediction-option" style="--asset-color:${asset.visual.primary}">
        <input type="radio" name="prediction-asset" value="${escapeHtml(asset.id)}">
        <strong>${escapeHtml(instrumentCode(asset))}</strong>
        <span>${escapeHtml(asset.shortName.toUpperCase())}</span>
      </label>
    `).join('');
    $('#prediction-assets').addEventListener('change', (event) => {
      this.selectedPrediction = event.target.value;
      this._updateSubmitButton();
      void this._refreshRoundAsset();
    });
  }

  async openPrediction(opener = null) {
    if (this.deploymentSelectionError) {
      this.toast(this.deploymentSelectionError);
      return;
    }
    const modalGeneration = this._showModal('prediction-modal', {
      opener,
      initialFocus: '.prediction-modal .modal-close',
    });
    if (!this.selectedPrediction) this.selectedPrediction = this.selectedId;
    const input = document.querySelector(`input[name="prediction-asset"][value="${this.selectedPrediction}"]`);
    if (input) input.checked = true;
    await this._loadRound();
    const record = this._modalRecord('prediction-modal');
    if (record.generation !== modalGeneration || record.layer.hidden) return;
    this._renderPredictionState();
  }

  closePrediction() {
    if (this._hideModal('prediction-modal')) this._clearClaimIntentRoute();
  }
  openHow(opener = null) {
    this._showModal('how-modal', { opener, initialFocus: '.how-modal .modal-close' });
  }
  closeHow() { this._hideModal('how-modal'); }

  _updateSubmitButton() {
    this.modalNotice = null;
    this._renderPredictionState();
  }

  _setWalletConnectionControls(connecting) {
    $('#wallet-button').disabled = connecting;
    const reconnect = $('#claim-reconnect');
    if (reconnect) reconnect.disabled = connecting;
  }

  async connectWallet() {
    if (this.walletConnectionPromise) return this.walletConnectionPromise;
    this._setWalletConnectionControls(true);
    $('#wallet-label').textContent = 'CONNECTING…';
    const connection = this._connectWalletOnce();
    this.walletConnectionPromise = connection;
    try {
      return await connection;
    } finally {
      if (this.walletConnectionPromise === connection) this.walletConnectionPromise = null;
      this._setWalletConnectionControls(false);
      this._renderPredictionState();
    }
  }

  async _connectWalletOnce() {
    try {
      const account = await this.gateway.connect();
      $('#wallet-label').textContent = account.label;
      $('#wallet-button').title = `${account.walletName ? `${account.walletName} · ` : ''}${account.address}`;
      this.modalNotice = `Connected to ${account.network} chain ${account.chainId} as ${account.label}. ${this.deployment.newWagersEnabled ? 'Test-GEN wagers and claims' : 'Legacy claims and timeout refunds'} are public and wallet-linked.`;
      await this._reconcileActivity();
      await this._loadWalletHistory();
      if (this.round) {
        try {
          await this._loadPositionState();
        } catch (error) {
          this.modalNotice = `Wallet connected, but its claim quote could not be verified. ${error?.message || 'Money actions remain disabled.'}`;
        }
      }
      this._renderPredictionState();
      if (this.pendingClaimIntent) this._focusClaimSection();
      this.toast(`${account.walletName ? `${account.walletName} · ` : ''}${this.networkPresentation.name} wallet connected: ${account.label}`);
    } catch (error) {
      $('#wallet-label').textContent = 'CONNECT GENLAYER';
      this.modalNotice = error.message;
      this._renderPredictionState();
      this.toast(error.message);
    }
  }

  async submitPrediction() {
    if (!this.selectedPrediction) return;
    this.submittingPrediction = true;
    this.pendingWagerHash = null;
    this.modalNotice = null;
    this._renderPredictionState();
    let activity = null;
    try {
      await this._loadRound();
      const contractAsset = getMarketAsset(this.selectedPrediction)?.contractId;
      const gate = this._roundGate(contractAsset);
      if (!gate.allowed || !this.round) throw new Error(gate.message);
      const stake = this._stakeValidation(contractAsset);
      if (!stake.allowed) throw new Error(stake.message);
      activity = {
        type: 'WAGER', roundId: this.round.roundId, assetId: contractAsset,
        objective: this.round.objective, amountAtto: stake.amount.toString(),
      };
      const result = await this.gateway.placeEpochWager(
        this.round.epochEndTimestamp,
        this.objectiveSelector,
        contractAsset,
        stake.amount,
        {
        onSubmitted: (hash, submission) => {
          activity = {
            ...activity,
            hash,
            account: submission.account,
            contractAddress: submission.contractAddress,
          };
          this.pendingWagerHash = hash;
          this._recordActivity({ ...activity, hash, status: 'SUBMITTED' });
          this.modalNotice = `SUBMITTED · ${hash.slice(0, 10)}…${hash.slice(-6)} · awaiting FINALIZED execution and state verification.`;
          this._renderPredictionState();
        },
        },
      );
      this._recordActivity({ ...activity, hash: result.hash, status: 'FINALIZED' });
      $('#wallet-label').textContent = this.gateway.accountLabel;
      this.modalNotice = `FINALIZED & VERIFIED · ${result.hash.slice(0, 10)}…${result.hash.slice(-6)}`;
      this.toast(`Test-GEN wager finalized and verified on ${this.networkPresentation.name}.`);
      await this._loadRound({ background: true });
      await this._loadWalletHistory();
    } catch (error) {
      if (error?.hash && activity) this._recordActivity({ ...activity, hash: error.hash, status: 'REVIEW' });
      const transaction = error?.hash ? ` Transaction ${error.hash.slice(0, 10)}… requires manual review.` : '';
      this.modalNotice = `${error?.message || 'Test-GEN wager failed safely.'}${transaction}`;
      this.toast(this.modalNotice);
    } finally {
      this.submittingPrediction = false;
      this.pendingWagerHash = null;
      this._renderPredictionState();
    }
  }

  async claimWager() {
    if (!this.round || this.claimingWager) return;
    const gate = v6ClaimGate(this.claimQuote);
    if (!gate.allowed) {
      this.modalNotice = gate.reason;
      this._renderPredictionState();
      return;
    }
    const claimTarget = walletClaimTarget(this.round);
    this.claimingWager = true;
    this.modalNotice = null;
    this._renderPredictionState();
    let activity = {
      type: 'CLAIM',
      roundId: String(claimTarget.epochEndTimestamp),
      assetId: this.entry?.choiceAssetId || null,
      objective: claimTarget.objective,
      amountAtto: null,
      deliveryStatus: 'PENDING',
    };
    try {
      const result = await this.gateway.claimEpoch(claimTarget.epochEndTimestamp, claimTarget.objective, {
        onSubmitted: (hash, submission) => {
          activity = {
            ...activity,
            hash,
            account: submission.account,
            contractAddress: submission.contractAddress,
            quotedAmountAtto: submission.quotedAmountAtto,
          };
          this._recordActivity({ ...activity, hash, status: 'SUBMITTED' });
        },
        onDeliveryDiscovered: (childHash, submission) => {
          activity = {
            ...activity,
            account: submission.account,
            contractAddress: submission.contractAddress,
            quotedAmountAtto: submission.quotedAmountAtto || activity.quotedAmountAtto,
            amountAtto: submission.actualAmountAtto || activity.amountAtto,
            childHash,
            deliveryStatus: 'PENDING',
          };
          this._recordActivity({ ...activity, hash: activity.hash, status: 'REVIEW' });
        },
      });
      this._recordActivity({
        ...activity,
        hash: result.hash,
        quotedAmountAtto: result.quotedAmountAtto,
        amountAtto: result.actualAmountAtto,
        childHash: result.delivery.childHash,
        deliveryStatus: 'DELIVERED',
        status: 'FINALIZED',
      });
      this._clearClaimIntentRoute();
      this.modalNotice = `CLAIM + TRANSFER FINALIZED & VERIFIED · ${result.delivery.childHash.slice(0, 10)}…${result.delivery.childHash.slice(-6)}`;
      this.toast(`Test-GEN claim child transfer finalized and verified on ${this.networkPresentation.name}.`);
      await this._loadRound({ background: true });
      await this._loadWalletHistory();
    } catch (error) {
      if (error?.hash) this._recordActivity({
        ...activity,
        hash: error.hash,
        quotedAmountAtto: error?.quotedAmountAtto || activity.quotedAmountAtto,
        amountAtto: error?.actualAmountAtto || activity.amountAtto,
        childHash: error?.childHash || activity.childHash,
        deliveryStatus: error?.deliveryStatus || 'REVIEW',
        status: 'REVIEW',
      });
      const transaction = error?.hash ? ` Transaction ${error.hash.slice(0, 10)}… requires manual review.` : '';
      this.modalNotice = `${error?.message || 'Test-GEN claim failed safely.'}${transaction}`;
      this.toast(this.modalNotice);
    } finally {
      this.claimingWager = false;
      this._renderPredictionState();
    }
  }

  async unlockEmergencyRefund() {
    if (!this.round || this.activatingEmergencyRefund) return;
    const gate = v6TimeoutGate(this.round.epoch, Math.floor(Date.now() / 1000));
    if (!gate.allowed) {
      this.modalNotice = gate.reason;
      this._renderPredictionState();
      return;
    }
    this.activatingEmergencyRefund = true;
    this.modalNotice = null;
    this._renderPredictionState();
    let activity = {
      type: 'TIMEOUT_REFUND',
      roundId: this.round.roundId,
      objective: this.round.objective,
      amountAtto: null,
    };
    try {
      const result = await this.gateway.activateTimeoutRefund(this.round.epochEndTimestamp, {
        onSubmitted: (hash, submission) => {
          activity = {
            ...activity,
            account: submission.account,
            contractAddress: submission.contractAddress,
          };
          this._recordActivity({ ...activity, hash, status: 'SUBMITTED' });
        },
      });
      this._recordActivity({ ...activity, hash: result.hash, status: 'FINALIZED' });
      this.modalNotice = `24-HOUR PRINCIPAL REFUNDS UNLOCKED · ${result.hash.slice(0, 10)}…${result.hash.slice(-6)}`;
      this.toast(`Timeout principal refunds finalized and verified on ${this.networkPresentation.name}.`);
      await this._loadRound({ background: true });
    } catch (error) {
      if (error?.hash) this._recordActivity({ ...activity, hash: error.hash, status: 'REVIEW' });
      const transaction = error?.hash ? ` Transaction ${error.hash.slice(0, 10)}… requires manual review.` : '';
      this.modalNotice = `${error?.message || 'Emergency principal unlock failed safely.'}${transaction}`;
      this.toast(this.modalNotice);
    } finally {
      this.activatingEmergencyRefund = false;
      this._renderPredictionState();
    }
  }

  toast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  destroy() {
    clearInterval(this.clockTimer);
    clearInterval(this.roundRefreshTimer);
    this.unsubscribeWallet?.();
    this.gateway.destroy();
    for (const driver of new Set([this.driver, this.roundDriver].filter(Boolean))) driver.destroy();
    this.arena.destroy();
  }
}

const app = new LiquidityArenaApp();
window.LIQUIDITY_ARENA = app;

window.addEventListener('beforeunload', () => app.destroy(), { once: true });
