# Bradbury V8 inactive-deployment canary

This harness deploys and certifies an initially **inactive** Liquidity Arena V8 candidate on
GenLayer Bradbury. It never edits an application route, deployment registry, database, or keeper
schedule. There is deliberately no cutover command.

`LiquidityArenaV8.release.py` is the deterministic deployment artifact and freezes the independently
deployed and verified chain-4221 factory
`0x944FdADd826C2a159c63cB100DB174716ccd1317`. Any change to that non-proxy address requires a new
factory deployment, bytecode/source verification, source review, and exact source-hash update.

## What is enforced

- The pinned `genlayer-js` chain must be exactly `testnet-bradbury`, chain ID `4221`, RPC
  `https://rpc-bradbury.genlayer.com`, `testnet=true`, and `isStudio=false`. The harness does not
  read or change the process-global GenLayer CLI network.
- The configuration must explicitly fix the owner account and address, keeper, treasury, EVM
  factory, factory binder, reserve sink, factory runtime bytecode hash, full V8 source hash,
  exhaustive 25-method schema hash, stake limits, and initial delivery reserve.
- For this reviewed rollout, the V8 owner and one-time factory binder must be the same dedicated EOA;
  configuration validation rejects a mismatch before any signature or deployment.
- The local source must hash exactly and contain one literal `AUDITED_PAYOUT_FACTORY_4221` equal to
  the configured factory. A zero-address candidate cannot be broadcast.
- Deployment is full consensus. The exact source and five constructor arguments must appear in a
  successful `FINALIZED` receipt, and its sender and resulting nonzero contract address must be
  exact. Merely reaching `ACCEPTED` or `FINALIZED` is not execution success.
- Deployed code must be byte-for-byte equal to the reviewed release artifact. Schema, `get_config`,
  the merged delivery-reserve/fee/liability state, and the totals returned by the one-item epoch and
  payout pages are exact readbacks; unknown fields fail closed.
- Only after the successful finalized deployment receipt, exact source/constructor/owner proof, and
  all deployment readbacks pass, the harness atomically creates a non-secret
  `liquidity-arena-bradbury-bind-request-v1` file beside operational state. Its published strict
  shape is [`bind-request.schema.json`](./bind-request.schema.json). It includes the config/source/
  schema hashes, constructor roles, owner/factory/arena addresses, both transaction hashes, and the
  outer EVM receipt block hash/number, but never the replayable signed raw transaction. The exact
  path is `<statePath>.bind-request.json`; publication is create-once, so an existing mismatch is a
  hard stop rather than an overwrite.
- A delegated EVM utility must bind the factory exactly once through `bind_arena(V8_ADDRESS)` and
  produce the exact proof shape in `bind-proof.example.json`. The file is only a pointer to evidence,
  not trusted evidence: before funding and again before activation, this harness independently
  fetches the exact transaction, successful receipt, canonical finalized block, `ArenaBound` event,
  runtime code SHA-256, binder, reserve sink, arena, and protocol from Bradbury. This harness does
  not deploy or bind the Solidity factory.
- Reserve funding must finalize successfully with the exact sender, V8 recipient, payable method,
  and value, followed by an exact reserve increase with zero liabilities.
- The reviewed `activate_payouts` transition enables payout processing while deliberately leaving
  `new_risk_enabled=false` in the same finalized transaction. There is no activation-to-pause
  public-risk window. The terminal harness state is `PAYOUTS_ACTIVE_RISK_PAUSED`; the standalone
  `pause` action remains defense-in-depth if a separately reviewed future tool ever resumes risk.
  This harness exposes no `resume_new_risk` action.
- Fresh deployment, funding, and activation gates require pristine zero accounting. Emergency-pause
  preflight, postcondition, status, and reconciliation deliberately use a separate live-state proof:
  code/schema/config remain exact, payouts remain enabled, new risk must become disabled, nonzero
  epoch/payout/liability state is allowed, and the consolidated reserve/fee/liability fields, the
  bounded three-attempt reserve formula, capacity, page totals, and funded/withdrawn fee identities
  must agree. Before signing, the exact canonical pre-pause accounting snapshot is stored in the
  durable `PAUSE_PREPARED` operation and the signer child independently re-reads and matches it.
  Post-finality and reconciliation require the exact risk-enabled-to-disabled transition and the
  same immutable payout/fee policy, while independently validating the later live accounting
  invariants. Resolution, claims, retries, and fee delivery may legitimately advance dynamic
  counts and amounts while the pause finalizes, so those values are not required to remain frozen.
  A legitimate canary therefore cannot make a successful pause unrecoverable merely by creating or
  settling accounting state.

## Transaction durability and secrets

Every write first records a unique `PREPARED` operation. Signing occurs in a hidden child process
launched with argument boundaries and `shell:false`. If the account is unlocked, the child reads
the existing `genlayer-cli` OS-keychain entry. An unavailable/rejecting headless Linux keychain is
treated only as “not unlocked”; its backend error is suppressed and the same encrypted-keystore
fallback is used. Otherwise the parent sends
`GENLAYER_KEYSTORE_PASSWORD` over stdin; it is never an argument or log value.

The signing hook atomically writes the exact signed raw EVM transaction, deterministic EVM hash,
sender nonce, and action nonce to ignored operational state **before** returning the payload to the
SDK. Therefore the SDK cannot call `eth_sendRawTransaction` first. A process crash never authorizes
a new signature or nonce; the one exact signed transaction is the recovery artifact. The temporary
contents and published file are flushed before the signer returns; POSIX directory metadata is
also flushed. Node does not expose a Windows directory handle that can prove rename durability
across sudden power loss, so after an OS crash or power loss, do not trust a rolled-back `PREPARED`
file: audit the dedicated owner's Bradbury nonce/transactions and the recorded lock/state before
any new signing. On POSIX, files are created with mode 0600 and state paths are confined to the
ignored `ops/bradbury-v8/.operational/state` tree. On Windows, state and owner locks default to the current user profile's
`%LOCALAPPDATA%\LiquidityArena\bradbury-v8` tree and custom state paths outside that tree are
refused; protection depends on the profile directory's inherited Windows ACL. Verify that ACL is
private to the operator before use. Treat the entire operational tree as sensitive even though it
contains no private key. State, bind-artifact, and lock roots/parents/targets are checked with both
`lstat` and `realpath` before reads, creation, publication, lock ownership checks, and signer-child
handoff. Symbolic links, Windows junctions, aliased ancestors, and dangling aliases are refused so
replayable transaction bytes cannot be redirected outside the protected root.

Before signing, the outer Bradbury `addTransaction` v6 calldata is canonical-reencoded and compared
byte-for-byte. Its literal 5-validator/3-rotation policy, sender, recipient, one-hour validity,
source or method, typed constructor arguments, empty call arguments, and `leaderOnly=false` must all
match. The deploy source is capped at 45,000 UTF-8 bytes and every outer transaction at 45,500
calldata bytes. Those operational limits retain roughly 15% headroom below the narrowest boundary
observed by read-only Bradbury probes on 2026-08-22; they are deliberately conservative and are not
treated as permanent protocol constants. An oversized source is a release failure, not permission
to send the SDK's fallback transaction.

Immediately before the account/nonce gate, the signer independently calls Bradbury
`eth_estimateGas` for the exact SDK-built sender, consensus recipient, calldata, and value. Any RPC
error is fatal. The result must be positive, no greater than `operator.maxEvmGasLimit`, and exactly
equal the SDK-requested gas. This specifically prevents `genlayer-js` 1.1.8 from signing after its
silent 200,000-gas fallback. The signed legacy envelope must reproduce those bytes and stay under
the explicit gas-limit and gas-price caps in the configuration. Their configured product and every
signed envelope are also subject to a non-configurable 0.03 GEN maximum gas-cost ceiling. Recovery
redoes the same check before any raw replay.

Immediately before every fresh signature, the signer reads the dedicated owner's Bradbury EVM
transaction counts at both `latest` and `pending` plus its pending balance. It signs zero bytes unless
`latest == pending ==` the SDK-requested nonce and the pending balance covers the exact transaction
value plus `gasLimit * gasPrice`. Both equal nonce observations, the balance, and the maximum cost are
bound into durable SIGNED evidence. Exact-raw recovery never performs a fresh signature and therefore
does not substitute a new nonce. The example's 50,000,000 gas-limit and 0.6 gwei gas-price caps meet
the 0.03 GEN ceiling exactly; the independent estimate still has to fit that cap.

After EVM submission, the harness requires the receipt for that exact deterministic EVM hash to be
successful and mined by Bradbury's exact consensus contract. It accepts exactly one
`NewTransaction` (or pinned legacy `CreatedTransaction`) event and requires the SDK's returned
GenLayer transaction ID to equal that event's indexed ID. Only then can state become `SUBMITTED`.
The GenLayer transaction must later reach `FINALIZED` **and** `FINISHED_WITH_RETURN`.

GenLayer finality does not claim that the outer EVM envelope's block has reached the EVM
`finalized` tag. The bind request therefore fixes
`deploymentEvmFinalityVerified=false` and `deploymentEvmFinalityRequiredBeforeBind=true`. Before
loading the binder key or submitting `bind_arena`, the delegated EVM utility must fetch that exact
EVM transaction/receipt, wait until its recorded block hash is canonical and no newer than the
Bradbury EVM `finalized` block, and refuse any hash, block, sender, recipient, calldata, or status
mismatch.

If a process dies while state is `*_SIGNED`, run `reconcile` first. It looks up the exact stored EVM
hash and never signs another payload. Without `--broadcast`, a missing receipt is only reported.
With `--broadcast`, recovery may replay only the byte-identical stored raw transaction; its returned
hash and receipt must still match. A recovered finalized activation requires the bind proof and,
after proving the exact activation receipt, must read back `payouts_enabled=true` and
`new_risk_enabled=false`; recovery sends no second pause transaction. Any conflicting hash, receipt,
event, state readback, or multiple unresolved operation is a hard stop.

Every state-changing or reconciliation run holds two exclusive lock files: one for the exact state
path and one for the Bradbury owner address. The exact-state lock serializes its state file; the
canonical owner lock coordinates the reviewed harness, factory, and bind tools across checkouts
under the same user profile. Use a dedicated Bradbury V8 owner. These locks cannot coordinate an
external wallet, CLI, older/unreviewed checkout, or other process that ignores the lock, which is
why the onchain quiescent-nonce gate is mandatory. A hard
process/OS crash deliberately leaves a stale lock.
Before manually deleting it, verify the recorded PID is dead, confirm no process is using the owner,
and inspect the protected operational state. Then run `reconcile`—never rerun the original broadcast
blindly.

## Usage

Copy both examples to ignored `*.local.json` files and replace every address/hash with independently
reviewed Bradbury evidence. Rebuild and review `LiquidityArenaV8.release.py`, then recompute
`sourceSha256`, after any canonical contract change. The schema hash changes only if the public ABI
changes.

After deploy succeeds, pass the generated `<statePath>.bind-request.json` to the separately reviewed
EVM factory utility's production bind mode. That bind mode—not this harness—produces the subsequent
`bind-proof.local.json` consumed by `fund` and `activate`. Production binding is intentionally
impossible until the finalized deployment proof producer has passed and created the exact request;
an address or state file alone is not authorization to bind.

```powershell
npm run v8:bradbury:status -- --config ops/bradbury-v8/config.local.json
npm run v8:bradbury:deploy -- --config ops/bradbury-v8/config.local.json
npm run v8:bradbury:deploy -- --config ops/bradbury-v8/config.local.json --broadcast
npm run v8:bradbury:reconcile -- --config ops/bradbury-v8/config.local.json
npm run v8:bradbury:reconcile -- --config ops/bradbury-v8/config.local.json --broadcast
node ops/bradbury-v8/harness.mjs fund --config ops/bradbury-v8/config.local.json --bind-proof ops/bradbury-v8/bind-proof.local.json
node ops/bradbury-v8/harness.mjs fund --config ops/bradbury-v8/config.local.json --bind-proof ops/bradbury-v8/bind-proof.local.json --broadcast
node ops/bradbury-v8/harness.mjs activate --config ops/bradbury-v8/config.local.json --bind-proof ops/bradbury-v8/bind-proof.local.json --broadcast
```

Omitting `--broadcast` performs only validation/readback and prints the exact plan. `status` is the
default and is always read-only. Bradbury transactions and reserve funding consume Bradbury
testnet GEN; they never use StudioNet's gasless environment or V7's existing GEN balance.

Activation is one safe GenLayer transaction: the contract sets `payouts_enabled=true` and preserves
`new_risk_enabled=false`. A crash after submission is recovered by exact-hash `reconcile`; it cannot
open epochs or wagers. Any future `resume_new_risk` canary/cutover requires a separately reviewed,
attended tool and safety plan and is intentionally outside this harness.

After `PAYOUTS_ACTIVE_RISK_PAUSED`, separately review the payout-only ghost/EVM canary plan, then run it.
Application and
database cutover remains a later, independent release operation after those canaries pass.
