// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    IDrandQuicknetBeaconVerifier
} from "../../src/interfaces/IDrandQuicknetBeaconVerifier.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../../src/DrandQuicknetBeaconRegistry.sol";

import {
    MockDrandQuicknetBeaconVerifier
} from "../mocks/MockDrandQuicknetBeaconVerifier.sol";

/// @dev Shared deterministic setup for registry unit tests.
abstract contract RegistryTestBase is Test {
    uint64 internal constant TEST_MINIMUM_LEAD_ROUNDS = 5;

    address internal verifierAddress;
    bytes32 internal expectedVerifierCodehash;

    IDrandQuicknetBeaconVerifier internal verifier;
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
        MockDrandQuicknetBeaconVerifier mockVerifier =
            new MockDrandQuicknetBeaconVerifier();

        verifierAddress = address(mockVerifier);
        expectedVerifierCodehash = verifierAddress.codehash;

        verifier = IDrandQuicknetBeaconVerifier(verifierAddress);

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
                IDrandQuicknetBeaconVerifier
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
                IDrandQuicknetBeaconVerifier
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