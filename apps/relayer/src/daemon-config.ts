import process from 'node:process';

import {
  getAddress,
  type Address,
} from 'viem';

import {
  RelayerConfigError,
} from './config-errors.js';

import {
  loadRelayerConfig,
  type NetworkSource,
  type RelayerConfig,
} from './config.js';

import {
  isDecimalInteger,
} from './decimal.js';

export const DEFAULT_MAX_BLOCK_RANGE = 2_000n;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface DaemonConfig extends RelayerConfig {
  consumers: readonly Address[];
  startBlock: bigint;
  checkpointFile: string;
  maxBlockRange: bigint;
  pollIntervalMs: number;
}

export interface LoadDaemonConfigOptions {
  source: NetworkSource;
  env?: NodeJS.ProcessEnv;
}

export async function loadDaemonConfig(
  options: LoadDaemonConfigOptions,
): Promise<DaemonConfig> {
  const env = options.env ?? process.env;
  const relayer = await loadRelayerConfig({
    source: options.source,
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
    throw new RelayerConfigError(
      'MISSING_REQUIRED_SETTING',
      'QUICKNET_CONSUMERS'
    );
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim());

  const consumers: Address[] = [];
  const seen = new Set<Address>();

  for (const entry of entries) {
    if (entry.length === 0) {
      throw new RelayerConfigError(
        'EMPTY_CONSUMER',
        'QUICKNET_CONSUMERS',
      );
    }

    let address: Address;
    try {
      address = getAddress(entry);
    } catch (cause) {
      throw new RelayerConfigError(
        'INVALID_CONSUMER',
        'QUICKNET_CONSUMERS',
        { cause },
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
    throw new RelayerConfigError(
      'MISSING_REQUIRED_SETTING',
      'QUICKNET_START_BLOCK',
    );
  }

  if (!isDecimalInteger(value)) {
    throw new RelayerConfigError(
      'INVALID_START_BLOCK',
      'QUICKNET_START_BLOCK',
    );
  }

  return BigInt(value);
}

export function parseCheckpointFile(
  value: string | undefined,
): string {
  if (value === undefined) {
    throw new RelayerConfigError(
      'MISSING_REQUIRED_SETTING',
      'QUICKNET_CHECKPOINT_FILE',
    );
  }

  if (value.trim().length === 0) {
    throw new RelayerConfigError(
      'EMPTY_CHECKPOINT_FILE',
      'QUICKNET_CHECKPOINT_FILE',
    );
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
    throw new RelayerConfigError(
      'INVALID_BLOCK_RANGE',
      'QUICKNET_MAX_BLOCK_RANGE',
    );
  }

  const parsed = BigInt(value);
  if (parsed === 0n) {
    throw new RelayerConfigError(
      'INVALID_BLOCK_RANGE',
      'QUICKNET_MAX_BLOCK_RANGE',
    );
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
    throw new RelayerConfigError(
      'INVALID_POLL_INTERVAL',
      'QUICKNET_POLL_INTERVAL_MS',
    );
  }

  const parsed = BigInt(value);
  if (parsed === 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RelayerConfigError(
      'INVALID_POLL_INTERVAL',
      'QUICKNET_POLL_INTERVAL_MS',
    );
  }

  return Number(parsed);
}