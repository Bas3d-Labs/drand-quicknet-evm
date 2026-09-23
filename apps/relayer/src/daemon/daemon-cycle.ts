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
  FinalityPolicy,
} from '../chain/finality-policy.js';

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
    };

export interface RunDaemonCycleResult {
  consumers: readonly DaemonConsumerCycleResult[];
}

export async function runDaemonCycle(
  options: RunDaemonCycleOptions,
): Promise<RunDaemonCycleResult> {
  const consumers: DaemonConsumerCycleResult[] = [];
  for (const consumer of options.consumers) {
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
        ...(softCursor === undefined
          ? {}
          : {
              softCursor,
            }),
      });

      options.softCursors.set(consumer.address, iteration.softCursor);

      consumers.push({
        status: 'success',
        consumer,
        iteration,
      });
    } catch (error) {
      consumers.push({
        status: 'failed',
        consumer,
        error,
      });
    }
  }

  return {
    consumers,
  };
}