// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {
    DrandQuicknetBeaconRegistry
} from "../../src/DrandQuicknetBeaconRegistry.sol";

interface ITestDrandOracleQuicknet {
    function verifyNormalized(
        uint64 round,
        bytes calldata signature
    )
        external
        view
        returns (
            bool verified,
            bytes32 normalizedRoundHash,
            bytes32 chainScopedHash
        );
}

/// @dev Shared fork setup for registry tests.
///
/// The expected chain, verifier address, and verifier runtime codehash
/// are loaded from deployments/robinhood-testnet.json. The verifier
/// runtime bytecode is checked before constructing a fresh registry.
abstract contract RegistryTestBase is Test {
    using stdJson for string;

    string internal deploymentJson;

    address internal oracleAddress;
    bytes32 internal expectedOracleCodehash;

    ITestDrandOracleQuicknet internal oracle;
    DrandQuicknetBeaconRegistry internal registry;

    address internal submitter = makeAddr("submitter");
    address internal otherSubmitter = makeAddr("otherSubmitter");

    event BeaconStored(
        uint64 indexed round,
        bytes32 randomness,
        address indexed submitter
    );

    function setUp() public virtual {
        string memory path = string.concat(
            vm.projectRoot(), "/../deployments/robinhood-testnet.json"
        );

        deploymentJson = vm.readFile(path);

        uint256 expectedChainId = deploymentJson.readUint(".chainId");

        string memory rpcUrl = vm.envString("ROBINHOOD_TESTNET_RPC_URL");

        vm.createSelectFork(rpcUrl);

        assertEq(block.chainid, expectedChainId, "unexpected fork chain ID");

        oracleAddress = deploymentJson.readAddress(".oracle.address");
        expectedOracleCodehash = 
            deploymentJson.readBytes32(".oracle.runtimeCodehash");

        assertEq(
            oracleAddress.codehash,
            expectedOracleCodehash,
            "oracle runtime codehash mismatch"
        );

        oracle = ITestDrandOracleQuicknet(oracleAddress);
        registry = new DrandQuicknetBeaconRegistry(
            oracleAddress, 
            expectedOracleCodehash
        );
    }

    function _mockVerify(
        uint64 round,
        bytes memory signature,
        bool verified,
        bytes32 normalizedRoundHash,
        bytes32 chainScopedHash
    )
        internal
    {
        vm.mockCall(
            oracleAddress,
            abi.encodeWithSelector(
                ITestDrandOracleQuicknet.verifyNormalized.selector,
                round,
                signature
            ),
            abi.encode(verified, normalizedRoundHash, chainScopedHash)
        );
    }

    function _sig1Compressed() internal pure returns (bytes memory) {
        return hex"8d2c8bbc37170dbacc5e280a21d4e195cff5f32a19fd6a58633fa4e4670478b5fb39bc13dd8f8c4372c5a76191198ac5";
    }

    function _sig1Uncompressed() internal pure returns (bytes memory) {
        return hex"0d2c8bbc37170dbacc5e280a21d4e195cff5f32a19fd6a58633fa4e4670478b5fb39bc13dd8f8c4372c5a76191198ac50823ff37364b4060af65c7ec4dde05a428e4a444713680d95c34a4b109f112af1792643c742b75d85940c4bdcfdfbfa1";
    }

    function _sig2Uncompressed() internal pure returns (bytes memory) {
        return hex"0a60486975062d9f06633c284cf1a7b46fb343f56f329f180530ca40a9e86320244f4fbfc37ae866cf25ef499665a31f08c61b5471ed86344d6b347d1b0e1a4146877a57c28507448678d8249521d91be74cd5a44fb6fce5f869b235e085ebe6";
    }

    function _liveCompressedSignature() internal pure returns (bytes memory) {
        return hex"87b3b9c9f99cc1e7fc326e249538f33b84a1c4ef8bd85920a267af642b570bcd62bf70900a3862f742e574164b5f17f3";
    }
}
