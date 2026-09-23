// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IDrandQuicknetBeaconRegistry
} from "../../src/interfaces/IDrandQuicknetBeaconRegistry.sol";

contract MockDrandQuicknetBeaconRegistry is
    IDrandQuicknetBeaconRegistry
{
    error InvalidRound();
    error BeaconUnavailable(uint64 round);
    error InvalidSignature();
    error UnexpectedCall();

    address public override verifier;
    bytes32 public override verifierCodehash;
    uint64 public override minimumLeadRounds;

    uint64 private _latestScheduledRound;

    mapping(uint64 round => bytes32 randomness)
        private _beacons;

    bool public revertOnIsStored;
    bool public revertOnGetBeacon;
    bool public revertOnSubmitBeacon;

    uint256 public verificationCount;

    constructor(
        address verifier_,
        bytes32 verifierCodehash_,
        uint64 minimumLeadRounds_
    ) {
        verifier = verifier_;
        verifierCodehash = verifierCodehash_;
        minimumLeadRounds = minimumLeadRounds_;
    }

    function setLatestScheduledRound(
        uint64 round
    )
        external
    {
        _latestScheduledRound = round;
    }

    function setBeacon(
        uint64 round,
        bytes32 randomness
    )
        external
    {
        if (round == 0) {
            revert InvalidRound();
        }

        _beacons[round] = randomness;
    }

    function setRevertOnIsStored(
        bool value
    )
        external
    {
        revertOnIsStored = value;
    }

    function setRevertOnGetBeacon(
        bool value
    )
        external
    {
        revertOnGetBeacon = value;
    }

    function setRevertOnSubmitBeacon(
        bool value
    )
        external
    {
        revertOnSubmitBeacon = value;
    }

    function submitBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        override
        returns (bytes32 randomness)
    {
        return _submitBeacon(
            round,
            signature
        );
    }

    /// @dev Consumer test double only. Witness coordinates are ignored.
    ///      Both submission methods share the cache and verification count.
    function submitBeaconWithWitness(
        uint64 round,
        bytes calldata signature,
        uint128,
        uint256
    )
        external
        override
        returns (bytes32 randomness)
    {
        return _submitBeacon(
            round,
            signature
        );
    }

    function getBeacon(
        uint64 round
    )
        external
        view
        override
        returns (bytes32 randomness)
    {
        if (revertOnGetBeacon) {
            revert UnexpectedCall();
        }

        if (round == 0) {
            revert InvalidRound();
        }

        randomness = _beacons[round];

        if (randomness == bytes32(0)) {
            revert BeaconUnavailable(round);
        }
    }

    function isStored(
        uint64 round
    )
        external
        view
        override
        returns (bool)
    {
        if (revertOnIsStored) {
            revert UnexpectedCall();
        }

        if (round == 0) {
            return false;
        }

        return _beacons[round] != bytes32(0);
    }

    function roundScheduledTime(
        uint64 round
    )
        external
        pure
        override
        returns (uint256)
    {
        if (round == 0) {
            revert InvalidRound();
        }

        return uint256(round);
    }

    function roundAt(
        uint256 timestamp
    )
        external
        pure
        override
        returns (uint64)
    {
        if (timestamp > type(uint64).max) {
            return type(uint64).max;
        }

        return uint64(timestamp);
    }

    function latestScheduledRound()
        external
        view
        override
        returns (uint64)
    {
        return _latestScheduledRound;
    }

    /// @dev Shared deterministic submission behavior for consumer tests.
    ///      The submission revert flag applies to both entry points.
    function _submitBeacon(
        uint64 round,
        bytes calldata signature
    )
        private
        returns (bytes32 randomness)
    {
        if (revertOnSubmitBeacon) {
            revert UnexpectedCall();
        }

        if (round == 0) {
            revert InvalidRound();
        }

        randomness = _beacons[round];

        if (randomness != bytes32(0)) {
            return randomness;
        }

        if (signature.length == 0) {
            revert InvalidSignature();
        }

        ++verificationCount;

        randomness = keccak256(
            abi.encode(
                round,
                signature
            )
        );

        if (randomness == bytes32(0)) {
            randomness = bytes32(uint256(1));
        }

        _beacons[round] = randomness;

        emit BeaconStored(
            round,
            randomness,
            msg.sender
        );
    }
}