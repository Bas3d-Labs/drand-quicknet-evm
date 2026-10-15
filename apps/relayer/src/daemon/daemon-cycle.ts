import type {
  Address,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  CheckpointStore,
} from '../state/checkpoint.js';

import type {
  IncompleteQuicknetRoundOutcome,
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
  type RunDaemonIterationOptions,
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

import type {
  BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import type {
  RoundImporterBinder,
} from '../rounds/create-round-importer.js';

export interface RunDaemonCycleOptions {
  publicClient: PublicClient;
  submitter: BeaconSubmitter;
  bindRoundImporter: RoundImporterBinder;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumers: readonly ValidatedQuicknetConsumer[];
  startBlock: bigint;
  maxBlockRange: bigint;
  finality: FinalityPolicy;
  softCursors: Map<Address, SoftScanCursor>;
  readChainHeads?: () => Promise<ChainHeads>;
  signal?: AbortSignal;
}

export interface DaemonIncompleteRound {
  scanType: 'durable' | 'soft';
  outcome: IncompleteQuicknetRoundOutcome;
}

type DaemonConsumerCycleResult =
  | {
      status: 'success';
      consumer: ValidatedQuicknetConsumer;
      iteration: RunDaemonIterationResult;
      incomplete?: readonly DaemonIncompleteRound[];
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
      incomplete?: readonly DaemonIncompleteRound[];
      reconciliation?: DurableRequestResult;
    };

export interface RunDaemonCycleResult {
  consumers: readonly DaemonConsumerCycleResult[];
}

export async function runDaemonCycle(
  options: RunDaemonCycleOptions,
): Promise<RunDaemonCycleResult> {
  options.signal?.throwIfAborted();

  try {
    await options.submitter.recover();
  } catch (error) {
    if (
      options.signal?.aborted &&
      error === options.signal.reason
    ) {
      throw error;
    }

    // Recovery failure prevents this cycle from preparing transactions.
    // Use the existing consumer-failure reporting and retry next cycle.
    return {
      consumers: options.consumers.map((consumer) => ({
        status: 'failed' as const,
        consumer,
        error,
      })),
    };
  }

  const consumers: DaemonConsumerCycleResult[] = [];
  for (const consumer of options.consumers) {
    if (options.signal?.aborted) {
      break;
    }

    let operation: OperationContext | undefined;

    const completed: {
      scanType: 'durable' | 'soft';
      result: ProcessedQuicknetRound;
    }[] = [];
    const incomplete: DaemonIncompleteRound[] = [];

    let reconciliation: DurableRequestResult | undefined;

    try {
      const softCursor = options.softCursors.get(consumer.address);
      const iterationOptions: RunDaemonIterationOptions = {
        publicClient: options.publicClient,
        bindRoundImporter: options.bindRoundImporter,
        submitter: options.submitter,
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

        onIncomplete(scanType, outcome) {
          incomplete.push({ scanType, outcome });
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
      };

      if (options.signal !== undefined) {
        iterationOptions.signal = options.signal;
      }

      const iteration = await runDaemonIteration(iterationOptions);

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

      if (incomplete.length > 0) {
        successful.incomplete = incomplete;
      }

      consumers.push(successful);
    } catch (error) {
      if (
        options.signal?.aborted &&
        error === options.signal.reason
      ) {
        throw error;
      }

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

      if (incomplete.length > 0) {
        failed.incomplete = incomplete;
      }

      consumers.push(failed);
    }
  }

  return {
    consumers,
  };
}