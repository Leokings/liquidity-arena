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

Epoch work creates or resolves only bounded due epochs after exact state reconciliation. Missing
planned epochs are coverage-critical and run before settlement or payout writes. A due epoch whose
exact HIGH and LOW objective records prove zero stake, zero participants, and zero accounting is
left OPEN. A durable recent-plus-rotating due-epoch scan rechecks it without allowing a long empty
backlog to starve an older funded round; any nonzero or malformed objective remains eligible for
`resolve_epoch` or timeout handling. This avoids spending finality capacity on empty testnet rounds
without treating the current zero state as permanently terminal.
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

### Consensus gas preflight

Fresh writes reserve 50% gas headroom above the larger of the SDK limit and an
independent estimate of the exact calldata, rounded up. Bradbury estimates can
understate gas consumed by nested consensus calls at inclusion. The padded limit
must still fit the existing 5,000,000 gas ceiling, gas-price and total-cost caps,
and pending signer balance; it is never clipped to make an unsafe request fit.
An exact read-only `eth_call` with the chosen gas limit must succeed before any
signature is made. Reverts, RPC failures, or unexpected return data fail unsigned.
Already signed journal entries retain their original bytes and gas limit.

### Broadcast admission failures

Bradbury can reject `eth_sendRawTransaction` with RPC code `-32005` and
`transaction gas rate limit exceeded: node is at capacity`. This means the
request was throttled before admission; waiting only for a receipt can leave the
exact signed envelope unseen and block all future epoch creation.

For that exact error with a valid `retryAfterMs` hint (1–30,000 milliseconds), the
keeper waits at least the requested delay plus 250 milliseconds and tries at most
ten broadcasts per signed operation within the existing four-minute recovery deadline.
Repeated throttles increase the backoff exponentially from one second to thirty seconds;
a longer valid node hint still takes precedence. Every retry checks the stored hash again,
requires unchanged latest and pending nonces, rechecks the validity window, and
renews the lease and reloads the same signed bytes before sending. A receipt or
known exact transaction suppresses another broadcast. Unknown errors, mismatched
hashes, nonce changes, and exhausted deadlines never authorize this retry path.
No replacement signature is made, and exhausted admission retries still fail.

`V8_KEEPER_FAILED` includes bounded public `pending` and `failures` entries with
the operation ID, outer hash, reason code, and sanitized broadcast rejection.
The watchdog reports which readiness checks failed and the epochs needed for
coverage. Do not clear a `SIGNED` row or create a replacement merely because an
RPC cannot find its hash; reconcile the recorded transaction first.

### State and recovery

Journal schema V10 supports epoch and payout subjects, a hard two-slot pipeline, immutable handoff
lineage, same-subject exclusion, and narrowly gated revalidation of a finalized generic
receipt-identity quarantine. A V10 operation moves `PREPARED -> SIGNED -> SUBMITTED`: the exact
signed Bradbury raw envelope, outer transaction hash, sender nonce, and decoded call evidence are
durable before any broadcast. Only a verified `NewTransaction` outer receipt may bind the inner
GenLayer transaction ID. Generic operation and recovery responses redact the raw bytes; an active
fenced lease may retrieve them only through `LOAD_SIGNED` for exact replay.
An exact hashless attempt may become `ABANDONED_PREHASH` only after structural proof that the
process never started or an audited Bradbury transaction/nonce scan confirms that no canonical or
pending transaction was observed. The scan does not claim that no network packet was ever sent.
The original attempt remains immutable and any retry is a new attempt.

Audited abandonment is a privileged, non-signing operator action restricted to a hashless
`resolve_epoch` or `create_epoch` attempt. Its evidence binds the operation, logical operation, target contract,
method, exact arguments, subject, and prepared timestamp. `nonceAtStart` means the keeper signer
transaction count at the block immediately before `scanStartBlock`; the end, latest, and pending
counts must be identical. The sole operator entry point uses the fixed HTTPS Bradbury RPC, checks
chain 4221 and the finalized head before an inclusive scan of at most 513 blocks, verifies the
reference outer `addTransaction` call and `NewTransaction` inner transaction ID, then performs a
credential-free fixed-RPC `get_epoch` read. It refuses journal contact unless a resolve target is
the exact OPEN/PENDING/RESOLVABLE epoch with both settlement modes PENDING, or a create target
fails with the exact expected `EPOCH_UNKNOWN` contract error. The persisted
`postStateVerified: true` field remains a trusted operator attestation; the command independently
rechecks that attestation immediately before recording it.

```powershell
npm run keeper:v8:abandon-prehash -- --operation-id <64-hex-operation-id> --evidence-json <audited-evidence.json>
```

Operational order is strict: apply migrations 007–010, deploy the schema-v10 application, wait
for journal health to report version 10, run the audited non-signing recovery, and only then permit the
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
4. A `SIGNED` row may replay only its exact stored raw bytes; never sign a replacement or reuse its nonce.
5. Permit one independent successor only when the predecessor has a fresh, exact `ACCEPTED` proof.
6. Refuse a third attention row; slots `0` and `1` are database-enforced.
7. Accept only the exact finalized receipt and monotonic post-state as verification.
8. Quarantine contradictory finalized hashes, arguments, or domain identity.

Scheduled recovery performs a bounded live probe and stops safely on a provider failure. It may
replay an exact `SIGNED` raw envelope by its deterministic outer hash, but cannot construct or sign
a replacement. When the exact canonical outer transaction is present but has no receipt, the run
reports `OUTER_RECEIPT_PENDING`. When its canonical status-1 receipt is above a valid Bradbury
finalized head, the run reports `OUTER_FINALITY_PENDING`. Both outcomes expose only the outer hash
and, for finality lag, the receipt block/hash and finalized-head number. They leave the row
`SIGNED`, keep raw bytes private, perform no journal transition or rebroadcast, and stop all later
writes in that run. The CLI exits successfully only for one of these exact allowlisted outcomes
with zero real failures, so the workflow still performs bounded history synchronization.

After an exact finalized outer receipt is durably bound as `SUBMITTED`, the first successful inner
status read can briefly return `UNKNOWN` while Bradbury indexes the new GenLayer transaction. Only
the same invocation that received the fenced submission-bind acknowledgement may report
`INNER_STATUS_INDEXING_PENDING`. That exact public outcome includes the inner and outer hashes,
canonical receipt block identity, and a positive finalized-head number at or above the receipt
block. If that invocation's first status lookup throws instead of returning a status, it may report
the distinct `INNER_STATUS_LOOKUP_PENDING` outcome with the same exact public proof and without the
exception text. Both outcomes leave the row `SUBMITTED`/`UNKNOWN`, perform no additional lookup
retry, journal mutation, resend, or later write, and allow the CLI to exit successfully so history
synchronization can still run. A rerun that still observes `UNKNOWN` is a hard
`LIFECYCLE_UNKNOWN` blockage, and a rerun whose lookup throws is hard
`LIFECYCLE_STATUS_UNAVAILABLE`; neither generic reason is allowlisted. A crash after the bind loses
the in-memory acknowledgement and is therefore conservative. Malformed returned statuses and every
other nonfinal result remain non-allowlisted.

An unavailable or invalid finalized head, missing or conflicting exact transaction identity,
nonce/hash mismatch, receipt or canonical-block drift, removed/conflicting event, or reorg remains
a nonzero hard failure. A newly submitted inner GenLayer transaction may use up to 480 reads at
five-second intervals (about 40 minutes) to reach exact `ACCEPTED` or `FINALIZED`, beneath the
keeper's hard 45-minute run deadline. Before signing any fresh write, the keeper reserves that
budget plus the bounded post-state verification margin. After one fresh signature, every remaining
action is deferred to the next scheduled run.

Migration 004 checksum is `1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910`. Migration 005 (`keeper_receipt_identity_revalidation`) checksum is `a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59`. Migration 006 (`keeper_accepted_handoff`) checksum is `5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf`. Migration 007 (`keeper_prehash_abandonment`) checksum is `4fa4e8103a1b3caa7022cff2ea1b4868ea6128a4f6b359cdb93a8a6320e0a8f3`. Migration 008 (`keeper_prehash_legacy_constraint_cleanup`) checksum is `030604d61f54ad9f6e388f497723d7eaa7118632866574cff976dd0bd43f680a`. Migration 009 (`keeper_create_prehash_recovery`) checksum is `5be4175a165d872112f97b88323f3ed013b47eb0aca37b17c2e8c6953cde6694`. Migration 010 (`keeper_durable_signed_envelope`) checksum is `4f59d7ba919df88f2bef6c409f2449d6d76da47f25d96e02c7c013fd6c9d6fcf`. Keeper health requires exact migrations 001–010, the named V10 durable-envelope constraints and indexes, and rejects any version newer than 10.

The isolated PostgreSQL regression for migration 008 is
`migrations/regressions/008_keeper_prehash_legacy_constraint_cleanup.sql`. It recreates the exact
legacy named constraint, proves that it rejects hashless `ABANDONED_PREHASH`, drops it, and proves
the same update succeeds before rolling the test transaction back.

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

The Cloudflare backup scheduler checks every quarter hour at minutes 12, 27, 42, and 57,
five minutes after each native keeper slot. A completed success covers only its current quarter
hour; an active run from an earlier slot still suppresses dispatch. This lets a later invocation
reconcile an outer-finality pending result without waiting a full hour when GitHub drops a native
schedule. The watchdog backup remains hourly at minute 57. Both dispatch the same protected-main
workflow names. The existing Worker name is retained so deployment replaces the former scheduler
rather than leaving a parallel legacy worker.

## Incident handling

- Pause new V8 risk first when exposure must stop.
- Preserve the journal and exact transaction hashes.
- Reconcile signed work; do not submit speculative replacements.
- Keep resolution, claims, payout delivery, recipient withdrawals, and refresh available when safe.
- Treat provider lag as an availability event, not permission to duplicate a write.

V6/V7 workflows and keepers are retired and must not be re-enabled.
