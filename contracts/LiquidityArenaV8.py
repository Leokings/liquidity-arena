# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import genlayer.gl._internal.gl_call as _gl_call
from genlayer.py.evm.calldata import MethodEncoder, decode as _decode_evm
import datetime
import json


PROTOCOL_VERSION = "LIQUIDITY_ARENA_V8"
POLICY_VERSION = "CRYPTO_SPOT_1M_MEDIAN_V1"
PAYOUT_PROTOCOL_VERSION = "IDEMPOTENT_EVM_VAULT_V1"

STATUS_OPEN = "OPEN"
STATUS_RESOLVED = "RESOLVED"
STATUS_TIMED_OUT = "TIMED_OUT"

RESULT_PENDING = "PENDING"
RESULT_DETERMINED = "DETERMINED"
RESULT_TIMEOUT = "TIMEOUT"

OBJECTIVE_HIGH = "HIGH"
OBJECTIVE_LOW = "LOW"
SUPPORTED_OBJECTIVES = (OBJECTIVE_HIGH, OBJECTIVE_LOW)

WINNER_TIE = "TIE"

SETTLEMENT_PENDING = "PENDING"
SETTLEMENT_PARIMUTUEL = "PARIMUTUEL"
SETTLEMENT_REFUND_TIE = "REFUND_TIE"
SETTLEMENT_REFUND_UNBACKED_WINNER = "REFUND_UNBACKED_WINNER"
SETTLEMENT_REFUND_NO_LOSING_SIDE = "REFUND_NO_LOSING_SIDE"
SETTLEMENT_REFUND_TIMEOUT = "REFUND_TIMEOUT"
REFUND_SETTLEMENT_MODES = (
    SETTLEMENT_REFUND_TIE,
    SETTLEMENT_REFUND_UNBACKED_WINNER,
    SETTLEMENT_REFUND_NO_LOSING_SIDE,
    SETTLEMENT_REFUND_TIMEOUT,
)
ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"

HOUR_SECONDS = 60 * 60
WAGER_OPEN_OFFSET_SECONDS = 40 * 60
BATTLE_OPEN_OFFSET_SECONDS = 20 * 60
RESOLUTION_PUBLICATION_DELAY_SECONDS = 120
TIMEOUT_REFUND_DELAY_SECONDS = 24 * 60 * 60
MAX_SCHEDULE_AHEAD_SECONDS = 31 * 24 * 60 * 60
MIN_EPOCH_CREATION_LEAD_SECONDS = 60 * 60
KEEPER_MAX_SCHEDULE_AHEAD_SECONDS = 26 * 60 * 60
ZERO_ADDRESS_TEXT = "0x" + ("0" * 40)

DEFAULT_PLATFORM_FEE_BPS = 200
BPS_DENOMINATOR = 10_000

PRICE_SCALE = 100_000_000
RETURN_SCALE = 1_000_000_000
MAX_PRICE_E8 = 10**22
VALIDATOR_RETURN_TOLERANCE_PPB = 100_000
MIN_QUALIFIED_VENUES = 3
MAX_SOURCE_BYTES = 512_000
MAX_PAGE_SIZE = 50

PAYOUT_PREPARING = "PREPARING"
PAYOUT_DISPATCHED = "DISPATCHED"
PAYOUT_FUNDED_IN_ESCROW = "FUNDED_IN_ESCROW"
PAYOUT_EOA_WITHDRAWN = "EOA_WITHDRAWN"
PAYOUT_KIND_PLAYER = "PLAYER"
PAYOUT_KIND_FEE = "FEE"
PAYOUT_RETRY_DELAY_SECONDS = 60 * 60
MAX_PAYOUT_ATTEMPTS = 3
SUPPORTED_ESCROW_CHAIN_IDS = (4_221,)
# Activation trusts only the independently deployed, bytecode-verified immutable
# factory frozen into this source. Constructor input and factory self-reporting
# alone are not security anchors.
AUDITED_PAYOUT_FACTORY_4221 = "0x944fdadd826c2a159c63cb100db174716ccd1317"

VENUE_BINANCE = "BINANCE"
VENUE_OKX = "OKX"
VENUE_BYBIT = "BYBIT"
VENUE_GATE = "GATE"
VENUE_KUCOIN = "KUCOIN"
APPROVED_VENUES = (
    VENUE_BINANCE,
    VENUE_OKX,
    VENUE_BYBIT,
    VENUE_GATE,
    VENUE_KUCOIN,
)

APPROVED_ASSETS = (
    ("BTC", "Bitcoin"),
    ("ETH", "Ethereum"),
    ("BNB", "BNB"),
    ("SOL", "Solana"),
    ("XRP", "XRP"),
)

BINANCE_HOST = "https://data-api.binance.vision"
OKX_HOST = "https://www.okx.com"
BYBIT_HOST = "https://api.bybit.com"
GATE_HOST = "https://api.gateio.ws"
KUCOIN_HOST = "https://api.kucoin.com"


@gl.evm.contract_interface
class _EOARecipient:
    class View:
        pass

    class Write:
        pass


_FACTORY_IS_BOUND = MethodEncoder("is_bound", (Address,), bool)
_FACTORY_PROTOCOL_VERSION = MethodEncoder("protocol_version", (), str)
_FACTORY_IS_PREPARED = MethodEncoder(
    "is_prepared",
    (str, Address, u256),
    bool,
)
_FACTORY_VAULT_OF = MethodEncoder("vault_of", (str,), Address)
_FACTORY_IS_CREDITED = MethodEncoder(
    "is_credited",
    (str, Address, u256),
    bool,
)
_FACTORY_IS_WITHDRAWN = MethodEncoder(
    "is_withdrawn",
    (str, Address, u256),
    bool,
)
_FACTORY_PREPARE = MethodEncoder(
    "prepare",
    (str, Address, u256),
    type(None),
)


def _evm_factory_view(
    factory: Address,
    encoder: MethodEncoder,
    args: tuple,
    result_type: type,
):
    calldata = encoder.encode_call(args)
    return _gl_call.gl_call_generic(
        {"EthCall": {"address": factory, "calldata": calldata}},
        lambda raw: _decode_evm(result_type, raw),
    ).get()


def _evm_factory_prepare(
    factory: Address,
    payout_id: str,
    recipient: Address,
    amount_atto: int,
) -> None:
    calldata = _FACTORY_PREPARE.encode_call(
        (payout_id, recipient, u256(amount_atto))
    )
    _gl_call.gl_call_generic(
        {
            "EthSend": {
                "address": factory,
                "calldata": calldata,
                "value": u256(0),
            }
        },
        lambda _raw: None,
    ).get()


def _expected(code: str, message: str):
    raise gl.vm.UserError(f"{ERROR_EXPECTED} {code}: {message}")


def _external(code: str, message: str):
    raise gl.vm.UserError(f"{ERROR_EXTERNAL} {code}: {message}")


def _transient(code: str, message: str):
    raise gl.vm.UserError(f"{ERROR_TRANSIENT} {code}: {message}")


def _canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _now_epoch() -> int:
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp())


def _address_text(value: Address) -> str:
    return value.as_hex.lower()


def _clean_objective(value: str) -> str:
    normalized = value.strip().upper()
    if normalized not in SUPPORTED_OBJECTIVES:
        _expected("OBJECTIVE", "Objective must be HIGH or LOW")
    return normalized


def _asset_definition(asset_id: str):
    normalized = asset_id.strip().upper()
    for approved_id, label in APPROVED_ASSETS:
        if approved_id == normalized:
            return approved_id, label
    _expected("ASSET", "Asset must be BTC, ETH, BNB, SOL, or XRP")


def _epoch_key(epoch_end_timestamp: int) -> str:
    return str(epoch_end_timestamp)


def _objective_key(epoch_key: str, objective: str) -> str:
    return epoch_key + "|" + objective


def _asset_key(epoch_key: str, asset_id: str) -> str:
    return epoch_key + "|" + asset_id


def _wallet_entry_key(epoch_key: str, objective: str, account: Address) -> str:
    return epoch_key + "|" + objective + "|" + _address_text(account)


def _page_bounds(offset: u256, limit: u256, count: int) -> tuple[int, int]:
    start = int(offset)
    page_limit = int(limit)
    if page_limit <= 0 or page_limit > MAX_PAGE_SIZE:
        _expected("PAGE_LIMIT", "Page limit must be between 1 and 50")
    if start < 0 or start > count:
        _expected("PAGE_OFFSET", "Page offset is out of bounds")
    end = start + page_limit
    return start, count if end > count else end


def _symbol_for(venue: str, asset_id: str) -> str:
    if venue == VENUE_OKX or venue == VENUE_KUCOIN:
        return asset_id + "-USDT"
    if venue == VENUE_GATE:
        return asset_id + "_USDT"
    return asset_id + "USDT"


def _decimal_to_e8(raw) -> int:
    if raw is None or isinstance(raw, bool):
        _external("PRICE_EMPTY", "Candle price is empty or boolean")
    text = str(raw).strip()
    if len(text) == 0 or text.startswith("-") or "e" in text.lower():
        _external("PRICE_REPRESENTATION", "Candle price uses an unsupported representation")
    if text.startswith("+"):
        text = text[1:]
    pieces = text.split(".")
    if len(pieces) > 2:
        _external("PRICE_DECIMAL", "Candle price is not a decimal")
    whole = pieces[0] if len(pieces[0]) > 0 else "0"
    fraction = pieces[1] if len(pieces) == 2 else ""
    if (
        not whole.isascii()
        or not whole.isdigit()
        or (
            len(fraction) > 0
            and (not fraction.isascii() or not fraction.isdigit())
        )
    ):
        _external("PRICE_NUMERIC", "Candle price is not numeric")
    fraction_e8 = (fraction + ("0" * 8))[:8]
    result = int(whole) * PRICE_SCALE + int(fraction_e8 or "0")
    if result <= 0 or result > MAX_PRICE_E8:
        _external("PRICE_DECIMAL_RANGE", "Candle price is outside the supported range")
    return result


def _integer_timestamp(raw, code: str) -> int:
    if raw is None or isinstance(raw, bool):
        _external(code + "_MISSING", "Candle timestamp is missing")
    text = str(raw).strip()
    if not text.isascii() or not text.isdigit():
        _external(code + "_FORMAT", "Candle timestamp must be a base-10 integer")
    return int(text)


def _return_ppb(start_open_e8: int, end_close_e8: int) -> int:
    if start_open_e8 <= 0 or end_close_e8 <= 0:
        _external("RETURN_PRICE_RANGE", "Settlement prices must be positive")
    return ((end_close_e8 - start_open_e8) * RETURN_SCALE) // start_open_e8


def _median_returns(values: list[int]) -> int:
    if len(values) < MIN_QUALIFIED_VENUES or len(values) > len(APPROVED_VENUES):
        _external("MEDIAN_COUNT", "Median requires three to five venue returns")
    ordered = sorted(values)
    count = len(ordered)
    if count == 4:
        # V1 policy: the four-venue median is floor((middle-low + middle-high) / 2).
        # Python integer // is defined for signed integers and never uses floats.
        return (ordered[1] + ordered[2]) // 2
    return ordered[count // 2]


def _price_pair(start_open, end_close) -> dict:
    return {
        "start_open_e8": _decimal_to_e8(start_open),
        "end_close_e8": _decimal_to_e8(end_close),
    }


def _parse_venue_payload(
    venue: str,
    payload,
    battle_start: int,
    epoch_end: int,
) -> dict:
    factor = 1000
    open_index = 1
    close_index = 4
    minimum_row_length = 7
    if venue == VENUE_BINANCE:
        rows = payload
    elif venue == VENUE_OKX:
        if not isinstance(payload, dict) or str(payload.get("code", "")) != "0":
            _external("OKX_STATUS", "OKX returned a non-success response")
        rows = payload.get("data")
        minimum_row_length = 9
    elif venue == VENUE_BYBIT:
        if not isinstance(payload, dict) or int(payload.get("retCode", -1)) != 0:
            _external("BYBIT_STATUS", "Bybit returned a non-success response")
        result = payload.get("result")
        rows = result.get("list") if isinstance(result, dict) else None
    elif venue == VENUE_GATE:
        rows = payload
        factor = 1
        open_index = 5
        close_index = 2
        minimum_row_length = 8
    elif venue == VENUE_KUCOIN:
        if not isinstance(payload, dict) or str(payload.get("code", "")) != "200000":
            _external("KUCOIN_STATUS", "KuCoin returned a non-success response")
        data = payload.get("data")
        rows = data.get("list") if isinstance(data, dict) else data
        factor = 1
    else:
        _external("VENUE_PARSER", "Unknown immutable candle adapter")
    if not isinstance(rows, list):
        _external(venue + "_PAYLOAD_SCHEMA", "Candle data must be an array")

    start_timestamp = battle_start * factor
    end_timestamp = (epoch_end - 60) * factor
    start_open = None
    end_close = None
    for row in rows:
        if not isinstance(row, list) or len(row) < minimum_row_length:
            _external(venue + "_ROW_SCHEMA", "Candle row is malformed")
        timestamp = _integer_timestamp(row[0], venue + "_TIMESTAMP")
        complete = True
        if venue == VENUE_OKX:
            complete = str(row[8]) == "1"
        elif venue == VENUE_GATE:
            complete = row[7] is True or str(row[7]).lower() == "true"
        elif venue == VENUE_BINANCE and timestamp == end_timestamp:
            complete = _integer_timestamp(
                row[6],
                "BINANCE_CLOSE_TIMESTAMP",
            ) < epoch_end * 1000
        if timestamp == start_timestamp:
            if not complete:
                _external(venue + "_OPEN_INCOMPLETE", "Opening candle is not complete")
            start_open = row[open_index]
        if timestamp == end_timestamp:
            if not complete:
                _external(venue + "_CLOSE_INCOMPLETE", "Closing candle is not complete")
            end_close = row[close_index]
    if start_open is None or end_close is None:
        _external(venue + "_CANDLES", "A required exact one-minute candle is missing")
    return _price_pair(start_open, end_close)


def _source_url(venue: str, asset_id: str, battle_start: int, epoch_end: int) -> str:
    symbol = _symbol_for(venue, asset_id)
    if venue == VENUE_BINANCE:
        return (
            BINANCE_HOST
            + "/api/v3/klines?symbol="
            + symbol
            + "&interval=1m&startTime="
            + str(battle_start * 1000)
            + "&endTime="
            + str(epoch_end * 1000 - 1)
            + "&limit=20"
        )
    if venue == VENUE_OKX:
        return (
            OKX_HOST
            + "/api/v5/market/history-candles?instId="
            + symbol
            + "&bar=1m&after="
            + str(epoch_end * 1000)
            + "&limit=20"
        )
    if venue == VENUE_BYBIT:
        return (
            BYBIT_HOST
            + "/v5/market/kline?category=spot&symbol="
            + symbol
            + "&interval=1&start="
            + str(battle_start * 1000)
            + "&end="
            + str(epoch_end * 1000 - 1)
            + "&limit=20"
        )
    if venue == VENUE_GATE:
        return (
            GATE_HOST
            + "/api/v4/spot/candlesticks?currency_pair="
            + symbol
            + "&from="
            + str(battle_start)
            + "&to="
            + str(epoch_end)
            + "&interval=1m"
        )
    if venue == VENUE_KUCOIN:
        return (
            KUCOIN_HOST
            + "/api/ua/v1/market/kline?tradeType=SPOT&symbol="
            + symbol
            + "&interval=1min&startAt="
            + str(battle_start)
            + "&endAt="
            + str(epoch_end)
        )
    _external("VENUE_SOURCE", "Unknown immutable candle adapter")


def _fetch_json(url: str):
    response = gl.nondet.web.get(url)
    if response.status >= 500:
        _transient("SOURCE_UNAVAILABLE", "Candle source is temporarily unavailable")
    if response.status >= 400:
        _external("SOURCE_REJECTED", "Candle source rejected the public request")
    if len(response.body) > MAX_SOURCE_BYTES:
        _external("SOURCE_SIZE", "Candle source response is too large")
    try:
        return json.loads(response.body.decode("utf-8"))
    except Exception:
        _external("SOURCE_JSON", "Candle source returned malformed JSON")


def _fetch_venue_result(venue: str, battle_start: int, epoch_end: int):
    asset_results = []
    try:
        for asset_id, _label in APPROVED_ASSETS:
            payload = _fetch_json(_source_url(venue, asset_id, battle_start, epoch_end))
            prices = _parse_venue_payload(venue, payload, battle_start, epoch_end)
            asset_results.append(
                [
                    asset_id,
                    _return_ppb(
                        prices["start_open_e8"],
                        prices["end_close_e8"],
                    ),
                ]
            )
    except Exception:
        # A venue is atomic: one missing, malformed, or unavailable asset
        # disqualifies that venue for the entire five-asset result vector.
        return None
    return [venue, asset_results]


def _winner_from_assets(assets: list, objective: str) -> tuple[str, int]:
    winning_return = None
    winners = []
    for item in assets:
        score = int(item[1])
        better = (
            winning_return is None
            or (objective == OBJECTIVE_HIGH and score > winning_return)
            or (objective == OBJECTIVE_LOW and score < winning_return)
        )
        if better:
            winning_return = score
            winners = [item[0]]
        elif score == winning_return:
            winners.append(item[0])
    if winning_return is None:
        _external("RESULT_EMPTY", "Determined result vector cannot be empty")
    return (winners[0] if len(winners) == 1 else WINNER_TIE, winning_return)


def _resolve_market(epoch_end: int) -> list:
    battle_start = epoch_end - BATTLE_OPEN_OFFSET_SECONDS
    qualified = []
    for venue in APPROVED_VENUES:
        venue_result = _fetch_venue_result(venue, battle_start, epoch_end)
        if venue_result is not None:
            qualified.append(venue_result)

    qualified_names = [item[0] for item in qualified]
    if len(qualified) < MIN_QUALIFIED_VENUES:
        # Source outages and endpoint differences are not reliable evidence of
        # an economic outcome. Keep the epoch OPEN so any caller can retry the
        # same immutable policy; the 24-hour timeout is the deterministic
        # zero-fee refund path if quorum never becomes available.
        _transient(
            "VENUE_QUORUM",
            "Fewer than three complete five-asset venue vectors are available; retry resolution",
        )

    assets = []
    for asset_index in range(len(APPROVED_ASSETS)):
        asset_id = APPROVED_ASSETS[asset_index][0]
        venue_returns = []
        for venue_result in qualified:
            item = venue_result[1][asset_index]
            if item[0] != asset_id:
                _external("VENUE_ASSET_ORDER", "Venue asset vector is out of order")
            venue_returns.append(int(item[1]))
        assets.append(
            [asset_id, _median_returns(venue_returns), venue_returns]
        )
    return [qualified_names, assets]


def _validate_resolution_result(result) -> list:
    if not isinstance(result, list) or len(result) != 2:
        _external("RESULT_SCHEMA", "Resolution result has invalid fields")
    venues = result[0]
    if (
        not isinstance(venues, list)
        or len(venues) < MIN_QUALIFIED_VENUES
        or len(venues) > len(APPROVED_VENUES)
    ):
        _external("RESULT_VENUE_COUNT", "Qualified venue count is invalid")
    canonical_venues = []
    next_venue_index = 0
    for venue in venues:
        venue_text = str(venue)
        found = False
        while next_venue_index < len(APPROVED_VENUES):
            expected_venue = APPROVED_VENUES[next_venue_index]
            next_venue_index += 1
            if venue_text == expected_venue:
                found = True
                break
        if not found:
            _external("RESULT_VENUE_ORDER", "Qualified venues are unknown, duplicated, or out of order")
        canonical_venues.append(venue_text)
    raw_assets = result[1]
    if not isinstance(raw_assets, list) or len(raw_assets) != len(APPROVED_ASSETS):
        _external("RESULT_ASSETS", "Determined result must contain the fixed five-asset basket")
    canonical_assets = []
    for index in range(len(APPROVED_ASSETS)):
        raw_item = raw_assets[index]
        if not isinstance(raw_item, list) or len(raw_item) != 3:
            _external("RESULT_ASSET_SCHEMA", "Resolution asset result is malformed")
        expected_asset_id = APPROVED_ASSETS[index][0]
        if str(raw_item[0]) != expected_asset_id:
            _external("RESULT_ASSET_ORDER", "Resolution assets are out of order")
        raw_returns = raw_item[2]
        if not isinstance(raw_returns, list) or len(raw_returns) != len(venues):
            _external("RESULT_RETURNS", "Venue return vector has the wrong length")
        venue_returns = []
        for raw_return in raw_returns:
            if isinstance(raw_return, bool):
                _external("RESULT_RETURN_BOOL", "Venue return cannot be boolean")
            try:
                venue_returns.append(int(raw_return))
            except Exception:
                _external("RESULT_RETURN_VALUE", "Venue return is invalid")
        if isinstance(raw_item[1], bool):
            _external("RESULT_MEDIAN_BOOL", "Median return cannot be boolean")
        try:
            median_return = int(raw_item[1])
        except Exception:
            _external("RESULT_MEDIAN_VALUE", "Median return is invalid")
        if median_return != _median_returns(venue_returns):
            _external("RESULT_MEDIAN", "Median return is inconsistent with venue returns")
        canonical_assets.append([expected_asset_id, median_return, venue_returns])
    return [canonical_venues, canonical_assets]


def _results_equivalent(leader_result: list, validator_result: list) -> bool:
    leader_assets = leader_result[1]
    validator_assets = validator_result[1]
    if _winner_from_assets(leader_assets, OBJECTIVE_HIGH)[0] != _winner_from_assets(
        validator_assets,
        OBJECTIVE_HIGH,
    )[0] or _winner_from_assets(leader_assets, OBJECTIVE_LOW)[0] != _winner_from_assets(
        validator_assets,
        OBJECTIVE_LOW,
    )[0]:
        return False
    for index in range(len(APPROVED_ASSETS)):
        leader_return = int(leader_assets[index][1])
        validator_return = int(validator_assets[index][1])
        difference = leader_return - validator_return
        if difference < 0:
            difference = -difference
        if difference > VALIDATOR_RETURN_TOLERANCE_PPB:
            return False
    return True


def _handle_leader_error(leaders_res: gl.vm.Result, leader_fn) -> bool:
    leader_message = leaders_res.message if hasattr(leaders_res, "message") else ""
    try:
        leader_fn()
        return False
    except gl.vm.UserError as validator_error:
        validator_message = (
            validator_error.message
            if hasattr(validator_error, "message")
            else str(validator_error)
        )
        if (
            validator_message.startswith(ERROR_TRANSIENT)
            and leader_message.startswith(ERROR_TRANSIENT)
        ):
            return True
        if validator_message.startswith(ERROR_EXPECTED) or validator_message.startswith(
            ERROR_EXTERNAL
        ):
            return validator_message == leader_message
        return False
    except Exception:
        return False


class LiquidityArenaV8(gl.Contract):
    owner: Address
    keeper: Address
    treasury: Address
    payout_vault_factory: Address
    payouts_enabled: bool
    new_risk_enabled: bool
    epoch_min_stake_atto: u256
    epoch_max_stake_per_wallet_atto: u256
    platform_fee_bps: u256
    total_player_liability_atto: u256
    accrued_platform_fees_atto: u256
    reserved_platform_fees_atto: u256
    funded_platform_fees_atto: u256
    withdrawn_platform_fees_atto: u256
    delivery_reserve_atto: u256
    committed_delivery_reserve_atto: u256
    reserved_player_payouts_atto: u256
    fee_payout_nonce: u256

    epoch_ids: DynArray[str]
    epoch_exists: TreeMap[str, bool]
    epoch_records: TreeMap[str, str]
    epoch_asset_records: TreeMap[str, str]
    objective_records: TreeMap[str, str]

    objective_total_stake_atto: TreeMap[str, u256]
    objective_participant_count: TreeMap[str, u256]
    objective_allocated_atto: TreeMap[str, u256]
    objective_funded_atto: TreeMap[str, u256]
    objective_paid_atto: TreeMap[str, u256]
    objective_unclaimed_winning_stake_atto: TreeMap[str, u256]
    asset_objective_stake_atto: TreeMap[str, u256]

    wallet_stake_atto: TreeMap[str, u256]
    wallet_choice_asset: TreeMap[str, str]
    wallet_seen: TreeMap[str, bool]
    wallet_claimed: TreeMap[str, bool]
    wallet_claimed_atto: TreeMap[str, u256]
    wallet_escrow_funded_atto: TreeMap[str, u256]
    wallet_payout_id: TreeMap[str, str]

    payout_ids: DynArray[str]
    payout_records: TreeMap[str, str]

    def __init__(
        self,
        treasury: Address,
        keeper: Address,
        epoch_min_stake_atto: u256,
        epoch_max_stake_per_wallet_atto: u256,
        payout_vault_factory: Address,
    ):
        if int(gl.message.value) != 0:
            _expected("VALUE_NOT_ACCEPTED", "Deployment does not accept native value")
        if _address_text(treasury) == ZERO_ADDRESS_TEXT:
            _expected("TREASURY_ZERO", "Treasury cannot be the zero address")
        if _address_text(keeper) == ZERO_ADDRESS_TEXT:
            _expected("KEEPER_ZERO", "Initial keeper cannot be the zero address")
        if _address_text(payout_vault_factory) == ZERO_ADDRESS_TEXT:
            _expected("PAYOUT_FACTORY_ZERO", "Payout vault factory cannot be zero")
        minimum_stake = int(epoch_min_stake_atto)
        maximum_wallet_stake = int(epoch_max_stake_per_wallet_atto)
        if minimum_stake <= 0:
            _expected("MIN_STAKE", "Minimum stake must be positive")
        if maximum_wallet_stake < minimum_stake:
            _expected("MAX_WALLET_STAKE", "Wallet cap must be at least the minimum stake")
        self.owner = gl.message.sender_address
        self.keeper = keeper
        self.treasury = treasury
        self.payout_vault_factory = payout_vault_factory
        self.payouts_enabled = False
        self.new_risk_enabled = False
        self.epoch_min_stake_atto = u256(minimum_stake)
        self.epoch_max_stake_per_wallet_atto = u256(maximum_wallet_stake)
        self.platform_fee_bps = u256(DEFAULT_PLATFORM_FEE_BPS)
        self.total_player_liability_atto = u256(0)
        self.accrued_platform_fees_atto = u256(0)
        self.reserved_platform_fees_atto = u256(0)
        self.funded_platform_fees_atto = u256(0)
        self.withdrawn_platform_fees_atto = u256(0)
        self.delivery_reserve_atto = u256(0)
        self.committed_delivery_reserve_atto = u256(0)
        self.reserved_player_payouts_atto = u256(0)
        self.fee_payout_nonce = u256(0)

    def _require_zero_value(self) -> None:
        if int(gl.message.value) != 0:
            _expected("VALUE_NOT_ACCEPTED", "This method does not accept native value")

    def _require_owner(self) -> None:
        if gl.message.sender_address != self.owner:
            _expected("ONLY_OWNER", "Only the arena owner can perform this action")

    def _require_new_risk_enabled(self) -> None:
        if not self.payouts_enabled:
            _expected(
                "PAYOUTS_INACTIVE",
                "New epochs and wagers remain disabled until the payout factory is verified",
            )
        if not self.new_risk_enabled:
            _expected(
                "NEW_RISK_PAUSED",
                "New epochs and wagers are paused until the owner explicitly resumes risk",
            )

    def _require_retry_operator(self, recipient: Address) -> None:
        sender = gl.message.sender_address
        if sender != self.owner and sender != self.keeper and sender != recipient:
            _expected(
                "PAYOUT_OPERATOR",
                "Only the recipient, owner, or keeper can retry this payout",
            )

    def _assert_factory_bound(self) -> None:
        chain_id = int(gl.message.chain_id)
        audited_factory = ""
        if chain_id == 4_221:
            audited_factory = AUDITED_PAYOUT_FACTORY_4221
        if (
            audited_factory == ""
            or audited_factory == ZERO_ADDRESS_TEXT
            or _address_text(self.payout_vault_factory) != audited_factory.lower()
        ):
            _expected(
                "PAYOUT_FACTORY_UNTRUSTED",
                "Payout factory is not the audited factory frozen for this chain",
            )
        arena = gl.message.contract_address
        if not _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_BOUND,
            (arena,),
            bool,
        ):
            _expected(
                "PAYOUT_FACTORY_UNBOUND",
                "Payout factory is not immutably bound to this arena",
            )
        protocol = _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_PROTOCOL_VERSION,
            (),
            str,
        )
        if protocol != PAYOUT_PROTOCOL_VERSION:
            _expected(
                "PAYOUT_FACTORY_PROTOCOL",
                "Payout factory protocol version does not match the arena",
            )

    def _payout_id(
        self,
        kind: str,
        recipient: Address,
        amount_atto: int,
        epoch_key: str,
        objective: str,
        nonce: int,
    ) -> str:
        return Keccak256(
            _canonical_json(
                {
                    "chain_id": int(gl.message.chain_id),
                    "contract": _address_text(gl.message.contract_address),
                    "factory": _address_text(self.payout_vault_factory),
                    "payout_protocol": PAYOUT_PROTOCOL_VERSION,
                    "kind": kind,
                    "recipient": _address_text(recipient),
                    "amount_atto": amount_atto,
                    "epoch_end_timestamp": int(epoch_key) if epoch_key != "" else 0,
                    "objective": objective,
                    "nonce": nonce,
                }
            ).encode("utf-8")
        ).hexdigest()

    def _get_payout_record(self, payout_id: str) -> dict:
        if self.payout_records.get(payout_id, "") == "":
            _expected("PAYOUT_UNKNOWN", "Payout record does not exist")
        return json.loads(self.payout_records[payout_id])

    def _save_payout_record(self, payout_id: str, record: dict) -> None:
        self.payout_records[payout_id] = _canonical_json(record)

    def _record_escrow_withdrawal(self, payout: dict) -> None:
        if bool(payout.get("escrow_withdrawn", False)):
            return
        amount = int(payout["amount_atto"])
        kind = str(payout["kind"])
        if kind == PAYOUT_KIND_PLAYER:
            wallet_key = str(payout["wallet_key"])
            if self.wallet_claimed.get(wallet_key, False):
                _expected("CLAIMED", "Position withdrawal was already recorded")
            objective_key = _objective_key(
                str(payout["epoch_end_timestamp"]),
                str(payout["objective"]),
            )
            paid = int(self.objective_paid_atto.get(objective_key, u256(0)))
            funded = int(self.objective_funded_atto.get(objective_key, u256(0)))
            if paid + amount > funded:
                _expected("PAYOUT_STATE", "Withdrawal exceeds funded escrow payouts")
            self.wallet_claimed[wallet_key] = True
            self.wallet_claimed_atto[wallet_key] = u256(amount)
            self.objective_paid_atto[objective_key] = u256(paid + amount)
        elif kind == PAYOUT_KIND_FEE:
            withdrawn = int(self.withdrawn_platform_fees_atto)
            funded_fees = int(self.funded_platform_fees_atto)
            if withdrawn + amount > funded_fees:
                _expected("FEE_FUNDED", "Withdrawal exceeds funded fee payouts")
            self.withdrawn_platform_fees_atto = u256(withdrawn + amount)
        else:
            _expected("PAYOUT_KIND", "Payout kind is unsupported")
        payout["escrow_withdrawn"] = True
        payout["withdrawn_at_timestamp"] = _now_epoch()
        payout["state"] = PAYOUT_EOA_WITHDRAWN

    def _unreserved_player_liability(self) -> int:
        liability = int(self.total_player_liability_atto)
        reserved = int(self.reserved_player_payouts_atto)
        if reserved > liability:
            _expected("LIABILITY_STATE", "Reserved player payouts exceed liability")
        return liability - reserved

    def _required_available_reserve(self, additional_player_atto: int = 0) -> int:
        unreserved_obligations = (
            self._unreserved_player_liability()
            + int(self.accrued_platform_fees_atto)
            + additional_player_atto
        )
        return unreserved_obligations * MAX_PAYOUT_ATTEMPTS

    def _assert_reserve_capacity(self, additional_player_atto: int = 0) -> None:
        required = self._required_available_reserve(additional_player_atto)
        if int(self.delivery_reserve_atto) < required:
            _expected(
                "PAYOUT_RESERVE_CAPACITY",
                "Available delivery reserve cannot cover the bounded attempt budget",
            )

    def _commit_attempt_budget(self, amount: int) -> int:
        budget = amount * MAX_PAYOUT_ATTEMPTS
        available = int(self.delivery_reserve_atto)
        if budget > available:
            _expected("PAYOUT_RESERVE", "Delivery reserve cannot cover this payout budget")
        self.delivery_reserve_atto = u256(available - budget)
        self.committed_delivery_reserve_atto = u256(
            int(self.committed_delivery_reserve_atto) + budget
        )
        return budget

    def _accounted_balance_atto(self) -> int:
        return (
            int(self.total_player_liability_atto)
            + int(self.accrued_platform_fees_atto)
            + int(self.reserved_platform_fees_atto)
            + int(self.delivery_reserve_atto)
            + int(self.committed_delivery_reserve_atto)
        )

    def _assert_accounting_solvent(self) -> None:
        if int(self.balance) < self._accounted_balance_atto():
            _expected("ACCOUNTING_INSOLVENT", "Contract balance is below accounted funds")

    def _require_epoch_creator(self) -> None:
        sender = gl.message.sender_address
        if sender != self.owner and sender != self.keeper:
            _expected(
                "EPOCH_CREATOR",
                "Only the arena owner or current keeper can create epochs",
            )

    def _require_fee_operator(self) -> None:
        sender = gl.message.sender_address
        if sender != self.owner and sender != self.treasury:
            _expected("FEE_OPERATOR", "Only the owner or treasury can withdraw accrued fees")

    def _require_epoch(self, epoch_end_timestamp: u256) -> tuple[str, dict]:
        epoch_end = int(epoch_end_timestamp)
        key = _epoch_key(epoch_end)
        if not self.epoch_exists.get(key, False):
            _expected("EPOCH_UNKNOWN", "Epoch does not exist")
        return key, json.loads(self.epoch_records[key])

    def _phase(self, record: dict) -> str:
        if record["status"] != STATUS_OPEN:
            return record["status"]
        now = _now_epoch()
        if now < int(record["wager_opens_timestamp"]):
            return "SCHEDULED"
        if now < int(record["wager_closes_timestamp"]):
            return "WAGER_OPEN"
        if now < int(record["epoch_end_timestamp"]):
            return "BATTLE"
        if now < int(record["resolution_available_timestamp"]):
            return "PUBLICATION_DELAY"
        if now < int(record["timeout_refund_available_timestamp"]):
            return "RESOLVABLE"
        return "TIMEOUT_AVAILABLE"

    def _objective_record(self, epoch_key: str, objective: str) -> dict:
        return json.loads(self.objective_records[_objective_key(epoch_key, objective)])

    @gl.public.write
    def set_keeper(self, keeper: Address) -> None:
        self._require_zero_value()
        self._require_owner()
        self.keeper = keeper

    @gl.public.write
    def activate_payouts(self) -> None:
        self._require_zero_value()
        self._require_owner()
        if int(gl.message.chain_id) not in SUPPORTED_ESCROW_CHAIN_IDS:
            _expected(
                "PAYOUT_NETWORK_UNSUPPORTED",
                "This chain is not allowlisted for the required EVM payout vault",
            )
        if self.payouts_enabled:
            _expected("PAYOUTS_ACTIVE", "Payouts are already activated")
        self._assert_factory_bound()
        self._assert_reserve_capacity()
        self._assert_accounting_solvent()
        self.payouts_enabled = True
        # Activating the payout rail must not implicitly open new wagering risk.
        # Risk is enabled only by the separate owner-only resume_new_risk gate
        # after an attended payout canary and explicit cutover decision.
        self.new_risk_enabled = False

    @gl.public.write
    def pause_new_risk(self) -> None:
        self._require_zero_value()
        sender = gl.message.sender_address
        if sender != self.owner and sender != self.keeper:
            _expected("PAUSE_OPERATOR", "Only the owner or keeper can pause new risk")
        self.new_risk_enabled = False

    @gl.public.write
    def resume_new_risk(self) -> None:
        self._require_zero_value()
        self._require_owner()
        if not self.payouts_enabled:
            _expected("PAYOUTS_INACTIVE", "Payouts must be activated before resuming risk")
        self._assert_factory_bound()
        self._assert_reserve_capacity()
        self._assert_accounting_solvent()
        self.new_risk_enabled = True

    @gl.public.write.payable
    def fund_delivery_reserve(self) -> None:
        amount = int(gl.message.value)
        if amount <= 0:
            _expected("RESERVE_AMOUNT", "Delivery reserve funding must be positive")
        self.delivery_reserve_atto = u256(int(self.delivery_reserve_atto) + amount)

    @gl.public.write
    def create_epoch(
        self,
        epoch_end_timestamp: u256,
    ) -> None:
        self._require_zero_value()
        self._require_new_risk_enabled()
        self._require_epoch_creator()
        epoch_end = int(epoch_end_timestamp)
        minimum_stake = int(self.epoch_min_stake_atto)
        maximum_wallet_stake = int(self.epoch_max_stake_per_wallet_atto)
        now = _now_epoch()
        if epoch_end <= 0 or epoch_end % HOUR_SECONDS != 0:
            _expected("EPOCH_HOURLY", "Epoch end must be an exact UTC hour")
        wager_opens = epoch_end - WAGER_OPEN_OFFSET_SECONDS
        wager_closes = epoch_end - BATTLE_OPEN_OFFSET_SECONDS
        creation_lead = epoch_end - now
        if creation_lead < MIN_EPOCH_CREATION_LEAD_SECONDS:
            _expected(
                "EPOCH_NOTICE",
                "Epoch must be created at least one hour before its end",
            )
        if gl.message.sender_address == self.keeper and creation_lead > KEEPER_MAX_SCHEDULE_AHEAD_SECONDS:
            _expected(
                "KEEPER_EPOCH_AHEAD",
                "Keeper cannot schedule an epoch more than 26 hours ahead",
            )
        if creation_lead > MAX_SCHEDULE_AHEAD_SECONDS:
            _expected("EPOCH_AHEAD", "Epoch cannot be scheduled more than 31 days ahead")
        key = _epoch_key(epoch_end)
        if self.epoch_exists.get(key, False):
            _expected("EPOCH_DUPLICATE", "Epoch already exists")

        fee_snapshot = int(self.platform_fee_bps)
        record = {
            "epoch_id": key,
            "epoch_end_timestamp": epoch_end,
            "wager_opens_timestamp": wager_opens,
            "wager_closes_timestamp": wager_closes,
            "battle_starts_timestamp": wager_closes,
            "resolution_available_timestamp": epoch_end
            + RESOLUTION_PUBLICATION_DELAY_SECONDS,
            "timeout_refund_available_timestamp": epoch_end
            + TIMEOUT_REFUND_DELAY_SECONDS,
            "created_at_timestamp": now,
            "creator": _address_text(gl.message.sender_address),
            "status": STATUS_OPEN,
            "result_status": RESULT_PENDING,
            "policy_version": POLICY_VERSION,
            "platform_fee_bps_snapshot": fee_snapshot,
            "min_stake_atto": minimum_stake,
            "max_stake_per_wallet_atto": maximum_wallet_stake,
            "qualified_venues": [],
            "venue_count": 0,
            "high_winner_asset_id": "",
            "high_winner_return_ppb": 0,
            "low_winner_asset_id": "",
            "low_winner_return_ppb": 0,
            "resolved_at_timestamp": 0,
            "resolution_digest": "",
            "platform_fee_accrued_atto": 0,
        }
        self.epoch_records[key] = _canonical_json(record)
        self.epoch_exists[key] = True
        for asset_id, label in APPROVED_ASSETS:
            self.epoch_asset_records[_asset_key(key, asset_id)] = _canonical_json(
                {
                    "asset_id": asset_id,
                    "label": label,
                    "return_ppb": 0,
                    "venue_returns_ppb": [],
                }
            )
            for objective in SUPPORTED_OBJECTIVES:
                self.asset_objective_stake_atto[
                    _objective_key(_asset_key(key, asset_id), objective)
                ] = u256(0)
        for objective in SUPPORTED_OBJECTIVES:
            objective_key = _objective_key(key, objective)
            self.objective_records[objective_key] = _canonical_json(
                {
                    "epoch_id": key,
                    "objective": objective,
                    "settlement_mode": SETTLEMENT_PENDING,
                    "winner_asset_id": "",
                    "winner_return_ppb": 0,
                    "payout_pool_atto": 0,
                    "winning_stake_atto": 0,
                    "losing_stake_atto": 0,
                    "platform_fee_atto": 0,
                }
            )
            self.objective_total_stake_atto[objective_key] = u256(0)
            self.objective_participant_count[objective_key] = u256(0)
            self.objective_allocated_atto[objective_key] = u256(0)
            self.objective_funded_atto[objective_key] = u256(0)
            self.objective_paid_atto[objective_key] = u256(0)
            self.objective_unclaimed_winning_stake_atto[objective_key] = u256(0)
        self.epoch_ids.append(key)

    @gl.public.write.payable
    def enter(
        self,
        epoch_end_timestamp: u256,
        objective: str,
        asset_id: str,
    ) -> None:
        self._require_new_risk_enabled()
        epoch_key, record = self._require_epoch(epoch_end_timestamp)
        if record["status"] != STATUS_OPEN:
            _expected("EPOCH_NOT_OPEN", "Epoch is not accepting wagers")
        now = _now_epoch()
        if now < int(record["wager_opens_timestamp"]):
            _expected("WAGER_NOT_STARTED", "Wager window has not opened")
        if now >= int(record["wager_closes_timestamp"]):
            _expected("WAGER_CLOSED", "Wager window has closed")
        normalized_objective = _clean_objective(objective)
        normalized_asset_id, _label = _asset_definition(asset_id)
        amount = int(gl.message.value)
        if amount <= 0:
            _expected("STAKE_POSITIVE", "Wager value must be positive")
        if amount < int(record["min_stake_atto"]):
            _expected("STAKE_MINIMUM", "Wager is below the epoch minimum")

        account = gl.message.sender_address
        wallet_key = _wallet_entry_key(epoch_key, normalized_objective, account)
        current = int(self.wallet_stake_atto.get(wallet_key, u256(0)))
        existing_choice = self.wallet_choice_asset.get(wallet_key, "")
        if existing_choice != "" and existing_choice != normalized_asset_id:
            _expected(
                "ONE_ASSET_PER_OBJECTIVE",
                "A wallet can wager on only one asset per objective in an epoch",
            )
        projected = current + amount
        if projected > int(record["max_stake_per_wallet_atto"]):
            _expected("WALLET_STAKE_CAP", "Wager would exceed the wallet cap")
        self._assert_reserve_capacity(amount)

        objective_key = _objective_key(epoch_key, normalized_objective)
        asset_stake_key = _objective_key(
            _asset_key(epoch_key, normalized_asset_id),
            normalized_objective,
        )
        self.wallet_choice_asset[wallet_key] = normalized_asset_id
        self.wallet_stake_atto[wallet_key] = u256(projected)
        self.objective_total_stake_atto[objective_key] = u256(
            int(self.objective_total_stake_atto.get(objective_key, u256(0)))
            + amount
        )
        self.asset_objective_stake_atto[asset_stake_key] = u256(
            int(self.asset_objective_stake_atto.get(asset_stake_key, u256(0)))
            + amount
        )
        self.total_player_liability_atto = u256(
            int(self.total_player_liability_atto) + amount
        )
        if not self.wallet_seen.get(wallet_key, False):
            self.wallet_seen[wallet_key] = True
            self.objective_participant_count[objective_key] = u256(
                int(self.objective_participant_count.get(objective_key, u256(0)))
                + 1
            )

    def _set_refund_objective(
        self,
        epoch_key: str,
        objective: str,
        mode: str,
        winner: str,
        winner_return: int,
    ) -> None:
        objective_key = _objective_key(epoch_key, objective)
        total_stake = int(
            self.objective_total_stake_atto.get(objective_key, u256(0))
        )
        record = self._objective_record(epoch_key, objective)
        record["settlement_mode"] = mode
        record["winner_asset_id"] = winner
        record["winner_return_ppb"] = winner_return
        record["payout_pool_atto"] = total_stake
        record["winning_stake_atto"] = 0
        record["losing_stake_atto"] = 0
        record["platform_fee_atto"] = 0
        self.objective_unclaimed_winning_stake_atto[objective_key] = u256(0)
        self.objective_records[objective_key] = _canonical_json(record)

    def _settle_objective(
        self,
        epoch_key: str,
        epoch_record: dict,
        objective: str,
        winner: str,
        winner_return: int,
    ) -> int:
        objective_key = _objective_key(epoch_key, objective)
        total_stake = int(
            self.objective_total_stake_atto.get(objective_key, u256(0))
        )
        if winner == WINNER_TIE:
            self._set_refund_objective(
                epoch_key,
                objective,
                SETTLEMENT_REFUND_TIE,
                winner,
                winner_return,
            )
            return 0
        winning_stake = int(
            self.asset_objective_stake_atto.get(
                _objective_key(_asset_key(epoch_key, winner), objective),
                u256(0),
            )
        )
        if winning_stake == 0:
            self._set_refund_objective(
                epoch_key,
                objective,
                SETTLEMENT_REFUND_UNBACKED_WINNER,
                winner,
                winner_return,
            )
            return 0
        losing_stake = total_stake - winning_stake
        if losing_stake == 0:
            self._set_refund_objective(
                epoch_key,
                objective,
                SETTLEMENT_REFUND_NO_LOSING_SIDE,
                winner,
                winner_return,
            )
            return 0

        fee_bps = int(epoch_record["platform_fee_bps_snapshot"])
        fee = (losing_stake * fee_bps) // BPS_DENOMINATOR
        payout_pool = total_stake - fee
        record = self._objective_record(epoch_key, objective)
        record["settlement_mode"] = SETTLEMENT_PARIMUTUEL
        record["winner_asset_id"] = winner
        record["winner_return_ppb"] = winner_return
        record["payout_pool_atto"] = payout_pool
        record["winning_stake_atto"] = winning_stake
        record["losing_stake_atto"] = losing_stake
        record["platform_fee_atto"] = fee
        self.objective_unclaimed_winning_stake_atto[objective_key] = u256(
            winning_stake
        )
        self.objective_records[objective_key] = _canonical_json(record)
        if fee > 0:
            liability = int(self.total_player_liability_atto)
            if fee > liability:
                _expected("LIABILITY_STATE", "Fee exceeds player liability")
            self.total_player_liability_atto = u256(liability - fee)
            self.accrued_platform_fees_atto = u256(
                int(self.accrued_platform_fees_atto) + fee
            )
        return fee

    @gl.public.write
    def resolve_epoch(self, epoch_end_timestamp: u256) -> None:
        self._require_zero_value()
        epoch_key, record = self._require_epoch(epoch_end_timestamp)
        if record["status"] != STATUS_OPEN:
            _expected("EPOCH_NOT_OPEN", "Epoch result or timeout is already final")
        epoch_end = int(record["epoch_end_timestamp"])
        now = _now_epoch()
        if now < int(record["resolution_available_timestamp"]):
            _expected("RESOLUTION_GATE", "Two-minute publication delay has not elapsed")
        if now >= int(record["timeout_refund_available_timestamp"]):
            _expected("RESOLUTION_TIMEOUT", "Epoch must use the 24-hour timeout refund")

        def leader_fn() -> list:
            return _resolve_market(epoch_end)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            try:
                leader_result = _validate_resolution_result(leaders_res.calldata)
                validator_result = _validate_resolution_result(leader_fn())
                return _results_equivalent(leader_result, validator_result)
            except Exception:
                return False

        result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        canonical = _validate_resolution_result(result)
        venues = canonical[0]
        assets = canonical[1]
        record["status"] = STATUS_RESOLVED
        record["result_status"] = RESULT_DETERMINED
        record["qualified_venues"] = venues
        record["venue_count"] = len(venues)
        record["resolved_at_timestamp"] = now
        public_assets = []
        for item in assets:
            public_item = {
                "asset_id": item[0],
                "return_ppb": item[1],
                "venue_returns_ppb": item[2],
            }
            public_assets.append(public_item)
            asset_record = json.loads(
                self.epoch_asset_records[_asset_key(epoch_key, item[0])]
            )
            asset_record["return_ppb"] = item[1]
            asset_record["venue_returns_ppb"] = item[2]
            self.epoch_asset_records[
                _asset_key(epoch_key, item[0])
            ] = _canonical_json(asset_record)
        high_winner, high_return = _winner_from_assets(assets, OBJECTIVE_HIGH)
        low_winner, low_return = _winner_from_assets(assets, OBJECTIVE_LOW)
        record["high_winner_asset_id"] = high_winner
        record["high_winner_return_ppb"] = high_return
        record["low_winner_asset_id"] = low_winner
        record["low_winner_return_ppb"] = low_return
        high_fee = self._settle_objective(
            epoch_key,
            record,
            OBJECTIVE_HIGH,
            high_winner,
            high_return,
        )
        low_fee = self._settle_objective(
            epoch_key,
            record,
            OBJECTIVE_LOW,
            low_winner,
            low_return,
        )
        record["platform_fee_accrued_atto"] = high_fee + low_fee
        canonical_result = {
            "policy_version": POLICY_VERSION,
            "status": RESULT_DETERMINED,
            "epoch_end_timestamp": epoch_end,
            "qualified_venues": venues,
            "venue_count": len(venues),
            "assets": public_assets,
            "high_winner_asset_id": high_winner,
            "high_winner_return_ppb": high_return,
            "low_winner_asset_id": low_winner,
            "low_winner_return_ppb": low_return,
        }
        record["resolution_digest"] = Keccak256(
            _canonical_json(canonical_result).encode("utf-8")
        ).hexdigest()
        self.epoch_records[epoch_key] = _canonical_json(record)

    @gl.public.write
    def activate_timeout_refund(self, epoch_end_timestamp: u256) -> None:
        self._require_zero_value()
        epoch_key, record = self._require_epoch(epoch_end_timestamp)
        if record["status"] != STATUS_OPEN:
            _expected("EPOCH_NOT_OPEN", "Epoch result or timeout is already final")
        if _now_epoch() < int(record["timeout_refund_available_timestamp"]):
            _expected("TIMEOUT_EARLY", "The 24-hour timeout has not elapsed")
        self._set_refund_objective(
            epoch_key,
            OBJECTIVE_HIGH,
            SETTLEMENT_REFUND_TIMEOUT,
            "",
            0,
        )
        self._set_refund_objective(
            epoch_key,
            OBJECTIVE_LOW,
            SETTLEMENT_REFUND_TIMEOUT,
            "",
            0,
        )
        record["status"] = STATUS_TIMED_OUT
        record["result_status"] = RESULT_TIMEOUT
        record["resolved_at_timestamp"] = _now_epoch()
        record["resolution_digest"] = Keccak256(
            _canonical_json(
                {
                    "epoch_end_timestamp": int(record["epoch_end_timestamp"]),
                    "policy_version": POLICY_VERSION,
                    "status": RESULT_TIMEOUT,
                }
            ).encode("utf-8")
        ).hexdigest()
        self.epoch_records[epoch_key] = _canonical_json(record)

    def _claim_quote(
        self,
        epoch_key: str,
        objective: str,
        account: Address,
    ) -> dict:
        objective_key = _objective_key(epoch_key, objective)
        objective_record = self._objective_record(epoch_key, objective)
        wallet_key = _wallet_entry_key(epoch_key, objective, account)
        stake = int(self.wallet_stake_atto.get(wallet_key, u256(0)))
        choice = self.wallet_choice_asset.get(wallet_key, "")
        claimed = self.wallet_claimed.get(wallet_key, False)
        claimed_atto = int(self.wallet_claimed_atto.get(wallet_key, u256(0)))
        escrow_funded_atto = int(
            self.wallet_escrow_funded_atto.get(wallet_key, u256(0))
        )
        payout_id = self.wallet_payout_id.get(wallet_key, "")
        payout_state = ""
        mode = str(objective_record["settlement_mode"])
        amount = 0
        includes_rounding_remainder = False
        if payout_id != "":
            payout = self._get_payout_record(payout_id)
            payout_state = str(payout["state"])
            amount = int(payout["amount_atto"])
            includes_rounding_remainder = bool(
                payout.get("includes_rounding_remainder", False)
            )
        elif not claimed and stake > 0:
            if mode in REFUND_SETTLEMENT_MODES:
                amount = stake
            elif (
                mode == SETTLEMENT_PARIMUTUEL
                and choice == objective_record["winner_asset_id"]
            ):
                winning_stake = int(objective_record["winning_stake_atto"])
                payout_pool = int(objective_record["payout_pool_atto"])
                allocated = int(
                    self.objective_allocated_atto.get(objective_key, u256(0))
                )
                remaining_winning_stake = int(
                    self.objective_unclaimed_winning_stake_atto.get(
                        objective_key,
                        u256(0),
                    )
                )
                if winning_stake <= 0 or stake > remaining_winning_stake:
                    _expected("PAYOUT_STATE", "Objective payout accounting is inconsistent")
                includes_rounding_remainder = stake == remaining_winning_stake
                amount = (
                    payout_pool - allocated
                    if includes_rounding_remainder
                    else (stake * payout_pool) // winning_stake
                )
        return {
            "epoch_end_timestamp": int(epoch_key),
            "objective": objective,
            "account": account,
            "choice_asset_id": choice,
            "stake_atto": stake,
            "settlement_mode": mode,
            "eligible": not claimed and payout_id == "" and amount > 0,
            "claimed": claimed,
            "claimed_atto": claimed_atto,
            "escrow_funded_atto": escrow_funded_atto,
            "amount_atto": amount,
            "includes_rounding_remainder": includes_rounding_remainder,
            "payout_id": payout_id,
            "payout_state": payout_state,
        }

    @gl.public.write
    def claim(self, epoch_end_timestamp: u256, objective: str) -> None:
        self._require_zero_value()
        if not self.payouts_enabled:
            _expected("PAYOUTS_INACTIVE", "Payout vault has not been activated")
        epoch_key, _epoch_record = self._require_epoch(epoch_end_timestamp)
        normalized_objective = _clean_objective(objective)
        objective_key = _objective_key(epoch_key, normalized_objective)
        objective_record = self._objective_record(epoch_key, normalized_objective)
        if objective_record["settlement_mode"] == SETTLEMENT_PENDING:
            _expected("NOT_SETTLED", "Objective is not settled")

        sender = gl.message.sender_address
        wallet_key = _wallet_entry_key(epoch_key, normalized_objective, sender)
        if self.wallet_claimed.get(wallet_key, False):
            _expected("CLAIMED", "Position proceeds were already claimed")
        if self.wallet_payout_id.get(wallet_key, "") != "":
            _expected("PAYOUT_EXISTS", "Position already has an immutable payout record")
        quote = self._claim_quote(epoch_key, normalized_objective, sender)
        if int(quote["stake_atto"]) <= 0:
            _expected("NO_STAKE", "Wallet has no stake for this objective")
        if int(quote["amount_atto"]) <= 0:
            _expected("NOT_ELIGIBLE", "Wallet is not eligible for proceeds")

        amount = int(quote["amount_atto"])
        allocated = int(
            self.objective_allocated_atto.get(objective_key, u256(0))
        )
        payout_pool = int(objective_record["payout_pool_atto"])
        if allocated + amount > payout_pool:
            _expected("PAYOUT_STATE", "Claim would exceed the objective payout pool")
        liability = int(self.total_player_liability_atto)
        if amount > liability:
            _expected("LIABILITY_STATE", "Claim would exceed player liability")
        payout_id = self._payout_id(
            PAYOUT_KIND_PLAYER,
            sender,
            amount,
            epoch_key,
            normalized_objective,
            0,
        )
        if self.payout_records.get(payout_id, "") != "":
            _expected("PAYOUT_DUPLICATE", "Deterministic payout ID already exists")
        now = _now_epoch()
        attempt_budget = self._commit_attempt_budget(amount)
        payout = {
            "payout_id": payout_id,
            "kind": PAYOUT_KIND_PLAYER,
            "recipient": _address_text(sender),
            "amount_atto": amount,
            "epoch_end_timestamp": int(epoch_key),
            "objective": normalized_objective,
            "wallet_key": wallet_key,
            "stake_atto": int(quote["stake_atto"]),
            "settlement_mode": str(quote["settlement_mode"]),
            "includes_rounding_remainder": bool(
                quote["includes_rounding_remainder"]
            ),
            "state": PAYOUT_PREPARING,
            "prepare_attempt_count": 1,
            "attempt_count": 0,
            "reserve_remaining_atto": attempt_budget,
            "vault": ZERO_ADDRESS_TEXT,
            "created_at_timestamp": now,
            "last_prepare_timestamp": now,
            "last_dispatch_timestamp": 0,
            "funded_at_timestamp": 0,
            "withdrawn_at_timestamp": 0,
            "escrow_withdrawn": False,
        }
        self.wallet_payout_id[wallet_key] = payout_id
        self.reserved_player_payouts_atto = u256(
            int(self.reserved_player_payouts_atto) + amount
        )
        self.objective_allocated_atto[objective_key] = u256(allocated + amount)
        if objective_record["settlement_mode"] == SETTLEMENT_PARIMUTUEL:
            remaining = int(
                self.objective_unclaimed_winning_stake_atto.get(
                    objective_key,
                    u256(0),
                )
            )
            stake = int(quote["stake_atto"])
            self.objective_unclaimed_winning_stake_atto[objective_key] = u256(
                remaining - stake
            )
        self.payout_records[payout_id] = _canonical_json(payout)
        self.payout_ids.append(payout_id)
        _evm_factory_prepare(self.payout_vault_factory, payout_id, sender, amount)

    @gl.public.write
    def request_fee_payout(self, amount_atto: u256) -> None:
        self._require_zero_value()
        if not self.payouts_enabled:
            _expected("PAYOUTS_INACTIVE", "Payout vault has not been activated")
        self._require_fee_operator()
        amount = int(amount_atto)
        if amount <= 0:
            _expected("FEE_AMOUNT", "Fee withdrawal must be positive")
        accrued = int(self.accrued_platform_fees_atto)
        if amount > accrued:
            _expected("FEE_ACCRUED", "Withdrawal exceeds accrued platform fees")
        nonce = int(self.fee_payout_nonce)
        payout_id = self._payout_id(
            PAYOUT_KIND_FEE,
            self.treasury,
            amount,
            "",
            "",
            nonce,
        )
        if self.payout_records.get(payout_id, "") != "":
            _expected("PAYOUT_DUPLICATE", "Deterministic fee payout already exists")
        attempt_budget = self._commit_attempt_budget(amount)
        self.accrued_platform_fees_atto = u256(accrued - amount)
        self.reserved_platform_fees_atto = u256(
            int(self.reserved_platform_fees_atto) + amount
        )
        self.fee_payout_nonce = u256(nonce + 1)
        payout = {
            "payout_id": payout_id,
            "kind": PAYOUT_KIND_FEE,
            "recipient": _address_text(self.treasury),
            "amount_atto": amount,
            "epoch_end_timestamp": 0,
            "objective": "",
            "wallet_key": "",
            "stake_atto": 0,
            "settlement_mode": "FEE_WITHDRAWAL",
            "includes_rounding_remainder": False,
            "state": PAYOUT_PREPARING,
            "prepare_attempt_count": 1,
            "attempt_count": 0,
            "reserve_remaining_atto": attempt_budget,
            "vault": ZERO_ADDRESS_TEXT,
            "created_at_timestamp": _now_epoch(),
            "last_prepare_timestamp": _now_epoch(),
            "last_dispatch_timestamp": 0,
            "funded_at_timestamp": 0,
            "withdrawn_at_timestamp": 0,
            "escrow_withdrawn": False,
        }
        self.payout_records[payout_id] = _canonical_json(payout)
        self.payout_ids.append(payout_id)
        _evm_factory_prepare(
            self.payout_vault_factory,
            payout_id,
            self.treasury,
            amount,
        )

    @gl.public.write
    def retry_prepare_payout(self, payout_id: str) -> None:
        self._require_zero_value()
        payout = self._get_payout_record(payout_id)
        recipient = Address(str(payout["recipient"]))
        if str(payout["state"]) != PAYOUT_PREPARING:
            _expected("PAYOUT_NOT_PREPARING", "Only a preparing payout can be prepared again")
        prepare_attempts = int(payout["prepare_attempt_count"])
        now = _now_epoch()
        if now < int(payout["last_prepare_timestamp"]) + PAYOUT_RETRY_DELAY_SECONDS:
            _expected("PAYOUT_PREPARE_EARLY", "Payout preparation retry cooldown has not elapsed")
        amount = int(payout["amount_atto"])
        if _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_PREPARED,
            (payout_id, recipient, u256(amount)),
            bool,
        ):
            _expected("PAYOUT_ALREADY_PREPARED", "Prepared payout is ready for dispatch")
        payout["prepare_attempt_count"] = prepare_attempts + 1
        payout["last_prepare_timestamp"] = now
        self._save_payout_record(payout_id, payout)
        _evm_factory_prepare(
            self.payout_vault_factory,
            payout_id,
            recipient,
            amount,
        )

    def _dispatch_payout(self, payout_id: str, retry: bool) -> None:
        payout = self._get_payout_record(payout_id)
        state = str(payout["state"])
        if retry:
            if state != PAYOUT_DISPATCHED:
                _expected("PAYOUT_NOT_DISPATCHED", "Only a dispatched payout can be retried")
            attempt_count = int(payout["attempt_count"])
            if attempt_count >= MAX_PAYOUT_ATTEMPTS:
                _expected("PAYOUT_ATTEMPT_CAP", "Payout retry cap was reached")
            if _now_epoch() < int(payout["last_dispatch_timestamp"]) + PAYOUT_RETRY_DELAY_SECONDS:
                _expected("PAYOUT_RETRY_EARLY", "Payout retry cooldown has not elapsed")
        elif state != PAYOUT_PREPARING:
            _expected("PAYOUT_NOT_PREPARING", "Payout is not waiting for vault preparation")

        recipient = Address(str(payout["recipient"]))
        amount = int(payout["amount_atto"])
        if not _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_PREPARED,
            (payout_id, recipient, u256(amount)),
            bool,
        ):
            _expected("PAYOUT_VAULT_UNPREPARED", "Exact payout vault is not prepared")
        vault = _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_VAULT_OF,
            (payout_id,),
            Address,
        )
        if _address_text(vault) == ZERO_ADDRESS_TEXT:
            _expected("PAYOUT_VAULT_ZERO", "Prepared payout vault cannot be zero")
        recorded_vault = str(payout["vault"])
        if recorded_vault != ZERO_ADDRESS_TEXT and recorded_vault != _address_text(vault):
            _expected("PAYOUT_VAULT_CHANGED", "Payout vault address changed")
        if retry and _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_CREDITED,
            (payout_id, recipient, u256(amount)),
            bool,
        ):
            _expected("PAYOUT_ALREADY_CREDITED", "Confirm the credited payout instead of retrying")

        reserve_remaining = int(payout["reserve_remaining_atto"])
        committed = int(self.committed_delivery_reserve_atto)
        if amount > reserve_remaining or amount > committed:
            _expected("PAYOUT_RESERVE", "Committed payout budget cannot cover this attempt")
        self._assert_accounting_solvent()

        self.committed_delivery_reserve_atto = u256(committed - amount)
        payout["state"] = PAYOUT_DISPATCHED
        payout["attempt_count"] = int(payout["attempt_count"]) + 1
        payout["reserve_remaining_atto"] = reserve_remaining - amount
        payout["vault"] = _address_text(vault)
        payout["last_dispatch_timestamp"] = _now_epoch()
        self._save_payout_record(payout_id, payout)
        _EOARecipient(vault).emit_transfer(value=u256(amount))

    @gl.public.write
    def dispatch_payout(self, payout_id: str) -> None:
        self._require_zero_value()
        self._dispatch_payout(payout_id, False)

    @gl.public.write
    def retry_payout(self, payout_id: str) -> None:
        self._require_zero_value()
        payout = self._get_payout_record(payout_id)
        self._require_retry_operator(Address(str(payout["recipient"])))
        self._dispatch_payout(payout_id, True)

    @gl.public.write
    def confirm_payout(self, payout_id: str) -> None:
        self._require_zero_value()
        payout = self._get_payout_record(payout_id)
        if str(payout["state"]) != PAYOUT_DISPATCHED:
            _expected("PAYOUT_NOT_DISPATCHED", "Only a dispatched payout can be confirmed")
        recipient = Address(str(payout["recipient"]))
        amount = int(payout["amount_atto"])
        if not _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_CREDITED,
            (payout_id, recipient, u256(amount)),
            bool,
        ):
            _expected("PAYOUT_NOT_CREDITED", "Escrow has not credited the exact payout")

        kind = str(payout["kind"])
        reserve_remaining = int(payout["reserve_remaining_atto"])
        committed = int(self.committed_delivery_reserve_atto)
        if reserve_remaining > committed:
            _expected("PAYOUT_RESERVE", "Payout reserve exceeds committed reserve")
        if kind == PAYOUT_KIND_PLAYER:
            liability = int(self.total_player_liability_atto)
            if amount > liability:
                _expected("LIABILITY_STATE", "Payout exceeds player liability")
            objective_key = _objective_key(
                str(payout["epoch_end_timestamp"]),
                str(payout["objective"]),
            )
            funded = int(
                self.objective_funded_atto.get(objective_key, u256(0))
            )
            allocated = int(
                self.objective_allocated_atto.get(objective_key, u256(0))
            )
            if funded + amount > allocated:
                _expected("PAYOUT_STATE", "Funded payout exceeds allocated payout")
            wallet_key = str(payout["wallet_key"])
            if int(self.wallet_escrow_funded_atto.get(wallet_key, u256(0))) > 0:
                _expected("PAYOUT_FUNDED", "Position was already funded in escrow")
            self.wallet_escrow_funded_atto[wallet_key] = u256(amount)
            self.objective_funded_atto[objective_key] = u256(funded + amount)
            self.total_player_liability_atto = u256(liability - amount)
            reserved_player = int(self.reserved_player_payouts_atto)
            if amount > reserved_player:
                _expected("LIABILITY_STATE", "Payout exceeds reserved player payouts")
            self.reserved_player_payouts_atto = u256(reserved_player - amount)
        elif kind == PAYOUT_KIND_FEE:
            reserved_fees = int(self.reserved_platform_fees_atto)
            if amount > reserved_fees:
                _expected("FEE_RESERVED", "Payout exceeds reserved platform fees")
            self.reserved_platform_fees_atto = u256(reserved_fees - amount)
            self.funded_platform_fees_atto = u256(
                int(self.funded_platform_fees_atto) + amount
            )
        else:
            _expected("PAYOUT_KIND", "Payout kind is unsupported")

        self.committed_delivery_reserve_atto = u256(committed - reserve_remaining)
        self.delivery_reserve_atto = u256(
            int(self.delivery_reserve_atto) + reserve_remaining + amount
        )
        payout["reserve_remaining_atto"] = 0
        payout["state"] = PAYOUT_FUNDED_IN_ESCROW
        payout["funded_at_timestamp"] = _now_epoch()
        escrow_withdrawn = _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_WITHDRAWN,
            (payout_id, recipient, u256(amount)),
            bool,
        )
        if escrow_withdrawn:
            self._record_escrow_withdrawal(payout)
        self._save_payout_record(payout_id, payout)
        self._assert_reserve_capacity()
        self._assert_accounting_solvent()

    @gl.public.write
    def refresh_payout_withdrawal(self, payout_id: str) -> None:
        self._require_zero_value()
        payout = self._get_payout_record(payout_id)
        state = str(payout["state"])
        if state == PAYOUT_EOA_WITHDRAWN and bool(
            payout.get("escrow_withdrawn", False)
        ):
            return
        if state != PAYOUT_FUNDED_IN_ESCROW:
            _expected("PAYOUT_NOT_FUNDED", "Only a funded escrow payout can be refreshed")
        recipient = Address(str(payout["recipient"]))
        amount = int(payout["amount_atto"])
        withdrawn = _evm_factory_view(
            self.payout_vault_factory,
            _FACTORY_IS_WITHDRAWN,
            (payout_id, recipient, u256(amount)),
            bool,
        )
        if not withdrawn:
            _expected("PAYOUT_NOT_WITHDRAWN", "Escrow withdrawal is not yet proven")
        self._record_escrow_withdrawal(payout)
        self._save_payout_record(payout_id, payout)

    @gl.public.view
    def get_config(self) -> dict:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "policy_version": POLICY_VERSION,
            "owner": self.owner,
            "keeper": self.keeper,
            "treasury": self.treasury,
            "payout_vault_factory": self.payout_vault_factory,
            "payout_protocol_version": PAYOUT_PROTOCOL_VERSION,
            "payouts_enabled": self.payouts_enabled,
            "new_risk_enabled": self.new_risk_enabled,
            "max_payout_attempts": MAX_PAYOUT_ATTEMPTS,
            "prepare_retries_capped": False,
            "payout_retry_delay_seconds": PAYOUT_RETRY_DELAY_SECONDS,
            "current_platform_fee_bps": int(self.platform_fee_bps),
            "epoch_min_stake_atto": int(self.epoch_min_stake_atto),
            "epoch_max_stake_per_wallet_atto": int(
                self.epoch_max_stake_per_wallet_atto
            ),
            "minimum_epoch_creation_lead_seconds": MIN_EPOCH_CREATION_LEAD_SECONDS,
            "keeper_max_schedule_ahead_seconds": KEEPER_MAX_SCHEDULE_AHEAD_SECONDS,
            "wager_open_offset_seconds": WAGER_OPEN_OFFSET_SECONDS,
            "battle_open_offset_seconds": BATTLE_OPEN_OFFSET_SECONDS,
            "resolution_publication_delay_seconds": RESOLUTION_PUBLICATION_DELAY_SECONDS,
            "timeout_refund_delay_seconds": TIMEOUT_REFUND_DELAY_SECONDS,
            "minimum_qualified_venues": MIN_QUALIFIED_VENUES,
            "asset_ids": [item[0] for item in APPROVED_ASSETS],
            "venues": list(APPROVED_VENUES),
            "validator_return_tolerance_ppb": VALIDATOR_RETURN_TOLERANCE_PPB,
            "supported_objectives": list(SUPPORTED_OBJECTIVES),
            "payout_finality": PAYOUT_FUNDED_IN_ESCROW,
            "claimed_semantics": PAYOUT_EOA_WITHDRAWN,
        }

    @gl.public.view
    def get_epoch_page(self, offset: u256, limit: u256) -> dict:
        count = len(self.epoch_ids)
        start, end = _page_bounds(offset, limit, count)
        ids = []
        for index in range(start, end):
            ids.append(self.epoch_ids[index])
        return {"offset": start, "next_offset": end, "total": count, "epoch_ids": ids}

    @gl.public.view
    def get_epoch(self, epoch_end_timestamp: u256) -> dict:
        key, record = self._require_epoch(epoch_end_timestamp)
        record["phase"] = self._phase(record)
        record["high"] = self.get_objective(epoch_end_timestamp, OBJECTIVE_HIGH)
        record["low"] = self.get_objective(epoch_end_timestamp, OBJECTIVE_LOW)
        record["epoch_id"] = key
        return record

    @gl.public.view
    def get_epoch_asset(self, epoch_end_timestamp: u256, asset_id: str) -> dict:
        key, _record = self._require_epoch(epoch_end_timestamp)
        normalized_asset_id, _label = _asset_definition(asset_id)
        result = json.loads(
            self.epoch_asset_records[_asset_key(key, normalized_asset_id)]
        )
        result["high_stake_atto"] = int(
            self.asset_objective_stake_atto.get(
                _objective_key(
                    _asset_key(key, normalized_asset_id),
                    OBJECTIVE_HIGH,
                ),
                u256(0),
            )
        )
        result["low_stake_atto"] = int(
            self.asset_objective_stake_atto.get(
                _objective_key(
                    _asset_key(key, normalized_asset_id),
                    OBJECTIVE_LOW,
                ),
                u256(0),
            )
        )
        return result

    @gl.public.view
    def get_objective(self, epoch_end_timestamp: u256, objective: str) -> dict:
        key, _record = self._require_epoch(epoch_end_timestamp)
        normalized_objective = _clean_objective(objective)
        objective_key = _objective_key(key, normalized_objective)
        record = self._objective_record(key, normalized_objective)
        total_stake = int(
            self.objective_total_stake_atto.get(objective_key, u256(0))
        )
        paid = int(self.objective_paid_atto.get(objective_key, u256(0)))
        funded = int(self.objective_funded_atto.get(objective_key, u256(0)))
        allocated = int(
            self.objective_allocated_atto.get(objective_key, u256(0))
        )
        record["total_stake_atto"] = total_stake
        record["participant_count"] = int(
            self.objective_participant_count.get(objective_key, u256(0))
        )
        record["paid_atto"] = paid
        record["funded_in_escrow_atto"] = funded
        record["allocated_atto"] = allocated
        record["remaining_payout_atto"] = int(record["payout_pool_atto"]) - funded
        record["unallocated_payout_atto"] = (
            int(record["payout_pool_atto"]) - allocated
        )
        record["allocated_not_funded_atto"] = allocated - funded
        record["funded_not_withdrawn_atto"] = funded - paid
        record["unclaimed_winning_stake_atto"] = int(
            self.objective_unclaimed_winning_stake_atto.get(
                objective_key,
                u256(0),
            )
        )
        return record

    @gl.public.view
    def get_claim_quote(
        self,
        epoch_end_timestamp: u256,
        objective: str,
        account: Address,
    ) -> dict:
        key, _record = self._require_epoch(epoch_end_timestamp)
        normalized_objective = _clean_objective(objective)
        return self._claim_quote(key, normalized_objective, account)

    @gl.public.view
    def get_delivery_reserve_state(self) -> dict:
        return {
            "treasury": self.treasury,
            "current_platform_fee_bps": int(self.platform_fee_bps),
            "payout_protocol_version": PAYOUT_PROTOCOL_VERSION,
            "payouts_enabled": self.payouts_enabled,
            "new_risk_enabled": self.new_risk_enabled,
            "player_liability_atto": int(self.total_player_liability_atto),
            "accrued_platform_fees_atto": int(self.accrued_platform_fees_atto),
            "reserved_platform_fees_atto": int(self.reserved_platform_fees_atto),
            "funded_platform_fees_atto": int(self.funded_platform_fees_atto),
            "withdrawn_platform_fees_atto": int(
                self.withdrawn_platform_fees_atto
            ),
            "available_reserve_atto": int(self.delivery_reserve_atto),
            "committed_reserve_atto": int(self.committed_delivery_reserve_atto),
            "required_available_reserve_atto": self._required_available_reserve(),
            "reserved_player_payouts_atto": int(
                self.reserved_player_payouts_atto
            ),
            "max_payout_attempts": MAX_PAYOUT_ATTEMPTS,
            "prepare_retries_capped": False,
            "retry_delay_seconds": PAYOUT_RETRY_DELAY_SECONDS,
        }

    @gl.public.view
    def get_payout(self, payout_id: str) -> dict:
        return self._get_payout_record(payout_id)

    @gl.public.view
    def get_payout_page(self, offset: u256, limit: u256) -> dict:
        count = len(self.payout_ids)
        start, end = _page_bounds(offset, limit, count)
        payouts = []
        for index in range(start, end):
            payout_id = self.payout_ids[index]
            payouts.append(self._get_payout_record(payout_id))
        return {
            "offset": start,
            "next_offset": end,
            "total": count,
            "payouts": payouts,
        }
