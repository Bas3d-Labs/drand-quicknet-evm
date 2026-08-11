// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {
    QuicknetTestConsumer
} from "../test/mocks/QuicknetTestConsumer.sol";

contract DeployQuicknetTestConsumer is Script {
    function run()
        external
        returns (QuicknetTestConsumer consumer)
    {
        address registry = vm.envAddress("QUICKNET_REGISTRY_ADDRESS");

        vm.startBroadcast();

        consumer = new QuicknetTestConsumer(registry);

        vm.stopBroadcast();
    }
}