// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {
    IDrandQuicknetBeaconVerifier
} from "../src/interfaces/IDrandQuicknetBeaconVerifier.sol";

contract DeployRegistry is Script {
    using stdJson for string;

    uint64 internal constant KAT_ROUND = 1000;

    bytes32 internal constant KAT_RANDOMNESS =
        0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

    uint128 internal constant KAT_Y_HI =
        0x11f92e4521ef54f047b64b85fa98db2d;

    uint256 internal constant KAT_Y_LO =
        0x46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2;

    uint128 internal constant KAT_OPPOSITE_Y_HI =
        0x0807e3a5179091aa03655c3048b2d1aa;

    uint256 internal constant KAT_OPPOSITE_Y_LO =
        0x1d86573a1665b20627a6c4e3194d42d4fb25a83bd81912e700f32229f5fdf3d9;

    function run()
        external
        returns (DrandQuicknetBeaconRegistry registry)
    {
        string memory deploymentFile = vm.envString("DEPLOYMENT_FILE");

        string memory path = string.concat(
            vm.projectRoot(),
            "/../deployments/",
            deploymentFile
        );

        string memory json = vm.readFile(path);

        uint256 expectedChainId = json.readUint(".chainId");

        address verifier = json.readAddress(".verifier.address");

        bytes32 expectedVerifierCodehash =
            json.readBytes32(".verifier.runtimeCodehash");

        uint256 minimumLeadRoundsValue =
            vm.envUint("MINIMUM_LEAD_ROUNDS");

        require(
            block.chainid == expectedChainId,
            "Wrong chain"
        );

        require(
            verifier.codehash == expectedVerifierCodehash,
            "Verifier codehash mismatch"
        );

        require(
            minimumLeadRoundsValue != 0,
            "Minimum lead rounds is zero"
        );

        require(
            minimumLeadRoundsValue <= type(uint64).max,
            "Minimum lead rounds too large"
        );

        uint64 minimumLeadRounds = uint64(minimumLeadRoundsValue);

        bytes memory signature = _katSignature();

        (
            bool verified,
            bytes32 randomness
        ) = IDrandQuicknetBeaconVerifier(verifier).verifyBeacon(
            KAT_ROUND,
            signature
        );

        require(
            verified && randomness == KAT_RANDOMNESS,
            "Verifier KAT failed"
        );

        (
            verified,
            randomness
        ) = IDrandQuicknetBeaconVerifier(
            verifier
        ).verifyBeaconWithWitness(
            KAT_ROUND,
            signature,
            KAT_Y_HI,
            KAT_Y_LO
        );

        require(
            verified && randomness == KAT_RANDOMNESS,
            "Verifier witness KAT failed"
        );

        signature[0] =
            bytes1(uint8(signature[0]) ^ 0x20);

        (
            bool negativeVerified,
            bytes32 negativeRandomness
        ) = IDrandQuicknetBeaconVerifier(verifier).verifyBeacon(
            KAT_ROUND,
            signature
        );

        require(
            !negativeVerified && negativeRandomness == bytes32(0),
            "Verifier negative KAT failed"
        );

        // The flipped signature and opposite root agree on encoding.
        // Rejection must therefore go beyond the witness sign check.
        (
            negativeVerified,
            negativeRandomness
        ) = IDrandQuicknetBeaconVerifier(
            verifier
        ).verifyBeaconWithWitness(
            KAT_ROUND,
            signature,
            KAT_OPPOSITE_Y_HI,
            KAT_OPPOSITE_Y_LO
        );

        require(
            !negativeVerified && negativeRandomness == bytes32(0),
            "Verifier witness negative KAT failed"
        );

        vm.startBroadcast();

        registry = new DrandQuicknetBeaconRegistry(
            verifier,
            expectedVerifierCodehash,
            minimumLeadRounds
        );

        vm.stopBroadcast();
    }

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
}
