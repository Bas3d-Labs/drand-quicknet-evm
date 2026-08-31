// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IDrandQuicknetBeaconVerifier
/// @notice Verifies canonical drand Quicknet beacon signatures.
interface IDrandQuicknetBeaconVerifier {
    function verifyBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        view
        returns (
            bool verified,
            bytes32 randomness
        );
}