# StudioNet V7 keeper and V6 drain runbook

## Purpose

The V7 reconciler is a bounded one-shot process. It validates the live contract, derives a full day
of exact-hour targets, scans the on-chain open index, plans missing creates and due permissionless
resolve/timeout actions, optionally submits serialized writes, verifies them, and exits. It is dry-run
by default and does not need an open browser.

Execution additionally requires the authoritative Neon keeper journal. The database is the durable
operation/hash authority; local files, workflow artifacts, and caches are not recovery authority.

The keeper's only privileged contract method is `create_epoch(E)`. Resolution and timeout are public
methods available to every account after their gates. The owner key must never be used as the routine
workflow signer.

## V7 configuration

- network: `studionet`, chain `61999`;
- protocol: `LIQUIDITY_ARENA_V7`;
- policy: `CRYPTO_SPOT_1M_MEDIAN_V1`;
- contract: `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`;
- coverage: 24 exact UTC hourly targets, beginning at least two hours ahead;
- keeper creation horizon: maximum 26 hours;
- contract creation notice: minimum one hour;
- stake limits: fixed 0.1–10 faucet test GEN per wallet/objective;
- resolution: permissionless from `E+120s` until `E+24h`;
- timeout refund: permissionless from `E+24h` while still open.

The checked-in example configuration reads addresses from environment variables and validates the
complete live profile. Do not replace it with a config that omits role checks.

## Local dry run

```powershell
$env:V7_CONTRACT_ADDRESS='0xb2ae59aE641f571726Ae81E30080f8c2192b15EF'
$env:V7_OWNER_ADDRESS='<expected owner address>'
$env:V7_KEEPER_ADDRESS='0x12ba664a1ec9ca78b070d103c6a69e20673f4b51'
$env:V7_TREASURY_ADDRESS='<expected treasury address>'
node scripts/v7-keeper.mjs --config scripts/examples/v7-keeper.example.json
```

Execution adds `--execute` and requires the configured dedicated keeper account to be selected and
unlocked, plus `KEEPER_JOURNAL_URL` and the separate `KEEPER_JOURNAL_SECRET`. Before each submitted
action the script re-reads the active account and rejects a signer that no longer matches
`V7_KEEPER_ADDRESS`. Before lease acquisition it also requires authenticated journal health with
`ready=true` and `schemaVersion=3`. If Neon is unavailable or stale before PREPARE, execution
performs zero writes.

```powershell
node scripts/v7-keeper.mjs --config scripts/examples/v7-keeper.example.json --execute
```

The dedicated keeper prerequisite is complete: the encrypted keeper is installed, owner rotation is
finalized, and `get_config` records the exact address above. Execution must still fail closed unless
the locally selected or workflow-imported signer matches that address.

## Dedicated keeper bootstrap and rotation

Run the bootstrap only with PowerShell 7 (`pwsh.exe`), not Windows PowerShell 5.1. The script asks
for a hidden password of at least 16 characters twice, creates a non-owner account, exports only an
encrypted keystore into a new randomly named temporary directory, uploads the keystore/password as
`studionet-keeper` **environment** secrets, records the public address as repository variable
`V7_KEEPER_ADDRESS`, and deletes the temporary export.

GenLayer CLI 0.39.2 has no noninteractive stdin alternative for these account passwords, so its
create/export/import/unlock commands place the password briefly in the process argument list. Run
bootstrap only on a trusted single-user machine and the workflow only on an isolated ephemeral
GitHub-hosted runner; keep tracing/debug output off, never echo commands, and treat process-list
access during those short operations as secret access.

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-v7-keeper.ps1
```

If the script fails after creating the local account, do not overwrite, print, or delete key
material impulsively. Inspect `genlayer account list` and the environment secret names first. Resume
the export/upload steps for that exact account, or rerun with a new explicit account name only after
confirming the first attempt did not upload a usable secret:

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-v7-keeper.ps1 `
  -AccountName 'liquidity-arena-v7-keeper-2'
```

After bootstrap, the owner performs the one-time on-chain rotation. Capture the submitted hash,
require `FINALIZED` plus successful execution, verify exact recipient/method/argument identity, and
read `get_config` back before enabling schedules:

```powershell
.\node_modules\.bin\genlayer.cmd network set studionet
.\node_modules\.bin\genlayer.cmd network info
.\node_modules\.bin\genlayer.cmd account use <LOCAL_OWNER_ACCOUNT_NAME>
.\node_modules\.bin\genlayer.cmd account show
.\node_modules\.bin\genlayer.cmd write 0xb2ae59aE641f571726Ae81E30080f8c2192b15EF `
  set_keeper --args <V7_KEEPER_ADDRESS>
.\node_modules\.bin\genlayer.cmd receipt <ROTATION_TX_HASH> --status FINALIZED `
  --retries 180 --interval 5000
.\node_modules\.bin\genlayer.cmd call 0xb2ae59aE641f571726Ae81E30080f8c2192b15EF get_config
```

Never upload the owner or treasury keystore to GitHub. Record only the dedicated keeper's public
address and the finalized rotation transaction in release evidence.

### Recorded rotation

- previous bootstrap keeper: `0x87e94edab4418e8a9ea37c0fab0675cf0602a9f2`;
- dedicated keeper: `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`;
- owner `set_keeper` transaction:
  `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`;
- result: `FINALIZED`, `MAJORITY_AGREE`, successful leader execution;
- exact `get_config` keeper read-back: passed;
- GitHub environment `studionet-keeper`: secret names `V7_KEEPER_KEYSTORE_B64` and
  `V7_KEEPER_KEYSTORE_PASSWORD` present;
- repository variable `V7_KEEPER_ADDRESS`: matches the dedicated keeper.
- local limited-role proof: epoch `1787256000`, transaction
  `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4`, `FINALIZED`, verified OPEN;
- local limited-role proof: epoch `1787259600`, transaction
  `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`, `FINALIZED`, verified OPEN.

This proves rotation, configuration identity, and local use of the intended limited on-chain role,
not by itself a successful default-branch run. Authoritative default-branch journal execution is
recorded separately below.

## Reconciliation algorithm

Every invocation:

1. requires StudioNet and the exact V7 address;
2. validates protocol, policy, owner, keeper, treasury, fee, stake limits, timing, precision, assets,
   venues, and resolution rules;
3. requires authenticated journal health on schema version 3, acquires the fenced global signer
   lease, and recovers every nonterminal journal operation before any chain plan;
4. stops all writes if recovery is unknown, pending, ambiguous, or otherwise unverified;
5. reads the bounded open-epoch index in pages of at most 50 and derives 24 exact-hour targets;
6. plans work in safety order: eligible `TIMEOUT`, due `RESOLVE`, then missing `CREATE`;
7. caps and serializes writes and rechecks signer identity before every write;
8. commits the exact canonical operation as `PREPARED` before broadcast;
9. captures and remotely binds the exact transaction hash before the write wrapper may exit;
10. permits a retry after an exact receipt-verified `FINALIZED_FAILURE` only by appending a new
    deterministic numbered attempt, without clearing or overwriting the previous hash;
11. uses raw lifecycle status only for liveness, then requires the full exact
    hash/recipient/method/arguments, successful `FINALIZED` execution, and matching post-state before
    VERIFIED.

Terminal epochs leave the open index, so the normal run does not repeatedly scan all historical
epochs. Contract guards and exact post-state checks make repeat invocations fail safely.

If fewer than three complete venue baskets are available, resolution should remain retryable/open.
A later run or any other caller may try again. Only the immutable timeout enables the deterministic
zero-fee fallback for an epoch that remains open.

## GitHub Actions

GitHub workflow `338089019` is active. PR #11 historically restored the minute-3/minute-13 schedule in
`.github/workflows/studionet-v7-keeper.yml` on main commit
`81850e3c814cd541d392fdeecf4dacca753d25e6` after the manual authoritative-journal canary passed.
Restored scheduled run [`32329108358`](https://github.com/Leokings/liquidity-arena/actions/runs/32329108358)
then passed reconcile job `96306191739` and history job `96306791996`. This proves the trigger and
journal path at that checkpoint. Second action-bearing scheduled run
[`32332196428`](https://github.com/Leokings/liquidity-arena/actions/runs/32332196428) passed reconcile
job `96314848434` and history job `96315355338`. The later 24-hour checkpoint is recorded below.
PR #15 merge `abef30d7268b34331528c470cc2a06eefe50ba33` now uses one hourly minute-27 trigger. Keeper,
scheduled projection, manual history repair, and proof backfill writers all share one durable
`queue: max` concurrency group, preventing pending writer replacement. Contract time still defines
every gate, and the Neon fenced lease remains the distributed writer authority. A projection job
must not run after a blocked keeper CLI result.

The independent backup implementation is documented at
[`ops/cloudflare-keeper-scheduler/README.md`](../ops/cloudflare-keeper-scheduler/README.md). It is a
Cron-only Cloudflare Worker: minute 37 checks whether the current UTC hour already has an active or
successful `main` keeper run before conditionally dispatching `studionet-v7-keeper.yml`; minute 57
does the same for `studionet-ops-watchdog.yml`. Use a new fine-grained GitHub token limited to this
repository with Actions read/write, stored only through Wrangler's hidden Cloudflare-secret prompt.
Never provide Cloudflare with the keeper keystore/password, journal secret, Neon URL, owner key, or
treasury key. Production activation requires Worker deployment, exact Cron Trigger readback, one
observed `:37`/`:57` cycle, and downstream workflow/journal/history/issue verification.

Environment: `studionet-keeper`

Repository environment variables:

```text
V7_CONTRACT_ADDRESS
V7_OWNER_ADDRESS
V7_KEEPER_ADDRESS
V7_TREASURY_ADDRESS
V6_CONTRACT_ADDRESS
KEEPER_JOURNAL_URL
  HISTORY_SYNC_URL
```

Encrypted environment secrets:

```text
V7_KEEPER_KEYSTORE_B64
V7_KEEPER_KEYSTORE_PASSWORD
KEEPER_JOURNAL_SECRET
  HISTORY_INGEST_SECRET
```

The keystore is decoded only into the runner's temporary directory, imported without printing its
contents, and removed in an `always()` cleanup step. The workflow must not contain or import an owner
keystore.

At this release checkpoint, `HISTORY_INGEST_SECRET` is installed in the `studionet-keeper`
environment and `HISTORY_SYNC_URL` is a repository variable. The dedicated V7 keeper keystore
secrets `V7_KEEPER_KEYSTORE_B64` and `V7_KEEPER_KEYSTORE_PASSWORD` are installed in that environment,
and public repository variable `V7_KEEPER_ADDRESS` is
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`. Never substitute the owner keystore.

Durable-history ingestion runs in a separate dependent job under the shared writer concurrency
group. Missing history configuration is now a workflow failure, as is a configured sync failure
after reconciliation has already completed. Scheduled projection is V7-only and syncs up to three
eligible epochs per run. History-projection availability never
authorizes or blocks settlement. Keeper-journal availability is intentionally different: an outage
before PREPARE permits zero writes, and an unresolved durable operation blocks later writes. A
blocked keeper CLI result must be nonzero so the dependent history job does not conceal it behind a
green workflow.

Scheduled V7 run `32298454771` proved default-branch activation and reconciliation; its separate
history job failed on the StudioNet provider quota. That projection incident did not invalidate the
successful reconcile and was superseded by workflow-dispatch run `32299468899`: reconcile job
`96218469576` passed exact profile/runtime-signer preflight with no actions required, and history job
`96218806119` completed the bounded sync. Activation is proven; later 24-hour delivery and watchdog
evidence is recorded below. Later verified workflow-dispatch run `32300282482` on code commit
`45be825084cce9e97579ca42266e318e2e97fe17` also passed reconcile job `96221017562` and history job
`96221327115`.

Scheduled action-bearing runs later exposed a StudioNet gateway interval in which a submitted hash
was authoritative but its receipt was not yet indexed. Main commit
`958e51743a821606ca78881e6bcc8fb0a34a8e8f` (PR #5) now performs seven finality lookups against that
same recorded hash, with 5/10/20/40/80/160-second outer delays (315 seconds total), and never
resubmits the write. CI run `32310160397` passed both jobs. The first live scheduled use is now
captured: run `32312864108`, reconcile job `96259232716`, on head `958e517`. It exhausted all seven
lookups for CREATE `0xe6af5cd917427b5f5dadcbb77a56dc5c529a3b844a26008165c0e2c9f8d83574`
and RESOLVE `0x0850dfa1098ce773b20c9407d602592eada74cc36004333dc3ec011930d71c7e`.
Both exact hashes were later observed `FINALIZED`, and epoch `1787274000` was OPEN while
`1787180400` was RESOLVED/DETERMINED. At that historical checkpoint, recorded coverage was at least
31 epochs, four of them workflow-created. The failure was receipt-index visibility beyond 315
seconds, not failed execution.

The replacement safety architecture uses the authoritative Neon journal. Its migration-002
foundation is applied to production branch
`br-calm-fire-aup0rw0r` with checksum
`d2609dfc884eae97d2fed12bf2b582f5a3a3d53de65c719e606d1a53afea6266`.
Production read-back preserved history v1, found four journal tables and the trigger, and contained
zero operations at migration time. Migration 003 `keeper_transaction_journal_attempts` was then applied to project
`steep-hat-04600004`, parent branch `br-calm-fire-aup0rw0r`, as migration
`14160d53-a2a3-43ab-a762-6bb7e54a95e8` through temporary branch
`br-polished-shape-aund54y0`, which was deleted. Checksum
`9af77d57fe7bd9317b8a2723bfc0d74ad48146ff3bb677a0b12c6944eb1dea70` read back with exact versions
1/2/3, zero operations at migration time, four attempt-lineage columns, `QUARANTINED` in the
unresolved unique index, and the parent-freeze trigger. The matching API is now deployed and its
authenticated health returns `ready=true` with `schemaVersion=3` before lease acquisition. Manual
run `32325583494` passed the required action-bearing canary.

### Recorded authoritative-journal canary

Run [`32325583494`](https://github.com/Leokings/liquidity-arena/actions/runs/32325583494) on
`f937b95a108dddd84e4fda3149452a2c22dd8f84` completed reconcile job
[`96296050506`](https://github.com/Leokings/liquidity-arena/actions/runs/32325583494/job/96296050506)
and history job `96297112208` successfully. Reconciliation first recovered the prior run's already
bound `resolve_epoch(1787184000)` hash without submitting a replacement, then submitted five new
writes. All six operations reached VERIFIED:

- RESOLVE `1787184000`, operation `518adcc2…544e`, transaction `0x1e90…02a6` (cross-run recovery);
- RESOLVE `1787187600`, operation `474e8b1a…7db4`, transaction `0xbfb4…80a4`;
- RESOLVE `1787191200`, operation `43de5e0f…9806`, transaction `0xbd09…5211`;
- CREATE `1787277600`, operation `309ede57…0280`, transaction `0xc081…ff8c`;
- CREATE `1787281200`, operation `dbc48bbb…560b`, transaction `0xae3e…061a`;
- CREATE `1787284800`, operation `0712f637…6bb7`, transaction `0x8a81…9ae1`.

Every entry is attempt 1 with exact receipt identity, successful execution, and matching post-state.
The canary proves one recovery plus five new writes, not six new broadcasts. History synchronized two
deployments, two epochs, and two snapshots from `2026-08-20T02:49:02.975Z` with zero rejected proof
requests.

### Recorded first restored scheduled run

Run `32329108358` fired from `schedule` on
`81850e3c814cd541d392fdeecf4dacca753d25e6` and completed successfully. At
`2026-08-20T03:42:20.118Z` it planned exactly RESOLVE `1787194800` followed by CREATE `1787288400`,
with zero deferred reads or actions. Both attempt-1 operations reached VERIFIED:

- RESOLVE operation `b49b8680…6d0b`, transaction `0x1943…9206`, finalized with majority agreement
  and successful exact keeper-to-V7 execution. Post-state was RESOLVED/DETERMINED with digest
  `2f86ecb7…f1d6`, four venues, BTC HIGH `-1190077` ppb and XRP LOW `-5067874` ppb, both
  `REFUND_UNBACKED_WINNER`;
- CREATE operation `90f8867c…bf74`, transaction `0xe9fc…b85a`, finalized with majority agreement
  and successful exact keeper-to-V7 execution. Epoch `1787288400` read back OPEN/SCHEDULED/PENDING
  with the dedicated keeper as creator.

Post-run Neon read-back contained eight operations, all VERIFIED, and zero unresolved. History job
`96306791996` synchronized two deployments, two epochs, and two snapshots at
`2026-08-20T03:45:10.146Z`, with zero new or rejected proofs. Live epoch count was 35, including eight
workflow-created epochs. The historical READY production artifact that executed this run was Vercel
deployment
`dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, source
`81850e3c814cd541d392fdeecf4dacca753d25e6`, bundle `/assets/market-BQWvq82y.js` SHA-256
`37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

### Recorded second action-bearing scheduled run

Run `32332196428` fired from `schedule` on
`2664e739c11ee3f223626a20663bc2564d64ec7a` and completed successfully. At
`2026-08-20T04:32:31.6853794Z` it planned exactly RESOLVE `1787198400` followed by CREATE
`1787292000`, with `nowEpochSeconds=1787200317` and zero deferred reads/actions. Both attempt-1
operations reached VERIFIED:

- RESOLVE operation/logical operation
  `77ea4dec2b4f3e8a5302771eb6a5c0a60736a48e8175201df1956215b2bc964e`, transaction
  `0xebc4478607bbc6ca17d670dafa05d4aca99d8282959db50072fa881af47199dd`, reached FINALIZED with
  MAJORITY_AGREE and successful exact keeper-to-V7 `resolve_epoch(1787198400)` execution. Post-state
  was RESOLVED/DETERMINED at `1787200361`, digest
  `b851d5c3973f192a939c350a924ab3b9d40bbfa5a82af027485917f4b42ed3ad`, venues
  Binance/OKX/Gate/KuCoin, BNB HIGH `3195374` ppb and XRP LOW `530561` ppb, both
  `REFUND_UNBACKED_WINNER`;
- CREATE operation/logical operation
  `8e86c84b1a85eabb6768decf1fc755f3ff0207c6098c667c6bc08070c9ca48f2`, transaction
  `0x3d4b235c91dbefaeffc1f790ed5a4f3466cefb7b452d190aac12eb4c099b8a88`, reached FINALIZED with
  MAJORITY_AGREE and successful exact keeper-to-V7 `create_epoch(1787292000)` execution. Post-state
  was OPEN/SCHEDULED/PENDING with the dedicated keeper as creator, `wagerOpens=1787289600`,
  `wagerCloses=battleStarts=1787290800`, and `resolutionAvailable=1787292120`.

Neon independently recorded the RESOLVE as PREPARED at `2026-08-20T04:32:40.467Z`, SUBMITTED at
`04:32:42.161Z`, FINALIZED at `04:33:36.206Z`, and VERIFIED at `04:33:41.005Z`; the CREATE followed
at `04:33:44.882Z`, `04:33:46.767Z`, `04:34:24.947Z`, and `04:34:29.922Z`. Snapshot read-back at
`2026-08-20T04:40:05.109Z` contained 10 operations, all VERIFIED, and zero unresolved. History job
`96315355338` synchronized two deployments, two epochs, and two snapshots at
`2026-08-20T04:34:56.951Z`, with zero proof failures/rejections and `replayed=false`. Evidenced live
coverage is now at least 36 epochs, including nine workflow-created epochs. This is a second
action-bearing scheduled cycle and a dated checkpoint.

### Recorded 24-hour checkpoint, repair, and manual verification

At the approximately `2026-08-21T06:50Z` cutoff, 25/25 delivered scheduled runs, all 50 jobs, and all
52 actions passed. The actions were 26 resolves plus 26 creates, every one VERIFIED; Neon read back
62/62 VERIFIED with zero unresolved. The old two-trigger schedule had 52 nominal slots but only 25
GitHub run records (48.08%), with a longest `01:39:05` gap. Catch-up run `32439590155` verified four
actions through the same journal boundary.

After PR #15, repair workflow runs must be dispatched sequentially and allowed to finish before the
next batch:

1. run `32458718433`, job `96701115201`: start offset 1, maximum 3, synced 3 epochs/3 snapshots;
2. run `32459026957`, job `96702015382`: start offset 4, maximum 2, synced 2/2;
3. run `32459340292`, job `96702933162`: start offset 29, maximum 2, synced 2/2.

All three completed with no proof failures or rejected requests. The history-integrity result moved
from 31 terminal journal operations with three missing and one stale durable epoch to 31/31 with
zero missing, stale, or missing-snapshot rows.

Manual keeper run `32459740369` then passed reconcile job `96704099506` and history job
`96704818464`. It VERIFIED RESOLVE `1787295600` operation
`4d0a94692338f4650a64ed6d44b8ae21eb3ee2c0ec3b0937eb77408cffc55cf9`, transaction
`0x6b2928291db52738ddcceb0500b7790ad46098a09e9c058effdeb9ba9e022bea`, and CREATE `1787389200`
operation `f55fa63b8e598172435ec284d7eb82e6db2c8aeb6f368188bc6f58452e172252`, transaction
`0x2075252b008d239da9bee85ff7186b0548da20570db8d319a0ed1ce1d4f25d73`. Exact post-states were
RESOLVED and OPEN. The dependent history job synchronized 3/3 at `2026-08-21T07:45:20.943Z`.
Current read-back is 64/64 journal operations VERIFIED, zero unresolved; history-health is HTTP 200
with 32/32 terminal/resolve operations and zero timeout, missing, stale, or missing snapshots.

### Production runtime checkpoints

The historical stream-hardened runtime is READY Vercel deployment `dpl_63B8Hrpd8HyS7CTjitTzEKGKdrWj` at
[its immutable URL](https://liquidity-arena-hvic9e8w8-leokings588-5902s-projects.vercel.app), GitHub
deployment `5995889896`, source `c32727f386f3e3f23d4a3d9a9d1e14a838655ff7`. CI run
`32332498286` passed browser/operator job `96315684498` and intelligent-contracts job
`96315684590`. Bundle `/assets/market-DTvIR-Xr.js` is 191538 bytes with SHA-256
`7056bef680f18a8e98af1b21822f91f3630644b75a639c83398e1b31601f8e00`.

The client shares one ref-counted EventSource per URL/tab, the Vercel function declares
`supportsCancellation=true`, and request/response disconnect cleanup releases reservations
idempotently. Steady Studio calls are about 240/hour; the cap is four concurrent streams per IP and
100 server-wide by default.
Production Network tracing showed exactly one HTTP-200 `/api/binance/stream` request/response across
ROUND→4H with no additional stream, then exactly one HTTP-200 stream for each of two rapid reloads.
The UI remained LIVE/FRESH with no STALE state or browser error. A separate curl immediately after
the stress sequence returned HTTP 200 `text/event-stream` with live BTC/ETH/BNB/SOL/XRP events.
Health, readiness, history-health, and proof view returned HTTP 200; readiness matched chain
`0xf22f`, exact V7/keeper/coverage, and zero V6 liability.

The initial post-soak runtime was READY Vercel deployment `dpl_JBPdit52XBSuc5GgcfCQ4fpg77K6` at
[its immutable URL](https://liquidity-arena-oadqjhtxc-leokings588-5902s-projects.vercel.app), GitHub
deployment `6017361124`, source `abef30d7268b34331528c470cc2a06eefe50ba33`. CI run `32458652480`
passed jobs `96700917346` and `96700917084`. Bundle `/assets/market-B8kYJwYW.js` is 191540 bytes with
ETag `W/"aed8cd3722fd07b7762e4331cd94d235"` and SHA-256
`2dd2d533907116437e6b013abb5e7248fd606efc262988c1f531b3968378c709`. Public surfaces return HTTP
200. Readiness reports 2 GEN of active V7 player liability across two eligible unclaimed refunds;
this positive participant obligation is non-blocking.

The last runtime-changing production artifact and synthetic-watchdog evidence checkpoint was the
READY/PROMOTED Vercel deployment
`dpl_9DpV89rJGbSJYFo3JgMMbemtPv6K` at
[its immutable URL](https://liquidity-arena-g2v4zho35-leokings588-5902s-projects.vercel.app), GitHub
deployment `6017754639`, source `a1c773ae36a882c043c6b167a1324d1d558ac60f`. Main-push CI run
`32461039766` passed jobs `96707863823` (393/393, build 477, audit 0) and `96707864002` (lint plus 37
direct tests). Bundle `/assets/market-BoHfo81C.js` is 193040 bytes, ETag
`"fa10949a324593024ea6c209eb3a0cc3"`, SHA-256
`82ad96f1de5080b13389ee5afa88f78c595bb26c1d920437b7304215dfdcf6aa`.
This immutable checkpoint does not assert that the public alias still targets it; later documentation-only
publication deployments may supersede the alias without changing the recorded runtime guarantees.

## Monitoring and recovery

- A fenced global signer lease is required across V7 and manual V6 recovery.
- Commit an exact canonical operation as `PREPARED` in Neon before broadcast, then bind the captured
  transaction hash immediately; a workflow artifact or cache is never authority.
- Preserve and review `logicalOperationId`, `attemptNumber`, attempt-specific `operationId`,
  `retryOfOperationId`, and the exact bound hash in action-bearing run evidence.
- Recover every nonterminal operation before planning. Unknown, pending, ambiguous, quarantined, or
  otherwise unverified evidence blocks all later writes. Only exact receipt-verified
  `FINALIZED_FAILURE` may append a new numbered attempt; the original attempt/hash is immutable.
- `gen_getTransactionStatus` is a bounded liveness lane only. `FINALIZED` there is not proof; require
  the full exact hash/contract/method/arguments, successful execution, and matching post-state before
  VERIFIED.
- Never submit a second write merely because StudioNet returns `transaction not found`.
- Never treat `ACCEPTED` as complete.
- Epoch creation is idempotently rejected if already present. Resolve/timeout are rejected once the
  epoch is terminal.
- One epoch failure must not move later exact-hour boundaries.
- Alert on missing current/next coverage, role or config drift, repeated venue quorum failure,
  finality delay, scheduler failure, and readiness degradation.
- GitHub-native watchdog manual run `32459656268`/job `96703858691` and automatic `workflow_run`
  `32460047757`/job `96704995526` passed. The watchdog checks readiness, projection integrity,
  authenticated schema-v3 journal health, keeper recency, and trigger conclusion; it opens/closes a
  repository issue on state change.
- Synthetic failure run `32461072315` passed real production checks, injected the alert condition,
  and opened issue #17 at `2026-08-21T07:59:29Z`. Recovery run `32461245006`/job `96708451794`
  rechecked app/history/journal/latest schedule, closed issue #17 at `08:01:35Z`, and posted the
  automated recovery comment. GitHub-native delivery is proven end to end.
- An independent third-party pager remains an optional defense-in-depth enhancement because the
  current watchdog shares GitHub's control plane with the scheduler it observes.
- Claims are participant actions, not keeper actions.

`scripts/claim-delivery-monitor.mjs` is read-only and requires an explicit `--protocol v6` or
`--protocol v7` profile. It verifies an already submitted claim parent and its exact EOA child. It
never retries a claim or transfer, because a delayed original child could make a retry double-pay.
The V7 profile is implemented and tested. Canary epoch `1787166000` proved three finalized exact
claim parent/child deliveries. `scripts/fee-delivery-monitor.mjs` independently proved the 0.002 GEN
fee-withdrawal parent `0x3df8d942…bb01f` and child `0x566082ce…470e`. Both monitors remain read-only;
healthy delivery evidence does not provide a safe retry for an ambiguous failed/delayed child.

## V6 legacy drain

V6 contract `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` retains its deployed owner-only `create_epoch`
capability, but operational policy forbids using it. The V6 drain process:

- scans the full finite V6 index;
- plans only due `RESOLVE` and eligible `TIMEOUT` actions;
- contains no `create_epoch` call;
- verifies every exact receipt and post-state;
- leaves claim handling to participants.

Live GitHub workflow `338089016` is `disabled_manually`, and main
`.github/workflows/studionet-v6-keeper.yml` retains only `workflow_dispatch`. The live audit found
exactly five V6 epochs, all
RESOLVED/DETERMINED, with zero remaining payout/unclaimed winning stake, zero player liability, and
an empty drain plan. Recurring drain execution is therefore retired. If manual recovery is ever
needed after schema-v3 readiness, it shares the authoritative fenced signer lease with V7.
Legacy claims/timeouts remain independently discoverable and callable.

Scheduled V6 drain run `32297047031` completed successfully. It used the limited signer and the
drain-only path; it did not create a V6 epoch.

Due V6 epochs `1787155200` and `1787158800` were resolved on 2026-08-19 by transactions
`0xae0ce453…e1480` and `0x09f01c2a…e735`. An earlier pre-resolution observation left epochs
`1787162400` and `1787166000` OPEN (RESOLVABLE and SCHEDULED respectively). Later drains resolved
them with `0x03f2ac80…0399` and `0x7e8030f0…27bb`. Supported public app/automation paths expose no V6
creation or new-wager action; a direct owner-created OPEN epoch would still accept `enter`, so owner
abstention and monitoring remain required. Keep V6 reads, permissionless resolve/timeouts, and claims
available until its liability is demonstrably zero and all user-facing legacy positions are
discoverable.

## Operational assumptions

- StudioNet and GitHub Actions have no exact availability or finality SLA.
- The hosted RPC budget may change; reads are paged/paced and writes serialized.
- GitHub concurrency is not a distributed lease; the Neon fenced signer lease is the write boundary.
- The 24-hour delivered-run audit is complete, but GitHub emitted only 25 of 52 nominal schedule
  records; minute-27 delivery must continue to be measured.
- The schema-v3 journal/API/action-bearing gate, 64/64 VERIFIED read-back, integrity repair, and
  GitHub-native watchdog delivery/recovery are complete; independent third-party alerting is optional.
- The Neon production schema and repeated V7/V6 snapshot ingestion are complete. Public rows cover
  V7 E20/E19 and V6 E19 without a duplicate overlapping V6 row. Protected run `32309637237` verified
  one deployment proof, nine V7 E19 epoch proofs, and the epochless fee-withdrawal parent with zero
  rejected requests. V7 E20 and V6 E19 remain at zero selected epoch proofs. Outage evidence and
  broader proof coverage remain pending; the projection improves discovery but does not replace
  on-chain reconciliation.
