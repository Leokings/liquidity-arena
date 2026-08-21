# Liquidity Arena V7 release audit ledger — 2026-08-21

## Conclusion

The deployed V7 source passes GenVM lint and its direct test suite. The redesign materially reduces
scheduled-key authority: the keeper can create fixed-terms hourly epochs but cannot choose stake
limits, change fees, administer roles, withdraw funds, or determine a result. Resolution and timeout
are permissionless.

This is a release audit ledger, not an independent external audit and not a production-safety
certificate. The funded V7 canary, Neon keeper-journal migrations 002/003, authenticated schema-v3
API health, and a six-operation action-bearing run through the replacement journal are complete.
The 24-hour delivered-run soak, post-soak projection repair, integrity health, and GitHub-native
watchdog healthy path and synthetic issue delivery/recovery are now complete. GitHub schedule
delivery produced only 25 of 52 nominal run records; an independent third-party pager is an optional
unconfigured enhancement. Durable-history outage recovery/
broader proof coverage, the 24-hour live timeout path, and claim-child failure recovery remain
incomplete gates. The first seven-attempt action-bearing run is
now recorded as receipt-index failure evidence, not pending success evidence. Dedicated keeper
rotation, default-branch signer/profile preflight, repeated history projection, selected proof
backfill, and public V7 cutover are complete.

The independent Cloudflare backup is no longer pending activation: Worker version `536e6476…cea7`
dispatched successful keeper run `32473485508` (VERIFIED RESOLVE `0x62331f…c746`, CREATE
`0x310fc6…5445`, and 3/3 history projection), successful watchdog run `32473776356`, and later
logged a minute-57 `CLOUDFLARE_BACKUP_SKIPPED/current_hour_run_succeeded` decision. The post-merge
cycle also passes: on the tick scheduled for `2026-08-21T14:37:29Z`, the Worker logged the skip at
`2026-08-21T14:37:30.115Z` for `current_hour_run_succeeded` run `32490379141` on `5ac2c1f`;
reconcile/history jobs
`96796351916`/`96797302128` VERIFIED RESOLVE `0x9d808082…b7742` to `RESOLVED`, CREATE
`0x6df7394b…945f9` to `OPEN`, and projected 1/3/3/0. Watchdog `32490747878`/`96797531668` passed;
integrity is 39 terminal, 39 resolve, 0 timeout, with zero gaps.

As of 2026-08-21, [PR #21](https://github.com/Leokings/liquidity-arena/pull/21) merged the claim/refund
UX at `2026-08-21T13:47:56Z` as squash
`5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475`. CI run
[`32488727873`](https://github.com/Leokings/liquidity-arena/actions/runs/32488727873), CodeQL run
[`32488727758`](https://github.com/Leokings/liquidity-arena/actions/runs/32488727758), and Cloudflare
scheduler CI run [`32488727814`](https://github.com/Leokings/liquidity-arena/actions/runs/32488727814)
succeeded. Final accessibility release gates are 210/210 market tests, 7/7 focused claim tests, 24/24
Playwright cases (12 journeys across `chromium`/`mobile-chromium`, Desktop Chrome/Pixel 7, one
worker), 434/434 full
tests, a 477-module build, and audit 0. Cached failed/refreshing deployment rows remain neutral `LAST
VERIFIED`/`PARTIAL` evidence and never a false `≥` lower bound.

An internal independent Codex diff review approved the four-file modal focus-containment change with no remaining P0/P1/P2,
and [PR #26](https://github.com/Leokings/liquidity-arena/pull/26) merged at
`2026-08-21T14:55:40Z` as `881e74895a31cb3cf82c078f4252110306684f30`. Main CI
`32494801072` passed browser/operator job `96810573370` and contracts job `96810573060`; CodeQL
`32494801089` passed JS/TS job `96810573794` and Python job `96810574148`. Successful GitHub
deployment `6023788676` and READY production Vercel deployment
`dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr` form the last runtime-changing checkpoint from exact source
`881e748`; an independent read-only Codex live-browser focus audit returned P0/P1/P2 all zero. Pytest advisory
[GHSA-6w46-j5rx-g56g](https://github.com/advisories/GHSA-6w46-j5rx-g56g) was fixed by PR #22 merge
`e79192eb25294bb59dc0dd31b55dee97085a464f`; the Dependabot alert was marked fixed at
`2026-08-21T14:38:20Z`.

The claim money path treats its pre-write quote as intent. It rechecks exact quote identity, wallet
account, and StudioNet immediately before writing. Finalized actual proceeds must be at least the
quote; the exact child is verified against that actual amount, which activity/recovery persists.

## V7 deployment identity

| Field | Recorded value |
| --- | --- |
| Network | GenLayer StudioNet, chain `61999` |
| Protocol | `LIQUIDITY_ARENA_V7` |
| Policy | `CRYPTO_SPOT_1M_MEDIAN_V1` |
| Contract | `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` |
| Deployment tx | `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` |
| Result | `FINALIZED`, `MAJORITY_AGREE`, successful execution |
| Recorded deployment time | `2026-08-19T17:15:58.617644Z` |
| Recorded finalization time | `2026-08-19T17:16:34.249123Z` |
| Source SHA-256 | `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F` |
| Source | `contracts/LiquidityArenaV7.py` |
| Currency | Native faucet test GEN |
| Fee | 200 bps default; 500 bps hard cap |
| Stakes | 0.1 GEN minimum; 10 GEN maximum per wallet/objective |

The machine-readable evidence is in
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).

## Completed V7 verification

- deployment receipt finalized with majority agreement and successful leader execution;
- local source hash recorded as
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- live `get_config`, asset catalog, venue catalog, roles, fee, stake limits, and timing read-back;
- GenVM lint passed with 29 schema methods;
- V7 direct suite passed 22/22 and the combined V6/V7 direct suite passed 37/37 at deployment review;
- 25 exact UTC hourly epochs were bootstrapped and read back: canary `1787166000` plus a 24-target
  full-day set from `1787169600` through `1787252400`; the first/final full-day creation hashes are
  `0x7b94b2d0…7726` and `0x443afcf7…7677f`;
- keeper tests cover fixed profile checks, 24-target derivation, bounded open-index reconciliation,
  serialized writes, receipt/post-state verification, and the signer recheck immediately before
  each write;
- dedicated keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` replaced the bootstrap wallet through owner
  transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, which reached `FINALIZED`
  with `MAJORITY_AGREE` and successful leader execution; exact `get_config` read-back and repository
  variable `V7_KEEPER_ADDRESS` match, and the two encrypted keeper secret names are present in the
  `studionet-keeper` environment;
- local execution as that dedicated keeper created epoch `1787256000` through finalized transaction
  `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4` and epoch `1787259600` through
  finalized transaction `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`;
  both exact post-states were verified OPEN, proving the limited on-chain role independently of CI;
- scheduled V7 run `32298454771` passed reconciliation; its separate history job failed on the
  StudioNet provider quota and was superseded by successful workflow-dispatch run `32299468899`,
  whose reconcile job `96218469576` passed exact profile/runtime-signer checks and correctly planned
  no actions;
- history job `96218806119` in run `32299468899` synchronized two deployments, two epochs, and two
  full snapshots from state read at `2026-08-19T20:38:39.397Z`; public V7 and V6 E19 records are
  resolved/determined;
- later successful workflow-dispatch run `32300282482` on main commit
  `45be825084cce9e97579ca42266e318e2e97fe17`
  passed reconcile job `96221017562` and history job `96221327115`; public history then contained V7
  E20/E19 and V6 E19 without duplicating overlapping V6 E19, with `proofsVerified=0`;
- StudioNet history receipt fix `e5627ebd270a7c6d5291151795b0af6442eba0a6` passed CI run
  `32308815377` and reuses the fail-closed finalized consensus/leader receipt validator;
- protected backfill run `32309637237`, job `96249796253`, passed all quota-spaced batches with 11
  accepted and zero rejected proof requests: one deployment proof, nine V7 E19 epoch proofs, and one
  epochless fee-withdrawal parent; public E19 read-back contains exactly one creation, four wagers,
  one resolution, and three credited claim proofs;
- keeper receipt-grace commit `958e51743a821606ca78881e6bcc8fb0a34a8e8f` passed CI run
  `32310160397` and performs seven same-hash attempts with 315 seconds of outer backoff and no write
  resubmission; scheduled run `32312864108`, reconcile job `96259232716`, then exhausted all seven
  lookups for CREATE `0xe6af5cd917427b5f5dadcbb77a56dc5c529a3b844a26008165c0e2c9f8d83574`
  and RESOLVE `0x0850dfa1098ce773b20c9407d602592eada74cc36004333dc3ec011930d71c7e`,
  although both exact transactions later finalized and their OPEN/RESOLVED post-states applied;
- the new CREATE raises the recorded coverage to at least 31 exact-hour epochs, including four
  workflow-created epochs;
- authoritative-journal run `32325583494` on
  `f937b95a108dddd84e4fda3149452a2c22dd8f84` passed reconcile job `96296050506`, recovered one
  previously bound resolve hash without resubmission, submitted five further writes, and finished
  with six VERIFIED operations—three resolves and three creates; history job `96297112208` also
  passed, raising the manual-run checkpoint to at least 34 epochs and seven workflow-created epochs;
- PR #11 restored the V7 minute-3/minute-13 schedule on main commit
  `81850e3c814cd541d392fdeecf4dacca753d25e6`; workflow `338089019` is active;
- first restored scheduled run `32329108358` passed reconcile job `96306191739` and history job
  `96306791996`, verified RESOLVE `1787194800` and CREATE `1787288400`, and left Neon with eight
  operations, all VERIFIED, zero unresolved; live epoch count was 35, eight workflow-created;
- second action-bearing scheduled run `32332196428` on `2664e739` passed reconcile job
  `96314848434` and history job `96315355338`, verified RESOLVE `1787198400` and CREATE
  `1787292000`, and left Neon with 10/10 VERIFIED operations and zero unresolved; evidenced coverage
  was at least 36 epochs, nine workflow-created at that checkpoint;
- the 24-hour checkpoint ending approximately `2026-08-21T06:50Z` found 25/25 delivered scheduled
  runs successful, 50/50 jobs successful, and 52/52 journal actions VERIFIED (26 resolve, 26 create),
  with 62/62 journal operations and zero unresolved before maintenance; the former two-trigger cron
  declared 52 slots but emitted only 25 records (48.08%), with a longest observed gap of `01:39:05`;
  catch-up run `32439590155` safely verified four actions;
- PR #15 merged as `abef30d7268b34331528c470cc2a06eefe50ba33` at `2026-08-21T07:26:39Z`, changing the
  cadence to one minute-27 trigger, adding durable `queue: max` writer serialization, required
  three-epoch V7 projection, projection-integrity health, active-player-liability diagnostics, and a
  GitHub-native issue watchdog; CI run `32458652480` passed jobs `96700917346` and `96700917084`;
- sequential repair runs `32458718433`/`96701115201`, `32459026957`/`96702015382`, and
  `32459340292`/`96702933162` passed, synchronizing 3/3, 2/2, and 2/2 epochs/snapshots with no proof
  failures/rejections; integrity moved from 31 terminal operations with three missing and one stale
  durable epoch to 31/31 with zero missing, stale, or missing-snapshot rows;
- post-merge keeper run `32459740369` passed reconcile job `96704099506` and history job
  `96704818464`, VERIFIED RESOLVE `1787295600` and CREATE `1787389200`, and synchronized 3/3
  epochs/snapshots at `2026-08-21T07:45:20.943Z`; that checkpoint read 64/64 VERIFIED with zero
  unresolved and 32/32 terminal/resolve history integrity. The later post-merge snapshot was 39/39/0
  with zero gaps;
- manual watchdog run `32459656268`/`96703858691` and automatic `workflow_run`
  `32460047757`/`96704995526` passed every surface check;
- synthetic failure run `32461072315` passed all production checks, injected a failure, and opened
  issue #17 at `2026-08-21T07:59:29Z`; recovery run `32461245006`/job `96708451794` rechecked every
  surface, closed the issue at `08:01:35Z`, and posted the automated recovery comment;
- scheduled legacy V6 drain run `32297047031` completed successfully without any creation action;
  the later live audit found all five V6 epochs resolved/determined and player liability zero, so
  recurring V6 drain execution is retired and live workflow `338089016` is `disabled_manually`;
- the dual-deployment browser registry is designed to allow only V7 new writes and V6 legacy
  reads/resolves/timeouts/claims, with explicit deployment aliases rather than arbitrary addresses;
- the read-only claim-delivery monitor requires an explicit V6 or V7 deployment profile and tests
  both identities;
- the Neon production migration with normalized marked-DDL SHA-256
  `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
  (raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`)
  was applied, and six expected tables plus four expected indexes were read back;
- separate Neon keeper-journal migration 002 was prepared as
  `1e440327-2e66-403d-934d-c302790ac775` on temporary branch `br-sweet-frost-auakkl85`, applied
  identically to production branch `br-calm-fire-aup0rw0r`, and the temporary branch was deleted;
  final checksum `d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`
  read back with the unchanged v1 checksum, four journal tables, the trigger, and zero operations at
  migration time;
- keeper-journal migration 003 `keeper_transaction_journal_attempts` was applied to project
  `steep-hat-04600004`, parent branch `br-calm-fire-aup0rw0r`, as migration
  `14160d53-a2a3-43ab-a762-6bb7e54a95e8` through deleted temporary branch
  `br-polished-shape-aund54y0`; checksum
  `9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70` read back with exact versions
  1/2/3, zero operations at migration time, four attempt columns, the `QUARANTINED` unresolved index,
  and parent-freeze trigger;
- CI run `32308815377` passed browser/operator job `96247333491` and intelligent-contracts job
  `96247333299`; historical READY deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` served the production alias
  with public health/readiness/history-health `200`; Vercel metadata anchors it to
  `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records `gitDirty=1`, while exact browser artifact
  identity is bundle `market-BHlwjm1W.js` SHA-256
  `c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`;
- the funded V7 canary for epoch `1787166000` completed with finalized resolution
  `0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66`, expected settlement modes,
  three exact participant claim deliveries, loser rejection, balance conservation, and exact fee
  withdrawal.

The four finalized/post-state-verified 0.1 GEN wagers were:

- account A: HIGH BTC `0x58f69072…c4fa` and LOW XRP `0xa6284710…5831`;
- account B: HIGH ETH `0xc0d5401c…2a19` and LOW BNB `0x80c1d306…7e9c`.

The four-venue result selected unbacked SOL HIGH (`4394531` ppb) and backed BNB LOW (`170154` ppb).
Two 0.100 GEN HIGH refunds and the 0.198 GEN LOW payout were delivered through three finalized exact
parent/child pairs. The losing LOW XRP claim `0xb0d9889a…e688` failed as expected without changing
state. The 0.002 GEN fee was delivered through parent `0x3df8d942…bb01f` and child
`0x566082ce…470e`. Balances moved from A/B/contract 0.700/0.648/0.400 GEN before resolution, to
0.800/0.946/0.002 after claims, to 0.802/0.946/0 after fee withdrawal. Liability and accrued fees
ended at zero and 1.748 GEN was conserved throughout. Full hashes are in the machine-readable
deployment record.

## Authorization review

V7 changes `create_epoch` from a parameterized V6 operator action to `create_epoch(E)`. Minimum and
maximum stake are contract-level values and are snapshotted automatically. Only owner/keeper can
create; keeper horizon is 26 hours and minimum notice is one hour. The owner controls fee and keeper,
ownership transfer is propose/accept, and owner/treasury can withdraw only accrued fees.

`resolve_epoch` and `activate_timeout_refund` are permissionless after immutable gates. A compromised
keeper therefore cannot select winners or block every other caller from settlement. The production
workflow must use a dedicated encrypted keeper, never the owner. Rotation away from the temporary
bootstrap wallet is complete and exact live/repository identity matches; successful activated
workflow runs prove the CI runtime signer/profile preflight. Manual run `32325583494` additionally
proved schema-v3 journal authorization, cross-run exact-hash recovery, and six exact VERIFIED
operations. Two finalized local keeper creates prove that the dedicated account can exercise the
intended limited `create_epoch` authority. These observations do not prove continuous uptime.

## Evidence and accounting review

The V7 policy retains the fixed five-venue, five-asset, 3-of-5 complete-basket median. Both objectives
use one vector. Temporary quorum failure cannot produce a guessed winner; the 24-hour timeout remains
the deterministic zero-fee escape path.

The fee remains a snapshotted percentage of losing stake, not principal from an unbacked winner.
Ties, unbacked winners, no losing side, undetermined settlement, and timeout return eligible
principal at zero fee. Only accrued fees are treasury-withdrawable. Effects-first pull claims avoid
an unbounded payout loop and duplicate economic claims.

The remaining value-delivery concern is asynchronous EOA child failure. Because a delayed child can
still finalize, automatically replaying a recorded claim is unsafe. The included monitor intentionally
does not submit or retry transactions; it only proves delivery or reports an ambiguous state. V7
has no upgrader or delivery-retry state, so this remains a protocol P1. The current 2 GEN across two
eligible unclaimed refunds remains participant liability. A fresh-deployment state machine and
idempotent escrow are specified in [`V8-PAYOUT-RECOVERY.md`](V8-PAYOUT-RECOVERY.md).

## Legacy V6 evidence and drain

V6 at `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` previously proved a funded four-position round:

- one shared four-venue resolution;
- SOL HIGH with an unbacked-winner refund;
- BNB LOW with an exact 0.198 GEN payout and 0.002 GEN fee;
- three finalized claim-parent/EOA-child pairs;
- expected loser rejection and zero remaining player liability.

Full hashes and atto balance deltas remain in
[`../deployments/studionet-v6.json`](../deployments/studionet-v6.json). This is regression evidence,
not V7 funded proof. V6 due epochs `1787155200` and `1787158800` were resolved on 2026-08-19 by
`0xae0ce453…e1480` and `0x09f01c2a…e735`. An earlier pre-resolution snapshot left epochs
`1787162400` and `1787166000` OPEN (RESOLVABLE and SCHEDULED); later permissionless drains resolved
them with `0x03f2ac80…0399` and `0x7e8030f0…27bb`. Supported public app and automation paths expose
no V6 creation or new-wager action, while read/resolve/timeout/claim recovery remains available. The
deployed V6 owner creation capability still exists and must remain unused until the legacy surface
is fully retired. A live zero-state audit found exactly five terminal resolved/determined epochs,
zero remaining player liability, and an empty drain plan; live V6 workflow `338089016` is therefore
`disabled_manually`, and main retains only `workflow_dispatch` for that legacy drain.

## Open findings and release gates

### P1 — GitHub schedule delivery remains below the nominal cadence

The dedicated encrypted keeper is installed, its on-chain role was finalized/read back, the GitHub
configuration matches, and default-branch signer/profile preflight passed. The first seven-attempt
live scheduled run is captured: run `32312864108`, job `96259232716`, failed lookup after 315 seconds
while both exact hashes later finalized and applied. The replacement Neon journal requires a fenced
global signer lease, durable PREPARE before broadcast, exact captured-hash binding, and full exact
receipt/execution plus matching post-state before VERIFIED. Raw transaction status is liveness only;
unknown or unverified operations block further writes, and artifacts/caches are not authority.
Migration 003 adds immutable numbered retry attempts after exact receipt-verified
`FINALIZED_FAILURE` and is applied as migration `14160d53-a2a3-43ab-a762-6bb7e54a95e8` at checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70`. Production read-back found
exact versions 1/2/3, zero operations at migration read-back, four attempt columns, the `QUARANTINED`
unresolved-index rule, and the parent-freeze trigger. The matching API now reports authenticated
schema version 3 health. Manual run `32325583494` then recovered the exact previously submitted hash
and left six operations VERIFIED, proving the action-bearing recovery gate. PR #11 restored the V7
schedule; V7 workflow `338089019` is active while V6 workflow `338089016` stays
`disabled_manually`. Scheduled run `32329108358` then passed both jobs, verified one exact resolve and
one exact create, and left eight operations VERIFIED with zero unresolved. Second scheduled run
`32332196428` repeated the exact action-bearing path with two more finalized, majority-agree,
post-state-verified attempt-1 operations and left 10/10 VERIFIED with zero unresolved. Across the
subsequent 24-hour window, every one of 25 delivered runs, 50 jobs, and 52 actions passed, and the
journal reached 62/62 VERIFIED with zero unresolved. However, GitHub emitted only 25 run records for
52 nominal slots and the longest gap was `01:39:05`. PR #15 reduces cadence pressure to one hourly
trigger, and durable `queue: max` prevents pending writer replacement; neither control guarantees
GitHub schedule delivery. The repository-native issue watchdog passed manual and automatic checks;
synthetic injection additionally proved issue open, recovery comment, and close delivery. Continue
measuring schedule delivery and prove no owner-capable key is available to automation. An independent
third-party pager for coverage, source quorum, finality, journal health, history integrity/quota
failures, and role drift remains an optional defense-in-depth enhancement.

### P1 — asynchronous child failure has no safe retry

Healthy parent/child delivery has been proven on both V6 and the funded V7 canary. Real-value use
would still need a protocol delivery guarantee or a recoverable transfer design for an ambiguous
failed/delayed child that cannot double-pay. The read-only monitor is correct but is detection, not
recovery.

### P1 — public cutover completed; rollback discipline remains

The last fully enumerated pre-journal READY Vercel deployment was
`dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`. Its metadata source anchor
is `e5627ebd270a7c6d5291151795b0af6442eba0a6` with `gitDirty=1`; the exact browser bundle/hash is
recorded above. The public alias targets V7, health/readiness/history-health returned `200`, V6
remained readable with zero known liability, and the previous V6 compatibility deployment remains a
rollback artifact. Continue browser/wallet soak and ensure rollback never reactivates V6 creation.
The proof view in [PR #6](https://github.com/Leokings/liquidity-arena/pull/6) is now merged and
deployed on the production alias. The historical READY artifact that executed the first restored
scheduled run `32329108358` was Vercel deployment `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ` at
[its immutable URL](https://liquidity-arena-dz2a8196a-leokings588-5902s-projects.vercel.app), GitHub
deployment `5994871034`, source `81850e3c814cd541d392fdeecf4dacca753d25e6`, with bundle
`/assets/market-BQWvq82y.js` (188376 bytes), SHA-256
`37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

The historical stream-hardened runtime is READY Vercel deployment
`dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
[its immutable URL](https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app), GitHub
deployment `5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI `32332498286`
passed jobs `96315684498` and `96315684590`. Bundle `/assets/market-DTvIR-Xr.js` is 191538 bytes,
SHA-256 `7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. It enables Vercel request
cancellation and one shared ref-counted EventSource per URL/tab; steady Studio calls are about
240/hour under the cap of four concurrent streams per IP. Browser tracing proved one HTTP-200 SSE request for
ROUND→4H, one per rapid reload across two reloads, LIVE/FRESH without STALE/errors, and an immediate
independent HTTP-200 five-asset stream. Health, readiness, history-health, and proof view returned
HTTP 200; readiness matched chain `0xf22f`, exact V7/keeper/coverage, and zero V6 liability.

The initial post-soak artifact was READY Vercel deployment `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
[its immutable URL](https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app), GitHub
deployment `6017361124`, source/merge `abef30d7268b34331528c470cc2a06eefe50ba33`. CI run
`32458652480` passed jobs `96700917346` and `96700917084`. Bundle `/assets/market-B8kYJwYW.js` is
191540 bytes with ETag `W/"aed8cd3722fd07b7762e4331cd94d235"` and SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public surfaces return HTTP
200 after repair. Active V7 player liability is 2 GEN across two eligible unclaimed refunds; this is
an outstanding participant obligation, intentionally not a readiness failure.

The previous runtime-changing production artifact and synthetic-watchdog evidence checkpoint was the
READY/PROMOTED Vercel deployment
`dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
[its immutable URL](https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app), GitHub
deployment `6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI run
`32461039766` passed jobs `96707863823` (393/393, build 477, audit 0) and `96707864002` (lint plus 37
direct tests). Bundle `/assets/market-BoHfo81C.js` is 193040 bytes, ETag
`"fa10949a324593024ea6c209eb3a0cc3"`, SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint no longer owns the public alias.

The previous core-claim production artifact is GitHub deployment `6022675081` and
READY/PROMOTED Vercel deployment `dpl_5FdBbP3e76rwgy1EzqyJYofG4Hxx` at
[its immutable URL](https://liquidity-arena-eujqytbxd-leokings588-5902s-projects.vercel.app). At that
verification checkpoint, [the public alias](https://liquidity-arena.vercel.app) also targeted it. It
is anchored to exact merged source `5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475`; alias and immutable
URL then served identical
`/assets/market-CfuCPKfs.js` bytes: 219197 bytes, ETag
`W/"830736d362d152a9ebb18e01b9b268a1"` for the gzip representation, SHA-256
`de89b5ae0947c35f384e5de0ff806b774947cf416f5e9dd9c0f7b51848232f87`. Production `/healthz`,
`/readyz`, and `/api/history-health` returned HTTP 200; readiness matched chain `0xf22f`, exact
V7/keeper identity, and the non-blocking 2 GEN participant liability. At that checkpoint, history
integrity reported 39 verified terminal/resolve operations, zero timeouts,
and zero missing or stale rows. The exact V7
HIGH claim deep link for
epoch `1787205600` showed the exact epoch, `RESOLVED · ON-CHAIN`, `VIEW POSITION / CLAIM`, and an
enabled `RECONNECT WALLET TO CLAIM HIGH POSITION` action with the Binance stream connected. No
error-level or HTTP 500 log appeared in the first ten minutes. This proves deployed route/reconnect
UI only: no live user-wallet signature, finalized claim transaction, or exact child delivery was
performed.
That PR #21 artifact predates merged PR #26's modal focus-containment fix. The last runtime-changing
checkpoint is successful GitHub deployment `6023788676` and READY production Vercel deployment
`dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr`, build `bld_6ru8isp7p`, at
`https://liquidity-arena-7bkvfta05-leokings588-5902s-projects.vercel.app`. At its verification
checkpoint, the public alias and immutable URL served identical exact-source
`881e74895a31cb3cf82c078f4252110306684f30` `/assets/market-Cbg1BCfB.js` bytes (225141 bytes), ETag
`"7e1bea4635aa5da15eae5805c486d4c1"`, SHA-256
`33a2cfa7b48970660b09bf8b3a455dd3740f09efe65f0e33b5a0707321f95bbf`. At that verification
checkpoint, health/readiness/history checks passed with exact V7/keeper/coverage/five feeds, non-blocking 2 GEN,
and an artifact/browser history snapshot of 39/39/0 with zero gaps. Later documentation validation
at `2026-08-21T15:16:17.648Z` observed HTTP 200 ready, journal 3, 40/40/0, and zero gaps. Immutable
HIGH and alias LOW epoch-`1787205600` routes passed correct
dialog/objective/reconnect focus, background inert/`aria-hidden`, 24 desktop/12 mobile wrap moves,
Escape fallback, exact opener restore, 412x915 no-overflow/visible-CTA layout, and zero site-origin
warning/error checks. The internal read-only Codex audit verdict was P0=0, P1=0, P2=0; no wallet action was submitted.
An evidence-publication successor may move the alias and differ in artifact bytes because the deployment
registries are serverless build inputs; it does not retroactively alter this immutable checkpoint. The
current registry edit leaves every field consumed by `history/deployment-manifest.mjs` unchanged.

### P2 — durable history outage recovery and broader proof coverage are pending

The Neon migration/schema read-back and repeated production syncs passed. Public history now
contains full V7 E20/E19 and V6 E19 determined snapshots with no duplicate overlapping V6 E19 row.
Selected proof backfill passed: V7 E19 contains nine finalized proofs, while its deployment proof and
epochless fee parent are stored separately. Access-control/outage recovery and proof coverage beyond
that selected set still require verification. Post-soak repair and the recorded post-merge integrity
snapshot are complete at 39 verified terminal/resolve operations with zero timeouts, missing, stale, or missing
snapshots. No
projection record may be described as an oracle.

### P2 — operational and external reviews remain

Live timeout evidence, provider data-use/legal review, independent security review, GitHub schedule-
delivery monitoring, and rollback rehearsal remain. An independent third-party pager is optional.
StudioNet's
observed sub-minute finality is not an SLA.

## Required final verification

Before submission, record fresh results for:

- full JavaScript tests, production build, dependency audit, GenVM lint, and direct tests;
- preservation of the exact deployed-source/config/schema and finalized keeper-rotation read-back;
- preservation/review of the funded V7 canary and claim-child evidence;
- V6 legacy liability/read/resolve/timeout/claim verification, public-write gating, and owner
  abstention monitoring, while preserving its zero-liability disabled-drain posture;
- continued scheduled journal/coverage/role/finality monitoring and GitHub delivery evidence; the
  repository-native alert path and Cloudflare keeper-dispatch/watchdog-skip paths are proven, with
  optional independent paging as defense in depth;
- a live StudioNet user-wallet signature, finalized claim transaction, and exact child-delivery proof;
- explicit acceptance or resolution of the V7 asynchronous child-recovery P1 before real-value use;
- Neon outage recovery and extended proof coverage against the migrated, repeatedly populated schema;
- public Vercel health, readiness, same-origin RPC, exchange stream, CSP, console, wallet, history,
  and rollback checks;
- an independent security report and closure of all critical/high findings.

No observation in this document is a finality promise. Transactions and value are trusted only after
`FINALIZED`, successful execution, exact post-state, and, when applicable, the exact finalized EOA
child.
