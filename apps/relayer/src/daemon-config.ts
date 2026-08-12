import {
  getAddress,
  type Address,
} from 'viem';

import {
  loadRelayerConfig,
  type RelayerConfig,
  type RelayerNetwork,
} from './config.js';
import { isDecimalInteger } from './decimal.js';

export const DEFAULT_MAX_BLOCK_RANGE = 2000n;
export const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface DaemonConfig extends RelayerConfig {
  consumers: readonly Address[];
  startBlock: bigint;
  checkpointFile: string;
  maxBlockRange: bigint;
  pollIntervalMs: number;
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
  const checkpointFile = parseCheckpointFile(env.QUICKNET_CHECKPOINT_FILE);
  const maxBlockRange = parseMaxBlockRange(env.QUICKNET_MAX_BLOCK_RANGE);
  const pollIntervalMs = parsePollIntervalMs(env.QUICKNET_POLL_INTERVAL_MS);

  return {
    ...relayer,
    consumers,
    startBlock,
    checkpointFile,
    maxBlockRange,
    pollIntervalMs,
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

  return consumers;
}

export function parseStartBlock(
  value: string | undefined,
): bigint {
  if (value === undefined) {
    throw new Error('Missing required environment variable: QUICKNET_START_BLOCK.');
  }

  if (!isDecimalInteger(value)) {
    throw new Error('QUICKNET_START_BLOCK must be a non-negative decimal integer.');
  }

  return BigInt(value);
}

export function parseCheckpointFile(
  value: string | undefined,
): string {
  if (value === undefined) {
    throw new Error('Missing required environment variable: QUICKNET_CHECKPOINT_FILE.');
  }

  if (value.trim().length === 0) {
    throw new Error('QUICKNET_CHECKPOINT_FILE must not be empty.');
  }

  return value;
}

export function parseMaxBlockRange(
  value: string | undefined,
): bigint {
  if (value === undefined) {
    return DEFAULT_MAX_BLOCK_RANGE;
  }

  if (!isDecimalInteger(value)) {
    throw new Error('QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.');
  }

  const parsed = BigInt(value);
  if (parsed === 0n) {
    throw new Error('QUICKNET_MAX_BLOCK_RANGE must be a positive decimal integer.');
  }

  return parsed;
}

export function parsePollIntervalMs(
  value: string | undefined
): number {
  if (value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  if (!isDecimalInteger(value)) {
    throw new Error('QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.');
  }

  const parsed = BigInt(value);
  if (parsed === 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('QUICKNET_POLL_INTERVAL_MS must be a positive safe integer.');
  }

  return Number(parsed);
}