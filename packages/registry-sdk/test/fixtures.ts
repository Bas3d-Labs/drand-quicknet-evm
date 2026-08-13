import {
  keccak256,
  type Address,
  type Hex,
} from 'viem';

import {
  decompressSignature,
  parseCompressedSignature,
} from '@based-labs/drand-quicknet';

import type {
  RegistryDeployment,
} from '../src/types.js';

export const CHAIN_ID = 46_630;

export const REGISTRY_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
export const ORACLE_ADDRESS: Address = '0x2222222222222222222222222222222222222222';

export const ACCOUNT: Address = '0x3333333333333333333333333333333333333333';

export const RUNTIME_CODE: Hex = '0x6001600055';
export const RUNTIME_CODEHASH = keccak256(RUNTIME_CODE);

export const ORACLE_RUNTIME_CODE: Hex = '0x6002600055';
export const ORACLE_RUNTIME_CODEHASH = keccak256(ORACLE_RUNTIME_CODE);

export const ROUND = 20_791_007n;
export const RANDOMNESS: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const TRANSACTION_HASH: Hex =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export const DEPLOYMENT: RegistryDeployment = {
  chainId: CHAIN_ID,
  address: REGISTRY_ADDRESS,
  runtimeCodehash: RUNTIME_CODEHASH,
  oracleAddress: ORACLE_ADDRESS,
  oracleRuntimeCodehash: ORACLE_RUNTIME_CODEHASH,
};

export const COMPRESSED_SIGNATURE =
  parseCompressedSignature(
    '8d2c8bbc37170dbacc5e280a21d4e195cff5f32a19fd6a58633fa4e4670478b5fb39bc13dd8f8c4372c5a76191198ac5',
  );

export const UNCOMPRESSED_SIGNATURE =
  decompressSignature(COMPRESSED_SIGNATURE);