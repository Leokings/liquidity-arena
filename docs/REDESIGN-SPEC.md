# Liquidity Arena V8 product specification

## Product

Liquidity Arena is a Bradbury testnet game in which wallets choose the highest- or lowest-returning asset for an exact UTC-hour window. Supported assets are BTC, ETH, BNB, SOL, and XRP. Stakes use faucet-issued test GEN.

V8 is the sole active protocol. It combines GenLayer nondeterministic resolution with deterministic EVM escrow delivery.

## User lifecycle

1. Connect a wallet and switch to Bradbury chain 4221.
2. Select an open V8 epoch, objective, and asset.
3. Review the exact stake quote and sign the GenLayer entry.
4. After resolution, review the claim quote and create the V8 payout.
5. Follow preparation, dispatch, and escrow funding progress.
6. As the immutable recipient, withdraw the EVM vault.
7. Refresh V8 to record `EOA_WITHDRAWN`.

Every action survives reload through a durable, monotonic local journal. Failed or dropped EVM withdrawal attempts may be retried only after exact state inspection. A pending or finalized attempt cannot be duplicated or downgraded.

## Market rules

- exact UTC-hour epochs;
- HIGH and LOW objectives settle independently;
- one chosen asset per wallet/objective, with bounded top-ups;
- fixed 0.1 GEN minimum and 10 GEN wallet cap;
- fixed 200 bps platform fee;
- five-venue median resolution under validator consensus;
- under-quorum or malformed results remain unresolved;
- parimutuel winner allocation with explicit rounding remainder.

## Delivery rules

- deterministic payout ID and vault;
- committed reserve capacity before delivery;
- idempotent prepare/dispatch/confirm/refresh;
- recipient-only vault withdrawal;
- duplicate/wrong funding is excess, not principal;
- excess recovery pays only the fixed reserve sink.

## Safety and availability

Payout rails and new-risk acceptance are separate gates. Readiness remains degraded until exact deployment/config/reserve/history checks pass and risk is intentionally resumed. Pausing risk does not block settlement, claims, payout reconciliation, recipient withdrawal, or refresh.

The app accepts only the finalized V8 address from configuration. Retired V6/V7 URLs canonicalize to V8, arbitrary `contract=` input is rejected, and there is no legacy claim path.

## Acceptance

- deterministic release generation, lint, direct tests, EVM tests, harness tests, market tests, server/history/keeper tests, build, and desktop/mobile E2E pass;
- live V8 deployment and factory binding are finalized and exact;
- migration 004 applies once and exposes only the configured V8 deployment;
- reserve funding and payout/risk activation are finalized;
- readiness, history health, keeper, and scheduler agree on V8;
- a live payout lifecycle is verified when a resolved claimable position exists.

See [`../TECHNICAL.md`](../TECHNICAL.md), [`../SECURITY.md`](../SECURITY.md), and [`V8-PAYOUT-RECOVERY.md`](V8-PAYOUT-RECOVERY.md) for implementation details.
