import type {
  PublicClient,
} from 'viem';

import {
  getDurableBlockNumber,
  type FinalityPolicy,
} from './finality-policy.js';

export interface ChainHeads {
  latestBlock: bigint;
  durableBlock: bigint;
  latestBlockObservedAt?: string;
  durableBlockObservedAt?: string;
}

export interface GetChainHeadsOptions {
  publicClient: PublicClient;
  finality: FinalityPolicy;

  /** Optional diagnostic wall clock. Never participates in cache expiry. */
  observationClock?: (() => number) | undefined;
}

export async function getChainHeads(
  options: GetChainHeadsOptions,
): Promise<ChainHeads> {
  const durableBlock = await getDurableBlockNumber(
    options.publicClient,
    options.finality,
  );

  const durableObservation = observeHeadTime(
    options.observationClock,
    'durableBlockObservedAt',
  );

  const latestBlock = await options.publicClient.getBlockNumber({
    cacheTime: 0,
  });

  if (durableBlock > latestBlock) {
    throw new Error(
      `Durable block ${durableBlock} is ahead of latest block ${latestBlock}.`
    );
  }

  return {
    latestBlock,
    durableBlock,
    ...durableObservation,
    ...observeHeadTime(options.observationClock, 'latestBlockObservedAt'),
  };
}

/** A diagnostic clock must not replace an RPC result or invent an observation. */
export function observeHeadTime(
  clock: (() => number) | undefined,
  field: 'latestBlockObservedAt' | 'durableBlockObservedAt',
): Pick<ChainHeads, 'latestBlockObservedAt' | 'durableBlockObservedAt'> {
  if (clock === undefined) {
    return {};
  }

  try {
    const milliseconds = clock();

    if (!Number.isSafeInteger(milliseconds)) {
      return {};
    }

    return { [field]: new Date(milliseconds).toISOString() };
  } catch {
    return {};
  }
}
