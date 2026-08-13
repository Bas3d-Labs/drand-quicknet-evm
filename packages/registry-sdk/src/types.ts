import {
  getAddress,
  isHex,
  size,
  type Address,
  type Hex,
} from 'viem';

import type {
  CompressedSignature,
  UncompressedSignature,
} from '@based-labs/drand-quicknet';

export interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex;
  oracleAddress: Address;
  oracleRuntimeCodehash: Hex;
}

export interface CreateRegistryDeploymentOptions {
  chainId: unknown;
  address: unknown;
  runtimeCodehash: unknown;
  oracleAddress: unknown;
  oracleRuntimeCodehash: unknown;
}

export const RegistryDeployment = {
  create(
    options: CreateRegistryDeploymentOptions,
  ): RegistryDeployment {
    const {
      chainId,
      address,
      runtimeCodehash,
      oracleAddress,
      oracleRuntimeCodehash,
    } = options;

    if (
      typeof chainId !== 'number' ||
      !Number.isSafeInteger(chainId) ||
      chainId <= 0
    ) {
      throw new Error('Registry deployment chainId must be a positive safe integer.');
    }

    if (typeof address !== 'string') {
      throw new Error('Registry deployment address must be a valid address.');
    }
    
    const normalizedAddress = normalizeAddress(
      address,
      'Registry deployment address'
    );

    const normalizedOracleAddress = normalizeAddress(
      oracleAddress,
        'Registry deployment oracleAddress'
    );

    validateCodehash(runtimeCodehash, 'Registry deployment runtimeCodehash');
    validateCodehash(oracleRuntimeCodehash, 'Registry deployment oracleRuntimeCodehash');

    return {
      chainId,
      address: normalizedAddress,
      runtimeCodehash,
      oracleAddress: normalizedOracleAddress,
      oracleRuntimeCodehash,
    };
  },
};

function normalizeAddress(
  value: unknown,
  field: string,
): Address {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a valid address.`);
  }

  try {
    return getAddress(value);
  } catch (cause) {
    throw new Error(
      `${field} must be a valid address.`,
      { cause }
    );
  }
}

function validateCodehash(
  value: unknown,
  field: string,
): asserts value is Hex {
  if (
    !isHex(value, { strict: true }) ||
    size(value) !== 32
  ) {
    throw new Error(`${field} must be a 32-byte hex value.`);
  }
}

export type RegistrySignature =
  | CompressedSignature
  | UncompressedSignature;