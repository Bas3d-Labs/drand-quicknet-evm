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
  throughBlock: bigint;
  maxBlockRange: bigint;
}

export type ScanQuicknetRequestsResult =
  | {
      status: 'caught-up';
      throughBlock: bigint;
      nextBlock: bigint;
    }
  | {
      status: 'scanned';
      throughBlock: bigint;
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

  if (options.throughBlock < 0n) {
    throw new Error('throughBlock must not be negative.');
  }

  if (options.maxBlockRange <= 0n) {
    throw new Error('maxBlockRange must be greater than zero.');
  }

  if (options.nextBlock > options.throughBlock) {
    return {
      status: 'caught-up',
      throughBlock: options.throughBlock,
      nextBlock: options.nextBlock,
    };
  }

  const maximumToBlock = options.nextBlock + options.maxBlockRange - 1n;
  const toBlock = maximumToBlock < options.throughBlock
    ? maximumToBlock
    : options.throughBlock;

  const requests = await getQuicknetRandomnessRequests({
    publicClient: options.publicClient,
    consumers: options.consumers,
    fromBlock: options.nextBlock,
    toBlock,
  });

  return {
    status: 'scanned',
    throughBlock: options.throughBlock,
    fromBlock: options.nextBlock,
    toBlock,
    nextBlock: toBlock + 1n,
    requests,
  };
}