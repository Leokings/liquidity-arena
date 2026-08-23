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

Journal schema V7 supports epoch and payout subjects, a hard two-slot pipeline, immutable handoff
lineage, same-subject exclusion, and narrowly gated revalidation of a finalized generic
receipt-identity quarantine. An operation is prepared before broadcast and records the exact
method, arguments, signer, contract, transaction identity, attempt, and receipts.
An exact hashless attempt may become `ABANDONED_PREHASH` only after structural proof that the
process never started or an audited Bradbury transaction/nonce scan confirms that no canonical or
pending transaction was observed. The scan does not claim that no network packet was ever sent.
The original attempt remains immutable and any retry is a new attempt.

Audited abandonment is a privileged, non-signing operator action restricted to a hashless
`resolve_epoch` attempt. Its evidence binds the operation, logical operation, target contract,
method, exact arguments, subject, and prepared timestamp. `nonceAtStart` means the keeper signer
transaction count at the block immediately before `scanStartBlock`; the end, latest, and pending
counts must be identical. The sole operator entry point uses the fixed HTTPS Bradbury RPC, checks
chain 4221 and the finalized head before an inclusive scan of at most 513 blocks, verifies the
reference outer `addTransaction` call and `NewTransaction` inner transaction ID, then performs a
credential-free fixed-RPC `get_epoch` read. It refuses journal contact unless the epoch is still
the exact OPEN/PENDING/RESOLVABLE target with both settlement modes PENDING. The persisted
`postStateVerified: true` field remains a trusted operator attestation; the command independently
rechecks that attestation immediately before recording it.

```powershell
npm run keeper:v8:abandon-prehash -- --operation-id <64-hex-operation-id> --evidence-json <audited-evidence.json>
```

Operational order is strict: apply migration 007, deploy the schema-v7 application, wait for
journal health to report version 7, run the audited non-signing recovery, and only then permit the
keeper to create attempt two. The watchdog remains disabled until the controlled retry and
readiness checks pass.

An attempt-two PREPARE response whose parent used audited no-broadcast recovery carries the
immutable audited nonce. After its final lease renewal and immediately before starting the write
process, the keeper re-reads both the Bradbury `latest` and `pending` signer nonces and requires
both to equal that value. A changed or unavailable nonce blocks signing.

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

Migration 004 checksum is `1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910`. Migration 005 (`keeper_receipt_identity_revalidation`) checksum is `a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59`. Migration 006 (`keeper_accepted_handoff`) checksum is `5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf`. Migration 007 (`keeper_prehash_abandonment`) checksum is `4fa4e8103a1b3caa7022cff2ea1b4868ea6128a4f6b359cdb93a8a6320e0a8f3`. Keeper health requires exact migrations 001–007 and rejects any version newer than 7.

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
