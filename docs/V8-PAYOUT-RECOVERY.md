# V8 escrow-backed payout recovery

## Status

V8 is an inactive release candidate. The repository contains the new GenLayer contract and the
immutable EVM payout factory/vault, but no V8 deployment is recorded and no production or
StudioNet route points to it. New wagering must remain on V7 until every live-network gate in this
document passes.

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

The factory is deployed first with immutable binder and reserve-sink addresses. After the V8
ghost address is known, the binder may bind that arena exactly once. Activation verifies the
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
execute the required EVM factory/vault path. `create_epoch` and `enter` remain disabled until all of
the following are true:

1. the chain is allowlisted;
2. the constructor factory equals the exact audited address compiled for that chain;
3. the immutable factory is exactly bound to the V8 ghost;
4. the factory reports the exact payout protocol;
5. the delivery reserve covers every unreserved obligation; and
6. arena accounting is solvent.

Owner or keeper may pause new epochs/wagers without blocking settlement, claims, preparation,
dispatch reconciliation, confirmation, or EVM withdrawal. Only the owner can resume new risk, and
resume repeats the factory, reserve, and solvency checks.

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

The current repository candidate passes GenVM lint/validation, 33 direct V8 tests, and nine
adversarial Solidity tests. The Solidity compile uses locked `solc 0.8.28` and reports zero errors
or warnings; the authority/storage/forbidden-source-construct/bytecode-size audit and isolated dependency
audit also pass. These checks are wired into CI as a separate EVM payout-contract job. They prove
the local state machine and immutable contracts, not live ghost/EVM parity or a deployable GenLayer
Chain artifact. The chain is a zkSync Elastic Chain; the live gate must use its supported deployment
toolchain, publish the resulting bytecode and constructor immutables, and repeat the source/address
anchor review rather than treating the local Hardhat/solc artifact as production proof.

A later cutover also requires a new append-only database migration and a global one-active-
deployment constraint; the current history schema can otherwise leave both V7 and V8 marked active.
The safe sequence is: deploy and verify inactive V8, stop V7 creation sources, drain all V7 open
epochs, retain V7 claims/liability, validate V8 canaries, apply the cutover migration, switch the app
and keeper atomically, and verify V7/V8 liabilities remain distinct.
