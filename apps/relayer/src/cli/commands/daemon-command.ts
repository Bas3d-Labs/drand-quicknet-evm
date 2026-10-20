import {
  randomUUID,
} from 'node:crypto';

import {
  basename,
  join,
  resolve,
} from 'node:path';

import {
  type Address,
} from 'viem';

import {
  verifyRegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  NetworkSource,
} from '../../config/config.js';

import {
  createChainHeadsReader,
} from '../../chain/chain-heads-reader.js';

import {
  createRelayerClients,
} from '../../chain/clients.js';

import {
  runDaemon,
} from '../../daemon/daemon.js';

import {
  createDaemonLogger,
} from '../../daemon/daemon-logging.js';

import {
  loadDaemonConfig,
} from '../../config/daemon-config.js';

import {
  collectDaemonStartupSummary,
  type DaemonStartupSummary,
} from '../../daemon/daemon-startup.js';

import {
  createDaemonStatusPublisher,
} from '../../daemon/daemon-status-publisher.js';

import type {
  SummarizeErrorOptions,
} from '../../diagnostics/error-summary.js';

import {
  createRelayerLog,
} from '../../diagnostics/relayer-log.js';

import {
  FileCheckpointStore,
} from '../../state/file-checkpoint-store.js';

import {
  validateQuicknetConsumers,
} from '../../consumers/validate-consumers.js';

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
  });

  const submitter = await openBeaconSubmitter({
    config,
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    log: logger,
    readChainHeads,
    maxBlockRange: config.maxBlockRange,
    checkpointFile: config.checkpointFile,
    startupPollIntervalMs: config.pollIntervalMs,
    onInitialized: statusPublisher.onInitialized,
    onRecoveryCompleted: statusPublisher.onRecoveryCompleted,
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
    readChainHeads,
    async onCycle(result, context) {
      statusPublisher.onCycleCompleted(context.cycle);

      try {
        const cycleLogger = logger.withContext({
          cycle: context.cycle,
          signer: config.account.address,
        });

        daemonLogger.onCycle(result, cycleLogger);
      } finally {
        await statusPublisher.publish();
      }
    },
    ...(options.signal !== undefined
      ? { signal: options.signal }
      : {}),
  });
}