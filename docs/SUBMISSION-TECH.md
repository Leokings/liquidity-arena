# Liquidity Arena V7 submission technical note

## Product

Liquidity Arena is a StudioNet test-token application for exact-hour crypto return battles across
BTC, ETH, BNB, SOL, and XRP. Each UTC hour produces one canonical result vector and two independent
pari-mutuel objectives: highest return (`HIGH`) and lowest return (`LOW`).

## Release target

| Component | V7 target |
| --- | --- |
| Intelligent contract | `contracts/LiquidityArenaV7.py` |
| Protocol / policy | `LIQUIDITY_ARENA_V7` / `CRYPTO_SPOT_1M_MEDIAN_V1` |
| StudioNet address | `0xb2ae59aE641f571726Ae81E30080f8c2192b15EF` |
| Deployment tx | `0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579` |
| Currency | Native faucet test GEN, 18 decimals |
| Fee | 2% of losing pool by default; 5% hard cap |
| Stake limits | 0.1–10 GEN per wallet/objective |
| Evidence | Binance, OKX, Bybit, Gate, KuCoin; at least 3 complete baskets |
| Operator | Limited epoch-creation keeper; permissionless resolve/timeout |
| Public host | [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app), V7 active/READY with V6 legacy recovery |

V6 `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1` is retained for historical reads, eligible
resolves/timeouts, and claims. Its due epochs `1787155200` and `1787158800` were resolved on
2026-08-19 by `0xae0ce453…e1480` and `0x09f01c2a…e735`. A later permissionless drain
resolved epoch `1787162400` with `0x03f2ac80…0399`, and another resolved `1787166000` with
`0x7e8030f0…27bb`. Supported public app/automation paths expose no V6 creation or new wagers, but the
deployed owner creation capability remains and must not be used.

## User-visible timing

For exact hour `E`:

- buffer `[E-60m,E-40m)`;
- wagers `[E-40m,E-20m)`;
- scored battle `[E-20m,E)`;
- evidence publication through `E+120s`;
- permissionless resolution until `E+24h`;
- permissionless zero-fee timeout refund from `E+24h` if still open.

There are exactly 24 targets each UTC day. Later epochs continue while an older transaction awaits
finality.

## Settlement and payment

GenLayer validators independently obtain completed one-minute boundary candles. A venue qualifies
only with a valid five-asset vector. The contract uses the deterministic per-asset median from three
to five venues and commits a shared result for both objectives.

A backed winner receives principal plus its pro-rata share of losing stake after the snapshotted fee.
A tie, unbacked winner, no losing side, undetermined result, or timeout returns eligible principal
with zero fee. Participants pull claims directly from V7; no custodian or server pays them.

The UI and operator never unlock at `ACCEPTED`. They require the exact transaction to be `FINALIZED`,
successful authoritative execution, matching state, and, for native payments, the finalized EOA
transfer child. The claim-delivery monitor requires an explicit V6 or V7 deployment profile, is
read-only, and does not perform unsafe retries.

## Visualization

During battle, exchange streams provide a clearly labeled provisional liquid map. Territory area is
driven by return, direction by momentum, and turbulence by volatility/disagreement. After consensus,
the V7 `return_ppb` vector becomes the permanent ROUND result. Rolling 1H/4H/1D/1W views are
historical context and do not reset with the hourly wager round.

## Evidence completed

- V7 deployment finalized with `MAJORITY_AGREE` and successful execution;
- source SHA-256 recorded as
  `2306688F2FA3745ED36C4D230E83044624F8B4EAA8080159AE97A64CA81C7B0F`;
- live contract configuration, role, catalog, fee, stake, and timing read-back;
- GenVM lint passed with a 29-method schema;
- V7 direct tests passed 22/22; combined V6/V7 direct tests passed 37/37 at deployment review;
- 25 epochs were seeded and verified: one canary plus a full 24-hour exact-epoch schedule, whose
  first/final creation hashes are `0x7b94b2d0…7726` and `0x443afcf7…7677f`;
- V7 keeper safeguards and the dual-deployment registry are implemented; READY production deployment
  `dpl_HZ4iAxBgnzotYUBQVXWxS8uDguW3` serves V7 while preserving V6 legacy recovery. Its immutable URL
  is `https://liquidity-arena-etugq1wnj-leokings588-5902s-projects.vercel.app`, source commit is
  `45be825084cce9e97579ca42266e318e2e97fe17`, and `market-DECrh0Dy.js` has SHA-256
  `d82c6975f0275add1e355a3d298a0170aae483f26788d4e9431a2a259cfe85ac`;
- dedicated keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` was installed by owner transaction
  `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`, which finalized with majority
  agreement and successful leader execution; exact config read-back and GitHub repository variable
  match, and the encrypted keeper secret names are present in environment `studionet-keeper`;
- local execution as the dedicated keeper created `1787256000` through finalized transaction
  `0xe10ce0bf…a9c4` and `1787259600` through finalized transaction `0x00398a3c…9058`; both exact
  post-states were verified OPEN, proving the limited role;
- scheduled V7 run `32298454771` passed reconciliation while its independent history job hit a
  superseded provider-quota failure; later run `32299468899` passed no-action signer/profile
  reconciliation in job `96218469576` and bounded history sync in job `96218806119`; final observed
  run `32300282482` also passed reconcile job `96221017562` and history job `96221327115`;
- scheduled V6 drain run `32297047031` completed successfully without creating any epoch;
- V6 funded evidence remains recorded as regression proof, including exact payout, fee, refund,
  loser rejection, and parent/child delivery;
- the Neon production migration was applied with normalized marked-DDL SHA-256
  `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
  (raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`), followed by successful
  six-table/four-index read-back and an initial two-deployment/two-epoch/two-snapshot production
  sync from `2026-08-19T20:38:39.397Z`;
- public history returns full resolved/determined V7 and V6 E19 snapshots; both `verifiedProofs`
  arrays are empty, so transaction-proof backfill is not claimed; the later run added resolved V7
  E20 and re-synced V6 E19 without a duplicate row;
- four V7 canary wagers of 0.1 GEN each were finalized and post-state verified: account A HIGH BTC
  `0x58f69072…c4fa`, account A LOW XRP `0xa6284710…5831`, account B HIGH ETH `0xc0d5401c…2a19`, and
  account B LOW BNB `0x80c1d306…7e9c`;
- shared resolution `0xc2c86fdb…ab66` finalized from four venues: unbacked SOL HIGH refunded both
  0.1 GEN positions and backed BNB LOW paid 0.198 GEN after a 0.002 GEN fee;
- three claim parent/child pairs delivered exactly 0.398 GEN, the losing LOW XRP claim
  `0xb0d9889a…e688` failed without state change, and fee parent `0x3df8d942…bb01f` plus child
  `0x566082ce…470e` delivered 0.002 GEN to treasury;
- exact A/B/contract balances were 0.700/0.648/0.400 GEN before resolution,
  0.800/0.946/0.002 after claims, and 0.802/0.946/0 after fee withdrawal; liability and accrued fees
  ended at zero and the total 1.748 GEN was conserved.

See [`AUDIT.md`](AUDIT.md), [`STUDIONET-V7.md`](STUDIONET-V7.md), and
[`../deployments/studionet-v7.json`](../deployments/studionet-v7.json).

## Truthful current status

The V7 contract, dedicated keeper, workflow preflight, repeated state projection, and public V7
cutover are complete, but this remains a StudioNet test-token release rather than a real-value
production-safety claim:

- Vercel production targets V7 and retains readable, zero-known-liability V6 recovery;
- Neon migration and repeated finalized-epoch projection are complete; transaction-proof backfill
  and outage recovery remain;
- production scheduler activation is proven; long-run monitoring, live timeout evidence, and
  rollback rehearsal remain;
- independent security and provider data-use/legal review remain.

Observed StudioNet finalization has commonly been under one minute, but this is not an SLA. Reviewers
must be told that StudioNet is temporary test infrastructure and faucet GEN has no promised value.

## Submission completion checklist

1. Separately backfill and verify transaction proofs and rehearse database outage recovery.
2. Continue public browser/wallet soak and prove that V6 recovery stays accessible while the app
   routes no new V6 writes; monitor that the retained owner creation capability remains unused.
3. Continue monitoring default-branch keeper/drain coverage and failures.
4. Record a 24-hour timeout proof or clearly retain it as a known demo limitation.
5. Complete independent security and provider/legal review, screenshots, demo video, repository
   cleanup, and rollback evidence.

Until those gates pass, the correct claim is “public V7 StudioNet test-token release with V6 recovery
compatibility,” not “fully production-ready wagering application.”

The verified code artifact before this evidence-only documentation refresh is commit
`45be825084cce9e97579ca42266e318e2e97fe17`, successful CI run `32299866117`, and READY production
deployment `dpl_HZ4iAxBgnzotYUBQVXWxS8uDguW3` at
`https://liquidity-arena-etugq1wnj-leokings588-5902s-projects.vercel.app`. Bundle
`market-DECrh0Dy.js` has SHA-256
`d82c6975f0275add1e355a3d298a0170aae483f26788d4e9431a2a259cfe85ac`; health, readiness, and history
health returned `200`. This evidence does not pretend the later docs-only commit was the tested source.
