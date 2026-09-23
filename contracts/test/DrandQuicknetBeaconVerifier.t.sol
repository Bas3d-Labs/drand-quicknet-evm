// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../src/verifiers/DrandQuicknetBeaconVerifier.sol";

import {
    DrandQuicknetBeaconVerifierHarness
} from "./harnesses/DrandQuicknetBeaconVerifierHarness.sol";

contract DrandQuicknetBeaconVerifierTest is Test {
    uint64 internal constant KAT_ROUND = 1000;

    bytes32 internal constant KAT_RANDOMNESS =
        0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

    uint64 internal constant ALIAS_KAT_ROUND = 13_335;

    bytes32 internal constant ALIAS_KAT_RANDOMNESS =
        0xf4eb2e59448d155b1bc34337f2a4160ac5005429644ba61134779a8b8c6087b6;

    uint128 internal constant P_HI =
        0x1a0111ea397fe69a4b1ba7b6434bacd7;

    uint256 internal constant P_LO =
        0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    uint128 internal constant MAX_X_HI =
        0x1fffffffffffffffffffffffffffffff;

    uint256 internal constant AMPLE_VERIFY_GAS = 2_000_000;
    uint256 internal constant STARVED_VERIFY_GAS = 1_000;
    uint256 internal constant REFERENCE_KAT_GAS_CEILING = 800_000;

    address internal constant PAIRING_PRECOMPILE = address(0x0f);

    uint128 internal constant KAT_Y_HI =
        0x11f92e4521ef54f047b64b85fa98db2d;

    uint256 internal constant KAT_Y_LO =
        0x46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2;

    uint128 internal constant NEGATIVE_KAT_Y_HI =
        0x0807e3a5179091aa03655c3048b2d1aa;

    uint256 internal constant NEGATIVE_KAT_Y_LO =
        0x1d86573a1665b20627a6c4e3194d42d4fb25a83bd81912e700f32229f5fdf3d9;

    uint128 internal constant X4_Y_HI =
        0x0a989badd40d6212b33cffc3f3763e9b;

    uint256 internal constant X4_Y_LO =
        0xc760f988c9926b26da9dd85e928483446346b8ed00e1de5d5ea93e354abe706c;

    DrandQuicknetBeaconVerifierHarness internal verifier;

    function setUp() public {
        verifier = new DrandQuicknetBeaconVerifierHarness();
    }

    // ---------------------------------------------------------------------
    // Assurance ownership
    // ---------------------------------------------------------------------
    //
    // Canonical encoding:
    // - Unit vectors and fuzz tests.
    //
    // Valid Quicknet verification:
    // - Official known-answer tests.
    //
    // Pairing equation / round binding:
    // - S-flip and wrong-round vectors.
    //
    // Curve / subgroup rejection:
    // - Adversarial vectors through EIP-2537.
    //
    // Caller gas handling:
    // - Explicit gas-band tests.
    //
    // Pairing gas-cap forwarding:
    // - Guard-band and constrained invalid-input tests.
    // - Focused review of work between the gas guard and STATICCALL.
    //
    // Precompile ABI / execution-environment invariants:
    // - Focused low-level code review.
    // - Two-sided constructor self-test.
    // - Post-deployment acceptance/rejection KAT.
    // - Recurring acceptance/rejection canary.
    //
    // Nonconforming precompile behavior is intentionally not modeled by
    // replacing reserved precompile addresses with test doubles.

    // ---------------------------------------------------------------------
    // Verification behavior
    // ---------------------------------------------------------------------

    function test_verifyBeacon_matchesOfficialQuicknetVector()
        public
        view
    {
        bytes memory signature = _katSignature();

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            KAT_ROUND,
            signature
        );

        assertTrue(verified);

        assertEq(
            randomness,
            KAT_RANDOMNESS
        );

        assertEq(
            sha256(signature),
            KAT_RANDOMNESS
        );
    }

    function test_verifyBeacon_rejectsRoundZero()
        public
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            0,
            _katSignature()
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    function test_verifyBeacon_rejectsWrongRound()
        public
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            KAT_ROUND + 1,
            _katSignature()
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    function test_xBitTamperIsCanonicalButDoesNotVerify()
        public
        view
    {
        bytes memory signature = _katSignature();

        signature[47] =
            bytes1(
                uint8(signature[47]) ^
                0x01
            );

        assertTrue(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    // ---------------------------------------------------------------------
    // Canonical encoding
    // ---------------------------------------------------------------------

    function test_isCanonical_acceptsOfficialSignature()
        public
        view
    {
        assertTrue(
            verifier.isCanonical(
                _katSignature()
            )
        );
    }

    function test_rejectsValidLookingInvalidSignatureLengths()
        public
        view
    {
        _assertNonCanonicalRejected(
            new bytes(0)
        );

        _assertNonCanonicalRejected(
            _validLookingSignatureWithLength(47)
        );

        _assertNonCanonicalRejected(
            _validLookingSignatureWithLength(49)
        );

        _assertNonCanonicalRejected(
            _validLookingSignatureWithLength(96)
        );
    }

    function test_isCanonical_rejectsCompressionBitClear()
        public
        view
    {
        bytes memory signature = _katSignature();
        signature[0] =
            bytes1(
                uint8(signature[0]) &
                0x7f
            );

        assertFalse(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    function test_isCanonical_rejectsInfinityBitSet()
        public
        view
    {
        bytes memory signature = _katSignature();
        signature[0] =
            bytes1(
                uint8(signature[0]) |
                0x40
            );

        assertFalse(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    function test_signBitFlipIsCanonicalButDoesNotVerify()
        public
        view
    {
        bytes memory signature = _katSignature();
        signature[0] =
            bytes1(
                uint8(signature[0]) ^
                0x20
            );

        assertTrue(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    function test_isCanonical_acceptsXEqualPMinusOne()
        public
        view
    {
        bytes memory signature =
            hex"9a0111ea397fe69a4b1ba7b6434bacd7"
            hex"64774b84f38512bf6730d2a0f6b0f624"
            hex"1eabfffeb153ffffb9feffffffffaaaa";

        assertTrue(
            verifier.isCanonical(
                signature
            )
        );
    }

    function test_isCanonical_rejectsXEqualP()
        public
        view
    {
        bytes memory signature =
            hex"9a0111ea397fe69a4b1ba7b6434bacd7"
            hex"64774b84f38512bf6730d2a0f6b0f624"
            hex"1eabfffeb153ffffb9feffffffffaaab";

        assertFalse(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    function test_isCanonical_rejectsXPlusPAlias()
        public
        view
    {
        bytes memory signature = _aliasKatSignature();

        assertTrue(
            verifier.isCanonical(
                signature
            )
        );

        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            ALIAS_KAT_ROUND,
            signature
        );

        assertTrue(verified);
        assertEq(randomness, ALIAS_KAT_RANDOMNESS);
        assertEq(sha256(signature), ALIAS_KAT_RANDOMNESS);

        uint256 wordA;
        uint256 xLo;

        assembly {
            wordA := mload(add(signature, 0x20))
            xLo := mload(add(signature, 0x30))
        }

        uint128 xHi =
            uint128(wordA >> 128) &
            MAX_X_HI;

        uint256 aliasLo;

        unchecked {
            aliasLo = xLo + P_LO;
        }

        uint128 carry;

        if (aliasLo < xLo) {
            carry = 1;
        }

        uint128 aliasHi =
            xHi + P_HI + carry;

        // The alias is only meaningful if x + p still fits within the
        // 381 coordinate bits and does not enter the reserved flag bits.
        assertLe(aliasHi, MAX_X_HI);

        uint128 flags =
            uint128(
                uint8(signature[0]) &
                0xe0
            ) << 120;

        bytes memory aliasSignature =
            abi.encodePacked(
                bytes16(aliasHi | flags),
                bytes32(aliasLo)
            );

        assertEq(aliasSignature.length, 48);

        // Secondary sanity check. Eligibility was established above before
        // the original C/I/S bits were restored.
        assertEq(
            uint8(aliasSignature[0]) & 0xe0,
            uint8(signature[0]) & 0xe0
        );

        assertFalse(
            verifier.isCanonical(
                aliasSignature
            )
        );

        _assertRejectedAtRound(
            ALIAS_KAT_ROUND,
            aliasSignature
        );
    }

    // ---------------------------------------------------------------------
    // Witness
    // ---------------------------------------------------------------------

    function test_witness_matchesOfficialQuicknetVector()
        public
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeaconWithWitness(
            KAT_ROUND,
            _katSignature(),
            KAT_Y_HI,
            KAT_Y_LO
        );

        assertTrue(verified);
        assertEq(randomness, KAT_RANDOMNESS);
    }

    function test_witness_roundZeroRejectsBeforePairing()
        public
    {
        _expectNoPairing();

        _assertWitnessRejected(
            0,
            _katSignature(),
            KAT_Y_HI,
            KAT_Y_LO
        );
    }

    function test_witness_invalidLengthsRejectBeforePairing()
        public
    {
        _expectNoPairing();

        uint256[4] memory lengths = [
            uint256(0),
            47,
            49,
            96
        ];

        for (uint256 i = 0; i < lengths.length; ++i) {
            _assertWitnessRejected(
                KAT_ROUND,
                _validLookingSignatureWithLength(lengths[i]),
                KAT_Y_HI,
                KAT_Y_LO
            );
        }
    }

    function test_witness_invalidFlagsRejectBeforePairing()
        public
    {
        _expectNoPairing();

        uint8[6] memory flags = [
            uint8(0x00),
            0x20,
            0x40,
            0x60,
            0xc0,
            0xe0
        ];

        for (uint256 i = 0; i < flags.length; ++i) {
            bytes memory signature = _katSignature();

            signature[0] = bytes1(
                (uint8(signature[0]) & 0x1f) | flags[i]
            );

            _assertWitnessRejected(
                KAT_ROUND,
                signature,
                KAT_Y_HI,
                KAT_Y_LO
            );
        }
    }

    function test_witness_xAtOrAbovePRejectsBeforePairing()
        public
    {
        _expectNoPairing();

        _assertWitnessRejected(
            KAT_ROUND,
            _compressedPoint(P_HI, P_LO, true),
            KAT_Y_HI,
            KAT_Y_LO
        );

        _assertWitnessRejected(
            KAT_ROUND,
            _compressedPoint(P_HI, P_LO + 1, true),
            KAT_Y_HI,
            KAT_Y_LO
        );

        _assertWitnessRejected(
            KAT_ROUND,
            _compressedPoint(MAX_X_HI, type(uint256).max, true),
            KAT_Y_HI,
            KAT_Y_LO
        );
    }

    function test_witness_yAtOrAbovePRejectsBeforePairing()
        public
    {
        _expectNoPairing();

        bytes memory signature = _katSignature();

        _assertWitnessRejected(KAT_ROUND, signature, P_HI, P_LO);
        _assertWitnessRejected(KAT_ROUND, signature, P_HI, P_LO + 1);
        _assertWitnessRejected(KAT_ROUND, signature, P_HI + 1, 0);

        _assertWitnessRejected(
            KAT_ROUND,
            signature,
            type(uint128).max,
            type(uint256).max
        );
    }

    function test_witness_infinityRejectsBeforePairing()
        public
    {
        _expectNoPairing();

        _assertWitnessRejected(
            KAT_ROUND,
            _compressedPoint(0, 0, false),
            0,
            0
        );

        _assertWitnessRejected(
            KAT_ROUND,
            _compressedPoint(0, 0, true),
            0,
            0
        );
    }

    function test_witness_signMismatchesRejectBeforePairing()
        public
    {
        _expectNoPairing();

        _assertWitnessRejected(
            KAT_ROUND,
            _katSignature(),
            NEGATIVE_KAT_Y_HI,
            NEGATIVE_KAT_Y_LO
        );

        bytes memory flipped = _katSignature();
        flipped[0] = bytes1(uint8(flipped[0]) ^ 0x20);

        _assertWitnessRejected(
            KAT_ROUND,
            flipped,
            KAT_Y_HI,
            KAT_Y_LO
        );
    }

    function test_witness_wrongRoundReachesPairing()
        public
    {
        bytes memory signature = _katSignature();

        bytes memory input = verifier.pairingInputForWitness(
            KAT_ROUND + 1,
            signature,
            KAT_Y_HI,
            KAT_Y_LO
        );

        vm.expectCall(PAIRING_PRECOMPILE, input, uint64(1));

        _assertWitnessRejected(
            KAT_ROUND + 1,
            signature,
            KAT_Y_HI,
            KAT_Y_LO
        );
    }

    /// @dev Local execution conformance. Target-chain RPC calls and traces
    ///      must independently repeat these cases before deployment use.
    function test_witness_matchesRawPairingConformanceCases()
        public
    {
        // Passing control under the same raw-call gas allowance.
        _assertPairingCase(
            _katSignature(),
            KAT_Y_HI,
            KAT_Y_LO,
            true,
            true
        );

        // Valid subgroup point, correctly encoded, wrong signature.
        bytes memory flipped = _katSignature();
        flipped[0] = bytes1(uint8(flipped[0]) ^ 0x20);

        _assertPairingCase(
            flipped,
            NEGATIVE_KAT_Y_HI,
            NEGATIVE_KAT_Y_LO,
            true,
            false
        );

        // Off-curve point with the original signature's sign.
        _assertPairingCase(
            _katSignature(),
            KAT_Y_HI,
            KAT_Y_LO + 1,
            false,
            false
        );

        // On-curve, non-subgroup: smaller root at x = 0.
        _assertPairingCase(
            _compressedPoint(0, 0, false),
            0,
            2,
            false,
            false
        );

        // On-curve, non-subgroup: larger root at x = 0.
        _assertPairingCase(
            _compressedPoint(0, 0, true),
            P_HI,
            P_LO - 2,
            false,
            false
        );

        // On-curve, non-subgroup: generic nonzero x.
        _assertPairingCase(
            _compressedPoint(0, 4, false),
            X4_Y_HI,
            X4_Y_LO,
            false,
            false
        );
    }

    function test_compressed_rejectsAdditionalSubgroupVectors()
        public
    {
        vm.expectCall(
            PAIRING_PRECOMPILE,
            bytes(""),
            uint64(2)
        );

        _assertDecompressedAndRejected(
            _compressedPoint(0, 0, true),
            0,
            P_HI,
            P_LO - 2
        );

        _assertDecompressedAndRejected(
            _compressedPoint(0, 4, false),
            4,
            X4_Y_HI,
            X4_Y_LO
        );
    }

    function testFuzz_witness_rejectsOtherCanonicalY(
        uint128 rawYHi,
        uint256 rawYLo
    )
        public
        view
    {
        (
            uint128 yHi,
            uint256 yLo
        ) = _boundedY(rawYHi, rawYLo);

        vm.assume(yHi != KAT_Y_HI || yLo != KAT_Y_LO);

        _assertWitnessRejected(
            KAT_ROUND,
            _katSignature(),
            yHi,
            yLo
        );
    }

    function testFuzz_witness_smallYRejectsBeforePairing(
        uint256 yLo
    )
        public
    {
        // Every 256-bit y is below p/2. The KAT requires S = 1.
        _expectNoPairing();

        _assertWitnessRejected(
            KAT_ROUND,
            _katSignature(),
            0,
            yLo
        );
    }

    function test_negateY_boundariesAddBackToP()
        public
        view
    {
        _assertNegation(0, 0);
        _assertNegation(0, 1);
        _assertNegation(0, P_LO);
        _assertNegation(0, P_LO + 1);
        _assertNegation(0, type(uint256).max);
        _assertNegation(P_HI, P_LO - 1);
        _assertNegation(P_HI - 1, P_LO + 1);
        _assertNegation(P_HI - 1, type(uint256).max);
    }

    function testFuzz_negateY_addsBackToP(
        uint128 rawYHi,
        uint256 rawYLo
    )
        public
        view
    {
        (
            uint128 yHi,
            uint256 yLo
        ) = _boundedY(rawYHi, rawYLo);

        _assertNegation(yHi, yLo);
    }

    function test_witness_guardPrecedesKatSuccessBand()
        public
        view
    {
        _assertWitnessGasBoundary(true);
    }

    function test_witness_guardPrecedesInvalidCompletionBand()
        public
        view
    {
        _assertWitnessGasBoundary(false);
    }

    // ---------------------------------------------------------------------
    // Curve and subgroup validation
    // ---------------------------------------------------------------------

    function test_offSubgroupPointIsCanonicalButDoesNotVerify()
        public
        view
    {
        // This encoding decompresses to P = (0, 2).
        //
        // P is on y^2 = x^3 + 4. Since the doubling slope at x = 0 is zero,
        // 2P = (0, -2) = -P, so 3P is infinity. P therefore has order 3
        // and cannot belong to the prime-order BLS12-381 G1 subgroup.
        bytes memory pointEncoding =
            _offSubgroupPointEncoding();

        assertTrue(
            verifier.isCanonical(
                pointEncoding
            )
        );

        (
            uint128 xHi,
            uint256 xLo,
            uint128 yHi,
            uint256 yLo
        ) = verifier.decompressG1(
            pointEncoding
        );

        assertEq(xHi, 0);
        assertEq(xLo, 0);
        assertEq(yHi, 0);
        assertEq(yLo, 2);

        _assertRejected(pointEncoding);
    }

    // ---------------------------------------------------------------------
    // Fuzz properties
    // ---------------------------------------------------------------------

    function testFuzz_rejectsValidLookingNon48ByteLengths(
        uint8 length
    )
        public
        view
    {
        vm.assume(length != 48);

        bytes memory signature =
            _validLookingSignatureWithLength(
                length
            );

        assertFalse(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    function testFuzz_isCanonical_signBitDoesNotAffectCanonicality(
        bytes32 first,
        bytes16 second
    )
        public
        view
    {
        bytes memory signature =
            _signature48(
                first,
                second
            );

        bytes memory flippedSignature =
            _signature48(
                first,
                second
            );

        flippedSignature[0] =
            bytes1(
                uint8(flippedSignature[0]) ^
                0x20
            );

        assertEq(
            verifier.isCanonical(signature),
            verifier.isCanonical(flippedSignature)
        );
    }

    function testFuzz_isCanonical_matchesFieldBoundForValidFlags(
        uint128 rawXHi,
        uint256 xLo,
        bool sign
    )
        public
        view
    {
        uint128 xHi = rawXHi & MAX_X_HI;

        uint128 flags =
            uint128(0x80) << 120;

        if (sign) {
            flags |=
                uint128(0x20) << 120;
        }

        bytes memory signature =
            abi.encodePacked(
                bytes16(xHi | flags),
                bytes32(xLo)
            );

        bool belowP =
            xHi < P_HI ||
            (
                xHi == P_HI &&
                xLo < P_LO
            );

        assertEq(
            verifier.isCanonical(signature),
            belowP
        );
    }

    function testFuzz_verifyBeacon_canonicalCandidateReturnsConsistentResult(
        uint64 round,
        bytes32 first,
        bytes16 second
    )
        public
        view
    {
        vm.assume(round != 0);

        bytes memory signature =
            _signature48(
                first,
                second
            );

        signature[0] =
            bytes1(
                (
                    uint8(signature[0]) &
                    0x3f
                ) |
                0x80
            );

        vm.assume(
            verifier.isCanonical(
                signature
            )
        );

        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            AMPLE_VERIFY_GAS,
            round,
            signature
        );

        assertTrue(success);
        assertEq(returnData.length, 64);

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        if (verified) {
            assertEq(
                randomness,
                sha256(signature)
            );

            return;
        }

        assertEq(
            randomness,
            bytes32(0)
        );
    }

    function testFuzz_verifyBeacon_roundZeroAlwaysRejects(
        bytes memory signature
    )
        public
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            0,
            signature
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    function testFuzz_verifyBeacon_rejectsSingleBitKatMutation(
        uint16 rawBitIndex
    )
        public
        view
    {
        uint256 bitIndex =
            uint256(rawBitIndex) % 384;

        bytes memory signature =
            _katSignature();

        uint256 byteIndex =
            bitIndex / 8;

        uint8 bitMask =
            uint8(
                uint256(1) <<
                (bitIndex % 8)
            );

        signature[byteIndex] =
            bytes1(
                uint8(signature[byteIndex]) ^
                bitMask
            );

        _assertRejected(signature);
    }

    function testFuzz_verifyBeacon_boundedInputDoesNotRevert(
        uint64 round,
        bytes memory signature
    )
        public
        view
    {
        vm.assume(round != 0);
        vm.assume(signature.length <= 96);

        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            AMPLE_VERIFY_GAS,
            round,
            signature
        );

        assertTrue(success);
        assertEq(returnData.length, 64);

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        if (verified) {
            assertEq(
                signature.length,
                48
            );

            assertEq(
                randomness,
                sha256(signature)
            );

            return;
        }

        assertEq(
            randomness,
            bytes32(0)
        );
    }

    // ---------------------------------------------------------------------
    // Caller gas handling
    // ---------------------------------------------------------------------

    function test_verifyBeacon_succeedsWithAmpleGas()
        public
        view
    {
        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            AMPLE_VERIFY_GAS,
            KAT_ROUND,
            _katSignature()
        );

        assertTrue(success);
        assertEq(returnData.length, 64);

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        assertTrue(verified);
        assertEq(randomness, KAT_RANDOMNESS);
    }

    function test_verifyBeacon_guardPrecedesKatSuccessBand()
        public
        view
    {
        uint256 minimumSuccessfulGas =
            _minimumSuccessfulKatGas();

        assertGt(minimumSuccessfulGas, 0);

        // Regression ceiling for the current compiler and reference EVM profile.
        // This is not a cross-chain verifier gas requirement.
        assertLt(
            minimumSuccessfulGas,
            REFERENCE_KAT_GAS_CEILING
        );

        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            minimumSuccessfulGas - 1,
            KAT_ROUND,
            _katSignature()
        );

        assertFalse(success);
        assertEq(returnData.length, 4);

        assertEq(
            _revertSelector(returnData),
            DrandQuicknetBeaconVerifier
                .InsufficientVerifierGas
                .selector
        );

        (
            success,
            returnData
        ) = _callVerifyWithGas(
            minimumSuccessfulGas,
            KAT_ROUND,
            _katSignature()
        );

        assertTrue(success);
        assertEq(returnData.length, 64);

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        assertTrue(verified);
        assertEq(randomness, KAT_RANDOMNESS);
    }

    function test_verifyBeacon_severeGasStarvationHasNoRevertData()
        public
        view
    {
        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            STARVED_VERIFY_GAS,
            KAT_ROUND,
            _katSignature()
        );

        assertFalse(success);
        assertEq(returnData.length, 0);
    }

    function test_verifyBeacon_invalidCandidateReturnsFalseWithAmpleGas()
        public
        view
    {
        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            AMPLE_VERIFY_GAS,
            KAT_ROUND,
            _offSubgroupPointEncoding()
        );

        assertTrue(success);
        assertEq(returnData.length, 64);

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    function test_verifyBeacon_guardPrecedesInvalidCandidateCompletionBand()
        public
        view
    {
        uint256 minimumCompletedGas =
            _minimumCompletedInvalidCandidateGas();

        assertGt(minimumCompletedGas, 0);

        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            minimumCompletedGas - 1,
            KAT_ROUND,
            _offSubgroupPointEncoding()
        );

        assertFalse(success);
        assertEq(returnData.length, 4);

        assertEq(
            _revertSelector(returnData),
            DrandQuicknetBeaconVerifier
                .InsufficientVerifierGas
                .selector
        );

        (
            success,
            returnData
        ) = _callVerifyWithGas(
            minimumCompletedGas,
            KAT_ROUND,
            _offSubgroupPointEncoding()
        );

        assertTrue(success);
        assertEq(returnData.length, 64);

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _katSignature()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"b44679b9a59af2ec876b1a6b1ad52ea9"
            hex"b1615fc3982b19576350f93447cb1125"
            hex"e342b73a8dd2bacbe47e4b6b63ed5e39";
    }

    function _aliasKatSignature()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"a38ab268d58c04ce2d22b8317e4b66ec"
            hex"da5fa8841c7215bf7733af8dbaed6c5e"
            hex"7d8d60b77817294a64b891f719bc1b40";
    }

    function _offSubgroupPointEncoding()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"80000000000000000000000000000000"
            hex"00000000000000000000000000000000"
            hex"00000000000000000000000000000000";
    }

    function _expectNoPairing()
        internal
    {
        vm.expectCall(
            PAIRING_PRECOMPILE,
            bytes(""),
            uint64(0)
        );
    }

    function _assertRejected(
        bytes memory signature
    )
        internal
        view
    {
        _assertRejectedAtRound(
            KAT_ROUND,
            signature
        );
    }

    function _assertRejectedAtRound(
        uint64 round,
        bytes memory signature
    )
        internal
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            round,
            signature
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    function _minimumSuccessfulKatGas()
        internal
        view
        returns (uint256)
    {
        uint256 low;
        uint256 high = AMPLE_VERIFY_GAS;

        assertTrue(
            _katSucceedsWithGas(high)
        );

        while (low + 1 < high) {
            uint256 middle =
                low + (high - low) / 2;

            if (_katSucceedsWithGas(middle)) {
                high = middle;
            } else {
                low = middle;
            }
        }

        return high;
    }

    function _katSucceedsWithGas(
        uint256 gasLimit
    )
        internal
        view
        returns (bool)
    {
        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            gasLimit,
            KAT_ROUND,
            _katSignature()
        );

        if (
            !success ||
            returnData.length != 64
        ) {
            return false;
        }

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        return
            verified &&
            randomness == KAT_RANDOMNESS;
    }

    function _callVerifyWithGas(
        uint256 gasLimit,
        uint64 round,
        bytes memory signature
    )
        internal
        view
        returns (
            bool success,
            bytes memory returnData
        )
    {
        bytes memory callData =
            abi.encodeWithSelector(
                DrandQuicknetBeaconVerifier
                    .verifyBeacon
                    .selector,
                round,
                signature
            );

        return
            address(verifier).staticcall{
                gas: gasLimit
            }(
                callData
            );
    }

    function _revertSelector(
        bytes memory returnData
    )
        internal
        pure
        returns (bytes4 selector)
    {
        if (returnData.length < 4) {
            return bytes4(0);
        }

        assembly {
            selector := mload(add(returnData, 0x20))
        }
    }

    function _signature48(
        bytes32 first,
        bytes16 second
    )
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            first,
            second
        );
    }

    function _assertNonCanonicalRejected(
        bytes memory signature
    )
        internal
        view
    {
        assertFalse(
            verifier.isCanonical(
                signature
            )
        );

        _assertRejected(signature);
    }

    function _validLookingSignatureWithLength(
        uint256 length
    )
        internal
        pure
        returns (bytes memory signature)
    {
        signature = new bytes(length);

        if (length > 0) {
            signature[0] = 0x80;
        }
    }

    function _minimumCompletedInvalidCandidateGas()
        internal
        view
        returns (uint256)
    {
        uint256 low;
        uint256 high = AMPLE_VERIFY_GAS;

        assertTrue(
            _invalidCandidateCompletesWithGas(high)
        );

        while (low + 1 < high) {
            uint256 middle =
                low + (high - low) / 2;

            if (_invalidCandidateCompletesWithGas(middle)) {
                high = middle;
            } else {
                low = middle;
            }
        }

        return high;
    }

    function _invalidCandidateCompletesWithGas(
        uint256 gasLimit
    )
        internal
        view
        returns (bool)
    {
        (
            bool success,
            bytes memory returnData
        ) = _callVerifyWithGas(
            gasLimit,
            KAT_ROUND,
            _offSubgroupPointEncoding()
        );

        if (
            !success ||
            returnData.length != 64
        ) {
            return false;
        }

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(
            returnData,
            (bool, bytes32)
        );

        return
            !verified &&
            randomness == bytes32(0);
    }
    
    function _assertWitnessRejected(
        uint64 round,
        bytes memory signature,
        uint128 yHi,
        uint256 yLo
    )
        internal
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeaconWithWitness{
            gas: AMPLE_VERIFY_GAS
        }(
            round,
            signature,
            yHi,
            yLo
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }

    function _compressedPoint(
        uint128 xHi,
        uint256 xLo,
        bool largerRoot
    )
        internal
        pure
        returns (bytes memory)
    {
        uint128 flags = uint128(0x80) << 120;

        if (largerRoot) {
            flags |= uint128(0x20) << 120;
        }

        return abi.encodePacked(
            bytes16(xHi | flags),
            bytes32(xLo)
        );
    }

    function _assertPairingCase(
        bytes memory signature,
        uint128 yHi,
        uint256 yLo,
        bool expectedCallSuccess,
        bool expectedVerified
    )
        internal
    {
        bytes memory input = verifier.pairingInputForWitness(
            KAT_ROUND,
            signature,
            yHi,
            yLo
        );

        assertEq(input.length, 768);

        // One raw call and one production call must use identical input.
        vm.expectCall(PAIRING_PRECOMPILE, input, uint64(2));

        (
            bool callSuccess,
            bytes memory returndata
        ) = verifier.rawPairing(input);

        assertEq(callSuccess, expectedCallSuccess);

        if (callSuccess) {
            assertEq(returndata.length, 32);

            uint256 result = abi.decode(returndata, (uint256));

            assertLe(result, 1);
            assertEq(result == 1, expectedVerified);
        }

        // Failed raw calls are deliberately not decoded.
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeaconWithWitness(
            KAT_ROUND,
            signature,
            yHi,
            yLo
        );

        assertEq(verified, expectedVerified);

        if (expectedVerified) {
            assertEq(randomness, KAT_RANDOMNESS);
        } else {
            assertEq(randomness, bytes32(0));
        }
    }

    function _assertDecompressedAndRejected(
        bytes memory signature,
        uint256 expectedXLo,
        uint128 expectedYHi,
        uint256 expectedYLo
    )
        internal
        view
    {
        (
            uint128 xHi,
            uint256 xLo,
            uint128 yHi,
            uint256 yLo
        ) = verifier.decompressG1(signature);

        assertEq(xHi, 0);
        assertEq(xLo, expectedXLo);
        assertEq(yHi, expectedYHi);
        assertEq(yLo, expectedYLo);

        _assertRejected(signature);
    }

    function _boundedY(
        uint128 rawYHi,
        uint256 rawYLo
    )
        internal
        pure
        returns (
            uint128 yHi,
            uint256 yLo
        )
    {
        yHi = uint128(bound(uint256(rawYHi), 0, uint256(P_HI)));
        yLo = rawYLo;

        if (yHi == P_HI) {
            yLo = bound(rawYLo, 0, P_LO - 1);
        }
    }

    function _assertNegation(
        uint128 yHi,
        uint256 yLo
    )
        internal
        view
    {
        (
            uint128 oppositeYHi,
            uint256 oppositeYLo
        ) = verifier.negateY(yHi, yLo);

        // Verify subtraction through independent addition with carry.
        uint256 sumLo;

        unchecked {
            sumLo = yLo + oppositeYLo;
        }

        uint256 sumHi = uint256(yHi) + uint256(oppositeYHi);

        if (sumLo < yLo) {
            ++sumHi;
        }

        assertEq(sumHi, uint256(P_HI));
        assertEq(sumLo, P_LO);
    }

    function _callWitnessWithGas(
        uint256 gasLimit,
        bytes memory signature,
        uint128 yHi,
        uint256 yLo
    )
        internal
        view
        returns (
            bool success,
            bytes memory returndata
        )
    {
        bytes memory callData = abi.encodeCall(
            DrandQuicknetBeaconVerifier.verifyBeaconWithWitness,
            (KAT_ROUND, signature, yHi, yLo)
        );

        return address(verifier).staticcall{
            gas: gasLimit
        }(callData);
    }

    function _witnessCompletesWithGas(
        uint256 gasLimit,
        bytes memory signature,
        uint128 yHi,
        uint256 yLo,
        bool expectedVerified
    )
        internal
        view
        returns (bool)
    {
        (
            bool success,
            bytes memory returndata
        ) = _callWitnessWithGas(
            gasLimit,
            signature,
            yHi,
            yLo
        );

        if (!success || returndata.length != 64) {
            return false;
        }

        (
            bool verified,
            bytes32 randomness
        ) = abi.decode(returndata, (bool, bytes32));

        if (verified != expectedVerified) {
            return false;
        }

        if (verified) {
            return randomness == KAT_RANDOMNESS;
        }

        return randomness == bytes32(0);
    }

    function _assertWitnessGasBoundary(
        bool validCandidate
    )
        internal
        view
    {
        bytes memory signature = _katSignature();
        uint128 yHi = KAT_Y_HI;
        uint256 yLo = KAT_Y_LO;

        if (!validCandidate) {
            signature = _offSubgroupPointEncoding();
            yHi = 0;
            yLo = 2;
        }

        uint256 low = 0;
        uint256 high = AMPLE_VERIFY_GAS;

        assertTrue(
            _witnessCompletesWithGas(
                high,
                signature,
                yHi,
                yLo,
                validCandidate
            )
        );

        while (low + 1 < high) {
            uint256 middle = low + (high - low) / 2;

            if (
                _witnessCompletesWithGas(
                    middle,
                    signature,
                    yHi,
                    yLo,
                    validCandidate
                )
            ) {
                high = middle;
            } else {
                low = middle;
            }
        }

        (
            bool success,
            bytes memory returndata
        ) = _callWitnessWithGas(
            high - 1,
            signature,
            yHi,
            yLo
        );

        assertFalse(success);
        assertEq(returndata.length, 4);

        assertEq(
            _revertSelector(returndata),
            DrandQuicknetBeaconVerifier.InsufficientVerifierGas.selector
        );

        assertTrue(
            _witnessCompletesWithGas(
                high,
                signature,
                yHi,
                yLo,
                validCandidate
            )
        );
    }
}