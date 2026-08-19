# Liquidity Arena

Liquidity Arena is a GenLayer StudioNet crypto-return battle for BTC, ETH, BNB, SOL, and XRP.
Every exact UTC hour produces one shared five-asset result and settles two independent pari-mutuel
objectives:

- `HIGH`: the asset with the highest percentage return;
- `LOW`: the asset with the lowest percentage return.

The release target is protocol `LIQUIDITY_ARENA_V7` at
[`0xb2ae59aE641f571726Ae81E30080f8c2192b15EF`](https://explorer-studio.genlayer.com/address/0xb2ae59aE641f571726Ae81E30080f8c2192b15EF)
on StudioNet, chain `61999`. The deployment transaction is
[`0x85ca…c579`](https://explorer-studio.genlayer.com/tx/0x85ca7da5018aeac4955a9f10e035fe5013d520e5ea86ded43c89861ba96bc579).
Native faucet test GEN is used for wagers; it has no represented real-world value.

## Release status

V7 is deployed and its contract configuration, source hash, direct tests, and initial hourly schedule
have been verified. It is now the public write target. The funded two-wallet V7 canary is
complete: the shared resolution, unbacked-winner refunds, backed LOW payout, loser rejection, three
claim parent/child deliveries, exact conservation, and platform-fee withdrawal were all verified.
The dedicated limited keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` is installed on-chain;
rotation transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`
finalized with majority agreement and successful leader execution, and exact `get_config` read-back
confirmed the new role. Acting as that keeper locally then created epochs `1787256000` and
`1787259600`; transactions `0xe10ce0bf…a9c4` and `0x00398a3c…9058` finalized and both exact
post-states were verified OPEN. The default-branch keeper is active: scheduled run `32298454771`
passed reconciliation, and later run `32299468899` passed both no-action reconciliation and bounded
history synchronization. Final observed run `32300282482` also passed reconciliation and history
sync on source commit `45be825084cce9e97579ca42266e318e2e97fe17`. Long-run monitoring remains
pending.

The public site at [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app) now targets V7.
V6 at
[`0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1`](https://explorer-studio.genlayer.com/address/0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1)
is operationally retired: the supported public app and automation expose no V6 epoch-creation or
wager path. The deployed V6 owner capability still exists, however, and a directly created OPEN V6
epoch would accept wagers; the owner must not use that capability. Due epochs `1787155200` and
`1787158800` were resolved on 2026-08-19 by transactions `0xae0ce453…e1480` and `0x09f01c2a…e735`.
Legacy read/resolve/timeout/claim paths remain available. Subsequent permissionless drains resolved
epochs `1787162400` and `1787166000` with transactions `0x03f2ac80…0399` and `0x7e8030f0…27bb`.

| Surface | Current state |
| --- | --- |
| V7 contract | Deployed and finalized on StudioNet |
| V7 hourly coverage | 27 exact-hour epochs evidenced: initial canary plus 24 full-day targets and 2 dedicated-keeper creates |
| V7 funded canary | Complete: settlement, three claim deliveries, loser rejection, conservation, and fee withdrawal verified |
| Dedicated V7 keeper rotation | Complete: finalized on-chain and exact config/repository address verified |
| V7 keeper workflow | Active: scheduled reconcile observed and later full workflow run passed; long-run soak pending |
| Public Vercel browser | V7 active and READY; V6 legacy recovery remains readable with zero known liability |
| V6 | Public app/automation new writes disabled; owner creation capability remains and must not be used |
| Durable settled-epoch history | Initial and repeated production sync/read-back passed; V7 E20/E19 and V6 E19 are live, proof backfill pending |

The verified V7 code artifact immediately before this evidence-only documentation refresh is Vercel
deployment `dpl_HZ4iAxBgnzotYUBQVXWxS8uDguW3`
([immutable URL](https://liquidity-arena-etugq1wnj-leokings588-5902s-projects.vercel.app)), built from
commit `45be825084cce9e97579ca42266e318e2e97fe17`. Bundle `market-DECrh0Dy.js` has SHA-256
`d82c6975f0275add1e355a3d298a0170aae483f26788d4e9431a2a259cfe85ac`. Vercel reports READY; both
immutable URL and public alias returned `200` readiness for V7, five feeds, keeper coverage, and
readable zero-liability V6 compatibility. `/healthz` and `/api/history-health` also returned `200`.
CI run `32299866117` passed browser/operator job `96219707620` and intelligent-contracts job
`96219707869` for that exact source. The later documentation commit is not falsely treated as the
source of this tested code artifact. V6 compatibility deployment `dpl_DQEvnGup417wvTxuxzeNfJvySiM5`
remains a READY rollback artifact.

The 24-target full-day seed covers epoch IDs `1787169600` through `1787252400`. Its first and final
creation transactions are `0x7b94b2d0…7726` and `0x443afcf7…7677f`; the separate canary epoch
`1787166000` was created by `0x48658624…72cb`. These 25 creations prove bounded scheduling, not
continuous automation. The rotated keeper separately created `1787256000` and `1787259600` through
finalized transactions `0xe10ce0bfc24320998e12cea148734124cb8b0f0ee2fb728ef2961191ee3aa9c4`
and `0x00398a3c1acf443220848fabecdc4dd0e2cb4232a0b10588ac6ebbbfdf4c9058`; both were read back OPEN.

## Exact-hour schedule

Each epoch is identified by its exact UTC end time `E`; therefore there are exactly 24 targets per
UTC day.

| Interval | Phase | Behavior |
| --- | --- | --- |
| `[E-60m, E-40m)` | Buffer | The epoch exists, but wagers are closed. |
| `[E-40m, E-20m)` | Wagering | Users may enter or top up `HIGH`, `LOW`, or both. |
| `[E-20m, E)` | Battle | Wagers are locked and returns are measured. |
| `[E, E+120s)` | Publication | Completed one-minute boundary candles become available. |
| `[E+120s, E+24h)` | Resolution | `resolve_epoch(E)` is permissionless. |
| `E+24h` onward | Timeout | If still open, `activate_timeout_refund(E)` is permissionless. |

Only the ROUND visualization resets at battle start. The 1H, 4H, 1D, and 1W views are rolling
historical context and do not reset with an epoch.

## Settlement policy

The immutable policy is `CRYPTO_SPOT_1M_MEDIAN_V1`. GenLayer validators independently read completed
one-minute spot candles from Binance, OKX, Bybit, Gate, and KuCoin. A venue qualifies only if its
complete five-asset basket passes timestamp, symbol, schema, and price validation. At least three of
the five venues must qualify.

For each asset, the contract takes the deterministic median venue return. The same canonical vector
selects both `HIGH` and `LOW`. A finalized contract vector permanently replaces the provisional live
ROUND display. Territory area is return-only; momentum controls movement and volatility/disagreement
controls turbulence, never payout.

Temporary source failure does not invent a result. Fewer than three complete venues raises a
retryable quorum error and leaves the epoch OPEN; it does not immediately select
`REFUND_UNDETERMINED`. If the epoch remains open until `E+24h`, anyone can activate the deterministic
zero-fee timeout refund.

## Wagers, fees, and claims

- V7 holds native faucet test GEN directly on StudioNet.
- The deployed epoch stake range is 0.1–10 GEN per wallet per objective.
- A wallet chooses one asset per objective and may top up only that asset before wager close.
- The default fee is 2% of the losing pool, snapshotted when the epoch is created; the contract caps
  future fee settings at 5%.
- Ties, an unbacked winner, no losing side, an undetermined result, and timeout return eligible
  principal with zero fee.
- Winners and refundable participants pull their own claims; the contract has no unbounded payout
  loop.
- Money actions are considered delivered only after the parent transaction is `FINALIZED`, execution
  and post-state match, and the exact EOA transfer child is also finalized.

The checked-in claim-delivery monitor is read-only and requires an explicit `--protocol v6` or
`--protocol v7` deployment profile. It never retries or re-emits a transfer: retrying without
protocol-proof that the original child failed could double-pay if that child later finalizes. The V7
canary proved three exact finalized claim-parent/EOA-child deliveries; ambiguous child-failure
recovery remains outside that healthy-path proof.

The V7 canary epoch `1787166000` resolved with
`0xc2c86fdb37da9569e67eae00a15b6864ddab05364e92f4d6c0c4c75d6a4aab66`: HIGH selected unbacked SOL
and refunded both HIGH positions; LOW selected backed BNB and delivered 0.198 GEN. The expected LOW
XRP loser claim failed without changing state. After the three claims, balances were 0.800 GEN,
0.946 GEN, and 0.002 GEN for account A, account B, and the contract. The exact 0.002 GEN fee was then
delivered to treasury by parent `0x3df8d942…bb01f` and child `0x566082ce…470e`, leaving 0.802 GEN,
0.946 GEN, and zero respectively. The conserved total was 1.748 GEN throughout. Full hashes are in
[`deployments/studionet-v7.json`](deployments/studionet-v7.json).

## V7 authorization model

V7 narrows the scheduled operator:

- only the owner or current keeper may call `create_epoch(E)`;
- the keeper cannot schedule more than 26 hours ahead and every epoch needs at least one hour of
  notice;
- anyone may call `resolve_epoch(E)` or `activate_timeout_refund(E)` after their gates;
- only the owner changes the keeper or fee and ownership uses propose/accept transfer;
- only the owner or treasury may withdraw already accrued fees.

The owner key is not a workflow credential. The current keeper is the dedicated limited account
`0x12ba664a1ec9ca78b070d103c6a69e20673f4b51`; GitHub environment `studionet-keeper` contains the
encrypted keeper keystore/password secrets, and repository variable `V7_KEEPER_ADDRESS` records the
same public address. Successful default-branch runs now prove the runtime signer/profile and observed
coverage; two local finalized creates independently prove the dedicated account's limited on-chain
keeper authority. Continuous availability remains a monitoring obligation.

That runtime preflight is now proven by reconcile job `96218469576` in run `32299468899`. It checked
the exact contract profile and imported signer and correctly planned no actions because coverage was
already complete. This is activation evidence, not a long-run availability guarantee.

## Run and verify locally

```powershell
npm ci
npm test
npm run build
npm start
```

Open `http://127.0.0.1:4400/market.html`. Live exchange data is the default; use `?feed=demo` only
for the deterministic replay.

Contract checks:

```powershell
python -X utf8 -m pytest tests/direct -q
python -X utf8 -m genvm_linter.cli check contracts/LiquidityArenaV7.py
```

V7 keeper dry run:

```powershell
$env:V7_CONTRACT_ADDRESS='0xb2ae59aE641f571726Ae81E30080f8c2192b15EF'
$env:V7_OWNER_ADDRESS='<expected owner>'
$env:V7_KEEPER_ADDRESS='0x12ba664a1ec9ca78b070d103c6a69e20673f4b51'
$env:V7_TREASURY_ADDRESS='<expected treasury>'
node scripts/v7-keeper.mjs --config scripts/examples/v7-keeper.example.json
```

Do not use the owner key for routine scheduling. See [the V7 keeper runbook](docs/round-keeper.md).

## Remaining release gates

After public V7 cutover:

1. keep V6 legacy reads/claims available and retain a tested rollback without re-enabling V6 writes;
2. separately backfill and verify transaction proofs; recurring state projection intentionally
   reports zero verified proofs today;
3. monitor repeated scheduled keeper/drain runs, history quota behavior, and alerting;
4. complete timeout evidence, independent security review, browser/wallet soak, and provider
   data-use/legal review.

Initial history run `32299468899`, job `96218806119`, synchronized two deployments, two epochs, and
two full E19 snapshots. Later run `32300282482`, reconcile job `96221017562` and history job
`96221327115`, also succeeded on main commit `45be825…fe17`. Its state read at
`2026-08-19T20:47:19.912Z` synchronized two deployments, two epochs, and two snapshots with
`proofsVerified=0`. Public history now has V7 E20 (`1787169600`) plus V7 E19 and V6 E19; all three
are resolved/determined with no duplicate V6 E19 row. This proves repeated projection behavior but
not transaction-proof backfill. Earlier scheduled run `32298454771` had successful reconciliation
while its history job hit the StudioNet provider quota; later bounded syncs supersede that incident.
Scheduled V6 drain run `32297047031` also passed.

StudioNet finality has been observed in tens of seconds, including finalized transactions in under a
minute, but these samples are not a bound or service-level promise. Claims never unlock at
`ACCEPTED`.

## Documentation

- [V7 deployment and cutover record](docs/STUDIONET-V7.md)
- [Technical architecture](TECHNICAL.md)
- [Contract requirements](contracts/README.md)
- [Keeper runbook](docs/round-keeper.md)
- [Security model](SECURITY.md)
- [Audit status](docs/AUDIT.md)
- [Submission status](docs/SUBMISSION-TECH.md)
- [Product specification](docs/REDESIGN-SPEC.md)
- [Execution brief](docs/REDESIGN-EXECUTION-BRIEF.md)
- [Machine-readable V7 deployment record](deployments/studionet-v7.json)
- [Legacy V6 deployment evidence](deployments/studionet-v6.json)
