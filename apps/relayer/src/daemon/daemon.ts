import type {
  Account,
  Address,
  PublicClient,
} from 'viem';

import type {
  RegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  createChainHeadsReader,
} from '../chain/chain-heads-reader.js';

import type {
  ChainHeads,
} from '../chain/chain-heads.js';

import type {
  FinalityPolicy,
} from '../chain/finality-policy.js';

import type {
  ValidatedQuicknetConsumer,
} from '../consumers/consumer.js';

import type {
  QuicknetRandomnessRequest,
} from '../consumers/request-events.js';

import type {
  ConsumerHealth,
} from '../diagnostics/relayer-log.js';

import type {
  RequestDiscovery,
} from '../diagnostics/request-discovery.js';

import {
  isOperationCancelled,
} from '../execution/is-operation-cancelled.js';

import type {
  BeaconSubmitter,
} from '../rounds/create-beacon-submitter.js';

import {
  createRoundImporter,
} from '../rounds/create-round-importer.js';

import type {
  TerminalRoundReason,
} from '../rounds/terminal-round-reason.js';

import {
  isPositiveSafeInteger,
} from '../shared/integer.js';

import type {
  CheckpointStore,
} from '../state/checkpoint.js';

import type {
  SchedulerInspectionCompletion,
} from '../state/scheduler-recovery-observer.js';

import {
  runDaemonCycle,
  type RunDaemonCycleOptions,
  type RunDaemonCycleResult,
} from './daemon-cycle.js';

import {
  DaemonHeartbeatViews,
} from './daemon-heartbeat-views.js';

import type {
  SoftScanCursor,
} from './daemon-iteration.js';

import {
  DaemonLoopSchedule,
  type SchedulingState,
} from './daemon-loop-schedule.js';

import {
  DaemonWorkExecutor,
} from './daemon-work-executor.js';

import {
  discoverRequests,
  type DiscoverRequestsOptions,
} from './discover-requests.js';

import {
  FutureRoundScheduler,
  type DispatchObservation,
  type WaitTransition,
} from './future-round-scheduler.js';

const DURABLE_HEAD_POLL_INTERVAL_MS = 30_000;

export type DaemonWorkContext =
  | {
      readonly iteration: number;
      readonly kind: 'full';
      readonly cycle: number;
    }
  | {
      readonly iteration: number;
      readonly kind: 'discovery';
    };

export interface DaemonWorkResult {
  readonly cycle?: RunDaemonCycleResult;
  readonly discoveryCompleted: boolean;
  readonly consumers: readonly ConsumerHealth[];
  readonly waitingRejectedOffers: bigint;
  readonly discoveryFailures: readonly {
    consumer: Address;
    error: unknown;
  }[];
}

export interface RunDaemonOptions {
  now?: () => number;
  monotonicNow?: () => number;
  readSchedulingState: () => SchedulingState;
  installInspectionObserver?: (
    observe: (fact: SchedulerInspectionCompletion) => void,
  ) => () => void;
  onSchedulerInitialized?: (
    read: (at: number) => ReturnType<FutureRoundScheduler['observe']>,
  ) => void;
  onWaitTransition?: ((
    event: WaitTransition,
    context?: DaemonWorkContext,
  ) => void) | undefined;
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
  onRequestDiscovered?: ((
    scanType: 'durable' | 'soft',
    observation: RequestDiscovery,
    context: DaemonWorkContext,
  ) => void) | undefined;
  onUnfulfillable?: ((
    scanType: 'durable' | 'soft',
    request: QuicknetRandomnessRequest,
    reason: TerminalRoundReason,
  ) => void) | undefined;
  signal?: AbortSignal;
  readChainHeads?: () => Promise<ChainHeads>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onWork?: (
    result: DaemonWorkResult,
    context: DaemonWorkContext,
  ) => void | Promise<void>;
}

export async function runDaemon(
  options: RunDaemonOptions,
): Promise<void> {
  if (!isPositiveSafeInteger(options.pollIntervalMs)) {
    throw new Error('pollIntervalMs must be a positive safe integer.');
  }

  const now = options.now ?? Date.now;

  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  const schedule = new DaemonLoopSchedule(
    options.pollIntervalMs,
    monotonicNow(),
  );

  const views = new DaemonHeartbeatViews(
    options.consumers.map((consumer) => consumer.address),
  );

  const dispatch = new Map<string, DispatchObservation>();

  let activeContext: DaemonWorkContext | undefined;

  const waiting = new FutureRoundScheduler({
    chainId: options.deployment.chainId,
    registry: options.deployment.address,
    now,
    onTransition(event) {
      schedule.transition(event);
      options.onWaitTransition?.(event, activeContext);
    },
    onDispatch(fact) {
      dispatch.set(fact.workId, fact);
    },
  });

  options.onSchedulerInitialized?.((at) => waiting.observe(at));

  const bindRoundImporter = createRoundImporter({
    deferFutureRounds: true,
    now,
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

  const executor = new DaemonWorkExecutor();

  const durablePositions = new Map<Address, { head: bigint; nextBlock: bigint }>();

  let cycle = 0;
  let iteration = 0;
  let startup = true;

  async function runFullWork(
    context: Extract<DaemonWorkContext, { kind: 'full' }>,
    selectedAt: number,
    wall: number,
  ): Promise<DaemonWorkResult> {
    const capture = schedule.captureFull(selectedAt, wall);

    dispatch.clear();

    const submitter = Object.freeze<BeaconSubmitter>({
      findRetainedWork: (workId) => options.submitter.findRetainedWork(workId),
      recover: () => options.submitter.recover(context.cycle),
      submit: (request) => options.submitter.submit(request, context.cycle),
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
      scanSoft: false,
      readChainHeads,

      selectDurableTarget(consumer, nextBlock, head) {
        return schedule.durableTarget(consumer, nextBlock, head, monotonicNow());
      },

      onRequestDiscovered(scanType, observation) {
        options.onRequestDiscovered?.(scanType, observation, context);
      },
      onUnfulfillable: options.onUnfulfillable,
    };

    if (options.signal !== undefined) {
      cycleOptions.signal = options.signal;
    }

    const result = await runDaemonCycle(cycleOptions);

    options.signal?.throwIfAborted();

    const completedAt = monotonicNow();

    if (!result.recoveryFailed) {
      for (const outcome of result.consumers) {
        const consumer = outcome.consumer.address;

        if (outcome.status === 'failed') {
          views.fullFailed(consumer);
          schedule.durableFailed(consumer, completedAt);

          continue;
        }

        const scan = outcome.iteration;

        views.fullCompleted(consumer, {
          durableBlock: scan.durableBlock,
          durableNextBlock: scan.durableNextBlock,
          ...(scan.durableBlockObservedAt === undefined
            ? {}
            : { durableBlockObservedAt: scan.durableBlockObservedAt }),
        });

        durablePositions.set(consumer, {
          head: scan.durableBlock,
          nextBlock: scan.durableNextBlock,
        });

        schedule.durableFinished(consumer, scan.durableNextBlock, completedAt);
      }
    }

    schedule.fullFinished(
      capture,
      completedAt,
      options.readSchedulingState(),
      dispatch,
      result.recoveryFailed === true,
    );

    return {
      cycle: result,
      discoveryCompleted: false,
      consumers: views.snapshot(),
      waitingRejectedOffers: waiting.rejectedOffers,
      discoveryFailures: [],
    };
  }

  async function runDiscoveryWork(
    context: Extract<DaemonWorkContext, { kind: 'discovery' }>,
    selectedAt: number,
  ): Promise<DaemonWorkResult> {
    const discoveryFailures: { consumer: Address; error: unknown }[] = [];

    let succeeded = 0;

    for (const consumer of options.consumers) {
      options.signal?.throwIfAborted();

      if (!schedule.discoveryDue(consumer.address, selectedAt)) {
        continue;
      }

      const durable = durablePositions.get(consumer.address);

      if (durable === undefined) {
        // Recovery or this consumer's first durable scan has not succeeded.
        // The configured start block is not a safe optimistic scan position.
        continue;
      }

      try {
        const soft = softCursors.get(consumer.address);

        let nextBlock = durable.nextBlock;

        if (durable.head + 1n > nextBlock) {
          nextBlock = durable.head + 1n;
        }

        if (soft !== undefined && soft.nextBlock > nextBlock) {
          nextBlock = soft.nextBlock;
        }

        const discoveryOptions: DiscoverRequestsOptions = {
          publicClient: options.publicClient,
          queue: waiting,
          consumer: consumer.address,
          nextBlock,
          maxBlockRange: options.maxBlockRange,
          now,
          observationClock: now,
          onRequestDiscovered(observation) {
            options.onRequestDiscovered?.('soft', observation, context);
          },
        };

        if (options.signal !== undefined) {
          discoveryOptions.signal = options.signal;
        }

        const discovery = await discoverRequests(discoveryOptions);

        options.signal?.throwIfAborted();

        const after = discovery.scan.nextBlock;

        softCursors.set(consumer.address, { nextBlock: after });

        views.discoveryCompleted(consumer.address, {
          latestBlock: discovery.latestBlock,
          softNextBlock: after,
          ...(discovery.latestBlockObservedAt === undefined
            ? {}
            : { latestBlockObservedAt: discovery.latestBlockObservedAt }),
        });

        schedule.discoveryFinished(
          consumer.address,
          monotonicNow(),
          discovery.scan.status === 'scanned' &&
            after > nextBlock &&
            after <= discovery.latestBlock,
        );

        for (const admission of discovery.admissions) {
          if (admission.status === 'unfulfillable') {
            options.onUnfulfillable?.('soft', admission.request, admission.reason);
          }
        }

        succeeded += 1;
      } catch (error) {
        if (isOperationCancelled(error, options.signal)) {
          throw error;
        }

        views.discoveryFailed(consumer.address);

        schedule.discoveryFailed(consumer.address, selectedAt, monotonicNow());

        discoveryFailures.push({ consumer: consumer.address, error });
      }
    }

    schedule.discoveryPassFinished(selectedAt, monotonicNow());

    return {
      discoveryCompleted: succeeded === options.consumers.length,
      consumers: views.snapshot(),
      waitingRejectedOffers: waiting.rejectedOffers,
      discoveryFailures,
    };
  }

  const detach = options.installInspectionObserver?.((fact) => {
    schedule.inspectionCompleted(fact);
  });

  try {
    while (!options.signal?.aborted) {
      const selectedAt = monotonicNow();
      const wall = now();
      const deadlines = schedule.deadlines(selectedAt, wall, options.readSchedulingState());

      executor.replace(startup ? { full: selectedAt, discovery: null } : deadlines);

      const executed = await executor.runNext(selectedAt, async (kind) => {
        if (
          iteration === Number.MAX_SAFE_INTEGER ||
          (kind === 'full' && cycle === Number.MAX_SAFE_INTEGER)
        ) {
          throw new Error('Daemon work counter exhausted.');
        }

        iteration += 1;

        let context: DaemonWorkContext;

        if (kind === 'full') {
          cycle += 1;
          context = Object.freeze({ iteration, kind, cycle });
        } else {
          context = Object.freeze({ iteration, kind });
        }

        activeContext = context;

        try {
          let result: DaemonWorkResult;

          if (context.kind === 'full') {
            result = await runFullWork(context, selectedAt, wall);
          } else {
            result = await runDiscoveryWork(context, selectedAt);
          }

          // Publication remains inside serial ownership.
          await options.onWork?.(result, context);
        } finally {
          activeContext = undefined;
        }
      });

      startup = false;

      if (options.signal?.aborted) {
        return;
      }

      if (executed !== undefined) {
        continue;
      }

      const next = executor.nextDeadline;

      const remaining = Math.max(
        0,
        (next ?? selectedAt + options.pollIntervalMs) - selectedAt,
      );

      await sleep(Math.min(options.pollIntervalMs, remaining), options.signal);
    }
  } finally {
    detach?.();
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
