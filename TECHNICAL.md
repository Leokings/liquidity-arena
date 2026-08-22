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

- V8: `0xe6aa95e551f8407b139474ec60c2012e4cc8a6cd`
- factory: `0x944fdadd826c2a159c63cb100db174716ccd1317`
- V8 release SHA-256: `160965bc42b34dce42fa7154923116f21edb39a7a42abc61bde162db8e15d5aa`
- schema SHA-256: `c8545eea9398fa05c29edf719250402f2ffda99a98ad706ffd329e457d2d89c4`
- factory runtime Keccak-256: `0x30f617eaa58c41ff98353a51e1ee0c4ee6f6c64a2e6d31e13a867cc548af9b3c`
- payout protocol: `IDEMPOTENT_EVM_VAULT_V1`

The deterministic release builder preserves the 39-field storage layout, constructor, 25-method public ABI, decorators, type annotations, and factory literal. The generated source is 44,125 bytes; the measured Bradbury outer deployment calldata is 44,452 bytes and estimates at 35,346,217 gas.

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

Migrations 001–003 remain immutable. Migration 004 adds Bradbury V8 identity, globally deactivates legacy deployments, enforces one globally active deployment, adds payout identity and stage-proof tables, generalizes keeper subjects to epochs or payout IDs, and persists rotating payout cursors.

Public history exposes only V8 deployments, epochs, proofs, and payouts. Health requires exact contract/role/factory/schema identity, schema version 4 with no unknown later migration, complete epoch/payout projections, and verified payout-stage evidence.

## Keeper

The V8 keeper uses a Bradbury-scoped lease and authoritative journal. It scans a hot newest payout tail plus a durable rotating backlog, so older nonterminal payouts cannot starve. It may call:

- `retry_prepare_payout`
- `dispatch_payout`
- `retry_payout` when authorized
- `confirm_payout`
- `refresh_payout_withdrawal`

It has no EVM signer and no vault-withdraw ABI.

## Activation and rollback

Rollout order is deploy, bind, fund, activate payout rails, deploy the V8-only app/history/keeper, verify the payout lifecycle, then resume new risk. Readiness stays degraded while payouts or risk are disabled.

Rollback is `pause_new_risk`. Existing resolution, claims, payout retries, recipient withdrawals, and refresh remain available while new exposure is closed. V7 is never a rollback target.
