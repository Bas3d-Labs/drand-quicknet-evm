// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IQuicknetBeaconVerifier
} from "../../src/interfaces/IQuicknetBeaconVerifier.sol";

contract MockQuicknetBeaconVerifier is
    IQuicknetBeaconVerifier
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