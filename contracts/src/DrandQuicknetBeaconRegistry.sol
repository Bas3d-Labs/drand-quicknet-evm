// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IDrandQuicknetBeaconRegistry
} from "./interfaces/IDrandQuicknetBeaconRegistry.sol";

import {
    IQuicknetBeaconVerifier
} from "./interfaces/IQuicknetBeaconVerifier.sol";

/// @title DrandQuicknetBeaconRegistry
/// @notice Permissionless cache of cryptographically verified drand
///         Quicknet beacons.
/// @dev This contract authenticates and caches beacon values only.
///
///      Security requirements for consumers:
///
///      1. FUTURE-ROUND COMMITMENT
///         Bind every randomness-consuming action to one specific future
///         round sufficiently before that round's scheduled time, under
///         the normal drand threshold-honesty assumption.
///
///         `minimumLeadRounds` declares the minimum future-round lead
///         expected by this registry deployment. Consumers with their own
///         security floor must first authenticate the registry deployment
///         and require `minimumLeadRounds` to meet that floor.
///
///         After authenticating the registry deployment, consumers should
///         require `minimumLeadRounds` to meet or exceed their immutable
///         local security floor. A new commitment must then target a round
///         at least `minimumLeadRounds` ahead of the authenticated
///         `latestScheduledRound()`.
///
///         Size the required lead according to the consumer's chain and
///         threat model, including relevant timestamp uncertainty and
///         desired finality/reorg margin. If the target round is selected
///         off-chain before transaction submission, transaction inclusion
///         latency must also be accounted for.
///
///         `minimumLeadRounds` is not enforced by `submitBeacon`. Valid past,
///         current, and future rounds may all be cached permissionlessly.
///
///      2. ROUND SELECTION MUST NOT DEPEND ON REGISTRY AVAILABILITY
///         Consumers must never select a randomness round based on which
///         beacons are already stored in this registry. In particular,
///         do not use the latest stored round, the first available round,
///         or choose among several stored rounds.
///
///         Submission is permissionless and optional. An adversary can
///         therefore influence WHICH valid rounds are present in the
///         registry and WHEN they are submitted, even though they cannot
///         alter the value of any valid round.
///
///         If outcome selection depends on registry availability, an
///         adversary may selectively submit only rounds that produce a
///         favorable result. The target round must instead be fixed
///         independently of registry state before its randomness can
///         become known.
///
///      3. A COMMITTED ROUND MUST NEVER BE SUBSTITUTED
///         Once an action is bound to round R, only the randomness from
///         round R may settle that action. If R has not yet been cached,
///         the action must remain pending until R is supplied; it must
///         not fall back to R+1, another available round, or a newly
///         selected round.
///
///         A missing registry entry is a liveness condition, not grounds
///         for choosing new randomness. Substitution after R becomes
///         knowable is economically equivalent to rerolling: whether to
///         use R or another round can depend on the already-known outcome.
///
///         Settlement should therefore remain permissionless for the exact
///         committed round, allowing anyone to supply R's valid signature
///         through `submitBeacon`.
///
///      4. DOMAIN SEPARATION
///         The stored randomness is application-neutral and identical on
///         every chain where the same Quicknet round is imported.
///         Consumers should derive application-specific randomness. e.g.:
///
///             bytes32 seed = keccak256(abi.encode(
///                 DOMAIN_TAG,
///                 block.chainid,
///                 address(this),
///                 campaignId,
///                 drawId,
///                 randomness
///             ));
///
///         Omit block.chainid only when identical cross-chain results are
///         intentionally desired.
///
///      5. REGISTRY STORAGE IS NOT A KNOWABILITY BOUNDARY
///         A Quicknet round has a scheduled time (`roundScheduledTime`),
///         independently of when anyone submits it to this registry.
///         Under the normal drand threshold-honesty assumption, consumers
///         must treat the round as potentially knowable by its scheduled
///         time, not by its registry storage time.
///
///         Neither storage in this registry nor the `BeaconStored` event
///         proves that the value was unknowable beforehand. A colluding
///         drand signing threshold could additionally know an unchained
///         future beacon before its scheduled time.
contract DrandQuicknetBeaconRegistry is
    IDrandQuicknetBeaconRegistry
{
    error InvalidVerifier();
    error InvalidMinimumLeadRounds();
    error InvalidRound();
    error InvalidBeacon();
    error BeaconUnavailable(uint64 round);

    /// @notice Unix timestamp associated with Quicknet round 1.
    uint64 public constant GENESIS_TIMESTAMP = 1692803367;

    /// @notice Seconds between consecutive scheduled Quicknet rounds.
    uint64 public constant PERIOD_SECONDS = 3;

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    address public immutable override verifier;

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    bytes32 public immutable override verifierCodehash;

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    uint64 public immutable override minimumLeadRounds;

    /// @dev round => official drand randomness.
    ///      bytes32(0) represents "not stored".
    ///      Verified zero randomness is deliberately rejected so zero
    ///      can serve as the unstored sentinel.
    mapping(uint64 round => bytes32 randomness) private _beacons;

    /// @param verifier_ Quicknet verifier used by this registry.
    /// @param verifierCodehash_ Expected runtime bytecode hash of `verifier_`.
    /// @param minimumLeadRounds_ Minimum future-round lead declared by this
    ///        registry deployment.
    constructor(
        address verifier_,
        bytes32 verifierCodehash_,
        uint64 minimumLeadRounds_
    ) {
        if (verifier_.code.length == 0) {
            revert InvalidVerifier();
        }

        if (
            verifierCodehash_ == bytes32(0) ||
            verifier_.codehash != verifierCodehash_
        ) {
            revert InvalidVerifier();
        }

        if (minimumLeadRounds_ == 0) {
            revert InvalidMinimumLeadRounds();
        }

        verifier = verifier_;
        verifierCodehash = verifierCodehash_;
        minimumLeadRounds = minimumLeadRounds_;
    }

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    function submitBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        override
        returns (bytes32 randomness)
    {
        if (round == 0) {
            revert InvalidRound();
        }

        randomness = _beacons[round];

        if (randomness != bytes32(0)) {
            return randomness;
        }

        bool verified;

        (
            verified,
            randomness
        ) = IQuicknetBeaconVerifier(
            verifier
        ).verifyBeacon(
            round,
            signature
        );

        if (!verified || randomness == bytes32(0)) {
            revert InvalidBeacon();
        }

        _beacons[round] = randomness;

        emit BeaconStored(
            round,
            randomness,
            msg.sender
        );

        return randomness;
    }

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    function getBeacon(
        uint64 round
    )
        external
        view
        override
        returns (bytes32 randomness)
    {
        if (round == 0) {
            revert InvalidRound();
        }

        randomness = _beacons[round];

        if (randomness == bytes32(0)) {
            revert BeaconUnavailable(round);
        }
    }

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    function isStored(
        uint64 round
    )
        external
        view
        override
        returns (bool)
    {
        if (round == 0) {
            return false;
        }

        return _beacons[round] != bytes32(0);
    }

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    function roundScheduledTime(
        uint64 round
    )
        public
        pure
        override
        returns (uint256)
    {
        if (round == 0) {
            revert InvalidRound();
        }

        return
            uint256(GENESIS_TIMESTAMP) +
            uint256(round - 1) * uint256(PERIOD_SECONDS);
    }

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    function roundAt(
        uint256 timestamp
    )
        public
        pure
        override
        returns (uint64)
    {
        if (timestamp < uint256(GENESIS_TIMESTAMP)) {
            return 0;
        }

        uint256 round = (timestamp - uint256(GENESIS_TIMESTAMP))
            / uint256(PERIOD_SECONDS) + 1;

        if (round > type(uint64).max) {
            revert InvalidRound();
        }

        return uint64(round);
    }

    /// @inheritdoc IDrandQuicknetBeaconRegistry
    function latestScheduledRound()
        external
        view
        override
        returns (uint64)
    {
        return roundAt(block.timestamp);
    }
}
