# Liquidity Arena StudioNet V7 execution brief

This brief turns [the V7 product specification](REDESIGN-SPEC.md) into a release sequence. It records
what is deployed, what is verified, and what must still pass before any public-value readiness claim.
A checked box must be backed by reproducible local output or immutable StudioNet/public evidence.

## Claim UX deployment evidence — 2026-08-21

- [x] Cloudflare backup activation is publicly evidenced: Worker version `536e6476…cea7`, successful
  keeper dispatch run `32473485508` with VERIFIED RESOLVE `0x62331f…c746`, CREATE
  `0x310fc6…5445`, and 3/3 history projection; successful watchdog run `32473776356`; and an
  observed minute-57 `CLOUDFLARE_BACKUP_SKIPPED/current_hour_run_succeeded` decision.
- [x] Post-merge minute-37 proof passes: the Worker tick scheduled for `2026-08-21T14:37:29Z` logged
  its skip at `2026-08-21T14:37:30.115Z` after recognizing successful current-hour run `32490379141`
  on `5ac2c1f`; jobs `96796351916`/`96797302128` VERIFIED exact
  RESOLVE/CREATE post-states and projected 1/3/3/0; watchdog `32490747878`/`96797531668` passed;
  integrity is 39/39/0 with zero gaps.
- [x] As of 2026-08-21, final accessibility release changes pass 210/210 market tests, 7/7 focused claim
  tests, 24/24 Playwright cases (12 journeys across `chromium`/`mobile-chromium`, Desktop Chrome/
  Pixel 7, one worker), 434/434 full tests, a 477-module build, and audit 0.
- [x] Claim aggregates are verified-current only after complete known pagination and successful
  deployment reads. Failed or refreshing cached deployments remain neutral `LAST VERIFIED`/
  `PARTIAL` evidence with `CHECK`/`RETRY`, never a false `≥` lower bound.
- [x] The pre-write quote is intent; wallet account and StudioNet are rechecked immediately before
  writing; finalized actual proceeds must be at least the quote; exact child delivery and persisted
  activity/recovery use that actual amount.
- [x] [PR #21](https://github.com/Leokings/liquidity-arena/pull/21) merged at
  `2026-08-21T13:47:56Z` as `5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475`; CI `32488727873`,
  CodeQL `32488727758`, and Cloudflare scheduler CI `32488727814` succeeded.
- [x] Dependabot alerts and automated security updates, SHA-pin enforcement, conversation resolution,
  and required browser/operator, contracts, and both CodeQL checks are enabled; dependency-graph run
  `32489288312` succeeded.
- [x] GitHub deployment `6022675081` and Vercel deployment `dpl_5FdBbP3e76rwgy1EzqyJYofG4Hxx`
  succeeded; the exact V7 HIGH epoch-`1787205600` route/reconnect UI was production-browser verified.
- [x] An internal independent Codex diff review approved the four-file modal focus-containment fix with no P0/P1/P2 remaining.
- [x] [PR #26](https://github.com/Leokings/liquidity-arena/pull/26) merged at
  `2026-08-21T14:55:40Z` as `881e74895a31cb3cf82c078f4252110306684f30`.
- [x] Main CI `32494801072` passed jobs `96810573370`/`96810573060`; CodeQL `32494801089` passed
  jobs `96810573794`/`96810574148`.
- [x] GitHub deployment `6023788676` and READY Vercel deployment
  `dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr` form the last runtime-changing checkpoint from exact source
  `881e748` with recorded bundle identity at verification;
  release health/readiness checks and the 39/39/0 history snapshot pass.
- [x] Later documentation validation at `2026-08-21T15:16:17.648Z` observed history HTTP 200 ready,
  journal 3, 40/40/0, and zero missing/stale/snapshot gaps.
- [x] An independent read-only Codex immutable-HIGH/alias-LOW desktop/mobile production-browser modal
  focus audit passed with P0/P1/P2 all zero; no wallet action or signature was submitted.
- [x] Pytest advisory [GHSA-6w46-j5rx-g56g](https://github.com/advisories/GHSA-6w46-j5rx-g56g)
  was fixed by PR #22 merge `e79192e`; Dependabot marked
  the alert fixed at `2026-08-21T14:38:20Z`.
- [ ] A live StudioNet user-wallet signature, finalized claim transaction, and exact child delivery
  have not been exercised for this deployment.
- [ ] Active V7 liability remains 2 GEN across two eligible unclaimed refunds.
- [ ] V7 ambiguous asynchronous-child recovery remains a protocol P1. V7 is immutable; the
  implemented but inactive/unbroadcast V8 state machine and idempotent payout escrow are in
  [`V8-PAYOUT-RECOVERY.md`](V8-PAYOUT-RECOVERY.md).

## 1. Frozen design

| Decision | Value |
| --- | --- |
| Runtime | Single-chain GenLayer StudioNet demo |
| Protocol / policy | `LIQUIDITY_ARENA_V7` / `CRYPTO_SPOT_1M_MEDIAN_V1` |
| Currency | Native faucet test GEN |
| Cadence | 24 exact UTC hourly targets per day |
| Schedule | 20m buffer, 20m wagering, 20m battle |
| Assets | BTC, ETH, BNB, SOL, XRP |
| Venues | Binance, OKX, Bybit, Gate, KuCoin |
| Evidence | Completed 1m boundaries, 3-of-5 complete baskets, median return |
| Pools | HIGH and LOW in one epoch, one shared vector |
| Fee | 2% of losing pool; 5% hard cap |
| Stake limits | 0.1–10 test GEN per wallet/objective |
| Exceptional results | Eligible-principal refund, zero fee |
| Resolve / timeout | Permissionless at `E+120s` / `E+24h` |
| Scheduled privilege | Fixed-terms epoch creation only |
| Public host | Vercel |
| Durable history | Neon repeated projection, selected proof backfill, post-soak repair, and journal-to-projection integrity health live; outage recovery and broader proof coverage pending |

V6 remains only for old reads, permissionless resolve/timeouts, and claims.
This is an application/automation policy: the deployed V6 owner creation capability still exists and
must remain unused.

## 2. Canonical hourly example

For a 15:00 UTC target:

| Time | Behavior |
| --- | --- |
| 14:00 | Buffer begins; epoch already exists. |
| 14:20 | HIGH and LOW wagering opens. |
| 14:40 | Wagers lock; battle baseline begins. |
| 15:00 | Battle ends at the exact clock boundary. |
| 15:02 | Permissionless resolution becomes available. |
| after actual finality | Eligible claims/refunds become available. |
| next day 15:00 | Permissionless timeout becomes available if still open. |

An already-created 16:00 epoch continues on its contract clock even if the 15:00 resolver is still
finalizing. If that 16:00 epoch is missing, the keeper cannot create it while an earlier journal
operation remains unresolved.

## 3. Phase A — V7 contract and deployment

### Delivered

- [x] `contracts/LiquidityArenaV7.py` with one shared HIGH/LOW epoch.
- [x] Fixed five-asset/five-venue 3-of-5 median policy.
- [x] Fixed contract-level stake limits and snapshotted future fee.
- [x] Owner/keeper separation and two-step ownership transfer.
- [x] Keeper/owner-only epoch creation with one-hour notice and 26-hour keeper horizon.
- [x] Permissionless resolution and timeout.
- [x] Pull claims, fee isolation, solvency checks, zero-fee exceptional refunds, and bounded views.
- [x] GenVM lint and deterministic direct suites.
- [x] Deployment finalized at `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`.
- [x] Deployment/config/catalog/source read-back recorded.

### Evidence

- transaction: `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579`;
- consensus: `FINALIZED`, `MAJORITY_AGREE`, successful execution;
- source SHA-256:
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- V7 direct tests: 22/22;
- combined V6/V7 direct tests: 37/37;
- schema: 29 methods.

### Remaining

- [ ] Complete independent contract-focused review and remediate critical/high findings.
- [ ] Prove the 24-hour timeout path live or preserve it as a clearly disclosed limitation.
- [ ] Define protocol-safe child-transfer recovery for any real-value future.

## 4. Phase B — hourly automation and role rotation

### Delivered

- [x] Derive exactly 24 future hourly targets.
- [x] Reconcile bounded open-epoch pages rather than every terminal historical epoch.
- [x] Validate exact chain, contract, policy, roles, stake limits, timing, fee, assets, and venues.
- [x] Recheck active signer immediately before every write.
- [x] Bound/serialize writes and require exact finalized receipts/post-state.
- [x] Create and verify the initial 24-hour V7 schedule.
- [x] Pin GitHub workflow action revisions and use concurrency.
- [x] Historical minute-3 execution plus minute-13 watchdog activation was proven. V6 workflow
      `338089016` remains `disabled_manually`, and its merged `main` YAML is
      `workflow_dispatch`-only. PR #11 merged as `81850e3` and restored the V7 cron source; scheduled
      run `32329108358` passed reconcile and history.
- [x] Complete a 24-hour delivered-run checkpoint: 25/25 scheduled records, 50/50 jobs, and 52/52
      actions passed; journal read-back was 62/62 VERIFIED with zero unresolved.
- [x] Serialize every writer with durable `queue: max`, reduce the cron to minute 27, and project up
      to three V7 epochs per run under PR #15 merge `abef30d`.
- [x] Add GitHub-native readiness/history/journal/keeper watchdog; manual and automatic healthy-path
      runs pass.
- [x] Prove watchdog delivery with injected failure run `32461072315` opening issue #17 and recovery
      run `32461245006` commenting and closing it.

### Remaining

- [x] Create the dedicated encrypted keeper account.
- [x] Install environment-scoped keystore secrets and exact role variables.
- [x] Use the owner only once to call `set_keeper(dedicated_keeper)`.
- [x] Verify the on-chain keeper and public repository variable match.
- [x] Capture one activated workflow run proving the imported runtime signer matches.
- [x] Capture the first successful scheduled reconcile after PR #11 restored the V7 cron source.
- [x] Connect coverage, role drift, finality, journal, and history-integrity checks to a GitHub-native
      issue watchdog.
- [ ] Optional: connect an independent third-party pager outside the GitHub control plane.

The owner key must never enter CI. Dedicated keeper
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` replaced the bootstrap wallet through owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, which reached `FINALIZED`,
`MAJORITY_AGREE`, with successful leader execution. Exact `get_config` and repository variable
`V7_KEEPER_ADDRESS` match; secret names `V7_KEEPER_KEYSTORE_B64` and
`V7_KEEPER_KEYSTORE_PASSWORD` are present in environment `studionet-keeper`. Local use of that
keeper created `1787256000` via finalized transaction `0xe10ce0bf…a9c4` and `1787259600` via
finalized transaction `0x00398a3c…9058`; both exact post-states were verified OPEN. This proves the
limited role. Scheduled run `32298454771` then passed reconciliation, and later run `32299468899`
passed exact signer/profile reconciliation with no actions required. Long-run monitoring remains
open. Scheduled run `32312864108`, job `96259232716`, later exercised all seven receipt attempts:
CREATE `0xe6af…3574` and RESOLVE `0x0850…c7e` were reported lookup failures but both later finalized
and applied. Manual authoritative-journal run `32325583494` on commit
`f937b95a108dddd84e4fda3149452a2c22dd8f84` then succeeded: reconcile job `96296050506` verified
six operations (three resolves and three creates), including one recovered across runs and five newly
submitted; history job `96297112208` also succeeded. At that manual-run checkpoint, recorded V7
coverage was at least 34 epochs, including seven workflow-created epochs. Authenticated journal API health is active at `ready=true`,
`schemaVersion=3`. Scheduled run `32329108358` then passed jobs `96306191739` and `96306791996`,
verified RESOLVE `1787194800` and CREATE `1787288400`, and left Neon at 8/8 VERIFIED with zero
unresolved. Live epoch count was 35, including eight workflow-created epochs. Second action-bearing
scheduled run `32332196428` then passed jobs `96314848434` and `96315355338`, verified RESOLVE
`1787198400` and CREATE `1787292000`, and left Neon at 10/10 VERIFIED with zero unresolved.
Evidenced coverage was then at least 36 epochs, nine workflow-created. The later 24-hour checkpoint
proved every delivered run/action, but GitHub produced only 25 run records for 52 nominal slots,
with a longest gap of `01:39:05`. Catch-up run `32439590155` safely verified four actions. PR #15
merged at `2026-08-21T07:26:39Z` with the minute-27 trigger, shared durable queue, history-integrity
gate, active-liability diagnostic, and GitHub-native watchdog. Manual watchdog `32459656268` and
automatic `32460047757` pass. Synthetic failure `32461072315` opened issue #17, and recovery
`32461245006` rechecked production, commented, and closed it. GitHub-native delivery is proven;
independent third-party delivery remains an optional open enhancement.

## 5. Phase C — funded V7 canary

Use at least two faucet-funded wallets and positions on distinct assets/objectives. Record exact
attoGEN values and full hashes.

Required proof:

1. [x] every wager reaches `FINALIZED` and exact `get_entry` post-state;
2. [x] both HIGH and LOW have distinct backing;
3. [x] one permissionless shared resolution reaches `FINALIZED` and matches the authoritative
   returns;
4. [x] fee and refund modes match the actual winner configuration;
5. [x] three eligible payout/refunds finalize through their exact EOA children;
6. [x] an ineligible loser is rejected without state change;
7. [x] player liability, accrued fee, contract balance, and wallet deltas conserve exactly;
8. [x] the read-only delivery monitor is extended/tested for V7 and records exact parent/child proof
   without retrying anything.

Resolution `0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66` selected unbacked SOL HIGH
and backed BNB LOW. Three exact claim children delivered 0.100, 0.100, and 0.198 GEN; loser claim
`0xb0d9889a…e688` failed as expected. Fee parent `0x3df8d942…bb01f` and child `0x566082ce…470e`
delivered 0.002 GEN. A/B/contract balances were 0.700/0.648/0.400 GEN before resolution,
0.800/0.946/0.002 after claims, and 0.802/0.946/0 after fee withdrawal. Liability and accrued fees
ended at zero; 1.748 GEN was conserved throughout. Full hashes are recorded in
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).

## 6. Phase D — V6 drain and compatibility

### Delivered

- [x] V6 is classified as legacy, not an alternate active write target.
- [x] The drain process contains no `create_epoch` operation.
- [x] Due V6 epochs `1787155200` and `1787158800` were resolved on 2026-08-19.
- [x] Later due V6 epochs `1787162400` and `1787166000` were resolved by `0x03f2ac80…0399` and
  `0x7e8030f0…27bb`.
- [x] Historical V6 funded payout/refund evidence remains published.
- [x] The browser deployment registry separates V7 and V6 identities.
- [x] The retained V6 owner-only creation capability is documented as an abstention/monitoring risk,
  not falsely described as revoked on-chain.

### Required compatibility checks

- [ ] V7 is the only new wager target after cutover.
- [ ] Old V6 epochs and wallet positions remain discoverable.
- [ ] Eligible V6 claims and timeouts remain callable.
- [ ] Raw/arbitrary contract URL injection fails closed.
- [ ] Unreadable V6 liability is reported as unknown, never zero.
- [ ] Rollback does not reactivate V6 creation.

V6 may be removed from the browser only after liabilities and user recovery obligations are closed.
The live retirement audit found all five epochs resolved/determined, zero player liability, and no
drain actions. Recurring V6 drain execution is retired. Live workflow `338089016` is
`disabled_manually`; its merged `main` source is `workflow_dispatch`-only.

## 7. Phase E — durable history

Neon is a durable projection of finalized settled epochs. Its production schema migration and
initial finalized-epoch ingestion are complete. It is not an oracle and must not become required for
wager, resolve, timeout, or claim correctness.

Required completion:

- [x] review and apply the migration through the approved temporary-branch workflow;
- [x] read back the expected six tables and four indexes;
- [x] scope the ingestion secret to server/GitHub environment use, not browsers;
- [x] implement/test ingestion restricted to allowlisted contract/protocol identities;
- [x] implement/test rejection of non-final or mismatched records;
- [x] implement/test idempotency and unique epoch identity;
- [x] expose/test bounded read APIs with caching/rate limits;
- [x] derive/reconcile projected records from authoritative chain views;
- [x] report ingestion lag/failure without making projection availability settlement authority;
- [x] cross-check VERIFIED V7 terminal journal operations against durable epochs/snapshots and fail
      history health when rows are missing or stale;
- [ ] document backup/rebuild and rollback behavior.

Live production completion remains:

- [x] run the initial finalized-epoch sync against the migrated schema;
- [x] repeat the same sync and prove production idempotency;
- [x] verify populated public reads for V7 and V6 E19;
- [ ] verify database-outage recovery behavior;
- [x] backfill and verify the selected V7 deployment/canary/fee transaction proofs separately from
      recurring state projection;
- [x] run sequential post-soak projection repair and close all three missing plus one stale durable
      epoch without proof failures or rejections;
- [ ] extend proof coverage beyond the selected evidence set.

Until the remaining checks pass, documentation and UI must distinguish live repeated settled-state
projection from pending outage/broader-proof evidence. Protected run `32309637237` accepted 11
selected records with zero rejections; public V7 E19 contains nine finalized epoch proofs, while its
deployment proof and epochless fee parent are stored separately.

Applied migration ID: `aa7617fa-bfa7-4d48-9b30-f60afeda43a1`. Normalized marked-DDL SHA-256:
`dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`. Raw migration-file SHA-256:
`8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`.

The authoritative keeper journal is a separate Neon concern. Migration 002 was prepared as
`1e440327-2e66-403d-934d-c302790ac775` on temporary branch `br-sweet-frost-auakkl85`, applied
identically to production `br-calm-fire-aup0rw0r`, and the temporary branch was deleted. Final
checksum `d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`
read back with unchanged v1, four journal tables, the trigger, and zero operations at that
migration-time read-back. The runtime
invariants are a fenced global signer lease, durable PREPARE before broadcast, exact captured-hash
binding, and fail-closed recovery before planning. Raw transaction status is liveness only; full
exact receipt identity, successful execution, and matching post-state are required for VERIFIED.
No workflow artifact or cache is authoritative. Migration 003
`keeper_transaction_journal_attempts` is now applied to production as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through deleted temporary branch
`br-polished-shape-aund54y0`, at checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70`. Production read-back found
exact versions 1/2/3, zero operations at that migration-time read-back, four attempt columns, the
`QUARANTINED` unresolved-index rule, and the parent-freeze trigger. The matching API now reports
authenticated `ready=true`, `schemaVersion=3`; manual run `32325583494` proved six VERIFIED live
operations, including one recovered across runs and five newly submitted.

Post-soak runs `32458718433`, `32459026957`, and `32459340292` synchronized seven V7 epochs and
seven snapshots in serialized batches. Integrity moved from 31 verified terminal operations with
three missing and one stale durable epoch to 31/31 with no missing, stale, or missing-snapshot rows.
Manual keeper run `32459740369` subsequently VERIFIED RESOLVE `1787295600` and CREATE `1787389200`,
left the journal at 64/64 VERIFIED with zero unresolved, and synchronized 3/3 epochs/snapshots at
`2026-08-21T07:45:20.943Z`. That checkpoint reached 32/32 terminal/resolve operations and zero gaps;
the recorded post-merge public history-health snapshot is HTTP 200 with 39 verified terminal/resolve operations, zero
timeouts, and zero missing or stale rows.

## 8. Phase F — browser/API release candidate

Required release behavior:

- exact phase/countdown and 24-hour schedule;
- V7-only new writes plus V6 read/resolve/timeout/claim recovery compatibility;
- finalized/provisional/degraded labels;
- live ROUND reset only at battle baseline;
- rolling 1H/4H/1D/1W context unaffected by epoch reset;
- territory area by return, direction by momentum, turbulence by volatility/disagreement;
- pending transaction persistence, exact explorer links, claim history, and recovery state;
- same-origin StudioNet RPC and no secrets in the bundle;
- bounded API input/output, timeouts, cache, rate limits, strict CORS/CSP, and redacted logs;
- readiness based on the same exact deployment config used by the application.

Cutover procedure:

1. [x] configure and promote V7 with the recorded address and expected roles;
2. [x] verify health, readiness, chain `0xf22f`, all five feeds, kline history, CSP, and console;
3. [x] production-browser verify the exact V7 claim deep link and enabled reconnect-to-claim action;
4. [ ] exercise a live V7 user-wallet claim write and V6 legacy wallet claim;
5. [ ] verify mobile, refresh, delayed finality, stale feed, and database outage behavior;
6. [x] preserve the last verified production artifact and environment for rollback;
7. [x] promote V7 while retaining V6 recovery;
8. [x] verify production health/readiness/history-health and exact deployment identity;

Historical verified V7 production deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` was READY at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`. Vercel metadata anchors it
to merged receipt-proof commit `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records
`gitDirty=1`; exact browser artifact `market-BHlwjm1W.js` has SHA-256
`c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`. CI run `32308815377` passed
both jobs; health/readiness/history
health returned `200`, and V6 remained readable with zero known liability. Deployment
`dpl_DQEvnGup417wvTxuxzeNfJvySiM5` remains the prior V6 rollback artifact. Proof-view PR #6 is merged
and deployed. The historical READY artifact that executed first restored run `32329108358` was
Vercel deployment `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, GitHub deployment `5994871034`, source
`81850e3c814cd541d392fdeecf4dacca753d25e6`, bundle `/assets/market-BQWvq82y.js` (188376 bytes),
SHA-256 `37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

The historical stream-hardened runtime was READY deployment `dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
`https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app`, GitHub deployment
`5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI run `32332498286` passed jobs
`96315684498` and `96315684590`. Bundle `/assets/market-DTvIR-Xr.js` is 191538 bytes with SHA-256
`7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. Shared ref-counted SSE,
`supportsCancellation=true`, and disconnect cleanup reduce steady Studio calls to about 240/hour
under the cap of four concurrent streams per IP. Browser tracing proved one HTTP-200 stream for ROUND→4H, one per rapid
reload, LIVE/FRESH without STALE/errors, and an immediate independent HTTP-200 five-asset stream.
Health, readiness, history-health, and proof view returned HTTP 200; readiness matched chain
`0xf22f`, exact V7/keeper/coverage, and zero V6 liability.

The initial post-soak runtime was READY deployment `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
`https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017361124`, source/merge `abef30d7268b34331528c470cc2a06eefe50ba33`. CI run `32458652480`
passed jobs `96700917346` and `96700917084`. Bundle `/assets/market-B8kYJwYW.js` is 191540 bytes,
SHA-256 `2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public surfaces return
HTTP 200 after repair. Readiness reports 2 GEN of active V7 player liability across two eligible
unclaimed refunds without treating that obligation as a service failure.

The previous runtime-changing production artifact and synthetic-watchdog evidence checkpoint was
READY/PROMOTED deployment `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K`
at `https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app`, GitHub deployment
`6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI run
`32461039766` passed. Bundle `/assets/market-BoHfo81C.js` is 193040 bytes with SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint no longer owns the public alias.

The previous core-claim runtime artifact is GitHub deployment `6022675081` and READY/PROMOTED Vercel
deployment `dpl_5FdBbP3e76rwgy1EzqyJYofG4Hxx` at
`https://liquidity-arena-eujqytbxd-leokings588-5902s-projects.vercel.app`. At that verification
checkpoint, `https://liquidity-arena.vercel.app` also targeted exact source
`5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475`, and both URLs served identical
`/assets/market-CfuCPKfs.js` bytes (219197 bytes), ETag
`W/"830736d362d152a9ebb18e01b9b268a1"` for the gzip representation, SHA-256
`de89b5ae0947c35f384e5de0ff806b774947cf416f5e9dd9c0f7b51848232f87`. Health, readiness, and
history-health returned HTTP 200; the recorded post-merge history snapshot reports 39 terminal/resolve
operations, zero timeouts, and zero missing or stale rows. The exact V7 HIGH claim deep link for epoch
`1787205600` showed
`RESOLVED · ON-CHAIN`, `VIEW POSITION / CLAIM`, and enabled `RECONNECT WALLET TO CLAIM HIGH POSITION`
with the Binance stream connected. No error-level or HTTP 500 logs appeared in the first ten
minutes. This is route/reconnect UI evidence, not a live wallet signature or claim transfer, and the
artifact predates the merged PR #26 modal accessibility fix.

The last runtime-changing checkpoint is successful GitHub deployment `6023788676` and READY production Vercel
deployment `dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr`, build `bld_6ru8isp7p`, at
`https://liquidity-arena-7bkvfta05-leokings588-5902s-projects.vercel.app`. At its verification
checkpoint, the public alias and immutable deployment served identical exact-source
`881e74895a31cb3cf82c078f4252110306684f30` `/assets/market-Cbg1BCfB.js` bytes (225141 bytes), ETag
`"7e1bea4635aa5da15eae5805c486d4c1"`, SHA-256
`33a2cfa7b48970660b09bf8b3a455dd3740f09efe65f0e33b5a0707321f95bbf`. Health/readiness/history
pass, and an independent read-only Codex desktop/mobile focus audit returned P0/P1/P2 all zero without a wallet
action or signature.
An evidence-publication successor may move the alias and differ in artifact bytes because the deployment
registries are serverless build inputs; it does not retroactively alter this immutable checkpoint. The
current registry edit leaves every field consumed by `history/deployment-manifest.mjs` unchanged.

## 9. Phase G — submission package

Required artifacts:

- [x] clean public repository with reproducible setup;
- [x] V7 architecture, contract, keeper, history, and security documentation;
- [x] V7 deployment record and funded canary evidence;
- [x] V6 drain/legacy-liability and retained-owner-capability explanation;
- [x] current test/build/dependency outputs;
- [ ] independent review and remediation record;
- [ ] screenshots and short end-to-end demonstration video;
- [x] StudioNet/faucet-GEN limitations and provider/legal disclosures;
- [x] public Vercel URL and rollback record.

## 10. Operational constraints

- StudioNet observed finality is not an SLA; always wait for actual `FINALIZED` status.
- V6 workflow `338089016` remains `disabled_manually`, with `workflow_dispatch`-only source on
  `main`. PR #11 merge `81850e3` restored the V7 cron source; runs `32329108358` and `32332196428`
  both passed exact action-bearing reconcile/history cycles. Contract time defines every epoch and
  permissionless methods avoid an exclusive
  settlement operator.
- Public exchange endpoint availability and terms can change.
- Vercel request runtimes must not own unbounded finality waits.
- Claims require exact child monitoring; no automatic replay is permitted.
- Neon history can improve discoverability but cannot authorize settlement or payment; the separate
  keeper journal intentionally gates whether an automation write may broadcast.
- GitHub schedule delivery is best-effort: only 25 of 52 nominal slots produced records during the
  24-hour audit. The durable writer queue prevents pending replacement but cannot guarantee cron
  emission; contract time and permissionless settlement remain authoritative.

## 11. Current truthful status

The V7 contract, initial full-day schedule, funded canary, dedicated keeper rotation, default-branch
scheduler preflight, repeated Neon state projection, and public V7 promotion are complete. The
selected proof backfill, proof-view deployment, authenticated schema-v3 journal API health, a
successful six-operation authoritative-journal canary, the 24-hour delivered-run audit, projection
repair/integrity gate, end-to-end GitHub-native watchdog delivery, and independent Cloudflare
keeper-dispatch/watchdog-skip evidence are also complete. The release still needs outage/broader-
proof evidence, timeout evidence, schedule-delivery monitoring, a live user-wallet claim
signature/finalized transaction/exact child-delivery proof, protocol
child-recovery closure, and independent
reviews; a third-party pager remains
optional. The post-soak manual keeper/projection run and current
production runtime are recorded. The prior
seven-attempt live run remains recorded as a failed lookup despite both exact writes later
finalizing/applying.

The next safe sequence is:

1. extend transaction-proof coverage and rehearse database outage recovery;
2. monitor minute-27 GitHub plus the live Cloudflare backup; optionally connect an independent
   third-party pager;
3. exercise the deployed claim/refund UX with a live StudioNet user-wallet signature, finalized
   claim transaction, and exact child-delivery verification;
4. continue public browser/wallet soak with V6 legacy recovery;
5. complete the V8 finalized deployment, binding, funding, and live-canary gates before any
   real-value claim;
6. rehearse rollback without re-enabling V6 writes;
7. finish operational/external review and submission media.
