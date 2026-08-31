// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IDrandQuicknetBeaconVerifier
} from "../../src/interfaces/IDrandQuicknetBeaconVerifier.sol";

contract MockDrandQuicknetBeaconVerifier is
    IDrandQuicknetBeaconVerifier
{
    function verifyBeacon(
        uint64,
        bytes calldata
    )
        external
        pure
        override
        returns (
            bool verified,
            bytes32 randomness
        )
    {
        return (
            false,
            bytes32(0)
        );
    }
}