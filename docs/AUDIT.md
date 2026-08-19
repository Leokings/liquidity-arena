# Liquidity Arena V7 release audit ledger — 2026-08-19

## Conclusion

The deployed V7 source passes GenVM lint and its direct test suite. The redesign materially reduces
scheduled-key authority: the keeper can create fixed-terms hourly epochs but cannot choose stake
limits, change fees, administer roles, withdraw funds, or determine a result. Resolution and timeout
are permissionless.

This is a release audit ledger, not an independent external audit and not a production-safety
certificate. The funded V7 canary and Neon production schema migration are complete, but
long-run keeper/drain monitoring, the first live action-bearing run under the merged receipt grace,
durable-history outage recovery/broader proof coverage, the 24-hour live timeout path, and
claim-child failure recovery remain incomplete gates. Dedicated keeper rotation, default-branch
signer/profile preflight, repeated history projection, selected proof backfill, and public V7 cutover
are complete.

## V7 deployment identity

| Field | Recorded value |
| --- | --- |
| Network | GenLayer StudioNet, chain `61999` |
| Protocol | `LIQUIDITY_ARENA_V7` |
| Policy | `CRYPTO_SPOT_1M_MEDIAN_V1` |
| Contract | `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` |
| Deployment tx | `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` |
| Result | `FINALIZED`, `MAJORITY_AGREE`, successful execution |
| Recorded deployment time | `2026-08-19T17:15:58.617644Z` |
| Recorded finalization time | `2026-08-19T17:16:34.249123Z` |
| Source SHA-256 | `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F` |
| Source | `contracts/LiquidityArenaV7.py` |
| Currency | Native faucet test GEN |
| Fee | 200 bps default; 500 bps hard cap |
| Stakes | 0.1 GEN minimum; 10 GEN maximum per wallet/objective |

The machine-readable evidence is in
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).

## Completed V7 verification

- deployment receipt finalized with majority agreement and successful leader execution;
- local source hash recorded as
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- live `get_config`, asset catalog, venue catalog, roles, fee, stake limits, and timing read-back;
- GenVM lint passed with 29 schema methods;
- V7 direct suite passed 22/22 and the combined V6/V7 direct suite passed 37/37 at deployment review;
- 25 exact UTC hourly epochs were bootstrapped and read back: canary `1787166000` plus a 24-target
  full-day set from `1787169600` through `1787252400`; the first/final full-day creation hashes are
  `0x7b94b2d0…7726` and `0x443afcf7…7677f`;
- keeper tests cover fixed profile checks, 24-target derivation, bounded open-index reconciliation,
  serialized writes, receipt/post-state verification, and the signer recheck immediately before
  each write;
- dedicated keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` replaced the bootstrap wallet through owner
  transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, which reached `FINALIZED`
  with `MAJORITY_AGREE` and successful leader execution; exact `get_config` read-back and repository
  variable `V7_KEEPER_ADDRESS` match, and the two encrypted keeper secret names are present in the
  `studionet-keeper` environment;
- local execution as that dedicated keeper created epoch `1787256000` through finalized transaction
  `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4` and epoch `1787259600` through
  finalized transaction `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`;
  both exact post-states were verified OPEN, proving the limited on-chain role independently of CI;
- scheduled V7 run `32298454771` passed reconciliation; its separate history job failed on the
  StudioNet provider quota and was superseded by successful workflow-dispatch run `32299468899`,
  whose reconcile job `96218469576` passed exact profile/runtime-signer checks and correctly planned
  no actions;
- history job `96218806119` in run `32299468899` synchronized two deployments, two epochs, and two
  full snapshots from state read at `2026-08-19T20:38:39.397Z`; public V7 and V6 E19 records are
  resolved/determined;
- later successful workflow-dispatch run `32300282482` on main commit
  `45be825084cce9e97579ca42266e318e2e97fe17`
  passed reconcile job `96221017562` and history job `96221327115`; public history then contained V7
  E20/E19 and V6 E19 without duplicating overlapping V6 E19, with `proofsVerified=0`;
- StudioNet history receipt fix `e5627ebd270a7c6d5291151795b0af6442eba0a6` passed CI run
  `32308815377` and reuses the fail-closed finalized consensus/leader receipt validator;
- protected backfill run `32309637237`, job `96249796253`, passed all quota-spaced batches with 11
  accepted and zero rejected proof requests: one deployment proof, nine V7 E19 epoch proofs, and one
  epochless fee-withdrawal parent; public E19 read-back contains exactly one creation, four wagers,
  one resolution, and three credited claim proofs;
- keeper receipt-grace commit `958e51743a821606ca78881e6bcc8fb0a34a8e8f` passed CI run
  `32310160397` and performs seven same-hash attempts with 315 seconds of outer backoff and no write
  resubmission; its first live action-bearing scheduled-run evidence remains pending;
- scheduled legacy V6 drain run `32297047031` completed successfully without any creation action;
- the dual-deployment browser registry is designed to allow only V7 new writes and V6 legacy
  reads/resolves/timeouts/claims, with explicit deployment aliases rather than arbitrary addresses;
- the read-only claim-delivery monitor requires an explicit V6 or V7 deployment profile and tests
  both identities;
- the Neon production migration with normalized marked-DDL SHA-256
  `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
  (raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`)
  was applied, and six expected tables plus four expected indexes were read back;
- CI run `32308815377` passed browser/operator job `96247333491` and intelligent-contracts job
  `96247333299`; READY deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` serves the production alias
  with public health/readiness/history-health `200`; Vercel metadata anchors it to
  `e5627ebd270a7c6d5291151795b0af6442eba0a6` and records `gitDirty=1`, while exact browser artifact
  identity is bundle `market-BHlwjm1W.js` SHA-256
  `c0be752a9a1407e76a1f417256f220f068969fdcf80f88872683e33f2c96e79e`;
- the funded V7 canary for epoch `1787166000` completed with finalized resolution
  `0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66`, expected settlement modes,
  three exact participant claim deliveries, loser rejection, balance conservation, and exact fee
  withdrawal.

The four finalized/post-state-verified 0.1 GEN wagers were:

- account A: HIGH BTC `0x58f69072…c4fa` and LOW XRP `0xa6284710…5831`;
- account B: HIGH ETH `0xc0d5401c…2a19` and LOW BNB `0x80c1d306…7e9c`.

The four-venue result selected unbacked SOL HIGH (`4394531` ppb) and backed BNB LOW (`170154` ppb).
Two 0.100 GEN HIGH refunds and the 0.198 GEN LOW payout were delivered through three finalized exact
parent/child pairs. The losing LOW XRP claim `0xb0d9889a…e688` failed as expected without changing
state. The 0.002 GEN fee was delivered through parent `0x3df8d942…bb01f` and child
`0x566082ce…470e`. Balances moved from A/B/contract 0.700/0.648/0.400 GEN before resolution, to
0.800/0.946/0.002 after claims, to 0.802/0.946/0 after fee withdrawal. Liability and accrued fees
ended at zero and 1.748 GEN was conserved throughout. Full hashes are in the machine-readable
deployment record.

## Authorization review

V7 changes `create_epoch` from a parameterized V6 operator action to `create_epoch(E)`. Minimum and
maximum stake are contract-level values and are snapshotted automatically. Only owner/keeper can
create; keeper horizon is 26 hours and minimum notice is one hour. The owner controls fee and keeper,
ownership transfer is propose/accept, and owner/treasury can withdraw only accrued fees.

`resolve_epoch` and `activate_timeout_refund` are permissionless after immutable gates. A compromised
keeper therefore cannot select winners or block every other caller from settlement. The production
workflow must use a dedicated encrypted keeper, never the owner. Rotation away from the temporary
bootstrap wallet is complete and exact live/repository identity matches; a successful activated
workflow run now proves the CI runtime signer/profile preflight. Two finalized local keeper creates
prove that the dedicated account can exercise the intended limited `create_epoch` authority. A
no-action reconcile proves configuration and coverage at that observation, not continuous uptime.

## Evidence and accounting review

The V7 policy retains the fixed five-venue, five-asset, 3-of-5 complete-basket median. Both objectives
use one vector. Temporary quorum failure cannot produce a guessed winner; the 24-hour timeout remains
the deterministic zero-fee escape path.

The fee remains a snapshotted percentage of losing stake, not principal from an unbacked winner.
Ties, unbacked winners, no losing side, undetermined settlement, and timeout return eligible
principal at zero fee. Only accrued fees are treasury-withdrawable. Effects-first pull claims avoid
an unbounded payout loop and duplicate economic claims.

The remaining value-delivery concern is asynchronous EOA child failure. Because a delayed child can
still finalize, automatically replaying a recorded claim is unsafe. The included monitor intentionally
does not submit or retry transactions; it only proves delivery or reports an ambiguous state.

## Legacy V6 evidence and drain

V6 at `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` previously proved a funded four-position round:

- one shared four-venue resolution;
- SOL HIGH with an unbacked-winner refund;
- BNB LOW with an exact 0.198 GEN payout and 0.002 GEN fee;
- three finalized claim-parent/EOA-child pairs;
- expected loser rejection and zero remaining player liability.

Full hashes and atto balance deltas remain in
[`../deployments/studionet-v6.json`](../deployments/studionet-v6.json). This is regression evidence,
not V7 funded proof. V6 due epochs `1787155200` and `1787158800` were resolved on 2026-08-19 by
`0xae0ce453…e1480` and `0x09f01c2a…e735`. An earlier pre-resolution snapshot left epochs
`1787162400` and `1787166000` OPEN (RESOLVABLE and SCHEDULED); later permissionless drains resolved
them with `0x03f2ac80…0399` and `0x7e8030f0…27bb`. Supported public app and automation paths expose
no V6 creation or new-wager action, while read/resolve/timeout/claim recovery remains available. The
deployed V6 owner creation capability still exists and must remain unused until the legacy surface
is fully retired.

## Open findings and release gates

### P1 — production scheduler long-run monitoring remains pending

The dedicated encrypted keeper is installed, its on-chain role was finalized/read back, the GitHub
configuration matches, and default-branch signer/profile preflight passed. Continue scheduled-run
soak, prove no owner key or owner-capable keystore is available to automation, and add alerts for
coverage, source quorum, finality, history quota failures, and role drift. Seven-attempt/315-second
same-hash receipt polling is merged and CI-tested, but the first live action-bearing scheduled run
under it is explicitly pending.

### P1 — asynchronous child failure has no safe retry

Healthy parent/child delivery has been proven on both V6 and the funded V7 canary. Real-value use
would still need a protocol delivery guarantee or a recoverable transfer design for an ambiguous
failed/delayed child that cannot double-pay. The read-only monitor is correct but is detection, not
recovery.

### P1 — public cutover completed; soak and rollback discipline remain

Current READY Vercel deployment `dpl_7qDFq9UxkT4oatbuqJXaNooYYUWi` is live at
`https://liquidity-arena-elththdkj-leokings588-5902s-projects.vercel.app`. Its metadata source anchor
is `e5627ebd270a7c6d5291151795b0af6442eba0a6` with `gitDirty=1`; the exact browser bundle/hash is
recorded above. The public alias targets V7, health/readiness/history-health returned `200`, V6
remained readable with zero known liability, and the previous V6 compatibility deployment remains a
rollback artifact. Continue browser/wallet soak and ensure rollback never reactivates V6 creation.

### P2 — durable history outage recovery and broader proof coverage are pending

The Neon migration/schema read-back and two bounded production syncs passed. Public history now
contains full V7 E20/E19 and V6 E19 determined snapshots with no duplicate overlapping V6 E19 row.
Selected proof backfill passed: V7 E19 contains nine finalized proofs, while its deployment proof and
epochless fee parent are stored separately. Access-control/outage recovery and proof coverage beyond
that selected set still require verification. No projection record may be described as an oracle.

### P2 — operational and external reviews remain

Live timeout evidence, longer StudioNet soak, provider data-use/legal review, independent security
review, monitoring, and rollback rehearsal remain. StudioNet's observed sub-minute finality is not an
SLA.

## Required final verification

Before submission, record fresh results for:

- full JavaScript tests, production build, dependency audit, GenVM lint, and direct tests;
- preservation of the exact deployed-source/config/schema and finalized keeper-rotation read-back;
- preservation/review of the funded V7 canary and claim-child evidence;
- V6 legacy liability/read/resolve/timeout/claim verification, public-write gating, and owner
  abstention monitoring;
- Neon outage recovery and extended proof coverage against the migrated, repeatedly populated schema;
- public Vercel health, readiness, same-origin RPC, exchange stream, CSP, console, wallet, history,
  and rollback checks;
- an independent security report and closure of all critical/high findings.

No observation in this document is a finality promise. Transactions and value are trusted only after
`FINALIZED`, successful execution, exact post-state, and, when applicable, the exact finalized EOA
child.
