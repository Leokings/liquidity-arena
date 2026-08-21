# V8 payout-recovery design

## Status and reason for a new deployment

This document is a design specification, not deployed code. V7 remains the active StudioNet
test-token contract and currently reports 2 GEN of player liability across two eligible unclaimed
refunds. Those refunds remain V7 obligations and must not be copied, marked paid, or retried by an
off-chain operator.

Application-level discovery and routing are a separate concern. Core claim/refund UX from
[PR #21](https://github.com/Leokings/liquidity-arena/pull/21) merged at
`2026-08-21T13:47:56Z` as `5ac2c1fcae0a7fc4b3096e71f8adf65d511aa475` and was production-deployed
through READY/PROMOTED Vercel deployment `dpl_5FdBbP3e76rwgy1EzqyJYofG4Hxx`. Production inspection proved
the exact V7 HIGH epoch-`1787205600` deep link, resolved/on-chain state, visible claim entry, and
enabled reconnect-to-claim action. It did not include a user wallet signature, claim transaction,
or child-transfer proof and therefore does not discharge either refund or mitigate the protocol P1.

The four-file modal focus-containment follow-up was approved by an internal independent Codex diff review and merged in
[PR #26](https://github.com/Leokings/liquidity-arena/pull/26) at `2026-08-21T14:55:40Z` as
`881e74895a31cb3cf82c078f4252110306684f30`. Its settled evidence is 7/7 focused claim,
210/210 market, 434/434 full, and 24/24 Playwright cases (12 journeys across
`chromium`/`mobile-chromium`, Desktop Chrome/Pixel 7, one worker), plus a 477-module build and audit
0. Successful GitHub deployment `6023788676` and READY Vercel deployment
`dpl_4WMe3qaTs8uQVS7hA6FTfFcTjdBr` form the last runtime-changing checkpoint from exact source
`881e748`; main CI `32494801072` and CodeQL
`32494801089` passed. An independent read-only Codex desktop/mobile production focus audit passed with
P0/P1/P2 all zero, but no wallet action or signature was submitted. These UI gates do not establish a
live signed claim or safe asynchronous-child recovery.
An evidence-publication successor may move the alias and differ in artifact bytes because the deployment
registries are serverless build inputs; it does not retroactively alter the last runtime-changing checkpoint.

Post-merge operations evidence is healthy but likewise does not change payout semantics: native
GitHub scheduled current-hour run `32490379141`, recognized and safe-skipped by Cloudflare, VERIFIED
its exact RESOLVE and CREATE operations; history job
`96797302128` synchronized 1 deployment/3 epochs/3 snapshots/0 proofs, watchdog run `32490747878`
succeeded, and Worker version `536e6476-3c4e-4b93-a454-700f55d6cea7` emitted
`CLOUDFLARE_BACKUP_SKIPPED/current_hour_run_succeeded` on the tick scheduled for
`2026-08-21T14:37:29Z`, logging at `2026-08-21T14:37:30.115Z`. History integrity
at that recorded snapshot was 39/39 with zero missing/stale durable rows or snapshots. Later
documentation validation at `2026-08-21T15:16:17.648Z` observed HTTP 200 ready, journal 3, 40/40/0,
and zero gaps. Separately, pytest advisory
[GHSA-6w46-j5rx-g56g](https://github.com/advisories/GHSA-6w46-j5rx-g56g) was fixed by
[PR #22](https://github.com/Leokings/liquidity-arena/pull/22), merged as
`e79192eb25294bb59dc0dd31b55dee97085a464f`; the Dependabot alert recorded fixed at
`2026-08-21T14:38:20Z`.

V7 cannot be repaired in place. `LiquidityArenaV7.py` registers no upgrader and exposes no upgrade
method; GenLayer contracts without an authorized upgrade path are immutable after construction. See
the official [GenLayer upgradability documentation](https://docs.genlayer.com/developers/intelligent-contracts/features/upgradability).

V7 also performs effects before dispatching an independent value-transfer child: `claim()` records
the wallet as claimed, allocates the payout, and reduces player liability before sending the child.
Fee withdrawal similarly moves accrued fees to withdrawn accounting before its child. GenLayer
messages execute independently after the parent finalizes, so parent success alone is not proof that
the recipient was credited. See the official documentation for
[messages](https://docs.genlayer.com/developers/intelligent-contracts/features/messages) and
[value transfers](https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers).

The existing monitors therefore remain read-only. A missing, delayed, accepted, timeout,
undetermined, or otherwise ambiguous child is not retry evidence: the first child could later
credit, making a second direct payment a double payment. This unresolved recovery boundary is a P1
protocol limitation, even though the funded V7 canary's healthy parent/child deliveries passed.

## Required V8 state machine

V8 should create one immutable payout record per `(contract, epoch, objective, account)` and assign
it a deterministic `payout_id`:

```text
CLAIMABLE -> RESERVED(attempt 0) -> DISPATCHED(attempt 0)
DISPATCHED -> DELIVERED                         terminal
DISPATCHED -> AMBIGUOUS                         no direct retry
DISPATCHED -> TERMINAL_FAILED -> RESERVED(attempt n + 1)
AMBIGUOUS  -> DELIVERED                         only on exact credit proof
AMBIGUOUS  -> TERMINAL_FAILED                   only on exact final failure plus non-credit proof
AMBIGUOUS  -> RESERVED(attempt n + 1)            escrow-only, idempotent, reserve-funded retry
```

Entering `RESERVED` must atomically fix:

- payout ID, recipient, amount, objective, stake allocation, and rounding-remainder assignment;
- the first attempt number and a separately funded delivery-loss reserve requirement;
- `objective_allocated_atto`, distinct from `objective_delivered_atto`; and
- a concurrency guard that prevents a second reservation or dispatch for the same payout.

The amount and recipient never change across attempts. `wallet_claimed` becomes true only after
exact credited delivery is proven. Player liability decreases only once, at the same proven-delivery
transition. A deadline by itself must never convert an ambiguous direct-to-EOA child into a retryable
failure. An ambiguous retry is permitted only when the fixed destination is the idempotent escrow
described below and the next attempt is fully covered by the delivery-loss reserve.

## Idempotent payout escrow

The recommended recoverable design is V8 plus an idempotent EVM payout escrow. GenLayer documents
network EVM calls under
[interacting with EVM contracts](https://docs.genlayer.com/developers/intelligent-contracts/features/interacting-with-evm-contracts).
Every V8 dispatch sends to `PayoutEscrow.deposit(payoutId, recipient)` rather than directly to an
EOA. The escrow must:

1. credit each `payout_id` to its fixed recipient at most once;
2. accept duplicate deposits without adding a second user credit;
3. place duplicate value in an explicit recoverable-excess bucket rather than reverting and
   assuming value automatically returns;
4. expose an exact immutable payout record for reconciliation; and
5. let the user withdraw the one credited balance through an ordinary atomic EVM transaction.

Retries reuse the same payout ID, recipient, and amount. V8 may mark `DELIVERED` only after reading
the escrow's exact record and proving the credited value. Until the target network and Studio/test
environment support this interaction with matching semantics, retries must remain disabled. The
official documentation currently states that Studio does not implement EVM-contract interactions
beyond value transfers to EOAs, so the escrow design cannot be claimed as Studio-tested today.

## Solvency and authorization invariants

Each dispatch immediately consumes contract balance while the obligation remains outstanding until
delivery proof. Before every attempt, V8 must enforce:

```text
post_emit_contract_balance >= all outstanding player liabilities
```

Failed attempts may consume only a separately funded delivery-loss reserve—not participant
principal, accrued fees, or another claimant's obligation. Additional invariants are:

- one payout ID can credit a claimant at most once;
- allocation never exceeds the objective payout pool;
- at most one active direct-to-EOA attempt exists for a payout;
- no attempt may follow `DELIVERED`;
- fee availability moves through `available -> reserved -> delivered/withdrawn` and never touches
  player liability;
- owner, treasury, or recipient rotation cannot redirect an existing reservation; and
- there is no owner `force_retry` or `force_delivered` override.

## Required evidence before cutover

Direct and full-consensus tests must cover reservation duplication, two-winner rounding, immutable
retry amount, success applied exactly once, duplicate confirmation, retry-after-delivery rejection,
all ambiguous child states, terminal non-credit proof, reserve exhaustion, fee-path symmetry,
recipient rotation, randomized transition sequences, and idempotent escrow duplicate deposits.
Fault injection must demonstrate delayed, failed, duplicated, and eventually delivered children;
direct mode alone cannot prove child creation or finality.

V8 requires a fresh deployment. A safe cutover must stop V7 epoch creation, wait for all V7 wagering
and settlement work to close, retain V7 as a legacy read/resolve/timeout/claim surface, separately
fund the V8 delivery reserve, and prove the new UI and both scheduler paths before activation. The
current two V7 refunds remain on V7 until their exact child deliveries are finalized and verified.
