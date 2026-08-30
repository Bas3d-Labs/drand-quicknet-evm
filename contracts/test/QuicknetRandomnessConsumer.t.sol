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

    uint256 internal constant V1_VECTOR_CHAIN_ID = 46630;
    address internal constant V1_VECTOR_CONSUMER = address(0xC0FFEE);

    bytes32 internal constant V1_VECTOR_APPLICATION_DOMAIN =
        0xd68423ccd1ea2bb7b0aa7b3ad69e61b84d362c827767cd804411835564b33855;

    bytes32 internal constant V1_VECTOR_REQUEST_ID = bytes32(uint256(42));

    uint64 internal constant V1_VECTOR_ROUND = 31_250_005;

    bytes32 internal constant V1_VECTOR_RANDOMNESS =
        0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;

    bytes32 internal constant V1_VECTOR_EXPECTED_SEED =
        0x1ec91054743783996cd7e4abc7845f3124a2257d232d913004cb3390eeb0ea8a;

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

    function test_constructor_codehashDoesNotValidateRegistrySemantics()
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
            true,
            address(consumer)
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

    function test_request_newRequestUsesAdvancedScheduledRound()
        public
    {
        registry.setLatestScheduledRound(100);

        uint64 firstRound = consumer.request(1);

        registry.setLatestScheduledRound(500);

        uint64 secondRound = consumer.request(2);

        assertEq(firstRound, 110);
        assertEq(secondRound, 510);

        assertEq(
            consumer.requestRounds(1),
            110
        );

        assertEq(
            consumer.requestRounds(2),
            510
        );
    }

    function testFuzz_request_usesLatestScheduledRoundPlusLead(
        uint64 latest,
        uint64 lead
    )
        public
    {
        vm.assume(lead != 0);
        vm.assume(
            latest <= type(uint64).max - lead
        );

        MockQuicknetRandomnessConsumer fuzzConsumer =
            _deployConsumer(
                registry,
                lead
            );

        registry.setLatestScheduledRound(latest);

        uint64 round = fuzzConsumer.request(1);

        assertEq(
            round,
            latest + lead
        );

        assertEq(
            fuzzConsumer.requestRounds(1),
            round
        );
    }

    function testFuzz_request_revertsOnRoundOverflow(
        uint64 latest,
        uint64 lead
    )
        public
    {
        vm.assume(lead != 0);
        vm.assume(
            latest > type(uint64).max - lead
        );

        MockQuicknetRandomnessConsumer fuzzConsumer =
            _deployConsumer(
                registry,
                lead
            );

        registry.setLatestScheduledRound(latest);

        vm.expectRevert(
            QuicknetRandomnessConsumer
                .QuicknetRoundOverflow
                .selector
        );

        fuzzConsumer.request(1);
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

    function test_submitBeacon_permissionlessCallerStoresAndReturnsBeacon()
        public
    {
        uint64 round = 110;
        address submitter = address(0xBEEF);

        vm.prank(submitter);

        bytes32 randomness = consumer.submitBeacon(
            round,
            hex"1234"
        );

        assertEq(
            consumer.getBeacon(round),
            randomness
        );

        assertTrue(
            consumer.isStored(round)
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

    function test_submitBeacon_otherRoundDoesNotFulfillRequest()
        public
    {
        registry.setLatestScheduledRound(100);

        uint64 requestedRound = consumer.request(42);

        consumer.submitBeacon(
            requestedRound + 1,
            hex"1234"
        );

        assertTrue(
            consumer.isStored(
                requestedRound + 1
            )
        );

        assertFalse(
            consumer.isStored(
                requestedRound
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

        consumer.getRequestedBeacon(42);
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

    function test_deriveSeed_differsAcrossRandomness()
        public
        view
    {
        uint64 round = 110;
        bytes32 requestId = bytes32(uint256(1));

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            keccak256("randomness-a")
        );

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            requestId,
            round,
            keccak256("randomness-b")
        );

        assertNotEq(first, second);
    }

    function test_deriveSeed_sharedRoundProducesDistinctRequestSeeds()
        public
    {
        registry.setLatestScheduledRound(100);

        uint64 firstRound = consumer.request(1);
        uint64 secondRound = consumer.request(2);

        assertEq(firstRound, 110);
        assertEq(secondRound, 110);

        bytes32 randomness = keccak256("round-110");

        registry.setBeacon(
            110,
            randomness
        );

        (
            ,
            ,
            bytes32 firstSeed
        ) = consumer.deriveRequestedSeed(
            1,
            PACK_DOMAIN,
            bytes32(uint256(1))
        );

        (
            ,
            ,
            bytes32 secondSeed
        ) = consumer.deriveRequestedSeed(
            2,
            PACK_DOMAIN,
            bytes32(uint256(2))
        );

        assertNotEq(firstSeed, secondSeed);
    }

    function test_deriveSeed_matchesV1CompatibilityVector()
        public
    {
        vm.chainId(V1_VECTOR_CHAIN_ID);

        vm.etch(
            V1_VECTOR_CONSUMER,
            address(consumer).code
        );

        MockQuicknetRandomnessConsumer fixedConsumer =
            MockQuicknetRandomnessConsumer(
                V1_VECTOR_CONSUMER
            );

        bytes32 seed = fixedConsumer.deriveSeed(
            V1_VECTOR_APPLICATION_DOMAIN,
            V1_VECTOR_REQUEST_ID,
            V1_VECTOR_ROUND,
            V1_VECTOR_RANDOMNESS
        );

        assertEq(
            seed,
            V1_VECTOR_EXPECTED_SEED
        );
    }

    function testFuzz_deriveSeed_isDeterministic(
        bytes32 applicationDomain,
        bytes32 requestId,
        uint64 round,
        bytes32 randomness
    )
        public
        view
    {
        bytes32 first = consumer.deriveSeed(
            applicationDomain,
            requestId,
            round,
            randomness
        );

        bytes32 second = consumer.deriveSeed(
            applicationDomain,
            requestId,
            round,
            randomness
        );

        assertEq(first, second);
    }

    function testFuzz_deriveSeed_distinguishesUniqueRequestIds(
        bytes32 firstRequestId,
        bytes32 secondRequestId,
        uint64 round,
        bytes32 randomness
    )
        public
        view
    {
        vm.assume(
            firstRequestId != secondRequestId
        );

        bytes32 first = consumer.deriveSeed(
            PACK_DOMAIN,
            firstRequestId,
            round,
            randomness
        );

        bytes32 second = consumer.deriveSeed(
            PACK_DOMAIN,
            secondRequestId,
            round,
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

    function test_getRequestedBeacon_revertsIfPersistedRoundUnavailable()
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