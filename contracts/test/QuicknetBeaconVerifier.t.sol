// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    QuicknetBeaconVerifierHarness
} from "./mocks/QuicknetBeaconVerifierHarness.sol";

contract QuicknetBeaconVerifierTest is Test {
    uint64 internal constant KAT_ROUND = 1000;

    bytes32 internal constant KAT_RANDOMNESS =
        0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

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

    function _assertRejected(
        bytes memory signature
    )
        internal
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(
            KAT_ROUND,
            signature
        );

        assertFalse(verified);
        assertEq(randomness, bytes32(0));
    }
}