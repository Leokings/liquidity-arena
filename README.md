# Liquidity Arena

Liquidity Arena is a GenLayer StudioNet crypto-return battle for BTC, ETH, BNB, SOL, and XRP.
Every exact UTC hour produces one shared five-asset result and settles two independent pari-mutuel
objectives:

- `HIGH`: the asset with the highest percentage return;
- `LOW`: the asset with the lowest percentage return.

The release target is protocol `LIQUIDITY_ARENA_V7` at
[`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`](https://explorer-studio.genlayer.com/address/0xb2ae59aE641f571726Ae81E30080f8c2192b15EF)
on StudioNet, chain `61999`. The deployment transaction is
[`0x85ca…c579`](https://explorer-studio.genlayer.com/tx/0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579).
Native faucet test GEN is used for wagers; it has no represented real-world value.

## Release status

V7 is deployed and its contract configuration, source hash, direct tests, and initial hourly schedule
have been verified. It is now the public write target. The funded two-wallet V7 canary is
complete: the shared resolution, unbacked-winner refunds, backed LOW payout, loser rejection, three
claim parent/child deliveries, exact conservation, and platform-fee withdrawal were all verified.
The dedicated limited keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` is installed on-chain;
rotation transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`
finalized with majority agreement and successful leader execution, and exact `get_config` read-back
confirmed the new role. Acting as that keeper locally then created epochs `1787256000` and
`1787259600`; transactions `0xe10ce0bf…a9c4` and `0x00398a3c…9058` finalized and both exact
post-states were verified OPEN. Historical default-branch activation is proven: scheduled run
`32298454771` passed reconciliation, and later run `32299468899` passed both no-action reconciliation and bounded
history synchronization. Later verified no-action run `32300282482` also passed reconciliation and history
sync. Later action-bearing scheduled attempts exposed delayed StudioNet receipt indexing. Main
commit `958e51743a821606ca78881e6bcc8fb0a34a8e8f` now polls the same recorded transaction hash seven
times with 5/10/20/40/80/160-second outer delays (315 seconds total) and never resubmits the write;
CI run `32310160397` passed. The first live action-bearing scheduled use is no longer pending:
[run `32312864108`](https://github.com/Leokings/liquidity-arena/actions/runs/32312864108), reconcile
[job `96259232716`](https://github.com/Leokings/liquidity-arena/actions/runs/32312864108/job/96259232716),
failed after all seven lookups on head `958e517`. Its CREATE `0xe6af…3574` and RESOLVE
`0x0850…c7e` nevertheless both later reached `FINALIZED` and their OPEN/RESOLVED post-states were
applied. That is evidence that receipt-index invisibility can exceed 315 seconds, not a failed chain
execution and not a successful journal-backed run.

The replacement journal path is now proven end to end. Manual run
[`32325583494`](https://github.com/Leokings/liquidity-arena/actions/runs/32325583494) on
`f937b95a108dddd84e4fda3149452a2c22dd8f84` passed reconcile job `96296050506` and history job
`96297112208`. It authenticated the production schema-v3 journal, recovered the previously recorded
`resolve_epoch(1787184000)` operation on its original hash without resubmission, and finished with
six journal operations VERIFIED: three resolves and three creates. Five writes were newly submitted
and verified in that run; the recovered operation proves restart-safe same-hash continuity. At that
manual-run checkpoint, the three creates raised recorded coverage to at least 34 epochs, seven of
them workflow-created. PR #11
then restored the V7 minute-3/minute-13 trigger on main commit
`81850e3c814cd541d392fdeecf4dacca753d25e6`. The first restored scheduled run is now proven:
[`32329108358`](https://github.com/Leokings/liquidity-arena/actions/runs/32329108358) passed reconcile
job `96306191739` and history job `96306791996`. It verified RESOLVE `1787194800` and CREATE
`1787288400`; Neon then held eight operations, all VERIFIED, with zero unresolved. Live epoch count
was 35, including eight workflow-created epochs. A second action-bearing scheduled cycle,
[`32332196428`](https://github.com/Leokings/liquidity-arena/actions/runs/32332196428), then passed
reconcile job `96314848434` and history job `96315355338` on source `2664e739`. It verified exact
attempt-1 RESOLVE `1787198400` (`0xebc44786…99dd`) and CREATE `1787292000`
(`0x3d4b235c…8a88`) operations. The production journal read back 10 operations, all VERIFIED, with
zero unresolved; evidenced coverage was then at least 36 epochs, nine workflow-created.

The 24-hour scheduler checkpoint closed at approximately `2026-08-21T06:50Z`. All 25 scheduled V7
run records succeeded (50/50 jobs), and all 52 journal actions were VERIFIED—26 resolves and 26
creates—with zero unresolved operations. Neon read back 62/62 VERIFIED operations before post-soak
maintenance. This proves every delivered run and action in the window, but not every nominal cron
delivery: the former minute-3/minute-13 schedule declared 52 slots while GitHub emitted only 25 run
records (48.08%), with a longest observed gap of `01:39:05`. Catch-up run
[`32439590155`](https://github.com/Leokings/liquidity-arena/actions/runs/32439590155) safely verified
four actions through the journal.

[PR #15](https://github.com/Leokings/liquidity-arena/pull/15) merged as
`abef30d7268b34331528c470cc2a06eefe50ba33` at `2026-08-21T07:26:39Z`. It changes V7 to one hourly
minute-27 trigger, gives all serialized writer workflows a durable `queue: max` concurrency queue,
projects up to three V7 epochs per run, makes history configuration mandatory, adds projection-
integrity health, reports active V7 player liability without blocking readiness, and adds a
GitHub-native issue watchdog. Three sequential repair runs—`32458718433`/job `96701115201`,
`32459026957`/job `96702015382`, and `32459340292`/job `96702933162`—all passed, synchronizing
3/3, 2/2, and 2/2 epochs/snapshots with no proof failures or rejections. Integrity moved from 31
verified terminal operations with three missing and one stale durable epoch to 31/31 complete with
zero missing, stale, or missing-snapshot rows.

Post-merge manual keeper run
[`32459740369`](https://github.com/Leokings/liquidity-arena/actions/runs/32459740369) passed reconcile
job `96704099506` and history job `96704818464`. It VERIFIED RESOLVE `1787295600`, operation
`4d0a94692338f4650a64ed6d44b8ae21eb3ee2c0ec3b0937eb77408cffc55cf9`, transaction
`0x6b2928291db52738ddcceb0500b7790ad46098a09e9c058effdeb9ba9e022bea`, and CREATE `1787389200`,
operation `f55fa63b8e598172435ec284d7eb82e6db2c8aeb6f368188bc6f58452e172252`, transaction
`0x2075252b008d239da9bee85ff7186b0548da20570db8d319a0ed1ce1d4f25d73`. Both exact post-states
matched RESOLVED and OPEN, and history synchronized 3/3 epochs/snapshots at
`2026-08-21T07:45:20.943Z`. The journal is now 64/64 VERIFIED with zero unresolved. Public
`/api/history-health` returns `200` with 32/32 verified terminal/resolve operations and zero timeout,
missing, stale, or missing-snapshot rows. Watchdog manual run `32459656268`/job `96703858691` and
automatic `workflow_run` `32460047757`/job `96704995526` both passed. Synthetic failure run
[`32461072315`](https://github.com/Leokings/liquidity-arena/actions/runs/32461072315), job
`96707962137`, then passed all production checks, intentionally injected a failure, and opened
[issue #17](https://github.com/Leokings/liquidity-arena/issues/17) at `2026-08-21T07:59:29Z`.
Healthy recovery run `32461245006`/job `96708451794` succeeded and closed the issue at
`2026-08-21T08:01:35Z` with an
[automated recovery comment](https://github.com/Leokings/liquidity-arena/issues/17#issuecomment-5367061156).
GitHub-native alert delivery and recovery are therefore proven end to end. An optional independent
third-party pager is not configured.

The public site at [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app) now targets V7.
V6 at
[`0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1`](https://explorer-studio.genlayer.com/address/0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1)
is operationally retired: the supported public app and automation expose no V6 epoch-creation or
wager path. The deployed V6 owner capability still exists, however, and a directly created OPEN V6
epoch would accept wagers; the owner must not use that capability. Due epochs `1787155200` and
`1787158800` were resolved on 2026-08-19 by transactions `0xae0ce453…e1480` and `0x09f01c2a…e735`.
Legacy read/resolve/timeout/claim paths remain available. Subsequent permissionless drains resolved
epochs `1787162400` and `1787166000` with transactions `0x03f2ac80…0399` and `0x7e8030f0…27bb`.
The final live audit found all five V6 epochs resolved/determined and zero player liability, so the
recurring V6 drain has been retired. Live GitHub workflow `338089016` is `disabled_manually`;
main now keeps only `workflow_dispatch` for that legacy drain.

| Surface | Current state |
| --- | --- |
| V7 contract | Deployed and finalized on StudioNet |
| V7 hourly coverage | 24-hour checkpoint: 25/25 delivered scheduled runs and 52/52 actions passed; 25 of 52 nominal cron slots produced records, so delivery reliability remains monitored |
| V7 funded canary | Complete: settlement, three claim deliveries, loser rejection, conservation, and fee withdrawal verified |
| Dedicated V7 keeper rotation | Complete: finalized on-chain and exact config/repository address verified |
| V7 keeper workflow | Workflow `338089019` is active on minute 27; writer jobs share durable `queue: max`; post-merge run `32459740369` passed both jobs |
| Public Vercel browser | V7 active and READY; runtime guarantees last changed at source `a1c773a`, while later docs-only publication deployments may own the alias; V6 legacy recovery remains readable with zero known liability |
| V6 | Public app/automation new writes disabled; owner creation capability remains and must not be used |
| Durable settled-epoch history | Repair backfill and integrity health passed: 32 verified V7 resolves, 0 missing/stale/snapshot gaps; outage recovery and broader proof coverage remain pending |
| Keeper journal | Operational authority active; 64/64 operations VERIFIED, 0 unresolved after the post-soak manual run |
| Active V7 player liability | 2 GEN, representing two eligible unclaimed refunds; reported as an outstanding participant obligation, not a readiness failure |
| Operations watchdog | Healthy, synthetic-failure, issue-open, recovery, and issue-close paths pass; optional independent pager not configured |
| Proof view | Merged in [PR #6](https://github.com/Leokings/liquidity-arena/pull/6) and present in the current production runtime artifact |

The last fully enumerated pre-journal production artifact was Vercel deployment
`dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi`
([immutable URL](https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app)). Vercel
metadata anchors the CLI deployment to merged StudioNet receipt-proof fix
`e5627ebd270a7c6d5291151795b0af6442eba0a6` but also records `gitDirty=1`, so that commit is an
anchor rather than a byte-identical source claim. The exact served browser bundle
`market-BHlwjm1W.js` has SHA-256
`c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`. Vercel reports READY; both
immutable URL and public alias returned `200` readiness for V7, five feeds, keeper coverage, and
readable zero-liability V6 compatibility. `/healthz` and `/api/history-health` also returned `200`.
CI run `32308815377` passed browser/operator job `96247333491` and intelligent-contracts job
`96247333299` for the source anchor. V6 compatibility deployment `dpl_DQEvnGup417wvTxuxzeNfJvySiM5`
remains a READY rollback artifact. The alias has since received the merged proof view, journal API,
receipt-recovery fixes, and schedule restoration. The historical production artifact that executed
the first restored scheduled run `32329108358` was READY Vercel deployment
`dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ` at
[its immutable URL](https://liquidity-arena-dz2a8196a-leokings588-5902s-projects.vercel.app), GitHub
deployment `5994871034`, sourced from `81850e3c814cd541d392fdeecf4dacca753d25e6`. Its served bundle
`/assets/market-BQWvq82y.js` is 188376 bytes with SHA-256
`37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

The historical stream-hardened production runtime was READY Vercel deployment
`dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
[its immutable URL](https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app),
GitHub deployment `5995889896`, sourced from
`c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI run `32332498286` passed browser/operator job
`96315684498` and intelligent-contracts job `96315684590`. Its served bundle
`/assets/market-DTvIR-Xr.js` is 191538 bytes with SHA-256
`7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`. The runtime shares one
ref-counted EventSource per URL/tab, enables Vercel request cancellation, and releases stream
reservations on disconnect; steady Studio calls are about 240/hour, with four concurrent streams
per IP and a server-wide default cap of 100. Production browser verification observed one HTTP-200 SSE request across ROUND→4H
with no extra stream, exactly one HTTP-200 SSE request on each of two rapid reloads, LIVE/FRESH UI
with no STALE state or browser error, and an immediate separate curl returning HTTP 200 with live
BTC/ETH/BNB/SOL/XRP events. Public health, readiness, history health, and proof view returned HTTP
200; readiness reported chain `0xf22f`, the exact V7/keeper, current coverage, and zero V6 liability.

The initial post-soak production artifact was READY Vercel deployment
`dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
[its immutable URL](https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app), GitHub
deployment `6017361124`, source/merge
`abef30d7268b34331528c470cc2a06eefe50ba33`. Bundle `/assets/market-B8kYJwYW.js` is 191540 bytes,
has ETag `W/"aed8cd3722fd07b7762e4331cd94d235"`, and SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public health, readiness,
history-health, and proof surfaces returned HTTP 200 after repair. Readiness reports the 2 GEN active
player liability as two unclaimed eligible refunds without treating that positive obligation as an
availability failure.

The last runtime-changing production artifact and synthetic-watchdog evidence checkpoint from PR #16
was READY and promoted as Vercel deployment `dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
[its immutable URL](https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app), GitHub
deployment `6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI run
`32461039766` passed browser/operator job `96707863823` (393/393 tests, 477-module build, audit 0)
and contracts job `96707864002` (V6/V7 lint and 37 direct tests). Bundle
`/assets/market-BoHfo81C.js` is 193040 bytes, has ETag
`"fa10949a324593024ea6c209eb3a0cc3"`, and SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint is not a claim that the public alias still targets it: later documentation-only
publication deployments may supersede the alias without changing the recorded runtime guarantees.

The 24-target full-day seed covers epoch IDs `1787169600` through `1787252400`. Its first and final
creation transactions are `0x7b94b2d0…7726` and `0x443afcf7…7677f`; the separate canary epoch
`1787166000` was created by `0x48658624…72cb`. These 25 creations prove bounded scheduling, not
continuous automation. The rotated keeper separately created `1787256000` and `1787259600` through
finalized transactions `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4`
and `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`; both were read back OPEN.

## Exact-hour schedule

Each epoch is identified by its exact UTC end time `E`; therefore there are exactly 24 targets per
UTC day.

| Interval | Phase | Behavior |
| --- | --- | --- |
| `[E-60m, E-40m)` | Buffer | The epoch exists, but wagers are closed. |
| `[E-40m, E-20m)` | Wagering | Users may enter or top up `HIGH`, `LOW`, or both. |
| `[E-20m, E)` | Battle | Wagers are locked and returns are measured. |
| `[E, E+120s)` | Publication | Completed one-minute boundary candles become available. |
| `[E+120s, E+24h)` | Resolution | `resolve_epoch(E)` is permissionless. |
| `E+24h` onward | Timeout | If still open, `activate_timeout_refund(E)` is permissionless. |

Only the ROUND visualization resets at battle start. The 1H, 4H, 1D, and 1W views are rolling
historical context and do not reset with an epoch.

## Settlement policy

The immutable policy is `CRYPTO_SPOT_1M_MEDIAN_V1`. GenLayer validators independently read completed
one-minute spot candles from Binance, OKX, Bybit, Gate, and KuCoin. A venue qualifies only if its
complete five-asset basket passes timestamp, symbol, schema, and price validation. At least three of
the five venues must qualify.

For each asset, the contract takes the deterministic median venue return. The same canonical vector
selects both `HIGH` and `LOW`. A finalized contract vector permanently replaces the provisional live
ROUND display. Territory area is return-only; momentum controls movement and volatility/disagreement
controls turbulence, never payout.

Temporary source failure does not invent a result. Fewer than three complete venues raises a
retryable quorum error and leaves the epoch OPEN; it does not immediately select
`REFUND_UNDETERMINED`. If the epoch remains open until `E+24h`, anyone can activate the deterministic
zero-fee timeout refund.

## Wagers, fees, and claims

- V7 holds native faucet test GEN directly on StudioNet.
- The deployed epoch stake range is 0.1–10 GEN per wallet per objective.
- A wallet chooses one asset per objective and may top up only that asset before wager close.
- The default fee is 2% of the losing pool, snapshotted when the epoch is created; the contract caps
  future fee settings at 5%.
- Ties, an unbacked winner, no losing side, an undetermined result, and timeout return eligible
  principal with zero fee.
- Winners and refundable participants pull their own claims; the contract has no unbounded payout
  loop.
- Money actions are considered delivered only after the parent transaction is `FINALIZED`, execution
  and post-state match, and the exact EOA transfer child is also finalized.

The checked-in claim-delivery monitor is read-only and requires an explicit `--protocol v6` or
`--protocol v7` deployment profile. It never retries or re-emits a transfer: retrying without
protocol-proof that the original child failed could double-pay if that child later finalizes. The V7
canary proved three exact finalized claim-parent/EOA-child deliveries; ambiguous child-failure
recovery remains outside that healthy-path proof.

The V7 canary epoch `1787166000` resolved with
`0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66`: HIGH selected unbacked SOL
and refunded both HIGH positions; LOW selected backed BNB and delivered 0.198 GEN. The expected LOW
XRP loser claim failed without changing state. After the three claims, balances were 0.800 GEN,
0.946 GEN, and 0.002 GEN for account A, account B, and the contract. The exact 0.002 GEN fee was then
delivered to treasury by parent `0x3df8d942…bb01f` and child `0x566082ce…470e`, leaving 0.802 GEN,
0.946 GEN, and zero respectively. The conserved total was 1.748 GEN throughout. Full hashes are in
[`deployments/studionet-v7.json`](deployments/studionet-v7.json).

## V7 authorization model

V7 narrows the scheduled operator:

- only the owner or current keeper may call `create_epoch(E)`;
- the keeper cannot schedule more than 26 hours ahead and every epoch needs at least one hour of
  notice;
- anyone may call `resolve_epoch(E)` or `activate_timeout_refund(E)` after their gates;
- only the owner changes the keeper or fee and ownership uses propose/accept transfer;
- only the owner or treasury may withdraw already accrued fees.

The owner key is not a workflow credential. The current keeper is the dedicated limited account
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`; GitHub environment `studionet-keeper` contains the
encrypted keeper keystore/password secrets, and repository variable `V7_KEEPER_ADDRESS` records the
same public address. Successful default-branch runs now prove the runtime signer/profile and observed
coverage; two local finalized creates independently prove the dedicated account's limited on-chain
keeper authority. The completed 24-hour checkpoint proves delivered-run execution, while the 25/52
nominal GitHub schedule-delivery ratio remains an availability monitoring obligation.

That runtime preflight is now proven by reconcile job `96218469576` in run `32299468899`. It checked
the exact contract profile and imported signer and correctly planned no actions because coverage was
already complete. This is activation evidence, not a long-run availability guarantee.

The replacement keeper safety boundary uses an authoritative Neon pending-operation journal, not a
workflow artifact or cache. A fenced global signer lease covers V7 and manual V6 recovery. Every
write must commit `PREPARED` before broadcast and bind the exact captured hash immediately after
submission. Raw `gen_getTransactionStatus` is only a liveness signal; `FINALIZED` there is not proof.
The journal marks success only after the full receipt proves the exact hash/contract/method/arguments
and successful execution, followed by matching post-state. Unknown, pending, quarantined,
ambiguous, or otherwise unverified operations fail closed and block later writes. An exact
receipt-verified `FINALIZED_FAILURE` may be retried only as a new immutable numbered attempt; it
never clears or overwrites the failed attempt's hash. Neon migration 002 was applied
to production branch `br-calm-fire-aup0rw0r` with final checksum
`d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`; the migration-time production
read-back found the four journal tables and trigger, preserved migration v1, and contained zero
operations.
Migration 003 `keeper_transaction_journal_attempts` was applied to Neon project
`steep-hat-04600004`, parent branch `br-calm-fire-aup0rw0r`, as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through temporary branch
`br-polished-shape-aund54y0`, which was deleted after completion. Its final checksum is
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70`. Its migration-time production
read-back found exact schema versions 1/2/3, zero operations at that migration-time read-back, all
four attempt-lineage columns, the
unresolved unique index covering `QUARANTINED`, and the parent-freeze trigger. The matching production
API now returns authenticated `ready=true`, `schemaVersion=3` health before lease acquisition. Run
`32325583494` then recovered one previously submitted exact hash and finished with six VERIFIED
operations—three resolves and three creates—without a duplicate submission. The journal is now the
active workflow write authority; artifacts and caches remain non-authoritative. Scheduled run
`32329108358` then verified one resolve and one create. Independent receipt/post-state checks passed,
and the production journal read back eight operations, all VERIFIED, with zero unresolved. Scheduled
run `32332196428` subsequently verified another exact resolve/create pair; Neon then read back 10/10
VERIFIED operations with zero unresolved. The dated 24-hour checkpoint later read 62/62 VERIFIED;
post-merge run `32459740369` added one resolve and one create, producing the current 64/64 VERIFIED
and zero-unresolved state.

## Run and verify locally

```powershell
npm ci
npm test
npm run build
npm start
```

Open `http://127.0.0.1:4400/market.html`. Live exchange data is the default; use `?feed=demo` only
for the deterministic replay.

Contract checks:

```powershell
python -X utf8 -m pytest tests/direct -q
python -X utf8 -m genvm_linter.cli check contracts/LiquidityArenaV7.py
```

V7 keeper dry run:

```powershell
$env:V7_CONTRACT_ADDRESS='0xb2ae59aE641f571726Ae81E30080f8c2192b15EF'
$env:V7_OWNER_ADDRESS='<expected owner>'
$env:V7_KEEPER_ADDRESS='0x12ba664a1ec9ca78b070d103c6a69e20673f4b51'
$env:V7_TREASURY_ADDRESS='<expected treasury>'
node scripts/v7-keeper.mjs --config scripts/examples/v7-keeper.example.json
```

Do not use the owner key for routine scheduling. See [the V7 keeper runbook](docs/round-keeper.md).

## Remaining release gates

After public V7 cutover:

1. keep V6 legacy reads/claims available and retain a tested rollback without re-enabling V6 writes;
2. rehearse database outage/recovery and extend transaction-proof coverage beyond the selected V7
   deployment/canary/fee evidence;
3. continue coverage/journal/role/finality alerting, investigate the 25/52 nominal GitHub cron-
   delivery ratio; GitHub-native issue delivery/recovery is proven, while an independent third-party
   pager remains an optional open enhancement;
4. complete timeout evidence, independent security review, browser/wallet soak, and provider
   data-use/legal review.

Initial history run `32299468899`, job `96218806119`, synchronized two deployments, two epochs, and
two full E19 snapshots. Later run `32300282482`, reconcile job `96221017562` and history job
`96221327115`, also succeeded on main commit `45be825…fe17`. Its state read at
`2026-08-19T20:47:19.912Z` synchronized two deployments, two epochs, and two snapshots with
`proofsVerified=0`. Public history now has V7 E20 (`1787169600`) plus V7 E19 and V6 E19; all three
are resolved/determined with no duplicate V6 E19 row. This proves repeated projection behavior but
was not itself transaction-proof backfill. Merged fix
`e5627ebd270a7c6d5291151795b0af6442eba0a6` taught the fail-closed verifier to accept StudioNet's
finalized consensus/leader receipt shape. Manual protected run `32309637237`, job `96249796253`,
then completed all quota-spaced batches with 6, 3, and 2 verified proofs and zero rejected requests.
The 11 accepted records comprise one deployment proof, nine V7 E19 epoch proofs (one creation, four
wagers, one resolution, and three credited claims), and the epochless fee-withdrawal parent. Public
history exposes exactly those nine E19 proofs; V7 E20 and V6 E19 remain at zero because they were not
part of this selected backfill. The fee parent is correctly absent from an epoch array because
`withdraw_accrued_fees` has no epoch argument; its child-delivery monitor remains the stronger
delivery evidence. Database outage recovery is still pending. Earlier scheduled run `32298454771`
had successful reconciliation while its history job hit the StudioNet provider quota; later bounded
syncs supersede that incident. Scheduled V6 drain run `32297047031` also passed.

The post-soak history repair used three serialized V7-only workflow-dispatch batches:
`32458718433` (3 epochs/snapshots), `32459026957` (2/2), and `32459340292` (2/2). All passed with
zero proof failures or rejections. The integrity gate changed from 31 verified terminal operations,
three missing durable epochs, one stale epoch, and zero missing snapshots to 31/31 with zero gaps.
Manual keeper run `32459740369` then projected 3/3 at `2026-08-21T07:45:20.943Z`; the live integrity
read-back is now 32 terminal operations, all `resolve_epoch`, with zero timeout, missing, stale, or
missing-snapshot rows.

Manual authoritative-journal run `32325583494` later passed reconcile job `96296050506` and history
job `96297112208`. Its history read at `2026-08-20T02:49:02.975Z` synchronized two deployments, two
epochs, and two snapshots with zero requested or rejected new proofs. This is the latest proven
manual projection. Restored scheduled run `32329108358` then passed history job `96306791996`; at
`2026-08-20T03:45:10.146Z` it synchronized two deployments, two epochs, and two snapshots with zero
new or rejected proofs and `replayed=false`. Second scheduled run `32332196428` passed history job
`96315355338`; at `2026-08-20T04:34:56.951Z` it again synchronized two deployments, two epochs, and
two snapshots, with zero proof failures or rejections and `replayed=false`.

StudioNet finality has been observed in tens of seconds, including finalized transactions in under a
minute, but these samples are not a bound or service-level promise. Claims never unlock at
`ACCEPTED`.

## Documentation

- [V7 deployment and cutover record](docs/STUDIONET-V7.md)
- [Technical architecture](TECHNICAL.md)
- [Contract requirements](contracts/README.md)
- [Keeper runbook](docs/round-keeper.md)
- [Public durable-history API](docs/HISTORY-API.md)
- [Security model](SECURITY.md)
- [Audit status](docs/AUDIT.md)
- [Submission status](docs/SUBMISSION-TECH.md)
- [Product specification](docs/REDESIGN-SPEC.md)
- [Execution brief](docs/REDESIGN-EXECUTION-BRIEF.md)
- [Machine-readable V7 deployment record](deployments/studionet-v7.json)
- [Legacy V6 deployment evidence](deployments/studionet-v6.json)
