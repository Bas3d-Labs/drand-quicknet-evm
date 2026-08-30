// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    ITestDrandOracleQuicknet
} from "../interfaces/ITestDrandOracleQuicknet.sol";

contract MockDrandOracleQuicknet is ITestDrandOracleQuicknet {
    function verifyNormalized(
        uint64,
        bytes calldata
    )
        external
        pure
        returns (
            bool verified,
            bytes32 normalizedRoundHash,
            bytes32 chainScopedHash
        )
    {
        return (false, bytes32(0), bytes32(0));
    }
}