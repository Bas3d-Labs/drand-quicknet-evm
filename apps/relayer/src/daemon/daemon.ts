import type {
  Account,
  Address,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  TerminalRoundReason,
} from '../rounds/terminal-round-reason.js';

import type {
  QuicknetRandomnessRequest,
} from '../consumers/request-events.js';

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

import {
  createRoundImporter,
} from '../rounds/create-round-importer.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

import type {
  CheckpointStore,
} from '../state/checkpoint.js';

import {
  runDaemonCycle,
  type RunDaemonCycleOptions,
  type RunDaemonCycleResult,
} from './daemon-cycle.js';

import type {
  SoftScanCursor,
} from './daemon-iteration.js';

import {
  FutureRoundScheduler,
  type WaitTransition,
} from './future-round-scheduler.js';

const DURABLE_HEAD_POLL_INTERVAL_MS = 30_000;

interface DaemonCycleContext {
  readonly cycle: number;
}

export interface RunDaemonOptions {
  now?: () => number;
  onSchedulerInitialized?: (
    read: (at: number) => ReturnType<FutureRoundScheduler['observe']>,
  ) => void;
  onWaitTransition?: ((event: WaitTransition) => void) | undefined;
  publicClient: PublicClient;
  account: Account;
  submitter: BeaconSubmitter;
  deployment: RegistryDeployment;
  checkpointStore: CheckpointStore;
  consumers: readonly ValidatedQuicknetConsumer[];
  startBlock: bigint;
  maxBlockRange: bigint;
  finality: FinalityPolicy;
  pollIntervalMs: number;
  receiptTimeoutMs?: number;
  fetchTimeoutMs?: number;
  onUnfulfillable?: ((
    scanType: 'durable' | 'soft',
    request: QuicknetRandomnessRequest,
    reason: TerminalRoundReason,
  ) => void) | undefined;
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
  if (!isPositiveSafeInteger(options.pollIntervalMs)) {
    throw new Error('pollIntervalMs must be a positive safe integer.');
  }

  const waiting = new FutureRoundScheduler({
    chainId: options.deployment.chainId,
    registry: options.deployment.address,
    onTransition: options.onWaitTransition,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  options.onSchedulerInitialized?.((at) => waiting.observe(at));

  const bindRoundImporter = createRoundImporter({
    deferFutureRounds: true,
    ...(options.now === undefined ? {} : { now: options.now }),
    publicClient: options.publicClient,
    account: options.account,
    deployment: options.deployment,

    ...(options.receiptTimeoutMs !== undefined
      ? { receiptTimeoutMs: options.receiptTimeoutMs }
      : {}),

    ...(options.fetchTimeoutMs !== undefined
      ? { fetchTimeoutMs: options.fetchTimeoutMs }
      : {}),
  });

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
      findRetainedWork: (workId) =>
        options.submitter.findRetainedWork(workId),

      recover: () => options.submitter.recover(context.cycle),

      submit: (request) => options.submitter.submit(
        request,
        context.cycle,
      ),
    });

    const cycleOptions: RunDaemonCycleOptions = {
      waiting,
      publicClient: options.publicClient,
      bindRoundImporter,
      submitter,
      deployment: options.deployment,
      checkpointStore: options.checkpointStore,
      consumers: options.consumers,
      startBlock: options.startBlock,
      maxBlockRange: options.maxBlockRange,
      finality: options.finality,
      softCursors,
      readChainHeads,
      onUnfulfillable: options.onUnfulfillable,
    };

    if (options.signal !== undefined) {
      cycleOptions.signal = options.signal;
    }

    const result = await runDaemonCycle(cycleOptions);

    if (options.onCycle !== undefined) {
      await options.onCycle(result, context);
    }

    if (options.signal?.aborted) {
      return;
    }

    await sleep(
      waiting.sleepMilliseconds(options.pollIntervalMs, result.scheduled),
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
