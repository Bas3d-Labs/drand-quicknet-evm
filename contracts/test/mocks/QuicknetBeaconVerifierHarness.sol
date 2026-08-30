// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

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
}