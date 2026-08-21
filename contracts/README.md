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

## V7 immutability and payout-recovery boundary

V7 registers no upgrader and exposes no upgrade method, so the deployed contract cannot receive an
in-place payout-recovery patch. Its `claim()` state/accounting effects occur before the independent
native value-transfer child is emitted. A delayed or ambiguous child therefore cannot be retried
safely: it might later credit and turn a second payment into a double payment. The delivery monitors
remain read-only, and this is an unresolved protocol P1 rather than a browser-only defect.

The active V7 deployment currently reports 2 GEN across two eligible unclaimed refunds. Those are
participant obligations and remain claimable on V7. A fresh-deployment V8 state machine,
delivery-loss reserve, and idempotent payout-escrow proposal are documented in
[`../docs/V8-PAYOUT-RECOVERY.md`](../docs/V8-PAYOUT-RECOVERY.md). The claim/refund UX merged in
[PR #21](https://github.com/Leokings/liquidity-arena/pull/21) and is deployed from exact source
`5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475`; it improves discovery and reconnection but does not
change this contract boundary. Its pre-write quote is intent; wallet account and StudioNet are
rechecked immediately before writing; finalized actual proceeds must be at least that quote; and
delivery plus activity/recovery use the actual amount. Final accessibility release evidence is 210/210 market,
7/7 focused claim, 24/24 browser cases across 12 `chromium`/`mobile-chromium` journeys, 434/434 full
tests, a 477-module build, and audit 0. Production route/reconnect UI was browser-verified, but no
live user-wallet signature, finalized claim transaction, or exact child delivery was performed. The
focus-containment fix approved by an internal independent Codex diff review merged as PR #26 commit
`881e74895a31cb3cf82c078f4252110306684f30`; CI/CodeQL passed and its exact replacement deployment
`dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr` was READY at verification. An independent read-only Codex
desktop/mobile production focus audit passed with P0/P1/P2 all zero,
but no wallet action or signature was submitted. It does not change V7 or resolve the payout-recovery
P1.

Operational evidence outside the immutable contract boundary also passed. Native GitHub scheduled
keeper run [`32490379141`](https://github.com/Leokings/liquidity-arena/actions/runs/32490379141)
verified one resolve and one create, projected 1 deployment/3 epochs/3 snapshots/0 proofs, and was followed by
successful watchdog run
[`32490747878`](https://github.com/Leokings/liquidity-arena/actions/runs/32490747878); Worker version
`536e6476-3c4e-4b93-a454-700f55d6cea7` then emitted `CLOUDFLARE_BACKUP_SKIPPED` because the current
hour's primary run had succeeded. Pytest advisory
[`GHSA-6w46-j5rx-g56g`](https://github.com/advisories/GHSA-6w46-j5rx-g56g) was fixed by
[PR #22](https://github.com/Leokings/liquidity-arena/pull/22), merge
`e79192eb25294bb59dc0dd31b55dee97085a464f`; neither operational change alters V7 or closes its
payout-recovery P1.

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

The post-soak integrity gate now cross-checks VERIFIED V7 terminal journal operations against durable
epochs and determined snapshots. Repair runs `32458718433`, `32459026957`, and `32459340292`
synchronized seven epochs/snapshots and moved the diagnostic from 31 terminal operations with three
missing and one stale epoch to 31/31 with zero missing, stale, or missing-snapshot rows. After manual
keeper run `32459740369`, history-health reported 32/32 verified terminal/resolve operations and zero
gaps; the later post-merge snapshot was 39/39/0 with zero gaps. Documentation validation at
`2026-08-21T15:16:17.648Z` then observed HTTP 200 ready, journal 3, 40/40/0, and zero gaps. These are
time-qualified observations over an off-chain projection, not contract authority.

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
completed the initial bounded history sync; later verified no-action run `32300282482` repeated both
jobs successfully. StudioNet receipt-proof fix `e5627ebd270a7c6d5291151795b0af6442eba0a6` and protected
backfill run `32309637237` prove the selected deployment/canary/fee records, and proof-view PR #6 is
merged and deployed. Historical verified Vercel deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` was
READY at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`; browser bundle
`market-BHlwjm1W.js` has SHA-256
`c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`. Vercel metadata anchors it
to `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records `gitDirty=1`. Keeper receipt grace is
merged on main `958e51743a821606ca78881e6bcc8fb0a34a8e8f`: seven same-hash attempts with 315 seconds of
outer backoff and no resubmission. The first live scheduled use, run `32312864108` / job
`96259232716`, exhausted all seven receipt lookups even though CREATE `0xe6af…3574` and RESOLVE
`0x0850…c7e` later finalized and applied. Manual authoritative-journal run `32325583494` on commit
`f937b95a108dddd84e4fda3149452a2c22dd8f84` then succeeded: reconcile job `96296050506` verified
six operations (three resolves and three creates), including one operation recovered across runs and
five newly submitted operations; history job `96297112208` also succeeded. At that manual-run
checkpoint, evidenced coverage was at least 34 epochs, including seven workflow-created epochs. V6 workflow `338089016` remains
`disabled_manually`, with its `main` YAML `workflow_dispatch`-only. PR #11 merged as `81850e3` and
restored the V7 cron source. Scheduled run `32329108358` passed reconcile job `96306191739` and
history job `96306791996`, verified one resolve and one create, and left Neon at 8/8 VERIFIED with
zero unresolved. Live epoch count was 35, including eight workflow-created epochs. Second scheduled
run `32332196428` passed reconcile job `96314848434` and history job `96315355338`, verified
RESOLVE `1787198400` and CREATE `1787292000`, and left Neon at 10/10 VERIFIED with zero unresolved;
evidenced coverage was at least 36 epochs, nine workflow-created at that checkpoint. The subsequent
24-hour audit found 25/25 delivered scheduled runs, 50/50 jobs, and 52/52 actions VERIFIED, split 26
resolve/26 create, with 62/62 journal operations and zero unresolved. Only 25 of 52 nominal cron
slots produced records, with a longest gap of `01:39:05`, so schedule delivery reliability remains a
known issue even though every delivered action passed. PR #15 merge
`abef30d7268b34331528c470cc2a06eefe50ba33` installs one minute-27 trigger, a durable shared
`queue: max` writer queue, mandatory three-epoch V7 projection, integrity health, active-player-
liability reporting, and a GitHub-native watchdog. Post-merge run `32459740369` added one exact
VERIFIED resolve/create pair; the journal at that checkpoint was 64/64 VERIFIED with zero unresolved.
Later keeper cycles are recorded by exact operations without asserting a new aggregate count. The
historical
READY artifact that executed the first restored run was
Vercel deployment `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, source
`81850e3c814cd541d392fdeecf4dacca753d25e6`, bundle `/assets/market-BQWvq82y.js` SHA-256
`37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`. The historical stream-
hardened runtime was READY Vercel deployment `dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj`, GitHub deployment
`5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`; CI `32332498286` passed jobs
`96315684498` and `96315684590`. Bundle `/assets/market-DTvIR-Xr.js` is 191538 bytes with SHA-256
`7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. Its shared ref-counted
EventSource and Vercel request cancellation passed reload/interval-switch browser stress with one
HTTP-200 stream per page load, LIVE/FRESH UI, no errors, and an immediate independent five-asset
HTTP-200 stream probe. Migration 002 was applied/read
back at checksum
`d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266` with zero operations at that
migration-time read-back. Its
fenced global signer lease, durable PREPARE-before-broadcast and exact-hash binding fail closed until
full receipt identity, successful execution, and post-state are proven; raw lifecycle status and
artifacts/caches are never proof or authority. Migration 003 retry-attempt lineage is applied and
production-read-back verified at checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70`; the matching API now reports
authenticated `ready=true`, `schemaVersion=3`, and the manual and scheduled runs prove live
execution. The initial post-soak runtime was READY deployment `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6`,
GitHub deployment `6017361124`, source `abef30d7268b34331528c470cc2a06eefe50ba33`, at
`https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app`. Bundle
`/assets/market-B8kYJwYW.js` is 191540 bytes with SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Manual and automatic
watchdog runs pass. Synthetic failure run `32461072315` opened issue #17; healthy recovery run
`32461245006`/job `96708451794` rechecked production, closed the issue, and posted the automated
recovery comment. GitHub-native delivery is proven; an independent third-party pager remains an
optional, unconfigured enhancement. Active V7 player liability is 2 GEN
across two eligible unclaimed refunds; it is an outstanding participant obligation, not a readiness
failure. Outage recovery and external review remain pending.

The previous runtime-changing production artifact and synthetic-watchdog evidence checkpoint was
READY/PROMOTED deployment `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K`,
GitHub deployment `6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`, at
`https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app`. Main-push CI
`32461039766` passed. Bundle `/assets/market-BoHfo81C.js` is 193040 bytes with SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint does not assert that the public alias still targets it. Later evidence-publication
deployments may supersede the alias and produce different artifact bytes because the deployment registries are
serverless build inputs; they do not retroactively change this checkpoint. Any behavior-affecting consumed
registry-field change requires separate validation.

See [`../docs/STUDIONET-V7.md`](../docs/STUDIONET-V7.md) and
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).
