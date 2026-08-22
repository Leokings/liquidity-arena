// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LiquidityArenaPayoutVault} from "./LiquidityArenaPayoutVault.sol";

/// @title LiquidityArenaPayoutFactory
/// @notice One-time-bound CREATE2 registry for immutable Liquidity Arena payouts.
/// @dev The binder loses all effective authority after binding. Neither the binder
///      nor any other principal has an upgrade, drain, or vault mutation path.
contract LiquidityArenaPayoutFactory {
    error OnlyBinder();
    error AlreadyBound();
    error ArenaNotBound();
    error OnlyArena();
    error ZeroAddress();
    error EmptyPayoutId();
    error PayoutIdTooLong();
    error ZeroAmount();
    error PayoutDefinitionMismatch();
    error VaultAddressMismatch();

    event ArenaBound(address indexed arena);
    event PayoutPrepared(
        bytes32 indexed payoutIdHash,
        string payoutId,
        address indexed vault,
        address indexed recipient,
        uint256 amount
    );

    string private constant _PROTOCOL_VERSION = "IDEMPOTENT_EVM_VAULT_V1";
    bytes32 private constant _CREATE2_DOMAIN =
        keccak256("LIQUIDITY_ARENA_PAYOUT_VAULT_CREATE2_V1");
    uint256 private constant _MAX_PAYOUT_ID_BYTES = 256;

    struct PreparedPayout {
        address vault;
        address recipient;
        uint256 amount;
    }

    address public immutable binder;
    address public immutable reserveSink;
    address public arena;

    mapping(bytes32 payoutIdHash => PreparedPayout payout) private _payouts;

    constructor(address binder_, address reserveSink_) {
        if (binder_ == address(0) || reserveSink_ == address(0)) {
            revert ZeroAddress();
        }
        binder = binder_;
        reserveSink = reserveSink_;
    }

    /// @notice Permanently binds the single arena ghost allowed to prepare/fund.
    function bind_arena(address arenaGhost) external {
        if (msg.sender != binder) revert OnlyBinder();
        if (arena != address(0)) revert AlreadyBound();
        if (arenaGhost == address(0)) revert ZeroAddress();

        arena = arenaGhost;
        emit ArenaBound(arenaGhost);
    }

    function protocol_version() external pure returns (string memory) {
        return _PROTOCOL_VERSION;
    }

    function is_bound(address arenaGhost) external view returns (bool) {
        return arena != address(0) && arenaGhost == arena;
    }

    /// @notice Idempotently deploys the exact payout vault requested by the arena.
    /// @dev Repeating the identical tuple succeeds without creating a second vault;
    ///      reusing an ID with a different recipient or amount always reverts.
    function prepare(
        string calldata payoutId,
        address recipient,
        uint256 amount
    ) external {
        address boundArena = arena;
        if (boundArena == address(0)) revert ArenaNotBound();
        if (msg.sender != boundArena) revert OnlyArena();
        _validateDefinition(payoutId, recipient, amount);

        bytes32 idHash = keccak256(bytes(payoutId));
        PreparedPayout storage existing = _payouts[idHash];
        if (existing.vault != address(0)) {
            if (existing.recipient != recipient || existing.amount != amount) {
                revert PayoutDefinitionMismatch();
            }
            return;
        }

        bytes32 salt = _salt(idHash);
        address expected = _predict(salt, boundArena, recipient, amount, idHash);
        LiquidityArenaPayoutVault created = new LiquidityArenaPayoutVault{salt: salt}(
            boundArena,
            reserveSink,
            recipient,
            amount,
            idHash
        );
        address vault = address(created);
        if (vault != expected) revert VaultAddressMismatch();

        _payouts[idHash] = PreparedPayout({
            vault: vault,
            recipient: recipient,
            amount: amount
        });
        emit PayoutPrepared(idHash, payoutId, vault, recipient, amount);
    }

    function predict_vault(
        string calldata payoutId,
        address recipient,
        uint256 amount
    ) external view returns (address) {
        address boundArena = arena;
        if (boundArena == address(0)) revert ArenaNotBound();
        _validateDefinition(payoutId, recipient, amount);
        bytes32 idHash = keccak256(bytes(payoutId));
        return _predict(_salt(idHash), boundArena, recipient, amount, idHash);
    }

    function vault_of(string calldata payoutId) external view returns (address) {
        return _payouts[keccak256(bytes(payoutId))].vault;
    }

    function is_prepared(
        string calldata payoutId,
        address recipient,
        uint256 amount
    ) public view returns (bool) {
        PreparedPayout storage payout = _payouts[keccak256(bytes(payoutId))];
        return
            payout.vault != address(0) &&
            payout.recipient == recipient &&
            payout.amount == amount;
    }

    function is_credited(
        string calldata payoutId,
        address recipient,
        uint256 amount
    ) external view returns (bool) {
        PreparedPayout storage payout = _payouts[keccak256(bytes(payoutId))];
        if (
            payout.vault == address(0) ||
            payout.recipient != recipient ||
            payout.amount != amount
        ) return false;
        return LiquidityArenaPayoutVault(payable(payout.vault)).credited();
    }

    function is_withdrawn(
        string calldata payoutId,
        address recipient,
        uint256 amount
    ) external view returns (bool) {
        PreparedPayout storage payout = _payouts[keccak256(bytes(payoutId))];
        if (
            payout.vault == address(0) ||
            payout.recipient != recipient ||
            payout.amount != amount
        ) return false;
        return LiquidityArenaPayoutVault(payable(payout.vault)).withdrawn();
    }

    function get_record(string calldata payoutId)
        external
        view
        returns (address vault, address recipient, uint256 amount)
    {
        PreparedPayout storage payout = _payouts[keccak256(bytes(payoutId))];
        return (payout.vault, payout.recipient, payout.amount);
    }

    function _validateDefinition(
        string calldata payoutId,
        address recipient,
        uint256 amount
    ) private pure {
        uint256 idLength = bytes(payoutId).length;
        if (idLength == 0) revert EmptyPayoutId();
        if (idLength > _MAX_PAYOUT_ID_BYTES) revert PayoutIdTooLong();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
    }

    function _salt(bytes32 idHash) private pure returns (bytes32) {
        return keccak256(abi.encode(_CREATE2_DOMAIN, idHash));
    }

    function _predict(
        bytes32 salt,
        address boundArena,
        address recipient,
        uint256 amount,
        bytes32 idHash
    ) private view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(LiquidityArenaPayoutVault).creationCode,
                abi.encode(boundArena, reserveSink, recipient, amount, idHash)
            )
        );
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
                        )
                    )
                )
            );
    }
}
