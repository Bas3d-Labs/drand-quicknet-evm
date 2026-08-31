// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    DrandQuicknetBeaconRegistry
} from "../../src/DrandQuicknetBeaconRegistry.sol";

import {RegistryIntegrationTestBase} from "./RegistryIntegrationTestBase.sol";

contract DrandQuicknetBeaconRegistryIntegrationTest is RegistryIntegrationTestBase {
    uint64 internal constant KAT_ROUND = 1000;
    uint64 internal constant SECOND_KNOWN_ROUND = 13_335;
    uint64 internal constant LIVE_ROUND = 31_089_008;

    bytes32 internal constant KAT_RANDOMNESS_HASH =
        0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

    bytes32 internal constant LIVE_RANDOMNESS=
        0xce7b0bc26c2f2f969bb4fa4ceb074fd13baed8557659ac0ea1af0b589c68d8bf;

    function test_RealVerifierAcceptsKatSignature() public {
        bytes memory signature = _katSignature();

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            KAT_ROUND,
            signature
        );

        assertTrue(verified);
        assertEq(randomness, KAT_RANDOMNESS_HASH);
        assertEq(randomness, sha256(signature));

        bytes32 stored = registry.submitBeacon(KAT_ROUND, signature);

        assertEq(stored, randomness);
        assertEq(
            registry.getBeacon(KAT_ROUND),
            randomness
        );
    }

    function test_LiveKnownVectorMatchesExpectedRandomness() public {
        bytes memory signature = _liveSignature();

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            LIVE_ROUND,
            signature
        );

        assertTrue(verified);
        assertEq(randomness, LIVE_RANDOMNESS);
        assertEq(randomness, sha256(signature));

        bytes32 stored = registry.submitBeacon(LIVE_ROUND, signature);

        assertEq(stored, LIVE_RANDOMNESS);
        assertEq(
            registry.getBeacon(LIVE_ROUND),
            LIVE_RANDOMNESS
        );
    }

    function test_SignatureForDifferentRoundRejected() public {
        bytes memory signature = _katSignature();
        uint64 wrongRound = KAT_ROUND + 1;

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            wrongRound,
            signature
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));

        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidBeacon
                .selector
        );

        registry.submitBeacon(wrongRound, signature);

        assertFalse(registry.isStored(wrongRound));
    }

    function test_MalformedSignatureCannotStoreBeacon() public {
        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidBeacon
                .selector
        );

        registry.submitBeacon(KAT_ROUND, hex"01");

        assertFalse(registry.isStored(KAT_ROUND));
    }

    function test_SFlippedSignatureCannotStoreBeacon() public {
        bytes memory signature = _katSignature();

        signature[0] = bytes1(
            uint8(signature[0]) ^ 0x20
        );

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            KAT_ROUND,
            signature
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));

        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidBeacon
                .selector
        );

        registry.submitBeacon(KAT_ROUND, signature);

        assertFalse(registry.isStored(KAT_ROUND));
    }

    function test_SecondKnownVectorVerifies() public {
        bytes memory signature = _secondKnownSignature();

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            SECOND_KNOWN_ROUND,
            signature
        );

        assertTrue(verified);
        assertNotEq(randomness, bytes32(0));
        assertEq(randomness, sha256(signature));

        assertEq(
            registry.submitBeacon(
                SECOND_KNOWN_ROUND,
                signature
            ),
            randomness
        );
    }
}
