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

- migrations 001–004 have exact checksums;
- no later migration exists;
- exactly one configured Bradbury V8 deployment is active;
- legacy deployments are inactive;
- epoch and payout projections are complete;
- required payout-stage evidence is present and internally consistent;
- keeper journal schema V4 is healthy.

Migration 004 is append-only and intentionally refuses a second application. Its checksum is `1c713e2f54f873b6ffd8ae771ac9dd9e67ed61293d667b48a394e2182a26e910`.

## Synchronization

`POST /api/history-sync` requires the configured bearer secret and an idempotency key. Bodies, selectors, epoch/payout work, response size, and runtime are bounded. The secret is never accepted in URLs or logs.

```powershell
npm run history:sync
```

The public API is a projection, not a wallet authorization source. Browser writes still verify live finalized V8 and EVM state immediately before action.
