// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IDrandOracleQuicknet} from "./IDrandOracleQuicknet.sol";

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
///         the normal drand threshold-honesty assumption. Use a lead
///         margin rather than relying on a bare scheduled-time boundary:
///
///             if (targetRound <
///                 registry.latestScheduledRound() + MIN_LEAD_ROUNDS)
///             {
///                 revert TooLate();
///             }
///
///         Size MIN_LEAD_ROUNDS according to the consumer's chain and
///         threat model, including relevant timestamp uncertainty and
///         desired finality/reorg margin. If targetRound is selected
///         off-chain before transaction submission, transaction
///         inclusion latency must also be accounted for.
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
contract DrandQuicknetBeaconRegistry {
    error InvalidOracle();
    error InvalidRound();
    error InvalidBeacon();
    error BeaconUnavailable(uint64 round);

    /// @notice Unix timestamp associated with Quicknet round 1.
    uint64 public constant GENESIS_TIMESTAMP = 1692803367;

    /// @notice Seconds between consecutive scheduled Quicknet rounds.
    uint64 public constant PERIOD_SECONDS = 3;

    /// @notice Runtime code hash of the exact Quicknet verifier accepted
    ///         by this registry.
    bytes32 public constant EXPECTED_ORACLE_CODEHASH = 0x78faa56ca608db8a19cfb3bb052f11fedbaa14fb1ce74db58044db99246b4cfc;

    /// @notice Immutable drand Quicknet verifier.
    IDrandOracleQuicknet public immutable oracle;

    /// @dev round => canonical normalized beacon hash.
    ///      bytes32(0) represents "not stored".
    ///      A verified zero hash is deliberately rejected so zero 
    ///      can serve as the unstored sentinel.
    mapping(uint64 round => bytes32 randomness) private _beacons;

    event BeaconStored(
        uint64 indexed round,
        bytes32 randomness,
        address indexed submitter
    );

    constructor(address oracle_) {
        if (oracle_.codehash != EXPECTED_ORACLE_CODEHASH) {
            revert InvalidOracle();
        }

        oracle = IDrandOracleQuicknet(oracle_);
    }

    /// @notice Verifies and caches a Quicknet beacon.
    /// @dev Idempotent. If the round has already been verified,
    ///      the cached value is returned without examining `signature`.
    ///      Both 48-byte compressed and 96-byte uncompressed Quicknet
    ///      signatures may be accepted by the underlying oracle.
    function submitBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        returns (bytes32 randomness)
    {
        if (round == 0) {
            revert InvalidRound();
        }

        randomness = _beacons[round];

        if (randomness != bytes32(0)) {
            return randomness;
        }

        (
            bool verified, 
            bytes32 normalizedRoundHash, 
        ) = oracle.verifyNormalized(round, signature);

        if (!verified || normalizedRoundHash == bytes32(0)) {
            revert InvalidBeacon();
        }

        randomness = normalizedRoundHash;
        _beacons[round] = randomness;

        emit BeaconStored(round, randomness, msg.sender);

        return randomness;
    }

    /// @notice Returns the verified randomness for `round`.
    /// @dev Reverts if the round has not been cached.
    function getBeacon(uint64 round) 
        external
        view
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

    /// @notice Returns true if `round` has already been verified and stored.
    function isStored(uint64 round) 
        external
        view
        returns (bool)
    {
        return _beacons[round] != bytes32(0);
    }

    /// @notice Returns the scheduled Unix timestamp for `round`.
    /// @dev This is Quicknet schedule arithmetic only. It does not
    ///      prove that the beacon was actually published at this exact
    ///      time, nor that it could not have been known earlier by a
    ///      colluding drand signing threshold. 
    function roundScheduledTime(uint64 round)
        public
        pure
        returns (uint256)
    {
        if (round == 0) {
            revert InvalidRound();
        }

        return
            uint256(GENESIS_TIMESTAMP) +
            uint256(round - 1) *
            uint256(PERIOD_SECONDS);
    }
    
    /// @notice Returns the latest Quicknet round scheduled at or
    ///         before `timestamp`.
    function roundAt(uint256 timestamp)
        public
        pure
        returns (uint64)
    {
        if (timestamp < uint256(GENESIS_TIMESTAMP)) {
            return 0;
        }

        uint256 round = (timestamp - uint256(GENESIS_TIMESTAMP)) / uint256(PERIOD_SECONDS) + 1;

        if (round > type(uint64).max) {
            revert InvalidRound();
        }

        return uint64(round);
    }

    /// @notice Returns the latest Quicknet round whose scheduled time
    ///         has passed according to this chain's block.timestamp.
    /// @dev This is not a proof of beacon availability or first
    ///      knowability, only a schedule helper.
    function latestScheduledRound()
        external
        view
        returns (uint64)
    {
        return roundAt(block.timestamp);
    }
}