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

const MAX_UINT64 = (1n << 64n) - 1n;

export interface RegistryDeployment {
  chainId: number;
  address: Address;
  runtimeCodehash: Hex;
  verifierAddress: Address;
  verifierRuntimeCodehash: Hex;
  minimumLeadRounds: bigint;
}

export interface CreateRegistryDeploymentOptions {
  chainId: unknown;
  address: unknown;
  runtimeCodehash: unknown;
  verifierAddress: unknown;
  verifierRuntimeCodehash: unknown;
  minimumLeadRounds: unknown;
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
      minimumLeadRounds,
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

    const normalizedMinimumLeadRounds =
      normalizeMinimumLeadRounds(minimumLeadRounds);

    return {
      chainId,
      address: normalizedAddress,
      runtimeCodehash,
      verifierAddress: normalizedVerifierAddress,
      verifierRuntimeCodehash,
      minimumLeadRounds: normalizedMinimumLeadRounds,
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

function normalizeMinimumLeadRounds(
  value: unknown,
): bigint {
  let normalized: bigint;

  if (typeof value === 'bigint') {
    normalized = value;
  } else if (
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  ) {
    normalized = BigInt(value);
  } else {
    throw new Error(
      'Registry deployment minimumLeadRounds must be a positive uint64.'
    );
  }

  if (
    normalized <= 0n ||
    normalized > MAX_UINT64
  ) {
    throw new Error(
      'Registry deployment minimumLeadRounds must be a positive uint64.'
    );
  }

  return normalized;
}

export type RegistrySignature = CompressedSignature;