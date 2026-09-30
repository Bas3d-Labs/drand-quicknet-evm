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
  reconcileDurableRequests,
  type DurableRequestResult,
} from '../consumers/durable-requests.js';

import {
  processQuicknetRequests,
  type ProcessedQuicknetRound,
  type ProcessQuicknetRequestsResult,
} from '../consumers/request-processor.js';

import {
  scanQuicknetRequests,
} from '../consumers/request-scanner.js';

import type {
  OperationContext,
} from '../diagnostics/operation-context.js';

export interface SoftScanCursor {
  nextBlock: bigint;
}

export interface ProcessedDaemonScan {
  fromBlock: bigint;
  toBlock: bigint;
  nextBlock: bigint;
  processing: ProcessQuicknetRequestsResult;
  reconciliation?: DurableRequestResult;
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
  readChainHeads?: () => Promise<ChainHeads>;
  onOperation?: (operation: OperationContext) => void;
  onCompleted?: (
    scanType: 'durable' | 'soft',
    result: ProcessedQuicknetRound,
  ) => void;
  onReconciliation?: (
    result: DurableRequestResult,
  ) => void;
}

export interface RunDaemonIterationResult {
  status: 'caught-up' | 'processed' | 'deferred';
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

  let currentOperation: OperationContext | undefined;

  function reportOperation(operation: OperationContext): void {
    currentOperation = operation;

    try {
      options.onOperation?.(operation);
    } catch {
      // Reporting must not change processing or replace its error.
    }
  }

  function reportCompleted(
    scanType: 'durable' | 'soft',
    result: ProcessedQuicknetRound,
  ): void {
    try {
      options.onCompleted?.(scanType, result);
    } catch {
      // Reporting must not change processing or replace its error.
    }
  }

  validateOptions(options);

  reportOperation({ name: 'load-checkpoint' });

  const checkpoint = await options.checkpointStore.load(options.consumer);
  let durableNextBlock = checkpoint ?? options.startBlock;

  reportOperation({ name: 'read-chain-heads' });

  let heads: ChainHeads;

  if (options.readChainHeads !== undefined) {
    heads = await options.readChainHeads();
  } else {
    heads = await getChainHeads({
      publicClient: options.publicClient,
      finality: options.finality,
    });
  }

  const durableHeadRegressed =
    checkpoint !== undefined &&
    checkpoint > 0n &&
    heads.durableBlock < checkpoint - 1n;

  let durableScan: ProcessedDaemonScan | undefined;
  
  if (hasDurableBlocksToScan(durableNextBlock, heads.durableBlock)) {
    reportOperation({
      name: 'scan-requests',
      scanType: 'durable',
      fromBlock: durableNextBlock,
      throughBlock: heads.durableBlock,
      maxBlockRange: options.maxBlockRange,
    });

    const reconciliation = await reconcileDurableRequests({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: options.account,
      deployment: options.deployment,
      consumer: options.consumer,
      nextBlock: durableNextBlock,
      durableBlock: heads.durableBlock,
      maxBlockRange: options.maxBlockRange,

      onCompleted(result) {
        reportCompleted('durable', result);
      },

      onProgress(progress) {
        reportOperation({
          name: 'import-round',
          scanType: 'durable',
          fromBlock: durableNextBlock,
          toBlock: minimum(
            durableNextBlock + options.maxBlockRange - 1n,
            heads.durableBlock,
          ),
          ...progress,
        });
      },
    });

    try {
      options.onReconciliation?.(reconciliation);
    } catch {
      // Reporting must not change checkpoint eligibility.
    }

    const importFailure = reconciliation.imports.find(
      outcome => outcome.status === 'failed',
    );

    const importOperation = currentOperation;
    const decision = reconciliation.checkpoint;

    if (
      decision.status === 'verified' &&
      decision.nextBlock > durableNextBlock
    ) {
      reportOperation({
        name: 'save-checkpoint',
        nextBlock: decision.nextBlock,
      });

      try {
        await options.checkpointStore.save(
          options.consumer,
          decision.nextBlock,
        );
      } catch (saveError) {
        if (importFailure !== undefined) {
          throw new AggregateError(
            [saveError, importFailure.error],
            'Checkpoint persistence failed after a round import failed.',
          );
        }

        throw saveError;
      }

      durableNextBlock = decision.nextBlock;
    }

    const rounds: ProcessedQuicknetRound[] = [];

    for (const outcome of reconciliation.imports) {
      if (outcome.status === 'completed') {
        rounds.push({
          round: outcome.round,
          result: outcome.result,
        });
      }
    }

    if (reconciliation.status === 'scanned') {
      durableScan = {
        fromBlock: reconciliation.fromBlock,
        toBlock: reconciliation.toBlock,
        nextBlock: durableNextBlock,
        processing: { rounds },
        reconciliation,
      };
    }

    if (importFailure !== undefined) {
      if (importOperation !== undefined) {
        reportOperation(importOperation);
      }

      throw importFailure.error;
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

  reportOperation({
    name: 'scan-requests',
    scanType: 'soft',
    fromBlock: softNextBlock,
    throughBlock: heads.latestBlock,
    maxBlockRange: options.maxBlockRange,
  });

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
    reportOperation({
      name: 'process-requests',
      scanType: 'soft',
      fromBlock: softResult.fromBlock,
      toBlock: softResult.toBlock,
    });

    const processing = await processQuicknetRequests({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: options.account,
      deployment: options.deployment,
      requests: softResult.requests,
      onProgress(progress) {
        reportOperation({
          name: 'import-round',
          scanType: 'soft',
          fromBlock: softResult.fromBlock,
          toBlock: softResult.toBlock,
          ...progress,
        });
      },
      onCompleted(result) {
        reportCompleted('soft', result);
      },
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

function minimum(
  first: bigint,
  second: bigint,
): bigint {
  if (first < second) {
    return first;
  }

  return second;
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
  let status: RunDaemonIterationResult['status'] = 'caught-up';

  if (
    options.durableScan !== undefined ||
    options.softScan !== undefined
  ) {
    status = 'processed';
  } else if (options.durableNextBlock <= options.heads.durableBlock) {
    status = 'deferred';
  }

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