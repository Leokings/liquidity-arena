# Liquidity Arena V7 product and protocol specification

## 1. Scope

Liquidity Arena is a StudioNet test-token market game. Once per exact UTC hour, users predict which
of BTC, ETH, BNB, SOL, and XRP will have the highest or lowest percentage return during a fixed
20-minute battle. GenLayer validators derive one shared market vector from five public spot venues;
the StudioNet contract escrows native faucet GEN and settles both objectives.

The release protocol is `LIQUIDITY_ARENA_V7` and the settlement policy is
`CRYPTO_SPOT_1M_MEDIAN_V1`. The system is single-chain StudioNet.

## 2. Fixed release decisions

| Decision | V7 value |
| --- | --- |
| Network | GenLayer StudioNet, chain `61999` |
| Currency | Native faucet test GEN |
| Contract | `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` |
| Epoch cadence | 24 exact UTC hour targets per day |
| Epoch phases | 20m buffer, 20m wagering, 20m battle |
| Assets | BTC, ETH, BNB, SOL, XRP |
| Venues | Binance, OKX, Bybit, Gate, KuCoin |
| Evidence quorum | At least 3 complete five-asset venue baskets |
| Aggregation | Per-asset median; four venues use floor average of middle two |
| Objectives | HIGH and LOW pools in one epoch |
| Normal fee | 2% of losing pool |
| Fee hard cap | 5% |
| Stake range | 0.1–10 GEN per wallet/objective |
| Exceptional modes | Zero-fee eligible-principal refunds |
| Resolution gate | `E+120s` |
| Timeout gate | `E+24h` |
| Keeper privilege | Create fixed-terms epochs only |
| Resolution/timeout | Permissionless |
| Public hosting | Vercel browser and bounded API |
| Durable history | Neon repeated projection, selected proof backfill, post-soak repair, and journal-to-projection integrity health live; outage recovery and broader proof coverage pending |

## 3. Canonical hourly model

The epoch ID is the integer UTC end timestamp `E`, and `E % 3600 == 0`.

| Time | Phase | Required behavior |
| --- | --- | --- |
| `E-60m` | Buffer begins | Epoch exists and is visible; entry remains closed. |
| `E-40m` | Wagering begins | `enter` accepts valid HIGH/LOW positions. |
| `E-20m` | Wagering closes | Positions lock and battle baseline begins. |
| `E` | Battle ends | Live ROUND projection freezes as provisional. |
| `E+120s` | Resolution available | Any account may submit the shared resolver. |
| `E+24h` | Timeout available | Any account may activate zero-fee refunds if still open. |

An already-created next epoch continues on its contract schedule regardless of the prior
transaction's finality. A missing epoch cannot be created while an earlier journal operation blocks
keeper writes. There is no sliding “one hour after creation” round. Contract timestamps, not
scheduler timing or browser clocks, define every gate.

## 4. Market evidence

For each approved venue and asset, the V7 resolver requests completed one-minute spot candles at the
two fixed boundaries. It validates:

- exact allowlisted venue and market symbol;
- response size and expected JSON schema;
- one-minute interval and immutable boundary timestamps;
- positive prices and consistent quote asset;
- complete five-asset basket in canonical order.

A venue is all-or-nothing. With three to five qualified venues, calculate each venue's signed return
using fixed-point integers, then take the deterministic median for each asset. The resulting vector
contains exactly five `return_ppb` values in BTC/ETH/BNB/SOL/XRP order. HIGH chooses the maximum and
LOW the minimum; equal extrema are ties.

GenLayer validators independently execute the policy and compare results within the fixed return
tolerance. A temporary venue-quorum failure must not guess a winner. It leaves the epoch available
for retry; the 24-hour timeout supplies the deterministic zero-fee escape path.

Public/no-key endpoints are a demo dependency, not proof of uptime, data redistribution, or
settlement licensing. Production-value use requires provider and legal review.

## 5. Wager rules

- A participant can enter HIGH, LOW, or both during `[E-40m,E-20m)`.
- Each wallet selects only one asset per objective in an epoch.
- A wallet may top up the same selected asset before close.
- Every entry is positive native GEN and at least the snapshotted 0.1 GEN minimum.
- Total stake per wallet/objective may not exceed the snapshotted 10 GEN cap.
- An epoch contains both objectives and resolves them from one vector.
- The server never holds participant funds and cannot place or redirect a claim.

## 6. Settlement and fees

For a backed unique winner with at least one losing stake:

```text
losing_pool = total_pool - winning_stake
fee = floor(losing_pool * epoch_fee_bps / 10_000)
payout_pool = total_pool - fee
payout_i = floor(stake_i * payout_pool / winning_stake)
```

The final eligible winning claimant receives the remaining integer dust. The default fee is 200 bps
and is snapshotted at epoch creation. The owner may set only a future fee between 0 and 500 bps.

The following modes return eligible principal and charge no fee:

- tied objective;
- winner has no backing;
- winner is the only backed side, so no losing pool exists;
- a consensus-recorded undetermined result;
- 24-hour timeout.

Unbacked winning assets do not transfer participants' principal to the platform. Only the explicit
normal losing-pool fee becomes accrued platform fees.

## 7. Claims and delivery

Claims are participant-initiated, objective-specific, and pull-based. V7 records claim state,
objective paid amount, winning stake remainder, and player liability before emitting a finalized EOA
value transfer. The system verifies:

1. exact claim parent identity and arguments;
2. `FINALIZED` successful parent execution;
3. matching contract state and claim amount;
4. exactly one expected EOA transfer child;
5. `FINALIZED` successful child and exact recipient/value.

The monitoring process is read-only. It cannot safely replay a claim whose child is ambiguous,
because a delayed first child could later pay and turn a retry into a double payment. A protocol-safe
recovery design remains required before real value.

## 8. Roles

### Owner

- changes the keeper;
- proposes/cancels two-step ownership transfer;
- changes the fee for future epochs within the hard cap;
- may recover epoch creation within the 31-day owner horizon;
- may withdraw accrued fees, subject to solvency.

### Keeper

- creates fixed-terms epochs at least one hour before `E`;
- cannot create more than 26 hours ahead;
- cannot choose fee or stake terms;
- cannot change roles, withdraw, claim for users, or determine results.

### Treasury

- may withdraw only accrued fees;
- has no scheduling, resolution, or participant-claim authority.

### Public callers

- may resolve after `E+120s` and before timeout;
- may activate timeout after `E+24h` if still open.

The owner key is never an automation credential. Dedicated encrypted keeper
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` is installed on-chain and configured for the keeper
workflow. Default-branch runtime-signer/profile preflight passed; schedule-delivery and independent
alert monitoring remain mandatory. Seven-attempt/315-second receipt propagation grace is merged on main
`958e51743a821606ca78881e6bcc8fb0a34a8e8f`. Its first live action-bearing scheduled use, run
`32312864108` / job `96259232716`, exhausted receipt lookups for CREATE `0xe6af…3574` and RESOLVE
`0x0850…c7e`; both exact writes nevertheless later finalized and applied. Manual
authoritative-journal run `32325583494` on commit
`f937b95a108dddd84e4fda3149452a2c22dd8f84` then succeeded. Reconcile job `96296050506` verified
six operations (three resolves and three creates), including one recovered across runs and five newly
submitted; history job `96297112208` also succeeded. V6 workflow `338089016` remains
`disabled_manually` and its merged `main` YAML is `workflow_dispatch`-only. PR #11 merged as
`81850e3`, restoring the V7 cron source. Scheduled run `32329108358` passed reconcile job
`96306191739` and history job `96306791996`, verifying one resolve and one create. Second
action-bearing scheduled run `32332196428` passed jobs `96314848434` and `96315355338`, verifying
RESOLVE `1787198400` and CREATE `1787292000`. Neon read back 10/10 VERIFIED operations with zero
unresolved. A later 24-hour audit passed every delivered unit—25/25 scheduled records, 50/50 jobs,
and 52/52 VERIFIED actions (26 resolve, 26 create)—and reached 62/62 VERIFIED operations with zero
unresolved. Only 25 of 52 nominal cron slots emitted records and the longest gap was `01:39:05`.
PR #15 merge `abef30d7268b34331528c470cc2a06eefe50ba33` therefore moved to one minute-27 trigger,
durable `queue: max` writer serialization, required V7-only three-epoch projection, integrity health,
active-player-liability reporting, and a GitHub-native issue watchdog. Synthetic failure/recovery
later proved issue delivery end to end; independent third-party alert delivery remains optional.

## 9. Visualization

The current ROUND visualization and the settlement winner must converge:

- battle territory size is a monotonic function of percentage return;
- highest territory/rank represents the greatest return and lowest represents the least;
- momentum controls direction, not rank;
- volatility and cross-source disagreement control turbulence, not payout;
- the live stream is labeled provisional;
- finalized on-chain `return_ppb` replaces the provisional ROUND vector atomically.

Only ROUND resets at `E-20m`. The 1H, 4H, 1D, and 1W tabs are rolling historical market context and
never reset with an epoch.

## 10. Browser and deployment compatibility

The browser uses an allowlisted deployment registry:

- V7 is the only new epoch/wager target after cutover;
- V6 remains accessible for historical epoch reads, wallet positions, claims, and eligible timeouts;
- a query may select only a known `v7` or `v6` alias, never inject a raw contract;
- pending transaction records retain deployment identity across refresh;
- finalized V7 and V6 histories are labeled by protocol/address.

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is operationally drained: due epochs `1787155200`,
`1787158800`, `1787162400`, and `1787166000` were resolved on 2026-08-19. Supported public app and
automation paths expose no new V6 writes. The deployed owner-only creation capability remains and
must not be used; legacy resolve/timeout/claim discoverability remains until liabilities are closed.

The public Vercel site targets V7 and retains V6 legacy recovery. The dedicated keeper rotation,
funded canary, exact public readiness, and proof view from merged PR #6 are deployed. Browser/wallet
soak and rollback discipline remain ongoing obligations. Historical READY schedule-restoration
artifact `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ` executed first restored run `32329108358`; historical
stream-hardened runtime `dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` is retained as a dated checkpoint. The
initial post-soak runtime is `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` from source `abef30d`. The current
synthetic-watchdog runtime is `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` from source `a1c773a`. Exact
identities are recorded below.

## 11. Keeper and readiness

The reconciler:

- validates StudioNet and the complete live V7 profile;
- derives 24 future exact-hour targets;
- scans the bounded open-epoch index;
- plans missing creates and due permissionless resolve/timeout writes;
- rechecks the active signer before every submission;
- serializes and caps writes;
- captures hashes immediately;
- requires exact receipt identity, `FINALIZED`, successful execution, and post-state.

V6 workflow `338089016` remains `disabled_manually` with `workflow_dispatch`-only source on `main`.
PR #11 merge `81850e3` restored the V7 cron source, and action-bearing scheduled runs `32329108358`
and `32332196428` passed. PR #15 merge `abef30d` now runs once per hour at minute 27 and uses one
durable `queue: max` concurrency group across every chain/history writer.
Contract time remains authoritative. The Neon journal uses one fenced global signer
lease across V7 and manual V6 recovery, requires durable PREPARE before broadcast and exact captured
hash binding, and blocks every later write while an operation is unknown or unverified. Raw
`gen_getTransactionStatus` is only liveness; VERIFIED still requires the full exact receipt,
successful execution, and matching post-state. Workflow artifacts and caches are never authority.
Readiness checks exact chain/contract/roles/policy/stakes/fee/schedule and all five feeds. V6 legacy
and active V7 player liabilities are separately reported; an unreadable value is not zero. The
current V7 value is 2 GEN across two eligible unclaimed refunds and is deliberately diagnostic, not
a service-readiness failure.

## 12. History and observability

Contract pages are authoritative for epochs, open work, wallet positions, claims, fees, and
liability. The Neon production schema migration has been applied for a durable settled-epoch
projection; initial production ingestion now contains V7 and V6 E19. The projection must be:

- populated only from allowlisted deployments and finalized authoritative reads;
- idempotent across repeated ingestion;
- keyed by chain, contract/protocol, and epoch;
- traceable to resolution/timeout transaction identity where available;
- replaceable from on-chain truth;
- non-blocking for settlement and claims.

The applied migration has normalized marked-DDL SHA-256
`dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2` and raw migration-file SHA-256
`8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`; six tables and four indexes
were read back. Repeated production projection is live: public history contains V7 E20/E19 and V6
E19 without duplicating overlapping V6 E19. Protected run `32309637237` verified 11 selected records
with zero rejections; public V7 E19 contains exactly nine finalized proofs (one creation, four
wagers, one resolution, three credited claims), with the deployment proof and epochless fee parent
stored outside the epoch array. Outage recovery and broader proof coverage remain pending.

Separate keeper-journal migration 002 is applied to Neon production branch
`br-calm-fire-aup0rw0r` with checksum
`d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`. It was prepared as
`1e440327-2e66-403d-934d-c302790ac775` on temporary branch `br-sweet-frost-auakkl85`, applied
identically to production, and the temporary branch was deleted. Production read-back preserved v1,
found four journal tables plus the trigger, and contained zero operations at that migration-time
read-back. Migration 003
`keeper_transaction_journal_attempts` was then applied to production as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through deleted temporary branch
`br-polished-shape-aund54y0`. Checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70` read back with exact versions
1/2/3, zero operations at that migration-time read-back, all four attempt-lineage columns, the
unresolved unique index including `QUARANTINED`, and the parent-freeze trigger. The matching API now
reports authenticated `ready=true`, `schemaVersion=3`; manual run `32325583494` proved six VERIFIED
live operations, including one recovered across runs.

Projection integrity is now an explicit health surface. Before repair it observed 31 VERIFIED V7
terminal operations with three missing durable epochs, one stale epoch, and zero missing snapshots.
Serialized V7-only repair runs `32458718433`, `32459026957`, and `32459340292` synchronized seven
epochs/snapshots without proof failures or rejections and closed every gap. Post-merge keeper run
`32459740369` VERIFIED one resolve and one create and synchronized 3/3 epochs/snapshots; journal
read-back is 64/64 VERIFIED, zero unresolved, while history-health is HTTP 200 at 32/32 terminal/
resolve operations and zero missing, stale, or missing-snapshot rows.

Monitor public health/readiness, exact-hour coverage, exchange source status, finality lag, keeper
failures, role/config drift, parent/child delivery, V6 legacy liability, and history ingestion lag.
The GitHub-native issue watchdog passed manual run `32459656268` and automatic `workflow_run`
`32460047757`. Synthetic run `32461072315` injected failure only after production checks passed and
opened issue #17; recovery `32461245006`/job `96708451794` rechecked every surface, commented, and
closed the issue. GitHub-native delivery is therefore proven. An independent third-party pager is an
optional defense-in-depth enhancement.

## 13. Security requirements

Tests and review must cover:

- UTC rollover, exact boundary seconds, duplicates, and schedule horizons;
- malformed/stale/revised venue data, redirects, symbol confusion, outliers, and quorum loss;
- role compromise, keeper signer races, owner/treasury separation, and fee-cap bypass;
- integer rounding, maximum values, liability conservation, fee isolation, and duplicate claims;
- uncertain submission, delayed finality, child failure, restart, rate limits, and overlapping jobs;
- arbitrary-address injection, wrong-network signing, CSP/CORS/SSRF, cache poisoning, and secret leaks;
- database forgery, duplicate ingestion, stale history, and unavailable history;
- misleading provisional/final labels and unsafe V6 fallback writes.

## 14. StudioNet deployment record

- address: `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`;
- transaction: `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579`;
- result: `FINALIZED`, `MAJORITY_AGREE`, successful execution;
- source SHA-256:
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- V7 direct tests: 22/22 at deployment review;
- combined V6/V7 direct tests: 37/37 at deployment review;
- initial schedule: one canary plus a full 24-target exact-epoch set created and verified;
- dedicated keeper rotation: complete—keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`, finalized
  transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, exact config/repository
  address match, and encrypted environment secret names installed; two local keeper creates
  `0xe10ce0bf…a9c4` and `0x00398a3c…9058` finalized with verified OPEN post-state, and default-branch
  signer/profile evidence passed in reconcile job `96218469576`; the first seven-attempt live run
  `32312864108` failed receipt lookup although both exact writes later finalized/applied. Manual
  journal run `32325583494` on `f937b95a108dddd84e4fda3149452a2c22dd8f84` then succeeded:
  reconcile job `96296050506` verified three resolves and three creates (one recovered across runs,
  five newly submitted), and history job `96297112208` succeeded. That manual-run checkpoint recorded
  at least 34 epochs, including seven workflow-created epochs. V6 workflow `338089016` remains `disabled_manually` with
  `workflow_dispatch`-only `main` source; PR #11 merge `81850e3` restored the V7 cron source;
- first restored scheduled run `32329108358` passed both jobs, verified RESOLVE `1787194800` and
  CREATE `1787288400`, left Neon at 8/8 VERIFIED with zero unresolved, and raised live read-back to
  35 epochs with eight workflow-created;
- second scheduled run `32332196428` passed both jobs, verified exact attempt-1 RESOLVE
  `1787198400` and CREATE `1787292000` transactions with finalized majority-agree receipts and
  matching post-state, left Neon at 10/10 VERIFIED with zero unresolved, and raised evidenced
  read-back to at least 36 epochs with nine workflow-created at that checkpoint;
- 24-hour delivered-run audit: 25/25 scheduled records, 50/50 jobs, and 52/52 actions passed; the
  journal read 62/62 VERIFIED with zero unresolved. The declared cron had 52 nominal slots but only
  25 emitted records, with a longest `01:39:05` gap; catch-up run `32439590155` verified four actions;
- post-soak hardening/repair: PR #15 merged as `abef30d7268b34331528c470cc2a06eefe50ba33`; three repair
  runs closed three missing and one stale durable epoch, and manual run `32459740369` left the journal
  at 64/64 VERIFIED with history health 32/32 terminal/resolve and zero gaps;
- funded V7 canary: complete—resolution `0xc2c86fdb…ab66`, three exact claim deliveries, expected
  loser rejection, 1.748 GEN conserved, and exact 0.002 GEN fee withdrawal delivered;
- Neon production migrations: history v1 and keeper-journal v2/v3 applied; six-table/four-index history
  read-back plus four journal tables/trigger/zero-operation migration-time production read-back passed; initial
  and repeated two-deployment/two-epoch/two-snapshot sync plus public V7 E20/E19 and V6 E19 read-back
  passed; selected proof backfill also passed through run `32309637237`;
- public V7 cutover: complete—historical verified READY deployment
  `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` at
  `https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`, with public readiness and
  legacy V6 read-back `200`. Vercel metadata anchors it to
  `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records `gitDirty=1`; its browser bundle/hash is
  recorded in the deployment evidence JSON. Proof-view PR #6 is merged and deployed. Historical
  READY schedule-restoration artifact `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, GitHub deployment `5994871034`,
  source `81850e3c814cd541d392fdeecf4dacca753d25e6`, served bundle
  `/assets/market-BQWvq82y.js` (188376 bytes), SHA-256
  `37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`, and executed successful
  scheduled run `32329108358`. The earlier verified live-feed-hardening runtime was
  `dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
  `https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app`, GitHub deployment
  `5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`, passed CI run `32332498286`
  jobs `96315684498`/`96315684590` and serves `/assets/market-DTvIR-Xr.js` (191538 bytes), SHA-256
  `7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. Shared ref-counted SSE,
  Vercel request cancellation, and disconnect cleanup hold steady Studio calls near 240/hour under
  the cap of four concurrent streams per IP. Browser trace proved one HTTP-200 stream for ROUND→4H, one per rapid reload,
  LIVE/FRESH without STALE/errors, plus immediate independent HTTP-200 five-asset events. Public
  health/readiness/history-health/proof endpoints returned HTTP 200; readiness matched chain
  `0xf22f`, exact V7/keeper/coverage, and zero V6 liability.

- initial post-soak deployment: `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
  `https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app`, GitHub deployment
  `6017361124`, source `abef30d7268b34331528c470cc2a06eefe50ba33`; CI run `32458652480` passed jobs
  `96700917346`/`96700917084`, and bundle `/assets/market-B8kYJwYW.js` is 191540 bytes with SHA-256
  `2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public surfaces return HTTP
  200; active V7 player liability is 2 GEN across two eligible unclaimed refunds and is non-blocking.

- current synthetic-watchdog deployment: READY/PROMOTED `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
  `https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app`, GitHub deployment
  `6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`; main CI run `32461039766`
  passed, and `/assets/market-BoHfo81C.js` is 193040 bytes with SHA-256
  `82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.

Observed StudioNet finality is not an SLA. The recorded deploy finalized in about 36 seconds, but the
system always waits for actual finality rather than a timer.

## 15. Definition of done

The V7 StudioNet demo is submission-complete only when:

1. all exact-hour, adapter, contract, keeper, browser, server, and history tests pass;
2. the dedicated keeper is encrypted, installed, rotated on-chain, and monitored without owner
   material;
3. a funded two-wallet V7 canary proves both objectives, exact fee/refund math, loser rejection,
   claims, liabilities, and parent/child value delivery;
4. V6 public app/automation paths are demonstrably drained for new writes, the retained owner
   creation capability remains unused, every legacy position remains discoverable/recoverable, and
   its zero-liability live workflow remains disabled;
5. Neon history and keeper-journal migrations pass, the matching journal API returns authenticated
   schema-v3 health, chain truth remains settlement-authoritative, a successful manual action-bearing
   journal run is reviewed, and the restored V7 schedule produces reviewed scheduled evidence;
6. the V7 Vercel release passes health, readiness, RPC, stream, history, wallet, CSP, console, and
   mobile checks, with a tested rollback;
7. timeout behavior and delayed-finality/operator outage behavior are evidenced or explicitly
   disclosed as incomplete;
8. independent security and provider data-use/legal review are complete;
9. deployment hashes, configuration, funded proofs, screenshots, demo video, and known limitations
   are published;
10. every user-facing surface labels StudioNet and faucet GEN as temporary test infrastructure.

Documentation alone does not satisfy these gates. Until they pass, the truthful status is a deployed
V7 StudioNet release candidate with V6 public compatibility, not a production-ready wagering system.
