# Bradbury V8 keeper runbook

## Purpose

The V8 keeper maintains future epochs and reconciles the GenLayer side of payout delivery. It is not a custody agent and cannot withdraw recipient EVM vaults.

## Fixed identity

- network: `testnet-bradbury`
- keeper journal domain: `bradbury`, chain `4221`
- protocol: `LIQUIDITY_ARENA_V8`
- V8: supplied through `V8_CONTRACT_ADDRESS`
- payout factory: `0xc812709d267372ad7e06807bf0a4d451ed263a30`
- keeper signer: configured `GENLAYER_V8_KEEPER`

Startup fails closed unless live `get_config`, schema, roles, stake limits, factory, reserve accounting, and risk flags match the reviewed configuration.

## Keeper operations

Epoch work creates or resolves only bounded due epochs after exact state reconciliation.
The production schedule runs at minutes 7, 22, 37, and 52 and keeps exactly the next two eligible
UTC-hour epochs populated. GenLayer queues this account's transactions in submission order. The
two-hour horizon therefore bootstraps safely, while each scheduled run signs at most one fresh
transaction.

Payout work scans both a hot newest tail and a durable rotating older backlog. Based on exact V8 and EVM factory state it may submit:

- `retry_prepare_payout(payout_id)`
- `dispatch_payout(payout_id)`
- `retry_payout(payout_id)` for the configured keeper
- `confirm_payout(payout_id)`
- `refresh_payout_withdrawal(payout_id)`

Monotonic successor states satisfy earlier operations during recovery. This prevents another permissionless caller from stranding a finalized keeper transaction by advancing the payout first.

The keeper never calls EVM `withdraw()` and has no recipient key.

## Durable journal

Journal schema V6 supports epoch and payout subjects, a hard two-slot pipeline, immutable handoff
lineage, same-subject exclusion, and narrowly gated revalidation of a finalized generic
receipt-identity quarantine. An operation is prepared before broadcast and records the exact
method, arguments, signer, contract, transaction identity, attempt, and receipts.

Only an exact successful `ACCEPTED` receipt can authorize a handoff. Its hash, recipient/contract,
method, arguments, lifecycle status, and `FINISHED_WITH_RETURN` execution result are durably bound
to the journal row. `ACCEPTED` is reversible during the appeal window and is never treated as
terminal or verified. Before a successor is prepared, the keeper re-reads the predecessor and
revalidates its exact `ACCEPTED` receipt; `UNKNOWN`, an appeal regression, or unavailable evidence
blocks every new signature. Final receipt identity, successful execution, and monotonic post-state
remain the only route to `VERIFIED`.

Recovery rules:

1. Acquire the Bradbury lease.
2. Probe every unresolved row nonblocking before preparing new work.
3. Suppress duplicate logical operations and every operation for an in-flight subject.
4. Never rebroadcast or replace a durably bound transaction hash.
5. Permit one independent successor only when the predecessor has a fresh, exact `ACCEPTED` proof.
6. Refuse a third attention row; slots `0` and `1` are database-enforced.
7. Accept only the exact finalized receipt and monotonic post-state as verification.
8. Quarantine contradictory finalized hashes, arguments, or domain identity.

Scheduled recovery performs a bounded live probe and stops safely on a provider failure; it never
rebroadcasts the recorded operation. A newly submitted transaction may use up to 480 reads at
five-second intervals (about 40 minutes) to reach exact `ACCEPTED` or `FINALIZED`, beneath the
keeper's hard 45-minute run deadline. Before signing any fresh write, the keeper reserves that
budget plus the bounded post-state verification margin. After one fresh signature, every remaining
action is deferred to the next scheduled run.

Migration 004 checksum is `1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910`. Migration 005 (`keeper_receipt_identity_revalidation`) checksum is `a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59`. Migration 006 (`keeper_accepted_handoff`) checksum is `5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf`. Keeper health requires exact migrations 001–006 and rejects any version newer than 6.

## Local dry run

Use the ignored V8 keeper config or explicit environment variables. Dry runs do not load a signer.

```powershell
node scripts/v8-keeper.mjs --config scripts/examples/v8-keeper.example.json --dry-run
node scripts/ops-watchdog.mjs
```

Before any write, verify:

- V8 payouts and new risk have the expected release state;
- owner, keeper, treasury, factory, source/schema, and policy are exact;
- delivery reserve capacity is solvent;
- journal schema and lease are healthy;
- the journal has a free pipeline slot and every predecessor has fresh exact `ACCEPTED` evidence.

## GitHub Actions

Active workflows:

- `.github/workflows/bradbury-v8-keeper.yml`
- `.github/workflows/bradbury-v8-ops-watchdog.yml`

Both jobs hard-gate the exact repository and protected `main` ref before reading secret-bearing configuration. Configure the GitHub environment with the V8 keeper encrypted keystore/password, history ingest secret, app URLs, and public V8 variables.

The Cloudflare backup scheduler dispatches these same workflow names. Its existing Worker name is retained so deployment replaces the former scheduler rather than leaving a parallel legacy worker.

## Incident handling

- Pause new V8 risk first when exposure must stop.
- Preserve the journal and exact transaction hashes.
- Reconcile signed work; do not submit speculative replacements.
- Keep resolution, claims, payout delivery, recipient withdrawals, and refresh available when safe.
- Treat provider lag as an availability event, not permission to duplicate a write.

V6/V7 workflows and keepers are retired and must not be re-enabled.
