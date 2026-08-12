import {
  type Address,
} from 'viem';

import {
  verifyRegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  NetworkSource,
} from './config.js';

import {
  createRelayerClients,
} from './clients.js';

import {
  createDaemonLogger,
} from './daemon-logging.js';

import {
  logger,
} from './logger.js';

import {
  loadDaemonConfig,
} from './daemon-config.js';

import {
  collectDaemonStartupSummary,
  formatDaemonStartupSummary,
} from './daemon-startup.js';

import {
  runDaemon,
} from './daemon.js';

import {
  FileCheckpointStore,
} from './file-checkpoint-store.js';

import {
  validateQuicknetConsumers,
} from './validate-consumers.js';
import { FileCheckpointLock } from './file-checkpoint-lock.js';

export interface RunDaemonCommandOptions {
  source: NetworkSource;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function runDaemonCommand(
  options: RunDaemonCommandOptions,
): Promise<void> {
  const config = await loadDaemonConfig({
    source: options.source,
    ...(options.env !== undefined
      ? { env: options.env }
      : {}),
  });

  const daemonLogger = createDaemonLogger({
    logger: logger.child({
      component: 'daemon',
      network: config.network,
      chainId: config.chain.id,
    }),
  });

  const clients = createRelayerClients(config);

  await verifyRegistryDeployment(
    clients.publicClient,
    config.deployment,
  );
  
  const validatedConsumers = await validateQuicknetConsumers({
    publicClient: clients.publicClient,
    deployment: config.deployment,
    consumers: config.consumers,
  });

  const checkpointStore = new FileCheckpointStore({
    filePath: config.checkpointFile,
    deployment: config.deployment,
  });

  const checkpointLock = new FileCheckpointLock({
    checkpointFile: config.checkpointFile,
  });
  const lockHandle = await checkpointLock.acquire();

  try {
    const durableNextBlocks = new Map<Address, bigint>();
    for (const consumer of validatedConsumers) {
      const nextBlock = await checkpointStore.load(consumer.address);
      if (nextBlock !== undefined) {
        durableNextBlocks.set(consumer.address, nextBlock);
      }
    }

    const startupSummary = await collectDaemonStartupSummary({
      publicClient: clients.publicClient,
      config,
      durableNextBlocks,
    });
    console.log(formatDaemonStartupSummary(startupSummary));

    await runDaemon({
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      account: config.account,
      deployment: config.deployment,
      checkpointStore,
      consumers: validatedConsumers,
      startBlock: config.startBlock,
      maxBlockRange: config.maxBlockRange,
      finality: config.finality,
      pollIntervalMs: config.pollIntervalMs,
      onCycle: daemonLogger.onCycle,
      ...(options.signal !== undefined
        ? { signal: options.signal }
        : {}),
    });
  } finally {
    await lockHandle.release();
  }
}