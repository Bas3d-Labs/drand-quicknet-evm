// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    DrandQuicknetRandomnessConsumer
} from "../../src/consumers/DrandQuicknetRandomnessConsumer.sol";

/// @notice Testnet measurement consumer, not an application settlement contract.
/// @dev Selects the round at inclusion through the production consumer helper.
contract QuicknetLeadThreeMeasurementConsumer is
    DrandQuicknetRandomnessConsumer
{
    error InvalidRequester();
    error UnauthorizedRequester();
    error RequestAlreadyExists(uint256 requestId);

    address public immutable requester;

    mapping(uint256 requestId => uint64 round) public requestRounds;

    constructor(
        address registry_,
        bytes32 expectedRegistryCodehash_,
        address requester_
    ) DrandQuicknetRandomnessConsumer(
        registry_,
        expectedRegistryCodehash_,
        3
    ) {
        if (requester_ == address(0)) {
            revert InvalidRequester();
        }

        requester = requester_;
    }

    /// @notice Commits an unused experiment ID to an inclusion-time round.
    /// @dev The inherited event supplies the round to the observer. Requests
    ///      cannot be overwritten, and callers cannot select their round.
    function request(
        uint256 requestId
    )
        external
        returns (uint64 round)
    {
        if (msg.sender != requester) {
            revert UnauthorizedRequester();
        }

        if (requestRounds[requestId] != 0) {
            revert RequestAlreadyExists(requestId);
        }

        round = _requestQuicknetRandomness();
        requestRounds[requestId] = round;
    }
}
