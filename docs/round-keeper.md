# StudioNet V7 keeper and V6 drain runbook

## Purpose

The V7 reconciler is a bounded one-shot process. It validates the live contract, derives a full day
of exact-hour targets, scans the on-chain open index, plans missing creates and due permissionless
resolve/timeout actions, optionally submits serialized writes, verifies them, and exits. It is dry-run
by default and does not need an open browser.

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
unlocked. Before each submitted action the script re-reads the active account and rejects a signer
that no longer matches `V7_KEEPER_ADDRESS`.

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
not a successful default-branch scheduled run.

## Reconciliation algorithm

Every invocation:

1. requires StudioNet and the exact V7 address;
2. validates protocol, policy, owner, keeper, treasury, fee, stake limits, timing, precision, assets,
   venues, and resolution rules;
3. reads the bounded open-epoch index in pages of at most 50;
4. derives 24 exact-hour targets with sufficient creation lead;
5. plans missing `CREATE` actions;
6. plans `RESOLVE` for open epochs after `E+120s` and before `E+24h`;
7. plans `TIMEOUT` after `E+24h`;
8. caps and serializes writes;
9. rechecks signer identity immediately before every write;
10. captures each hash immediately and requires exact recipient/method/arguments, `FINALIZED`,
    successful execution, and matching post-state.

Terminal epochs leave the open index, so the normal run does not repeatedly scan all historical
epochs. Contract guards and exact post-state checks make repeat invocations fail safely.

If fewer than three complete venue baskets are available, resolution should remain retryable/open.
A later run or any other caller may try again. Only the immutable timeout enables the deterministic
zero-fee fallback for an epoch that remains open.

## GitHub Actions

`.github/workflows/studionet-v7-keeper.yml` is scheduled at minute 3 and minute 13 of every hour. The
second run is a watchdog; GitHub schedules are best-effort and do not define contract time. Workflow
writer concurrency prevents the V6 and V7 signer jobs from overlapping, and all action revisions are
pinned. The separate read/project history job intentionally uses its own concurrency group.

Environment: `studionet-keeper`

Repository environment variables:

```text
V7_CONTRACT_ADDRESS
V7_OWNER_ADDRESS
V7_KEEPER_ADDRESS
V7_TREASURY_ADDRESS
V6_CONTRACT_ADDRESS
HISTORY_SYNC_URL (optional projection job)
```

Encrypted environment secrets:

```text
V7_KEEPER_KEYSTORE_B64
V7_KEEPER_KEYSTORE_PASSWORD
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
history failure after reconciliation has already completed. Database availability or an ingest
credential can therefore never prevent epoch creation, resolution, or timeout recovery.

Scheduled V7 run `32298454771` proved default-branch activation and reconciliation; its separate
history job failed on the StudioNet provider quota. That projection incident did not invalidate the
successful reconcile and was superseded by workflow-dispatch run `32299468899`: reconcile job
`96218469576` passed exact profile/runtime-signer preflight with no actions required, and history job
`96218806119` completed the bounded sync. Activation is proven; long-run scheduling/alert monitoring
remains a release obligation. Final observed workflow-dispatch run `32300282482` on code commit
`45be825084cce9e97579ca42266e318e2e97fe17` also passed reconcile job `96221017562` and history job
`96221327115`.

## Monitoring and recovery

- A known transaction hash is the recovery key. Inspect that exact hash and post-state before
  considering another action.
- Never treat `ACCEPTED` as complete; wait for `FINALIZED` and successful execution.
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

`.github/workflows/studionet-v6-keeper.yml` runs this bounded drain every five minutes and shares
the exact `studionet-liquidity-arena-writer` concurrency group with the V7 reconciler, so the common
keeper signer cannot race its nonce across workflows. Retire the V6 workflow only after every V6
epoch is terminal, player liability is zero, and all legacy claims/timeouts remain independently
discoverable and callable.

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
- Workflow concurrency is repository-scoped, not a distributed cross-provider lease.
- External alert delivery and long-run soak evidence remain release work.
- The Neon production schema and repeated V7/V6 snapshot ingestion are complete. Public rows cover
  V7 E20/E19 and V6 E19 without a duplicate overlapping V6 row. Outage evidence remains pending,
  and empty public `verifiedProofs` arrays mean transaction-proof backfill is not yet established.
  The projection improves discovery but does not replace on-chain reconciliation.
