// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    QuicknetBeaconVerifier
} from "../src/verifiers/QuicknetBeaconVerifier.sol";

import {
    QuicknetBeaconVerifierHarness
} from "./mocks/QuicknetBeaconVerifierHarness.sol";

contract QuicknetBeaconVerifierTest is Test {
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

    QuicknetBeaconVerifierHarness internal verifier;

    function setUp() public {
        verifier =
            new QuicknetBeaconVerifierHarness();
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
    // - Constructor KAT.
    // - Post-deployment live KAT.
    // - Recurring operational canary.
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

    function test_isCanonical_rejectsInvalidLengths()
        public
        view
    {
        assertFalse(verifier.isCanonical(new bytes(0)));
        assertFalse(verifier.isCanonical(new bytes(47)));
        assertFalse(verifier.isCanonical(new bytes(49)));
        assertFalse(verifier.isCanonical(new bytes(95)));
        assertFalse(verifier.isCanonical(new bytes(96)));
        assertFalse(verifier.isCanonical(new bytes(97)));
    }

    function test_verifyBeacon_rejectsNonCanonicalLengths()
        public
        view
    {
        _assertRejected(new bytes(0));
        _assertRejected(new bytes(47));
        _assertRejected(new bytes(49));
        _assertRejected(new bytes(95));
        _assertRejected(new bytes(96));
        _assertRejected(new bytes(97));
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

    function test_verifyBeacon_guardPrecedesCurrentKatSuccessBand()
        public
        view
    {
        uint256 minimumSuccessfulGas =
            _minimumSuccessfulKatGas();

        assertGt(minimumSuccessfulGas, 0);

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
            QuicknetBeaconVerifier
                .InsufficientVerifierGas
                .selector
        );
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
            QuicknetBeaconVerifier
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
                QuicknetBeaconVerifier
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
}