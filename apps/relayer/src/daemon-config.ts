import {
  getAddress,
  type Address,
} from 'viem';

import {
  loadRelayerConfig,
  type RelayerConfig,
  type RelayerNetwork,
} from './config.js';

export interface DaemonConfig extends RelayerConfig {
  consumers: readonly Address[];
}

export interface LoadDaemonConfigOptions {
  network: RelayerNetwork;
  env?: NodeJS.ProcessEnv;
}

export async function loadDaemonConfig(
  options: LoadDaemonConfigOptions,
): Promise<DaemonConfig> {
  const env = options.env ?? process.env;
  const relayer = await loadRelayerConfig({
    network: options.network,
    env,
  });
  const consumers = parseConsumerAddresses(env.QUICKNET_CONSUMERS);

  return {
    ...relayer,
    consumers,
  };
}

export function parseConsumerAddresses(
  value: string | undefined,
): readonly Address[] {
  if (value === undefined) {
    throw new Error('Missing required environment variable: QUICKNET_CONSUMERS.');
  }

  const entries = value.split(',')
    .map((entry) => entry.trim());

  const consumers: Address[] = [];
  const seen = new Set<Address>();
  for (const entry of entries) {
    if (entry.length === 0) {
      throw new Error('QUICKNET_CONSUMERS contains an empty consumer address.');
    }

    let address: Address;
    try {
      address = getAddress(entry);
    } catch (cause) {
      throw new Error(
        `Invalid Quicknet consumer address: ${entry}.`,
        { cause }
      );
    }

    if (seen.has(address)) {
      continue;
    }

    seen.add(address);
    consumers.push(address);
  }

  if (consumers.length === 0) {
    throw new Error('QUICKNET_CONSUMERS must contain at least one consumer address.');
  }

  return consumers;
}