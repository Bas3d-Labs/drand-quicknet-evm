import {
  getAddress,
  isHex,
  size,
  type Address,
  type Hex,
} from 'viem';

import type {
  CompressedSignature,
} from '@based-labs/drand-quicknet';

export interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex;
  verifierAddress: Address;
  verifierRuntimeCodehash: Hex;
}

export interface CreateRegistryDeploymentOptions {
  chainId: unknown;
  address: unknown;
  runtimeCodehash: unknown;
  verifierAddress: unknown;
  verifierRuntimeCodehash: unknown;
}

export const RegistryDeployment = {
  create(
    options: CreateRegistryDeploymentOptions,
  ): RegistryDeployment {
    const {
      chainId,
      address,
      runtimeCodehash,
      verifierAddress,
      verifierRuntimeCodehash,
    } = options;

    if (
      typeof chainId !== 'number' ||
      !Number.isSafeInteger(chainId) ||
      chainId <= 0
    ) {
      throw new Error(
        'Registry deployment chainId must be a positive safe integer.'
      );
    }

    const normalizedAddress = normalizeAddress(
      address,
      'Registry deployment address'
    );

    const normalizedVerifierAddress = normalizeAddress(
      verifierAddress,
      'Registry deployment verifierAddress'
    );

    validateCodehash(
      runtimeCodehash,
      'Registry deployment runtimeCodehash'
    );

    validateCodehash(
      verifierRuntimeCodehash,
      'Registry deployment verifierRuntimeCodehash'
    );

    return {
      chainId,
      address: normalizedAddress,
      runtimeCodehash,
      verifierAddress: normalizedVerifierAddress,
      verifierRuntimeCodehash,
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

export type RegistrySignature = CompressedSignature;
