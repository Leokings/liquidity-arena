# Liquidity Arena V6 — StudioNet single-chain architecture

Status: implemented, direct-tested, linted, and deployed on StudioNet at `0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1`.

## Consensus boundary

The browser and server own presentation, live non-authoritative prices, indexing caches, wallet UX, and keeper convenience. They do not choose a winner or calculate a payable result.

`LiquidityArenaV6` owns the native test-GEN escrow, hourly schedule, wagers, fee accounting, external candle evidence, one consensus result vector, independent HIGH and LOW settlement, claims/refunds, and fee withdrawals. The five exchanges own the raw public spot-candle facts. GenLayer validators independently fetch and normalize those facts before the contract changes settlement state.

Protocol identifier: `LIQUIDITY_ARENA_V6`.

Settlement policy identifier: `CRYPTO_SPOT_1M_MEDIAN_V1`.

The runner is pinned to `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`. Neither a local-only runner alias nor an upgradable data-adapter address is used.

## Exact hourly epoch

An epoch is identified by its Unix end timestamp `E`. `E` must be divisible by 3,600, so it is an exact UTC hour.

| Phase | Half-open interval |
| --- | --- |
| Scheduled | before `E - 40 minutes` |
| Wager window | `[E - 40 minutes, E - 20 minutes)` |
| Battle/data window | `[E - 20 minutes, E)` |
| Publication delay | `[E, E + 120 seconds)` |
| Resolution window | `[E + 120 seconds, E + 24 hours)` |
| Timeout refund | at or after `E + 24 hours` |

The owner/keeper must create an epoch before its wager window opens. The contract derives every boundary; callers cannot provide alternative phase timestamps. `resolve_epoch` is rejected at and after the timeout boundary, while `activate_timeout_refund` is rejected before it. Both transitions additionally require the epoch to remain `OPEN`, making result and timeout terminal paths mutually exclusive.

## Assets, objectives, and custody

The basket and order are fixed:

1. BTC/USDT
2. ETH/USDT
3. BNB/USDT
4. SOL/USDT
5. XRP/USDT

Each epoch has two independently funded objectives that consume the same result vector:

- `HIGH`: the asset with the highest median percentage return.
- `LOW`: the asset with the lowest median percentage return.

`enter(E, objective, asset)` is payable in StudioNet's native test GEN. A wallet may hold one chosen asset in HIGH and one chosen asset in LOW for the same epoch. Further payments can top up the already chosen asset for that objective, but cannot switch it. The wallet cap applies independently to each epoch/objective position.

The contract maintains `total_player_liability_atto` separately from `accrued_platform_fees_atto`. No administrative method can withdraw player liability. Claims, refunds, and fee withdrawals use emitted native transfers with `on="finalized"`.

StudioNet GEN has no production monetary guarantee. V6 must not be described as a production-money wagering contract.

## Immutable public candle adapters

Every validator uses the following public, unauthenticated REST adapters:

| Venue | Endpoint family | Symbol form |
| --- | --- | --- |
| Binance | `https://data-api.binance.vision/api/v3/klines` | `BTCUSDT` |
| OKX | `https://www.okx.com/api/v5/market/history-candles` | `BTC-USDT` |
| Bybit | `https://api.bybit.com/v5/market/kline` | `BTCUSDT` |
| Gate | `https://api.gateio.ws/api/v4/spot/candlesticks` | `BTC_USDT` |
| KuCoin | `https://api.kucoin.com/api/ua/v1/market/kline` | `BTC-USDT` |

The corresponding official specifications are [Binance Spot klines](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data), [OKX candlestick history](https://www.okx.com/docs-v5/en/#rest-api-market-data-get-candlesticks-history), [Bybit Get Kline](https://bybit-exchange.github.io/docs/v5/market/kline), [Gate spot candlesticks](https://www.gate.com/docs/developers/apiv4/en/#market-candlesticks), and [KuCoin UTA Get Klines](https://www.kucoin.com/docs-new/rest/ua/get-klines).

For every asset and venue, the policy requires two exact one-minute candle timestamps:

- start price: the **open** of the candle whose open time is exactly `E - 20 minutes`;
- end price: the **close** of the candle whose open time is exactly `E - 1 minute`.

The resolution gate ensures the latter candle has ended. Binance close-time, OKX confirmation, and Gate closed flags receive additional explicit checks. Missing exact timestamps, malformed decimals, failed status codes, oversize responses, or incomplete candles disqualify the whole venue.

A venue qualifies only if all five assets parse successfully. The result requires at least three qualified venues out of five. This atomic-venue rule prevents different assets from silently using unrelated venue subsets.

The adapter constants and parser policy cannot be changed in deployed V6 storage. An endpoint, schema, basket, quote asset, timing, or normalization change requires a new policy/protocol deployment.

## Integer return and median policy

Prices are parsed from decimal strings to positive E8 integers. Extra fractional digits are truncated toward zero after eight decimal places. Scientific notation, floats, negative values, and booleans are rejected.

For each venue and asset:

```text
return_ppb = floor((end_close_e8 - start_open_e8) * 1,000,000,000 / start_open_e8)
```

Signed Python integer floor division is the V1 policy. No native float participates in evidence, winner selection, fee math, or payout math.

For three or five qualified venues, the median is the middle sorted integer return. The four-venue median is defined explicitly as:

```text
floor((second_sorted_return + third_sorted_return) / 2)
```

After producing the five median returns, the contract derives both winners from that one ordered vector. Equal maxima produce a HIGH tie; equal minima produce a LOW tie. One objective can refund for a tie while the other settles normally.

## Validator comparison

V6 uses `gl.vm.run_nondet_unsafe` with a custom validator; it does not use brittle `strict_eq` over raw HTTP results.

Both leader and validator results must independently pass strict structural checks:

- correct policy and epoch;
- ordered, unique, approved venue subset;
- fixed ordered five-asset vector when determined;
- venue-return vector length consistent with the qualified count;
- each published median recomputed from its venue returns;
- HIGH and LOW winners recomputed from the shared median vector.

For determined results, validators must agree on both objective winners and every asset median must be within 100,000 PPB (0.01 percentage point) of the leader. This small semantic tolerance avoids comparing irrelevant response formatting while keeping the payable winner exact. If an execution finds fewer than three qualifying atomic venues, it raises a tagged transient quorum error; matching transient errors finalize no state and permit a later retry.

## Fee and settlement accounting

The initial fee is 200 basis points (2%) of the losing pool only. The owner may set a future fee between 0 and 500 basis points; 500 (5%) is a hard contract cap. `create_epoch` snapshots the current value, so a later update cannot change an existing epoch.

For a normal objective:

```text
losing_pool = total_stake - winning_stake
fee = floor(losing_pool * epoch_fee_bps / 10,000)
payout_pool = winning_stake + losing_pool - fee
winner_claim = floor(wallet_winning_stake * payout_pool / winning_stake)
```

The final winning claimant receives the remaining payout-pool dust. This guarantees that total winner claims equal the exact payout pool. At resolution, only the computed fee moves from player liability to accrued platform fees.

Example: winners backed 600 atto-GEN and losers backed 400. At 2%, the fee is 8, the payout pool is 992, and two winning stakes of 200 and 400 receive 330 and 662 when claimed in that order.

The following modes refund every participating wallet's principal and charge zero fee:

- `REFUND_TIE`: the objective has multiple result-vector winners;
- `REFUND_UNBACKED_WINNER`: the unique winner received no wager;
- `REFUND_NO_LOSING_SIDE`: the winner was backed but no other asset was backed;
- `REFUND_UNDETERMINED`: a structurally valid undetermined result is explicitly consensus-recorded;
  the ordinary fewer-than-three-venue path instead raises a transient error and leaves the epoch
  OPEN for retry or the 24-hour timeout;
- `REFUND_TIMEOUT`: no result became final within 24 hours of `E`.

The constructor rejects the zero treasury address. `withdraw_accrued_fees(amount)` is callable only by the owner or configured treasury. It always pays the configured treasury, checks the accrued-fee ledger, and verifies that the post-withdrawal contract balance still covers the entire player-liability ledger.

## Pull recovery and on-chain history

Wallets do not depend on browser local storage to rediscover funds.

- Global epoch history: `get_epoch_count`, O(1) `get_epoch_id(index)`, and `get_epoch_page(offset, limit)`.
- Wallet history: `get_wallet_position_count(account)`, O(1) `get_wallet_position(account, index)`, and `get_wallet_position_page(account, offset, limit)`.
- Pages are capped at 50 items. No view scans all epochs or all wallets.
- A first wager creates one position reference for that epoch/objective. Same-asset topups do not duplicate it.
- `get_entry` and `get_claim_quote` expose current claim/refund eligibility, including already-claimed state and the exact amount.

## Public ABI summary

Constructor:

```text
LiquidityArenaV6(treasury: Address)
```

Writes:

```text
set_platform_fee_bps(fee_bps)
create_epoch(E, min_stake_atto, max_stake_per_wallet_atto)
enter(E, objective, asset_id) payable
resolve_epoch(E)
activate_timeout_refund(E)
claim(E, objective)
withdraw_accrued_fees(amount_atto)
```

Core views:

```text
get_config()
get_asset_catalog()
get_venue_catalog()
get_fee_state()
get_epoch(E)
get_epoch_asset(E, asset_id)
get_objective(E, objective)
get_entry(E, objective, account)
get_claim_quote(E, objective, account)
get_total_player_liability_atto()
```

The supported settlement modes are `PENDING`, `PARIMUTUEL`, `REFUND_TIE`, `REFUND_UNBACKED_WINNER`, `REFUND_NO_LOSING_SIDE`, `REFUND_UNDETERMINED`, and `REFUND_TIMEOUT`.

## Verification completed and remaining

Completed:

- `genvm-lint check contracts/LiquidityArenaV6.py` passes with the pinned runner;
- direct tests cover every schedule boundary, fee snapshot/cap, independent objective entries and topups, on-chain recovery indexes, exact two-objective payout accounting, rounding remainder, treasury isolation, tie/unbacked/no-loser/timeout refunds, transient quorum retry, result-timeout exclusivity, each public parser fixture, exact candle timestamps, atomic venue failure, and the four-venue median;
- read-only live probes confirmed the current five public response shapes and all five configured pairs on each venue. In one sampled hour KuCoin returned no final XRP candle because that minute had no ticks; KuCoin was therefore correctly ineligible while Binance, OKX, Bybit, and Gate still supplied a four-venue result. Missing candles are expected evidence failures, not values to interpolate.
- deployment, schema/config/catalog read-back, exact source hash match, and four future epoch creations are finalized and recorded in `deployments/studionet-v6.json`.

Direct mode executes the leader path only. StudioNet subsequently proved a funded V6 four-position
round with one shared four-venue resolution, two unbacked-winner refund children, one 0.198 GEN
pari-mutuel payout child, expected loser rejection, a 0.002 GEN fee, zero remaining liability, and
exact balance conservation. The full hashes are recorded in `deployments/studionet-v6.json`.

V6 is now a legacy compatibility surface. Epochs `1787155200`, `1787158800`, `1787162400`, and
`1787166000` were drained to `RESOLVED`; the last resolution transaction was
`0x7e8030f0975d86479a01a398b88d10b2606c466eec78046fc84eca18c55d27bb`. Supported public app and
automation paths expose no V6 creation or wager action, while old reads, permissionless
resolve/timeout, and claims remain available. The deployed owner-only `create_epoch` method still
exists and must not be used; a directly created OPEN epoch would still accept `enter`. Public APIs
can change without notice; quorum loss therefore leaves an open epoch available for retry and the
immutable timeout—not an operator guess—controls refunds.
