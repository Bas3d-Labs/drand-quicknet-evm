// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {
    IQuicknetBeaconVerifier
} from "../src/interfaces/IQuicknetBeaconVerifier.sol";

contract DeployRegistry is Script {
    using stdJson for string;

    uint64 internal constant KAT_ROUND = 1000;

    bytes32 internal constant KAT_RANDOMNESS =
        0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

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
            json.readUint(".registry.minimumLeadRounds");

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
        ) = IQuicknetBeaconVerifier(verifier).verifyBeacon(
            KAT_ROUND,
            signature
        );

        require(
            verified && randomness == KAT_RANDOMNESS,
            "Verifier KAT failed"
        );

        signature[0] =
            bytes1(uint8(signature[0]) ^ 0x20);

        (
            bool negativeVerified,
            bytes32 negativeRandomness
        ) = IQuicknetBeaconVerifier(verifier).verifyBeacon(
            KAT_ROUND,
            signature
        );

        require(
            !negativeVerified && negativeRandomness == bytes32(0),
            "Verifier negative KAT failed"
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
