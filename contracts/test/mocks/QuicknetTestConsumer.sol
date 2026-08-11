// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Test-only Quicknet consumer used to exercise the reference
///         relayer end-to-end. Not intended for production use.
contract QuicknetTestConsumer {
    address public immutable quicknetBeaconRegistry;

    event QuicknetRandomnessRequested(
        uint64 indexed round
    );

    constructor(address registry) {
        quicknetBeaconRegistry = registry;
    }

    function request(uint64 round)
        external
    {
        emit QuicknetRandomnessRequested(round);
    }
}