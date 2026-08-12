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
}

export interface CreateRegistryDeploymentOptions {
  chainId: unknown;
  address: unknown;
  runtimeCodehash: unknown;
}

export const RegistryDeployment = {
  create(
    options: CreateRegistryDeploymentOptions,
  ): RegistryDeployment {
    const {
      chainId,
      address,
      runtimeCodehash,
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

    let normalizedAddress: Address;
    try {
      normalizedAddress = getAddress(address);
    } catch (cause) {
      throw new Error(
        'Registry deployment address must be a valid address.',
        { cause }
      );
    }

    if (
      !isHex(runtimeCodehash, { strict: true}) || 
      size(runtimeCodehash) !== 32
    ) {
      throw new Error('Registry deployment runtimeCodehash must be a 32-byte hex value.');
    }

    return {
      chainId,
      address: normalizedAddress,
      runtimeCodehash,
    }
  }
};

export type RegistrySignature =
  | CompressedSignature
  | UncompressedSignature;