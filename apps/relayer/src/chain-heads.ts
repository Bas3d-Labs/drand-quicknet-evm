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
}

export interface GetChainHeadsOptions {
  publicClient: PublicClient;
  finality: FinalityPolicy;
}

export async function getChainHeads(
  options: GetChainHeadsOptions,
): Promise<ChainHeads> {
  const durableBlock = await getDurableBlockNumber(
    options.publicClient,
    options.finality,
  );
  const latestBlock = await options.publicClient.getBlockNumber();
  if (durableBlock > latestBlock) {
    throw new Error(
      `Durable block ${durableBlock} is ahead of latest block ${latestBlock}.`
    );
  }

  return {
    latestBlock,
    durableBlock,
  };
}