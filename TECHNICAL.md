# Liquidity Arena V8 technical design

## System boundary

The active system is V8 on GenLayer Bradbury testnet with deterministic payout delivery on the Bradbury EVM layer, chain 4221. StudioNet V6/V7 deployments are archival evidence only.

| Component | Responsibility |
| --- | --- |
| V8 intelligent contract | Epochs, wagers, five-venue resolution, parimutuel accounting, payout state, reserve accounting, risk gates |
| EVM payout factory | One-time arena binding and deterministic immutable vault creation |
| Recipient vault | Exact-principal receipt, monotonic credit, recipient-only withdrawal, excess recovery to fixed sink |
| Browser | V8 reads/writes, wallet/chain checks, durable payout action journal, recipient withdrawal |
| Server/history | Exact deployment readiness, V8-only public projection, payout-stage proofs |
| Keeper | Bounded epoch work and payout reconciliation; never recipient withdrawal |

## Release identity

- V8: `0x06b643f94003e51c6dc47e89524e7fd045630549`
- factory: `0xc812709d267372ad7e06807bf0a4d451ed263a30`
- V8 release SHA-256: `1e7545f8f0fd121d64f3565675ac8f541d0ba8274abbde60db0dd02d7d777db5`
- schema SHA-256: `c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4`
- factory runtime Keccak-256: `0x30f617eaa58c41ff98353a51e1ee0c4ee6f6c64a2e6d31e13a867cc548af9b3c`
- payout protocol: `IDEMPOTENT_EVM_VAULT_V1`

The deterministic release builder preserves the 39-field storage layout, constructor, 25-method public ABI, decorators, type annotations, and factory literal. The generated source is 43,957 bytes; the exact Bradbury deployment used 44,292 bytes of outer calldata and an independently reproduced 35,233,264 gas estimate.

## Market lifecycle

Epochs use exact UTC-hour identifiers. A wallet may enter HIGH or LOW for one asset per objective, subject to the fixed 0.1–10 GEN limits. Validators fetch five independent venue payloads and agree on the canonical median result. Under-quorum or malformed results leave the epoch unresolved rather than accepting partial data.

Settlement is parimutuel. Platform fees, player liability, rounding remainder, reserve commitments, delivered principal, and withdrawn principal are separate ledgers checked by cross-view accounting invariants.

## Payout lifecycle

```text
claim/request fee
  -> PREPARING
  -> DISPATCHED
  -> FUNDED_IN_ESCROW
  -> recipient EVM withdraw
  -> refresh_payout_withdrawal
  -> EOA_WITHDRAWN
```

Preparation and dispatch are idempotent. A payout ID cannot be redefined. Duplicate or wrong-value EVM funding becomes uncredited excess and cannot consume principal. Permissionless excess recovery can pay only the immutable reserve sink.

Delivery capacity follows the configured reserve multiplier. New payout commitments fail closed if the reserve cannot cover the requested liability. Enabling payout rails does not enable new risk.

## Cross-chain proof model

Every write is reconciled against its exact GenLayer or EVM domain:

- GenLayer receipts must be finalized, successful, and match sender, recipient, method, arguments, value, source, and contract identity.
- EVM receipts must match chain 4221, sender, target, calldata, value, canonical block, finalized head, factory binding, vault record, and immutable runtime.
- GenLayer and EVM transaction hashes are never treated as interchangeable.

The operator journals a prepared intent before signing. Once a signed hash exists, recovery inspects that hash first and may replay only the identical serialized transaction under explicit authorization.

## Browser state

The browser recognizes only V8. Legacy deployment query values canonicalize to V8; arbitrary contract addresses are rejected. Immediately before every wallet write it rechecks account, chain, contract, quote/payout identity, and expected value.

EVM withdrawal attempts are stored in a bounded durable multi-attempt journal. Pending attempts block duplicate signing. Finalized attempts cannot downgrade. Reverted or dropped attempts may be retried only after exact vault/receipt inspection; an externally completed withdrawal advances to the GenLayer refresh step.

## History and database

Migrations 001–003 remain immutable. Migration 004 adds Bradbury V8 identity, globally deactivates legacy deployments, enforces one globally active deployment, adds payout identity and stage-proof tables, generalizes keeper subjects to epochs or payout IDs, and persists rotating payout cursors. Migration 005 narrowly permits revalidation of a finalized generic receipt-identity quarantine after the exact finalized receipt—using raw transaction bytes for call identity—proves the stored hash, contract, method, arguments, and successful execution; specific identity mismatches remain terminal.

Public history exposes only V8 deployments, epochs, proofs, and payouts. Health requires exact contract/role/factory/schema identity, schema version 5 with no unknown later migration, complete epoch/payout projections, and verified payout-stage evidence.

## Keeper

The V8 keeper uses a Bradbury-scoped lease and authoritative journal. It scans a hot newest payout tail plus a durable rotating backlog, so older nonterminal payouts cannot starve. It may call:

- `retry_prepare_payout`
- `dispatch_payout`
- `retry_payout` when authorized
- `confirm_payout`
- `refresh_payout_withdrawal`

It has no EVM signer and no vault-withdraw ABI.

## Activation and rollback

Rollout order is deploy, bind, fund, activate payout rails, explicitly resume new risk, deploy the
V8-only app/history/keeper, create future epochs, and verify readiness. A value-bearing production
network should put an attended payout lifecycle canary before resume; this faucet-funded Bradbury
cutover explicitly does not claim that pre-resume canary. Readiness stays degraded while payouts or
risk are disabled.

Rollback is `pause_new_risk`. Existing resolution, claims, payout retries, recipient withdrawals, and refresh remain available while new exposure is closed. V7 is never a rollback target.
