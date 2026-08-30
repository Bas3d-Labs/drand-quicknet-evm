// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    DrandQuicknetBeaconRegistry
} from "../../src/DrandQuicknetBeaconRegistry.sol";

import {RegistryIntegrationTestBase} from "./RegistryIntegrationTestBase.sol";

contract DrandQuicknetBeaconRegistryIntegrationTest is RegistryIntegrationTestBase {
    uint64 internal constant ROUND_1 = 20_791_007;
    uint64 internal constant ROUND_2 = 20_905_307;
    uint64 internal constant LIVE_ROUND = 31_089_008;

    bytes32 internal constant LIVE_NORMALIZED_HASH =
        0x9b81abb093df33375d039627e697083932b2d07ea75f7add4aa3389a13370b17;

    function test_RealOracleAcceptsCompressedSignature() public {
        bytes memory signature = _sig1Compressed();

        (bool verified, bytes32 normalized,) =
            oracle.verifyNormalized(ROUND_1, signature);

        assertTrue(verified);
        assertNotEq(normalized, bytes32(0));

        bytes32 stored = registry.submitBeacon(ROUND_1, signature);

        assertEq(stored, normalized);

        assertEq(registry.getBeacon(ROUND_1), normalized);
    }

    function test_RealOracleAcceptsUncompressedSignature() public {
        bytes memory signature = _sig1Uncompressed();

        (bool verified, bytes32 normalized,) =
            oracle.verifyNormalized(ROUND_1, signature);

        assertTrue(verified);
        assertNotEq(normalized, bytes32(0));

        bytes32 stored = registry.submitBeacon(ROUND_1, signature);

        assertEq(stored, normalized);
    }

    function test_CompressedAndUncompressedNormalizeIdentically() public {
        bytes memory compressed = _sig1Compressed();

        bytes memory uncompressed = _sig1Uncompressed();

        (bool compressedVerified, bytes32 compressedHash,) =
            oracle.verifyNormalized(ROUND_1, compressed);

        (bool uncompressedVerified, bytes32 uncompressedHash,) =
            oracle.verifyNormalized(ROUND_1, uncompressed);

        assertTrue(compressedVerified);
        assertTrue(uncompressedVerified);

        assertEq(compressedHash, uncompressedHash);

        DrandQuicknetBeaconRegistry compressedRegistry =
            new DrandQuicknetBeaconRegistry(
                oracleAddress,
                expectedOracleCodehash
            );

        DrandQuicknetBeaconRegistry uncompressedRegistry =
            new DrandQuicknetBeaconRegistry(
                oracleAddress,
                expectedOracleCodehash
            );

        bytes32 fromCompressed =
            compressedRegistry.submitBeacon(ROUND_1, compressed);

        bytes32 fromUncompressed =
            uncompressedRegistry.submitBeacon(ROUND_1, uncompressed);

        assertEq(fromCompressed, fromUncompressed);

        assertEq(fromCompressed, compressedHash);
    }

    function test_LiveKnownVectorMatchesExpectedHash() public {
        bytes memory signature = _liveCompressedSignature();

        (bool verified, bytes32 normalized,) =
            oracle.verifyNormalized(LIVE_ROUND, signature);

        assertTrue(verified);

        assertEq(normalized, LIVE_NORMALIZED_HASH);

        bytes32 stored = registry.submitBeacon(LIVE_ROUND, signature);

        assertEq(stored, LIVE_NORMALIZED_HASH);

        assertEq(registry.getBeacon(LIVE_ROUND), LIVE_NORMALIZED_HASH);
    }

    function test_SecondKnownVectorVerifies() public {
        bytes memory signature = _sig2Uncompressed();

        (bool verified, bytes32 normalized,) =
            oracle.verifyNormalized(ROUND_2, signature);

        assertTrue(verified);
        assertNotEq(normalized, bytes32(0));

        assertEq(registry.submitBeacon(ROUND_2, signature), normalized);
    }

    function test_SignatureForDifferentRoundRejected() public {
        bytes memory signature = _sig1Compressed();

        uint64 wrongRound = ROUND_1 + 1;

        (bool verified,,) = oracle.verifyNormalized(wrongRound, signature);

        assertFalse(verified);

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidBeacon.selector);

        registry.submitBeacon(wrongRound, signature);

        assertFalse(registry.isStored(wrongRound));
    }

    function test_MalformedSignatureCannotStoreBeacon() public {
        uint64 round = ROUND_1;

        (bool success,) = address(registry)
            .call(
                abi.encodeWithSelector(
                    DrandQuicknetBeaconRegistry.submitBeacon.selector,
                    round,
                    hex"01"
                )
            );

        // The exact revert may originate from the verifier's
        // signature decoding rather than the registry itself.
        assertFalse(success);

        assertFalse(registry.isStored(round));
    }

    // A corrupted compressed G1 point may reach the EIP-2537
    // pairing precompile and trigger a PrecompileError. Such an
    // error can consume all gas forwarded to the precompile.
    function test_BitFlippedSignatureCannotStoreBeacon() public {
        bytes memory signature = _sig1Compressed();

        signature[20] = bytes1(uint8(signature[20]) ^ 0x01);

        (bool success,) = address(registry).call{gas: 1_000_000}(
            abi.encodeWithSelector(
                DrandQuicknetBeaconRegistry.submitBeacon.selector,
                ROUND_1,
                signature
            )
        );

        assertFalse(success);

        assertFalse(registry.isStored(ROUND_1));
    }
}
