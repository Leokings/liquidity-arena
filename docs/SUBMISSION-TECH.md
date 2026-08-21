# Liquidity Arena V7 submission technical note

## Product

Liquidity Arena is a StudioNet test-token application for exact-hour crypto return battles across
BTC, ETH, BNB, SOL, and XRP. Each UTC hour produces one canonical result vector and two independent
pari-mutuel objectives: highest return (`HIGH`) and lowest return (`LOW`).

## Release target

| Component | V7 target |
| --- | --- |
| Intelligent contract | `contracts/LiquidityArenaV7.py` |
| Protocol / policy | `LIQUIDITY_ARENA_V7` / `CRYPTO_SPOT_1M_MEDIAN_V1` |
| StudioNet address | `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` |
| Deployment tx | `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` |
| Currency | Native faucet test GEN, 18 decimals |
| Fee | 2% of losing pool by default; 5% hard cap |
| Stake limits | 0.1–10 GEN per wallet/objective |
| Evidence | Binance, OKX, Bybit, Gate, KuCoin; at least 3 complete baskets |
| Operator | Limited epoch-creation keeper; permissionless resolve/timeout; V7 workflow `338089019` active at minute 27 with durable writer queue, V6 workflow `338089016` disabled |
| Keeper write authority | Active authoritative Neon journal: 64/64 operations VERIFIED, 0 unresolved after the 24-hour checkpoint and post-merge run |
| Public host | [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app), V7 source `a1c773a` active/READY with V6 legacy recovery |
| Operations health | Projection integrity 32/32 with zero gaps; GitHub-native synthetic issue delivery/recovery passes; independent pager optional |

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is retained for historical reads, eligible
resolves/timeouts, and claims. Its due epochs `1787155200` and `1787158800` were resolved on
2026-08-19 by `0xae0ce453…e1480` and `0x09f01c2a…e735`. A later permissionless drain
resolved epoch `1787162400` with `0x03f2ac80…0399`, and another resolved `1787166000` with
`0x7e8030f0…27bb`. Supported public app/automation paths expose no V6 creation or new wagers, but the
deployed owner creation capability remains and must not be used.
The final live audit found all five V6 epochs resolved/determined and player liability zero. Its
recurring drain is retired; live workflow `338089016` is `disabled_manually`. The release-candidate
YAML change is merged and main retains only `workflow_dispatch` for the V6 drain.

## User-visible timing

For exact hour `E`:

- buffer `[E-60m,E-40m)`;
- wagers `[E-40m,E-20m)`;
- scored battle `[E-20m,E)`;
- evidence publication through `E+120s`;
- permissionless resolution until `E+24h`;
- permissionless zero-fee timeout refund from `E+24h` if still open.

There are exactly 24 targets each UTC day. Contract time and already-created user-facing rounds
continue while an older transaction awaits finality, but a missing epoch cannot be created and all
keeper writes stop globally until every unresolved journal operation is recovered and verified or
safely classified.

## Settlement and payment

GenLayer validators independently obtain completed one-minute boundary candles. A venue qualifies
only with a valid five-asset vector. The contract uses the deterministic per-asset median from three
to five venues and commits a shared result for both objectives.

A backed winner receives principal plus its pro-rata share of losing stake after the snapshotted fee.
A tie, unbacked winner, no losing side, undetermined result, or timeout returns eligible principal
with zero fee. Participants pull claims directly from V7; no custodian or server pays them.

The UI and operator never unlock at `ACCEPTED`. They require the exact transaction to be `FINALIZED`,
successful authoritative execution, matching state, and, for native payments, the finalized EOA
transfer child. The claim-delivery monitor requires an explicit V6 or V7 deployment profile, is
read-only, and does not perform unsafe retries.

## Visualization

During battle, exchange streams provide a clearly labeled provisional liquid map. Territory area is
driven by return, direction by momentum, and turbulence by volatility/disagreement. After consensus,
the V7 `return_ppb` vector becomes the permanent ROUND result. Rolling 1H/4H/1D/1W views are
historical context and do not reset with the hourly wager round.

## Evidence completed

- V7 deployment finalized with `MAJORITY_AGREE` and successful execution;
- source SHA-256 recorded as
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- live contract configuration, role, catalog, fee, stake, and timing read-back;
- GenVM lint passed with a 29-method schema;
- V7 direct tests passed 22/22; combined V6/V7 direct tests passed 37/37 at deployment review;
- 25 epochs were seeded and verified: one canary plus a full 24-hour exact-epoch schedule, whose
  first/final creation hashes are `0x7b94b2d0…7726` and `0x443afcf7…7677f`;
- at least 36 epochs are now read back, including two local dedicated-keeper creates and nine
  workflow-created epochs beyond the 25 seeded epochs;
- V7 keeper safeguards and the dual-deployment registry are implemented; the last fully enumerated
  pre-journal READY production deployment
  `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` serves V7 while preserving V6 legacy recovery. Its immutable URL
  is `https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`; Vercel metadata
  anchors it to merged receipt-proof commit `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records
  `gitDirty=1`, while exact browser artifact `market-BHlwjm1W.js` has SHA-256
  `c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`;
- dedicated keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` was installed by owner transaction
  `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, which finalized with majority
  agreement and successful leader execution; exact config read-back and GitHub repository variable
  match, and the encrypted keeper secret names are present in environment `studionet-keeper`;
- local execution as the dedicated keeper created `1787256000` through finalized transaction
  `0xe10ce0bf…a9c4` and `1787259600` through finalized transaction `0x00398a3c…9058`; both exact
  post-states were verified OPEN, proving the limited role;
- scheduled V7 run `32298454771` passed reconciliation while its independent history job hit a
  superseded provider-quota failure; later run `32299468899` passed no-action signer/profile
  reconciliation in job `96218469576` and bounded history sync in job `96218806119`; later verified
  no-action run `32300282482` also passed reconcile job `96221017562` and history job `96221327115`;
- first seven-attempt action-bearing scheduled run `32312864108`, reconcile job `96259232716`, on
  head `958e51743a821606ca78881e6bcc8fb0a34a8e8f` exhausted receipt lookup for CREATE
  `0xe6af…3574` and RESOLVE `0x0850…c7e`; both exact writes later finalized and applied, proving
  receipt-index lag beyond 315 seconds rather than failed execution;
- authoritative-journal run `32325583494` on
  `f937b95a108dddd84e4fda3149452a2c22dd8f84` passed reconcile job `96296050506`: it recovered the
  previously bound `resolve_epoch(1787184000)` hash without resubmission, submitted five more exact
  writes, and finished with six VERIFIED operations (three resolves and three creates); history job
  `96297112208` also passed with two deployments, two epochs, and two snapshots synchronized;
- PR #11 restored the V7 minute-3/minute-13 schedule at main commit
  `81850e3c814cd541d392fdeecf4dacca753d25e6`; workflow `338089019` is active;
- restored scheduled run `32329108358` passed reconcile job `96306191739` and history job
  `96306791996`, verified RESOLVE `1787194800` and CREATE `1787288400`, and left Neon at eight
  operations, all VERIFIED, zero unresolved; live epoch count was 35, eight workflow-created;
- second scheduled run `32332196428` passed reconcile job `96314848434` and history job
  `96315355338`, verified exact RESOLVE `1787198400` transaction `0xebc44786…99dd` and CREATE
  `1787292000` transaction `0x3d4b235c…8a88`, and left Neon at 10/10 VERIFIED with zero unresolved;
  evidenced coverage was at least 36 epochs, nine workflow-created at that checkpoint;
- 24-hour checkpoint ending approximately `2026-08-21T06:50Z`: 25/25 delivered scheduled runs,
  50/50 jobs, and 52/52 VERIFIED actions (26 resolve, 26 create), with a 62/62 VERIFIED journal and
  zero unresolved. GitHub emitted only 25 records for 52 nominal slots and the longest gap was
  `01:39:05`; catch-up run `32439590155` safely verified four actions;
- PR #15 merge `abef30d7268b34331528c470cc2a06eefe50ba33` changed the cadence to minute 27, added shared
  durable `queue: max`, required three-epoch V7 projection, integrity health, active-player-liability
  diagnostics, and a GitHub-native issue watchdog; CI run `32458652480` passed jobs `96700917346`
  and `96700917084`;
- repair runs `32458718433`, `32459026957`, and `32459340292` synchronized seven epochs/snapshots
  and moved integrity from 31 terminal operations with three missing/one stale to 31/31 with no gaps;
- manual run `32459740369` VERIFIED RESOLVE `1787295600` and CREATE `1787389200`, left Neon at 64/64
  VERIFIED and zero unresolved, and produced history health 32/32 terminal/resolve with zero gaps;
- watchdog manual `32459656268` and automatic `32460047757` healthy-path runs passed; synthetic
  failure `32461072315` opened issue #17, while recovery `32461245006`/`96708451794` rechecked all
  surfaces, commented, and closed it. An independent third-party pager remains optional;
- historical first-restored-run artifact was READY Vercel deployment
  `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, GitHub deployment `5994871034`, source
  `81850e3c814cd541d392fdeecf4dacca753d25e6`, bundle `/assets/market-BQWvq82y.js` (188376 bytes),
  SHA-256 `37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`;
- historical stream-hardened runtime was READY Vercel deployment `dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj`,
  GitHub deployment `5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`; CI
  `32332498286` passed jobs `96315684498` and `96315684590`; bundle `/assets/market-DTvIR-Xr.js`
  is 191538 bytes, SHA-256 `7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`;
- shared ref-counted SSE plus Vercel request cancellation passed production browser stress: one
  HTTP-200 stream for ROUND→4H, one per rapid reload, LIVE/FRESH without STALE/errors, immediate
  independent HTTP-200 five-asset events, about 240 steady Studio calls/hour under the cap of four
  concurrent streams per IP;
- initial post-soak runtime was READY Vercel deployment `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6`, GitHub
  deployment `6017361124`, source `abef30d7268b34331528c470cc2a06eefe50ba33`; bundle
  `/assets/market-B8kYJwYW.js` is 191540 bytes with SHA-256
  `2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`;
- current synthetic-watchdog runtime is READY/PROMOTED Vercel deployment
  `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K`, GitHub deployment `6017754639`, source
  `a1c773ae36a882c043c6b167a1324d1d558ac60f`; main CI `32461039766` passed, and bundle
  `/assets/market-BoHfo81C.js` is 193040 bytes with SHA-256
  `82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`;
- historical scheduled V6 drain run `32297047031` completed successfully without creating any epoch;
  the later zero-liability audit retired recurring execution and live workflow `338089016` is now
  `disabled_manually`;
- V6 funded evidence remains recorded as regression proof, including exact payout, fee, refund,
  loser rejection, and parent/child delivery;
- the Neon production migration was applied with normalized marked-DDL SHA-256
  `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
  (raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`), followed by successful
  six-table/four-index read-back and an initial two-deployment/two-epoch/two-snapshot production
  sync from `2026-08-19T20:38:39.397Z`;
- separate keeper-journal migration 002 was prepared as
  `1e440327-2e66-403d-934d-c302790ac775` on temporary branch `br-sweet-frost-auakkl85`, applied
  identically to production branch `br-calm-fire-aup0rw0r`, and the temporary branch was deleted;
  final checksum `d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`
  read back with unchanged v1, four journal tables, the trigger, and zero operations at migration
  time; migration 003
  `keeper_transaction_journal_attempts` was then applied as
  `14160d53-a2a3-43ab-a762-6bb7e54a95e8` through deleted branch
  `br-polished-shape-aund54y0`, with checksum
  `9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70`; production read-back found
  exact versions 1/2/3, zero operations at migration time, four attempt columns, the `QUARANTINED` unresolved index,
  and the parent-freeze trigger;
- public history returns full resolved/determined V7 E20/E19 and V6 E19 snapshots; protected run
  `32309637237` accepted 11 selected proofs with zero rejections, and public V7 E19 exposes exactly
  nine finalized proofs (creation 1, wagers 4, resolution 1, credited claims 3). The finalized
  deployment proof and epochless fee parent are stored outside the epoch array; V7 E20 and V6 E19
  remain at zero because they were outside this selected proof set;
- four V7 canary wagers of 0.1 GEN each were finalized and post-state verified: account A HIGH BTC
  `0x58f69072…c4fa`, account A LOW XRP `0xa6284710…5831`, account B HIGH ETH `0xc0d5401c…2a19`, and
  account B LOW BNB `0x80c1d306…7e9c`;
- shared resolution `0xc2c86fdb…ab66` finalized from four venues: unbacked SOL HIGH refunded both
  0.1 GEN positions and backed BNB LOW paid 0.198 GEN after a 0.002 GEN fee;
- three claim parent/child pairs delivered exactly 0.398 GEN, the losing LOW XRP claim
  `0xb0d9889a…e688` failed without state change, and fee parent `0x3df8d942…bb01f` plus child
  `0x566082ce…470e` delivered 0.002 GEN to treasury;
- exact A/B/contract balances were 0.700/0.648/0.400 GEN before resolution,
  0.800/0.946/0.002 after claims, and 0.802/0.946/0 after fee withdrawal; liability and accrued fees
  ended at zero and the total 1.748 GEN was conserved.

See [`AUDIT.md`](AUDIT.md), [`STUDIONET-V7.md`](STUDIONET-V7.md), and
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).

The keeper journal gates writes with a fenced global signer lease. It requires durable PREPARE
before broadcast, immediate exact-hash binding, and recovery of every nonterminal operation before
planning. Raw transaction status is liveness only; full exact receipt identity, successful execution,
and matching post-state are required before VERIFIED. Unresolved evidence fails closed and blocks
later writes. Workflow artifacts and caches are never journal authority.

## Truthful current status

The V7 contract, dedicated keeper, workflow preflight, repeated state projection, and public V7
cutover are complete, but this remains a StudioNet test-token release rather than a real-value
production-safety claim:

- Vercel production targets V7 and retains readable, zero-known-liability V6 recovery;
- Neon migration, repeated finalized-epoch projection, and selected V7 proof backfill are complete;
  outage recovery and broader proof coverage remain;
- the authoritative journal API/schema-v3 health and six-operation action-bearing canary are proven;
  one previously submitted hash was recovered without resubmission. PR #11 restored the V7 schedule
  and workflow `338089019` is active, while V6 workflow `338089016` remains disabled. Restored
  scheduled runs `32329108358` and `32332196428` each passed with two VERIFIED operations and green
  history. The later 24-hour delivered-run audit, projection repair/integrity gate, and GitHub-native
  watchdog delivery/recovery are complete. GitHub schedule delivery (25/52 nominal records), live
  timeout evidence, and rollback rehearsal remain; independent third-party paging is optional;
- active V7 player liability is 2 GEN across two eligible unclaimed refunds; it is an outstanding
  participant obligation and intentionally does not fail service readiness;
- independent security and provider data-use/legal review remain.

Observed StudioNet finalization has commonly been under one minute, but this is not an SLA. Reviewers
must be told that StudioNet is temporary test infrastructure and faucet GEN has no promised value.

## Submission completion checklist

1. Extend transaction-proof coverage beyond the selected V7 evidence and rehearse database outage
   recovery.
2. Continue public browser/wallet soak and prove that V6 recovery stays accessible while the app
   routes no new V6 writes; monitor that the retained owner creation capability remains unused.
3. Monitor minute-27 GitHub delivery and preserve scheduled journal/coverage/finality/role checks
   while V6 remains disabled at zero liability; optionally add an independent third-party pager.
4. Record a 24-hour timeout proof or clearly retain it as a known demo limitation.
5. Complete independent security and provider/legal review, screenshots, demo video, repository
   cleanup, and rollback evidence.

Until those gates pass, the correct claim is “public V7 StudioNet test-token release with V6 recovery
compatibility,” not “fully production-ready wagering application.”

The last fully enumerated pre-journal production artifact was READY deployment
`dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`. CI run `32308815377`
passed both jobs for Vercel's source anchor `e5627ebd270a7c6d5291151795b0af6442eba0a6`; because deployment
metadata records `gitDirty=1`, the bundle hash above—not the commit alone—is the exact browser
artifact identity. Health, readiness, and history health returned `200` for that checkpoint. The
proof view from [PR #6](https://github.com/Leokings/liquidity-arena/pull/6) is now merged and deployed,
and the alias has since received the journal API, receipt-recovery fixes, and schedule restoration.
The historical artifact that executed first restored run `32329108358` was READY deployment
`dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ` at
`https://liquidity-arena-dz2a8196a-leokings588-5902s-projects.vercel.app`, with the source and bundle
identity recorded above. The historical stream-hardened runtime was
`dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
`https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app`; health, readiness,
history-health, and proof view returned HTTP 200, with readiness matching chain `0xf22f`, exact
V7/keeper/coverage, and zero V6 liability.

The initial post-soak runtime was `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
`https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017361124`, source `abef30d7268b34331528c470cc2a06eefe50ba33`. Public surfaces return HTTP
200 after repair; history integrity is 32/32 with zero gaps, and readiness reports the non-blocking
2 GEN outstanding active-player liability.

The current production runtime is `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
`https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI `32461039766`
passed; bundle `/assets/market-BoHfo81C.js` is 193040 bytes with SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
