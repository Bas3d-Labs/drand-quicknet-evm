// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

contract WrongOracle {}

contract DrandQuicknetBeaconRegistryTest is RegistryTestBase {
    using stdJson for string;
    // ---------------------------------------------------------------------
    // Constructor / configuration
    // ---------------------------------------------------------------------

    function test_ConstructorStoresOracle() public view {
        assertEq(address(registry.oracle()), oracleAddress);
    }

    function test_ConstantsMatchDeploymentManifest() public view {
        assertEq(
            uint256(registry.GENESIS_TIMESTAMP()),
            deploymentJson.readUint(".quicknet.genesisTimestamp")
        );

        assertEq(
            uint256(registry.PERIOD_SECONDS()),
            deploymentJson.readUint(".quicknet.periodSeconds")
        );

        assertEq(
            registry.EXPECTED_ORACLE_CODEHASH(),
            deploymentJson.readBytes32(".oracle.runtimeCodehash")
        );
    }

    function test_ConstructorRejectsAddressWithoutCode() public {
        address invalidOracle = makeAddr("invalidOracle");

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidOracle.selector);

        new DrandQuicknetBeaconRegistry(invalidOracle);
    }

    function test_ConstructorRejectsWrongRuntimeCode() public {
        WrongOracle wrongOracle = new WrongOracle();

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidOracle.selector);

        new DrandQuicknetBeaconRegistry(address(wrongOracle));
    }

    // ---------------------------------------------------------------------
    // submitBeacon
    // ---------------------------------------------------------------------

    function test_SubmitBeaconStoresNormalizedHash() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        bytes32 normalized = keccak256("normalized");

        bytes32 chainScoped = keccak256("chain-scoped");

        _mockVerify(round, signature, true, normalized, chainScoped);

        vm.expectEmit(true, true, false, true, address(registry));

        emit BeaconStored(round, normalized, submitter);

        vm.prank(submitter);

        bytes32 returned = registry.submitBeacon(round, signature);

        assertEq(returned, normalized);
        assertTrue(registry.isStored(round));
        assertEq(registry.getBeacon(round), normalized);
    }

    function test_SubmitBeaconStoresNormalizedNotChainScoped() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        bytes32 normalized = keccak256("normalized");

        bytes32 chainScoped = keccak256("chain-scoped");

        assertNotEq(normalized, chainScoped);

        _mockVerify(round, signature, true, normalized, chainScoped);

        registry.submitBeacon(round, signature);

        assertEq(registry.getBeacon(round), normalized);

        assertNotEq(registry.getBeacon(round), chainScoped);
    }

    function test_SubmitBeaconIsPermissionless() public {
        uint64 round = 456;
        bytes memory signature = hex"abcd";
        bytes32 normalized = keccak256("beacon");

        _mockVerify(
            round, signature, true, normalized, bytes32(uint256(0x1234))
        );

        vm.prank(otherSubmitter);

        bytes32 returned = registry.submitBeacon(round, signature);

        assertEq(returned, normalized);

        assertEq(registry.getBeacon(round), normalized);
    }

    function test_SubmitBeaconRejectsRoundZero() public {
        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidRound.selector);

        registry.submitBeacon(0, hex"1234");
    }

    function test_SubmitBeaconRejectsFailedVerification() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerify(
            round,
            signature,
            false,
            keccak256("unused"),
            keccak256("unused-scoped")
        );

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidBeacon.selector);

        registry.submitBeacon(round, signature);

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconRejectsZeroNormalizedHash() public {
        uint64 round = 123;
        bytes memory signature = hex"1234";

        _mockVerify(
            round, signature, true, bytes32(0), keccak256("chain-scoped")
        );

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidBeacon.selector);

        registry.submitBeacon(round, signature);

        assertFalse(registry.isStored(round));
    }

    function test_SubmitBeaconIsIdempotent() public {
        uint64 round = 123;

        bytes memory firstSignature = hex"aaaa";

        bytes memory secondSignature = hex"bbbb";

        bytes32 normalized = keccak256("normalized");

        _mockVerify(
            round, firstSignature, true, normalized, keccak256("scope-1")
        );

        registry.submitBeacon(round, firstSignature);

        // If the registry attempted to validate this second
        // signature, verification would fail.
        _mockVerify(round, secondSignature, false, bytes32(0), bytes32(0));

        vm.recordLogs();

        bytes32 returned = registry.submitBeacon(round, secondSignature);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(returned, normalized);
        assertEq(registry.getBeacon(round), normalized);

        // Cached submissions do not emit another
        // BeaconStored event.
        assertEq(logs.length, 0);
    }

    function test_StoredBeaconCannotBeOverwritten() public {
        uint64 round = 123;

        bytes memory firstSignature = hex"aaaa";

        bytes memory secondSignature = hex"bbbb";

        bytes32 firstRandomness = keccak256("first");

        bytes32 secondRandomness = keccak256("second");

        _mockVerify(
            round, firstSignature, true, firstRandomness, keccak256("scope-1")
        );

        registry.submitBeacon(round, firstSignature);

        _mockVerify(
            round, secondSignature, true, secondRandomness, keccak256("scope-2")
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

        _mockVerify(roundA, signatureA, true, randomnessA, bytes32(uint256(1)));

        _mockVerify(roundB, signatureB, true, randomnessB, bytes32(uint256(2)));

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
        // isStored intentionally treats zero exactly like
        // any other unstored mapping key.
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

    function test_RoundAtRejectsValueBeyondUint64() public {
        uint256 timestamp = uint256(registry.GENESIS_TIMESTAMP())
            + uint256(type(uint64).max) * uint256(registry.PERIOD_SECONDS());

        vm.expectRevert(DrandQuicknetBeaconRegistry.InvalidRound.selector);

        registry.roundAt(timestamp);
    }
}
