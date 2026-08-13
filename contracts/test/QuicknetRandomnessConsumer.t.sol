// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    Test
} from "forge-std/Test.sol";

import {
    QuicknetRandomnessConsumer
} from "../src/consumers/QuicknetRandomnessConsumer.sol";

import {
    MockQuicknetRandomnessConsumer
} from "./mocks/MockQuicknetRandomnessConsumer.sol";

import {
    MockDrandQuicknetBeaconRegistry
} from "./mocks/MockDrandQuicknetBeaconRegistry.sol";

contract UnrelatedContract {}

contract QuicknetRandomnessConsumerTest is Test {
    uint64 internal constant LEAD_ROUNDS = 10;

    bytes32 internal constant PACK_DOMAIN =
        keccak256(
            "GACHA_PACK_OPENING_V1"
        );

    bytes32 internal constant LOTTERY_DOMAIN =
        keccak256(
            "LOTTERY_DRAW_V1"
        );

    MockDrandQuicknetBeaconRegistry internal registry;
    MockQuicknetRandomnessConsumer internal consumer;

    event QuicknetRandomnessRequested(
        uint64 indexed round
    );

    function setUp() public {
        registry = new MockDrandQuicknetBeaconRegistry(
            address(0x1234),
            bytes32(uint256(0x5678))
        );

        consumer = _deployConsumer(
            registry,
            LEAD_ROUNDS
        );
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function test_constructor_setsConfiguration()
        public
        view
    {
        assertEq(
            consumer.quicknetBeaconRegistry(),
            address(registry)
        );

        assertEq(
            consumer.quicknetBeaconRegistryCodehash(),
            address(registry).codehash
        );

        assertEq(
            consumer.quicknetLeadRounds(),
            LEAD_ROUNDS
        );
    }

    function test_constructor_revertsForRegistryWithoutCode()
        public
    {
        address noCode = address(0xBEEF);

        vm.expectRevert(
            QuicknetRandomnessConsumer
                .InvalidQuicknetBeaconRegistry
                .selector
        );

        new MockQuicknetRandomnessConsumer(
            noCode,
            bytes32(uint256(1)),
            LEAD_ROUNDS
        );
    }

    function test_constructor_revertsForWrongRegistryCodehash()
        public
    {
        bytes32 wrongCodehash =
            keccak256(
                "wrong-codehash"
            );

        assertTrue(
            wrongCodehash != address(registry).codehash
        );

        vm.expectRevert(
            QuicknetRandomnessConsumer
                .InvalidQuicknetBeaconRegistryCodehash
                .selector
        );

        new MockQuicknetRandomnessConsumer(
            address(registry),
            wrongCodehash,
            LEAD_ROUNDS
        );
    }

    function test_constructor_revertsForZeroRegistryCodehash()
        public
    {
        vm.expectRevert(
            QuicknetRandomnessConsumer
                .InvalidQuicknetBeaconRegistryCodehash
                .selector
        );

        new MockQuicknetRandomnessConsumer(
            address(registry),
            bytes32(0),
            LEAD_ROUNDS
        );
    }

    function test_constructor_revertsForZeroLeadRounds()
        public
    {
        vm.expectRevert(
            QuicknetRandomnessConsumer
                .InvalidQuicknetLeadRounds
                .selector
        );

        new MockQuicknetRandomnessConsumer(
            address(registry),
            address(registry).codehash,
            0
        );
    }

    function test_constructor_acceptsNonCanonicalContractWhenExpectedCodehashMatches()
        public
    {
        UnrelatedContract unrelated = new UnrelatedContract();

        MockQuicknetRandomnessConsumer unrelatedConsumer =
            new MockQuicknetRandomnessConsumer(
                address(unrelated),
                address(unrelated).codehash,
                LEAD_ROUNDS
            );

        assertEq(
            unrelatedConsumer.quicknetBeaconRegistry(),
            address(unrelated)
        );

        assertEq(
            unrelatedConsumer.quicknetBeaconRegistryCodehash(),
            address(unrelated).codehash
        );
    }

    // ---------------------------------------------------------------------
    // Round selection
    // ---------------------------------------------------------------------

    function test_request_usesLatestScheduledRoundPlusLead()
        public
    {
        registry.setLatestScheduledRound(100);

        uint64 round = consumer.request(1);

        assertEq(
            round,
            110
        );

        assertEq(
            consumer.requestRounds(1),
            110
        );
    }

    function test_request_emitsCommittedRound()
        public
    {
        registry.setLatestScheduledRound(100);

        vm.expectEmit(
            true,
            false,
            false,
            true
        );

        emit QuicknetRandomnessRequested(
            110
        );

        consumer.request(1);
    }

    function test_request_acceptsMaximumNonOverflowingRound()
        public
    {
        registry.setLatestScheduledRound(
            type(uint64).max - LEAD_ROUNDS
        );

        uint64 round = consumer.request(1);

        assertEq(
            round,
            type(uint64).max
        );
    }

    function test_request_revertsOnRoundOverflow()
        public
    {
        registry.setLatestScheduledRound(
            type(uint64).max - LEAD_ROUNDS + 1
        );

        vm.expectRevert(
            QuicknetRandomnessConsumer
                .QuicknetRoundOverflow
                .selector
        );

        consumer.request(1);
    }

    function test_request_doesNotInspectBeaconAvailability()
        public
    {
        registry.setLatestScheduledRound(100);

        registry.setRevertOnIsStored(true);
        registry.setRevertOnGetBeacon(true);
        registry.setRevertOnSubmitBeacon(true);

        uint64 round = consumer.request(1);

        assertEq(
            round,
            110
        );

        assertEq(
            consumer.requestRounds(1),
            110
        );
    }

    // ---------------------------------------------------------------------
    // Exact-round reads / no substitution
    // ---------------------------------------------------------------------

    function test_isStored_returnsRegistryState()
        public
    {
        uint64 round = 110;

        assertFalse(consumer.isStored(round));

        registry.setBeacon(
            round,
            keccak256("beacon")
        );

        assertTrue(consumer.isStored(round));
    }

    function test_getBeacon_returnsExactStoredRound()
        public
    {
        uint64 round = 110;
        bytes32 randomness = keccak256("round-110");

        registry.setBeacon(
            round,
            randomness
        );

        assertEq(
            consumer.getBeacon(round),
            randomness
        );
    }

    function test_getBeacon_revertsWhenExactRoundIsUnavailable()
        public
    {
        uint64 round = 110;

        vm.expectRevert(
            abi.encodeWithSelector(
                MockDrandQuicknetBeaconRegistry
                    .BeaconUnavailable
                    .selector,
                round
            )
        );

        consumer.getBeacon(round);
    }

    function test_getBeacon_doesNotSubstituteAvailableRound()
        public
    {
        uint64 requestedRound = 110;
        uint64 otherRound = 111;

        registry.setBeacon(
            otherRound,
            keccak256(
                "other-round"
            )
        );

        assertTrue(
            consumer.isStored(
                otherRound
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                MockDrandQuicknetBeaconRegistry
                    .BeaconUnavailable
                    .selector,
                requestedRound
            )
        );

        consumer.getBeacon(requestedRound);
    }

    // ---------------------------------------------------------------------
    // Permissionless submit / idempotency
    // ---------------------------------------------------------------------

    function test_submitBeacon_storesAndReturnsRandomness()
        public
    {
        uint64 round = 110;
        bytes memory signature = hex"1234";

        bytes32 randomness = consumer.submitBeacon(
            round,
            signature
        );

        assertTrue(consumer.isStored(round));

        assertEq(
            consumer.getBeacon(round),
            randomness
        );

        assertEq(
            registry.verificationCount(),
            1
        );
    }

    function test_submitBeacon_isIdempotentForStoredRound()
        public
    {
        uint64 round = 110;

        bytes32 first = consumer.submitBeacon(
            round,
            hex"1234"
        );

        assertEq(
            registry.verificationCount(),
            1
        );

        bytes32 second = consumer.submitBeacon(
            round,
            hex""
        );

        assertEq(
            second,
            first
        );

        assertEq(
            registry.verificationCount(),
            1
        );
    }

    function test_submitBeacon_revertsForMissingSignatureWhenRoundIsNotStored()
        public
    {
        uint64 round = 110;

        vm.expectRevert(
            MockDrandQuicknetBeaconRegistry
                .InvalidSignature
                .selector
        );

        consumer.submitBeacon(round, hex"");
    }

    // ---------------------------------------------------------------------
    // Seed derivation
    // ---------------------------------------------------------------------

    function test_deriveSeed_isDeterministicForSameInputs()
        public
        view
    {
        uint64 round = 110;
        bytes32 randomness = keccak256("randomness");
        bytes32 requestId = bytes32(uint256(1));

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        assertEq(first, second);
    }

    function test_deriveSeed_differsForDifferentUniqueRequestIds()
        public
        view
    {
        uint64 round = 110;
        bytes32 randomness = keccak256("randomness");

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            bytes32(uint256(1)),
            round,
            randomness
        );

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            bytes32(uint256(2)),
            round,
            randomness
        );

        assertNotEq(first, second);
    }

    function test_deriveSeed_reusingUniqueRequestIdProducesSameSeed()
        public
        view
    {
        uint64 round = 110;

        bytes32 randomness = keccak256("randomness");
        bytes32 requestId = bytes32(uint256(1));

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        assertEq(first, second);
    }

    function test_deriveSeed_differsAcrossApplicationDomains()
        public
        view
    {
        uint64 round = 110;
        bytes32 randomness = keccak256("randomness");
        bytes32 requestId = bytes32(uint256(1));

        bytes32 packSeed = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        bytes32 lotterySeed = consumer.deriveSeed(
            LOTTERY_DOMAIN,
            requestId,
            round,
            randomness
        );

        assertNotEq(packSeed, lotterySeed);
    }

    function test_deriveSeed_differsAcrossConsumers()
        public
    {
        MockQuicknetRandomnessConsumer
            secondConsumer =
                _deployConsumer(
                    registry,
                    LEAD_ROUNDS
                );

        uint64 round = 110;
        bytes32 randomness = keccak256("randomness");
        bytes32 requestId = bytes32(uint256(1));

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        bytes32 second = secondConsumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        assertNotEq(first, second);
    }

    function test_deriveSeed_differsAcrossChains()
        public
    {
        uint256 originalChainId = block.chainid;
        uint64 round = 110;
        bytes32 randomness = keccak256("randomness");
        bytes32 requestId = bytes32(uint256(1));

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        vm.chainId(originalChainId + 1);

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            randomness
        );

        assertNotEq(first, second);
    }

    function test_deriveSeed_differsAcrossRounds()
        public
        view
    {
        bytes32 randomness = keccak256("randomness");
        bytes32 requestId = bytes32(uint256(1));

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            110,
            randomness
        );

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            111,
            randomness
        );

        assertNotEq(first, second);
    }

    // ---------------------------------------------------------------------
    // Persisted-round behavior
    // ---------------------------------------------------------------------

    function test_getRequestedBeacon_usesPersistedRoundAfterLatestAdvances()
        public
    {
        registry.setLatestScheduledRound(100);

        uint64 requestedRound = consumer.request(42);

        assertEq(requestedRound, 110);

        bytes32 randomness = keccak256("round-110");
        registry.setBeacon(requestedRound, randomness);
        registry.setLatestScheduledRound(500);

        (
            uint64 resolvedRound,
            bytes32 resolvedRandomness
        ) = consumer.getRequestedBeacon(42);

        assertEq(resolvedRound, 110);
        assertEq(resolvedRandomness, randomness);
    }

    function test_getRequestedBeacon_revertsIfPersistedRoundIsUnavailable()
        public
    {
        registry.setLatestScheduledRound(100);
        uint64 requestedRound = consumer.request(42);
        registry.setLatestScheduledRound(500);
        registry.setBeacon(510, keccak256("later-beacon"));

        vm.expectRevert(
            abi.encodeWithSelector(
                MockDrandQuicknetBeaconRegistry
                    .BeaconUnavailable
                    .selector,
                requestedRound
            )
        );

        consumer.getRequestedBeacon(42);
    }

    function test_getRequestedBeacon_revertsForUnknownRequest()
        public
    {
        vm.expectRevert(
            abi.encodeWithSelector(
                MockQuicknetRandomnessConsumer
                    .RequestNotFound
                    .selector,
                42
            )
        );

        consumer.getRequestedBeacon(
            42
        );
    }

    function test_deriveRequestedSeed_usesPersistedRound()
        public
    {
        registry.setLatestScheduledRound(100);

        uint64 requestedRound = consumer.request(42);
        bytes32 randomness = keccak256("round-110");

        registry.setBeacon(requestedRound, randomness);
        registry.setLatestScheduledRound(500);

        bytes32 uniqueRequestId = bytes32(uint256(42));

        (
            uint64 resolvedRound,
            bytes32 resolvedRandomness,
            bytes32 seed
        ) = consumer.deriveRequestedSeed(
            42,
            PACK_DOMAIN,
            uniqueRequestId
        );

        assertEq(resolvedRound, requestedRound);

        assertEq(resolvedRandomness, randomness);

        assertEq(
            seed,
            consumer.deriveSeed(
                PACK_DOMAIN,
                uniqueRequestId,
                requestedRound,
                randomness
            )
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _deployConsumer(
        MockDrandQuicknetBeaconRegistry registry_,
        uint64 leadRounds_
    )
        internal
        returns (
            MockQuicknetRandomnessConsumer
        )
    {
        return
            new MockQuicknetRandomnessConsumer(
                address(registry_),
                address(registry_).codehash,
                leadRounds_
            );
    }
}