import json
import re
from pathlib import Path

import pytest

from gltest.direct.sdk_loader import setup_sdk_paths


CONTRACT_PATH = Path("contracts/LiquidityArenaV6.py")

CREATED_ISO = "2030-01-01T00:00:00Z"
EPOCH_END_ISO = "2030-01-01T01:00:00Z"
WAGER_OPEN_ISO = "2030-01-01T00:20:00Z"
WAGER_CLOSE_ISO = "2030-01-01T00:40:00Z"
RESOLUTION_MINUS_ONE_ISO = "2030-01-01T01:01:59Z"
RESOLUTION_AVAILABLE_ISO = "2030-01-01T01:02:00Z"
TIMEOUT_MINUS_ONE_ISO = "2030-01-02T00:59:59Z"
TIMEOUT_AVAILABLE_ISO = "2030-01-02T01:00:00Z"

EPOCH_END = 1_893_459_600
SECOND_EPOCH_END = 1_893_463_200
BATTLE_START = EPOCH_END - 20 * 60
END_CANDLE_OPEN = EPOCH_END - 60
MIN_STAKE = 10
MAX_STAKE = 10_000

ASSETS = ("BTC", "ETH", "BNB", "SOL", "XRP")
VENUES = ("BINANCE", "OKX", "BYBIT", "GATE", "KUCOIN")


def as_address(value):
    from genlayer.py.types import Address

    return Address(value) if isinstance(value, bytes) else value


def deploy_arena(direct_vm, direct_deploy, direct_owner, treasury):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    direct_vm.warp(CREATED_ISO)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 0
    return direct_deploy(str(CONTRACT_PATH), as_address(treasury))


def create_epoch(contract, epoch_end=EPOCH_END):
    contract.create_epoch(epoch_end, MIN_STAKE, MAX_STAKE)


def place_wager(direct_vm, contract, account, objective, asset_id, amount):
    direct_vm.sender = as_address(account)
    direct_vm.value = amount
    contract.enter(EPOCH_END, objective, asset_id)
    # genlayer-test direct mode does not credit payable value automatically.
    direct_vm.deal(direct_vm._contract_address, int(contract.balance) + amount)


def source_url(venue, asset_id):
    if venue in ("OKX", "KUCOIN"):
        symbol = f"{asset_id}-USDT"
    elif venue == "GATE":
        symbol = f"{asset_id}_USDT"
    else:
        symbol = f"{asset_id}USDT"
    if venue == "BINANCE":
        return (
            "https://data-api.binance.vision/api/v3/klines"
            f"?symbol={symbol}&interval=1m&startTime={BATTLE_START * 1000}"
            f"&endTime={EPOCH_END * 1000 - 1}&limit=20"
        )
    if venue == "OKX":
        return (
            "https://www.okx.com/api/v5/market/history-candles"
            f"?instId={symbol}&bar=1m&after={EPOCH_END * 1000}&limit=20"
        )
    if venue == "BYBIT":
        return (
            "https://api.bybit.com/v5/market/kline"
            f"?category=spot&symbol={symbol}&interval=1"
            f"&start={BATTLE_START * 1000}&end={EPOCH_END * 1000 - 1}&limit=20"
        )
    if venue == "GATE":
        return (
            "https://api.gateio.ws/api/v4/spot/candlesticks"
            f"?currency_pair={symbol}&from={BATTLE_START}&to={EPOCH_END}&interval=1m"
        )
    return (
        "https://api.kucoin.com/api/ua/v1/market/kline"
        f"?tradeType=SPOT&symbol={symbol}&interval=1min"
        f"&startAt={BATTLE_START}&endAt={EPOCH_END}"
    )


def candle_payload(venue, start_price, end_price, *, timestamp_shift=0):
    start = BATTLE_START + timestamp_shift
    end_open = END_CANDLE_OPEN + timestamp_shift
    if venue == "BINANCE":
        return [
            [
                start * 1000,
                str(start_price),
                str(start_price),
                str(start_price),
                str(start_price),
                "1",
                start * 1000 + 59_999,
            ],
            [
                end_open * 1000,
                str(start_price),
                str(end_price),
                str(start_price),
                str(end_price),
                "1",
                end_open * 1000 + 59_999,
            ],
        ]
    if venue == "OKX":
        return {
            "code": "0",
            "data": [
                [
                    str(end_open * 1000),
                    str(start_price),
                    str(end_price),
                    str(start_price),
                    str(end_price),
                    "1",
                    "1",
                    "1",
                    "1",
                ],
                [
                    str(start * 1000),
                    str(start_price),
                    str(start_price),
                    str(start_price),
                    str(start_price),
                    "1",
                    "1",
                    "1",
                    "1",
                ],
            ],
        }
    if venue == "BYBIT":
        return {
            "retCode": 0,
            "retMsg": "OK",
            "result": {
                "category": "spot",
                "list": [
                    [
                        str(end_open * 1000),
                        str(start_price),
                        str(end_price),
                        str(start_price),
                        str(end_price),
                        "1",
                        "1",
                    ],
                    [
                        str(start * 1000),
                        str(start_price),
                        str(start_price),
                        str(start_price),
                        str(start_price),
                        "1",
                        "1",
                    ],
                ],
            },
        }
    if venue == "GATE":
        return [
            [str(start), "1", str(start_price), str(start_price), str(start_price), str(start_price), "1", "true"],
            [str(end_open), "1", str(end_price), str(end_price), str(start_price), str(start_price), "1", "true"],
        ]
    return {
        "code": "200000",
        "data": {
            "tradeType": "SPOT",
            "symbol": "BTC-USDT",
            "list": [
                [start, str(start_price), str(start_price), str(start_price), str(start_price), "1", "1"],
                [end_open, str(start_price), str(end_price), str(start_price), str(end_price), "1", "1"],
            ],
        },
    }


def mock_market(
    direct_vm,
    closes_by_asset,
    *,
    closes_by_venue=None,
    malformed=None,
    timestamp_shift=None,
):
    malformed = set() if malformed is None else set(malformed)
    timestamp_shift = {} if timestamp_shift is None else timestamp_shift
    for venue in VENUES:
        for asset_id in ASSETS:
            if (venue, asset_id) in malformed:
                body = "{}"
            else:
                venue_closes = (
                    closes_by_asset
                    if closes_by_venue is None
                    else closes_by_venue[venue]
                )
                payload = candle_payload(
                    venue,
                    100,
                    venue_closes[asset_id],
                    timestamp_shift=timestamp_shift.get((venue, asset_id), 0),
                )
                body = json.dumps(payload)
            direct_vm.mock_web(
                re.escape(source_url(venue, asset_id)),
                {"status": 200, "body": body},
            )


def resolve(direct_vm, contract, closes_by_asset, **mock_options):
    direct_vm.value = 0
    direct_vm.warp(RESOLUTION_AVAILABLE_ISO)
    direct_vm.check_pickling = True
    mock_market(direct_vm, closes_by_asset, **mock_options)
    contract.resolve_epoch(EPOCH_END)


def default_market():
    return {"BTC": 110, "ETH": 105, "BNB": 99, "SOL": 102, "XRP": 95}


def test_v6_pins_runner_and_exposes_fixed_policy(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    first_line = CONTRACT_PATH.read_text(encoding="utf-8").splitlines()[0]
    source = CONTRACT_PATH.read_text(encoding="utf-8")
    assert first_line.startswith('# { "Depends": "py-genlayer:')
    assert "py-genlayer:test" not in first_line
    assert "py-genlayer:latest" not in first_line
    assert "run_nondet_unsafe" in source
    assert "strict_eq" not in source

    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    config = contract.get_config()
    assert config["protocol_version"] == "LIQUIDITY_ARENA_V6"
    assert config["policy_version"] == "CRYPTO_SPOT_1M_MEDIAN_V1"
    assert config["current_platform_fee_bps"] == 200
    assert config["max_platform_fee_bps"] == 500
    assert config["resolution_publication_delay_seconds"] == 120
    assert config["timeout_refund_delay_seconds"] == 86_400
    assert config["four_venue_median_policy"] == "FLOOR_AVERAGE_OF_MIDDLE_TWO"
    assert config["transfer_finality"] == "FINALIZED"
    assert [item["asset_id"] for item in contract.get_asset_catalog()["assets"]] == list(ASSETS)
    assert contract.get_venue_catalog()["venues"] == list(VENUES)


def test_zero_treasury_is_rejected(
    direct_vm,
    direct_deploy,
    direct_owner,
):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    from genlayer.py.types import Address

    direct_vm.warp(CREATED_ISO)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 0
    with direct_vm.expect_revert("TREASURY_ZERO"):
        direct_deploy(str(CONTRACT_PATH), Address(bytes(20)))


def test_exact_hour_schedule_and_all_phase_boundaries(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    with direct_vm.expect_revert("EPOCH_HOURLY"):
        contract.create_epoch(EPOCH_END + 1, MIN_STAKE, MAX_STAKE)
    create_epoch(contract)
    summary = contract.get_epoch(EPOCH_END)
    assert summary["wager_opens_timestamp"] == EPOCH_END - 2_400
    assert summary["wager_closes_timestamp"] == EPOCH_END - 1_200
    assert summary["battle_starts_timestamp"] == EPOCH_END - 1_200
    assert summary["resolution_available_timestamp"] == EPOCH_END + 120
    assert summary["timeout_refund_available_timestamp"] == EPOCH_END + 86_400
    assert summary["phase"] == "SCHEDULED"

    direct_vm.warp("2030-01-01T00:19:59Z")
    assert contract.get_epoch(EPOCH_END)["phase"] == "SCHEDULED"
    direct_vm.warp(WAGER_OPEN_ISO)
    assert contract.get_epoch(EPOCH_END)["phase"] == "WAGER_OPEN"
    direct_vm.warp("2030-01-01T00:39:59Z")
    assert contract.get_epoch(EPOCH_END)["phase"] == "WAGER_OPEN"
    direct_vm.warp(WAGER_CLOSE_ISO)
    assert contract.get_epoch(EPOCH_END)["phase"] == "BATTLE"
    direct_vm.warp(EPOCH_END_ISO)
    assert contract.get_epoch(EPOCH_END)["phase"] == "PUBLICATION_DELAY"
    direct_vm.warp(RESOLUTION_MINUS_ONE_ISO)
    assert contract.get_epoch(EPOCH_END)["phase"] == "PUBLICATION_DELAY"
    with direct_vm.expect_revert("RESOLUTION_GATE"):
        contract.resolve_epoch(EPOCH_END)
    direct_vm.warp(RESOLUTION_AVAILABLE_ISO)
    assert contract.get_epoch(EPOCH_END)["phase"] == "RESOLVABLE"
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    assert contract.get_epoch(EPOCH_END)["phase"] == "TIMEOUT_AVAILABLE"


def test_epoch_creation_requires_notice_and_snapshots_fee_with_hard_cap(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.sender = as_address(direct_owner)
    contract.set_platform_fee_bps(500)
    contract.create_epoch(SECOND_EPOCH_END, MIN_STAKE, MAX_STAKE)
    assert contract.get_epoch(EPOCH_END)["platform_fee_bps_snapshot"] == 200
    assert contract.get_epoch(SECOND_EPOCH_END)["platform_fee_bps_snapshot"] == 500
    with direct_vm.expect_revert("FEE_CAP"):
        contract.set_platform_fee_bps(501)

    direct_vm.warp(WAGER_OPEN_ISO)
    with direct_vm.expect_revert("EPOCH_NOTICE"):
        # A fresh contract would reject this E at the exact opening boundary;
        # this contract hits the notice guard before the duplicate guard.
        contract.create_epoch(EPOCH_END, MIN_STAKE, MAX_STAKE)


def test_entries_are_per_objective_top_up_only_and_recoverable_on_chain(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    place_wager(direct_vm, contract, direct_alice, "high", "btc", 50)
    place_wager(direct_vm, contract, direct_alice, "LOW", "ETH", 70)
    place_wager(direct_vm, contract, direct_bob, "HIGH", "SOL", 25)

    assert contract.get_entry(EPOCH_END, "HIGH", as_address(direct_alice))["stake_atto"] == 150
    assert contract.get_entry(EPOCH_END, "LOW", as_address(direct_alice))["stake_atto"] == 70
    assert contract.get_total_player_liability_atto() == 245
    assert contract.get_wallet_position_count(as_address(direct_alice)) == 2
    page = contract.get_wallet_position_page(as_address(direct_alice), 0, 10)
    assert page["total"] == 2
    assert [(item["objective"], item["choice_asset_id"]) for item in page["positions"]] == [
        ("HIGH", "BTC"),
        ("LOW", "ETH"),
    ]
    assert contract.get_epoch_count() == 1
    assert contract.get_epoch_id(0) == str(EPOCH_END)
    assert contract.get_epoch_page(0, 10)["epoch_ids"] == [str(EPOCH_END)]

    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = 10
    with direct_vm.expect_revert("ONE_ASSET_PER_OBJECTIVE"):
        contract.enter(EPOCH_END, "HIGH", "ETH")
    direct_vm.value = 0
    with direct_vm.expect_revert("PAGE_LIMIT"):
        contract.get_wallet_position_page(as_address(direct_alice), 0, 51)

    direct_vm.warp(WAGER_CLOSE_ISO)
    direct_vm.sender = as_address(direct_bob)
    direct_vm.value = 10
    with direct_vm.expect_revert("WAGER_CLOSED"):
        contract.enter(EPOCH_END, "LOW", "XRP")


def test_two_percent_losing_pool_fee_exact_claims_and_fee_solvency(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 200)
    place_wager(direct_vm, contract, direct_charlie, "HIGH", "BTC", 400)
    place_wager(direct_vm, contract, direct_bob, "HIGH", "ETH", 400)
    place_wager(direct_vm, contract, direct_bob, "LOW", "XRP", 300)
    place_wager(direct_vm, contract, direct_alice, "LOW", "BTC", 700)

    resolve(direct_vm, contract, default_market())
    epoch = contract.get_epoch(EPOCH_END)
    high = contract.get_objective(EPOCH_END, "HIGH")
    low = contract.get_objective(EPOCH_END, "LOW")
    assert epoch["result_status"] == "DETERMINED"
    assert epoch["high_winner_asset_id"] == "BTC"
    assert epoch["low_winner_asset_id"] == "XRP"
    assert epoch["platform_fee_accrued_atto"] == 22
    assert high["settlement_mode"] == "PARIMUTUEL"
    assert high["winning_stake_atto"] == 600
    assert high["losing_stake_atto"] == 400
    assert high["platform_fee_atto"] == 8
    assert high["payout_pool_atto"] == 992
    assert low["platform_fee_atto"] == 14
    assert low["payout_pool_atto"] == 986
    assert contract.get_total_player_liability_atto() == 1_978
    assert contract.get_fee_state()["accrued_platform_fees_atto"] == 22

    alice = as_address(direct_alice)
    bob = as_address(direct_bob)
    charlie = as_address(direct_charlie)
    assert contract.get_claim_quote(EPOCH_END, "HIGH", alice)["amount_atto"] == 330
    assert contract.get_claim_quote(EPOCH_END, "HIGH", bob)["amount_atto"] == 0
    direct_vm.sender = alice
    direct_vm.value = 0
    contract.claim(EPOCH_END, "HIGH")
    charlie_quote = contract.get_claim_quote(EPOCH_END, "HIGH", charlie)
    assert charlie_quote["amount_atto"] == 662
    assert charlie_quote["includes_rounding_remainder"] is True
    direct_vm.sender = charlie
    contract.claim(EPOCH_END, "HIGH")
    direct_vm.sender = bob
    contract.claim(EPOCH_END, "LOW")
    assert contract.get_total_player_liability_atto() == 0

    direct_vm.sender = as_address(direct_alice)
    with direct_vm.expect_revert("FEE_OPERATOR"):
        contract.withdraw_accrued_fees(1)
    direct_vm.sender = as_address(direct_owner)
    with direct_vm.expect_revert("FEE_ACCRUED"):
        contract.withdraw_accrued_fees(23)
    contract.withdraw_accrued_fees(22)
    fee_state = contract.get_fee_state()
    assert fee_state["accrued_platform_fees_atto"] == 0
    assert fee_state["withdrawn_platform_fees_atto"] == 22


def test_tie_and_unbacked_winner_refund_principal_with_zero_fee(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    place_wager(direct_vm, contract, direct_bob, "HIGH", "ETH", 150)
    place_wager(direct_vm, contract, direct_alice, "LOW", "BTC", 80)
    tied_market = {"BTC": 110, "ETH": 110, "BNB": 100, "SOL": 99, "XRP": 90}
    resolve(direct_vm, contract, tied_market)

    high = contract.get_objective(EPOCH_END, "HIGH")
    low = contract.get_objective(EPOCH_END, "LOW")
    assert high["winner_asset_id"] == "TIE"
    assert high["settlement_mode"] == "REFUND_TIE"
    assert high["platform_fee_atto"] == 0
    assert low["winner_asset_id"] == "XRP"
    assert low["settlement_mode"] == "REFUND_UNBACKED_WINNER"
    assert low["platform_fee_atto"] == 0
    assert contract.get_fee_state()["accrued_platform_fees_atto"] == 0

    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = 0
    assert contract.get_claim_quote(EPOCH_END, "HIGH", as_address(direct_alice))["amount_atto"] == 100
    contract.claim(EPOCH_END, "HIGH")
    contract.claim(EPOCH_END, "LOW")
    direct_vm.sender = as_address(direct_bob)
    contract.claim(EPOCH_END, "HIGH")
    assert contract.get_total_player_liability_atto() == 0


def test_no_losing_side_refunds_instead_of_charging_fee(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 123)
    resolve(direct_vm, contract, default_market())
    high = contract.get_objective(EPOCH_END, "HIGH")
    assert high["settlement_mode"] == "REFUND_NO_LOSING_SIDE"
    assert high["platform_fee_atto"] == 0
    assert contract.get_claim_quote(EPOCH_END, "HIGH", as_address(direct_alice))["amount_atto"] == 123


def test_fewer_than_three_atomic_venues_remains_open_for_retry(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    place_wager(direct_vm, contract, direct_bob, "LOW", "XRP", 200)
    malformed = {
        (venue, asset_id)
        for venue in ("BYBIT", "GATE", "KUCOIN")
        for asset_id in ASSETS
    }
    with direct_vm.expect_revert("VENUE_QUORUM"):
        resolve(direct_vm, contract, default_market(), malformed=malformed)
    epoch = contract.get_epoch(EPOCH_END)
    assert epoch["status"] == "OPEN"
    assert epoch["result_status"] == "PENDING"
    assert contract.get_objective(EPOCH_END, "HIGH")["settlement_mode"] == "PENDING"
    assert contract.get_objective(EPOCH_END, "LOW")["settlement_mode"] == "PENDING"
    assert contract.get_fee_state()["accrued_platform_fees_atto"] == 0
    assert contract.get_claim_quote(EPOCH_END, "HIGH", as_address(direct_alice))["amount_atto"] == 0
    assert contract.get_claim_quote(EPOCH_END, "LOW", as_address(direct_bob))["amount_atto"] == 0


def test_four_venue_median_and_all_public_parser_fixtures(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    closes_by_venue = {
        "BINANCE": {asset_id: 101 for asset_id in ASSETS},
        "OKX": {asset_id: 103 for asset_id in ASSETS},
        "BYBIT": {asset_id: 107 for asset_id in ASSETS},
        "GATE": {asset_id: 109 for asset_id in ASSETS},
        "KUCOIN": {asset_id: 150 for asset_id in ASSETS},
    }
    # One malformed XRP row disqualifies the whole KuCoin vector, even though
    # its other four assets parse. The remaining four median is (3% + 7%)/2.
    resolve(
        direct_vm,
        contract,
        default_market(),
        closes_by_venue=closes_by_venue,
        malformed={("KUCOIN", "XRP")},
    )
    epoch = contract.get_epoch(EPOCH_END)
    assert epoch["venue_count"] == 4
    assert epoch["qualified_venues"] == ["BINANCE", "OKX", "BYBIT", "GATE"]
    for asset_id in ASSETS:
        asset = contract.get_epoch_asset(EPOCH_END, asset_id)
        assert asset["return_ppb"] == 50_000_000
        assert asset["venue_returns_ppb"] == [
            10_000_000,
            30_000_000,
            70_000_000,
            90_000_000,
        ]
    assert epoch["high_winner_asset_id"] == "TIE"
    assert epoch["low_winner_asset_id"] == "TIE"


def test_exact_candle_timestamp_is_required_for_venue_qualification(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    shifts = {
        (venue, asset_id): 60
        for venue in ("BYBIT", "GATE", "KUCOIN")
        for asset_id in ASSETS
    }
    with direct_vm.expect_revert("VENUE_QUORUM"):
        resolve(direct_vm, contract, default_market(), timestamp_shift=shifts)
    assert contract.get_epoch(EPOCH_END)["status"] == "OPEN"


def test_timeout_and_result_paths_are_mutually_exclusive_and_zero_fee(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    direct_vm.value = 0
    direct_vm.warp(TIMEOUT_MINUS_ONE_ISO)
    with direct_vm.expect_revert("TIMEOUT_EARLY"):
        contract.activate_timeout_refund(EPOCH_END)
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    with direct_vm.expect_revert("RESOLUTION_TIMEOUT"):
        contract.resolve_epoch(EPOCH_END)
    contract.activate_timeout_refund(EPOCH_END)
    epoch = contract.get_epoch(EPOCH_END)
    assert epoch["status"] == "TIMED_OUT"
    assert epoch["result_status"] == "TIMEOUT"
    assert contract.get_objective(EPOCH_END, "HIGH")["settlement_mode"] == "REFUND_TIMEOUT"
    assert contract.get_fee_state()["accrued_platform_fees_atto"] == 0
    with direct_vm.expect_revert("EPOCH_NOT_OPEN"):
        contract.resolve_epoch(EPOCH_END)
    direct_vm.sender = as_address(direct_alice)
    contract.claim(EPOCH_END, "HIGH")
    assert contract.get_total_player_liability_atto() == 0


def test_resolved_epoch_cannot_later_enter_timeout(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    resolve(direct_vm, contract, default_market())
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    with direct_vm.expect_revert("EPOCH_NOT_OPEN"):
        contract.activate_timeout_refund(EPOCH_END)


@pytest.mark.parametrize("bad_limit", [0, 51])
def test_global_history_pages_are_bounded(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
    bad_limit,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    with direct_vm.expect_revert("PAGE_LIMIT"):
        contract.get_epoch_page(0, bad_limit)
