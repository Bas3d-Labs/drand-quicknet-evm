import {
  getAddress,
  keccak256,
} from 'viem';

import type {
  PublicClient,
} from 'viem';

import {
  drandQuicknetBeaconRegistryAbi,
} from './abi.js';

import type {
  RegistryDeployment,
} from './types.js';

export async function verifyRegistryDeployment(
  client: PublicClient,
  deployment: RegistryDeployment,
): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) {
    throw new Error(
      `Registry chain mismatch: expected ${deployment.chainId}, received ${chainId}`
    );
  }

  const registryCode = await client.getCode({
    address: deployment.address
  });
  if (registryCode === undefined || registryCode === '0x') {
    throw new Error(
      `No contract deployed at registry address ${deployment.address}`
    );
  }

  const registryRuntimeCodehash = keccak256(registryCode);
  if (
    registryRuntimeCodehash.toLowerCase() !== 
    deployment.runtimeCodehash.toLowerCase()
  ) {
    throw new Error(
      `Registry runtime codehash mismatch: expected ${deployment.runtimeCodehash}, received ${registryRuntimeCodehash}`
    );
  }

  const verifierAddress = await client.readContract({
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'verifier',
  });

  if (getAddress(verifierAddress) !== deployment.verifierAddress) {
    throw new Error(
      `Registry verifier address mismatch: expected ${deployment.verifierAddress}, received ${verifierAddress}`
    );
  }

  const verifierCodehash = await client.readContract({
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'verifierCodehash',
  });

  if (
    verifierCodehash.toLowerCase() !==
    deployment.verifierRuntimeCodehash.toLowerCase()
  ) {
    throw new Error(
      `Registry verifier codehash mismatch: expected ${deployment.verifierRuntimeCodehash}, received ${verifierCodehash}`
    );
  }

  const minimumLeadRounds = await client.readContract({
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'minimumLeadRounds',
  });

  if (minimumLeadRounds !== deployment.minimumLeadRounds) {
    throw new Error(
      `Registry minimumLeadRounds mismatch: expected ${deployment.minimumLeadRounds}, received ${minimumLeadRounds}`
    );
  }

  const verifierCode = await client.getCode({
    address: deployment.verifierAddress,
  });

  if (verifierCode === undefined || verifierCode === '0x') {
    throw new Error(
      `No contract deployed at verifier address ${deployment.verifierAddress}`
    );
  }

  const actualVerifierCodehash = keccak256(verifierCode);

  if (
    actualVerifierCodehash.toLowerCase() !==
    deployment.verifierRuntimeCodehash.toLowerCase()
  ) {
    throw new Error(
      `Verifier runtime codehash mismatch: expected ${deployment.verifierRuntimeCodehash}, received ${actualVerifierCodehash}`
    );
  }
}