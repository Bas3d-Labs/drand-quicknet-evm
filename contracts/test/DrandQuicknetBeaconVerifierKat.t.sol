// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {
    DrandQuicknetBeaconVerifierHarness
} from "./harnesses/DrandQuicknetBeaconVerifierHarness.sol";

/// @notice Offline, externally sourced Quicknet regression corpus.
/// @dev Provenance and independent verification instructions are in
///      scripts/quicknet-kat/README.md. No RPC, FFI, or network is used here.
contract DrandQuicknetBeaconVerifierKatTest is Test {
    DrandQuicknetBeaconVerifierHarness internal verifier;
    string internal corpus;

    function setUp() 
        public
    {
        verifier = new DrandQuicknetBeaconVerifierHarness();
        corpus = vm.readFile(
            string.concat(
                vm.projectRoot(),
                "/test/fixtures/quicknet-kat.json"
            )
        );

        assertEq(vm.parseJsonUint(corpus, ".schemaVersion"), 1);
        assertEq(vm.parseJsonString(corpus, ".quicknet.dst"), verifier.DST());
    }

    function test_kat_acceptsPublishedCanonicalRounds()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;
        assertEq(count, 12, "positive corpus must not silently shrink");

        for (uint256 i; i < count; ++i) {
            string memory key = _key("positive", i);
            uint64 round = _round(key);
            
            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            bytes32 expected = vm.parseJsonBytes32(
                corpus,
                string.concat(key, ".randomness")
            );

            assertTrue(verifier.isCanonical(signature), key);

            (
                bool verified,
                bytes32 randomness
            ) = verifier.verifyBeacon(round, signature);

            assertTrue(verified, key);

            // The published answer is fixed in the fixture, never derived
            // from this verifier as part of the test.
            assertEq(randomness, expected, key);
            assertEq(sha256(signature), expected, key);
        }
    }

    function test_kat_rejectsFixedAdversarialVectors()
        public
        view 
    {
        uint256 count = vm.parseJsonKeys(corpus, ".negative").length;
        assertEq(count, 31, "negative corpus must not silently shrink");

        for (uint256 i; i < count; ++i) {
            string memory key = _key("negative", i);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            bool canonical = vm.parseJsonBool(
                corpus,
                string.concat(key, ".canonical")
            );

            assertEq(verifier.isCanonical(signature), canonical, key);
            _assertRejected(_round(key), signature, key);
        }
    }

    function test_kat_decompressesToIndependentCoordinates()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;

        for (uint256 i; i < count; ++i) {
            string memory key = _key("positive", i);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            bytes memory expected = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".uncompressed")
            );

            (
                uint128 xHi,
                uint256 xLo,
                uint128 yHi,
                uint256 yLo
            ) = verifier.decompressG1(signature);

            assertEq(
                abi.encodePacked(
                    bytes16(xHi), bytes32(xLo), bytes16(yHi), bytes32(yLo)
                ),
                expected,
                key
            );
        }
    }

    function test_kat_bindsEverySignatureToAllRoundBytes()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;

        for (uint256 i; i < count; ++i) {
            string memory key = _key("positive", i);
            uint64 round = _round(key);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            // Change each of the eight serialized round bytes. The high
            // offsets also catch truncation to 32, 40, 48, or 56 bits.
            for (uint256 byteIndex; byteIndex < 8; ++byteIndex) {
                uint64 offset = uint64(uint256(1) << (8 * byteIndex));
                _assertRejected(round + offset, signature, key);
            }
        }
    }

    function test_kat_rejectsSignFlipForEveryRound()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;

        for (uint256 i; i < count; ++i) {
            string memory key = _key("positive", i);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );
            signature[0] = bytes1(uint8(signature[0]) ^ 0x20);

            assertTrue(verifier.isCanonical(signature), key);
            _assertRejected(_round(key), signature, key);
        }
    }

    function test_kat_constructorVectorMatchesPublishedCorpus()
        public
        view
    {
        (
            uint64 round,
            bytes memory signature,
            bytes32 randomness
        ) = verifier.selfTestVector();

        uint256 count =
            vm.parseJsonKeys(corpus, ".positive").length;

        uint256 matches = 0;

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("positive", i);

            if (_round(key) != round) {
                continue;
            }

            ++matches;

            assertEq(
                signature,
                vm.parseJsonBytes(
                    corpus,
                    string.concat(key, ".signature")
                ),
                "constructor signature differs from corpus"
            );

            assertEq(
                randomness,
                vm.parseJsonBytes32(
                    corpus,
                    string.concat(key, ".randomness")
                ),
                "constructor randomness differs from corpus"
            );

            (
                uint128 constructorYHi,
                uint256 constructorYLo
            ) = verifier.selfTestWitness();

            (
                uint128 expectedYHi,
                uint256 expectedYLo
            ) = _corpusWitness(key);

            assertEq(
                constructorYHi,
                expectedYHi,
                "constructor witness high limb differs from corpus"
            );

            assertEq(
                constructorYLo,
                expectedYLo,
                "constructor witness low limb differs from corpus"
            );
        }

        assertEq(
            matches,
            1,
            "constructor round must occur exactly once in corpus"
        );
    }

    function test_kat_witnessMatchesCompressedAndPublishedAnswers()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;
        assertEq(count, 12, "positive corpus must not silently shrink");

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("positive", i);
            uint64 round = _round(key);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            bytes32 expected = vm.parseJsonBytes32(
                corpus,
                string.concat(key, ".randomness")
            );

            (
                uint128 yHi,
                uint256 yLo
            ) = _corpusWitness(key);

            (
                bool compressedVerified,
                bytes32 compressedRandomness
            ) = verifier.verifyBeacon(round, signature);

            (
                bool witnessVerified,
                bytes32 witnessRandomness
            ) = verifier.verifyBeaconWithWitness(
                round,
                signature,
                yHi,
                yLo
            );

            assertTrue(compressedVerified, key);
            assertTrue(witnessVerified, key);
            assertEq(compressedRandomness, expected, key);
            assertEq(witnessRandomness, expected, key);
            assertEq(witnessRandomness, compressedRandomness, key);
        }
    }

    function test_kat_witnessBindsEverySignatureToAllRoundBytes()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("positive", i);
            uint64 round = _round(key);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            (
                uint128 yHi,
                uint256 yLo
            ) = _corpusWitness(key);

            for (uint256 byteIndex = 0; byteIndex < 8; ++byteIndex) {
                uint64 mask = uint64(uint256(1) << (8 * byteIndex));

                _assertWitnessRejected(
                    round ^ mask,
                    signature,
                    yHi,
                    yLo,
                    key
                );
            }
        }
    }

    function test_kat_witnessSignMismatchesRejectBeforePairing()
        public
    {
        vm.expectCall(address(0x0f), bytes(""), uint64(0));

        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("positive", i);
            uint64 round = _round(key);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            (
                uint128 yHi,
                uint256 yLo
            ) = _corpusWitness(key);

            (
                uint128 oppositeYHi,
                uint256 oppositeYLo
            ) = verifier.negateY(yHi, yLo);

            // Original signature, opposite root.
            _assertWitnessRejected(
                round,
                signature,
                oppositeYHi,
                oppositeYLo,
                key
            );

            // Flipped signature, original root.
            signature[0] = bytes1(uint8(signature[0]) ^ 0x20);

            _assertWitnessRejected(
                round,
                signature,
                yHi,
                yLo,
                key
            );
        }
    }

    function test_kat_witnessConsistentSignFlipsReachPairing()
        public
    {
        uint256 count = vm.parseJsonKeys(corpus, ".positive").length;
        assertEq(count, 12, "positive corpus must not silently shrink");

        vm.expectCall(address(0x0f), bytes(""), uint64(12));

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("positive", i);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            (
                uint128 yHi,
                uint256 yLo
            ) = _corpusWitness(key);

            (
                uint128 oppositeYHi,
                uint256 oppositeYLo
            ) = verifier.negateY(yHi, yLo);

            signature[0] = bytes1(uint8(signature[0]) ^ 0x20);

            _assertWitnessRejected(
                _round(key),
                signature,
                oppositeYHi,
                oppositeYLo,
                key
            );
        }
    }

    function test_kat_witnessRejectsFixedAdversarialVectors()
        public
        view
    {
        uint256 count = vm.parseJsonKeys(corpus, ".negative").length;
        assertEq(count, 31, "negative corpus must not silently shrink");

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("negative", i);

            bytes memory signature = vm.parseJsonBytes(
                corpus,
                string.concat(key, ".signature")
            );

            bool canonical = vm.parseJsonBool(
                corpus,
                string.concat(key, ".canonical")
            );

            assertEq(verifier.isCanonical(signature), canonical, key);

            uint128 yHi = 0;
            uint256 yLo = 0;

            if (canonical) {
                // These negative fixtures need not encode valid points.
                // Use the legacy decompressor to supply a candidate y.
                // Independent coordinates are used for all positive KATs.
                (
                    ,
                    ,
                    yHi,
                    yLo
                ) = verifier.decompressG1(signature);
            }

            _assertWitnessRejected(
                _round(key),
                signature,
                yHi,
                yLo,
                key
            );
        }
    }

    function test_kat_witnessNoncanonicalCorpusRejectsBeforePairing()
        public
    {
        vm.expectCall(address(0x0f), bytes(""), uint64(0));

        uint256 count = vm.parseJsonKeys(corpus, ".negative").length;
        uint256 checked = 0;

        for (uint256 i = 0; i < count; ++i) {
            string memory key = _key("negative", i);

            if (
                vm.parseJsonBool(
                    corpus,
                    string.concat(key, ".canonical")
                )
            ) {
                continue;
            }

            ++checked;

            _assertWitnessRejected(
                _round(key),
                vm.parseJsonBytes(
                    corpus,
                    string.concat(key, ".signature")
                ),
                0,
                0,
                key
            );
        }

        assertGt(checked, 0, "noncanonical corpus coverage missing");
    }

    function _key(
        string memory group,
        uint256 index
    )
        internal
        pure
        returns (string memory)
    {
        return string.concat(".", group, ".v", vm.toString(index));
    }

    function _round(string memory key)
        internal
        view
        returns (uint64)
    {
        uint256 round = vm.parseUint(
            vm.parseJsonString(corpus, string.concat(key, ".round"))
        );

        assertLe(round, type(uint64).max, key);

        return uint64(round);
    }

    /// @dev Reads y from the independently generated 96-byte x || y
    ///      fixture. Does not invoke the Solidity decompressor.
    function _corpusWitness(
        string memory key
    )
        internal
        view
        returns (
            uint128 yHi,
            uint256 yLo
        )
    {
        bytes memory uncompressed = vm.parseJsonBytes(
            corpus,
            string.concat(key, ".uncompressed")
        );

        assertEq(uncompressed.length, 96, key);

        assembly {
            yHi := shr(128, mload(add(uncompressed, 0x50)))
            yLo := mload(add(uncompressed, 0x60))
        }
    }

    function _assertRejected(
        uint64 round,
        bytes memory signature,
        string memory context
    )
        internal
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeacon(round, signature);

        assertFalse(verified, context);
        assertEq(randomness, bytes32(0), context);
    }

    function _assertWitnessRejected(
        uint64 round,
        bytes memory signature,
        uint128 yHi,
        uint256 yLo,
        string memory context
    )
        internal
        view
    {
        (
            bool verified,
            bytes32 randomness
        ) = verifier.verifyBeaconWithWitness(
            round,
            signature,
            yHi,
            yLo
        );

        assertFalse(verified, context);
        assertEq(randomness, bytes32(0), context);
    }
}
