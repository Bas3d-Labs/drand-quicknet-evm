// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {
    DrandQuicknetRandomnessConsumer
} from "../src/consumers/DrandQuicknetRandomnessConsumer.sol";

import {
    MockDrandQuicknetBeaconVerifier
} from "./mocks/MockDrandQuicknetBeaconVerifier.sol";

import {
    QuicknetLeadThreeMeasurementConsumer
} from "./mocks/QuicknetLeadThreeMeasurementConsumer.sol";

contract QuicknetLeadThreeMeasurementConsumerTest is Test {
    DrandQuicknetBeaconRegistry internal registry;
    QuicknetLeadThreeMeasurementConsumer internal consumer;

    event QuicknetRandomnessRequested(uint64 indexed round);

    function setUp()
        public
    {
        MockDrandQuicknetBeaconVerifier verifier =
            new MockDrandQuicknetBeaconVerifier();

        registry = new DrandQuicknetBeaconRegistry(
            address(verifier),
            address(verifier).codehash,
            3
        );

        consumer = new QuicknetLeadThreeMeasurementConsumer(
            address(registry),
            address(registry).codehash,
            address(this)
        );

        vm.warp(registry.GENESIS_TIMESTAMP() + 300);
    }

    function test_configurationIsFixed()
        public
        view
    {
        assertEq(consumer.requester(), address(this));

        assertEq(consumer.quicknetBeaconRegistry(), address(registry));

        assertEq(
            consumer.quicknetBeaconRegistryCodehash(),
            address(registry).codehash
        );

        assertEq(consumer.quicknetLeadRounds(), 3);
    }

    function test_roundLeadAtEverySecondOfPeriod()
        public
    {
        uint256 boundary = block.timestamp;

        for (uint256 offset = 0; offset < 3; offset++) {
            vm.warp(boundary + offset);

            uint64 expected = registry.latestScheduledRound() + 3;

            vm.expectEmit(true, false, false, true, address(consumer));
            emit QuicknetRandomnessRequested(expected);

            uint64 round = consumer.request(offset);

            assertEq(round, expected);

            assertEq(consumer.requestRounds(offset), round);

            uint256 release = uint256(registry.GENESIS_TIMESTAMP())
                + uint256(round - 1) * registry.PERIOD_SECONDS();

            assertEq(release - block.timestamp, 9 - offset);
        }
    }

    function test_delayedInclusionUsesNewSchedule()
        public
    {
        uint64 beforeDelay = registry.latestScheduledRound() + 3;

        vm.warp(block.timestamp + 12);

        uint64 round = consumer.request(1);

        assertEq(round, beforeDelay + 4);

        assertEq(consumer.requestRounds(1), round);
    }

    function test_cannotOverwriteCommittedRound()
        public
    {
        uint64 original = consumer.request(1);

        vm.warp(block.timestamp + 30);

        vm.expectRevert(
            abi.encodeWithSelector(
                QuicknetLeadThreeMeasurementConsumer
                    .RequestAlreadyExists.selector,
                uint256(1)
            )
        );
        consumer.request(1);

        assertEq(consumer.requestRounds(1), original);
    }

    function test_unrelatedCallerCannotCreateLoad()
        public
    {
        vm.prank(address(0xBEEF));
        vm.expectRevert(
            QuicknetLeadThreeMeasurementConsumer
                .UnauthorizedRequester.selector
        );
        consumer.request(1);

        assertEq(consumer.requestRounds(1), 0);
    }

    function test_distinctIdsMayShareOneRound()
        public
    {
        uint64 first = consumer.request(1);

        uint64 second = consumer.request(2);

        assertEq(first, second);

        assertEq(consumer.requestRounds(1), first);

        assertEq(consumer.requestRounds(2), second);
    }

    function test_zeroRequesterRejected()
        public
    {
        vm.expectRevert(
            QuicknetLeadThreeMeasurementConsumer.InvalidRequester.selector
        );
        new QuicknetLeadThreeMeasurementConsumer(
            address(registry),
            address(registry).codehash,
            address(0)
        );
    }

    function test_wrongRegistryHashRejected()
        public
    {
        vm.expectRevert(
            DrandQuicknetRandomnessConsumer
                .InvalidQuicknetBeaconRegistryCodehash.selector
        );
        new QuicknetLeadThreeMeasurementConsumer(
            address(registry),
            bytes32(uint256(1)),
            address(this)
        );
    }

    function test_higherRegistryFloorRejected()
        public
    {
        DrandQuicknetBeaconRegistry stricter =
            new DrandQuicknetBeaconRegistry(
                registry.verifier(),
                registry.verifierCodehash(),
                4
            );

        vm.expectRevert(
            abi.encodeWithSelector(
                DrandQuicknetRandomnessConsumer
                    .QuicknetLeadBelowRegistryMinimum.selector,
                uint64(3),
                uint64(4)
            )
        );
        new QuicknetLeadThreeMeasurementConsumer(
            address(stricter),
            address(stricter).codehash,
            address(this)
        );
    }
}
