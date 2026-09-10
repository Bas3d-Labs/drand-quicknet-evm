// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    BLS2
} from "bls-solidity/libraries/BLS2.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../../src/verifiers/DrandQuicknetBeaconVerifier.sol";

/// @notice Exposes canonicality and BLS2 decompression for verifier tests.
/// @dev Inherits verifyBeacon and DST without overrides. Deployment executes
///      the verifier constructor's two-sided self-test before each test setup
///      completes. The wrappers add no cryptographic validation logic.
contract DrandQuicknetBeaconVerifierHarness is 
    DrandQuicknetBeaconVerifier
{
    function selfTestVector()
        external
        pure
        returns (
            uint64 round,
            bytes memory signature,
            bytes32 randomness
        )
    {
        return (
            SELF_TEST_ROUND,
            SELF_TEST_SIGNATURE,
            SELF_TEST_RANDOMNESS
        );
    }

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
        BLS2.PointG1 memory point = BLS2.g1UnmarshalCompressed(signature);

        return (
            point.x_hi,
            point.x_lo,
            point.y_hi,
            point.y_lo
        );
    }
}