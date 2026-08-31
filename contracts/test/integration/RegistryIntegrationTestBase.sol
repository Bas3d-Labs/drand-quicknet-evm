// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    stdJson
} from "forge-std/StdJson.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../../src/DrandQuicknetBeaconRegistry.sol";

import {
    IQuicknetBeaconVerifier
} from "../../src/interfaces/IQuicknetBeaconVerifier.sol";

abstract contract RegistryIntegrationTestBase is Test {
    using stdJson for string;

    uint64 internal constant TEST_MINIMUM_LEAD_ROUNDS = 5;

    string internal deploymentJson;

    address internal verifierAddress;
    bytes32 internal expectedVerifierCodehash;

    IQuicknetBeaconVerifier internal verifier;
    DrandQuicknetBeaconRegistry internal registry;

    function setUp() public virtual {
        string memory path =
            string.concat(
                vm.projectRoot(),
                "/../deployments/robinhood-testnet.json"
            );

        deploymentJson =
            vm.readFile(path);

        uint256 expectedChainId =
            deploymentJson.readUint(
                ".chainId"
            );

        verifierAddress =
            deploymentJson.readAddress(
                ".verifier.address"
            );

        expectedVerifierCodehash =
            deploymentJson.readBytes32(
                ".verifier.runtimeCodehash"
            );

        string memory rpcUrl =
            vm.envString(
                "ROBINHOOD_TESTNET_RPC_URL"
            );

        vm.createSelectFork(
            rpcUrl
        );

        assertEq(
            block.chainid,
            expectedChainId,
            "unexpected fork chain ID"
        );

        assertEq(
            verifierAddress.codehash,
            expectedVerifierCodehash,
            "verifier runtime codehash mismatch"
        );

        verifier =
            IQuicknetBeaconVerifier(
                verifierAddress
            );

        registry =
            new DrandQuicknetBeaconRegistry(
                verifierAddress,
                expectedVerifierCodehash,
                TEST_MINIMUM_LEAD_ROUNDS
            );
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

    function _liveSignature()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"87b3b9c9f99cc1e7fc326e249538f33b"
            hex"84a1c4ef8bd85920a267af642b570bcd"
            hex"62bf70900a3862f742e574164b5f17f3";
    }

    function _secondKnownSignature()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"a38ab268d58c04ce2d22b8317e4b66ec"
            hex"da5fa8841c7215bf7733af8dbaed6c5e"
            hex"7d8d60b77817294a64b891f719bc1b40";
    }
}