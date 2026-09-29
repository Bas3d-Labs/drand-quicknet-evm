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
    }
  | {
      status: 'failed';
      consumer: ValidatedQuicknetConsumer;
      error: unknown;
      operation?: OperationContext;
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

      consumers.push({
        status: 'success',
        consumer,
        iteration,
      });
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

      consumers.push(failed);
    }
  }

  return {
    consumers,
  };
}