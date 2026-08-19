# Liquidity Arena V7 product and protocol specification

## 1. Scope

Liquidity Arena is a StudioNet test-token market game. Once per exact UTC hour, users predict which
of BTC, ETH, BNB, SOL, and XRP will have the highest or lowest percentage return during a fixed
20-minute battle. GenLayer validators derive one shared market vector from five public spot venues;
the StudioNet contract escrows native faucet GEN and settles both objectives.

The release protocol is `LIQUIDITY_ARENA_V7` and the settlement policy is
`CRYPTO_SPOT_1M_MEDIAN_V1`. The system is single-chain StudioNet.

## 2. Fixed release decisions

| Decision | V7 value |
| --- | --- |
| Network | GenLayer StudioNet, chain `61999` |
| Currency | Native faucet test GEN |
| Contract | `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` |
| Epoch cadence | 24 exact UTC hour targets per day |
| Epoch phases | 20m buffer, 20m wagering, 20m battle |
| Assets | BTC, ETH, BNB, SOL, XRP |
| Venues | Binance, OKX, Bybit, Gate, KuCoin |
| Evidence quorum | At least 3 complete five-asset venue baskets |
| Aggregation | Per-asset median; four venues use floor average of middle two |
| Objectives | HIGH and LOW pools in one epoch |
| Normal fee | 2% of losing pool |
| Fee hard cap | 5% |
| Stake range | 0.1–10 GEN per wallet/objective |
| Exceptional modes | Zero-fee eligible-principal refunds |
| Resolution gate | `E+120s` |
| Timeout gate | `E+24h` |
| Keeper privilege | Create fixed-terms epochs only |
| Resolution/timeout | Permissionless |
| Public hosting | Vercel browser and bounded API |
| Durable history | Neon repeated V7/V6 projection live; transaction-proof backfill pending |

## 3. Canonical hourly model

The epoch ID is the integer UTC end timestamp `E`, and `E % 3600 == 0`.

| Time | Phase | Required behavior |
| --- | --- | --- |
| `E-60m` | Buffer begins | Epoch exists and is visible; entry remains closed. |
| `E-40m` | Wagering begins | `enter` accepts valid HIGH/LOW positions. |
| `E-20m` | Wagering closes | Positions lock and battle baseline begins. |
| `E` | Battle ends | Live ROUND projection freezes as provisional. |
| `E+120s` | Resolution available | Any account may submit the shared resolver. |
| `E+24h` | Timeout available | Any account may activate zero-fee refunds if still open. |

The next epoch begins on schedule regardless of the prior transaction's finality. There is no sliding
“one hour after creation” round. Contract timestamps, not scheduler timing or browser clocks, define
every gate.

## 4. Market evidence

For each approved venue and asset, the V7 resolver requests completed one-minute spot candles at the
two fixed boundaries. It validates:

- exact allowlisted venue and market symbol;
- response size and expected JSON schema;
- one-minute interval and immutable boundary timestamps;
- positive prices and consistent quote asset;
- complete five-asset basket in canonical order.

A venue is all-or-nothing. With three to five qualified venues, calculate each venue's signed return
using fixed-point integers, then take the deterministic median for each asset. The resulting vector
contains exactly five `return_ppb` values in BTC/ETH/BNB/SOL/XRP order. HIGH chooses the maximum and
LOW the minimum; equal extrema are ties.

GenLayer validators independently execute the policy and compare results within the fixed return
tolerance. A temporary venue-quorum failure must not guess a winner. It leaves the epoch available
for retry; the 24-hour timeout supplies the deterministic zero-fee escape path.

Public/no-key endpoints are a demo dependency, not proof of uptime, data redistribution, or
settlement licensing. Production-value use requires provider and legal review.

## 5. Wager rules

- A participant can enter HIGH, LOW, or both during `[E-40m,E-20m)`.
- Each wallet selects only one asset per objective in an epoch.
- A wallet may top up the same selected asset before close.
- Every entry is positive native GEN and at least the snapshotted 0.1 GEN minimum.
- Total stake per wallet/objective may not exceed the snapshotted 10 GEN cap.
- An epoch contains both objectives and resolves them from one vector.
- The server never holds participant funds and cannot place or redirect a claim.

## 6. Settlement and fees

For a backed unique winner with at least one losing stake:

```text
losing_pool = total_pool - winning_stake
fee = floor(losing_pool * epoch_fee_bps / 10_000)
payout_pool = total_pool - fee
payout_i = floor(stake_i * payout_pool / winning_stake)
```

The final eligible winning claimant receives the remaining integer dust. The default fee is 200 bps
and is snapshotted at epoch creation. The owner may set only a future fee between 0 and 500 bps.

The following modes return eligible principal and charge no fee:

- tied objective;
- winner has no backing;
- winner is the only backed side, so no losing pool exists;
- a consensus-recorded undetermined result;
- 24-hour timeout.

Unbacked winning assets do not transfer participants' principal to the platform. Only the explicit
normal losing-pool fee becomes accrued platform fees.

## 7. Claims and delivery

Claims are participant-initiated, objective-specific, and pull-based. V7 records claim state,
objective paid amount, winning stake remainder, and player liability before emitting a finalized EOA
value transfer. The system verifies:

1. exact claim parent identity and arguments;
2. `FINALIZED` successful parent execution;
3. matching contract state and claim amount;
4. exactly one expected EOA transfer child;
5. `FINALIZED` successful child and exact recipient/value.

The monitoring process is read-only. It cannot safely replay a claim whose child is ambiguous,
because a delayed first child could later pay and turn a retry into a double payment. A protocol-safe
recovery design remains required before real value.

## 8. Roles

### Owner

- changes the keeper;
- proposes/cancels two-step ownership transfer;
- changes the fee for future epochs within the hard cap;
- may recover epoch creation within the 31-day owner horizon;
- may withdraw accrued fees, subject to solvency.

### Keeper

- creates fixed-terms epochs at least one hour before `E`;
- cannot create more than 26 hours ahead;
- cannot choose fee or stake terms;
- cannot change roles, withdraw, claim for users, or determine results.

### Treasury

- may withdraw only accrued fees;
- has no scheduling, resolution, or participant-claim authority.

### Public callers

- may resolve after `E+120s` and before timeout;
- may activate timeout after `E+24h` if still open.

The owner key is never an automation credential. Dedicated encrypted keeper
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` is installed on-chain and configured for the scheduled
workflow. Default-branch runtime-signer/profile preflight passed; long-run monitoring remains
mandatory.

## 9. Visualization

The current ROUND visualization and the settlement winner must converge:

- battle territory size is a monotonic function of percentage return;
- highest territory/rank represents the greatest return and lowest represents the least;
- momentum controls direction, not rank;
- volatility and cross-source disagreement control turbulence, not payout;
- the live stream is labeled provisional;
- finalized on-chain `return_ppb` replaces the provisional ROUND vector atomically.

Only ROUND resets at `E-20m`. The 1H, 4H, 1D, and 1W tabs are rolling historical market context and
never reset with an epoch.

## 10. Browser and deployment compatibility

The browser uses an allowlisted deployment registry:

- V7 is the only new epoch/wager target after cutover;
- V6 remains accessible for historical epoch reads, wallet positions, claims, and eligible timeouts;
- a query may select only a known `v7` or `v6` alias, never inject a raw contract;
- pending transaction records retain deployment identity across refresh;
- finalized V7 and V6 histories are labeled by protocol/address.

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is operationally drained: due epochs `1787155200`,
`1787158800`, `1787162400`, and `1787166000` were resolved on 2026-08-19. Supported public app and
automation paths expose no new V6 writes. The deployed owner-only creation capability remains and
must not be used; legacy resolve/timeout/claim discoverability remains until liabilities are closed.

The public Vercel site now targets V7 and retains V6 legacy recovery. The dedicated keeper rotation,
funded canary, exact public readiness, and code-artifact CI are complete. Browser/wallet soak and
rollback discipline remain ongoing obligations.

## 11. Keeper and readiness

The reconciler:

- validates StudioNet and the complete live V7 profile;
- derives 24 future exact-hour targets;
- scans the bounded open-epoch index;
- plans missing creates and due permissionless resolve/timeout writes;
- rechecks the active signer before every submission;
- serializes and caps writes;
- captures hashes immediately;
- requires exact receipt identity, `FINALIZED`, successful execution, and post-state.

GitHub Actions runs at minutes 3 and 13 as a best-effort scheduler/watchdog. Contract time remains
authoritative. Readiness checks exact chain/contract/roles/policy/stakes/fee/schedule and all five
feeds. V6 legacy liability is a separately reported compatibility state; an unreadable value is not
zero.

## 12. History and observability

Contract pages are authoritative for epochs, open work, wallet positions, claims, fees, and
liability. The Neon production schema migration has been applied for a durable settled-epoch
projection; initial production ingestion now contains V7 and V6 E19. The projection must be:

- populated only from allowlisted deployments and finalized authoritative reads;
- idempotent across repeated ingestion;
- keyed by chain, contract/protocol, and epoch;
- traceable to resolution/timeout transaction identity where available;
- replaceable from on-chain truth;
- non-blocking for settlement and claims.

The applied migration has normalized marked-DDL SHA-256
`dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2` and raw migration-file SHA-256
`8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`; six tables and four indexes
were read back. Repeated production projection is live: public history contains V7 E20/E19 and V6
E19 without duplicating overlapping V6 E19. Outage recovery and transaction-proof backfill remain
pending; all current `verifiedProofs` arrays are empty.

Monitor public health/readiness, exact-hour coverage, exchange source status, finality lag, keeper
failures, role/config drift, parent/child delivery, V6 legacy liability, and history ingestion lag.

## 13. Security requirements

Tests and review must cover:

- UTC rollover, exact boundary seconds, duplicates, and schedule horizons;
- malformed/stale/revised venue data, redirects, symbol confusion, outliers, and quorum loss;
- role compromise, keeper signer races, owner/treasury separation, and fee-cap bypass;
- integer rounding, maximum values, liability conservation, fee isolation, and duplicate claims;
- uncertain submission, delayed finality, child failure, restart, rate limits, and overlapping jobs;
- arbitrary-address injection, wrong-network signing, CSP/CORS/SSRF, cache poisoning, and secret leaks;
- database forgery, duplicate ingestion, stale history, and unavailable history;
- misleading provisional/final labels and unsafe V6 fallback writes.

## 14. StudioNet deployment record

- address: `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`;
- transaction: `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579`;
- result: `FINALIZED`, `MAJORITY_AGREE`, successful execution;
- source SHA-256:
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- V7 direct tests: 22/22 at deployment review;
- combined V6/V7 direct tests: 37/37 at deployment review;
- initial schedule: one canary plus a full 24-target exact-epoch set created and verified;
- dedicated keeper rotation: complete—keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`, finalized
  transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, exact config/repository
  address match, and encrypted environment secret names installed; two local keeper creates
  `0xe10ce0bf…a9c4` and `0x00398a3c…9058` finalized with verified OPEN post-state, and default-branch
  signer/profile evidence passed in reconcile job `96218469576`; long-run monitoring remains pending;
- funded V7 canary: complete—resolution `0xc2c86fdb…ab66`, three exact claim deliveries, expected
  loser rejection, 1.748 GEN conserved, and exact 0.002 GEN fee withdrawal delivered;
- Neon production migration: applied and six-table/four-index schema read-back passed; initial
  and repeated two-deployment/two-epoch/two-snapshot sync plus public V7 E20/E19 and V6 E19 read-back
  passed, while proof backfill remains pending;
- public V7 cutover: complete—READY deployment `dpl_HZ4iAxBgnzotYUBQVXWxS8uDguW3` from verified code
  commit `45be825084cce9e97579ca42266e318e2e97fe17`, with public readiness and legacy V6 read-back `200`.

Observed StudioNet finality is not an SLA. The recorded deploy finalized in about 36 seconds, but the
system always waits for actual finality rather than a timer.

## 15. Definition of done

The V7 StudioNet demo is submission-complete only when:

1. all exact-hour, adapter, contract, keeper, browser, server, and history tests pass;
2. the dedicated keeper is encrypted, installed, rotated on-chain, and monitored without owner
   material;
3. a funded two-wallet V7 canary proves both objectives, exact fee/refund math, loser rejection,
   claims, liabilities, and parent/child value delivery;
4. V6 public app/automation paths are demonstrably drained for new writes, the retained owner
   creation capability remains unused, and every legacy position remains discoverable/recoverable;
5. Neon migration and idempotent ingestion pass and chain truth remains authoritative;
6. the V7 Vercel release passes health, readiness, RPC, stream, history, wallet, CSP, console, and
   mobile checks, with a tested rollback;
7. timeout behavior and delayed-finality/operator outage behavior are evidenced or explicitly
   disclosed as incomplete;
8. independent security and provider data-use/legal review are complete;
9. deployment hashes, configuration, funded proofs, screenshots, demo video, and known limitations
   are published;
10. every user-facing surface labels StudioNet and faucet GEN as temporary test infrastructure.

Documentation alone does not satisfy these gates. Until they pass, the truthful status is a deployed
V7 StudioNet release candidate with V6 public compatibility, not a production-ready wagering system.
