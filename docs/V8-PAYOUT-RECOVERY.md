# V8 escrow-backed payout recovery

## Status

V8 is an inactive, unbroadcast Bradbury release candidate. The repository contains the GenLayer
contract, immutable EVM payout factory/vault, Bradbury factory-deploy/bind tools, and inactive-
deployment harness. No V8-release transaction has been broadcast: nothing has been deployed, bound,
funded, canaried, or cut over. No production or StudioNet route points to V8, and new wagering must
remain on V7 until every live-network gate in this document passes.

The deployed V7 contract remains immutable and currently retains 2 GEN across two eligible legacy
refunds. Those obligations cannot be read, moved, or claimed by V8: V7 has no upgrader, its claim is
sender-bound, and V8 cannot pull V7 storage or balance. The public application must therefore keep
V7 as a distinct legacy claim target after any future V8 cutover. Copying the two refunds into V8
would create duplicate obligations and is prohibited.

## Why an escrow is required

V7 applies claim/fee accounting before emitting its external value-transfer message. Off-chain
receipts can prove a known child credited the exact recipient, but the contract cannot consume that
receipt and Studio has no payout-ID-level deduplication. A retry creates a different child hash, so
an absent, delayed, or ambiguous first child is never sufficient evidence for a second direct EOA
payment.

GenLayer documents external EVM messages as finality-only and routed through the contract's ghost.
That does not make a parent receipt a contract-consumable delivery proof, and a live EVM target may
still reject or mishandle a call. V8 therefore sends every attempt to an immutable idempotent vault,
not directly to the claimant. See the official documentation for
[value transfers](https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers),
[EVM interaction](https://docs.genlayer.com/developers/intelligent-contracts/features/interacting-with-evm-contracts),
and [Studio limitations](https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio/limitations).

## Pinned-runner constraint

The V8 source remains on the repository's pinned V0.2.16-compatible GenLayer runner. Direct
inspection and execution found two defects in that runner's generated EVM interface: generated
views reference a nonexistent proxy field, and value-bearing method calls lose their `value`.

V8 avoids those paths deliberately:

- exact factory views use pinned-runner low-level `EthCall`;
- factory preparation uses a zero-value `EthSend`; and
- value uses the runner's working pure `emit_transfer` to the deterministic prepared vault.

The factory/vault split is therefore required for this runner. A future V0.3 port may simplify the
flow to one value-bearing escrow method, but only after a full contract and test migration.

## State machine

```text
CLAIMABLE
  -> PREPARING
  -> DISPATCHED
  -> FUNDED_IN_ESCROW
  -> EOA_WITHDRAWN
```

`claim(epoch, objective)` is a reservation, not a payment receipt. It atomically fixes the payout
ID, recipient, amount, stake allocation, rounding remainder, and the payout's bounded reserve
budget. It then emits an idempotent zero-value factory preparation message.

Factory preparation carries no value and can only repeat the same immutable tuple. After the fixed
cooldown, `retry_prepare_payout(id)` is therefore permissionless and deliberately has no terminal
retry cap; dropped preparation messages cannot strand a reserved payout. Value-bearing vault
dispatches remain capped at three attempts because each ambiguous dispatch can consume reserve.

`dispatch_payout(id)` is permissionless once the exact deterministic vault is prepared. A retry is
allowed only for the immutable same payout ID, recipient, amount, and vault, after the deployment-
fixed cooldown, and only while that payout still has precommitted reserve. The recipient, keeper,
or owner may request a retry; none can change the proof, destination, amount, cap, or cooldown.

`confirm_payout(id)` is permissionless and transitions only after an exact synchronous factory view
proves that the vault credited the immutable payout. Player or fee liability leaves the arena at
`FUNDED_IN_ESCROW`, because the vault has assumed an enforceable withdrawal obligation. A separate
`refresh_payout_withdrawal(id)` records `EOA_WITHDRAWN`; wallet `claimed` and fee `withdrawn`
counters do not advance merely because escrow was funded.

Retry exhaustion is not a terminal failure. A late original attempt can still fund the vault and
must remain confirmable.

## Payout identity

The deterministic payout ID is Keccak-256 over canonical JSON containing:

- chain ID;
- V8 contract address;
- immutable factory address;
- payout protocol version;
- payout kind (`PLAYER` or `FEE`);
- exact recipient and amount;
- epoch and objective for a player payout; and
- a monotonic nonce for a fee payout.

Player reservation also increments `objective_allocated_atto` and consumes winning stake exactly
once. The last reserved winning claimant receives `payout_pool - allocated`, so every claim order
conserves the integer pool. Allocation is never recomputed during a retry.

## Immutable EVM factory and vault

The factory must be deployed first with immutable binder and reserve-sink addresses. For this
reviewed rollout the binder is the same dedicated EOA as the V8 owner, and both tools reject a
mismatch before signing. After the V8 ghost address is known, the binder may bind that arena exactly
once. Activation verifies the
exact binding and payout protocol, but those self-reported views are not a trust anchor. The exact
independently audited, non-proxy factory address must also be compiled into the V8 source for chain
`4221`. The release-candidate constant is intentionally the zero address, so this source cannot
activate until the live factory bytecode, constructor immutables, binding, and reserve sink have
been verified and the resulting V8 source hash has been reviewed again.

Only the bound arena ghost may prepare a payout. The factory deploys one CREATE2 vault from the
payout ID and permanently binds its arena, recipient, amount, and payout ID. The vault:

1. accepts ordinary `receive()` funding and creates credit only from the bound arena, while forced
   or preseeded balance remains uncredited excess;
2. records one user credit only for the first exact amount;
3. treats a wrong amount or any duplicate as excess without changing the original credit;
4. exposes immutable payout identity plus monotonic prepared, credited, and withdrawn facts;
5. lets only the fixed recipient pull the credit through an atomic reentrancy-guarded withdrawal;
6. preserves the credit if the recipient rejects the withdrawal; and
7. permits only excess—not claimant principal—to be swept to the immutable reserve sink.

There is no proxy, upgrader, recipient mutation, admin proof override, principal drain, or
`force_funded` method.

## Reserve accounting

The delivery-loss reserve is funded separately through `fund_delivery_reserve()`. Participant stake
and accrued fees cannot be relabeled as reserve. V8 has no generic "recognize balance surplus"
method because an unexplained balance change is not safe proof that an external attempt can no
longer debit.

The deployment fixes three value attempts per payout. Before accepting a new wager, available
reserve must cover:

```text
3 * (unreserved player liability + accrued unreserved fee liability + new stake)
```

Reservation moves exactly `amount * 3` from available reserve into that payout's committed budget.
Each dispatch consumes one amount from the same budget. Until exact escrow funding is proven, the
original player/fee liability remains intact. After every dispatch:

```text
contract balance
  >= player liability
   + accrued fees
   + reserved fees
   + available delivery reserve
   + remaining committed attempt reserve
```

On exact escrow funding, unused attempts return to available reserve and the discharged arena
principal becomes available reserve. Attempts beyond the one successful credit remain reserve
losses. One payout can never consume another payout's committed budget.

Reserve withdrawal is intentionally absent from V8.

## Network and activation gates

The contract fails closed on every chain except the target EVM-capable GenLayer chain ID `4221`.
Local Studio (`61127`) and StudioNet (`61999`) cannot activate payouts because Studio does not
execute the required EVM factory/vault path. Payout activation deliberately leaves new epochs and
wagers paused. The owner must separately call `resume_new_risk` before `create_epoch` or `enter` can
succeed, and that explicit resume remains disabled until all of the following are true:

1. the chain is allowlisted;
2. the constructor factory equals the exact audited address compiled for that chain;
3. the immutable factory is exactly bound to the V8 ghost;
4. the factory reports the exact payout protocol;
5. the delivery reserve covers every unreserved obligation; and
6. arena accounting is solvent.

Owner or keeper may pause new epochs/wagers without blocking settlement, claims, preparation,
dispatch reconciliation, confirmation, or EVM withdrawal. Only the owner can resume new risk, and
resume repeats the factory, reserve, and solvency checks. This split prevents payout activation from
creating a non-atomic public-risk window while an operator waits for a separate pause transaction.

## Verification and cutover requirements

Repository acceptance requires:

- GenVM lint plus V7-equivalent timing, market, settlement, and authorization tests;
- direct payout tests for chain/factory fail-closed activation, domain-separated IDs, duplicate
  reservation, both two-winner claim orders, player/fee symmetry, simultaneous payouts, reserve exhaustion,
  exact immutable retry, cooldown/cap, late credit, and funded-versus-withdrawn accounting;
- Solidity tests for unauthorized preparation/funding, CREATE2 identity, wrong and duplicate
  funding, excess isolation/recovery, reverting and reentrant recipients, one withdrawal, persistent
  records, and absence of admin principal drains; and
- live full-consensus tests on an EVM-capable GenLayer network for ghost sender identity, preparation,
  message fees, delayed/reordered attempts, duplicate excess, exact confirmation, withdrawal, and
  fee-path symmetry.

Studio/direct mocks cannot close the final EVM gate. Until live evidence exists, V8 must remain an
inactive candidate and no `deployments/*-v8.json`, public V8 route, V8 keeper schedule, or active
history alias may be published.

Local verification passes GenVM lint/validation, 34 direct V8 tests, 29 Bradbury harness tests
(included in the 463/463 root Node suite), and 59 EVM tests: nine adversarial factory/vault tests plus
50 factory deployment/binding-tool tests. The production build emits 477 modules and dependency
audit reports zero findings. The Solidity compile uses locked `solc 0.8.28` and reports zero errors
or warnings; the authority/storage/forbidden-source-construct/bytecode-size audit also passes. These
checks are wired into CI. These figures are local evidence and do not by themselves assert a remote-
CI run. They prove the local state machine and tooling, not live ghost/EVM parity or finalized
deployment evidence. The live gate must publish the resulting bytecode and constructor immutables
and repeat the source/address-anchor review.

A later cutover also requires a new append-only database migration and a global one-active-
deployment constraint; the current history schema can otherwise leave both V7 and V8 marked active.
The safe sequence is: complete a finalized sacrificial factory rehearsal; deploy and explorer-verify
a finalized production unbound factory; freeze its exact address into V8 and repeat review/CI;
deploy inactive V8; bind the factory once from finalized proof; fund reserve; activate payouts with
risk paused; run live payout-only canaries; stop every V7 creation source, settle/drain all open V7
epochs, and retain legacy V7 claim routes/liability; apply the migration/global one-active constraint;
then run a separately reviewed attended risk canary and cut over the app and keeper while keeping V7
claims/liability distinct.
