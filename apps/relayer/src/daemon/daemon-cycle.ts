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
} from '../state/checkpoint.js';

import type {
  ProcessedQuicknetRound,
} from '../consumers/request-processor.js';

import type {
  DurableRequestResult,
} from '../consumers/durable-requests.js';

import type {
  ValidatedQuicknetConsumer,
} from '../consumers/consumer.js';

import {
  runDaemonIteration,
  type RunDaemonIterationResult,
  type SoftScanCursor,
} from '../daemon/daemon-iteration.js';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import type {
  OperationContext,
} from '../diagnostics/operation-context.js';

export interface RunDaemonCycleOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumers: readonly ValidatedQuicknetConsumer[];
  startBlock: bigint;
  maxBlockRange: bigint;
  finality: FinalityPolicy;
  softCursors: Map<Address, SoftScanCursor>;
  readChainHeads?: () => Promise<ChainHeads>;
}

export type DaemonConsumerCycleResult =
  | {
      status: 'success';
      consumer: ValidatedQuicknetConsumer;
      iteration: RunDaemonIterationResult;
      reconciliation?: DurableRequestResult;
    }
  | {
      status: 'failed';
      consumer: ValidatedQuicknetConsumer;
      error: unknown;
      operation?: OperationContext;
      completed?: readonly {
        scanType: 'durable' | 'soft';
        result: ProcessedQuicknetRound;
      }[];
      reconciliation?: DurableRequestResult;
    };

export interface RunDaemonCycleResult {
  consumers: readonly DaemonConsumerCycleResult[];
}

export async function runDaemonCycle(
  options: RunDaemonCycleOptions,
): Promise<RunDaemonCycleResult> {
  const consumers: DaemonConsumerCycleResult[] = [];
  for (const consumer of options.consumers) {
    let operation: OperationContext | undefined;

    const completed: {
      scanType: 'durable' | 'soft';
      result: ProcessedQuicknetRound;
    }[] = [];

    let reconciliation: DurableRequestResult | undefined;

    try {
      const softCursor = options.softCursors.get(consumer.address);
      const iteration = await runDaemonIteration({
        publicClient: options.publicClient,
        walletClient: options.walletClient,
        account: options.account,
        deployment: options.deployment,
        checkpointStore: options.checkpointStore,
        consumer: consumer.address,
        startBlock: options.startBlock,
        maxBlockRange: options.maxBlockRange,
        finality: options.finality,
        onOperation(current) {
          operation = current;
        },
        onCompleted(scanType, result) {
          completed.push({ scanType, result });
        },
        onReconciliation(result) {
          reconciliation = result;
        },
        ...(softCursor === undefined
          ? {}
          : {
              softCursor,
            }),
        ...(options.readChainHeads !== undefined
          ? { readChainHeads: options.readChainHeads }
          : {}),
      });

      options.softCursors.set(consumer.address, iteration.softCursor);

      const successful: Extract<
        DaemonConsumerCycleResult,
        { status: 'success' }
      > = {
        status: 'success',
        consumer,
        iteration,
      };

      if (reconciliation !== undefined) {
        successful.reconciliation = reconciliation;
      }

      consumers.push(successful);
    } catch (error) {
      const failed: Extract<
        DaemonConsumerCycleResult,
        { status: 'failed' }
      > = {
        status: 'failed',
        consumer,
        error,
      };

      if (operation !== undefined) {
        failed.operation = operation;
      }

      if (completed.length > 0) {
        failed.completed = completed;
      }

      if (reconciliation !== undefined) {
        failed.reconciliation = reconciliation;
      }

      consumers.push(failed);
    }
  }

  return {
    consumers,
  };
}