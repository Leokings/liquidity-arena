# StudioNet V7 deployment and cutover record

## Deployment

| Field | Value |
| --- | --- |
| Network | GenLayer StudioNet |
| Chain ID | `61999` (`0xf22f`) |
| Protocol | `LIQUIDITY_ARENA_V7` |
| Policy | `CRYPTO_SPOT_1M_MEDIAN_V1` |
| Contract | [`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`](https://explorer-studio.genlayer.com/address/0xb2ae59aE641f571726Ae81E30080f8c2192b15EF) |
| Deployment tx | [`0x85ca7d…c579`](https://explorer-studio.genlayer.com/tx/0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579) |
| Created | `2026-08-19T17:15:58.617644Z` |
| Finalized | `2026-08-19T17:16:34.249123Z` |
| Consensus | `FINALIZED`, `MAJORITY_AGREE` |
| Execution | `FINISHED_WITH_RETURN` |
| Source SHA-256 | `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F` |

The machine-readable source of record is
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json). This document adds operational
context; it does not replace the JSON evidence.

## 2026-08-21 release-candidate update

Cloudflare backup activation is now evidenced, without changing the V7 contract identity or any
recorded Vercel artifact ID. Worker version `536e6476-3c4e-4b93-a454-700f55d6cea7` dispatched keeper
run `32473485508`; reconciliation VERIFIED RESOLVE `0x62331f…c746` and CREATE `0x310fc6…5445`, and
history synchronized 3/3 epochs/snapshots. Watchdog run `32473776356` succeeded. A subsequent
minute-57 Worker log emitted `CLOUDFLARE_BACKUP_SKIPPED` with
`current_hour_run_succeeded`, proving the conditional skip path.

Claim/refund UX hardening is local release-candidate code only. As of 2026-08-21, pre-modal
aggregate eligibility, same-page route/session preservation, explicit cross-deployment reconnect,
exact reload intent, fail-closed quote identity, last-good validated pagination, and accessible
actions pass 208/208 market tests, 80/80 focused claim tests, 22/22 Playwright cases (11 journeys
across `chromium`/`mobile-chromium`, Desktop Chrome/Pixel 7, one worker), 432/432 full tests, a
477-module build, and audit 0. Verified-current aggregates require complete known pagination and
successful deployment reads;
failed or refreshing cached rows are neutral `LAST VERIFIED`/`PARTIAL` evidence with no false `≥`
lower bound. The changes are not yet merged, deployed, or live-wallet tested.

The pre-write quote is intent. The runtime rechecks exact quote identity, wallet account, and
StudioNet immediately before writing; finalized actual proceeds must be at least the quote; exact
child delivery is verified against the actual amount; and activity/recovery stores that actual.

V7 still reports 2 GEN of active player liability across two eligible unclaimed refunds. Because V7
has no upgrader and applies claim accounting before its independent transfer child, ambiguous-child
recovery remains a protocol P1. The proposed fresh V8 state machine and idempotent escrow are in
[`V8-PAYOUT-RECOVERY.md`](V8-PAYOUT-RECOVERY.md).

## Deployed policy

- assets: BTC, ETH, BNB, SOL, XRP;
- venues: Binance, OKX, Bybit, Gate, KuCoin;
- quorum: at least three complete five-asset venue baskets;
- interval: completed one-minute spot candles;
- aggregation: deterministic median return per asset;
- objectives: HIGH and LOW from one shared vector;
- cadence: 24 exact UTC hourly targets per day;
- phases: 20-minute buffer, 20-minute wagering, 20-minute battle;
- resolution: permissionless from `E+120s`;
- timeout: permissionless from `E+24h`;
- currency: native faucet test GEN;
- stakes: 0.1–10 GEN per wallet/objective;
- fee: 2% of losing pool by default, hard-capped at 5%.

## Role state

The live role state currently identifies:

- owner/treasury: `0x797d3b25fb2cca0ff93f60df1910267f3822d655`;
- dedicated keeper: `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`;
- pending owner: zero address.

These are public contract roles, not secret material. The constructor initially recorded bootstrap
keeper `0x87e94edab4418e8a9ea37c0fab0675cf0602a9f2`. Owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc` replaced it with the dedicated
keeper and reached `FINALIZED`, `MAJORITY_AGREE`, with successful leader execution. Exact
`get_config` read-back confirms the dedicated address. GitHub environment `studionet-keeper` now has
secret names `V7_KEEPER_KEYSTORE_B64` and `V7_KEEPER_KEYSTORE_PASSWORD`, and repository variable
`V7_KEEPER_ADDRESS` holds the same public address. The owner key must never enter workflow or Vercel
secrets. Reconcile job `96218469576` in run `32299468899` passed the exact default-branch
profile/runtime-signer preflight.

## Schedule state

Twenty-five exact-hour epochs were created and verified. Canary epoch `1787166000` was created by
`0x48658624ab4923cc81b594863cca424f0f7a7026dc29f2fe71241297f50672cb`. The full-day set contains
24 IDs from `1787169600` through `1787252400`; its first and final creation transactions are
`0x7b94b2d0dc4d0970482e60a2cec1fc4d3c3bcf0592816e992b3acbc9474b7726` and
`0x443afcf771f1c5751bdc0e525b75b8d04e7378ef37bb7f817799f98f36c7677f`. This proves full-day
derivation and creation, but it does not prove continuous scheduled operation. The default-branch
workflow's activation/preflight is proven. Legacy V6 workflow `338089016` remains
`disabled_manually` with a `workflow_dispatch`-only source. V7 workflow `338089019` is active; PR #11
restored its minute-3/minute-13 schedule on main commit
`81850e3c814cd541d392fdeecf4dacca753d25e6` after the journal canary passed. Restored scheduled run
[`32329108358`](https://github.com/Leokings/liquidity-arena/actions/runs/32329108358) passed reconcile
job `96306191739` and history job `96306791996`. The dedicated keeper rotation is complete; later
local and workflow creates raised the live read-back total to 35 epochs. Second action-bearing
scheduled run [`32332196428`](https://github.com/Leokings/liquidity-arena/actions/runs/32332196428)
passed reconcile job `96314848434` and history job `96315355338`; evidenced coverage is now at least
36 epochs, nine workflow-created.

StudioNet may return `transaction not found` for a newly broadcast hash before its receipt index is
visible. Main commit `958e51743a821606ca78881e6bcc8fb0a34a8e8f` (PR #5) therefore gives both V7
and V6 automation seven attempts on the same recorded hash with 5/10/20/40/80/160-second outer
delays, a 315-second propagation window. It never resubmits the write. CI run `32310160397` passed
browser/operator job `96251325751` and intelligent-contracts job `96251325923`. The first live
scheduled use is now recorded: [run `32312864108`](https://github.com/Leokings/liquidity-arena/actions/runs/32312864108),
[job `96259232716`](https://github.com/Leokings/liquidity-arena/actions/runs/32312864108/job/96259232716),
on head `958e517`. It exhausted seven receipt lookups for CREATE `0xe6af…3574` and RESOLVE
`0x0850…c7e`; both exact hashes later reached `FINALIZED` and their intended OPEN and
RESOLVED/DETERMINED post-states applied. This proves receipt-index invisibility beyond 315 seconds,
not a failed execution or successful journal-backed run.

The replacement journal then proved the recovery boundary. Manual run
[`32325583494`](https://github.com/Leokings/liquidity-arena/actions/runs/32325583494), reconcile
[job `96296050506`](https://github.com/Leokings/liquidity-arena/actions/runs/32325583494/job/96296050506),
on head `f937b95a108dddd84e4fda3149452a2c22dd8f84` authenticated schema-v3 health and recovered
`resolve_epoch(1787184000)` on its already bound hash `0x1e90…02a6`. It then submitted and verified
two further resolves and three creates. All six journal operations reached VERIFIED with exact
receipt/execution/post-state checks; the recovered operation was not resubmitted. History job
`96297112208` also passed. At that manual-run checkpoint, the three new creates—`1787277600`,
`1787281200`, and `1787284800`—raised the evidenced totals to at least 34 epochs and seven
workflow-created epochs.

The first restored scheduled run then verified RESOLVE `1787194800` through transaction
`0x1943…9206` and CREATE `1787288400` through `0xe9fc…b85a`. Both exact attempt-1 journal operations
reached VERIFIED with finalized majority-agree receipts, successful execution, and matching
post-state. Neon read back eight operations, all VERIFIED, with zero unresolved. The resolve selected
BTC HIGH `-1190077` ppb and XRP LOW `-5067874` ppb from Binance, OKX, Gate, and KuCoin, with both
objectives in `REFUND_UNBACKED_WINNER`; the new epoch read back OPEN. Live totals became 35 epochs
and eight workflow-created epochs.

The second scheduled run then verified exact attempt-1 RESOLVE `1787198400` through transaction
`0xebc4478607bbc6ca17d670dafa05d4aca99d8282959db50072fa881af47199dd` (operation
`77ea4dec2b4f3e8a5302771eb6a5c0a60736a48e8175201df1956215b2bc964e`) and CREATE `1787292000`
through `0x3d4b235c91dbefaeffc1f790ed5a4f3466cefb7b452d190aac12eb4c099b8a88` (operation
`8e86c84b1a85eabb6768decf1fc755f3ff0207c6098c667c6bc08070c9ca48f2`). Both finalized with
majority agreement, successful exact keeper-to-V7 execution, and matching RESOLVED/OPEN post-state.
Neon snapshot `2026-08-20T04:40:05.109Z` read back 10 operations, all VERIFIED, zero unresolved.

### Recorded 24-hour checkpoint and post-soak hardening

The audit cutoff was approximately `2026-08-21T06:50Z`. All 25 scheduled V7 run records succeeded,
all 50 jobs succeeded, and all 52 journal actions were VERIFIED—26 resolves and 26 creates—with zero
unresolved. The journal read back 62/62 VERIFIED before post-soak maintenance. This is a clean
delivered-run execution result, but the prior minute-3/minute-13 cron declared 52 nominal slots and
GitHub emitted only 25 records (48.08%); the longest observed gap was `01:39:05`. Catch-up run
[`32439590155`](https://github.com/Leokings/liquidity-arena/actions/runs/32439590155) safely verified
four actions.

[PR #15](https://github.com/Leokings/liquidity-arena/pull/15) merged as
`abef30d7268b34331528c470cc2a06eefe50ba33` at `2026-08-21T07:26:39Z`. Its operational changes are:

- one V7 schedule at minute 27 each hour;
- one shared durable `queue: max` concurrency group for keeper, history repair, and proof backfill
  writers, while the Neon fenced lease remains the distributed write boundary;
- required history configuration and V7-only projection of up to three epochs per run;
- journal-to-projection terminal/snapshot integrity health;
- non-blocking active V7 player-liability reporting;
- a GitHub-native issue watchdog over readiness, history integrity, journal health, and keeper
  recency/conclusion.

CI run `32458652480` passed browser/operator job `96700917346` and intelligent-contracts job
`96700917084`. Repair runs `32458718433`/job `96701115201`, `32459026957`/job `96702015382`, and
`32459340292`/job `96702933162` all passed, synchronizing 3/3, 2/2, and 2/2 epochs/snapshots with no
proof failures or rejections. Integrity moved from 31 terminal operations with three missing and one
stale durable epoch to 31/31 with zero missing, stale, or missing-snapshot rows.

Manual keeper run [`32459740369`](https://github.com/Leokings/liquidity-arena/actions/runs/32459740369)
then passed reconcile job `96704099506` and history job `96704818464`. It VERIFIED RESOLVE
`1787295600`, operation `4d0a94692338f4650a64ed6d44b8ae21eb3ee2c0ec3b0937eb77408cffc55cf9`, transaction
`0x6b2928291db52738ddcceb0500b7790ad46098a09e9c058effdeb9ba9e022bea`, with RESOLVED post-state,
and CREATE `1787389200`, operation
`f55fa63b8e598172435ec284d7eb82e6db2c8aeb6f368188bc6f58452e172252`, transaction
`0x2075252b008d239da9bee85ff7186b0548da20570db8d319a0ed1ce1d4f25d73`, with OPEN post-state.
History synchronized 3/3 at `2026-08-21T07:45:20.943Z`. Neon now reads 64/64 VERIFIED with zero
unresolved; public history-health is HTTP 200 with 32/32 terminal/resolve operations and zero timeout,
missing, stale, or missing-snapshot rows. Manual watchdog `32459656268`/job `96703858691` and
automatic `workflow_run` `32460047757`/job `96704995526` both pass. Synthetic run `32461072315`
then passed all production checks, injected failure, and opened issue #17 at
`2026-08-21T07:59:29Z`. Recovery run `32461245006`/job `96708451794` succeeded from
`08:01:23Z`–`08:01:39Z`, closed the issue at `08:01:35Z`, and posted the automated recovery comment.
GitHub-native delivery and recovery are proven. An independent third-party pager remains optional
and is not configured.

The dedicated keeper then created two additional exact-hour epochs locally. Epoch `1787256000` used
transaction `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4`; epoch `1787259600` used
`0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`. Both transactions finalized
and both exact epoch post-states were verified OPEN. These actions prove the dedicated account's
limited keeper role, but are not default-branch scheduled-run evidence.

The keeper privilege is limited to fixed-terms epoch creation. It cannot choose fees or stake limits.
Resolution and timeout are public contract methods, so any account may submit them after the
immutable gates.

## Verification state

Completed:

- finalized deployment with majority agreement and successful execution;
- recorded source hash and live config/catalog/role read-back;
- GenVM lint with 29 schema methods;
- V7 direct tests 22/22;
- combined V6/V7 direct tests 37/37;
- dated checkpoint of at least 36 created epochs read back: one canary, an initial 24-target full-day schedule, two
  finalized local dedicated-keeper creates, and nine workflow-created epochs with verified OPEN
  post-state;
- fail-closed V7 keeper profile checks and pre-write signer recheck;
- V6 drain tooling and a read-only claim-delivery monitor with explicit V6/V7 profiles;
- dual V7/V6 browser-deployment registry implementation;
- completed funded V7 canary settlement, claim delivery, rejection, conservation, and fee withdrawal;
- finalized dedicated-keeper rotation, exact `get_config` role read-back, and matching GitHub
  environment secret names/repository address variable;
- scheduled V7 reconciliation run `32298454771`, later successful no-action reconcile/history run
  `32299468899`, later verified no-action reconcile/history run `32300282482`, failed lookup run
  `32312864108` whose two exact actions later finalized/applied, and historical successful V6 drain
  run `32297047031`;
- Neon production migration application, six-table/four-index schema read-back, and initial bounded
  V7/V6 E19 snapshot synchronization/read-back;
- StudioNet consensus/leader receipt verification fix
  `e5627ebd270a7c6d5291151795b0af6442eba0a6`, successful CI run `32308815377`, and successful
  quota-spaced proof-backfill run `32309637237` with 11 accepted and zero rejected proof requests;
- public proof read-back with finalized deployment proof and exactly nine V7 E19 epoch proofs: one
  creation, four wagers, one resolution, and three credited claims with one child each;
- seven-attempt/315-second same-hash keeper receipt propagation grace merged on main and CI-tested.
- Neon keeper-journal migration 002 applied/read back with final checksum
  `d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`, four tables plus trigger,
  and zero production operations.
- Neon keeper-journal migration 003 `keeper_transaction_journal_attempts` applied/read back as
  migration `14160d53-a2a3-43ab-a762-6bb7e54a95e8`, checksum
  `9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70`, with exact versions 1/2/3,
  zero operations at migration read-back, four attempt columns, the `QUARANTINED` unresolved index,
  and parent-freeze trigger;
- matching journal API authenticated health passed with `ready=true`, `schemaVersion=3`, and manual
  action-bearing run `32325583494` verified six operations across one same-hash recovery and five new
  writes; dependent history job `96297112208` passed;
- V7 schedule restoration merged in PR #11 at
  `81850e3c814cd541d392fdeecf4dacca753d25e6`; workflow `338089019` is active;
- first restored scheduled run `32329108358` passed both jobs, verified one resolve and one create,
  and left the production journal at 8/8 VERIFIED with zero unresolved.
- second action-bearing scheduled run `32332196428` passed both jobs, verified one resolve and one
  create, and left the production journal at 10/10 VERIFIED with zero unresolved;
- 24-hour checkpoint passed 25/25 delivered scheduled records, 50/50 jobs, and 52/52 VERIFIED actions,
  ending at 62/62 VERIFIED and zero unresolved before maintenance;
- PR #15 post-soak hardening, three serialized repair runs, one verified manual keeper/history run,
  and history integrity 32/32 with zero gaps;
- GitHub-native watchdog healthy, synthetic issue-open, recovery-comment, and issue-close paths passed.

Pending:

- GitHub schedule-delivery monitoring after only 25/52 nominal slots emitted run records; an
  independent third-party pager outside GitHub remains optional;
- live 24-hour timeout-refund proof;
- database outage-recovery verification and transaction-proof coverage beyond the selected V7
  deployment/canary/fee evidence;
- continued public browser/wallet soak and rollback rehearsal without re-enabling V6 writes;
- independent security and provider/legal review.

The deploy finalized in about 36 seconds. Earlier successful StudioNet operations were also observed
in the tens-of-seconds range, but no observation is a finality bound or SLA. The application waits for
actual `FINALIZED` status and the exact EOA child when value is delivered.

## Funded canary evidence

A V7 canary epoch was created for `1787166000`. Four 0.1 GEN wagers finalized and each post-state
was verified:

- account `0x797d…d655`: HIGH BTC
  `0x58f6907284ad6616ec9a4b030954ddcf257fd4bf99089be20245c46c53dbc4fa` and LOW XRP
  `0xa6284710314653508ab987b585892d134e3efbf96d78cd235b07e56dc8ce5831`;
- account `0x87e9…a9f2`: HIGH ETH
  `0xc0d5401c97f87ef63a11adbb4a6db41d3f02ee2e927082847216eab48d142a19` and LOW BNB
  `0x80c1d3064ff30a1b070fbadd56598191873d881df02843d88a6dc000c3917e9c`.

The pre-resolution balances were 0.700 GEN for account A, 0.648 GEN for account B, and 0.400 GEN in
the contract. Resolution
`0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66` finalized successfully with
four qualified venues—Binance, OKX, Gate, and KuCoin—and digest
`24737b82b161c1bb05e6ceccf47c848b4a13078eccad7f810a54baa0f7fc31cf`. HIGH selected SOL at
`4394531` ppb with `REFUND_UNBACKED_WINNER`; LOW selected BNB at `170154` ppb with `PARIMUTUEL`.

Three participant payments were proven through exact finalized parent/EOA-child pairs:

- account A HIGH refund, 0.100 GEN: parent
  `0x83a7a0069c2996d74e2277c652df05583225ef2a6af8e7f6c3672abb3682b2f5`, child
  `0x334b4a1b288a8c88dd0e7de3df6eddee28fbaaffbd3733994aef5c028a5f434e`;
- account B HIGH refund, 0.100 GEN: parent
  `0x53adf85d1ad4b531807bc309744d72fe834d3500908c27c33e19c69aa68708e5`, child
  `0x0899c738a7726c98051252c3fab96fd96debf4b279d69e1e5a8b3a8c9adffe3c`;
- account B LOW payout, 0.198 GEN: parent
  `0xf8a3197cfb168a9019b9a9ac0499a253a92c7e1e58762982b92caf27ca3c6031`, child
  `0x7cfe12e50ab3f8636bd89d361d361012691fd0cc745c3468b1e01b6e6576c886`.

Account A's ineligible LOW XRP claim
`0xb0d9889a29247ed2754975eea299dfdd5427bd66a2e1311f1e303fd7b5cbe688` finalized with the expected
failed execution and no state change. After the successful claims, account A held 0.800 GEN,
account B held 0.946 GEN, the contract held 0.002 GEN, player liability was zero, and accrued fees
were 0.002 GEN.

Fee-withdrawal parent
`0x3df8d942bd9c5d699ee0d7816761ec5fd6264108d3a3e8bf3486c2c4f4fbb01f` and child
`0x566082ceef10482356f7aeac310098b7ece8f9c0a7e054eb1db718623602470e` delivered the exact 0.002 GEN
fee to account A/treasury. Final balances were 0.802 GEN for account A/treasury, 0.946 GEN for
account B, and zero for the contract; liability and accrued fees were zero, and withdrawn fees were
0.002 GEN. The total 1.748 GEN was conserved before resolution, after claims, and after withdrawal.

Do not substitute the V6 funded proof. V6 evidence validates the predecessor's normal payout and
unbacked-winner refund paths only.

## Legacy V6

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` remains a public legacy recovery surface while V7 is
active. The app disables V6 new wagers and creation while retaining old reads, resolves/timeouts, and
claims. Its due epochs `1787155200` and
`1787158800` were resolved on 2026-08-19 by
`0xae0ce45340fdeaf1c40c41cf12f10bc2dc42319a03aed0c5a706cd5a3ade1480` and
`0x09f01c2afb065a5ae27df1b791215a421fb2592d1eb65c85988c20072cc0e735`. A later permissionless drain
resolved epoch `1787162400` with `0x03f2ac803896b84fdfadbc4329ea4a085851d0559f0c3213c8eca4be659e0399`
and epoch `1787166000` with `0x7e8030f0975d86479a01a398b88d10b2606c466eec78046fc84eca18c55d27bb`.
Supported public app and automation paths expose no new V6 epoch or wager action; historical
resolve, timeout, and claim paths remain. The deployed V6 owner creation capability still exists and
must not be used. A later live audit found all five V6 epochs RESOLVED/DETERMINED and player
liability zero. Its recurring drain is retired; live workflow `338089016` is `disabled_manually`,
and main retains only `workflow_dispatch` for that legacy drain.

At V7 cutover:

- all new wagers must target V7;
- V6 epochs, positions, claims, and eligible timeouts must remain discoverable;
- no arbitrary address may be introduced through the URL;
- readiness must report legacy liability separately and never turn an unreadable value into zero;
- rollback must restore browser availability without re-enabling V6 creation.

## Durable history

The Neon production migration was applied through the approved temporary-branch workflow with
normalized marked-DDL SHA-256 `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
(raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`); six expected tables and
four expected indexes were read back. Workflow run `32299468899`, history job `96218806119`, then
synchronized two deployments, two epochs, and two snapshots from state read at
`2026-08-19T20:38:39.397Z`. Public history returns full resolved/determined V7 and V6 snapshots for
E19 (`1787166000`). Later run `32300282482`, reconcile job `96221017562` and history job
`96221327115`, also succeeded from state read at `2026-08-19T20:47:19.912Z`; public history added
resolved/determined V7 E20 without duplicating overlapping V6 E19. Those recurring runs projected
state and intentionally reported zero new proofs.

Manual journal canary run `32325583494` later passed history job `96297112208`. Its state read at
`2026-08-20T02:49:02.975Z` synchronized two deployments, two epochs, and two snapshots with zero new
or rejected proof requests. Restored scheduled run `32329108358` then passed history job
`96306791996`; at `2026-08-20T03:45:10.146Z` it synchronized two deployments, two epochs, and two
snapshots with zero new or rejected proofs and `replayed=false`.
Second scheduled run `32332196428` passed history job `96315355338`; at
`2026-08-20T04:34:56.951Z` it again synchronized two deployments, two epochs, and two snapshots with
zero proof failures/rejections and `replayed=false`.

Post-soak projection repair is separately recorded in runs `32458718433`, `32459026957`, and
`32459340292`. They synchronized seven V7 epochs/snapshots in batches of 3/3, 2/2, and 2/2 with no
proof failures/rejections. The integrity diagnostic changed from 31 VERIFIED terminal operations,
three missing durable epochs, one stale epoch, and zero missing snapshots to 31/31 with no gaps.
Manual keeper run `32459740369` then projected 3/3 at `2026-08-21T07:45:20.943Z`; current integrity
is 32/32 terminal/resolve operations with zero timeout, missing, stale, or missing-snapshot rows.

Merged fix `e5627ebd270a7c6d5291151795b0af6442eba0a6` reuses the audited fail-closed StudioNet
consensus/leader receipt validator for history proof verification. Protected manual workflow
`32309637237`, job `96249796253`, then passed all three quota-spaced batches: 6 deployment/create/
wager proofs, 3 resolution/claim proofs, and 2 final-claim/fee proofs, with zero rejected requests.
The 11 accepted database records comprise one deployment proof, nine E19 epoch proofs, and one
fee-withdrawal parent. Public read-back shows the deployment transaction finalized and V7 E19 with
exactly nine finalized proofs: `CREATE_EPOCH=1`, `WAGER=4`, `RESOLVE_EPOCH=1`, and `CLAIM=3`; all
three claims are credited and carry one child hash. V7 E20 and V6 E19 each remain at zero verified
epoch proofs because they were outside this selected backfill. The fee-withdrawal parent
`0x3df8d942bd9c5d699ee0d7816761ec5fd6264108d3a3e8bf3486c2c4f4fbb01f` is intentionally epochless
and therefore absent from E19's array; its exact finalized child is separately proven by the
fee-delivery monitor. Outage recovery remains pending. This off-chain cache is keyed to allowlisted
chain/contract/epoch state and cannot choose winners or make claims eligible.

The keeper journal is separate from that history projection. Migration 002 was prepared as
`1e440327-2e66-403d-934d-c302790ac775` on temporary branch `br-sweet-frost-auakkl85`, applied
identically to production branch `br-calm-fire-aup0rw0r`, and the temporary branch was deleted. Its
final checksum is `d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`;
production read-back preserved v1, found four journal tables plus the trigger, and reported zero
operations at migration time. Runtime authority requires a fenced global signer lease, PREPARE before broadcast,
exact captured-hash binding, recovery before planning, and fail-closed blocking. Raw status is
liveness only; full exact receipt identity, successful execution, and matching post-state are
required before VERIFIED. Artifacts and caches are never journal authority. Migration 003
`keeper_transaction_journal_attempts` is applied to project
`steep-hat-04600004`, parent branch `br-calm-fire-aup0rw0r`, as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through deleted temporary branch
`br-polished-shape-aund54y0`. Final checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70` read back with exact schema
versions 1/2/3, zero operations at migration read-back, all four attempt columns, the unresolved
unique index covering `QUARANTINED`, and the parent-freeze trigger. The matching API is now deployed;
authenticated health returned `ready=true`, `schemaVersion=3`, and run `32325583494` acquired the
journal boundary, recovered one previously bound hash without resubmission, and left six exact
operations VERIFIED. V7 workflow `338089019` is active after PR #11 restored its schedule, while V6
workflow `338089016` remains disabled.

## Public cutover record

The production alias [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app) targets V7
while retaining V6 legacy recovery. The last fully enumerated pre-journal production artifact was:

- Vercel source anchor: merged receipt-proof commit
  `e5627ebd270a7c6d5291151795b0af6442eba0a6`; metadata also records `gitDirty=1`, so this is an
  anchor rather than a byte-identical source claim;
- CI run: `32308815377`, with browser/operator job `96247333491` and intelligent-contracts job
  `96247333299` both successful;
- deployment: `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi`, production target, status READY;
- immutable URL:
  [liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app](https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app);
- browser bundle: `market-BHlwjm1W.js`, SHA-256
  `c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`;
- `/healthz`, `/readyz`, and `/api/history-health`: `200`;
- readiness: exact V7 contract/roles/policy, two covered future epochs, five feeds, and readable V6
  with zero known player liability.

The previous V6 artifact `dpl_DQEvnGup417wvTxuxzeNfJvySiM5` remains a READY rollback reference. Any
rollback must preserve V6 new-write disabling. Continue browser/wallet soak, outage tests, external
review, and broader proof coverage. The proof view from
[PR #6](https://github.com/Leokings/liquidity-arena/pull/6) is merged and deployed on the production
alias. The historical production artifact that executed first restored scheduled run `32329108358`
was READY Vercel deployment `dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ` at
[liquidity-arena-dz2a8196a-leokings588-5902s-projects.vercel.app](https://liquidity-arena-dz2a8196a-leokings588-5902s-projects.vercel.app),
GitHub deployment `5994871034`, source `81850e3c814cd541d392fdeecf4dacca753d25e6`.
Bundle `/assets/market-BQWvq82y.js` is 188376 bytes with SHA-256
`37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

The historical stream-hardened runtime is READY Vercel deployment
`dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
[liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app](https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app),
GitHub deployment `5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI run
`32332498286` passed jobs `96315684498` and `96315684590`. Bundle `/assets/market-DTvIR-Xr.js` is
191538 bytes with SHA-256 `7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`.
It shares one ref-counted EventSource per URL/tab, uses Vercel `supportsCancellation=true` and
disconnect cleanup, holds steady Studio calls near 240/hour, and retains the cap of four concurrent streams per IP.
Browser trace proved one HTTP-200 SSE request for ROUND→4H, one per rapid reload across two reloads,
LIVE/FRESH without STALE/errors, and an immediate independent HTTP-200 five-asset stream. Public
health/readiness/history-health/proof endpoints returned HTTP 200; readiness matched chain `0xf22f`,
exact V7/keeper/coverage, and zero V6 liability.

The initial post-soak production artifact was READY Vercel deployment
`dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
[liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app](https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app),
GitHub deployment `6017361124`, source/merge `abef30d7268b34331528c470cc2a06eefe50ba33`. CI run
`32458652480` passed jobs `96700917346` and `96700917084`. Bundle `/assets/market-B8kYJwYW.js` is
191540 bytes with ETag `W/"aed8cd3722fd07b7762e4331cd94d235"` and SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public health, readiness,
history-health, and proof surfaces return HTTP 200. Active V7 player liability is 2 GEN across two
eligible unclaimed refunds; it is reported as an outstanding participant obligation and does not
block readiness.

The last runtime-changing production artifact and synthetic-watchdog evidence checkpoint was the
READY/PROMOTED Vercel deployment
`dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
[liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app](https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app),
GitHub deployment `6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI
`32461039766` passed jobs `96707863823` (393/393, build 477, audit 0) and `96707864002` (lint plus 37
direct tests). Bundle `/assets/market-BoHfo81C.js` is 193040 bytes with ETag
`"fa10949a324593024ea6c209eb3a0cc3"` and SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint does not assert that the public alias still targets it; later documentation-only
publication deployments may supersede the alias without changing the recorded runtime guarantees.
