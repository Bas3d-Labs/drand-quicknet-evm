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
  runDaemonCycle,
  type RunDaemonCycleResult,
} from './daemon-cycle.js';

export interface RunDaemonOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumers: readonly ValidatedQuicknetConsumer[];
  startBlock: bigint;
  maxBlockRange: bigint;
  pollIntervalMs: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onCycle?: (result: RunDaemonCycleResult) => void | Promise<void>;
}

export async function runDaemon(
  options: RunDaemonOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0
  ) {
    throw new Error('pollIntervalMs must be a positive safe integer.')
  }

  const sleep = options.sleep ?? sleepUntilTimeoutOrAbort;

  while (!options.signal?.aborted) {
    const result = await runDaemonCycle({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: options.account,
      deployment: options.deployment,
      checkpointStore: options.checkpointStore,
      consumers: options.consumers,
      startBlock: options.startBlock,
      maxBlockRange: options.maxBlockRange,
    });

    if (options.onCycle !== undefined) {
      await options.onCycle(result);
    }

    if (options.signal?.aborted) {
      return;
    }

    if (cycleMadeProgress(result)) {
      continue;
    }

    await sleep(
      options.pollIntervalMs,
      options.signal,
    );
  }
}

function cycleMadeProgress(
  result: RunDaemonCycleResult,
): boolean {
  for (const consumer of result.consumers) {
    if (
      consumer.status === 'success' &&
      consumer.iteration.status === 'processed'
    ) {
      return true;
    }
  }

  return false;
}

async function sleepUntilTimeoutOrAbort(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;

    const cleanup = (): void => {
      if (signal !== undefined) {
        signal.removeEventListener('abort', handleAbort);
      }
    };

    const handleAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      resolve();
    };

    timeout = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      milliseconds
    );

    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}