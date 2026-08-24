# V8 history API

`GET /api/history` and `HEAD /api/history` expose bounded, read-only Bradbury V8 history. No V6/V7 deployment, epoch, claim, or proof is public.

## Query

```text
/api/history?view=deployments
/api/history?view=epochs&deployment=v8
/api/history?view=proofs&deployment=v8
/api/history?view=payouts&deployment=v8
```

Parameters:

- `view`: `deployments`, `epochs`, `proofs`, or `payouts`
- `deployment`: omitted for the deployments view; otherwise only `v8`
- `limit`: 1–50
- `cursor`: opaque cursor returned by the previous page

Unknown parameters, legacy aliases, arbitrary addresses, malformed cursors, and oversized pages fail closed.

## Identity and projection

The active deployment row must match the configured:

- `testnet-bradbury` network and chain 4221;
- V8 contract address;
- owner, keeper, and treasury;
- protocol, policy, source/schema, and payout factory.

Epoch rows include objective settlement/accounting data and finalized transaction proofs. Payout rows include recipient, amount, kind, epoch/objective identity, wallet/stake/settlement identity, state, immutable vault, attempt counters, reserve commitment, timestamps, withdrawal status, and ordered GenLayer/EVM stage proofs.

Payout IDs are lowercase 64-hex without `0x`. Stage proofs retain distinct retry attempts by transaction hash and domain.

## Durability and health

The synchronizer uses a persisted rotating payout cursor plus bounded epoch work, so old nonterminal payouts are eventually refreshed after leaving the newest tail.

`GET /api/history-health` is ready only when:

- migrations 001–010 have exact checksums;
- no migration newer than version 10 exists;
- exactly one configured Bradbury V8 deployment is active;
- legacy deployments are inactive;
- epoch and payout projections are complete;
- required payout-stage evidence is present and internally consistent;
- keeper journal schema V10 is healthy.

Migration 004 is append-only and intentionally refuses a second application. Its checksum is `1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910`.
Migration 005 (`keeper_receipt_identity_revalidation`) is likewise append-only and checksum-pinned at `a9473b780b659ea6bf04809d8c1b59bdaf6e0c8707328a7b03109e7ab5b5dd59`.
Migration 006 (`keeper_accepted_handoff`) is append-only and checksum-pinned at `5b81d291c121cae31962b164608e5ad5fc65a19158bed95cd96fae0348e13bdf`.
Migration 007 (`keeper_prehash_abandonment`) is append-only and checksum-pinned at `4fa4e8103a1b3caa7022cff2ea1b4868ea6128a4f6b359cdb93a8a6320e0a8f3`.
Migration 008 (`keeper_prehash_legacy_constraint_cleanup`) is append-only and checksum-pinned at `030604d61f54ad9f6e388f497723d7eaa7118632866574cff976dd0bd43f680a`.
Migration 009 (`keeper_create_prehash_recovery`) is append-only and checksum-pinned at `5be4175a165d872112f97b88323f3ed013b47eb0aca37b17c2e8c6953cde6694`.
Migration 010 (`keeper_durable_signed_envelope`) is append-only and stores one private raw signed
envelope before broadcast, with immutable outer-hash/nonce evidence and finalized canonical
`NewTransaction` receipt evidence before the inner transaction ID is bound.
Its checksum is `4f59d7ba919df88f2bef6c409f2449d6d76da47f25d96e02c7c013fd6c9d6fcf`.

Schema V10 preserves every abandoned hashless attempt and its immutable evidence, and removes the
legacy submission constraint that predated `ABANDONED_PREHASH`. Audited
no-broadcast evidence additionally binds the target contract and is limited to an exact
`resolve_epoch` or `create_epoch` operation. The former requires the unchanged resolvable epoch;
the latter requires an exact `EPOCH_UNKNOWN` read failure. Migration 009 also restores a named,
health-pinned finalized-state CHECK. A PREPARE response always includes nullable `auditedRetryNonce`; it is
non-null only for the newly inserted attempt-two child of an audited abandonment, allowing the
keeper to fail closed if either live Bradbury signer nonce changes before submission.

## Synchronization

`POST /api/history-sync` requires the configured bearer secret and an idempotency key. Bodies, selectors, epoch/payout work, response size, and runtime are bounded. The secret is never accepted in URLs or logs.

```powershell
npm run history:sync
```

The public API is a projection, not a wallet authorization source. Browser writes still verify live finalized V8 and EVM state immediately before action.
