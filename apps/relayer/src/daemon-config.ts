import {
  getAddress,
  type Address,
} from 'viem';

import {
  loadRelayerConfig,
  type RelayerConfig,
  type RelayerNetwork,
} from './config.js';

const DECIMAL_DIGITS = new Set([
  '0','1','2','3','4','5','6','7','8','9'
]);

export interface DaemonConfig extends RelayerConfig {
  consumers: readonly Address[];
  startBlock: bigint;
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
  const startBlock = parseStartBlock(env.QUICKNET_START_BLOCK);

  return {
    ...relayer,
    consumers,
    startBlock,
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

export function parseStartBlock(
  value: string | undefined,
): bigint {
  if (value === undefined) {
    throw new Error('Missing required environment variable: QUICKNET_START_BLOCK.');
  }

  if (value.length === 0) {
    throw new Error('QUICKNET_START_BLOCK must be a non-negative decimal integer.');
  }

  for (const character of value) {
    if (!DECIMAL_DIGITS.has(character)) {
      throw new Error('QUICKNET_START_BLOCK must be a non-negative decimal integer.');
    }
  }

  return BigInt(value);
}