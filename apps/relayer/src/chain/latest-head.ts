import type {
  PublicClient,
} from 'viem';

import {
  observeHeadTime,
} from './chain-heads.js';

export interface LatestHead {
  latestBlock: bigint;
  latestBlockObservedAt?: string;
}

export interface ReadLatestHeadOptions {
  publicClient: Pick<PublicClient, 'getBlockNumber'>;
  observationClock?: (() => number) | undefined;
}

/** Discovery has no durable-head reader or cache to refresh. */
export async function readLatestHead(
  options: ReadLatestHeadOptions,
): Promise<LatestHead> {
  const latestBlock = await options.publicClient.getBlockNumber({
    cacheTime: 0,
  });

  return {
    latestBlock,
    ...observeHeadTime(options.observationClock, 'latestBlockObservedAt'),
  };
}
