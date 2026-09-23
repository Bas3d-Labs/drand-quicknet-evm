import {
  getAddress,
  type Address,
  type PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';
import { QUICKNET_RANDOMNESS_CONSUMER_ABI } from './consumer-abi.js';

export interface ValidateQuicknetConsumerOptions {
  publicClient: PublicClient;
  consumer: Address;
  deployment: RegistryDeployment;
}

export interface ValidatedQuicknetConsumer {
  address: Address;
  registry: Address;
}

export async function validateQuicknetConsumer(
  options: ValidateQuicknetConsumerOptions,
): Promise<ValidatedQuicknetConsumer> {
  const consumer = getAddress(options.consumer);
  const code = await options.publicClient.getCode({
    address: consumer,
  });

  if (code === undefined || code === '0x') {
    throw new Error(`Quicknet consumer ${consumer} has no deployed code.`);
  }

  const registry = await options.publicClient.readContract({
    address: consumer,
    abi: QUICKNET_RANDOMNESS_CONSUMER_ABI,
    functionName: 'quicknetBeaconRegistry',
  });

  const expectedRegistry = getAddress(options.deployment.address);
  const actualRegistry = getAddress(registry);
  if (actualRegistry !== expectedRegistry) {
    throw new Error(
      `Quicknet consumer ${consumer} uses registry ${actualRegistry}, ` +
      `but relayer is configured for ${expectedRegistry}.`
    );
  }

  return {
    address: consumer,
    registry: actualRegistry,
  };
}