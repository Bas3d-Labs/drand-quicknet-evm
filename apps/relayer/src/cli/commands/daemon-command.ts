import {
  randomUUID,
} from 'node:crypto';

import {
  basename,
  join,
  resolve,
} from 'node:path';

import {
  performance,
} from 'node:perf_hooks';

import {
  type Address,
} from 'viem';

import {
  verifyRegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import {
  createChainHeadsReader,
} from '../../chain/chain-heads-reader.js';

import {
  createRelayerClients,
} from '../../chain/clients.js';

import type {
  NetworkSource,
} from '../../config/config.js';

import {
  loadDaemonConfig,
} from '../../config/daemon-config.js';

import {
  validateQuicknetConsumers,
} from '../../consumers/validate-consumers.js';

import {
  createDaemonLogger,
} from '../../daemon/daemon-logging.js';

import {
  collectDaemonStartupSummary,
  type DaemonStartupSummary,
} from '../../daemon/daemon-startup.js';

import {
  createDaemonStatusPublisher,
} from '../../daemon/daemon-status-publisher.js';

import {
  runDaemon,
} from '../../daemon/daemon.js';

import type {
  SummarizeErrorOptions,
} from '../../diagnostics/error-summary.js';

import {
  createRelayerLog,
} from '../../diagnostics/relayer-log.js';

import {
  createRpcUsageSession,
} from '../../diagnostics/rpc/rpc-usage-session.js';

import {
  createRpcUsageSnapshot,
} from '../../diagnostics/rpc/rpc-usage-snapshot.js';

import {
  FileCheckpointStore,
} from '../../state/file-checkpoint-store.js';

import type {
  SignerRuntimeObservation,
} from '../../state/read-signer-runtime-observation.js';

import {
  assertServiceLockHeld,
} from '../../state/service-lock.js';

import {
  openBeaconSubmitter,
} from '../open-beacon-submitter.js';

export interface RunDaemonCommandOptions {
  source: NetworkSource;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStartup?: (summary: DaemonStartupSummary) => void;
  onDiagnostics?: (
    policy: SummarizeErrorOptions | undefined,
  ) => void;
}

export async function runDaemonCommand(
  options: RunDaemonCommandOptions,
): Promise<void> {
  const env = options.env ?? process.env;

  options.signal?.throwIfAborted();

  assertServiceLockHeld({ env });

  const loadedConfig = await loadDaemonConfig({
    source: options.source,
    env,
    ...(options.onDiagnostics !== undefined
      ? { onDiagnostics: options.onDiagnostics }
      : {}),
  });

  options.signal?.throwIfAborted();

  const configuredCheckpointFile = resolve(
    loadedConfig.checkpointFile,
  );

  const { stateDirectory } = assertServiceLockHeld({
    env,
    checkpointFile: configuredCheckpointFile,
  });

  const config = {
    ...loadedConfig,
    checkpointFile: join (
      stateDirectory,
      basename(configuredCheckpointFile),
    ),
  };

  const errorSummary = config.errorSummary;

  const runId = randomUUID();

  const logger = createRelayerLog({
    chainId: config.chain.id,
    runId,
    level: (options.env ?? process.env).QUICKNET_LOG_LEVEL ?? 'info',
    errorSummary,
  });

  const statusPublisher = createDaemonStatusPublisher({
    identity: {
      chainId: config.chain.id,
      signer: config.account.address,
    },
    runId,
    env: {
      ...env,
      QUICKNET_STATE_DIR: stateDirectory,
    },
    readRpcUsage(observedAt) {
      return createRpcUsageSnapshot(
        clients.rpcMetrics.snapshot(),
        observedAt,
      );
    },
    onFailure(error) {
      logger.statusPublicationFailed({
        signer: config.account.address,
        error,
      });
    },
  });

  const daemonLogger = createDaemonLogger({
    logger,
  });

  const clients = createRelayerClients(config);

  const rpcUsageSession = createRpcUsageSession({
    readSnapshot: () => clients.rpcMetrics.snapshot(),
    emit(context) {
      logger.rpcUsage(context);
    },
    onFailure(error) {
      logger.loggingFailed({ error });
    },
  });

  try {
    await verifyRegistryDeployment(
      clients.publicClient,
      config.deployment,
    );

    options.signal?.throwIfAborted();
    
    const validatedConsumers = await validateQuicknetConsumers({
      publicClient: clients.publicClient,
      deployment: config.deployment,
      consumers: config.consumers,
    });

    options.signal?.throwIfAborted();

    const readChainHeads = createChainHeadsReader({
      publicClient: clients.publicClient,
      finality: config.finality,
      durableHeadPollIntervalMs: 30_000,
      observationClock: Date.now,
    });

    let readRuntime: (() => SignerRuntimeObservation) | undefined;

    const monotonicNow = () => performance.now();

    const submitter = await openBeaconSubmitter({
      config,
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      log: logger,
      readChainHeads,
      maxBlockRange: config.maxBlockRange,
      checkpointFile: config.checkpointFile,
      startupPollIntervalMs: config.pollIntervalMs,
      onInitialized(read) {
        readRuntime = read;
        statusPublisher.onInitialized(read);
      },
      onRecoveryCompleted: statusPublisher.onRecoveryCompleted,
      schedulerObserver: {
        now: monotonicNow,
        onInspectionCompleted: statusPublisher.onInspectionCompleted,
      },
      signal: options.signal,
      env,
    });

    options.signal?.throwIfAborted();

    const checkpointStore = await FileCheckpointStore.open({
      filePath: config.checkpointFile,
      deployment: config.deployment,
    });

    options.signal?.throwIfAborted();
    
    const durableNextBlocks = new Map<Address, bigint>();
    for (const consumer of validatedConsumers) {
      const nextBlock = await checkpointStore.load(consumer.address);

      options.signal?.throwIfAborted();

      if (nextBlock !== undefined) {
        durableNextBlocks.set(consumer.address, nextBlock);
      }
    }

    const startupSummary = await collectDaemonStartupSummary({
      publicClient: clients.publicClient,
      config,
      durableNextBlocks,
    });

    options.signal?.throwIfAborted();
    
    options.onStartup?.(startupSummary);

    options.signal?.throwIfAborted();

    await statusPublisher.publish();

    options.signal?.throwIfAborted();

    await runDaemon({
      monotonicNow,
      readSchedulingState() {
        if (readRuntime === undefined) {
          throw new Error('Signer runtime is not initialized.');
        }

        const current = readRuntime();

        return {
          open: current.status.open,
          blockers: current.status.blockers,
          retainedCount: current.attempts.length,
        };
      },
      publicClient: clients.publicClient,
      account: config.account,
      submitter,
      deployment: config.deployment,
      checkpointStore,
      consumers: validatedConsumers,
      startBlock: config.startBlock,
      maxBlockRange: config.maxBlockRange,
      finality: config.finality,
      pollIntervalMs: config.pollIntervalMs,

      ...(config.receiptTimeoutMs !== undefined
        ? { receiptTimeoutMs: config.receiptTimeoutMs }
        : {}),

      ...(config.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: config.fetchTimeoutMs }
        : {}),

      readChainHeads,
      onRequestDiscovered(scanType, observation, context) {
        logger.withContext({
          ...(context.kind === 'full' ? { cycle: context.cycle } : {}),
          iteration: context.iteration,
          workKind: context.kind,
        }).requestDiscovered({
          ...observation,
          logIndex: BigInt(observation.logIndex),
          scanType,
        });
      },
      onUnfulfillable: daemonLogger.onUnfulfillable,
      onWaitTransition(event, context) {
        if (context === undefined) {
          daemonLogger.onWaitTransition(event);
          return;
        }

        daemonLogger.onWaitTransition(event, logger.withContext({
          ...(context.kind === 'full' ? { cycle: context.cycle } : {}),
          iteration: context.iteration,
          workKind: context.kind,
        }));
      },
      onSchedulerInitialized: statusPublisher.onSchedulerInitialized,
      
      async onWork(result, context) {
        const completion = statusPublisher.onWorkCompleted(
          context,
          result.discoveryCompleted,
        );

        try {
          const workLogger = logger.withContext({
            ...(context.kind === 'full' ? { cycle: context.cycle } : {}),
            iteration: context.iteration,
            workKind: context.kind,
            signer: config.account.address,
          });

          daemonLogger.onWork(result, workLogger);

          if (completion !== undefined) {
            workLogger.workCompleted({
              completedAt: completion.completedAt,
            });
          }
        } finally {
          try {
            await statusPublisher.publish();
          } finally {
            rpcUsageSession.onCycle();
          }
        }
      },
      ...(options.signal !== undefined
        ? { signal: options.signal }
        : {}),
    });
  } finally {
    rpcUsageSession.finish();
  }
}
