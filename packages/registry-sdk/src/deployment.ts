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

  const code = await client.getCode({
    address: deployment.address
  });
  if (code === undefined || code === '0x') {
    throw new Error(
      `No contract deployed at registry address ${deployment.address}`
    );
  }

  const runtimeCodehash = keccak256(code);
  if (runtimeCodehash.toLowerCase() !== deployment.runtimeCodehash.toLowerCase()) {
    throw new Error(
      `Registry runtime codehash mismatch: expected ${deployment.runtimeCodehash}, received ${runtimeCodehash}`
    );
  }

  const oracleAddress = await client.readContract({
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'oracle',
  });
  if (getAddress(oracleAddress) !== deployment.oracleAddress) {
    throw new Error(
      `Registry oracle address mismatch: expected ${deployment.oracleAddress}, received ${oracleAddress}`
    );
  }

  const oracleCodehash = await client.readContract({
    address: deployment.address,
    abi: drandQuicknetBeaconRegistryAbi,
    functionName: 'oracleCodehash',
  });
  if (
    oracleCodehash.toLowerCase() !== 
    deployment.oracleRuntimeCodehash.toLowerCase()
  ) {
    throw new Error(
      `Registry oracle codehash mismatch: expected ${deployment.oracleRuntimeCodehash}, received ${oracleCodehash}`
    );
  }

  const oracleCode = await client.getCode({
    address: deployment.oracleAddress,
  });
  if (oracleCode === undefined || oracleCode === '0x') {
    throw new Error(`No contract deployed at oracle address ${deployment.oracleAddress}`);
  }

  const actualOracleCodehash = keccak256(oracleCode);
  if (
    actualOracleCodehash.toLowerCase() !== 
    deployment.oracleRuntimeCodehash.toLowerCase()
  ) {
    throw new Error(
      `Oracle runtime codehash mismatch: expected ${deployment.oracleRuntimeCodehash}, received ${actualOracleCodehash}`
    );
  }
}