import type {
  Address,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  validateQuicknetConsumer,
  type ValidatedQuicknetConsumer,
} from './consumer.js';

export interface ValidateQuicknetConsumersOptions {
  publicClient: PublicClient;
  deployment: RegistryDeployment;
  consumers: readonly Address[];
}

export async function validateQuicknetConsumers(
  options: ValidateQuicknetConsumersOptions,
): Promise<readonly ValidatedQuicknetConsumer[]> {
  const validatedConsumers: ValidatedQuicknetConsumer[] = [];
  
  for (const consumer of options.consumers) {
    validatedConsumers.push(
      await validateQuicknetConsumer({
        publicClient: options.publicClient,
        consumer,
        deployment: options.deployment,
      })
    );
  }

  return validatedConsumers;
}