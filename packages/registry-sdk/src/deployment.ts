import { keccak256 } from 'viem';
import type { PublicClient } from 'viem';
import type { RegistryDeployment } from "./types.js";

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
}