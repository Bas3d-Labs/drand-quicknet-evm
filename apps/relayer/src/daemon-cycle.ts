import type {
  Account,
  PublicClient,
  WalletClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  CheckpointStore,
} from './checkpoint.js';

import type {
  ValidatedQuicknetConsumer,
} from './consumer.js';

import {
  runDaemonIteration,
  type RunDaemonIterationResult,
} from './daemon-iteration.js';

export interface RunDaemonCycleOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumers: readonly ValidatedQuicknetConsumer[];
  startBlock: bigint;
  maxBlockRange: bigint;
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
      const iteration = await runDaemonIteration({
        publicClient: options.publicClient,
        walletClient: options.walletClient,
        account: options.account,
        deployment: options.deployment,
        checkpointStore: options.checkpointStore,
        consumer: consumer.address,
        startBlock: options.startBlock,
        maxBlockRange: options.maxBlockRange,
      });

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