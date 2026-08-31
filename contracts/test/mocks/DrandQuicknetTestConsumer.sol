// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IDrandQuicknetRandomnessConsumer
} from "../../src/interfaces/IDrandQuicknetRandomnessConsumer.sol";

/// @notice Test-only Quicknet consumer used to exercise the reference
///         relayer end-to-end. Not intended for production use.
contract DrandQuicknetTestConsumer is 
    IDrandQuicknetRandomnessConsumer
{
    address public immutable quicknetBeaconRegistry;

    constructor(address registry) {
        quicknetBeaconRegistry = registry;
    }

    function request(uint64 round)
        external
    {
        emit QuicknetRandomnessRequested(round);
    }
}