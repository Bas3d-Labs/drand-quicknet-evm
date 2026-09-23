// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IDrandQuicknetBeaconRegistry {
    /// @notice Emitted the first time a round is stored.
    /// @dev Not emitted for an idempotent submission of an already
    ///      stored round.
    event BeaconStored(
        uint64 indexed round,
        bytes32 randomness,
        address indexed submitter
    );

    /// @notice Returns the configured Quicknet verifier address.
    function verifier()
        external
        view
        returns (address);

    /// @notice Returns the expected runtime bytecode hash of `verifier`.
    function verifierCodehash()
        external
        view
        returns (bytes32);

    /// @notice Returns the minimum supported consumer lead for this
    ///         registry deployment.
    function minimumLeadRounds()
        external
        view
        returns (uint64);

    /// @notice Verifies and caches a Quicknet beacon.
    /// @dev Idempotent. If `round` has already been stored, returns the
    ///      cached randomness without examining `signature` or invoking the
    ///      verifier.
    ///
    ///      For an unstored round, reverts from the configured verifier are
    ///      propagated unchanged.
    function submitBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        returns (bytes32 randomness);

    /// @notice Verifies and caches a Quicknet beacon using a supplied
    ///         signature y-coordinate.
    /// @dev Idempotent across both submission methods. If `round` has
    ///      already been stored, returns the cached randomness without
    ///      examining the signature or witness, or invoking the verifier.
    ///
    ///      For an unstored round, the verifier checks the witness against
    ///      the canonical compressed signature. A rejected submission stores
    ///      nothing and does not prevent a later corrected submission.
    ///
    ///      Reverts from the configured verifier are propagated unchanged.
    /// @param round Quicknet round to verify and cache.
    /// @param signature Canonical 48-byte compressed Quicknet signature.
    /// @param yHi Most significant 128 bits of the signature y-coordinate.
    /// @param yLo Least significant 256 bits of the signature y-coordinate.
    /// @return randomness Verified randomness derived from the signature.
    function submitBeaconWithWitness(
        uint64 round,
        bytes calldata signature,
        uint128 yHi,
        uint256 yLo
    )
        external
        returns (bytes32 randomness);

    /// @notice Returns the verified randomness for `round`.
    /// @dev Reverts if `round` is zero or has not been stored.
    function getBeacon(
        uint64 round
    )
        external
        view
        returns (bytes32 randomness);

    /// @notice Returns true if `round` has already been verified and stored.
    /// @dev Returns false for round zero.
    function isStored(
        uint64 round
    )
        external
        view
        returns (bool);

    /// @notice Returns the scheduled Unix timestamp for `round`.
    /// @dev Reverts for round zero.
    function roundScheduledTime(
        uint64 round
    )
        external
        pure
        returns (uint256);

    /// @notice Returns the latest Quicknet round scheduled at or before
    ///         `timestamp`.
    /// @dev Returns zero for timestamps before Quicknet genesis.
    function roundAt(
        uint256 timestamp
    )
        external
        pure
        returns (uint64);

    /// @notice Returns the latest Quicknet round whose scheduled time has
    ///         passed according to the current chain's `block.timestamp`.
    /// @dev This is a schedule helper, not a proof of beacon availability
    ///      or first knowability.
    function latestScheduledRound()
        external
        view
        returns (uint64);
}