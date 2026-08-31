// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {
    DrandQuicknetBeaconRegistry
} from "../src/DrandQuicknetBeaconRegistry.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../src/verifiers/DrandQuicknetBeaconVerifier.sol";

contract DrandQuicknetBeaconRegistryGasTest is Test {
    error GasProbeResult(
        bool success,
        uint256 returndataLength,
        bytes32 returndataWord
    );

    uint64 internal constant KAT_ROUND = 1000;
    uint64 internal constant TEST_MINIMUM_LEAD_ROUNDS = 5;

    uint256 internal constant SEARCH_CEILING_GAS = 1_000_000;

    // Reference-EVM regression ceiling only. This is not a portable gas
    // requirement for other EVM chains or deployments.
    uint256 internal constant REFERENCE_SUBMIT_GAS_CEILING = 700_000;
    
    uint256 internal constant STARVATION_GAS = 1_000;

    bytes32 internal constant KAT_RANDOMNESS =
        0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd;

    DrandQuicknetBeaconVerifier internal verifier;
    DrandQuicknetBeaconRegistry internal registry;

    function setUp() public {
        verifier = new DrandQuicknetBeaconVerifier();

        address verifierAddress = address(verifier);

        registry = new DrandQuicknetBeaconRegistry(
            verifierAddress,
            verifierAddress.codehash,
            TEST_MINIMUM_LEAD_ROUNDS
        );
    }

    function test_SubmitBeaconGasBands() public {
        uint256 minimumGas = _findMinimumSuccessfulGas();

        emit log_named_uint(
            "minimum submitBeacon call gas",
            minimumGas
        );

        assertGt(minimumGas, STARVATION_GAS);

        // Exact discovered boundary succeeds.
        (
            bool success,
            uint256 returndataLength,
            bytes32 returndataWord
        ) = _probe(minimumGas);

        assertTrue(success);
        assertEq(returndataLength, 32);
        assertEq(returndataWord, KAT_RANDOMNESS);

        // The probe wrapper reverts all registry state after every probe.
        assertFalse(registry.isStored(KAT_ROUND));

        // One gas below the success boundary should reach the verifier's
        // explicit gas guard and bubble its semantic error unchanged.
        (
            success,
            returndataLength,
            returndataWord
        ) = _probe(minimumGas - 1);

        assertFalse(success);
        assertEq(returndataLength, 4);

        assertEq(
            bytes4(returndataWord),
            DrandQuicknetBeaconVerifier
                .InsufficientVerifierGas
                .selector
        );

        assertFalse(registry.isStored(KAT_ROUND));

        // Severe starvation cannot reliably reach the semantic verifier
        // failure and therefore returns no revert data.
        (
            success,
            returndataLength,
            returndataWord
        ) = _probe(STARVATION_GAS);

        assertFalse(success);
        assertEq(returndataLength, 0);
        assertEq(returndataWord, bytes32(0));

        assertFalse(registry.isStored(KAT_ROUND));
    }

    function _findMinimumSuccessfulGas()
        internal
        returns (uint256 minimumGas)
    {
        uint256 low = 0;
        uint256 high = SEARCH_CEILING_GAS;

        (
            bool ceilingSucceeds,
            uint256 ceilingReturndataLength,
            bytes32 ceilingReturndataWord
        ) = _probe(high);

        assertTrue(
            ceilingSucceeds,
            "submitBeacon gas search ceiling is too low"
        );

        assertEq(ceilingReturndataLength, 32);
        assertEq(ceilingReturndataWord, KAT_RANDOMNESS);

        while (low + 1 < high) {
            uint256 middle = low + (high - low) / 2;

            (
                bool success,
                uint256 returndataLength,
                bytes32 returndataWord
            ) = _probe(middle);

            if (success) {
                assertEq(returndataLength, 32);
                assertEq(returndataWord, KAT_RANDOMNESS);

                high = middle;
            } else {
                low = middle;
            }
        }

        minimumGas = high;
    }

    function _probe(
        uint256 gasLimit
    )
        internal
        returns (
            bool success,
            uint256 returndataLength,
            bytes32 returndataWord
        )
    {
        (
            bool wrapperSuccess,
            bytes memory wrapperReturndata
        ) = address(this).call(
            abi.encodeCall(
                this.gasProbe,
                (gasLimit)
            )
        );

        assertFalse(wrapperSuccess);
        assertEq(wrapperReturndata.length, 100);

        bytes4 selector;

        assembly ("memory-safe") {
            selector := mload(
                add(wrapperReturndata, 0x20)
            )

            success := mload(
                add(wrapperReturndata, 0x24)
            )

            returndataLength := mload(
                add(wrapperReturndata, 0x44)
            )

            returndataWord := mload(
                add(wrapperReturndata, 0x64)
            )
        }

        assertEq(
            selector,
            GasProbeResult.selector
        );
    }

    function gasProbe(
        uint256 gasLimit
    )
        external
    {
        bytes memory callData = abi.encodeCall(
            DrandQuicknetBeaconRegistry.submitBeacon,
            (
                KAT_ROUND,
                _katSignature()
            )
        );

        (
            bool success,
            bytes memory returndata
        ) = address(registry).call{
            gas: gasLimit
        }(
            callData
        );

        bytes32 returndataWord;

        if (returndata.length != 0) {
            assembly ("memory-safe") {
                returndataWord := mload(
                    add(returndata, 0x20)
                )
            }
        }

        revert GasProbeResult(
            success,
            returndata.length,
            returndataWord
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
}