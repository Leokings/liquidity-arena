# Liquidity Arena V7 release audit ledger — 2026-08-19

## Conclusion

The deployed V7 source passes GenVM lint and its direct test suite. The redesign materially reduces
scheduled-key authority: the keeper can create fixed-terms hourly epochs but cannot choose stake
limits, change fees, administer roles, withdraw funds, or determine a result. Resolution and timeout
are permissionless.

This is a release audit ledger, not an independent external audit and not a production-safety
certificate. The funded V7 canary and Neon production schema migration are complete, but
default-branch keeper activation/monitoring, public browser cutover, initial durable-history
ingestion, the 24-hour live timeout path, and claim-child failure recovery remain incomplete gates.
The dedicated keeper rotation itself is complete. The public Vercel site remains on a verified V6
legacy-recovery compatibility release; V7 public cutover is still pending.

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
- the dual-deployment browser registry is designed to allow only V7 new writes and V6 legacy
  reads/resolves/timeouts/claims, with explicit deployment aliases rather than arbitrary addresses;
- the read-only claim-delivery monitor requires an explicit V6 or V7 deployment profile and tests
  both identities;
- the Neon production migration with normalized marked-DDL SHA-256
  `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
  (raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`)
  was applied, and six expected tables plus four expected indexes were read back;
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
workflow run is still needed to prove the CI runtime signer and schedule coverage. Two finalized
local keeper creates already prove that the dedicated account can exercise the intended limited
`create_epoch` authority.

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

### P1 — production scheduler activation and monitoring are pending

The dedicated encrypted keeper is installed, its on-chain role was finalized/read back, and the
GitHub environment secret names plus public repository variable are configured. Run the
default-branch workflow, prove that its imported signer is the exact recorded keeper and that no
owner key or owner-capable keystore is available to automation, then add alerts for coverage, source
quorum, finality, and role drift.

### P1 — asynchronous child failure has no safe retry

Healthy parent/child delivery has been proven on both V6 and the funded V7 canary. Real-value use
would still need a protocol delivery guarantee or a recoverable transfer design for an ambiguous
failed/delayed child that cannot double-pay. The read-only monitor is correct but is detection, not
recovery.

### P1 — public cutover is pending

The Vercel production site still targets V6. With keeper rotation complete, deploy the exact V7
configuration, verify new V7 writes and old V6 claims, exercise health/readiness/API/browser flows,
and retain the last verified artifact for rollback. Rollback must not reactivate V6 round creation.

Current compatibility evidence is deployment `dpl_DQEvnGup417wvTxuxzeNfJvySiM5`, immutable URL
`https://liquidity-arena-2qlh5a5kn-leokings588-5902s-projects.vercel.app`, source commit
`dbc2288a6adc745261128a55b555e8a34574db1e`, and bundle `market-Co0HBgo2.js` with SHA-256
`484b3c8ba3e40cb249a694ecd30bbe97df6685e1c858ea54639e8039eec43cd9`. Both default and explicit V7
routes disable new wagers. `/readyz` is expected `503` because the active legacy V6 compatibility
artifact lacks future keeper coverage. Six older deployments were retired/deleted.

### P2 — durable history ingestion is pending

The Neon production migration is applied and its schema read-back passed. Initial and repeated
idempotent ingestion, access-control behavior, health behavior, and authoritative-chain
reconciliation still require verification. It must not be described as populated live history or as
an oracle until those checks complete.

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
- Neon initial and repeated ingestion idempotency against the already migrated schema;
- public Vercel health, readiness, same-origin RPC, exchange stream, CSP, console, wallet, history,
  and rollback checks;
- an independent security report and closure of all critical/high findings.

No observation in this document is a finality promise. Transactions and value are trusted only after
`FINALIZED`, successful execution, exact post-state, and, when applicable, the exact finalized EOA
child.
