// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IDrandQuicknetBeaconRegistry
} from "../interfaces/IDrandQuicknetBeaconRegistry.sol";

import {
    IDrandQuicknetRandomnessConsumer
} from "../interfaces/IDrandQuicknetRandomnessConsumer.sol";

/// @title DrandQuicknetRandomnessConsumer
/// @notice Reusable base contract for consumers of a drand Quicknet
///         beacon registry.
///
/// @dev Consumer integration requirements:
///
///      1. SAFE LEAD MARGIN
///         The constructor authenticates the configured registry before
///         reading its immutable `minimumLeadRounds`.
///
///         The consumer supplies a local minimum acceptable lead as a
///         deployment-time safety floor. Construction reverts if the
///         authenticated registry's configured minimum is below that
///         floor.
///
///         `quicknetLeadRounds` is set to the authenticated registry value
///         and is used for all subsequent round commitments.
///
///         The base contract cannot determine the correct safety floor for
///         an arbitrary target chain or application. Integrators MUST
///         choose a local floor that covers the relevant timestamp slack,
///         inclusion latency, reorg/finality margin, and safety buffer.
///
///      2. EXACT-ROUND PERSISTENCE
///         The exact round returned by `_requestQuicknetRandomness()` MUST
///         be persisted with the application request. Settlement MUST use
///         only that stored round.
///
///         Any application identifier used to persist the committed round
///         MUST NOT be reused. Applications must reject attempts to
///         overwrite the round associated with an existing request.
///
///         Registry availability must never influence round selection.
///         A missing round is a liveness condition and MUST NOT cause
///         substitution with another round.
///
///      3. UNIQUE REQUEST IDENTIFIERS
///         `uniqueRequestId` passed to `_deriveQuicknetSeed()` MUST be
///         unique for every randomness-consuming request within an
///         application domain.
///
///         Use an incrementing request/opening/draw identifier. Do not use
///         the Quicknet round, a constant, or the caller address as the
///         unique identifier.
///
///      4. REGISTRY ATTESTATION
///         Construction verifies that the configured registry has the
///         expected runtime bytecode hash before reading any registry
///         metadata.
///
///         Only after successful authentication does the constructor trust
///         the registry's immutable `minimumLeadRounds`.
///
///         The security value of this check depends on
///         `expectedRegistryCodehash_` coming from an independently trusted
///         deployment manifest or equivalent source.
///
///         The authenticated registry bytecode also commits to the verifier
///         configuration and Quicknet schedule encoded by that deployment.
///
///      This contract performs no drand signature verification itself.
///      Verification is delegated entirely to the configured registry.
abstract contract DrandQuicknetRandomnessConsumer is
    IDrandQuicknetRandomnessConsumer
{
    error InvalidQuicknetBeaconRegistry();
    error InvalidQuicknetBeaconRegistryCodehash();
    error InvalidQuicknetLeadRounds();
    error QuicknetLeadBelowRegistryMinimum(
        uint64 leadRounds,
        uint64 minimumLeadrounds
    );
    error QuicknetRoundOverflow();

    bytes32 internal constant QUICKNET_SEED_DOMAIN =
        keccak256(
            "based-labs.drand-quicknet.consumer.seed.v1"
        );

    /// @inheritdoc IDrandQuicknetRandomnessConsumer
    address public immutable override quicknetBeaconRegistry;

    /// @notice Runtime bytecode hash attested for `quicknetBeaconRegistry`.
    bytes32 public immutable quicknetBeaconRegistryCodehash;

    /// @notice Authenticated registry lead used when committing Quicknet rounds.
    uint64 public immutable quicknetLeadRounds;

    constructor(
        address quicknetBeaconRegistry_,
        bytes32 expectedRegistryCodehash_,
        uint64 leadRounds_
    ) {
        if (leadRounds_ == 0) {
            revert InvalidQuicknetLeadRounds();
        }

        if (quicknetBeaconRegistry_.code.length == 0) {
            revert InvalidQuicknetBeaconRegistry();
        }

        if (
            expectedRegistryCodehash_ == bytes32(0) ||
            quicknetBeaconRegistry_.codehash != expectedRegistryCodehash_
        ) {
            revert InvalidQuicknetBeaconRegistryCodehash();
        }

        IDrandQuicknetBeaconRegistry registry =
            IDrandQuicknetBeaconRegistry(quicknetBeaconRegistry_);

        uint64 registryMinimum = registry.minimumLeadRounds();
        if (leadRounds_ < registryMinimum) {
            revert QuicknetLeadBelowRegistryMinimum(
                leadRounds_,
                registryMinimum
            );
        }

        quicknetBeaconRegistry = quicknetBeaconRegistry_;
        quicknetBeaconRegistryCodehash = expectedRegistryCodehash_;
        quicknetLeadRounds = leadRounds_;
    }

    /// @notice Commits to an exact future Quicknet round.
    ///
    /// @return round Exact Quicknet round committed by the consumer.
    ///
    /// @dev Uses the authenticated registry lead fixed during construction.
    ///      Registry availability does not influence round selection.
    function _requestQuicknetRandomness()
        internal
        returns (uint64 round)
    {
        uint64 latest = _quicknetRegistry().latestScheduledRound();
        if (latest > type(uint64).max - quicknetLeadRounds) {
            revert QuicknetRoundOverflow();
        }

        round = latest + quicknetLeadRounds;

        emit QuicknetRandomnessRequested(round);
    }

    /// @notice Returns the stored randomness for an exact Quicknet round.
    /// @dev Reverts through the registry if the round has not been stored.
    function _getQuicknetBeacon(
        uint64 round
    )
        internal
        view
        returns (bytes32 randomness)
    {
        return _quicknetRegistry().getBeacon(round);
    }

    /// @notice Permissionlessly supplies the beacon for an exact committed
    ///         Quicknet round.
    ///
    /// @dev The current registry's `submitBeacon` operation is idempotent:
    ///      if `round` is already stored, the existing randomness is
    ///      returned without examining `signature`.
    ///
    ///      This provides a liveness recovery path when the normal relayer
    ///      has not imported the committed round. It MUST NOT be used to
    ///      submit or select a replacement round.
    function _submitQuicknetBeacon(
        uint64 round,
        bytes calldata signature
    )
        internal
        returns (bytes32 randomness)
    {
        return _quicknetRegistry().submitBeacon(round, signature);
    }

    /// @notice Derives application-scoped randomness from a verified
    ///         Quicknet beacon.
    ///
    /// @param applicationDomain Domain identifying the randomness-consuming
    ///        feature. Prefer a fixed value such as
    ///        `keccak256("GACHA_PACK_OPENING_V1")`.
    /// @param uniqueRequestId Identifier unique to this request within
    ///        `applicationDomain`.
    /// @param round Exact persisted Quicknet round committed for the request.
    /// @param randomness Verified randomness obtained from that exact round.
    ///
    /// @dev `uniqueRequestId` is load-bearing when multiple requests share
    ///      the same Quicknet round. Reusing the same identifier within the
    ///      same application domain and round will derive the same seed.
    function _deriveQuicknetSeed(
        bytes32 applicationDomain,
        bytes32 uniqueRequestId,
        uint64 round,
        bytes32 randomness
    )
        internal
        view
        returns (bytes32 seed)
    {
        return keccak256(
            abi.encode(
                QUICKNET_SEED_DOMAIN,
                applicationDomain,
                block.chainid,
                address(this),
                uniqueRequestId,
                round,
                randomness
            )
        );
    }

    /// @notice Returns whether the exact Quicknet round has been stored.
    function _isQuicknetBeaconStored(
        uint64 round
    )
        internal
        view
        returns (bool)
    {
        return _quicknetRegistry().isStored(round);
    }

    /// @dev Returns the configured registry as its typed interface.
    function _quicknetRegistry()
        internal
        view
        returns (IDrandQuicknetBeaconRegistry)
    {
        return IDrandQuicknetBeaconRegistry(quicknetBeaconRegistry);
    }
}