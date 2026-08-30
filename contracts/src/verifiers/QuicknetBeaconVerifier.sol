// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    BLS2
} from "bls-solidity/libraries/BLS2.sol";

import {
    IQuicknetBeaconVerifier
} from "../interfaces/IQuicknetBeaconVerifier.sol";

/// @title QuicknetBeaconVerifier
/// @notice Verifies canonical drand Quicknet BLS12-381 beacons.
///
/// @dev For a nonzero Quicknet round, this verifier accepts only the
///      canonical 48-byte compressed G1 signature published by drand.
///
///      Canonical input requires:
///      - exactly 48 bytes
///      - compression bit C set
///      - infinity bit I clear
///      - encoded x strictly less than the BLS12-381 base-field modulus.
///
///      For a fixed round and Quicknet public key, BLS signature uniqueness
///      and pairing subgroup validation determine one valid signature
///      point. Canonical encoding fixes x, C, and I, while the pairing
///      equation fixes S. At most one byte encoding can therefore verify.
///
///      On successful verification, `randomness` is `sha256(signature)`,
///      matching drand's published randomness.
///
///      While the official known-answer test continues to pass on the
///      current execution environment, `(false, bytes32(0))` means that
///      the submitted candidate is not a valid Quicknet beacon.
///
///      Required BLS12-381 execution compatibility is checked by the
///      constructor's two-sided self-test. Deployment tooling and monitoring
///      should repeat the same acceptance and rejection checks against the
///      live deployed verifier.
contract QuicknetBeaconVerifier is IQuicknetBeaconVerifier {
    error PositiveSelfTestFailed();
    error NegativeSelfTestFailed();
    error InsufficientVerifierGas();
    error InvalidPairingResponse();

    string public constant DST =
        "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

    uint256 internal constant COMPRESSED_SIGNATURE_LENGTH = 48;

    uint128 internal constant P_HI =
        0x1a0111ea397fe69a4b1ba7b6434bacd7;

    uint256 internal constant P_LO =
        0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    uint128 internal constant MAX_X_HI =
        0x1fffffffffffffffffffffffffffffff;

    uint256 internal constant BLS12_PAIRING_CHECK = 0x0f;

    uint256 internal constant PAIRING_GAS = 500_000;

    uint256 internal constant PAIRING_GAS_RESERVE = 10_000;

    uint128 internal constant NEG_G2_X0_HI =
        0x024aa2b2f08f0a91260805272dc51051;

    uint256 internal constant NEG_G2_X0_LO =
        0xc6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8;

    uint128 internal constant NEG_G2_X1_HI =
        0x13e02b6052719f607dacd3a088274f65;

    uint256 internal constant NEG_G2_X1_LO =
        0x596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e;

    uint128 internal constant NEG_G2_Y0_HI =
        0x0d1b3cc2c7027888be51d9ef691d77bc;

    uint256 internal constant NEG_G2_Y0_LO =
        0xb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa;

    uint128 internal constant NEG_G2_Y1_HI =
        0x13fa4d4a0ad8b1ce186ed5061789213d;

    uint256 internal constant NEG_G2_Y1_LO =
        0x993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed;

    /// @dev The constructor self-test exercises both acceptance and rejection
    ///      through the complete verification path.
    constructor() {
        bytes memory signature =
            hex"b44679b9a59af2ec876b1a6b1ad52ea9"
            hex"b1615fc3982b19576350f93447cb1125"
            hex"e342b73a8dd2bacbe47e4b6b63ed5e39";

        bytes memory negativeSignature =
            abi.encodePacked(signature);

        negativeSignature[0] =
            bytes1(
                uint8(negativeSignature[0]) ^ 0x20
            );

        (
            bool verified,
            bytes32 randomness
        ) = _verifyBeacon(
            1000,
            signature
        );

        if (
            !verified ||
            randomness !=
                0xfe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd
        ) {
            revert PositiveSelfTestFailed();
        }

        (
            verified,
            randomness
        ) = _verifyBeacon(
            1000,
            negativeSignature
        );

        if (
            verified ||
            randomness != bytes32(0)
        ) {
            revert NegativeSelfTestFailed();
        }
    }

    function verifyBeacon(
        uint64 round,
        bytes calldata signature
    )
        external
        view
        override
        returns (
            bool verified,
            bytes32 randomness
        )
    {
        return _verifyBeacon(
            round,
            signature
        );
    }

    function _verifyBeacon(
        uint64 round,
        bytes memory signature
    )
        internal
        view
        returns (
            bool verified,
            bytes32 randomness
        )
    {
        if (
            round == 0 ||
            !_isCanonicalG1Compressed(signature)
        ) {
            return (
                false,
                bytes32(0)
            );
        }

        BLS2.PointG1 memory signaturePoint =
            BLS2.g1UnmarshalCompressed(signature);

        bytes32 roundHash = sha256(abi.encodePacked(round));

        BLS2.PointG1 memory messagePoint =
            BLS2.hashToPoint(
                bytes(DST),
                abi.encodePacked(roundHash)
            );

        if (
            !_verifyPairing(
                signaturePoint,
                messagePoint
            )
        ) {
            return (
                false,
                bytes32(0)
            );
        }

        return (
            true,
            sha256(signature)
        );
    }

    function _isCanonicalG1Compressed(
        bytes memory signature
    )
        internal
        pure
        returns (bool)
    {
        if (
            signature.length !=
            COMPRESSED_SIGNATURE_LENGTH
        ) {
            return false;
        }

        uint256 wordA;
        uint256 wordB;

        assembly {
            wordA := mload(add(signature, 0x20))
            wordB := mload(add(signature, 0x30))
        }

        uint8 first = uint8(wordA >> 248);
        if ((first & 0x80) == 0) {
            return false;
        }

        if ((first & 0x40) != 0) {
            return false;
        }

        uint128 xHi = uint128(wordA >> 128) & MAX_X_HI;

        return
            xHi < P_HI ||
            (
                xHi == P_HI &&
                wordB < P_LO
            );
    }

    function _verifyPairing(
        BLS2.PointG1 memory signature,
        BLS2.PointG1 memory message
    )
        internal
        view
        returns (bool verified)
    {
        BLS2.PointG2 memory publicKey = _publicKey();

        uint256[24] memory input;

        input[0] = signature.x_hi;
        input[1] = signature.x_lo;
        input[2] = signature.y_hi;
        input[3] = signature.y_lo;

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

        uint256[1] memory out;

        bool callSuccess;
        uint256 returnSize;
        uint256 pairingGas = PAIRING_GAS;
        uint256 precompile = BLS12_PAIRING_CHECK;

        _requirePairingGas();

        assembly {
            callSuccess := staticcall(
                pairingGas,
                precompile,
                input,
                768,
                out,
                32
            )

            returnSize := returndatasize()
        }

        if (!callSuccess) {
            return false;
        }

        if (
            returnSize != 32 ||
            out[0] > 1
        ) {
            revert InvalidPairingResponse();
        }

        return out[0] == 1;
    }

    function _requirePairingGas()
        internal
        view
    {
        uint256 eip150Minimum = (PAIRING_GAS * 64 + 62) / 63;

        if (
            gasleft() < eip150Minimum + PAIRING_GAS_RESERVE
        ) {
            revert InsufficientVerifierGas();
        }
    }

    function _publicKey()
        internal
        pure
        returns (
            BLS2.PointG2 memory
        )
    {
        return BLS2.PointG2(
            0x03cf0f2896adee7eb8b5f01fcad39122,
            0x12c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451,
            0x0d1fec758c921cc22b0e17e63aaf4bcb,
            0x5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a,
            0x01a714f2edb74119a2f2b0d5a7c75ba9,
            0x02d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b,
            0x0e5db2b6bfbb01c867749cadffca88b3,
            0x6c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273
        );
    }
}