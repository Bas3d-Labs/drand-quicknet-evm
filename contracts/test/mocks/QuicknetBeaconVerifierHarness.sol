// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    BLS2
} from "bls-solidity/libraries/BLS2.sol";

import {
    QuicknetBeaconVerifier
} from "../../src/verifiers/QuicknetBeaconVerifier.sol";

contract QuicknetBeaconVerifierHarness
    is QuicknetBeaconVerifier
{
    function isCanonical(
        bytes memory signature
    )
        external
        pure
        returns (bool)
    {
        return _isCanonicalG1Compressed(signature);
    }

    function decompressG1(
        bytes memory signature
    )
        external
        view
        returns (
            uint128 xHi,
            uint256 xLo,
            uint128 yHi,
            uint256 yLo
        )
    {
        BLS2.PointG1 memory point =
            BLS2.g1UnmarshalCompressed(signature);

        return (
            point.x_hi,
            point.x_lo,
            point.y_hi,
            point.y_lo
        );
    }
}