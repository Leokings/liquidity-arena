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

GitHub workflow `338089019` is active. PR #11 restored the minute-3/minute-13 schedule in
`.github/workflows/studionet-v7-keeper.yml` on main commit
`81850e3c814cd541d392fdeecf4dacca753d25e6` after the manual authoritative-journal canary passed.
Restored scheduled run [`32329108358`](https://github.com/Leokings/liquidity-arena/actions/runs/32329108358)
then passed reconcile job `96306191739` and history job `96306791996`. This proves the trigger and
journal path at that checkpoint; extended soak remains a monitoring obligation.
Contract time still defines every gate. The separate read/project history job has its own
concurrency group, but it must not run after a blocked keeper CLI result.

Environment: `studionet-keeper`

Repository environment variables:

```text
V7_CONTRACT_ADDRESS
V7_OWNER_ADDRESS
V7_KEEPER_ADDRESS
V7_TREASURY_ADDRESS
V6_CONTRACT_ADDRESS
KEEPER_JOURNAL_URL
HISTORY_SYNC_URL (optional projection job)
```

Encrypted environment secrets:

```text
V7_KEEPER_KEYSTORE_B64
V7_KEEPER_KEYSTORE_PASSWORD
KEEPER_JOURNAL_SECRET
HISTORY_INGEST_SECRET (optional projection job)
```

The keystore is decoded only into the runner's temporary directory, imported without printing its
contents, and removed in an `always()` cleanup step. The workflow must not contain or import an owner
keystore.

At this release checkpoint, `HISTORY_INGEST_SECRET` is installed in the `studionet-keeper`
environment and `HISTORY_SYNC_URL` is a repository variable. The dedicated V7 keeper keystore
secrets `V7_KEEPER_KEYSTORE_B64` and `V7_KEEPER_KEYSTORE_PASSWORD` are installed in that environment,
and public repository variable `V7_KEEPER_ADDRESS` is
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`. Never substitute the owner keystore.

Durable-history ingestion runs in a separate dependent job with its own concurrency group. Missing
history configuration skips only that projection job; a configured sync failure is reported as a
history failure after reconciliation has already completed. History-projection availability never
authorizes or blocks settlement. Keeper-journal availability is intentionally different: an outage
before PREPARE permits zero writes, and an unresolved durable operation blocks later writes. A
blocked keeper CLI result must be nonzero so the dependent history job does not conceal it behind a
green workflow.

Scheduled V7 run `32298454771` proved default-branch activation and reconciliation; its separate
history job failed on the StudioNet provider quota. That projection incident did not invalidate the
successful reconcile and was superseded by workflow-dispatch run `32299468899`: reconcile job
`96218469576` passed exact profile/runtime-signer preflight with no actions required, and history job
`96218806119` completed the bounded sync. Activation is proven; long-run scheduling/alert monitoring
remains a release obligation. Later verified workflow-dispatch run `32300282482` on code commit
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
workflow-created epochs. The READY production artifact that executed this run is Vercel deployment
`dpl_BDKvcX8E2qraEjsUen2b9Lv2gwnJ`, source
`81850e3c814cd541d392fdeecf4dacca753d25e6`, bundle `/assets/market-BQWvq82y.js` SHA-256
`37c3da723120b9d86a3a079e8e099fe86c474eaf152f0c41c6d2b2baf66a83ba`.

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
- External alert delivery and long-run soak evidence remain release work.
- The schema-v3 journal/API/action-bearing gate and first restored scheduled run are complete;
  extended soak and external alert delivery remain pending.
- The Neon production schema and repeated V7/V6 snapshot ingestion are complete. Public rows cover
  V7 E20/E19 and V6 E19 without a duplicate overlapping V6 row. Protected run `32309637237` verified
  one deployment proof, nine V7 E19 epoch proofs, and the epochless fee-withdrawal parent with zero
  rejected requests. V7 E20 and V6 E19 remain at zero selected epoch proofs. Outage evidence and
  broader proof coverage remain pending; the projection improves discovery but does not replace
  on-chain reconciliation.
