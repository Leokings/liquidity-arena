// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LiquidityArenaPayoutVault
/// @notice Immutable, single-payout escrow created by LiquidityArenaPayoutFactory.
/// @dev There is deliberately no owner, proxy hook, arbitrary call, or principal
///      recovery path. Only the recorded recipient can pull the exact principal.
contract LiquidityArenaPayoutVault {
    error OnlyArena();
    error OnlyRecipient();
    error NotCredited();
    error AlreadyWithdrawn();
    error NoExcess();
    error NativeTransferFailed();
    error ReentrantCall();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidPayoutIdHash();

    event PayoutCredited(bytes32 indexed payoutIdHash, uint256 amount);
    event ExcessReceived(
        bytes32 indexed payoutIdHash,
        address indexed sender,
        uint256 amount,
        bool duplicate
    );
    event PayoutWithdrawn(
        bytes32 indexed payoutIdHash,
        address indexed recipient,
        uint256 amount
    );
    event ExcessRecovered(
        bytes32 indexed payoutIdHash,
        address indexed reserveSink,
        uint256 amount
    );

    address public immutable factory;
    address public immutable arena;
    address public immutable reserveSink;
    address public immutable recipient;
    uint256 public immutable amount;
    bytes32 public immutable payoutIdHash;

    bool public credited;
    bool public withdrawn;
    uint256 public creditedAtBlock;
    uint256 public withdrawnAtBlock;
    uint256 public totalArenaReceived;
    uint256 public totalExcessRecovered;

    uint256 private _reentrancyState = 1;

    constructor(
        address arena_,
        address reserveSink_,
        address recipient_,
        uint256 amount_,
        bytes32 payoutIdHash_
    ) {
        if (
            arena_ == address(0) ||
            reserveSink_ == address(0) ||
            recipient_ == address(0)
        ) revert ZeroAddress();
        if (amount_ == 0) revert ZeroAmount();
        if (payoutIdHash_ == bytes32(0)) revert InvalidPayoutIdHash();

        factory = msg.sender;
        arena = arena_;
        reserveSink = reserveSink_;
        recipient = recipient_;
        amount = amount_;
        payoutIdHash = payoutIdHash_;
    }

    modifier nonReentrant() {
        if (_reentrancyState != 1) revert ReentrantCall();
        _reentrancyState = 2;
        _;
        _reentrancyState = 1;
    }

    /// @notice Receives native-token dispatches from the one bound arena.
    /// @dev Only the first exact dispatch creates the immutable credit. Wrong or
    ///      later values remain recoverable excess and can never change the credit.
    receive() external payable {
        if (msg.sender != arena) revert OnlyArena();

        totalArenaReceived += msg.value;
        if (!credited && msg.value == amount) {
            credited = true;
            creditedAtBlock = block.number;
            emit PayoutCredited(payoutIdHash, msg.value);
            return;
        }

        emit ExcessReceived(payoutIdHash, msg.sender, msg.value, credited);
    }

    /// @notice Pulls the exact credited principal to its immutable recipient.
    /// @dev State is committed before interaction and rolls back if the recipient
    ///      rejects the transfer. A callback cannot perform a second withdrawal.
    function withdraw() external nonReentrant {
        if (msg.sender != recipient) revert OnlyRecipient();
        if (!credited) revert NotCredited();
        if (withdrawn) revert AlreadyWithdrawn();

        withdrawn = true;
        withdrawnAtBlock = block.number;

        (bool sent,) = payable(recipient).call{value: amount}("");
        if (!sent) revert NativeTransferFailed();

        emit PayoutWithdrawn(payoutIdHash, recipient, amount);
    }

    /// @notice Sends every unlocked native token to the immutable reserve sink.
    /// @dev Anyone may trigger recovery, but nobody can redirect it. Credited and
    ///      unwithdrawn principal is always excluded.
    function recover_excess() external nonReentrant {
        uint256 recoverable = excess_available();
        if (recoverable == 0) revert NoExcess();

        totalExcessRecovered += recoverable;
        (bool sent,) = payable(reserveSink).call{value: recoverable}("");
        if (!sent) revert NativeTransferFailed();

        emit ExcessRecovered(payoutIdHash, reserveSink, recoverable);
    }

    function locked_principal() public view returns (uint256) {
        return credited && !withdrawn ? amount : 0;
    }

    function excess_available() public view returns (uint256) {
        return address(this).balance - locked_principal();
    }

    /// @notice A durable view of the immutable identity and delivery state.
    function record()
        external
        view
        returns (
            bytes32 idHash,
            address boundArena,
            address payoutRecipient,
            address excessReserveSink,
            uint256 payoutAmount,
            bool isCredited,
            bool isWithdrawn,
            uint256 creditBlock,
            uint256 withdrawalBlock,
            uint256 balance,
            uint256 locked,
            uint256 excess
        )
    {
        return (
            payoutIdHash,
            arena,
            recipient,
            reserveSink,
            amount,
            credited,
            withdrawn,
            creditedAtBlock,
            withdrawnAtBlock,
            address(this).balance,
            locked_principal(),
            excess_available()
        );
    }
}
