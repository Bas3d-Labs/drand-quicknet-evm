import { performance } from 'node:perf_hooks';

import {
  getChainHeads,
  type ChainHeads,
  type GetChainHeadsOptions,
} from './chain-heads.js';

export interface CreateChainHeadsReaderOptions
  extends GetChainHeadsOptions {
  durableHeadPollIntervalMs: number;
  now?: () => number;
}

interface CachedDurableHead {
  blockNumber: bigint;
  readStartedAt: number;
}

// Create one reader per daemon and use it sequentially.
export function createChainHeadsReader(
  options: CreateChainHeadsReaderOptions,
): () => Promise<ChainHeads> {
  const intervalMs = options.durableHeadPollIntervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(
      'durableHeadPollIntervalMs must be a positive safe integer.'
    );
  }

  const publicClient = options.publicClient;
  const finality = { ...options.finality };
  const now = options.now ?? (() => performance.now());

  let cached: CachedDurableHead | undefined;

  return async function readChainHeads(): Promise<ChainHeads> {
    if (finality.type === 'confirmations') {
      return getChainHeads({
        publicClient,
        finality,
      });
    }

    const readStartedAt = now();
    const previous = cached;

    if (
      previous === undefined ||
      readStartedAt - previous.readStartedAt >= intervalMs
    ) {
      cached = undefined;

      const heads = await getChainHeads({
        publicClient,
        finality,
      });

      cached = {
        blockNumber: heads.durableBlock,
        readStartedAt,
      };

      return heads;
    }

    try {
      const latestBlock = await publicClient.getBlockNumber({
        cacheTime: 0,
      });
      const durableBlock = previous.blockNumber;

      if (durableBlock > latestBlock) {
        throw new Error(
          `Durable block ${durableBlock} is ahead of latest block ${latestBlock}.`
        )
      }

      return {
        latestBlock,
        durableBlock,
      };
    } catch (error) {
      cached = undefined;
      throw error;
    }
  };
}