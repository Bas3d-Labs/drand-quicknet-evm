// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

contract DeployRegistry is Script {
    using stdJson for string;

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

        vm.startBroadcast();

        registry = new DrandQuicknetBeaconRegistry(
            verifier,
            expectedVerifierCodehash,
            minimumLeadRounds
        );

        vm.stopBroadcast();
    }
}
