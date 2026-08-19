# Public history API

`GET /api/history` and `HEAD /api/history` expose bounded, read-only StudioNet history. Responses use
`cache-control: no-store`; `limit` defaults to 20 and is restricted to 1-50. When `page.nextCursor` is
non-null, pass it back unchanged with the same view and deployment filter.

## Views

- `view=epochs` lists hourly contract epochs. `deployment=v6|v7` is optional.
- `view=deployments` lists configured contract deployments and accepts no deployment filter.
- `view=proofs&deployment=v6|v7` lists every stored, independently verified transaction-proof row
  for the selected deployment alias. The deployment filter is required. Proof pages use a stable
  descending transaction-hash keyset; cursors are opaque and scoped to the selected alias.

The proof response has this shape:

```json
{
  "status": "ok",
  "dataScope": "VERIFIED_TRANSACTION_PROOFS",
  "continuousVisualizationTicksStored": false,
  "view": "proofs",
  "deployment": "v7",
  "page": { "limit": 20, "nextCursor": null },
  "items": [
    {
      "transactionHash": "0x...",
      "deploymentId": "studionet:0x...",
      "deploymentAlias": "v7",
      "epochEndTimestamp": null,
      "kind": "FEE_WITHDRAWAL",
      "method": "withdraw_accrued_fees",
      "status": "FINALIZED",
      "valueAtto": "0",
      "valueCredited": null,
      "parentTransactionHash": null,
      "childTransactionHashes": [],
      "verifiedAt": "2026-08-19T22:42:37.000Z"
    }
  ]
}
```

The public projection intentionally omits decoded arguments, sender/recipient addresses, execution
payloads, proof metadata, and raw RPC receipts. `valueAtto` is kind-dependent: for `WAGER` it is the
attached stake; for `CLAIM` it is the independently verified credited child amount; for zero-value
contract calls such as `FEE_WITHDRAWAL` it is the attached value (`0`); and for `DEPLOYMENT` it is
`null`. A `FEE_WITHDRAWAL` item proves that the parent contract call finalized successfully.
`valueCredited: null` and an empty `childTransactionHashes` array do not prove that a treasury transfer
child finalized or was credited; delivery evidence must be verified separately.
