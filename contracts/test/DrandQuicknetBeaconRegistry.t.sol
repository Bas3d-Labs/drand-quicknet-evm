// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../src/verifiers/DrandQuicknetBeaconVerifier.sol";

import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

contract DrandQuicknetBeaconRegistryTest is RegistryTestBase {
    using stdJson for string;
    
    // ---------------------------------------------------------------------
    // Constructor / configuration
    // ---------------------------------------------------------------------

    function test_ConstructorStoresVerifier() public view {
        assertEq(
            registry.verifier(),
            verifierAddress
        );
    }

    function test_ConstructorStoresVerifierCodehash() public view {
        assertEq(
            registry.verifierCodehash(),
            expectedVerifierCodehash
        );

        assertEq(
            verifierAddress.codehash,
            expectedVerifierCodehash
        );
    }

    function test_ConstructorStoresMinimumLeadRounds()
        public
        view
    {
        assertEq(
            registry.minimumLeadRounds(),
            TEST_MINIMUM_LEAD_ROUNDS
        );
    }

    function test_ScheduleConstantsMatchRobinhoodTestnetManifest() public view {
        string memory path = string.concat(
            vm.projectRoot(),
            "/../deployments/robinhood-testnet.json"
        );

        string memory json = vm.readFile(path);

        assertEq(
            uint256(registry.GENESIS_TIMESTAMP()),
            json.readUint(".quicknet.genesisTimestamp")
        );

        assertEq(
            uint256(registry.PERIOD_SECONDS()),
            json.readUint(".quicknet.periodSeconds")
        );
    }

    function test_ConstructorRejectsAddressWithoutCode() public {
        address invalidVerifier = makeAddr("invalidVerifier");

        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidVerifier
                .selector
        );

        new DrandQuicknetBeaconRegistry(
            invalidVerifier,
            expectedVerifierCodehash,
            TEST_MINIMUM_LEAD_ROUNDS
        );
    }

    function test_ConstructorRejectsZeroVerifierCodehash() public {
        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidVerifier
                .selector
        );

        new DrandQuicknetBeaconRegistry(
            verifierAddress,
            bytes32(0),
            TEST_MINIMUM_LEAD_ROUNDS
        );
    }

    function test_ConstructorRejectsMismatchedVerifierCodehash() public {
        bytes32 wrongVerifierCodehash =
            keccak256("wrong-verifier-codehash");

        assertNotEq(
            wrongVerifierCodehash,
            verifierAddress.codehash
        );

        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidVerifier
                .selector
            );

        new DrandQuicknetBeaconRegistry(
            verifierAddress,
            wrongVerifierCodehash,
            TEST_MINIMUM_LEAD_ROUNDS
        );
    }

    function test_ConstructorRejectsZeroMinimumLeadRounds()
        public
    {
        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidMinimumLeadRounds
                .selector
        );

        new DrandQuicknetBeaconRegistry(
            verifierAddress,
            expectedVerifierCodehash,
            0
        );
    }

    // ---------------------------------------------------------------------
    // submitBeacon
    // ---------------------------------------------------------------------

    function test_SubmitBeaconStoresOfficialQuicknetRandomness()
        public
    {
        uint64 round = 1000;

        DrandQuicknetBeaconVerifier realVerifier =
            new DrandQuicknetBeaconVerifier();

        address realVerifierAddress =
            address(realVerifier);

        DrandQuicknetBeaconRegistry realRegistry =
            new DrandQuicknetBeaconRegistry(
                realVerifierAddress,
                realVerifierAddress.codehash,
                TEST_MINIMUM_LEAD_ROUNDS
            );

        bytes memory signature =
            hex"b44679b9a59af2ec876b1a6b1ad52ea9"
            hex"b1615fc3982b19576350f93447cb1125"
            hex"e342b73a8dd2bacbe47e4b6b63ed5e39";

        bytes32 expectedRandomness =
            0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

        assertEq(
            sha256(signature),
            expectedRandomness
        );

        bytes32 randomness =
            realRegistry.submitBeacon(
                round,
                signature
            );

        assertEq(
            randomness,
            expectedRandomness
        );

        assertEq(
            realRegistry.getBeacon(round),
            expectedRandomness
        );

        assertTrue(
            realRegistry.isStored(round)
        );
    }

    function test_SubmitBeaconStoresVerifierRandomness() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        bytes32 randomness = keccak256("randomness");

        _mockVerify(
            round,
            signature,
            true,
            randomness
        );

        vm.expectEmit(true, true, false, true, address(registry));

        emit BeaconStored(round, randomness, submitter);

        vm.prank(submitter);

        bytes32 returned = registry.submitBeacon(round, signature);

        assertEq(returned, randomness);
        assertTrue(registry.isStored(round));
        assertEq(registry.getBeacon(round), randomness);
    }

    function test_SubmitBeaconIsPermissionless() public {
        uint64 round = 456;
        bytes memory signature = hex"abcd";
        bytes32 randomness = keccak256("randomness");

        _mockVerify(
            round,
            signature,
            true,
            randomness
        );

        vm.prank(otherSubmitter);

        bytes32 returned = registry.submitBeacon(round, signature);

        assertEq(returned, randomness);

        assertEq(registry.getBeacon(round), randomness);
    }

    function test_SubmitBeaconRejectsRoundZeroBeforeVerifierCall()
        public
    {
        bytes memory signature = hex"1234";

        _mockVerifyRevert(
            0,
            signature
        );

        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidRound
                .selector
        );

        registry.submitBeacon(
            0,
            signature
        );
    }

    function test_SubmitBeaconRejectsFailedVerification() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerify(
            round,
            signature,
            false,
            keccak256("unused")
        );

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidBeacon.selector);

        registry.submitBeacon(round, signature);

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconRejectsZeroRandomness() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerify(
            round,
            signature,
            true,
            bytes32(0)
        );

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidBeacon.selector);

        registry.submitBeacon(round, signature);

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconBubblesVerifierRevert()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerifyRevert(
            round,
            signature
        );

        vm.expectRevert(
            MockVerifierFailure.selector
        );

        registry.submitBeacon(
            round,
            signature
        );

        assertFalse(
            registry.isStored(round)
        );
    }

    function test_SubmitBeaconAllowsPastRoundRegardlessOfLeadPolicy()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        bytes32 randomness =
            keccak256("randomness");

        vm.warp(
            registry.roundScheduledTime(round) +
            1 days
        );

        assertGt(
            registry.latestScheduledRound(),
            round
        );

        _mockVerify(
            round,
            signature,
            true,
            randomness
        );

        bytes32 returned =
            registry.submitBeacon(
                round,
                signature
            );

        assertEq(returned, randomness);

        assertEq(
            registry.getBeacon(round),
            randomness
        );
    }

    function test_SubmitBeaconAllowsFutureRoundBeforeScheduledTime()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        bytes32 randomness =
            keccak256("randomness");

        vm.warp(
            registry.GENESIS_TIMESTAMP()
        );

        assertLt(
            registry.latestScheduledRound(),
            round
        );

        assertLt(
            block.timestamp,
            registry.roundScheduledTime(round)
        );

        _mockVerify(
            round,
            signature,
            true,
            randomness
        );

        bytes32 returned =
            registry.submitBeacon(
                round,
                signature
            );

        assertEq(returned, randomness);

        assertEq(
            registry.getBeacon(round),
            randomness
        );
    }

    function test_SubmitBeaconIsIdempotent()
        public
    {
        uint64 round = 123;

        bytes memory firstSignature = hex"aaaa";
        bytes memory secondSignature = hex"bbbb";

        bytes32 randomness =
            keccak256("randomness");

        _mockVerify(
            round,
            firstSignature,
            true,
            randomness
        );

        registry.submitBeacon(
            round,
            firstSignature
        );

        // An already stored round must return before calling the verifier.
        _mockVerifyRevert(
            round,
            secondSignature
        );

        vm.recordLogs();

        bytes32 returned =
            registry.submitBeacon(
                round,
                secondSignature
            );

        Vm.Log[] memory logs =
            vm.getRecordedLogs();

        assertEq(returned, randomness);

        assertEq(
            registry.getBeacon(round),
            randomness
        );

        // Idempotent submissions do not emit another BeaconStored event.
        assertEq(logs.length, 0);
    }

    function test_StoredBeaconCannotBeOverwritten() public {
        uint64 round = 123;

        bytes memory firstSignature = hex"aaaa";

        bytes memory secondSignature = hex"bbbb";

        bytes32 firstRandomness = keccak256("first");

        bytes32 secondRandomness = keccak256("second");

        _mockVerify(
            round,
            firstSignature,
            true,
            firstRandomness
        );

        registry.submitBeacon(round, firstSignature);

        _mockVerify(
            round,
            secondSignature,
            true,
            secondRandomness
        );

        bytes32 returned = registry.submitBeacon(round, secondSignature);

        assertEq(returned, firstRandomness);

        assertEq(registry.getBeacon(round), firstRandomness);

        assertNotEq(registry.getBeacon(round), secondRandomness);
    }

    function test_DifferentRoundsStoreIndependently() public {
        uint64 roundA = 100;
        uint64 roundB = 101;

        bytes memory signatureA = hex"aaaa";
        bytes memory signatureB = hex"bbbb";

        bytes32 randomnessA = keccak256("round-a");

        bytes32 randomnessB = keccak256("round-b");

        _mockVerify(
            roundA,
            signatureA,
            true,
            randomnessA
        );

        _mockVerify(
            roundB,
            signatureB,
            true,
            randomnessB
        );

        registry.submitBeacon(roundA, signatureA);

        registry.submitBeacon(roundB, signatureB);

        assertEq(registry.getBeacon(roundA), randomnessA);

        assertEq(registry.getBeacon(roundB), randomnessB);
    }

    // ---------------------------------------------------------------------
    // getBeacon / isStored
    // ---------------------------------------------------------------------

    function test_GetBeaconRejectsRoundZero() public {
        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidRound.selector);

        registry.getBeacon(0);
    }

    function test_GetBeaconRevertsWhenUnavailable() public {
        uint64 round = 12345;

        vm.expectRevert(
            abi.encodeWithSelector(
                DrandQuicknetBeaconRegistry.BeaconUnavailable.selector, round
            )
        );

        registry.getBeacon(round);
    }

    function test_IsStoredReturnsFalseForMissingRound() public view {
        assertFalse(registry.isStored(999));
    }

    function test_IsStoredReturnsFalseForRoundZero() public view {
        assertFalse(registry.isStored(0));
    }

    // ---------------------------------------------------------------------
    // Quicknet schedule arithmetic
    // ---------------------------------------------------------------------

    function test_RoundScheduledTimeRoundOneIsGenesis() public view {
        assertEq(registry.roundScheduledTime(1), registry.GENESIS_TIMESTAMP());
    }

    function test_RoundScheduledTimeIncrementsByPeriod() public view {
        uint256 first = registry.roundScheduledTime(100);

        uint256 second = registry.roundScheduledTime(101);

        assertEq(second - first, registry.PERIOD_SECONDS());
    }

    function test_RoundScheduledTimeRejectsZero() public {
        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidRound.selector);

        registry.roundScheduledTime(0);
    }

    function test_RoundAtBeforeGenesisReturnsZero() public view {
        uint256 genesis = registry.GENESIS_TIMESTAMP();

        assertEq(registry.roundAt(genesis - 1), 0);
    }

    function test_RoundAtGenesisReturnsOne() public view {
        assertEq(registry.roundAt(registry.GENESIS_TIMESTAMP()), 1);
    }

    function test_RoundAtWithinRoundWindow() public view {
        uint256 genesis = registry.GENESIS_TIMESTAMP();

        assertEq(registry.roundAt(genesis + 0), 1);

        assertEq(registry.roundAt(genesis + 1), 1);

        assertEq(registry.roundAt(genesis + 2), 1);

        assertEq(registry.roundAt(genesis + 3), 2);

        assertEq(registry.roundAt(genesis + 5), 2);

        assertEq(registry.roundAt(genesis + 6), 3);
    }

    function test_LatestScheduledRoundUsesBlockTimestamp() public {
        uint256 genesis = registry.GENESIS_TIMESTAMP();

        uint256 timestamp = genesis + (1_234 * 3) + 2;

        vm.warp(timestamp);

        assertEq(registry.latestScheduledRound(), 1_235);
    }

    function test_LatestScheduledRoundIgnoresStoredFutureBeacon()
        public
    {
        uint64 scheduledRound = 100;
        uint64 storedRound = 500;

        uint256 timestamp =
            registry.roundScheduledTime(
                scheduledRound
            );

        vm.warp(timestamp);

        assertEq(
            registry.latestScheduledRound(),
            scheduledRound
        );

        bytes memory signature = hex"1234";

        bytes32 randomness =
            keccak256("future-randomness");

        _mockVerify(
            storedRound,
            signature,
            true,
            randomness
        );

        registry.submitBeacon(
            storedRound,
            signature
        );

        assertTrue(
            registry.isStored(storedRound)
        );

        assertEq(
            registry.latestScheduledRound(),
            scheduledRound
        );
    }

    function test_RoundAtLastTimestampOfMaxRoundReturnsMax()
        public
        view
    {
        uint256 timestamp =
            registry.roundScheduledTime(
                type(uint64).max
            ) +
            registry.PERIOD_SECONDS() -
            1;

        assertEq(
            registry.roundAt(timestamp),
            type(uint64).max
        );
    }

    function test_RoundAtRejectsFirstTimestampBeyondUint64()
        public
    {
        uint256 timestamp =
            registry.roundScheduledTime(
                type(uint64).max
            ) +
            registry.PERIOD_SECONDS();

        vm.expectRevert(
            DrandQuicknetBeaconRegistry
                .InvalidRound
                .selector
        );

        registry.roundAt(timestamp);
    }

    // ---------------------------------------------------------------------
    // Fuzz tests
    // ---------------------------------------------------------------------

    function testFuzz_RoundScheduledTimeRoundTrips(uint64 round) public view {
        vm.assume(round != 0);

        uint256 timestamp = registry.roundScheduledTime(round);

        assertEq(registry.roundAt(timestamp), round);
    }

    function testFuzz_RoundRemainsCurrentForEntirePeriod(
        uint64 round,
        uint8 offset
    )
        public
        view
    {
        vm.assume(round != 0);

        offset = uint8(bound(offset, 0, registry.PERIOD_SECONDS() - 1));

        uint256 timestamp = registry.roundScheduledTime(round) + offset;

        assertEq(registry.roundAt(timestamp), round);
    }

    function testFuzz_ScheduledTimeIsStrictlyIncreasing(uint64 round)
        public
        view
    {
        vm.assume(round != 0 && round != type(uint64).max);

        assertGt(
            registry.roundScheduledTime(round + 1),
            registry.roundScheduledTime(round)
        );
    }
}
