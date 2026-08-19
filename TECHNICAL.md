# Liquidity Arena V7 technical architecture

This document describes the deployed StudioNet V7 release target. V7 is finalized at
`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`, and the public Vercel browser now targets V7 with V6
legacy recovery retained. The dedicated keeper rotation and funded V7 canary are
complete. The public app and automation do not create V6 epochs or route new V6 wagers; the deployed
V6 owner capability
still exists and must not be used. V6 remains available for legacy reads, claims, and eligible
permissionless resolve/timeouts.

## System boundary

| Component | Authority and responsibility |
| --- | --- |
| Browser | Liquid visualization, epoch selection, wallet intent, finalized receipt recovery, V7 writes after cutover, and V6 legacy read/resolve/timeout/claim recovery |
| Web/API service | Live exchange fan-out, bounded historical candles, same-origin StudioNet RPC adapter, health, readiness, caching, and rate limiting |
| StudioNet V7 contract | Exact-hour schedule, test-GEN escrow, shared result, HIGH/LOW accounting, fees, refunds, claims, and authoritative history |
| Limited keeper | Creates missing future epochs; may also invoke permissionless resolve/timeout methods, but has no owner or treasury powers |
| Durable history projection | Neon-backed copy of settled public state for browsing and operations; migration plus repeated V7/V6 projection passed, proof backfill remains pending, and it is never settlement authority |

GenLayer validators and the V7 contract are the settlement authority. The live stream, API cache,
browser animation, keeper plan, and database projection cannot choose or alter a winner.

## Canonical epoch

An epoch is the exact UTC end timestamp `E`, with `E % 3600 == 0`:

```text
E-60m          E-40m          E-20m                         E        E+120s
| BUFFER       | WAGERING     | BATTLE                      | PUBLISH | RESOLVABLE
```

- creation must occur at least one hour before `E`;
- wager open: `E - 2400`;
- wager close and battle baseline: `E - 1200`;
- battle end: `E`;
- resolution gate: `E + 120`;
- timeout-refund gate: `E + 86400`.

There are exactly 24 epoch targets per UTC day. A later epoch proceeds independently while an older
transaction is still awaiting GenLayer finality.

## Evidence policy

V7 fixes `CRYPTO_SPOT_1M_MEDIAN_V1`, assets BTC/ETH/BNB/SOL/XRP, and venues Binance/OKX/Bybit/Gate/
KuCoin in contract source. For each venue the resolver:

1. requests the completed one-minute candle whose open establishes the `E-20m` baseline and the
   completed candle ending at `E`;
2. validates the fixed spot symbol, timestamp alignment, response bounds, schema, and positive
   prices for all five assets;
3. rejects the entire venue if any asset is invalid;
4. calculates signed fixed-point returns in parts per billion (`1e9` scale);
5. requires at least three complete venue baskets;
6. selects the per-asset median across the same qualifying venue set; with four venues, it uses the
   floor average of the middle two signed values.

The shared five-return vector selects `HIGH` by maximum and `LOW` by minimum. Equal extrema produce
a tied objective. GenLayer validators independently rerun the evidence logic and compare the result
within the contract's fixed tolerance before consensus can finalize the write.

Fewer than three complete venues is a retryable quorum failure and does not authorize a guessed
winner. If the epoch remains open for 24 hours, the permissionless timeout path makes both pools
zero-fee refundable.

## V7 contract surface

Important writes:

```text
set_keeper(address)                         owner
propose_ownership(address)                  owner
cancel_ownership_transfer()                 owner
accept_ownership()                          pending owner
set_platform_fee_bps(bps)                   owner, maximum 500
create_epoch(E)                             owner or keeper
enter(E, HIGH|LOW, asset) payable           participant
resolve_epoch(E)                            permissionless after E+120s
activate_timeout_refund(E)                  permissionless after E+24h
claim(E, HIGH|LOW)                          participant
withdraw_accrued_fees(amount_atto)          owner or treasury
```

V7 moves stake limits out of `create_epoch`. The immutable deployed limits are 0.1 GEN minimum and
10 GEN maximum per wallet/objective; the epoch snapshots those values and the current fee. This
prevents a compromised keeper from choosing economic parameters while scheduling.

The keeper may create at most 26 hours ahead. The owner may recover scheduling but cannot create
more than 31 days ahead. Ownership transfer is two-step. Changing the keeper or fee affects only
future actions/epochs; already created epoch snapshots remain immutable.

Important views include `get_config`, asset and venue catalogs, total/open epoch counts and bounded
pages, `get_epoch`, `get_epoch_asset`, `get_objective`, `get_entry`, `get_claim_quote`, bounded wallet
position pages, `get_fee_state`, and total player liability.

## Accounting

Amounts are integer attoGEN (`10^18` attoGEN per GEN). HIGH and LOW have separate stake and payout
accounting even though they share one market vector.

For a backed winner with a losing side:

```text
losing_pool = total_pool - winning_stake
fee = floor(losing_pool * epoch_fee_bps / 10_000)
payout_pool = total_pool - fee
wallet_payout = floor(wallet_winning_stake * payout_pool / winning_stake)
```

The last eligible winning claimant receives any integer remainder. The default epoch fee is 200 bps
(2%) and the hard configuration cap is 500 bps (5%). A tie, unbacked winner, no losing side,
consensus-recorded undetermined result, or timeout returns eligible principal and accrues no fee.

Only accrued platform fees may be withdrawn. The treasury withdrawal check preserves:

```text
contract balance >= outstanding participant liability + accrued unwithdrawn fees
```

Claims are pull-based and effects-first. V7 emits the exact EOA transfer on finalization. The
off-chain monitoring verifies the parent, child, recipient, amount, finality, and credited-value proof
but is strictly read-only. The checked-in claim monitor requires an explicit V6 or V7 deployment
profile and has tests for both identities. The live V7 canary proved three finalized claim-parent/
EOA-child deliveries and an exact fee-withdrawal parent/child delivery. There is no blind claim retry
because a delayed original child could later pay and make a retry a double payment.

## Keeper and readiness

The V7 reconciler derives 24 future exact-hour targets, scans only the bounded on-chain open-epoch
index, and produces a dry-run plan by default. Before every write it verifies:

- StudioNet chain `61999`;
- exact protocol, policy, assets, venues, timing, precision, fee, and stake limits;
- expected owner, keeper, and treasury addresses;
- current signer equals the configured keeper immediately before submission;
- exact transaction recipient, method, arguments, `FINALIZED` successful execution, and post-state.

The live keeper is `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`. Owner transaction
`0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc` finalized with
`MAJORITY_AGREE` and successful leader execution, and exact `get_config` read-back confirmed the
role. The matching encrypted-keystore secret names are present in GitHub environment
`studionet-keeper`, and repository variable `V7_KEEPER_ADDRESS` records the same address.
Local execution as that keeper created epoch `1787256000` with finalized transaction
`0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4` and epoch `1787259600` with
finalized transaction `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`;
both exact post-states were verified OPEN. This proves the limited on-chain role, not scheduled
workflow operation.

The checked-in GitHub Actions workflow is configured for minutes 3 and 13 as a best-effort scheduler/
watchdog. Scheduled run `32298454771` passed reconciliation but its independent history job hit the
provider quota. Later workflow-dispatch run `32299468899` passed exact-profile/runtime-signer
reconciliation with no actions and completed bounded history sync. Contract time, not cron, defines
every gate. `resolve_epoch` and `activate_timeout_refund` remain permissionless, so scheduler loss
cannot create an exclusive operator deadlock.

Readiness shares the same deployment configuration as the server. For V7 it checks chain, contract
identity, roles, stake and fee policy, exact-hour coverage, and all five live feeds. A V6 legacy
liability check is reported separately and does not turn an unreadable value into a false zero.

## Visualization and history

The ROUND layer resets to an equal baseline at `E-20m`. During battle, live exchange data produces a
clearly provisional estimate. Territory area is monotonically derived from return; flow direction
uses momentum and turbulence uses volatility/disagreement. At finality, the five V7 `return_ppb`
values replace the provisional display for that epoch.

The 1H, 4H, 1D, and 1W views are rolling context and never reset with the wager epoch. The contract's
paged epoch and wallet views are authoritative. The Neon production migration has been applied and
its expected six tables and four indexes read back. History job `96218806119` then synchronized two
deployments, two E19 epochs, and two full snapshots from state read at
`2026-08-19T20:38:39.397Z`. Public V7 and V6 records are resolved/determined; their `verifiedProofs`
arrays are empty. A second successful run, `32300282482`, synchronized V7 E20 and overlapping V6
E19 without duplication; public history now contains V7 E20/E19 and V6 E19. Projection repetition is
proven, while proof backfill and outage recovery remain separate pending evidence.

## V6 compatibility boundary

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is not a fallback write target. Its final due epochs
`1787155200` and `1787158800` were resolved on 2026-08-19 by `0xae0ce453…e1480` and
`0x09f01c2a…e735`. The drain workflow contains no creation action and the public registry disables
new V6 wagers, but the deployed owner-only `create_epoch` method remains callable and must not be
used. An earlier pre-resolution observation left epochs `1787162400` and `1787166000` OPEN
(RESOLVABLE and SCHEDULED); later drains resolved them with `0x03f2ac80…0399` and
`0x7e8030f0…27bb`. The browser
deployment registry must enforce:

- V7 only for new epoch discovery and new wagers after cutover;
- V6 only for old epoch reads, wallet history, eligible resolves/timeouts, and claims;
- explicit allowlisted deployment aliases, never an arbitrary address from the URL;
- a rollback that can restore the last verified browser artifact without writing new V6 rounds.

## Deployment and finality

V7 deployment transaction
`0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` finalized with
`MAJORITY_AGREE` and successful execution. The recorded source SHA-256 is
`2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`.

Twenty-five V7 epochs were seeded: canary epoch `1787166000` plus 24 exact-hour targets from
`1787169600` through `1787252400`. The full-day seed begins with creation transaction
`0x7b94b2d0…7726` and ends with `0x443afcf7…7677f`; this is creation evidence, not proof that the
scheduled workflow is continuously active. Two additional exact-hour epochs, `1787256000` and
`1787259600`, were then created and OPEN-state verified through the dedicated keeper transactions
recorded above.

The funded canary resolved with transaction
`0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66` from four qualified venues.
HIGH selected unbacked SOL at `4394531` ppb and refunded both 0.1 GEN HIGH entries. LOW selected BNB
at `170154` ppb and paid 0.198 GEN after a 0.002 GEN fee. Three exact claim children delivered 0.398
GEN, an ineligible LOW XRP claim was rejected without state change, and the fee child delivered the
remaining 0.002 GEN to treasury. Balances moved from 0.700/0.648/0.400 GEN before resolution, to
0.800/0.946/0.002 after claims, to 0.802/0.946/0 after fee withdrawal; 1.748 GEN was conserved at
each checkpoint.

The verified code artifact immediately before this evidence-only documentation refresh is source
commit `45be825084cce9e97579ca42266e318e2e97fe17`. CI run `32299866117` passed browser/operator job
`96219707620` and intelligent-contracts job `96219707869`. Vercel deployment
`dpl_HZ4iAxBgnzotYUBQVXWxS8uDguW3` is READY at
`https://liquidity-arena-etugq1wnj-leokings588-5902s-projects.vercel.app` and serves the production
alias. Bundle `market-DECrh0Dy.js` has SHA-256
`d82c6975f0275add1e355a3d298a0170aae483f26788d4e9431a2a259cfe85ac`; health, readiness, and history
health returned `200`. Readiness identified V7, two covered epochs, five feeds, and readable V6 with
zero known player liability. The subsequent evidence-only docs commit is outside that code artifact.

Observed StudioNet finality has been in the tens-of-seconds range, and an earlier V6 funded resolver
was observed at 53.38 seconds record-to-finalized. These are samples for UX design only, not a bound
or SLA. The application requires `FINALIZED`; it never treats `ACCEPTED` as settlement or payment
delivery.

## Current release gaps

- long-run V7 keeper and V6 drain workflow monitoring/alerting;
- transaction-proof backfill and database-outage recovery after successful repeated Neon projection;
- continued public browser/wallet soak plus a rollback rehearsal that never re-enables V6 writes;
- live 24-hour timeout evidence and a documented safe boundary for asynchronous child failure;
- independent contract/web/operations review and provider data-use/legal review.

See [the V7 deployment note](docs/STUDIONET-V7.md) for the current gate ledger.
