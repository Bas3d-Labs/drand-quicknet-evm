// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {
    DrandQuicknetTestConsumer
} from "../test/mocks/DrandQuicknetTestConsumer.sol";

contract DeployDrandQuicknetTestConsumer is Script {
    function run()
        external
        returns (DrandQuicknetTestConsumer consumer)
    {
        address registry = vm.envAddress("QUICKNET_REGISTRY_ADDRESS");

        vm.startBroadcast();

        consumer = new DrandQuicknetTestConsumer(registry);

        vm.stopBroadcast();
    }
}