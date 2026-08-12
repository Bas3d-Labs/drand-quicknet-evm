// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

contract DeployRegistry is Script {
    using stdJson for string;

    function run() external returns (DrandQuicknetBeaconRegistry registry) {
        string memory deploymentFile = vm.envString("DEPLOYMENT_FILE");
        string memory path = string.concat(
            vm.projectRoot(), 
            "/../deployments/", 
            deploymentFile
        );
        string memory json = vm.readFile(path);

        uint256 expectedChainId = json.readUint(".chainId");
        address oracle = json.readAddress(".oracle.address");
        bytes32 expectedOracleCodehash = json.readBytes32(".oracle.runtimeCodehash");

        require(block.chainid == expectedChainId, "Wrong chain");
        require(oracle.codehash == expectedOracleCodehash);

        vm.startBroadcast();

        registry = new DrandQuicknetBeaconRegistry(
            oracle,
            expectedOracleCodehash
        );

        vm.stopBroadcast();
    }
}
