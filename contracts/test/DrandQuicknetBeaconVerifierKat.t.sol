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
        }

        assertEq(
            matches,
            1,
            "constructor round must occur exactly once in corpus"
        );
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
}
