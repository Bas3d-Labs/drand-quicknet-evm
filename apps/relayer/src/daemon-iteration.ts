import type {
  Account,
  Address,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  CheckpointStore,
} from './checkpoint.js';

import {
  processQuicknetRequests,
  type ProcessQuicknetRequestsResult,
} from './request-processor.js';

import {
  scanQuicknetRequests,
} from './request-scanner.js';

export interface RunDaemonIterationOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumer: Address;
  startBlock: bigint;
  maxBlockRange: bigint;
}

export type RunDaemonIterationResult =
  | {
      status: 'caught-up';
      consumer: Address;
      headBlock: bigint;
      nextBlock: bigint;
    }
  | {
      status: 'processed';
      consumer: Address;
      headBlock: bigint;
      fromBlock: bigint;
      toBlock: bigint;
      nextBlock: bigint;
      processing: ProcessQuicknetRequestsResult;
    };

export async function runDaemonIteration(
  options: RunDaemonIterationOptions,
): Promise<RunDaemonIterationResult> {
  if (options.startBlock < 0n) {
    throw new Error('startBlock must not be negative.');
  }

  const checkpoint = await options.checkpointStore.load(options.consumer);
  const nextBlock = checkpoint ?? options.startBlock;

  const scan = await scanQuicknetRequests({
    publicClient: options.publicClient,
    consumers: [
      options.consumer,
    ],
    nextBlock,
    maxBlockRange: options.maxBlockRange,
  });

  if (scan.status === 'caught-up') {
    return {
      status: 'caught-up',
      consumer: options.consumer,
      headBlock: scan.headBlock,
      nextBlock: scan.nextBlock,
    };
  }

  const processing = await processQuicknetRequests({
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    account: options.account,
    deployment: options.deployment,
    requests: scan.requests,
  });

  await options.checkpointStore.save(options.consumer, scan.nextBlock);

  return {
    status: 'processed',
    consumer: options.consumer,
    headBlock: scan.headBlock,
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    nextBlock: scan.nextBlock,
    processing,
  };
}