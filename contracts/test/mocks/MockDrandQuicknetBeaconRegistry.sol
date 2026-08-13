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

    address public override oracle;
    bytes32 public override oracleCodehash;

    uint64 private _latestScheduledRound;

    mapping(uint64 round => bytes32 randomness)
        private _beacons;

    bool public revertOnIsStored;
    bool public revertOnGetBeacon;
    bool public revertOnSubmitBeacon;

    uint256 public verificationCount;

    constructor(
        address oracle_,
        bytes32 oracleCodehash_
    ) {
        oracle = oracle_;
        oracleCodehash = oracleCodehash_;
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
        if (revertOnSubmitBeacon) {
            revert UnexpectedCall();
        }

        if (round == 0) {
            revert InvalidRound();
        }

        randomness = _beacons[round];

        // Match the real registry's important idempotency behavior:
        // once stored, the signature is not examined.
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

        // The real registry uses zero as the "not stored" sentinel.
        // Avoid producing zero in the mock as well.
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

        // Schedule accuracy is not important for consumer unit tests.
        // Returning the round itself makes assertions deterministic.
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
}