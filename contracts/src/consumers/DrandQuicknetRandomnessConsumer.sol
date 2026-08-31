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
///         `quicknetLeadRounds` is fixed at deployment and MUST be sized
///         for the target chain and application. It must cover relevant
///         timestamp slack, inclusion latency, reorg/finality margin, and
///         an additional safety buffer, measured in Quicknet's 3-second
///         rounds.
///
///         The base contract can enforce that the configured lead is
///         nonzero, but it cannot determine the correct security margin
///         for an arbitrary target chain. Integrators should use the
///         recommended lead published with the registry deployment
///         metadata or a larger value.
///
///      2. EXACT-ROUND PERSISTENCE
///         The exact round returned by `_requestQuicknetRandomness()` MUST
///         be persisted with the application request. Settlement MUST use
///         only that stored round.
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
///         expected runtime bytecode hash. This attests that the configured
///         address contains the bytecode expected by the deployment.
///
///         The security value of this check depends on
///         `expectedRegistryCodehash_` coming from an independently trusted
///         deployment manifest or equivalent source.
///
///         Consumers SHOULD authenticate the registry deployment against
///         an expected runtime codehash before trusting deployment metadata
///         such as `minimumLeadRounds`, `verifier()`, or
///         `verifierCodehash()`.
///
///      This contract performs no drand signature verification itself.
///      Verification is delegated entirely to the configured registry.
abstract contract DrandQuicknetRandomnessConsumer is 
    IDrandQuicknetRandomnessConsumer
{
    error InvalidQuicknetBeaconRegistry();
    error InvalidQuicknetBeaconRegistryCodehash();
    error InvalidQuicknetLeadRounds();
    error QuicknetRoundOverflow();

    bytes32 internal constant QUICKNET_SEED_DOMAIN =
        keccak256(
            "based-labs.drand-quicknet.consumer.seed.v1"
        );

    /// @inheritdoc IDrandQuicknetRandomnessConsumer
    address public immutable override quicknetBeaconRegistry;

    /// @notice Runtime bytecode hash attested for `quicknetBeaconRegistry`.
    bytes32 public immutable quicknetBeaconRegistryCodehash;

    /// @notice Fixed number of Quicknet rounds between request-time
    ///         schedule position and the committed target round.
    uint64 public immutable quicknetLeadRounds;

    constructor(
        address quicknetBeaconRegistry_,
        bytes32 expectedRegistryCodehash_,
        uint64 leadRounds_
    ) {
        if (quicknetBeaconRegistry_.code.length == 0) {
            revert InvalidQuicknetBeaconRegistry();
        }

        if (expectedRegistryCodehash_ == bytes32(0) ||
            quicknetBeaconRegistry_.codehash != expectedRegistryCodehash_
        ) {
            revert InvalidQuicknetBeaconRegistryCodehash();
        }

        if (leadRounds_ == 0) {
            revert InvalidQuicknetLeadRounds();
        }

        quicknetBeaconRegistry = quicknetBeaconRegistry_;
        quicknetBeaconRegistryCodehash = expectedRegistryCodehash_;
        quicknetLeadRounds = leadRounds_;
    }

    /// @notice Commits to an exact future Quicknet round.
    ///
    /// @return round Exact Quicknet round committed by the consumer.
    ///
    /// @dev The application chooses its own lead policy. The base
    /// contract only requires the committed round to be strictly in
    /// the future.
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
    
    // @notice Returns whether the exact Quicknet round has been stored.
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
        return IDrandQuicknetBeaconRegistry(
            quicknetBeaconRegistry
        );
    }
}