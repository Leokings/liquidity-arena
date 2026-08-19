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
have been verified. It is not yet the public write target. The funded two-wallet V7 canary is
complete: the shared resolution, unbacked-winner refunds, backed LOW payout, loser rejection, three
claim parent/child deliveries, exact conservation, and platform-fee withdrawal were all verified.
The dedicated limited keeper `0x12ba664a1ec9ca78b070d103c6a69e20673f4b51` is installed on-chain;
rotation transaction `0xbca440cc838e6d5dcb595e18124e363e0fa1780a498e3ce49703f9d822aa2fdc`
finalized with majority agreement and successful leader execution, and exact `get_config` read-back
confirmed the new role. Acting as that keeper locally then created epochs `1787256000` and
`1787259600`; transactions `0xe10ce0bf…a9c4` and `0x00398a3c…9058` finalized and both exact
post-states were verified OPEN. Default-branch workflow activation and monitoring remain pending.

The public site at [liquidity-arena.vercel.app](https://liquidity-arena.vercel.app) still targets V6
until the remaining release gates below pass. V6 at
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
| Public Vercel browser | Verified V6 legacy-recovery compatibility; V7 cutover pending |
| V6 | Public app/automation new writes disabled; owner creation capability remains and must not be used |
| Durable settled-epoch history | Neon production migration applied; initial finalized-epoch ingestion pending |

The current safe compatibility artifact is Vercel deployment `dpl_DQEvnGup417wvTxuxzeNfJvySiM5`
([immutable URL](https://liquidity-arena-2qlh5a5kn-leokings588-5902s-projects.vercel.app)), built from
commit `dbc2288a6adc745261128a55b555e8a34574db1e`; bundle `market-Co0HBgo2.js` has SHA-256
`484b3c8ba3e40cb249a694ecd30bbe97df6685e1c858ea54639e8039eec43cd9`. Its `/readyz` is expected to
return `503` because the active legacy V6 compatibility artifact has no future keeper coverage. Six
older deployments were retired and deleted.

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
same public address. A successful default-branch workflow run is still required to prove the runtime
signer and continuous coverage; two local finalized creates already prove the dedicated account's
limited on-chain keeper authority.

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

Before switching public writes to V7:

1. run and verify initial/idempotent Neon finalized-epoch ingestion; the production migration with
   normalized marked-DDL SHA-256 `dd95ed3a5c55bf55d02090605a46557377778afb220126451bb4e750dbc280b2`
   (raw migration-file SHA-256 `8a6cb36aed985575fa797ab446481c89a1495c8d6d99a8024931cbda67674af5`)
   has already been applied and its six tables/four indexes read back;
2. publish the dual-deployment browser configuration, verify V7 writes plus V6 legacy claims, and
   retain a tested rollback;
3. activate the default-branch V7 workflow and verify its runtime signer/coverage;
4. complete timeout evidence, independent security review, and provider data-use/legal review.

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
