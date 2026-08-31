// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";

import {
    QuicknetBeaconVerifier
} from "../src/verifiers/QuicknetBeaconVerifier.sol";

contract DeployVerifier is Script {
    function run()
        external
        returns (QuicknetBeaconVerifier verifier)
    {
        vm.startBroadcast();

        verifier = new QuicknetBeaconVerifier();

        vm.stopBroadcast();
    }
}