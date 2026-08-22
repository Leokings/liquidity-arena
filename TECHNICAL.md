# Liquidity Arena V7 technical architecture

This document describes the deployed StudioNet V7 release target. V7 is finalized at
`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`, and the public Vercel browser now targets V7 with V6
legacy recovery retained. The dedicated keeper rotation and funded V7 canary are
complete. The public app and automation do not create V6 epochs or route new V6 wagers; the deployed
V6 owner capability
still exists and must not be used. V6 remains available for legacy reads, claims, and eligible
permissionless resolve/timeouts.

## System boundary

| Component | Authority and responsibility |
| --- | --- |
| Browser | Liquid visualization, epoch selection, wallet intent, finalized receipt recovery, V7 writes after cutover, and V6 legacy read/resolve/timeout/claim recovery |
| Web/API service | Live exchange fan-out, bounded historical candles, same-origin StudioNet RPC adapter, health, readiness, caching, and rate limiting |
| StudioNet V7 contract | Exact-hour schedule, test-GEN escrow, shared result, HIGH/LOW accounting, fees, refunds, claims, and authoritative history |
| Limited keeper | Creates missing future epochs; may also invoke permissionless resolve/timeout methods, but has no owner or treasury powers |
| Authoritative keeper journal | Neon-backed fenced global signer lease and append-only pending-operation/hash recovery boundary; it gates keeper writes but never settlement outcomes |
| Durable history projection | Neon-backed copy of settled public state for browsing and operations; migration, repeated V7/V6 projection, and selected V7 proof backfill passed, outage recovery and broader proof coverage remain pending, and it is never settlement authority |
| Operations watchdog | GitHub-native checks of readiness, projection integrity, journal health, and keeper recency/conclusion; synthetic issue open/recovery/close delivery is proven; an independent pager is optional and not configured |
| Backup scheduler | Cron-only Cloudflare Worker checks current-hour GitHub keeper/watchdog runs and conditionally invokes their existing `workflow_dispatch` entry points; it has no GenLayer, Neon, journal, owner, treasury, or keeper credential |

GenLayer validators and the V7 contract are the settlement authority. The live stream, API cache,
browser animation, keeper plan, and database projection cannot choose or alter a winner.

## Canonical epoch

An epoch is the exact UTC end timestamp `E`, with `E % 3600 == 0`:

```text
E-60m          E-40m          E-20m                         E        E+120s
| BUFFER       | WAGERING     | BATTLE                      | PUBLISH | RESOLVABLE
```

- creation must occur at least one hour before `E`;
- wager open: `E - 2400`;
- wager close and battle baseline: `E - 1200`;
- battle end: `E`;
- resolution gate: `E + 120`;
- timeout-refund gate: `E + 86400`.

There are exactly 24 epoch targets per UTC day. Contract time and user-facing epochs proceed
independently while an older transaction awaits finality, but the keeper must stop all later writes
until the unresolved journal operation is recovered.

## Evidence policy

V7 fixes `CRYPTO_SPOT_1M_MEDIAN_V1`, assets BTC/ETH/BNB/SOL/XRP, and venues Binance/OKX/Bybit/Gate/
KuCoin in contract source. For each venue the resolver:

1. requests the completed one-minute candle whose open establishes the `E-20m` baseline and the
   completed candle ending at `E`;
2. validates the fixed spot symbol, timestamp alignment, response bounds, schema, and positive
   prices for all five assets;
3. rejects the entire venue if any asset is invalid;
4. calculates signed fixed-point returns in parts per billion (`1e9` scale);
5. requires at least three complete venue baskets;
6. selects the per-asset median across the same qualifying venue set; with four venues, it uses the
   floor average of the middle two signed values.

The shared five-return vector selects `HIGH` by maximum and `LOW` by minimum. Equal extrema produce
a tied objective. GenLayer validators independently rerun the evidence logic and compare the result
within the contract's fixed tolerance before consensus can finalize the write.

Fewer than three complete venues is a retryable quorum failure and does not authorize a guessed
winner. If the epoch remains open for 24 hours, the permissionless timeout path makes both pools
zero-fee refundable.

## V7 contract surface

Important writes:

```text
set_keeper(address)                         owner
propose_ownership(address)                  owner
cancel_ownership_transfer()                 owner
accept_ownership()                          pending owner
set_platform_fee_bps(bps)                   owner, maximum 500
create_epoch(E)                             owner or keeper
enter(E, HIGH|LOW, asset) payable           participant
resolve_epoch(E)                            permissionless after E+120s
activate_timeout_refund(E)                  permissionless after E+24h
claim(E, HIGH|LOW)                          participant
withdraw_accrued_fees(amount_atto)          owner or treasury
```

V7 moves stake limits out of `create_epoch`. The immutable deployed limits are 0.1 GEN minimum and
10 GEN maximum per wallet/objective; the epoch snapshots those values and the current fee. This
prevents a compromised keeper from choosing economic parameters while scheduling.

The keeper may create at most 26 hours ahead. The owner may recover scheduling but cannot create
more than 31 days ahead. Ownership transfer is two-step. Changing the keeper or fee affects only
future actions/epochs; already created epoch snapshots remain immutable.

Important views include `get_config`, asset and venue catalogs, total/open epoch counts and bounded
pages, `get_epoch`, `get_epoch_asset`, `get_objective`, `get_entry`, `get_claim_quote`, bounded wallet
position pages, `get_fee_state`, and total player liability.

## Accounting

Amounts are integer attoGEN (`10^18` attoGEN per GEN). HIGH and LOW have separate stake and payout
accounting even though they share one market vector.

For a backed winner with a losing side:

```text
losing_pool = total_pool - winning_stake
fee = floor(losing_pool * epoch_fee_bps / 10_000)
payout_pool = total_pool - fee
wallet_payout = floor(wallet_winning_stake * payout_pool / winning_stake)
```

The last eligible winning claimant receives any integer remainder. The default epoch fee is 200 bps
(2%) and the hard configuration cap is 500 bps (5%). A tie, unbacked winner, no losing side,
consensus-recorded undetermined result, or timeout returns eligible principal and accrues no fee.

Only accrued platform fees may be withdrawn. The treasury withdrawal check preserves:

```text
contract balance >= outstanding participant liability + accrued unwithdrawn fees
```

Claims are pull-based and effects-first. V7 emits the exact EOA transfer on finalization. The
off-chain monitoring verifies the parent, child, recipient, amount, finality, and credited-value proof
but is strictly read-only. The checked-in claim monitor requires an explicit V6 or V7 deployment
profile and has tests for both identities. The live V7 canary proved three finalized claim-parent/
EOA-child deliveries and an exact fee-withdrawal parent/child delivery. There is no blind claim retry
because a delayed original child could later pay and make a retry a double payment.

## Keeper and readiness

The V7 reconciler derives 24 future exact-hour targets, scans only the bounded on-chain open-epoch
index, and produces a dry-run plan by default. Before every write it verifies:

- StudioNet chain `61999`;
- exact protocol, policy, assets, venues, timing, precision, fee, and stake limits;
- expected owner, keeper, and treasury addresses;
- current signer equals the configured keeper immediately before submission;
- an acquired and renewable fenced global signer lease;
- recovery of every authoritative nonterminal operation before planning;
- durable PREPARE before broadcast and exact captured-hash binding immediately after submission;
- full exact transaction recipient, method, arguments, `FINALIZED` successful execution, and
  matching post-state before VERIFIED.

Raw `gen_getTransactionStatus` is a bounded liveness lane, not receipt or execution proof. Unknown,
pending, ambiguous, quarantined, or otherwise unverified operations block every later write. An
exact receipt-verified `FINALIZED_FAILURE` may be retried only as a new append-only numbered attempt;
the earlier attempt and hash remain immutable. Workflow artifacts and caches have no journal
authority.

The live keeper is `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`. Owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc` finalized with
`MAJORITY_AGREE` and successful leader execution, and exact `get_config` read-back confirmed the
role. The matching encrypted-keystore secret names are present in GitHub environment
`studionet-keeper`, and repository variable `V7_KEEPER_ADDRESS` records the same address.
Local execution as that keeper created epoch `1787256000` with finalized transaction
`0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4` and epoch `1787259600` with
finalized transaction `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`;
both exact post-states were verified OPEN. This proves the limited on-chain role, not scheduled
workflow operation.

Historical minute-3/minute-13 activation produced scheduled run `32298454771`; reconciliation passed
while its independent history job hit the provider quota. Later workflow-dispatch run `32299468899`
passed exact-profile/runtime-signer reconciliation with no actions and completed bounded history
sync. The authoritative-journal canary then completed successfully in manual run `32325583494` on
commit `f937b95a108dddd84e4fda3149452a2c22dd8f84`: reconcile job `96296050506` verified six operations
(three resolves and three creates), recovering one exact operation across runs and submitting and
verifying five new operations; history job `96297112208` also succeeded. Authenticated journal API
health was active at `ready=true`, `schemaVersion=3`. V6 workflow `338089016` remains
`disabled_manually`, and its `main` YAML is `workflow_dispatch`-only. PR #11 merged as `81850e3` and
restored the V7 cron source. Scheduled run `32329108358` passed reconcile job `96306191739` and
history job `96306791996`, verifying one resolve and one create. Second action-bearing scheduled run
`32332196428` on source `2664e739` passed reconcile job `96314848434` and history job `96315355338`,
verifying RESOLVE `1787198400` and CREATE `1787292000` with zero deferred reads/actions. Contract
time defines every gate. `resolve_epoch` and `activate_timeout_refund` remain permissionless, so
scheduler loss cannot create an exclusive operator deadlock.

The 24-hour checkpoint ending approximately `2026-08-21T06:50Z` found 25/25 delivered scheduled
runs successful, 50/50 jobs successful, and 52/52 journal actions VERIFIED—26 resolves and 26
creates—with 62/62 total operations and zero unresolved before post-soak maintenance. The old
minute-3/minute-13 cron declared 52 slots but GitHub emitted only 25 records (48.08%); the longest
observed gap was `01:39:05`. Catch-up run `32439590155` verified four actions safely. PR #15,
merge `abef30d7268b34331528c470cc2a06eefe50ba33`, replaced that cadence with minute 27 and added
`queue: max` to the shared concurrency group for all chain/history writers. The queue prevents the
default pending-run replacement behavior; Neon remains the cross-run fencing authority.

The independent backup scheduler lives in
[`ops/cloudflare-keeper-scheduler`](ops/cloudflare-keeper-scheduler/README.md). GitHub's minute-27
keeper and minute-47 watchdog schedules remain primary. At minutes 37 and 57 UTC, Cloudflare lists
the corresponding `main` workflow runs and skips when the current hour already has an active or
successful run. Absence or failed runs trigger the existing workflow on `main`. A network failure,
HTTP 429, or GitHub 5xx errs toward dispatch; HTTP 401/403/404 stops as a configuration fault. Any
late duplicate is serialized by `queue: max`, fenced by the Neon journal, and revalidated against
contract state.
The Worker is a trigger only and cannot sign a transaction. Production evidence now exists for
Worker version `536e6476…cea7`: keeper workflow-dispatch run `32473485508` passed reconciliation
and 3/3 history projection with VERIFIED RESOLVE `0x62331f…c746` and CREATE `0x310fc6…5445`;
watchdog run `32473776356` passed; and the following minute-57 invocation logged
`CLOUDFLARE_BACKUP_SKIPPED/current_hour_run_succeeded` instead of duplicating the healthy run.
The post-merge minute-37 cycle also passes: on the tick scheduled for `2026-08-21T14:37:29Z`, the
Worker logged the skip at `2026-08-21T14:37:30.115Z` because successful current-hour native GitHub
scheduled run `32490379141` on `5ac2c1f` had VERIFIED one RESOLVE
and one CREATE; jobs `96796351916`/`96797302128` projected 1/3/3/0, downstream watchdog
`32490747878`/`96797531668` passed, and integrity reached 39 terminal, 39 resolve, 0 timeout with zero
gaps.

Readiness shares the same deployment configuration as the server. For V7 it checks chain, contract
identity, roles, stake and fee policy, exact-hour coverage, and all five live feeds. V6 legacy and
active V7 player liability are reported separately and do not turn unreadable values into false
zeros. The current V7 liability is 2 GEN across two eligible unclaimed refunds; this is a participant
obligation and is deliberately non-blocking for service readiness.

As of 2026-08-21, the claim/refund navigation changes are merged and deployed. [PR
#21](https://github.com/Leokings/liquidity-arena/pull/21) merged at
`5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475`; CI run
[`32488727873`](https://github.com/Leokings/liquidity-arena/actions/runs/32488727873), CodeQL run
[`32488727758`](https://github.com/Leokings/liquidity-arena/actions/runs/32488727758), and Cloudflare
scheduler CI run [`32488727814`](https://github.com/Leokings/liquidity-arena/actions/runs/32488727814)
succeeded. Production deployment `dpl_5FdBbP3e76rwgy1EzqyJYofG4Hxx` is READY/PROMOTED from that exact
source. Its pre-modal CTA exposes a truth-labeled aggregate or check state; same-deployment
navigation remains inside the SPA; cross-deployment navigation explicitly reloads and reconnects;
and reloads preserve nonsecret exact claim intent. The pre-write quote is intent: immediately before
writing, the gateway rechecks exact quote identity, wallet account, and StudioNet. Finalized actual
proceeds must be at least the quote; exact child delivery is verified against the actual amount, and
activity/recovery stores that actual amount. Aggregates are verified-current only after all known
rows load and every deployment read succeeds. Incomplete current pagination can show an explicit
partial lower bound with `LOAD OLDER`; failed or refreshing cached deployments instead use neutral
`LAST VERIFIED`/`PARTIAL` labels and retry controls, never a false `≥` lower bound; a zero-known
incomplete result prompts `CHECK`/`RETRY` instead of asserting zero eligibility. Final release
evidence is 210/210 market tests, 7/7 focused claim tests, 24/24 Playwright cases (12 journeys across
`chromium`/`mobile-chromium`, Desktop Chrome/Pixel 7, one worker), 434/434 full tests, a 477-module
build, and zero audit findings. Production browser verification reached the exact V7 HIGH deep link
for epoch `1787205600` and exposed its enabled reconnect-to-claim action. This does not prove a value
transfer: a live user-wallet signature, finalized claim transaction, and exact child delivery remain
untested. The modal focus-containment fix approved by an internal independent Codex diff review merged in [PR
#26](https://github.com/Leokings/liquidity-arena/pull/26) at `2026-08-21T14:55:40Z` as
`881e74895a31cb3cf82c078f4252110306684f30`; main CI `32494801072` and CodeQL `32494801089` have
passed jobs `96810573370`/`96810573060` and `96810573794`/`96810574148`, respectively. Successful
GitHub deployment `6023788676` and READY Vercel deployment `dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr`
form the last runtime-changing checkpoint from exact source `881e748`; its verified bundle identity is recorded in the deployment
registries. Health/readiness are green at exact V7/keeper/coverage/five feeds; the artifact/browser
history snapshot was 39/39/0 with zero gaps. Later documentation validation at
`2026-08-21T15:16:17.648Z` observed HTTP 200 ready, journal 3, 40/40/0, and zero gaps. An independent
read-only Codex immutable-HIGH/alias-LOW desktop/mobile focus audit passed with
P0/P1/P2 all zero, including containment, wrap, Escape fallback, opener restore, mobile layout,
and zero site-origin errors. Pytest advisory
[GHSA-6w46-j5rx-g56g](https://github.com/advisories/GHSA-6w46-j5rx-g56g) was fixed by PR #22 merge
`e79192eb25294bb59dc0dd31b55dee97085a464f`.

## Visualization and history

The ROUND layer resets to an equal baseline at `E-20m`. During battle, live exchange data produces a
clearly provisional estimate. Territory area is monotonically derived from return; flow direction
uses momentum and turbulence uses volatility/disagreement. At finality, the five V7 `return_ppb`
values replace the provisional display for that epoch.

The 1H, 4H, 1D, and 1W views are rolling context and never reset with the wager epoch. The contract's
paged epoch and wallet views are authoritative. The Neon production migration has been applied and
its expected six tables and four indexes read back. History job `96218806119` then synchronized two
deployments, two E19 epochs, and two full snapshots from state read at
`2026-08-19T20:38:39.397Z`. A second successful run, `32300282482`, synchronized V7 E20 and
overlapping V6 E19 without duplication; public history now contains V7 E20/E19 and V6 E19.
Projection repetition is proven. Merged StudioNet receipt verifier fix
`e5627ebd270a7c6d5291151795b0af6442eba0a6` then enabled protected proof-backfill run
`32309637237` to accept 11 records with zero rejections. One deployment proof and one epochless fee
parent sit outside epoch arrays; V7 E19 exposes the other nine finalized proofs (creation 1, wagers
4, resolution 1, credited claims 3). V7 E20 and V6 E19 remain at zero because they were outside this
selected proof set. Outage recovery and broader proof coverage remain pending.

Keeper-journal migration 002 is separate from the non-authoritative history projection. It was
prepared as migration `1e440327-2e66-403d-934d-c302790ac775` on temporary branch
`br-sweet-frost-auakkl85`, applied identically to Neon production branch
`br-calm-fire-aup0rw0r`, and the temporary branch was deleted. Final checksum
`d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`
read back with unchanged history v1, four journal tables, the trigger, and zero operations at that
migration-time read-back.
Migration 003 `keeper_transaction_journal_attempts` was then applied to project
`steep-hat-04600004`, parent branch `br-calm-fire-aup0rw0r`, as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through temporary branch
`br-polished-shape-aund54y0`, which was deleted. Checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70` read back with exact versions
1/2/3, zero operations at that migration-time read-back, four attempt-lineage columns,
`QUARANTINED` in the unresolved unique index, and the parent-freeze trigger. The matching API is now
deployed, authenticated health reports `ready=true` with `schemaVersion=3`, and manual run
`32325583494` proved the schema under six VERIFIED live operations.

PR #15 adds a fail-closed projection-integrity diagnostic that cross-checks every VERIFIED V7
terminal journal operation against the durable epoch and, when determined, its asset snapshot. The
pre-repair result was 31 terminal operations, three missing durable epochs, one stale epoch, and zero
missing snapshots. Serialized V7-only repair runs `32458718433`, `32459026957`, and `32459340292`
synchronized 3/3, 2/2, and 2/2 epochs/snapshots with no proof failures or rejections and closed all
four gaps. Manual keeper run `32459740369` then VERIFIED RESOLVE `1787295600` and CREATE
`1787389200`; dependent history job `96704818464` synchronized 3/3 at
`2026-08-21T07:45:20.943Z`. That checkpoint read 64/64 journal operations VERIFIED with zero
unresolved and 32/32 history integrity. The recorded post-merge public history-health snapshot was
`200` at 39/39/0 with zero timeout, missing, stale, or missing-snapshot rows; later keeper cycles are recorded by exact
operations without asserting a new aggregate journal count.

## V6 compatibility boundary

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is not a fallback write target. Its final due epochs
`1787155200` and `1787158800` were resolved on 2026-08-19 by `0xae0ce453…e1480` and
`0x09f01c2a…e735`. The drain workflow contains no creation action and the public registry disables
new V6 wagers, but the deployed owner-only `create_epoch` method remains callable and must not be
used. An earlier pre-resolution observation left epochs `1787162400` and `1787166000` OPEN
(RESOLVABLE and SCHEDULED); later drains resolved them with `0x03f2ac80…0399` and
`0x7e8030f0…27bb`. A final live audit found exactly five epochs, all RESOLVED/DETERMINED,
zero remaining payout/unclaimed winning stake, zero player liability, and no drain action. Recurring
drain execution is retired; live workflow `338089016` is `disabled_manually`, and its merged `main`
source is `workflow_dispatch`-only. The browser
deployment registry must enforce:

- V7 only for new epoch discovery and new wagers after cutover;
- V6 only for old epoch reads, wallet history, eligible resolves/timeouts, and claims;
- explicit allowlisted deployment aliases, never an arbitrary address from the URL;
- a rollback that can restore the last verified browser artifact without writing new V6 rounds.

## Deployment and finality

V7 deployment transaction
`0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` finalized with
`MAJORITY_AGREE` and successful execution. The recorded source SHA-256 is
`2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`.

Twenty-five V7 epochs were seeded: canary epoch `1787166000` plus 24 exact-hour targets from
`1787169600` through `1787252400`. The full-day seed begins with creation transaction
`0x7b94b2d0…7726` and ends with `0x443afcf7…7677f`; this is creation evidence, not proof that the
scheduled workflow is continuously active. Two additional exact-hour epochs, `1787256000` and
`1787259600`, were then created and OPEN-state verified through the dedicated keeper transactions
recorded above.

The manual canary and two restored scheduled action-bearing cycles raised the dated evidenced live
read-back total to at least 36 exact-hour epochs: 25 seeded, two local dedicated-keeper creates, and
nine workflow-created epochs. Neon held 10 journal operations, all VERIFIED, with zero unresolved
after the second scheduled run. The later 24-hour checkpoint and post-merge manual run superseded
that operational count with a dated 64/64 VERIFIED, zero-unresolved checkpoint; subsequent exact
operations are recorded separately.

The funded canary resolved with transaction
`0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66` from four qualified venues.
HIGH selected unbacked SOL at `4394531` ppb and refunded both 0.1 GEN HIGH entries. LOW selected BNB
at `170154` ppb and paid 0.198 GEN after a 0.002 GEN fee. Three exact claim children delivered 0.398
GEN, an ineligible LOW XRP claim was rejected without state change, and the fee child delivered the
remaining 0.002 GEN to treasury. Balances moved from 0.700/0.648/0.400 GEN before resolution, to
0.800/0.946/0.002 after claims, to 0.802/0.946/0 after fee withdrawal; 1.748 GEN was conserved at
each checkpoint.

Historical verified production artifact `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` was READY at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app` and serving the production
alias. Vercel metadata anchors it to receipt-proof commit
`e5627ebd270a7c6d5291151795b0af6442eba0a6` while recording `gitDirty=1`; exact browser artifact
identity is bundle `market-BHlwjm1W.js` with SHA-256
`c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`. CI run `32308815377`
passed browser/operator job `96247333491` and intelligent-contracts job `96247333299`. Health,
readiness, and history
health returned `200`. Readiness identified V7, two covered epochs, five feeds, and readable V6 with
zero known player liability. Proof view PR #6 has since merged and is deployed. The historical
schedule-restoration production artifact that executed first restored run `32329108358` was READY
Vercel deployment
`dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, GitHub deployment `5994871034`, source
`81850e3c814cd541d392fdeecf4dacca753d25e6`. Bundle `/assets/market-BQWvq82y.js` is 188376 bytes with
SHA-256 `37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

The historical stream-hardened production runtime is READY Vercel deployment
`dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
`https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app`, GitHub deployment
`5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI run `32332498286` passed
browser/operator job `96315684498` and intelligent-contracts job `96315684590`. Bundle
`/assets/market-DTvIR-Xr.js` is 191538 bytes with SHA-256
`7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. The runtime has a shared
ref-counted EventSource, `supportsCancellation=true`, disconnect cleanup, about 240 steady Studio
calls/hour, and a cap of four concurrent streams per IP. Browser trace proved one HTTP-200 stream for
ROUND→4H, exactly one HTTP-200 stream per rapid reload across two reloads, LIVE/FRESH without
STALE/errors, and an immediate independent curl returning five-asset live events. Public
health/readiness/history-health/proof endpoints all returned HTTP 200; readiness matched chain
`0xf22f`, exact V7/keeper configuration, epoch coverage, and zero V6 liability.

The initial post-soak production artifact was READY Vercel deployment
`dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
`https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017361124`, source/merge `abef30d7268b34331528c470cc2a06eefe50ba33`. CI run `32458652480`
passed browser/operator job `96700917346` and intelligent-contracts job `96700917084`. Bundle
`/assets/market-B8kYJwYW.js` is 191540 bytes, ETag
`W/"aed8cd3722fd07b7762e4331cd94d235"`, SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public health, readiness,
history-health, and proof surfaces return HTTP 200. Manual watchdog `32459656268`/`96703858691` and
automatic `workflow_run` `32460047757`/`96704995526` pass. Synthetic run `32461072315` opened
issue #17 after an injected failure, and recovery run `32461245006`/job `96708451794` rechecked every
surface, closed the issue, and posted the recovery comment. This proves GitHub-native delivery;
an independent pager remains an optional enhancement.

The previous runtime-changing production artifact and synthetic-watchdog evidence checkpoint was the
READY/PROMOTED Vercel deployment
`dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
`https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI run
`32461039766` passed jobs `96707863823` (393/393, build 477, audit 0) and `96707864002` (lint plus 37
direct tests). Bundle `/assets/market-BoHfo81C.js` is 193040 bytes, ETag
`"fa10949a324593024ea6c209eb3a0cc3"`, SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint does not assert that the public alias still targets it. Later evidence-publication
deployments may supersede the alias and produce different artifact bytes because the deployment registries are
serverless build inputs; they do not retroactively change this checkpoint. Any behavior-affecting consumed
registry-field change requires separate validation.

Main commit `958e51743a821606ca78881e6bcc8fb0a34a8e8f` separately extends keeper receipt propagation to
seven attempts on the same hash, using 315 seconds of outer backoff and no write resubmission; CI run
`32310160397` passed. Scheduled run `32312864108`, job `96259232716`, on that exact head then
exhausted all seven lookups for CREATE `0xe6af…3574` and RESOLVE `0x0850…c7e`. Both exact writes
later reached `FINALIZED` and applied their OPEN/RESOLVED post-states. This proves receipt indexing
can lag beyond 315 seconds; it is not a successful journal-backed action run. Proof view PR #6 later
merged and was deployed. Manual run `32325583494` subsequently proved the authoritative recovery
path by recovering one exact operation across runs and ending with six VERIFIED operations without
duplicate submission. Restored scheduled run `32329108358` then verified RESOLVE `1787194800` and
CREATE `1787288400`; post-run journal read-back was 8/8 VERIFIED with zero unresolved, and dependent
history synchronization passed. Second scheduled run `32332196428` then verified exact attempt-1
RESOLVE transaction `0xebc4478607bbc6ca17d670dafa05d4aca99d8282959db50072fa881af47199dd`
and CREATE transaction `0x3d4b235c91dbefaeffc1f790ed5a4f3466cefb7b452d190aac12eb4c099b8a88`;
both finalized with majority agreement and matching post-state. Neon read back 10/10 VERIFIED with
zero unresolved, and the dependent two-deployment/two-epoch/two-snapshot history sync passed.

Observed StudioNet finality has been in the tens-of-seconds range, and an earlier V6 funded resolver
was observed at 53.38 seconds record-to-finalized. These are samples for UX design only, not a bound
or SLA. The application requires `FINALIZED`; it never treats `ACCEPTED` as settlement or payment
delivery.

## Current release gaps

- GitHub schedule delivery reliability after only 25 of 52 nominal slots emitted run records; the
  GitHub-native alert path and independent Cloudflare keeper-dispatch/watchdog-skip paths are proven,
  while a third-party pager remains optional; live V6 workflow remains disabled at zero player liability;
- database-outage recovery and proof coverage beyond the selected V7 deployment/canary/fee set;
- a live StudioNet user-wallet signature, finalized claim transaction, and exact child-delivery
  proof, continued public browser/wallet soak,
  and a rollback rehearsal that never re-enables V6 writes;
- live 24-hour timeout evidence and safe asynchronous-child recovery. V7 has no upgrader and no
  safe retry state; this V7 protocol P1 and the implemented but inactive/unbroadcast V8
  idempotent-escrow candidate are documented in
  [the payout-recovery design](docs/V8-PAYOUT-RECOVERY.md);
- independent contract/web/operations review and provider data-use/legal review.

See [the V7 deployment note](docs/STUDIONET-V7.md) for the current gate ledger.
