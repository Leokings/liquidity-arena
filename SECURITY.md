# Security policy

## Status and scope

The active review target is `LIQUIDITY_ARENA_V7` at
`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` on GenLayer StudioNet. The immutable evidence policy is
`CRYPTO_SPOT_1M_MEDIAN_V1`. Contract lint and direct tests have passed, and the complete V7 canary
proved finalized resolution, refund/payout delivery, loser rejection, liability conservation, and
fee withdrawal. Dedicated keeper rotation, default-branch scheduler preflight, and initial durable
history ingestion, repeated projection, selected V7 proof backfill, proof-view deployment, and public
browser cutover are complete. The earlier action-bearing seven-attempt run remains recorded as a
failed receipt-index lookup whose two exact writes later finalized and applied. Migration 003 and
the matching journal API are now active, with authenticated `ready=true`, `schemaVersion=3` health.
Manual authoritative-journal run `32325583494` on
`f937b95a108dddd84e4fda3149452a2c22dd8f84` succeeded: reconcile job `96296050506` verified three
resolves and three creates, including one operation recovered across runs and five newly submitted
operations; history job `96297112208` also succeeded. At that manual-run checkpoint, evidenced
coverage was at least 34 epochs, including seven workflow-created epochs. V6 workflow `338089016` remains
`disabled_manually` with `workflow_dispatch`-only `main` source. PR #11 merged as `81850e3` and
restored the V7 cron source. Scheduled run `32329108358` passed reconcile/history, verified one
resolve and one create, and left Neon at eight operations, all VERIFIED, zero unresolved. Live epoch
count became 35, including eight workflow-created epochs. Second scheduled run `32332196428` passed
reconcile job `96314848434` and history job `96315355338`, finalized another exact resolve/create
pair, and left Neon at 10/10 VERIFIED operations with zero unresolved. Evidenced coverage was then at
least 36 epochs, nine workflow-created. The 24-hour checkpoint ending approximately
`2026-08-21T06:50Z` subsequently passed all 25 delivered scheduled runs, 50/50 jobs, and 52/52
VERIFIED actions (26 resolves and 26 creates), leaving the pre-maintenance journal at 62/62 VERIFIED
and zero unresolved. The former two-trigger cron nevertheless produced only 25 records for 52
nominal slots, with a longest gap of `01:39:05`; delivered execution integrity passed, while schedule
delivery reliability did not meet the declared cadence.

PR #15 merged as `abef30d7268b34331528c470cc2a06eefe50ba33` and hardens that boundary with one minute-27
trigger, durable `queue: max` serialization across every writer, required history configuration,
V7-only three-epoch projection, projection-integrity health, an active-player-liability diagnostic,
and a GitHub-native issue watchdog. Three repair runs (`32458718433`, `32459026957`, and
`32459340292`) passed and closed three missing plus one stale durable epoch. Post-merge keeper run
`32459740369` passed both jobs and added one exact VERIFIED resolve/create pair; Neon now reads 64/64
VERIFIED with zero unresolved. History health is `200` with 32/32 verified terminal/resolve
operations and zero timeout, missing, stale, or missing-snapshot rows. Manual watchdog run
`32459656268` and automatic `workflow_run` `32460047757` both passed. Synthetic run `32461072315`
then opened issue #17 after all real production checks passed and an injected failure fired. Recovery
run `32461245006`/job `96708451794` rechecked every surface, closed the issue at
`2026-08-21T08:01:35Z`, and posted the automated recovery comment. GitHub-native detection and
delivery/recovery are proven; an independent third-party pager remains an optional, unconfigured
enhancement. Database-outage recovery, broader proof
coverage, and an independent security review remain release gates. The payment path must not be
described as production-ready.

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is a legacy liability surface only. It remains readable
and claimable for existing positions; supported public app and automation paths must not use it for
new epochs or wagers. Its deployed owner-only creation capability remains, so owner abstention and
monitoring are part of the retirement control.

StudioNet is temporary, hosted, rate-limited development infrastructure. Faucet GEN has no promised
monetary value, and observed finality or transfer behavior is not a live-network guarantee or SLA.

## Critical invariants

V7 must preserve all of the following:

- one exact-hour epoch contains both HIGH and LOW pools;
- one immutable five-asset vector resolves both objectives;
- wagering closes before the battle baseline is measured;
- no result or payment is final at `ACCEPTED`;
- the normal fee applies only to the losing pool, defaults to 2%, and cannot be configured above 5%;
- every exceptional refund charges zero fee;
- only explicitly accrued fees are withdrawable;
- player liability plus accrued fees never exceeds contract balance;
- claim and refund effects are recorded before value transfer;
- the same epoch, position, resolution, timeout, claim, or transaction proof cannot be replayed;
- a missing or unreadable legacy liability must never be interpreted as zero.

## Authorization and key separation

V7 separates roles:

- owner: keeper rotation, future fee setting, and two-step ownership administration;
- keeper: future `create_epoch(E)` only as a privileged operation, with a 26-hour horizon;
- treasury/owner: withdrawal of already accrued fees only;
- any account: resolution and timeout after immutable gates;
- participant: its own wager and claim.

The owner key must never be installed in GitHub Actions or Vercel. The workflow uses a dedicated,
encrypted keeper keystore whose on-chain privilege cannot change fees, treasury, ownership, stake
limits, results, balances, or claims. The dedicated keeper
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` replaced the bootstrap wallet through finalized
transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`;
`get_config` and repository variable `V7_KEEPER_ADDRESS` match that address. The environment stores
the encrypted keeper material under the dedicated keeper secret names. Reconcile job `96218469576`
in successful workflow run `32299468899` imported the exact dedicated signer, passed the complete
profile/signer preflight, and correctly submitted no actions because coverage was complete. Local use
of the same signer created only fixed-term epochs `1787256000` and `1787259600`; both transactions
finalized and both post-states were verified OPEN.

Secrets must not appear in source, browser bundles, workflow artifacts, or logs. GenLayer CLI 0.39.2
offers only `--password`/`--source-password` for the noninteractive create, export, import, and unlock
operations used here, so the keeper password necessarily appears briefly in the local process
argument list. Run bootstrap on a trusted single-user machine and CI only on an isolated ephemeral
GitHub-hosted runner; disable shell tracing/debug logging, never echo the command, minimize the
process lifetime, decode the encrypted keystore only into a randomly named temporary file, and
remove it on every exit path. Treat host/process-list access during that interval as credential
access. Migrate to a non-argv CLI input mechanism if a future supported release provides one.

## Market-data threats

Settlement allowlists Binance, OKX, Bybit, Gate, and KuCoin and fixed USDT spot symbols for BTC, ETH,
BNB, SOL, and XRP. A venue qualifies only with a complete five-asset basket. The adapter must enforce
completed one-minute boundaries, timestamp alignment, bounded responses, strict schemas, positive
prices, fixed-point arithmetic, deterministic ordering, and at least three complete venues.

Tests and monitoring must cover stale/revised candles, clock skew, missing or duplicated assets,
malformed JSON, HTTP failure, wrong quote markets, extreme values, endpoint redirection, partial
venue outage, and disagreement between validators. Live visualization ticks are never settlement
evidence. A quorum failure must not guess a winner; the immutable 24-hour timeout is the deterministic
zero-fee fallback for an epoch that remains open.

Public endpoints do not imply production redistribution or settlement rights. Provider terms,
availability, jurisdiction, and commercial licensing require separate review.

## Accounting and value delivery

Review focus includes integer rounding, last-winning-claimant remainder, fee isolation, duplicate
claims, solvency, maximum stake arithmetic, and asynchronous native value delivery. The browser and
operator must verify the exact transaction recipient, method, arguments, value, final status,
authoritative execution, post-state, and emitted EOA child.

The claim-delivery monitor is deliberately read-only. It may alert and preserve evidence, but it
must never automatically resubmit `claim` or re-emit value. Once V7 has effects-first marked a claim
paid, an automatic retry without proof of child failure could double-pay if the original child later
finalizes. A protocol-backed recoverable-transfer design or documented delivery guarantee is still
required before real value.

## Keeper and availability threats

Every keeper invocation must fail closed unless chain, protocol, policy, source catalogs, timing,
fee, stake limits, owner, keeper, treasury, and signer all match. The signer is rechecked immediately
before each submission. Writes are serialized and bounded, hashes captured immediately, and success
requires exact receipt identity, `FINALIZED`, successful execution, and matching post-state.
StudioNet receipt indexing may lag broadcast. Main commit
`958e51743a821606ca78881e6bcc8fb0a34a8e8f` therefore retries finality lookup seven times against the
same recorded hash with 5/10/20/40/80/160-second outer delays (315 seconds total); it never
resubmits a write. Scheduled run `32312864108`, job `96259232716`, exercised that exact policy and
failed both receipt lookups after seven attempts. CREATE `0xe6af…3574` and RESOLVE `0x0850…c7e`
were later independently observed `FINALIZED` with their intended post-states applied. The incident
proves the lookup can remain invisible beyond the grace window and that a process exit cannot be the
authority for whether an exact hash may be resubmitted.

The replacement authority is the Neon keeper journal. A fenced global signer lease prevents V7 and
manual V6 recovery writers from racing. `PREPARED` must be durable before broadcast, and the exact
captured transaction hash must be bound to that operation immediately after submission. The raw
`gen_getTransactionStatus` lifecycle is a liveness lane only; even `FINALIZED` does not prove receipt
identity or execution. Verification requires the full exact receipt, successful execution, and
matching post-state. Unknown, pending, ambiguous, quarantined, or otherwise unverified operations
block later writes. Only an exact receipt-verified `FINALIZED_FAILURE` may create a new numbered
attempt, and migration 003 preserves the prior attempt and hash immutably. Workflow artifacts and
caches have no journal authority. Manual run `32325583494` proved this recovery boundary with six
VERIFIED operations: one exact cross-run recovery and five newly submitted operations, split across
three resolves and three creates. Live V6 workflow `338089016` remains `disabled_manually`, and its
merged `main` source is `workflow_dispatch`-only. PR #11 merge `81850e3` restored the V7 cron source;
run `32329108358` then passed with two exact VERIFIED operations and green history synchronization.
Second action-bearing scheduled run `32332196428` repeated that result with two more exact VERIFIED
operations and a green history job. The later 24-hour checkpoint proved all 25 delivered runs and
52 actions, while also exposing that GitHub emitted only 25 of 52 nominal schedule records. Catch-up
run `32439590155` safely verified four actions. PR #15 therefore moved the cadence to one minute-27
trigger and placed all keeper, projection-repair, and proof-backfill writers in the same durable
`queue: max` group; the Neon fenced lease remains the actual distributed write authority.

GitHub cron is best-effort. Cron does not define epoch time and is not an availability guarantee.
Permissionless resolution and timeout reduce operator lock-in, but monitoring must still alert on
missing coverage, source quorum loss, finality lag, scheduler failure, and unexpected role/config
changes. The GitHub-native watchdog checks readiness, durable-history integrity, authenticated
journal health, keeper recency/conclusion, and opens a repository issue on failure. Its manual and
automatic healthy-path runs pass, and synthetic failure/recovery runs prove repository issue
open/comment/close delivery. An optional independent third-party delivery path remains absent.

## Web, history, and migration threats

The browser must never receive exchange credentials, database credentials, or keeper material.
Server routes require allowlisted hosts, bounded input and output, timeouts, caching, rate limits,
restrictive CORS, CSP, and log redaction. Wallet confirmation must show StudioNet, exact contract,
epoch, objective, asset, value, and fee behavior before signing.

The deployment registry must allowlist only the recorded V7 and V6 addresses. V7 becomes the sole new
wager target after cutover; V6 remains limited to legacy reads, claims, and eligible permissionless
resolve/timeouts, with no epoch creation or new wagers. URL parameters cannot introduce an arbitrary
contract. A rollback may restore an earlier browser artifact, but it must not re-enable a public V6
creation or wager path.

Neon durable settled-epoch history is an off-chain projection. Its production migration was applied
with normalized marked-DDL SHA-256 `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
(raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`), and the expected six
tables/four indexes were read back without exposing connection or ingestion secrets. Database rows
must retain chain, contract, epoch, and finalized transaction identity, be idempotently ingested, and
remain replaceable from authoritative chain reads. Initial production sync/read-back populated full
resolved, determined V7 and V6 snapshots for epoch `1787166000`; a later sync added V7 E20 and
re-synced V6 E19 without duplication. Merged fail-closed receipt fix
`e5627ebd270a7c6d5291151795b0af6442eba0a6` and protected workflow `32309637237` then verified 11
selected records with zero rejections. Public V7 E19 exposes nine finalized proofs—one creation,
four wagers, one resolution, and three credited claims—while the deployment proof and epochless fee
parent are stored outside that epoch array. V7 E20 and V6 E19 remain at zero because they were not
part of the selected backfill. Database outage recovery and broader proof coverage remain pending.
Database availability can affect discovery, never settlement or claim eligibility.

Post-soak integrity health cross-checks VERIFIED V7 terminal journal operations against durable
epochs and required determined snapshots. Before repair it reported 31 terminal operations, three
missing epochs, one stale epoch, and zero missing snapshots. Serialized V7-only runs `32458718433`,
`32459026957`, and `32459340292` synchronized seven epochs and seven snapshots with no proof
failures/rejections and reduced every gap count to zero. Post-merge run `32459740369` then produced
the current 32/32 terminal/resolve, zero-timeout, zero-gap result. This integrity gate protects
discoverability; it does not make Neon a settlement authority.

The separate Neon keeper-journal migration 002 was prepared as migration
`1e440327-2e66-403d-934d-c302790ac775` on temporary branch `br-sweet-frost-auakkl85`, applied
identically to production branch `br-calm-fire-aup0rw0r`, and the temporary branch was deleted. Its
final checksum is `d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`.
Production read-back preserved the v1 checksum, found four journal tables plus the trigger, and
reported `operation_count=0` at that migration-time read-back. Migration 003
`keeper_transaction_journal_attempts` was subsequently
applied to project `steep-hat-04600004`, parent branch `br-calm-fire-aup0rw0r`, as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through temporary branch
`br-polished-shape-aund54y0`, which was deleted. Final checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70` read back with exact schema
versions 1/2/3, zero operations at that migration-time read-back, all four attempt columns, the
unresolved unique index including `QUARANTINED`, and the parent-freeze trigger installed. The matching
API now reports authenticated `ready=true`, `schemaVersion=3`, and manual run `32325583494` proved
the live journal path with six VERIFIED operations. Proof-view PR #6 is merged and deployed;
scheduled run `32329108358` subsequently proved the restored cron path, and `32332196428` proved a
second action-bearing scheduled cycle. The current journal state after the 24-hour checkpoint and
post-merge manual run is 64/64 VERIFIED with zero unresolved. The current hardened production
runtime is recorded below.

## Remaining security gates

After the V7 public cutover:

1. rerun GenVM lint, V7 direct tests, full JavaScript tests, build, and dependency audit;
2. complete an independent focused review of contract, evidence adapters, keeper, deployment
   registry, server boundary, and database ingestion;
3. monitor the 25/52 nominal GitHub schedule-delivery finding and preserve the proven GitHub-native
   watchdog; an independent third-party pager is an optional open enhancement. Keep live V6 workflow `338089016`
   disabled at zero player liability and prove no owner material exists in automation;
4. independently review the recorded funded V7 canary, including its shared resolution, fee/refund
   math, loser rejection, conserved balances, and finalized parent/child deliveries;
5. verify V6 legacy reads, resolve/timeout, and claims while proving public app/automation V6 writes
   remain disabled and the retained owner creation capability is monitored and unused;
6. extend transaction-proof coverage beyond the selected V7 evidence and complete a rollback/outage
   rehearsal;
7. test outage, delayed finality, restart, rate limit, and the independent 24-hour timeout path;
8. finish provider data-use and applicable legal review.

The earlier V6 funded round is valuable regression evidence, not a substitute for the V7 canary.
Historical verified V7 production deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` was READY at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`; its public
`/readyz` returned `200` with the exact V7 roles/policy, future coverage, five feeds, and readable
zero-liability V6 recovery. Vercel metadata anchors it to merged receipt-proof commit
`e5627ebd270a7c6d5291151795b0af6442eba0a6` and records `gitDirty=1`; bundle
`market-BHlwjm1W.js` with SHA-256
`c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e` is the exact browser artifact
identity. Proof-view PR #6 has since merged and is deployed. The historical schedule-restoration
artifact that executed first restored run `32329108358` was READY Vercel deployment
`dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, GitHub
deployment `5994871034`, source
`81850e3c814cd541d392fdeecf4dacca753d25e6`. Its bundle `/assets/market-BQWvq82y.js` is 188376 bytes
with SHA-256 `37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

The historical stream-hardened runtime is READY Vercel deployment
`dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
`https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app`, GitHub deployment
`5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI run `32332498286` passed jobs
`96315684498` and `96315684590`; bundle `/assets/market-DTvIR-Xr.js` is 191538 bytes with SHA-256
`7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. It uses one shared
ref-counted EventSource per URL/tab, Vercel request cancellation, idempotent disconnect cleanup,
about 240 steady Studio calls/hour, and a cap of four concurrent streams per IP. Adversarial production browser
verification found one HTTP-200 SSE request for ROUND→4H, one per rapid reload across two reloads,
LIVE/FRESH without STALE/errors, and an immediate independent HTTP-200 curl with five-asset events.
Health, readiness, history-health, and proof view returned HTTP 200; readiness matched chain
`0xf22f`, exact V7/keeper/coverage, and zero V6 liability. The earlier V6 compatibility deployment
remains a rollback artifact, but rollback must never re-enable V6 writes.

The initial post-soak artifact was READY Vercel deployment `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
`https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017361124`, source `abef30d7268b34331528c470cc2a06eefe50ba33`. CI run `32458652480` passed
browser/operator job `96700917346` and intelligent-contracts job `96700917084`. Bundle
`/assets/market-B8kYJwYW.js` is 191540 bytes with ETag
`W/"aed8cd3722fd07b7762e4331cd94d235"` and SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public health, readiness,
history-health, and proof surfaces return HTTP 200. Readiness reports active V7 player liability of
2 GEN, corresponding to two eligible unclaimed refunds; it is an outstanding participant obligation
and intentionally non-blocking, never an inferred zero or a readiness success condition.

The last runtime-changing production artifact and synthetic-watchdog evidence checkpoint was the
READY/PROMOTED Vercel deployment
`dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
`https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI `32461039766`
passed jobs `96707863823` (393/393, build 477, audit 0) and `96707864002` (lint plus 37 direct
tests). Bundle `/assets/market-BoHfo81C.js` is 193040 bytes with ETag
`"fa10949a324593024ea6c209eb3a0cc3"` and SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint does not assert that the public alias still targets it; later documentation-only
publication deployments may supersede the alias without changing the recorded runtime guarantees.

## Reporting

Never publish private keys, seed phrases, encrypted keystores, passwords, provider credentials,
database connection strings, or complete secrets. A report should identify the affected commit and
contract, minimal reproduction conditions, impact, and safe evidence. Security reports must clearly
separate locally tested behavior, observed StudioNet behavior, and assumptions that remain unproven.
