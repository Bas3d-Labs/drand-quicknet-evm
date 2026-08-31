// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    DrandQuicknetRandomnessConsumer
} from "../../src/consumers/DrandQuicknetRandomnessConsumer.sol";

/// @title MockDrandQuicknetRandomnessConsumer
/// @notice Test-only consumer exposing DrandQuicknetRandomnessConsumer internals.
contract MockDrandQuicknetRandomnessConsumer is
    DrandQuicknetRandomnessConsumer
{
    error RequestAlreadyExists(uint256 requestId);
    error RequestNotFound(uint256 requestId);

    mapping(uint256 requestId => uint64 round) public requestRounds;
        
    constructor(
        address registry_,
        bytes32 expectedRegistryCodehash_,
        uint64 leadRounds_
    ) DrandQuicknetRandomnessConsumer(
        registry_, 
        expectedRegistryCodehash_, 
        leadRounds_
    ) { }

    /// @notice Requests randomness and persists the exact committed round.
    function request(
        uint256 requestId
    )
        external
        returns (uint64 round)
    {
        if (requestRounds[requestId] != 0) {
            revert RequestAlreadyExists(requestId);
        }

        round = _requestQuicknetRandomness();
        requestRounds[requestId] = round;
    }

    /// @notice Returns whether an exact round is stored.
    function isStored(
        uint64 round
    )
        external
        view
        returns (bool)
    {
        return _isQuicknetBeaconStored(round);
    }

    /// @notice Reads the beacon for an exact round.
    function getBeacon(
        uint64 round
    )
        external
        view
        returns (bytes32 randomness)
    {
        return _getQuicknetBeacon(round);
    }

    /// @notice Exposes the permissionless submission/recovery helper.
    function submitBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        returns (bytes32 randomness)
    {
        return _submitQuicknetBeacon(round, signature);
    }

    /// @notice Exposes seed derivation for domain-separation tests.
    function deriveSeed(
        bytes32 applicationDomain,
        bytes32 uniqueRequestId,
        uint64 round,
        bytes32 randomness
    )
        external
        view
        returns (bytes32 seed)
    {
        return _deriveQuicknetSeed(
            applicationDomain,
            uniqueRequestId,
            round,
            randomness
        );
    }

    /// @notice Reads randomness using the exact round persisted when the
    ///         request was created.
    ///
    /// @dev Useful for proving that changes to latestScheduledRound()
    ///      cannot alter which round resolves an existing request.
    function getRequestedBeacon(
        uint256 requestId
    )
        external
        view
        returns (
            uint64 round,
            bytes32 randomness
        )
    {
        round = requestRounds[requestId];
        if (round == 0) {
            revert RequestNotFound(requestId);
        }

        randomness = _getQuicknetBeacon(round);
    }

    /// @notice Derives a seed from the exact persisted request round.
    ///
    /// @dev This gives tests a minimal request -> persist -> settle-style
    ///      flow without introducing application-specific state.
    function deriveRequestedSeed(
        uint256 requestId,
        bytes32 applicationDomain,
        bytes32 uniqueRequestId
    )
        external
        view
        returns (
            uint64 round,
            bytes32 randomness,
            bytes32 seed
        )
    {
        round = requestRounds[requestId];
        if (round == 0) {
            revert RequestNotFound(requestId);
        }

        randomness = _getQuicknetBeacon(round);

        seed = _deriveQuicknetSeed(
            applicationDomain,
            uniqueRequestId,
            round,
            randomness
        );
    }
}