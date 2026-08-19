# Liquidity Arena StudioNet contracts

[`LiquidityArenaV7.py`](LiquidityArenaV7.py) is the deployed release target. Protocol
`LIQUIDITY_ARENA_V7` is finalized on StudioNet at
`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`. Its recorded source SHA-256 is
`2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`.

[`LiquidityArenaV6.py`](LiquidityArenaV6.py) remains only because V6 positions must stay readable and
its permissionless resolve/timeout and participant claim paths must remain callable. V6 at
`0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is not a new-write target; its due
epochs `1787155200`, `1787158800`, `1787162400`, and `1787166000` were resolved on 2026-08-19. The
final listed epoch was resolved by transaction
`0x7e8030f0975d86479a01a398b88d10b2606c466eec78046fc84eca18c55d27bb`.

This is an operational retirement, not an immutable V6 contract revocation. The V6 owner-only
`create_epoch` method still exists, and `enter` would accept a wager for a directly created OPEN
epoch during its window. Supported app and automation paths expose neither operation; the owner must
not call V6 `create_epoch` again.

## V7 contract boundary

V7 owns:

- 24 exact UTC hourly epoch targets per day;
- the 20-minute buffer, 20-minute wager, and 20-minute battle schedule;
- one HIGH and one LOW pool per epoch;
- native faucet test-GEN escrow, positions, liabilities, fees, claims, and refunds;
- the fixed BTC, ETH, BNB, SOL, and XRP catalog;
- fixed Binance, OKX, Bybit, Gate, and KuCoin adapters;
- policy `CRYPTO_SPOT_1M_MEDIAN_V1` and a canonical five-asset result;
- atomic HIGH/LOW settlement from that shared result;
- bounded epoch/wallet/open-epoch views; and
- owner, keeper, and treasury authorization.

The browser owns animation only. Neither territory size nor the off-chain database can settle an
epoch.

## Epoch timing

For exact-hour end timestamp `E`:

| Field | Timestamp |
| --- | --- |
| Buffer start | `E - 3600` |
| Wager open | `E - 2400` |
| Wager close / battle baseline | `E - 1200` |
| Battle end | `E` |
| Resolve not before | `E + 120` |
| Timeout refund not before | `E + 86400` |

An epoch must be created at least one hour before its end. The keeper can create at most 26 hours
ahead; the owner recovery horizon is 31 days. Fee and stake limits are snapshotted into the epoch
before wagering.

## Public writes and authorization

| Method | Authorization | Value | Purpose |
| --- | --- | --- | --- |
| `set_keeper(address)` | Owner | Zero | Rotate or revoke the scheduler role |
| `propose_ownership(address)` | Owner | Zero | Begin two-step ownership transfer |
| `cancel_ownership_transfer()` | Owner | Zero | Cancel the pending transfer |
| `accept_ownership()` | Pending owner | Zero | Complete ownership transfer |
| `set_platform_fee_bps(bps)` | Owner | Zero | Set future fee, maximum 500 bps |
| `create_epoch(E)` | Owner or keeper | Zero | Create both pools with fixed contract stake limits |
| `enter(E, HIGH\|LOW, asset)` | Participant | Positive GEN | Wager on one asset in one objective |
| `resolve_epoch(E)` | Permissionless after gate | Zero | Run evidence and settle the shared result |
| `activate_timeout_refund(E)` | Permissionless after 24h | Zero | Make unresolved principal refundable |
| `claim(E, objective)` | Participant | Zero | Pull payout or principal refund |
| `withdraw_accrued_fees(amount)` | Owner or treasury | Zero | Withdraw only finalized accrued fees |

The deployed minimum is 0.1 GEN and maximum is 10 GEN per wallet/objective. A keeper cannot select
different stake limits in `create_epoch`, change fees, rotate roles, resolve to a chosen value, claim
for a participant, or withdraw funds.

## Evidence algorithm

For each approved venue, V7 accepts only a complete five-asset set of aligned, completed one-minute
boundary candles. With three to five qualifying venues, it sorts each asset's signed fixed-point
returns and chooses the median; four venues use the floor average of the middle two. The ordered
canonical vector derives:

```text
high_winner = argmax(canonical_asset_returns)
low_winner  = argmin(canonical_asset_returns)
```

Validators independently recompute the evidence and compare within the fixed ppb tolerance. A
temporary failure to obtain three full baskets is retryable and leaves the epoch open. The 24-hour
timeout is the deterministic zero-fee fallback if it never resolves. A tied extremum refunds only
that objective.

Public exchange endpoints are suitable only for this StudioNet test-token demo unless provider and
legal review establishes production settlement and redistribution rights.

## Fees, payouts, and refunds

V7 uses integer attoGEN accounting:

```text
default_fee_bps = 200
fee_hard_cap_bps = 500
losing_pool = total_pool - winning_stake
fee = floor(losing_pool * snapshotted_fee_bps / 10_000)
payout_pool = total_pool - fee
```

Backed winners share the payout pool pro rata and the last winning claimant receives the integer
remainder. Ties, an unbacked winner, no losing side, a recorded undetermined result, and timeout are
zero-fee principal-refund modes. Principal and unclaimed proceeds never become treasury fees.

Claims update accounting before emitting a finalized EOA value transfer. Off-chain monitoring must
verify the exact child and must not retry a recorded claim without protocol-safe failure proof.

## Read surface

V7 exposes configuration and catalogs, total and open epoch counts, bounded epoch/open pages,
per-epoch and per-asset results, objective pools, participant entries and claim quotes, bounded
wallet-position pages, fee state, and total player liability. Page size is capped at 50.

These views support fail-closed keeper/readiness checks and reconstruction without trusting emitted
logs. The Neon schema migration and initial finalized-state ingestion passed for full V7 and V6 E19
snapshots. A second production sync added V7 E20 and re-synced V6 E19 without duplication. Protected
backfill run `32309637237` subsequently verified 11 selected records with zero rejections: one V7
deployment proof, nine V7 E19 epoch proofs, and the epochless fee-withdrawal parent. Public V7 E19
now exposes exactly one creation, four wagers, one resolution, and three credited claim proofs; V7
E20 and V6 E19 remain at zero because they were outside that selected backfill. Neon history is a
cache/projection rather than a replacement for these views, and outage recovery remains pending.

## Verification requirements

- every UTC boundary and exactly 24 targets per day;
- creation authorization, one-hour notice, and keeper/owner horizons;
- owner/keeper/treasury separation and two-step ownership;
- entry before/during/after the wager window, top-ups, choice lock, and stake cap;
- both objectives and atomic shared-result settlement;
- all five adapters, 3-of-5 quorum, deterministic median, tolerance, ties, and outage paths;
- default fee, hard cap, fee withdrawal, rounding remainder, and conservation;
- tie, unbacked-winner, no-losing-side, undetermined, and timeout refunds;
- duplicate epoch, resolution, timeout, claim, and role-change rejection;
- bounded global/open/wallet pagination;
- asynchronous child-delivery monitoring without an unsafe retry.

## Deployment status

Deployment transaction
`0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` is `FINALIZED` with
`MAJORITY_AGREE` and successful leader execution. GenVM lint passed with a 29-method schema and V7
direct tests passed 22/22; the combined V6/V7 direct suite passed 37/37 at deployment review time.

The live configuration and catalogs were read back and 25 exact-hour epochs were created: one canary
plus an initial 24-target full-day set. The funded two-wallet V7 canary is complete, including shared
resolution, three finalized claim-parent/EOA-child deliveries, expected loser rejection, exact
1.748 GEN balance conservation, and a finalized 0.002 GEN fee-withdrawal child. Dedicated keeper
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` was installed by finalized owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc` and confirmed by exact
`get_config` read-back. It then created epochs `1787256000` and `1787259600` through finalized
transactions `0xe10ce0bf…a9c4` and `0x00398a3c…9058`; both post-states were verified OPEN.
Default-branch run `32299468899` then passed exact keeper/profile reconciliation with no actions and
completed the initial bounded history sync; later verified no-action run `32300282482` repeated both jobs
successfully. StudioNet receipt-proof fix `e5627ebd270a7c6d5291151795b0af6442eba0a6` and protected
backfill run `32309637237` now prove the selected deployment/canary/fee records. The public Vercel
alias targets V7 through READY deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`; browser bundle
`market-BHlwjm1W.js` has SHA-256
`c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`. Vercel metadata anchors it
to `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records `gitDirty=1`. Keeper receipt grace is
merged on main `958e51743a821606ca78881e6bcc8fb0a34a8e8f`: seven same-hash attempts with 315 seconds of
outer backoff and no resubmission. The first live action-bearing scheduled run under that policy,
long-run monitoring, outage recovery, and external review remain pending.

See [`../docs/STUDIONET-V7.md`](../docs/STUDIONET-V7.md) and
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).
