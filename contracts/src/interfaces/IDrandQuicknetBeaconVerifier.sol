// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IDrandQuicknetBeaconVerifier
/// @notice Verifies canonical drand Quicknet beacon signatures.
interface IDrandQuicknetBeaconVerifier {
    /// @notice Verifies a canonical compressed Quicknet beacon signature.
    /// @dev Reconstructs the signature point on-chain from the compressed
    ///      encoding. A false result means this verification attempt did
    ///      not succeed; it is not a permanent verdict that the round has
    ///      no valid beacon. Calls may revert on insufficient gas or
    ///      execution errors.
    /// @param round Nonzero Quicknet round.
    /// @param signature Canonical 48-byte compressed G1 signature.
    /// @return verified Whether the signature verifies for the round.
    /// @return randomness SHA-256 of signature on success, otherwise zero.
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

    /// @notice Verifies a Quicknet beacon using an untrusted y coordinate.
    /// @dev Signature must retain its canonical 48-byte compressed form.
    ///      The witness avoids on-chain signature decompression.
    ///      Hash-to-field still uses two ModExp calls in the current
    ///      BLS2 implementation; this path is not ModExp-free.
    ///
    ///      A false result means this verification attempt did not
    ///      succeed; it is not a permanent verdict that the round has
    ///      no valid beacon. Calls may revert on insufficient gas or
    ///      execution errors.
    /// @param round Nonzero Quicknet round.
    /// @param signature Canonical 48-byte compressed G1 signature.
    /// @param yHi Most significant 128 bits of the supplied y coordinate.
    /// @param yLo Least significant 256 bits of the supplied y coordinate.
    /// @return verified Whether the signature and supplied witness
    ///         successfully verify for the round.
    /// @return randomness SHA-256 of signature on success, otherwise zero.
    function verifyBeaconWithWitness(
        uint64 round,
        bytes calldata signature,
        uint128 yHi,
        uint256 yLo
    )
        external
        view
        returns (
            bool verified,
            bytes32 randomness
        );
}