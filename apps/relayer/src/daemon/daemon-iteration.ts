import type {
  Account,
  Address,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  getChainHeads,
  type ChainHeads,
} from '../chain/chain-heads.js';

import type {
  CheckpointStore,
} from '../state/checkpoint.js';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import {
  processQuicknetRequests,
  type ProcessQuicknetRequestsResult,
} from '../consumers/request-processor.js';

import {
  scanQuicknetRequests,
} from '../consumers/request-scanner.js';

export interface SoftScanCursor {
  nextBlock: bigint;
}

export interface ProcessedDaemonScan {
  fromBlock: bigint;
  toBlock: bigint;
  nextBlock: bigint;
  processing: ProcessQuicknetRequestsResult;
}

export interface RunDaemonIterationOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumer: Address;
  startBlock: bigint;
  maxBlockRange: bigint;
  finality: FinalityPolicy;
  softCursor?: SoftScanCursor;
}

export interface RunDaemonIterationResult {
  status: 'caught-up' | 'processed';
  consumer: Address;
  latestBlock: bigint;
  durableBlock: bigint;
  durableNextBlock: bigint;
  durableHeadRegressed: boolean;
  softCursor: SoftScanCursor;
  durableScan: ProcessedDaemonScan | undefined;
  softScan: ProcessedDaemonScan | undefined;
}

export async function runDaemonIteration(
  options: RunDaemonIterationOptions,
): Promise<RunDaemonIterationResult> {
  validateOptions(options);

  const checkpoint = await options.checkpointStore.load(options.consumer);
  let durableNextBlock = checkpoint ?? options.startBlock;

  const heads = await getChainHeads({
    publicClient: options.publicClient,
    finality: options.finality,
  });

  const durableHeadRegressed =
    checkpoint !== undefined &&
    checkpoint > 0n &&
    heads.durableBlock < checkpoint - 1n;

  let durableScan: ProcessedDaemonScan | undefined;
  
  if (hasDurableBlocksToScan(durableNextBlock, heads.durableBlock)) {
    const durableResult = await scanQuicknetRequests({
      publicClient: options.publicClient,
      consumers: [
        options.consumer,
      ],
      nextBlock: durableNextBlock,
      throughBlock: heads.durableBlock,
      maxBlockRange: options.maxBlockRange,
    });

    if (durableResult.status === 'scanned') {
      const processing = await processQuicknetRequests({
        publicClient: options.publicClient,
        walletClient: options.walletClient,
        account: options.account,
        deployment: options.deployment,
        requests: durableResult.requests,
      });

      await options.checkpointStore.save(
        options.consumer,
        durableResult.nextBlock,
      );

      durableNextBlock = durableResult.nextBlock;

      durableScan = {
        fromBlock: durableResult.fromBlock,
        toBlock: durableResult.toBlock,
        nextBlock: durableResult.nextBlock,
        processing,
      };
    }
  }

  const softNextBlock = getSoftNextBlock(
    options.softCursor,
    durableNextBlock,
    heads.durableBlock,
  );
  let softCursor: SoftScanCursor = {
    nextBlock: softNextBlock,
  };

  let softScan:
    ProcessedDaemonScan |
    undefined;

  const softResult = await scanQuicknetRequests({
    publicClient: options.publicClient,
    consumers: [
      options.consumer,
    ],
    nextBlock: softNextBlock,
    throughBlock: heads.latestBlock,
    maxBlockRange: options.maxBlockRange,
  });

  if (softResult.status === 'scanned') {
    const processing = await processQuicknetRequests({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: options.account,
      deployment: options.deployment,
      requests: softResult.requests,
    });

    softCursor = {
      nextBlock: softResult.nextBlock,
    };
    softScan = {
      fromBlock: softResult.fromBlock,
      toBlock: softResult.toBlock,
      nextBlock: softResult.nextBlock,
      processing,
    };
  }

  return createResult({
    consumer: options.consumer,
    heads,
    durableNextBlock,
    durableHeadRegressed,
    softCursor,
    durableScan,
    softScan,
  });
}

interface CreateResultOptions {
  consumer: Address;
  heads: ChainHeads;
  durableNextBlock: bigint;
  durableHeadRegressed: boolean;
  softCursor: SoftScanCursor;
  durableScan:
    ProcessedDaemonScan |
    undefined;
  softScan:
    ProcessedDaemonScan |
    undefined;
}

function createResult(
  options: CreateResultOptions,
): RunDaemonIterationResult {
  const status =
    options.durableScan !== undefined ||
    options.softScan !== undefined
      ? 'processed'
      : 'caught-up';

  return {
    status,
    consumer: options.consumer,
    latestBlock: options.heads.latestBlock,
    durableBlock: options.heads.durableBlock,
    durableNextBlock: options.durableNextBlock,
    durableHeadRegressed: options.durableHeadRegressed,
    softCursor: options.softCursor,
    durableScan: options.durableScan,
    softScan: options.softScan,
  };
}

function getSoftNextBlock(
  softCursor: SoftScanCursor | undefined,
  durableNextBlock: bigint,
  durableBlock: bigint,
): bigint {
  const firstNonDurableBlock = durableBlock + 1n;

  let minimumSoftBlock = durableNextBlock;
  if (firstNonDurableBlock > minimumSoftBlock) {
    minimumSoftBlock = firstNonDurableBlock;
  }

  if (softCursor === undefined || softCursor.nextBlock < minimumSoftBlock) {
    return minimumSoftBlock;
  }

  return softCursor.nextBlock;
}

function validateOptions(
  options: RunDaemonIterationOptions,
): void {
  if (options.startBlock < 0n) {
    throw new Error('startBlock must not be negative.');
  }

  if (options.maxBlockRange <= 0n) {
    throw new Error('maxBlockRange must be greater than zero.');
  }

  if (options.softCursor !== undefined && options.softCursor.nextBlock < 0n) {
    throw new Error('Soft cursor nextBlock must not be negative.');
  }
}

function hasDurableBlocksToScan(
  durableNextBlock: bigint,
  durableBlock: bigint,
): boolean {
  return durableNextBlock <= durableBlock;
}