// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IDrandOracleQuicknet {
    function verifyNormalized(
        uint64 round,
        bytes calldata signature
    )
        external
        view
        returns (
            bool verified,
            bytes32 normalizedRoundHash,
            bytes32 chainScopedHash
        );
}
