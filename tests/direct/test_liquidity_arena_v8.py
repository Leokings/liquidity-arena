import json
import re
import sys
from pathlib import Path

import pytest
from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_utils import keccak

from gltest.direct.sdk_loader import setup_sdk_paths


CONTRACT_PATH = Path("contracts/LiquidityArenaV8.py")

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
DELIVERY_RESERVE = 1_000_000
FACTORY_ADDRESS = "0x000000000000000000000000000000000000fAc8"

ASSETS = ("BTC", "ETH", "BNB", "SOL", "XRP")
VENUES = ("BINANCE", "OKX", "BYBIT", "GATE", "KUCOIN")


def as_address(value):
    from genlayer.py.types import Address

    return value if isinstance(value, Address) else Address(value)


def normalized_address(value):
    if isinstance(value, bytes):
        return "0x" + value.hex()
    return str(value).lower()


class MockPayoutFactory:
    def __init__(self, factory_address=FACTORY_ADDRESS):
        self.factory_address = factory_address.lower()
        self.bound_arena = None
        self.protocol = "IDEMPOTENT_EVM_VAULT_V1"
        self.prepared = {}
        self.vault_overrides = {}
        self.credited = set()
        self.withdrawn = set()
        self.transfers = []

    @staticmethod
    def _selector(signature):
        return keccak(text=signature)[:4]

    @staticmethod
    def _vault_for(payout_id):
        return "0x" + keccak(text=f"liquidity-arena-v8:{payout_id}")[-20:].hex()

    def vault_for(self, payout_id):
        return self.vault_overrides.get(payout_id, self._vault_for(payout_id))

    def credit(self, payout_id):
        assert payout_id in self.prepared
        exact_amount = self.prepared[payout_id][1]
        assert (payout_id, exact_amount) in self.transfers
        self.credited.add(payout_id)

    def mark_withdrawn(self, payout_id):
        assert payout_id in self.credited
        self.withdrawn.add(payout_id)

    def __call__(self, vm, request):
        if "EthCall" in request:
            call = request["EthCall"]
            assert normalized_address(call["address"]) == self.factory_address
            calldata = bytes(call["calldata"])
            selector = calldata[:4]
            payload = calldata[4:]
            if selector == self._selector("protocol_version()"):
                return abi_encode(["string"], [self.protocol])
            if selector == self._selector("is_bound(address)"):
                (arena,) = abi_decode(["address"], payload)
                return abi_encode(
                    ["bool"],
                    [normalized_address(arena) == normalized_address(self.bound_arena)],
                )
            if selector in (
                self._selector("is_prepared(string,address,uint256)"),
                self._selector("is_credited(string,address,uint256)"),
                self._selector("is_withdrawn(string,address,uint256)"),
            ):
                payout_id, recipient, amount = abi_decode(
                    ["string", "address", "uint256"], payload
                )
                prepared = self.prepared.get(payout_id)
                exact = prepared == (normalized_address(recipient), int(amount))
                if selector == self._selector("is_prepared(string,address,uint256)"):
                    result = exact
                elif selector == self._selector("is_credited(string,address,uint256)"):
                    result = exact and payout_id in self.credited
                else:
                    result = exact and payout_id in self.withdrawn
                return abi_encode(["bool"], [result])
            if selector == self._selector("vault_of(string)"):
                (payout_id,) = abi_decode(["string"], payload)
                vault = (
                    self.vault_for(payout_id)
                    if payout_id in self.prepared
                    else "0x" + ("0" * 40)
                )
                return abi_encode(["address"], [vault])
            raise AssertionError(f"Unexpected factory view selector {selector.hex()}")

        if "EthSend" in request:
            send = request["EthSend"]
            address = normalized_address(send["address"])
            calldata = bytes(send["calldata"])
            value = int(send.get("value", 0))
            if address == self.factory_address:
                assert calldata[:4] == self._selector("prepare(string,address,uint256)")
                payout_id, recipient, amount = abi_decode(
                    ["string", "address", "uint256"], calldata[4:]
                )
                exact = (normalized_address(recipient), int(amount))
                existing = self.prepared.get(payout_id)
                assert existing is None or existing == exact
                self.prepared[payout_id] = exact
                assert value == 0
                return b""

            matches = [
                payout_id
                for payout_id in self.prepared
                if self.vault_for(payout_id).lower() == address
            ]
            assert len(matches) == 1
            payout_id = matches[0]
            self.transfers.append((payout_id, value))
            balance = int(vm._balances.get(bytes(vm._contract_address), 0))
            assert balance >= value
            vm.deal(vm._contract_address, balance - value)
            return b""
        return None


def deploy_arena(
    direct_vm,
    direct_deploy,
    direct_owner,
    treasury,
    keeper=None,
    *,
    activate=True,
    delivery_reserve=DELIVERY_RESERVE,
):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    direct_vm.warp(CREATED_ISO)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 0
    contract = direct_deploy(
        str(CONTRACT_PATH),
        as_address(treasury),
        as_address(keeper if keeper is not None else treasury),
        MIN_STAKE,
        MAX_STAKE,
        as_address(FACTORY_ADDRESS),
    )
    # Production activation is intentionally frozen until a real audited
    # factory address is compiled into V8. Direct mode anchors only this mock.
    contract_module = sys.modules[contract._instance.__class__.__module__]
    contract_module.AUDITED_PAYOUT_FACTORY_4221 = FACTORY_ADDRESS.lower()
    factory = MockPayoutFactory()
    factory.bound_arena = direct_vm._contract_address
    direct_vm._gl_call_hook = factory
    contract._test_payout_factory = factory
    direct_vm._chain_id = 4_221
    direct_vm._refresh_gl_message()
    if delivery_reserve > 0:
        direct_vm.value = delivery_reserve
        contract.fund_delivery_reserve()
        direct_vm.deal(
            direct_vm._contract_address,
            int(contract.balance) + delivery_reserve,
        )
        direct_vm.value = 0
    if activate:
        contract.activate_payouts()
    return contract


def payout_for_position(contract, account, objective):
    quote = contract.get_claim_quote(EPOCH_END, objective, as_address(account))
    return quote["payout_id"], quote


def fund_payout(direct_vm, contract, account, objective):
    payout_id, quote = payout_for_position(contract, account, objective)
    assert payout_id
    contract.dispatch_payout(payout_id)
    contract._test_payout_factory.credit(payout_id)
    contract.confirm_payout(payout_id)
    return payout_id, quote


def create_epoch(contract, epoch_end=EPOCH_END):
    contract.create_epoch(epoch_end)


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


def test_v8_pins_runner_and_exposes_fixed_policy(
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
    assert config["protocol_version"] == "LIQUIDITY_ARENA_V8"
    assert config["payout_protocol_version"] == "IDEMPOTENT_EVM_VAULT_V1"
    assert config["payouts_enabled"] is True
    assert config["new_risk_enabled"] is True
    assert config["payout_finality"] == "FUNDED_IN_ESCROW"
    assert str(config["keeper"]).lower() == str(as_address(direct_charlie)).lower()
    assert config["epoch_min_stake_atto"] == MIN_STAKE
    assert config["epoch_max_stake_per_wallet_atto"] == MAX_STAKE
    assert config["minimum_epoch_creation_lead_seconds"] == 3_600
    assert config["keeper_max_schedule_ahead_seconds"] == 26 * 3_600
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
        direct_deploy(
            str(CONTRACT_PATH),
            Address(bytes(20)),
            as_address(direct_owner),
            MIN_STAKE,
            MAX_STAKE,
            as_address(FACTORY_ADDRESS),
        )


def test_constructor_rejects_zero_keeper(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    from genlayer.py.types import Address

    direct_vm.warp(CREATED_ISO)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 0
    with direct_vm.expect_revert("KEEPER_ZERO"):
        direct_deploy(
            str(CONTRACT_PATH),
            as_address(direct_charlie),
            Address(bytes(20)),
            MIN_STAKE,
            MAX_STAKE,
            as_address(FACTORY_ADDRESS),
        )


def test_constructor_rejects_zero_minimum_stake(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    direct_vm.warp(CREATED_ISO)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 0
    with direct_vm.expect_revert("MIN_STAKE"):
        direct_deploy(
            str(CONTRACT_PATH),
            as_address(direct_charlie),
            as_address(direct_charlie),
            0,
            MAX_STAKE,
            as_address(FACTORY_ADDRESS),
        )


def test_constructor_rejects_wallet_cap_below_minimum(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    setup_sdk_paths(CONTRACT_PATH, "v0.2.16")
    direct_vm.warp(CREATED_ISO)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 0
    with direct_vm.expect_revert("MAX_WALLET_STAKE"):
        direct_deploy(
            str(CONTRACT_PATH),
            as_address(direct_charlie),
            as_address(direct_charlie),
            MIN_STAKE,
            MIN_STAKE - 1,
            as_address(FACTORY_ADDRESS),
        )


def test_keeper_is_limited_rotatable_and_revocable(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
        keeper=direct_charlie,
    )
    from genlayer.py.types import Address
    direct_vm.sender = as_address(direct_alice)
    with direct_vm.expect_revert("EPOCH_CREATOR"):
        contract.create_epoch(EPOCH_END)

    direct_vm.sender = as_address(direct_charlie)
    contract.create_epoch(EPOCH_END)
    epoch = contract.get_epoch(EPOCH_END)
    assert epoch["min_stake_atto"] == MIN_STAKE
    assert epoch["max_stake_per_wallet_atto"] == MAX_STAKE
    with direct_vm.expect_revert("ONLY_OWNER"):
        contract.set_platform_fee_bps(300)
    with direct_vm.expect_revert("ONLY_OWNER"):
        contract.propose_ownership(as_address(direct_charlie))
    with direct_vm.expect_revert("ONLY_OWNER"):
        contract.set_keeper(as_address(direct_alice))
    with direct_vm.expect_revert("FEE_OPERATOR"):
        contract.request_fee_payout(1)

    direct_vm.sender = as_address(direct_owner)
    contract.set_keeper(as_address(direct_alice))
    direct_vm.sender = as_address(direct_charlie)
    with direct_vm.expect_revert("EPOCH_CREATOR"):
        contract.create_epoch(SECOND_EPOCH_END)
    direct_vm.sender = as_address(direct_alice)
    contract.create_epoch(SECOND_EPOCH_END)

    direct_vm.sender = as_address(direct_owner)
    contract.set_keeper(Address(bytes(20)))
    direct_vm.sender = as_address(direct_alice)
    with direct_vm.expect_revert("EPOCH_CREATOR"):
        contract.create_epoch(EPOCH_END + 2 * 3_600)
    direct_vm.sender = as_address(direct_owner)
    contract.create_epoch(EPOCH_END + 2 * 3_600)


def test_keeper_schedule_horizon_and_notice_are_exact(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_bob,
        keeper=direct_charlie,
    )
    direct_vm.sender = as_address(direct_charlie)
    contract.create_epoch(EPOCH_END)
    contract.create_epoch(EPOCH_END + 25 * 3_600)
    with direct_vm.expect_revert("KEEPER_EPOCH_AHEAD"):
        contract.create_epoch(EPOCH_END + 26 * 3_600)

    direct_vm.sender = as_address(direct_owner)
    contract.create_epoch(EPOCH_END + 26 * 3_600)
    direct_vm.warp("2030-01-01T00:00:01Z")
    with direct_vm.expect_revert("EPOCH_NOTICE"):
        contract.create_epoch(SECOND_EPOCH_END - 3_600)


def test_two_step_owner_rotation_and_cancellation(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    from genlayer.py.types import Address
    direct_vm.sender = as_address(direct_owner)
    with direct_vm.expect_revert("OWNER_ZERO"):
        contract.propose_ownership(Address(bytes(20)))
    with direct_vm.expect_revert("OWNER_UNCHANGED"):
        contract.propose_ownership(as_address(direct_owner))

    contract.propose_ownership(as_address(direct_alice))
    direct_vm.sender = as_address(direct_bob)
    with direct_vm.expect_revert("PENDING_OWNER"):
        contract.accept_ownership()
    direct_vm.sender = as_address(direct_owner)
    contract.cancel_ownership_transfer()
    direct_vm.sender = as_address(direct_alice)
    with direct_vm.expect_revert("PENDING_OWNER"):
        contract.accept_ownership()

    direct_vm.sender = as_address(direct_owner)
    contract.propose_ownership(as_address(direct_alice))
    direct_vm.sender = as_address(direct_alice)
    contract.accept_ownership()
    config = contract.get_config()
    assert str(config["owner"]).lower() == str(as_address(direct_alice)).lower()
    assert str(config["pending_owner"]).lower() == "0x" + ("0" * 40)
    direct_vm.sender = as_address(direct_owner)
    with direct_vm.expect_revert("ONLY_OWNER"):
        contract.set_platform_fee_bps(300)
    direct_vm.sender = as_address(direct_alice)
    contract.set_platform_fee_bps(300)


def test_admin_and_epoch_management_reject_native_value(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    direct_vm.sender = as_address(direct_owner)
    direct_vm.value = 1
    with direct_vm.expect_revert("VALUE_NOT_ACCEPTED"):
        contract.set_keeper(as_address(direct_alice))
    with direct_vm.expect_revert("VALUE_NOT_ACCEPTED"):
        contract.propose_ownership(as_address(direct_alice))
    with direct_vm.expect_revert("VALUE_NOT_ACCEPTED"):
        contract.cancel_ownership_transfer()
    with direct_vm.expect_revert("VALUE_NOT_ACCEPTED"):
        contract.set_platform_fee_bps(300)
    with direct_vm.expect_revert("VALUE_NOT_ACCEPTED"):
        contract.create_epoch(EPOCH_END)

    direct_vm.value = 0
    contract.propose_ownership(as_address(direct_alice))
    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = 1
    with direct_vm.expect_revert("VALUE_NOT_ACCEPTED"):
        contract.accept_ownership()
    direct_vm.value = 0


def test_exact_hour_schedule_and_all_phase_boundaries(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_charlie,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    with direct_vm.expect_revert("EPOCH_HOURLY"):
        contract.create_epoch(EPOCH_END + 1)
    create_epoch(contract)
    summary = contract.get_epoch(EPOCH_END)
    assert contract.get_open_epoch_count() == 1
    open_page = contract.get_open_epoch_page(0, 50)
    assert open_page["total"] == 1
    assert open_page["epoch_ids"] == [str(EPOCH_END)]
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
    contract.create_epoch(SECOND_EPOCH_END)
    assert contract.get_epoch(EPOCH_END)["platform_fee_bps_snapshot"] == 200
    assert contract.get_epoch(SECOND_EPOCH_END)["platform_fee_bps_snapshot"] == 500
    with direct_vm.expect_revert("FEE_CAP"):
        contract.set_platform_fee_bps(501)

    direct_vm.warp(WAGER_OPEN_ISO)
    with direct_vm.expect_revert("EPOCH_NOTICE"):
        # A fresh contract would reject this E at the exact opening boundary;
        # this contract hits the notice guard before the duplicate guard.
        contract.create_epoch(EPOCH_END)


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
    alice_payout_id, _ = fund_payout(direct_vm, contract, alice, "HIGH")
    funded_quote = contract.get_claim_quote(EPOCH_END, "HIGH", alice)
    assert funded_quote["payout_state"] == "FUNDED_IN_ESCROW"
    assert funded_quote["escrow_funded_atto"] == 330
    assert funded_quote["claimed"] is False
    assert funded_quote["claimed_atto"] == 0
    contract._test_payout_factory.mark_withdrawn(alice_payout_id)
    contract.refresh_payout_withdrawal(alice_payout_id)
    withdrawn_quote = contract.get_claim_quote(EPOCH_END, "HIGH", alice)
    assert withdrawn_quote["claimed"] is True
    assert withdrawn_quote["claimed_atto"] == 330
    assert contract.get_payout(alice_payout_id)["state"] == "EOA_WITHDRAWN"
    contract.refresh_payout_withdrawal(alice_payout_id)
    charlie_quote = contract.get_claim_quote(EPOCH_END, "HIGH", charlie)
    assert charlie_quote["amount_atto"] == 662
    assert charlie_quote["includes_rounding_remainder"] is True
    direct_vm.sender = charlie
    contract.claim(EPOCH_END, "HIGH")
    charlie_payout_id, _ = fund_payout(direct_vm, contract, charlie, "HIGH")
    direct_vm.sender = bob
    contract.claim(EPOCH_END, "LOW")
    bob_payout_id, _ = fund_payout(direct_vm, contract, bob, "LOW")
    assert contract.get_total_player_liability_atto() == 0
    assert contract.get_payout(alice_payout_id)["state"] == "EOA_WITHDRAWN"
    assert contract.get_payout(charlie_payout_id)["state"] == "FUNDED_IN_ESCROW"
    assert contract.get_payout(bob_payout_id)["state"] == "FUNDED_IN_ESCROW"

    direct_vm.sender = as_address(direct_alice)
    with direct_vm.expect_revert("FEE_OPERATOR"):
        contract.request_fee_payout(1)
    direct_vm.sender = as_address(direct_owner)
    with direct_vm.expect_revert("FEE_ACCRUED"):
        contract.request_fee_payout(23)
    reserve_before_fee = contract.get_delivery_reserve_state()[
        "available_reserve_atto"
    ]
    contract.request_fee_payout(22)
    fee_payout = contract.get_payout_page(3, 1)["payouts"][0]
    fee_payout_id = fee_payout["payout_id"]
    assert fee_payout["withdrawn_at_timestamp"] == 0
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 66
    contract.dispatch_payout(fee_payout_id)
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 44
    with direct_vm.expect_revert("PAYOUT_NOT_CREDITED"):
        contract.confirm_payout(fee_payout_id)
    direct_vm.warp("2030-01-01T02:02:00Z")
    contract.retry_payout(fee_payout_id)
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 22
    assert contract._test_payout_factory.transfers[-2:] == [
        (fee_payout_id, 22),
        (fee_payout_id, 22),
    ]
    contract._test_payout_factory.credit(fee_payout_id)
    contract.confirm_payout(fee_payout_id)
    fee_state = contract.get_fee_state()
    assert fee_state["accrued_platform_fees_atto"] == 0
    assert fee_state["funded_platform_fees_atto"] == 22
    assert fee_state["withdrawn_platform_fees_atto"] == 0
    assert contract.get_config()["claimed_semantics"] == "EOA_WITHDRAWN"
    assert contract.get_config()["prepare_retries_capped"] is False
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 0
    assert (
        contract.get_delivery_reserve_state()["available_reserve_atto"]
        == reserve_before_fee - 22
    )
    contract._test_payout_factory.mark_withdrawn(fee_payout_id)
    contract.refresh_payout_withdrawal(fee_payout_id)
    assert contract.get_fee_state()["withdrawn_platform_fees_atto"] == 22
    assert contract.get_payout(fee_payout_id)["state"] == "EOA_WITHDRAWN"
    contract.refresh_payout_withdrawal(fee_payout_id)


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
    fund_payout(direct_vm, contract, direct_alice, "HIGH")
    contract.claim(EPOCH_END, "LOW")
    fund_payout(direct_vm, contract, direct_alice, "LOW")
    direct_vm.sender = as_address(direct_bob)
    contract.claim(EPOCH_END, "HIGH")
    fund_payout(direct_vm, contract, direct_bob, "HIGH")
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
    assert contract.get_open_epoch_count() == 0
    with direct_vm.expect_revert("EPOCH_NOT_OPEN"):
        contract.resolve_epoch(EPOCH_END)
    direct_vm.sender = as_address(direct_alice)
    contract.claim(EPOCH_END, "HIGH")
    fund_payout(direct_vm, contract, direct_alice, "HIGH")
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
    assert contract.get_open_epoch_count() == 0
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
    with direct_vm.expect_revert("PAGE_LIMIT"):
        contract.get_open_epoch_page(0, bad_limit)


def test_activation_fails_closed_by_chain_binding_and_factory_protocol(
    direct_vm, direct_deploy, direct_owner, direct_charlie
):
    contract = deploy_arena(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_charlie,
        activate=False,
    )
    factory = contract._test_payout_factory

    direct_vm._chain_id = 61_999
    direct_vm._refresh_gl_message()
    with direct_vm.expect_revert("PAYOUT_NETWORK_UNSUPPORTED"):
        contract.activate_payouts()

    direct_vm._chain_id = 4_221
    direct_vm._refresh_gl_message()
    contract_module = sys.modules[contract._instance.__class__.__module__]
    trusted_factory = contract_module.AUDITED_PAYOUT_FACTORY_4221
    contract_module.AUDITED_PAYOUT_FACTORY_4221 = (
        "0x000000000000000000000000000000000000dead"
    )
    with direct_vm.expect_revert("PAYOUT_FACTORY_UNTRUSTED"):
        contract.activate_payouts()
    contract_module.AUDITED_PAYOUT_FACTORY_4221 = trusted_factory

    factory.bound_arena = as_address(direct_owner)
    with direct_vm.expect_revert("PAYOUT_FACTORY_UNBOUND"):
        contract.activate_payouts()

    factory.bound_arena = direct_vm._contract_address
    factory.protocol = "WRONG_PROTOCOL"
    with direct_vm.expect_revert("PAYOUT_FACTORY_PROTOCOL"):
        contract.activate_payouts()

    factory.protocol = "IDEMPOTENT_EVM_VAULT_V1"
    contract.activate_payouts()
    assert contract.get_config()["payouts_enabled"] is True
    with direct_vm.expect_revert("PAYOUTS_ACTIVE"):
        contract.activate_payouts()


def test_resume_new_risk_rechecks_actual_accounting_solvency(
    direct_vm, direct_deploy, direct_owner, direct_charlie
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    direct_vm.sender = as_address(direct_owner)
    contract.pause_new_risk()
    assert contract.get_config()["new_risk_enabled"] is False

    direct_vm.deal(direct_vm._contract_address, DELIVERY_RESERVE - 1)
    with direct_vm.expect_revert("ACCOUNTING_INSOLVENT"):
        contract.resume_new_risk()
    assert contract.get_config()["new_risk_enabled"] is False


def test_new_wager_requires_full_bounded_attempt_reserve(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie
):
    contract = deploy_arena(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_charlie,
        delivery_reserve=299,
    )
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = 100
    with direct_vm.expect_revert("PAYOUT_RESERVE_CAPACITY"):
        contract.enter(EPOCH_END, "HIGH", "BTC")
    assert contract.get_total_player_liability_atto() == 0
    assert contract.get_delivery_reserve_state()["available_reserve_atto"] == 299


def test_payout_identity_is_amount_and_factory_domain_separated_and_immutable(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    direct_vm.value = 0
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    contract.activate_timeout_refund(EPOCH_END)
    direct_vm.sender = as_address(direct_alice)
    contract.claim(EPOCH_END, "HIGH")

    payout_id, quote = payout_for_position(contract, direct_alice, "HIGH")
    domain = {
        "amount_atto": 100,
        "chain_id": 4_221,
        "contract": normalized_address(direct_vm._contract_address),
        "epoch_end_timestamp": EPOCH_END,
        "factory": FACTORY_ADDRESS.lower(),
        "kind": "PLAYER",
        "nonce": 0,
        "objective": "HIGH",
        "payout_protocol": "IDEMPOTENT_EVM_VAULT_V1",
        "recipient": normalized_address(as_address(direct_alice)),
    }
    expected = keccak(
        text=json.dumps(domain, sort_keys=True, separators=(",", ":"))
    ).hex()
    assert payout_id == expected
    payout = contract.get_payout(payout_id)
    assert set(payout) == {
        "payout_id",
        "kind",
        "recipient",
        "amount_atto",
        "epoch_end_timestamp",
        "objective",
        "wallet_key",
        "stake_atto",
        "settlement_mode",
        "includes_rounding_remainder",
        "state",
        "prepare_attempt_count",
        "attempt_count",
        "reserve_remaining_atto",
        "vault",
        "created_at_timestamp",
        "last_prepare_timestamp",
        "last_dispatch_timestamp",
        "funded_at_timestamp",
        "withdrawn_at_timestamp",
        "escrow_withdrawn",
    }
    assert payout["recipient"] == normalized_address(as_address(direct_alice))
    assert payout["amount_atto"] == quote["amount_atto"] == 100
    assert payout["reserve_remaining_atto"] == 300
    with direct_vm.expect_revert("PAYOUT_EXISTS"):
        contract.claim(EPOCH_END, "HIGH")
    assert contract.get_payout_count() == 1


def test_retry_is_exact_capped_and_late_credit_remains_confirmable(
    direct_vm, direct_deploy, direct_owner, direct_alice, direct_charlie
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    direct_vm.value = 0
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    contract.activate_timeout_refund(EPOCH_END)
    direct_vm.sender = as_address(direct_alice)
    contract.claim(EPOCH_END, "HIGH")
    payout_id, _quote = payout_for_position(contract, direct_alice, "HIGH")

    contract.dispatch_payout(payout_id)
    with direct_vm.expect_revert("PAYOUT_NOT_CREDITED"):
        contract.confirm_payout(payout_id)
    with direct_vm.expect_revert("PAYOUT_RETRY_EARLY"):
        contract.retry_payout(payout_id)

    direct_vm.warp("2030-01-02T02:00:00Z")
    contract.retry_payout(payout_id)
    direct_vm.warp("2030-01-02T03:00:00Z")
    contract.retry_payout(payout_id)
    direct_vm.warp("2030-01-02T04:00:00Z")
    with direct_vm.expect_revert("PAYOUT_ATTEMPT_CAP"):
        contract.retry_payout(payout_id)
    assert contract._test_payout_factory.transfers == [
        (payout_id, 100),
        (payout_id, 100),
        (payout_id, 100),
    ]
    assert contract.get_total_player_liability_atto() == 100

    contract._test_payout_factory.credit(payout_id)
    contract.confirm_payout(payout_id)
    payout = contract.get_payout(payout_id)
    assert payout["state"] == "FUNDED_IN_ESCROW"
    assert payout["attempt_count"] == 3
    assert payout["reserve_remaining_atto"] == 0
    assert contract.get_total_player_liability_atto() == 0
    with direct_vm.expect_revert("PAYOUT_NOT_DISPATCHED"):
        contract.confirm_payout(payout_id)


def test_prepare_retry_is_permissionless_uncapped_and_vault_identity_fails_closed(
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
    direct_vm.value = 0
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    contract.activate_timeout_refund(EPOCH_END)
    direct_vm.sender = as_address(direct_alice)
    contract.claim(EPOCH_END, "HIGH")
    payout_id, _quote = payout_for_position(contract, direct_alice, "HIGH")
    factory = contract._test_payout_factory
    exact_prepared = factory.prepared.pop(payout_id)

    with direct_vm.expect_revert("PAYOUT_PREPARE_EARLY"):
        contract.retry_prepare_payout(payout_id)
    direct_vm.warp("2030-01-02T02:00:00Z")
    direct_vm.sender = as_address(direct_bob)
    contract.retry_prepare_payout(payout_id)
    assert factory.prepared[payout_id] == exact_prepared

    # Exact preparation carries zero value. Any caller can recover repeated
    # lost prepare children after cooldown, without a terminal retry cap.
    for hour in range(3, 7):
        factory.prepared.pop(payout_id)
        direct_vm.warp(f"2030-01-02T{hour:02d}:00:00Z")
        direct_vm.sender = as_address(direct_bob)
        contract.retry_prepare_payout(payout_id)
    assert contract.get_payout(payout_id)["prepare_attempt_count"] == 6

    factory.prepared[payout_id] = (normalized_address(direct_bob), 100)
    with direct_vm.expect_revert("PAYOUT_VAULT_UNPREPARED"):
        contract.dispatch_payout(payout_id)
    factory.prepared[payout_id] = exact_prepared
    contract.dispatch_payout(payout_id)

    factory.vault_overrides[payout_id] = "0x000000000000000000000000000000000000beef"
    direct_vm.warp("2030-01-02T07:00:00Z")
    direct_vm.sender = as_address(direct_alice)
    with direct_vm.expect_revert("PAYOUT_VAULT_CHANGED"):
        contract.retry_payout(payout_id)


def test_confirm_records_player_withdrawal_already_proven_by_escrow(
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
    place_wager(direct_vm, contract, direct_bob, "HIGH", "ETH", 100)
    resolve(direct_vm, contract, default_market())

    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = 0
    contract.claim(EPOCH_END, "HIGH")
    payout_id, quote = payout_for_position(contract, direct_alice, "HIGH")
    contract.dispatch_payout(payout_id)
    contract._test_payout_factory.credit(payout_id)
    contract._test_payout_factory.mark_withdrawn(payout_id)
    contract.confirm_payout(payout_id)

    payout = contract.get_payout(payout_id)
    assert payout["state"] == "EOA_WITHDRAWN"
    assert payout["escrow_withdrawn"] is True
    assert payout["withdrawn_at_timestamp"] > 0
    after = contract.get_claim_quote(EPOCH_END, "HIGH", as_address(direct_alice))
    assert after["claimed"] is True
    assert after["claimed_atto"] == quote["amount_atto"] == 198
    objective = contract.get_objective(EPOCH_END, "HIGH")
    assert objective["funded_in_escrow_atto"] == 198
    assert objective["paid_atto"] == 198


def test_interleaved_player_and_fee_payouts_preserve_aggregate_reserve_invariants(
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
    place_wager(direct_vm, contract, direct_bob, "HIGH", "ETH", 100)
    resolve(direct_vm, contract, default_market())
    assert contract.get_total_player_liability_atto() == 198
    assert contract.get_fee_state()["accrued_platform_fees_atto"] == 2

    reserve_start = contract.get_delivery_reserve_state()["available_reserve_atto"]
    direct_vm.sender = as_address(direct_alice)
    direct_vm.value = 0
    contract.claim(EPOCH_END, "HIGH")
    player_id, _quote = payout_for_position(contract, direct_alice, "HIGH")
    direct_vm.sender = as_address(direct_owner)
    contract.request_fee_payout(2)
    fee_id = contract.get_payout_page(1, 1)["payouts"][0]["payout_id"]

    reserve = contract.get_delivery_reserve_state()
    assert reserve["reserved_player_payouts_atto"] == 198
    assert reserve["reserved_platform_fees_atto"] == 2
    assert reserve["committed_reserve_atto"] == 600
    assert reserve["available_reserve_atto"] == reserve_start - 600

    contract.dispatch_payout(player_id)
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 402
    contract.dispatch_payout(fee_id)
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 400
    direct_vm.warp("2030-01-01T02:02:00Z")
    contract.retry_payout(fee_id)
    assert contract.get_delivery_reserve_state()["committed_reserve_atto"] == 398

    contract._test_payout_factory.credit(player_id)
    contract.confirm_payout(player_id)
    contract._test_payout_factory.credit(fee_id)
    contract._test_payout_factory.mark_withdrawn(fee_id)
    contract.confirm_payout(fee_id)

    reserve = contract.get_delivery_reserve_state()
    assert reserve["reserved_player_payouts_atto"] == 0
    assert reserve["reserved_platform_fees_atto"] == 0
    assert reserve["committed_reserve_atto"] == 0
    assert reserve["available_reserve_atto"] == reserve_start - 2
    assert contract.get_total_player_liability_atto() == 0
    fees = contract.get_fee_state()
    assert fees["accrued_platform_fees_atto"] == 0
    assert fees["reserved_platform_fees_atto"] == 0
    assert fees["funded_platform_fees_atto"] == 2
    assert fees["withdrawn_platform_fees_atto"] == 2
    assert contract.get_payout(player_id)["state"] == "FUNDED_IN_ESCROW"
    assert contract.get_payout(fee_id)["state"] == "EOA_WITHDRAWN"
    assert int(contract.balance) == contract._accounted_balance_atto()


def test_two_simultaneous_payouts_have_isolated_attempt_budgets(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
):
    contract = deploy_arena(
        direct_vm,
        direct_deploy,
        direct_owner,
        direct_charlie,
        delivery_reserve=600,
    )
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 100)
    place_wager(direct_vm, contract, direct_bob, "LOW", "XRP", 100)
    direct_vm.value = 0
    direct_vm.warp(TIMEOUT_AVAILABLE_ISO)
    contract.activate_timeout_refund(EPOCH_END)

    direct_vm.sender = as_address(direct_alice)
    contract.claim(EPOCH_END, "HIGH")
    alice_id, _ = payout_for_position(contract, direct_alice, "HIGH")
    direct_vm.sender = as_address(direct_bob)
    contract.claim(EPOCH_END, "LOW")
    bob_id, _ = payout_for_position(contract, direct_bob, "LOW")
    reserve = contract.get_delivery_reserve_state()
    assert reserve["available_reserve_atto"] == 0
    assert reserve["committed_reserve_atto"] == 600

    contract.dispatch_payout(alice_id)
    contract._test_payout_factory.credit(alice_id)
    contract.confirm_payout(alice_id)
    reserve = contract.get_delivery_reserve_state()
    assert reserve["available_reserve_atto"] == 300
    assert reserve["committed_reserve_atto"] == 300
    assert contract.get_payout(bob_id)["reserve_remaining_atto"] == 300
    assert contract.get_total_player_liability_atto() == 100

    contract.dispatch_payout(bob_id)
    contract._test_payout_factory.credit(bob_id)
    contract.confirm_payout(bob_id)
    assert contract.get_total_player_liability_atto() == 0
    assert contract.get_delivery_reserve_state()["available_reserve_atto"] == 600


@pytest.mark.parametrize(
    ("first", "first_amount", "second_amount"),
    (("alice", 330, 662), ("charlie", 661, 331)),
)
def test_every_two_winner_claim_order_allocates_exact_rounding_remainder(
    direct_vm,
    direct_deploy,
    direct_owner,
    direct_alice,
    direct_bob,
    direct_charlie,
    first,
    first_amount,
    second_amount,
):
    contract = deploy_arena(direct_vm, direct_deploy, direct_owner, direct_charlie)
    create_epoch(contract)
    direct_vm.warp(WAGER_OPEN_ISO)
    place_wager(direct_vm, contract, direct_alice, "HIGH", "BTC", 200)
    place_wager(direct_vm, contract, direct_charlie, "HIGH", "BTC", 400)
    place_wager(direct_vm, contract, direct_bob, "HIGH", "ETH", 400)
    resolve(direct_vm, contract, default_market())

    accounts = {
        "alice": as_address(direct_alice),
        "charlie": as_address(direct_charlie),
    }
    second = "charlie" if first == "alice" else "alice"
    direct_vm.sender = accounts[first]
    contract.claim(EPOCH_END, "HIGH")
    first_id, first_quote = payout_for_position(contract, accounts[first], "HIGH")
    direct_vm.sender = accounts[second]
    contract.claim(EPOCH_END, "HIGH")
    second_id, second_quote = payout_for_position(contract, accounts[second], "HIGH")
    assert first_quote["amount_atto"] == first_amount
    assert second_quote["amount_atto"] == second_amount
    assert first_quote["includes_rounding_remainder"] is False
    assert second_quote["includes_rounding_remainder"] is True
    assert contract.get_objective(EPOCH_END, "HIGH")["allocated_atto"] == 992

    contract.dispatch_payout(first_id)
    contract._test_payout_factory.credit(first_id)
    contract.confirm_payout(first_id)
    contract.dispatch_payout(second_id)
    contract._test_payout_factory.credit(second_id)
    contract.confirm_payout(second_id)
    assert contract.get_total_player_liability_atto() == 0
