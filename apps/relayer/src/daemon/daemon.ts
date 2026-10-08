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
  ChainHeads,
} from '../chain/chain-heads.js';

import {
  createChainHeadsReader,
} from '../chain/chain-heads-reader.js';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import type {
  ValidatedQuicknetConsumer,
} from '../consumers/consumer.js';

import type {
  BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import type {
  CheckpointStore,
} from '../state/checkpoint.js';

import {
  runDaemonCycle,
  type RunDaemonCycleResult,
} from './daemon-cycle.js';

import type {
  SoftScanCursor,
} from './daemon-iteration.js';

const DURABLE_HEAD_POLL_INTERVAL_MS = 30_000;

export interface DaemonCycleContext {
  readonly cycle: number;
}

export interface RunDaemonOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  submitter: BeaconSubmitter;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumers: readonly ValidatedQuicknetConsumer[];
  startBlock: bigint;
  maxBlockRange: bigint;
  finality: FinalityPolicy;
  pollIntervalMs: number;
  signal?: AbortSignal;
  readChainHeads?: () => Promise<ChainHeads>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onCycle?: (
    result: RunDaemonCycleResult,
    context: DaemonCycleContext,
  ) => void | Promise<void>;
}

export async function runDaemon(
  options: RunDaemonOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0
  ) {
    throw new Error('pollIntervalMs must be a positive safe integer.');
  }

  const sleep = options.sleep ?? sleepUntilTimeoutOrAbort;
  const softCursors = new Map<Address, SoftScanCursor>();

  const readChainHeads =
    options.readChainHeads ??
    createChainHeadsReader({
      publicClient: options.publicClient,
      finality: options.finality,
      durableHeadPollIntervalMs: DURABLE_HEAD_POLL_INTERVAL_MS,
    });

  let cycle = 0;

  while (!options.signal?.aborted) {
    if (cycle === Number.MAX_SAFE_INTEGER) {
      throw new Error('Daemon cycle counter exhausted.');
    }

    cycle += 1;

    const context: DaemonCycleContext = Object.freeze({
      cycle,
    });

    const submitter = Object.freeze<BeaconSubmitter>({
      recover: () => options.submitter.recover(context.cycle),

      submit: (request) => options.submitter.submit(
        request,
        context.cycle,
      ),
    });

    const result = await runDaemonCycle({
      publicClient: options.publicClient,
      walletClient: options.walletClient,
      account: options.account,
      submitter,
      deployment: options.deployment,
      checkpointStore: options.checkpointStore,
      consumers: options.consumers,
      startBlock: options.startBlock,
      maxBlockRange: options.maxBlockRange,
      finality: options.finality,
      softCursors,
      readChainHeads,
    });

    if (options.onCycle !== undefined) {
      await options.onCycle(result, context);
    }

    if (options.signal?.aborted) {
      return;
    }

    await sleep(
      options.pollIntervalMs,
      options.signal,
    );
  }
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