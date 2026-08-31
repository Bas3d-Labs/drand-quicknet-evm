// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    IQuicknetBeaconVerifier
} from "../../src/interfaces/IQuicknetBeaconVerifier.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../../src/DrandQuicknetBeaconRegistry.sol";

import {
    MockQuicknetBeaconVerifier
} from "../mocks/MockQuicknetBeaconVerifier.sol";

/// @dev Shared deterministic setup for registry unit tests.
abstract contract RegistryTestBase is Test {
    uint64 internal constant TEST_MINIMUM_LEAD_ROUNDS = 5;

    address internal verifierAddress;
    bytes32 internal expectedVerifierCodehash;

    IQuicknetBeaconVerifier internal verifier;
    DrandQuicknetBeaconRegistry internal registry;

    address internal submitter =
        makeAddr("submitter");

    address internal otherSubmitter =
        makeAddr("otherSubmitter");

    event BeaconStored(
        uint64 indexed round,
        bytes32 randomness,
        address indexed submitter
    );

    error MockVerifierFailure();

    function setUp()
        public
        virtual
    {
        MockQuicknetBeaconVerifier mockVerifier =
            new MockQuicknetBeaconVerifier();

        verifierAddress = address(mockVerifier);
        expectedVerifierCodehash = verifierAddress.codehash;

        verifier = IQuicknetBeaconVerifier(verifierAddress);

        registry = new DrandQuicknetBeaconRegistry(
            verifierAddress,
            expectedVerifierCodehash,
            TEST_MINIMUM_LEAD_ROUNDS
        );
    }

    function _mockVerify(
        uint64 round,
        bytes memory signature,
        bool verified,
        bytes32 randomness
    )
        internal
    {
        vm.mockCall(
            verifierAddress,
            abi.encodeWithSelector(
                IQuicknetBeaconVerifier
                    .verifyBeacon
                    .selector,
                round,
                signature
            ),
            abi.encode(
                verified,
                randomness
            )
        );
    }

    function _mockVerifyRevert(
        uint64 round,
        bytes memory signature
    )
        internal
    {
        vm.mockCallRevert(
            verifierAddress,
            abi.encodeWithSelector(
                IQuicknetBeaconVerifier
                    .verifyBeacon
                    .selector,
                round,
                signature
            ),
            abi.encodeWithSelector(
                MockVerifierFailure.selector
            )
        );
    }
}