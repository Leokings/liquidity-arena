# V8 escrow-backed payout recovery

## Status

V8 is deployed and finalized on Bradbury at
`0x06b643f94003e51c6dc47e89524e7fd045630549`. Its production payout factory is finalized and
explorer-verified at `0xC812709d267372Ad7E06807bf0A4d451ED263A30`, and its one-time binding to
that exact V8 arena is also finalized. The checked-in manifest remains deliberately `active:false`:
delivery-reserve funding, payout activation, risk resume, and production cutover are still pending.
The live claimable-position canary is an explicitly non-gating testnet follow-up. An address and
finalized binding are not an assertion that payouts or new risk are live.

The deployed V7 contract remains immutable and its storage/balance cannot be moved into V8. This is
a testnet cutover: V7 state and its remaining test-token claims will be abandoned rather than
migrated or duplicated. The application, history service, and keeper will support only V8 after
cutover.

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

Bradbury also imposes a practical transaction-pubdata ceiling below the original readable V8
source size. The repository therefore keeps a reviewed readable source and deterministically
generates `contracts/LiquidityArenaV8.release.py` with Python 3.13 and pinned
`python-minifier==3.2.0`. The generator proves identical storage layout, constructor, and retained
public ABI before emitting the deployable artifact. The current artifact is 43,957 bytes (SHA-256
`1e7545f8f0fd121d64f3565675ac8f541d0ba8274abbde60db0dd02d7d777db5`), below the enforced
45,000-byte source and 45,500-byte outer-calldata caps. The finalized replacement deployment used
44,292 bytes of outer calldata and an independently reproduced 35,233,264 gas estimate. Any
estimate error, SDK fallback, or gas-envelope drift fails closed before signing.

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
`4221`. The finalized factory `0xC812709d267372Ad7E06807bf0A4d451ED263A30` is frozen into both
the readable and generated release sources. Its runtime, constructor immutables, protocol, reserve
sink, source publication, and initial unbound state were independently verified before that source
anchor was committed. The factory's one-time binding to the finalized V8 ghost is now finalized;
activation remains blocked until the delivery reserve and every remaining activation gate are
verified.

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

The contract fails closed unless its constructor contains the exact audited payout factory and that
factory is immutably bound back to the arena. The deployment, binding, and operator tooling pin the
outer EVM settlement chain to Bradbury `4221`; GenVM's message-domain chain ID is deliberately not
treated as the outer EVM chain identifier. Local Studio and StudioNet do not have the audited bound
factory/vault path. Payout activation deliberately leaves new epochs and
wagers paused. The owner must separately call `resume_new_risk` before `create_epoch` or `enter` can
succeed, and that explicit resume remains disabled until all of the following are true:

1. the configured factory equals the exact Bradbury chain-4221 audit anchor;
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

- GenVM lint plus complete V8 timing, market, settlement, and authorization tests;
- direct payout tests for chain/factory fail-closed activation, domain-separated IDs, duplicate
  reservation, both two-winner claim orders, player/fee symmetry, simultaneous payouts, reserve exhaustion,
  exact immutable retry, cooldown/cap, late credit, and funded-versus-withdrawn accounting;
- Solidity tests for unauthorized preparation/funding, CREATE2 identity, wrong and duplicate
  funding, excess isolation/recovery, reverting and reentrant recipients, one withdrawal, persistent
  records, and absence of admin principal drains; and
- live full-consensus tests on an EVM-capable GenLayer network for ghost sender identity, preparation,
  message fees, delayed/reordered attempts, duplicate excess, exact confirmation, withdrawal, and
  fee-path symmetry.

Studio/direct mocks cannot close the final EVM gate. The finalized Bradbury sacrificial factory/vault
rehearsal supplies that rail evidence. A complete live V8 claim-through-withdrawal canary additionally
requires waiting for a claimable position; the operator explicitly waived that wait for this
faucet-funded testnet cutover. Activating the manifest therefore does not claim that such a live V8
payout canary occurred.

Local verification passes GenVM lint/validation, 34 direct V8 tests, 38 Bradbury harness tests
(included in the 354/354 root Node suite), and 59 EVM tests: nine adversarial factory/vault tests plus
50 factory deployment/binding-tool tests. The production build emits 625 modules and dependency
audit reports zero findings. The Solidity compile uses locked `solc 0.8.28` and reports zero errors
or warnings; the authority/storage/forbidden-source-construct/bytecode-size audit also passes. These
checks are wired into CI. These figures are local evidence and do not by themselves assert a remote-
CI run. They prove the local state machine and tooling, not live ghost/EVM parity or finalized
deployment evidence. The live gate must publish the resulting bytecode and constructor immutables
and repeat the source/address-anchor review.

The finalized rehearsal, production-factory deployment, source freeze, V8 deployment, and one-time
factory binding are complete. The remaining testnet sequence is: fund the delivery reserve; activate
payouts with risk paused; explicitly resume new risk under the durable harness; then complete the
application, history-service, and keeper cutover. Migration 004 and the global one-active constraint
are already part of the release. The manifest remains `active:false` until the live fund, activation,
resume, and external cutover gates are closed.
