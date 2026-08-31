// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../src/verifiers/DrandQuicknetBeaconVerifier.sol";

contract DeployVerifier is Script {
    function run()
        external
        returns (DrandQuicknetBeaconVerifier verifier)
    {
        vm.startBroadcast();

        verifier = new DrandQuicknetBeaconVerifier();

        vm.stopBroadcast();
    }
}