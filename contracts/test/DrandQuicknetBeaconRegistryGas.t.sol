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

    uint128 internal constant KAT_Y_HI =
        0x11f92e4521ef54f047b64b85fa98db2d;

    uint256 internal constant KAT_Y_LO =
        0x46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2;

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
        bytes memory callData = abi.encodeCall(
            DrandQuicknetBeaconRegistry.submitBeacon,
            (
                KAT_ROUND,
                _katSignature()
            )
        );

        _assertSubmitGasBands(
            callData,
            "minimum submitBeacon call gas"
        );
    }

    function test_SubmitBeaconWithWitnessGasBands() public {
        bytes memory callData = abi.encodeCall(
            DrandQuicknetBeaconRegistry.submitBeaconWithWitness,
            (
                KAT_ROUND,
                _katSignature(),
                KAT_Y_HI,
                KAT_Y_LO
            )
        );

        _assertSubmitGasBands(
            callData,
            "minimum submitBeaconWithWitness call gas"
        );
    }

    function _assertSubmitGasBands(
        bytes memory callData,
        string memory label
    )
        internal
    {
        uint256 minimumGas = _findMinimumSuccessfulGas(callData);

        emit log_named_uint(label, minimumGas);

        assertLe(
            minimumGas,
            REFERENCE_SUBMIT_GAS_CEILING,
            "submission gas requirement exceeded reference ceiling"
        );

        assertGt(minimumGas, STARVATION_GAS);

        // Exact discovered boundary succeeds.
        (
            bool success,
            uint256 returndataLength,
            bytes32 returndataWord
        ) = _probe(minimumGas, callData);

        assertTrue(success);
        assertEq(returndataLength, 32);
        assertEq(returndataWord, KAT_RANDOMNESS);

        // Successful probes also roll back their storage changes.
        assertFalse(registry.isStored(KAT_ROUND));

        // Reference-EVM regression: the verifier guard is the binding
        // threshold for the complete registry submission.
        //
        // For this KAT, pre-guard work completes before gas becomes
        // limiting. After the guard passes, the pairing's actual cost
        // leaves sufficient gas for verifier completion and registry
        // storage. One gas below the success boundary is therefore
        // expected to reach and fail the guard.
        //
        // Reassess this expectation if guard accounting, pairing pricing,
        // compiler output, or surrounding work changes.
        (
            success,
            returndataLength,
            returndataWord
        ) = _probe(minimumGas - 1, callData);

        assertFalse(success);
        assertEq(returndataLength, 4);

        assertEq(
            bytes4(returndataWord),
            DrandQuicknetBeaconVerifier
                .InsufficientVerifierGas
                .selector
        );

        assertFalse(registry.isStored(KAT_ROUND));

        // Severe starvation cannot reliably reach the verifier guard.
        (
            success,
            returndataLength,
            returndataWord
        ) = _probe(STARVATION_GAS, callData);

        assertFalse(success);
        assertEq(returndataLength, 0);
        assertEq(returndataWord, bytes32(0));

        assertFalse(registry.isStored(KAT_ROUND));

        // Submit outside the rollback wrapper with sufficient gas.
        // The earlier failed attempts must not prevent storage.
        (
            bool retrySuccess,
            bytes memory retryReturndata
        ) = address(registry).call{
            gas: SEARCH_CEILING_GAS
        }(
            callData
        );

        assertTrue(retrySuccess);
        assertEq(retryReturndata.length, 32);

        assertEq(
            abi.decode(retryReturndata, (bytes32)),
            KAT_RANDOMNESS
        );

        assertTrue(registry.isStored(KAT_ROUND));
        assertEq(registry.getBeacon(KAT_ROUND), KAT_RANDOMNESS);
    }

    function _findMinimumSuccessfulGas(
        bytes memory callData
    )
        internal
        returns (uint256 minimumGas)
    {
        uint256 low = 0;
        uint256 high = SEARCH_CEILING_GAS;

        (
            bool ceilingSucceeds,
            uint256 ceilingReturndataLength,
            bytes32 ceilingReturndataWord
        ) = _probe(high, callData);

        assertTrue(
            ceilingSucceeds,
            "submission gas search ceiling is too low"
        );

        assertEq(ceilingReturndataLength, 32);
        assertEq(ceilingReturndataWord, KAT_RANDOMNESS);

        while (low + 1 < high) {
            uint256 middle = low + (high - low) / 2;

            (
                bool success,
                uint256 returndataLength,
                bytes32 returndataWord
            ) = _probe(middle, callData);

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
        uint256 gasLimit,
        bytes memory callData
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
                (
                    gasLimit,
                    callData
                )
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

    // Each probe rolls back storage and access warming introduced within
    // the wrapper, preserving the starting state across search iterations.
    function gasProbe(
        uint256 gasLimit,
        bytes calldata callData
    )
        external
    {
        (
            bool success,
            bytes memory returndata
        ) = address(registry).call{
            gas: gasLimit
        }(
            callData
        );

        bytes32 returndataWord = bytes32(0);

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