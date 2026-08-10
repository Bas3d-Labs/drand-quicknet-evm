import type {
  Address,
  PublicClient,
} from 'viem';

import {
  getQuicknetRandomnessRequests,
  type QuicknetRandomnessRequest,
} from './request-events.js';

export interface ScanQuicknetRequestOptions {
  publicClient: PublicClient;
  consumers: readonly Address[];
  nextBlock: bigint;
  maxBlockRange: bigint;
}

export type ScanQuicknetRequestsResult =
  | {
      status: 'caught-up';
      headBlock: bigint;
      nextBlock: bigint;
    }
  | {
      status: 'scanned';
      headBlock: bigint;
      fromBlock: bigint;
      toBlock: bigint;
      nextBlock: bigint;
      requests: readonly QuicknetRandomnessRequest[];
    };

export async function scanQuicknetRequests(
  options: ScanQuicknetRequestOptions,
): Promise<ScanQuicknetRequestsResult> {
  if (options.nextBlock < 0n) {
    throw new Error('nextBlock must not be negative.');
  }

  if (options.maxBlockRange <= 0n) {
    throw new Error('maxBlockRange must be greater than zero.');
  }

  const headBlock = await options.publicClient.getBlockNumber();
  if (options.nextBlock > headBlock) {
    return {
      status: 'caught-up',
      headBlock,
      nextBlock: options.nextBlock,
    };
  }

  const maximumToBlock = options.nextBlock + options.maxBlockRange - 1n;
  const toBlock = maximumToBlock < headBlock
    ? maximumToBlock
    : headBlock;

  const requests = await getQuicknetRandomnessRequests({
    publicClient: options.publicClient,
    consumers: options.consumers,
    fromBlock: options.nextBlock,
    toBlock,
  });

  return {
    status: 'scanned',
    headBlock,
    fromBlock: options.nextBlock,
    toBlock,
    nextBlock: toBlock + 1n,
    requests,
  };
}