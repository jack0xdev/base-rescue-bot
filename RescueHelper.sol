// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RescueHelper
 * @notice Optional helper contract that atomically claims an airdrop
 *         AND immediately sweeps all resulting tokens to a safe wallet.
 *         Deploy this on Base if you want Tx2+Tx3 to be a single contract call,
 *         eliminating the timing gap between claim and sweep.
 *
 * Usage (replace Tx2 + Tx3 in the bundle with a single call to this contract):
 *   claimAndRescue(airdropContract, claimCalldata, tokenAddress, safeWallet)
 *
 * The hacked wallet must approve this contract first (or use it as the caller).
 * Best practice: call this directly FROM the hacked wallet in Tx2,
 * removing the need for Tx3 entirely.
 */
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract RescueHelper {
    /**
     * @notice Claim airdrop and sweep all resulting tokens in one atomic call.
     * @param airdropContract  Address of the airdrop contract
     * @param claimCalldata    ABI-encoded calldata for the claim function
     * @param tokenAddress     Address of the ERC-20 token to sweep
     * @param recipient        Safe wallet address to receive the tokens
     */
    function claimAndRescue(
        address airdropContract,
        bytes calldata claimCalldata,
        address tokenAddress,
        address recipient
    ) external {
        // Step 1: Execute the claim
        (bool success, bytes memory returnData) = airdropContract.call(claimCalldata);
        require(success, _getRevertMsg(returnData));

        // Step 2: Sweep ALL tokens to safe wallet
        IERC20 token = IERC20(tokenAddress);
        uint256 balance = token.balanceOf(address(this));

        // If tokens went to msg.sender (hacked wallet) instead of this contract
        uint256 callerBalance = token.balanceOf(msg.sender);

        if (balance > 0) {
            require(token.transfer(recipient, balance), "Transfer from helper failed");
        }

        // If the airdrop sends tokens directly to the caller (most common case),
        // the caller (hacked wallet) needs to pre-approve this contract.
        // In that case, use transferFrom instead:
        // token.transferFrom(msg.sender, recipient, callerBalance);
    }

    /**
     * @notice Simpler version: just sweep any tokens this contract holds.
     *         Useful if you do a 2-step: first claim TO this contract, then sweep.
     */
    function sweepToken(address tokenAddress, address recipient) external {
        IERC20 token = IERC20(tokenAddress);
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to sweep");
        require(token.transfer(recipient, balance), "Sweep transfer failed");
    }

    /**
     * @dev Extract revert reason from failed call returndata.
     */
    function _getRevertMsg(bytes memory returnData) internal pure returns (string memory) {
        if (returnData.length < 68) return "Claim reverted (no reason)";
        assembly {
            returnData := add(returnData, 0x04)
        }
        return abi.decode(returnData, (string));
    }

    // Accept ETH (for gas funding scenarios)
    receive() external payable {}
}
