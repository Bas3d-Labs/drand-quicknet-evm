// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    BLS2
} from "bls-solidity/libraries/BLS2.sol";

import {
    DrandQuicknetBeaconVerifier
} from "../../src/verifiers/DrandQuicknetBeaconVerifier.sol";

/// @notice Exposes verifier internals and raw pairing calls for tests.
/// @dev Inherits both verification entry points without overrides.
///      Deployment executes the verifier's constructor self-tests.
///      Raw pairing exposes call success separately from pairing output.
contract DrandQuicknetBeaconVerifierHarness is 
    DrandQuicknetBeaconVerifier
{
    function selfTestVector()
        external
        pure
        returns (
            uint64 round,
            bytes memory signature,
            bytes32 randomness
        )
    {
        return (
            SELF_TEST_ROUND,
            SELF_TEST_SIGNATURE,
            SELF_TEST_RANDOMNESS
        );
    }

    function isCanonical(
        bytes memory signature
    )
        external
        pure
        returns (bool)
    {
        (bool canonical, , , ) =
            _decodeCanonicalG1Compressed(signature);

        return canonical;
    }

    function decompressG1(
        bytes memory signature
    )
        external
        view
        returns (
            uint128 xHi,
            uint256 xLo,
            uint128 yHi,
            uint256 yLo
        )
    {
        BLS2.PointG1 memory point = BLS2.g1UnmarshalCompressed(signature);

        return (
            point.x_hi,
            point.x_lo,
            point.y_hi,
            point.y_lo
        );
    }

    function selfTestWitness()
        external
        pure
        returns (
            uint128 yHi,
            uint256 yLo
        )
    {
        return (
            SELF_TEST_Y_HI,
            SELF_TEST_Y_LO
        );
    }

    /// @dev Test callers must supply y < p.
    function negateY(
        uint128 yHi,
        uint256 yLo
    )
        external
        pure
        returns (
            uint128 oppositeYHi,
            uint256 oppositeYLo
        )
    {
        return _negateY(yHi, yLo);
    }

    /// @dev Constructs the expected production pairing payload.
    ///      Tests match these bytes against the production STATICCALL.
    ///      Deliberately permits invalid witness coordinates.
    function pairingInputForWitness(
        uint64 round,
        bytes memory signature,
        uint128 yHi,
        uint256 yLo
    )
        external
        view
        returns (bytes memory)
    {
        (
            bool canonical,
            uint128 xHi,
            uint256 xLo,

        ) = _decodeCanonicalG1Compressed(signature);

        require(canonical, "noncanonical test input");

        bytes32 roundHash = sha256(abi.encodePacked(round));

        BLS2.PointG1 memory message = BLS2.hashToPoint(
            bytes(DST),
            abi.encodePacked(roundHash)
        );

        BLS2.PointG2 memory publicKey = _publicKey();

        uint256[24] memory input;

        input[0] = xHi;
        input[1] = xLo;
        input[2] = yHi;
        input[3] = yLo;

        input[4] = NEG_G2_X0_HI;
        input[5] = NEG_G2_X0_LO;
        input[6] = NEG_G2_X1_HI;
        input[7] = NEG_G2_X1_LO;
        input[8] = NEG_G2_Y0_HI;
        input[9] = NEG_G2_Y0_LO;
        input[10] = NEG_G2_Y1_HI;
        input[11] = NEG_G2_Y1_LO;

        input[12] = message.x_hi;
        input[13] = message.x_lo;
        input[14] = message.y_hi;
        input[15] = message.y_lo;

        input[16] = publicKey.x0_hi;
        input[17] = publicKey.x0_lo;
        input[18] = publicKey.x1_hi;
        input[19] = publicKey.x1_lo;
        input[20] = publicKey.y0_hi;
        input[21] = publicKey.y0_lo;
        input[22] = publicKey.y1_hi;
        input[23] = publicKey.y1_lo;

        return abi.encode(input);
    }

    /// @dev Uses the production pairing allowance and gas guard.
    ///      Callers must inspect callSuccess before decoding returndata.
    function rawPairing(
        bytes calldata input
    )
        external
        view
        returns (
            bool callSuccess,
            bytes memory returndata
        )
    {
        bytes memory payload = input;

        _requirePairingGas();

        return address(uint160(BLS12_PAIRING_CHECK)).staticcall{
            gas: PAIRING_GAS
        }(payload);
    }
}