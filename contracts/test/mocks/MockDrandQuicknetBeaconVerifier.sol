// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IDrandQuicknetBeaconVerifier
} from "../../src/interfaces/IDrandQuicknetBeaconVerifier.sol";

contract MockDrandQuicknetBeaconVerifier is
    IDrandQuicknetBeaconVerifier
{
    error UnmockedVerifierCall(uint64 round);

    function verifyBeacon(
        uint64 round,
        bytes calldata
    )
        external
        pure
        override
        returns (
            bool,
            bytes32
        )
    {
        revert UnmockedVerifierCall(round);
    }
}