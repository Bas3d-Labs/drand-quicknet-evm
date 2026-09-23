// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";

import {
    IDrandQuicknetBeaconRegistry
} from "../src/interfaces/IDrandQuicknetBeaconRegistry.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../src/verifiers/DrandQuicknetBeaconVerifier.sol";

import {
    MockDrandQuicknetBeaconVerifier
} from "./mocks/MockDrandQuicknetBeaconVerifier.sol";

import {
    RegistryTestBase
} from "./utils/RegistryTestBase.sol";

contract StatefulQuicknetVerifier {
    uint256 public value;

    function verifyBeacon(
        uint64,
        bytes calldata
    )
        external
        returns (
            bool verified,
            bytes32 randomness
        )
    {
        value = 1;

        return (
            true,
            keccak256("randomness")
        );
    }

    function verifyBeaconWithWitness(
        uint64,
        bytes calldata,
        uint128,
        uint256
    )
        external
        returns (
            bool verified,
            bytes32 randomness
        )
    {
        value = 1;

        return (
            true,
            keccak256("randomness")
        );
    }
}

contract DrandQuicknetBeaconRegistryTest is RegistryTestBase {
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

    function test_SubmitBeaconRealVerifierComposedPath() public {
        uint64 round = 1000;

        DrandQuicknetBeaconVerifier realVerifier =
            new DrandQuicknetBeaconVerifier();

        address realVerifierAddress = address(realVerifier);

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

        bytes memory sFlipped = bytes.concat(signature);
        sFlipped[0] =
            bytes1(
                uint8(sFlipped[0]) ^ 0x20
            );

        bytes32 expectedRandomness =
            0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

        assertEq(sha256(signature), expectedRandomness);

        // Rejection does not poison the round.
        vm.expectRevert(
            DrandQuicknetBeaconRegistry.InvalidBeacon.selector
        );

        realRegistry.submitBeacon(round, sFlipped);

        assertFalse(realRegistry.isStored(round));

        // Canonical signature now succeeds on the same round.
        vm.expectEmit(true, true, false, true, address(realRegistry));

        emit IDrandQuicknetBeaconRegistry.BeaconStored(
            round,
            expectedRandomness,
            address(this)
        );

        vm.recordLogs();

        bytes32 returned =
            realRegistry.submitBeacon(round, signature);

        Vm.Log[] memory storeLogs = vm.getRecordedLogs();

        assertEq(storeLogs.length, 1);
        assertEq(returned, expectedRandomness);
        assertEq(realRegistry.getBeacon(round), expectedRandomness);

        // Once stored, even an invalid signature is ignored.
        vm.recordLogs();

        returned = realRegistry.submitBeacon(
            round,
            sFlipped
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(returned, expectedRandomness);
        assertEq(logs.length, 0);
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

        emit IDrandQuicknetBeaconRegistry.BeaconStored(
            round,
            randomness,
            submitter
        );

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

    function test_SubmitBeaconVerifierRunsInStaticContext()
        public
    {
        StatefulQuicknetVerifier statefulVerifier =
            new StatefulQuicknetVerifier();

        address statefulVerifierAddress =
            address(statefulVerifier);

        DrandQuicknetBeaconRegistry staticRegistry =
            new DrandQuicknetBeaconRegistry(
                statefulVerifierAddress,
                statefulVerifierAddress.codehash,
                TEST_MINIMUM_LEAD_ROUNDS
            );

        uint64 round = 123;

        // Pins `verifyBeacon` as `view` in the verifier interface. The registry
        // must therefore use STATICCALL, causing this verifier's SSTORE to fail.
        (
            bool success,
            bytes memory returndata
        ) = address(staticRegistry).call(
            abi.encodeCall(
                DrandQuicknetBeaconRegistry.submitBeacon,
                (
                    round,
                    hex"1234"
                )
            )
        );

        assertFalse(success);
        assertEq(returndata.length, 0);

        assertEq(
            statefulVerifier.value(),
            0
        );

        assertFalse(
            staticRegistry.isStored(round)
        );
    }

    function test_SubmitBeaconUnmockedVerifierCallRevertsLoudly()
        public
    {
        uint64 round = 123;

        vm.expectRevert(
            abi.encodeWithSelector(
                MockDrandQuicknetBeaconVerifier
                    .UnmockedVerifierCall
                    .selector,
                round
            )
        );

        registry.submitBeacon(
            round,
            hex"1234"
        );

        assertFalse(
            registry.isStored(round)
        );
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
    // submitBeaconWithWitness
    // ---------------------------------------------------------------------

    function test_SubmitBeaconWithWitnessStoresVerifierRandomness()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";
        uint128 yHi = 17;
        uint256 yLo = 29;
        bytes32 randomness = keccak256("witness-randomness");

        _mockVerifyWithWitness(
            round,
            signature,
            yHi,
            yLo,
            true,
            randomness
        );

        vm.expectEmit(true, true, false, true, address(registry));

        emit IDrandQuicknetBeaconRegistry.BeaconStored(
            round,
            randomness,
            otherSubmitter
        );

        vm.recordLogs();
        vm.prank(otherSubmitter);

        bytes32 returned = registry.submitBeaconWithWitness(
            round,
            signature,
            yHi,
            yLo
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(returned, randomness);
        assertTrue(registry.isStored(round));
        assertEq(registry.getBeacon(round), randomness);
    }

    function test_SubmitBeaconWithWitnessRejectsRoundZeroBeforeVerifierCall()
        public
    {
        vm.expectCall(
            verifierAddress,
            bytes(""),
            uint64(0)
        );

        vm.expectRevert(
            DrandQuicknetBeaconRegistry.InvalidRound.selector
        );

        registry.submitBeaconWithWitness(
            0,
            hex"1234",
            17,
            29
        );

        assertFalse(registry.isStored(0));
    }

    function test_SubmitBeaconWithWitnessRejectsFailedVerification()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        // A nonzero answer must still be rejected when verified is false.
        _mockVerifyWithWitness(
            round,
            signature,
            17,
            29,
            false,
            keccak256("unused")
        );

        vm.expectRevert(
            DrandQuicknetBeaconRegistry.InvalidBeacon.selector
        );

        registry.submitBeaconWithWitness(
            round,
            signature,
            17,
            29
        );

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconWithWitnessRejectsZeroRandomness()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerifyWithWitness(
            round,
            signature,
            17,
            29,
            true,
            bytes32(0)
        );

        vm.expectRevert(
            DrandQuicknetBeaconRegistry.InvalidBeacon.selector
        );

        registry.submitBeaconWithWitness(
            round,
            signature,
            17,
            29
        );

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconWithWitnessBubblesVerifierRevert()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerifyWithWitnessRevert(
            round,
            signature,
            17,
            29
        );

        vm.expectRevert(MockVerifierFailure.selector);

        registry.submitBeaconWithWitness(
            round,
            signature,
            17,
            29
        );

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconWithWitnessUnmockedCallRevertsLoudly()
        public
    {
        uint64 round = 123;

        vm.expectRevert(
            abi.encodeWithSelector(
                MockDrandQuicknetBeaconVerifier
                    .UnmockedVerifierCall
                    .selector,
                round
            )
        );

        registry.submitBeaconWithWitness(
            round,
            hex"1234",
            17,
            29
        );

        assertFalse(registry.isStored(round));
    }

    function test_CompressedSubmissionPopulatesCacheForBothMethods()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";
        bytes32 randomness = keccak256("compressed-first");

        _mockVerify(
            round,
            signature,
            true,
            randomness
        );

        vm.prank(submitter);

        bytes32 returned = registry.submitBeacon(
            round,
            signature
        );

        assertEq(returned, randomness);

        _assertBothSubmissionMethodsUseCache(
            round,
            randomness
        );
    }

    function test_WitnessSubmissionPopulatesCacheForBothMethods()
        public
    {
        uint64 round = 123;
        bytes memory signature = hex"1234";
        bytes32 randomness = keccak256("witness-first");

        _mockVerifyWithWitness(
            round,
            signature,
            17,
            29,
            true,
            randomness
        );

        vm.prank(submitter);

        bytes32 returned = registry.submitBeaconWithWitness(
            round,
            signature,
            17,
            29
        );

        assertEq(returned, randomness);

        _assertBothSubmissionMethodsUseCache(
            round,
            randomness
        );
    }

    function test_SubmitBeaconWithWitnessRealVerifierCorrectedRetry()
        public
    {
        uint64 round = 1000;

        DrandQuicknetBeaconVerifier realVerifier =
            new DrandQuicknetBeaconVerifier();

        address realVerifierAddress = address(realVerifier);

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

        uint128 yHi =
            0x11f92e4521ef54f047b64b85fa98db2d;

        uint256 yLo =
            0x46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2;

        bytes32 expectedRandomness =
            0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

        assertEq(sha256(signature), expectedRandomness);

        // A valid signature with the wrong witness must not store a beacon.
        vm.expectRevert(
            DrandQuicknetBeaconRegistry.InvalidBeacon.selector
        );

        realRegistry.submitBeaconWithWitness(
            round,
            signature,
            0,
            0
        );

        assertFalse(realRegistry.isStored(round));

        vm.expectRevert(
            abi.encodeWithSelector(
                DrandQuicknetBeaconRegistry.BeaconUnavailable.selector,
                round
            )
        );

        realRegistry.getBeacon(round);

        // The same signature and round succeed with the correct witness.
        vm.expectEmit(true, true, false, true, address(realRegistry));

        emit IDrandQuicknetBeaconRegistry.BeaconStored(
            round,
            expectedRandomness,
            otherSubmitter
        );

        vm.recordLogs();
        vm.prank(otherSubmitter);

        bytes32 returned = realRegistry.submitBeaconWithWitness(
            round,
            signature,
            yHi,
            yLo
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(returned, expectedRandomness);
        assertTrue(realRegistry.isStored(round));
        assertEq(realRegistry.getBeacon(round), expectedRandomness);
    }

    function test_SubmitBeaconWithWitnessVerifierRunsInStaticContext()
        public
    {
        StatefulQuicknetVerifier statefulVerifier =
            new StatefulQuicknetVerifier();

        address statefulVerifierAddress = address(statefulVerifier);

        DrandQuicknetBeaconRegistry staticRegistry =
            new DrandQuicknetBeaconRegistry(
                statefulVerifierAddress,
                statefulVerifierAddress.codehash,
                TEST_MINIMUM_LEAD_ROUNDS
            );

        uint64 round = 123;

        // Bound the gas consumed by the deliberate SSTORE violation.
        // A non-static verifier call would instead succeed and store a beacon.
        (
            bool success,
            bytes memory returndata
        ) = address(staticRegistry).call{
            gas: 1_000_000
        }(
            abi.encodeCall(
                DrandQuicknetBeaconRegistry.submitBeaconWithWitness,
                (
                    round,
                    hex"1234",
                    uint128(17),
                    uint256(29)
                )
            )
        );

        assertFalse(success);
        assertEq(returndata.length, 0);
        assertEq(statefulVerifier.value(), 0);
        assertFalse(staticRegistry.isStored(round));
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

    function test_RoundScheduledTimeMatchesQuicknetKat() public view {
        assertEq(
            registry.roundScheduledTime(1000),
            1_692_806_364
        );
    }

    function test_RoundAtGenesisBoundary() public view {
        uint256 genesis = registry.GENESIS_TIMESTAMP();

        assertEq(registry.roundAt(genesis - 1), 0);
        assertEq(registry.roundAt(genesis), 1);
        assertEq(registry.roundAt(genesis + 2), 1);
        assertEq(registry.roundAt(genesis + 3), 2);
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

    function test_RoundAtMaximumBoundary() public {
        uint256 timestamp =
            registry.roundScheduledTime(type(uint64).max);

        assertEq(
            registry.roundAt(timestamp),
            type(uint64).max
        );

        assertEq(
            registry.roundAt(timestamp + 1),
            type(uint64).max
        );

        assertEq(
            registry.roundAt(timestamp + 2),
            type(uint64).max
        );

        vm.expectRevert(
            DrandQuicknetBeaconRegistry.InvalidRound.selector
        );

        registry.roundAt(timestamp + 3);
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

    /// @dev Checks both cached submission paths after the first import.
    ///      Invalid inputs must be ignored without verifier calls or events.
    function _assertBothSubmissionMethodsUseCache(
        uint64 round,
        bytes32 expectedRandomness
    )
        internal
    {
        vm.clearMockedCalls();

        // An empty prefix matches any call to the configured verifier.
        vm.expectCall(
            verifierAddress,
            bytes(""),
            uint64(0)
        );

        vm.recordLogs();
        vm.prank(otherSubmitter);

        bytes32 witnessReturned = registry.submitBeaconWithWitness(
            round,
            hex"",
            type(uint128).max,
            type(uint256).max
        );

        Vm.Log[] memory witnessLogs = vm.getRecordedLogs();

        assertEq(witnessReturned, expectedRandomness);
        assertEq(witnessLogs.length, 0);
        assertEq(registry.getBeacon(round), expectedRandomness);

        vm.recordLogs();
        vm.prank(otherSubmitter);

        bytes32 compressedReturned = registry.submitBeacon(
            round,
            hex""
        );

        Vm.Log[] memory compressedLogs = vm.getRecordedLogs();

        assertEq(compressedReturned, expectedRandomness);
        assertEq(compressedLogs.length, 0);
        assertTrue(registry.isStored(round));
        assertEq(registry.getBeacon(round), expectedRandomness);
    }
}
