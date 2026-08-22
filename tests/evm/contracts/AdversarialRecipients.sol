// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPayoutVault {
    function withdraw() external;
}

contract ToggleRevertingRecipient {
    bool public rejectNative = true;
    uint256 public received;

    function setRejectNative(bool reject) external {
        rejectNative = reject;
    }

    function pull(address vault) external {
        IPayoutVault(vault).withdraw();
    }

    receive() external payable {
        if (rejectNative) revert("RECIPIENT_REJECTED");
        received += msg.value;
    }
}

contract ReentrantRecipient {
    address public target;
    uint256 public received;
    uint256 public receiveCount;
    bool public reentrySucceeded;

    function pull(address vault) external {
        target = vault;
        IPayoutVault(vault).withdraw();
    }

    receive() external payable {
        received += msg.value;
        receiveCount += 1;
        (reentrySucceeded,) = target.call(
            abi.encodeWithSelector(IPayoutVault.withdraw.selector)
        );
    }
}
