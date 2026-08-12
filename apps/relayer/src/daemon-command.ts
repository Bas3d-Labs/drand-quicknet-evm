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

  const clients = createRelayerClients(config);

  await verifyRegistryDeployment(
    clients.publicClient,
    config.deployment,
  );

  const consumers = await validateQuicknetConsumers({
    publicClient: clients.publicClient,
    deployment: config.deployment,
    consumers: config.consumers,
  });

  const checkpointStore = new FileCheckpointStore({
    filePath: config.checkpointFile,
    deployment: config.deployment,
  });

  const startupSummary = await collectDaemonStartupSummary({
    publicClient: clients.publicClient,
    config,
  });
  console.log(formatDaemonStartupSummary(startupSummary));

  await runDaemon({
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    account: config.account,
    deployment: config.deployment,
    checkpointStore,
    consumers,
    startBlock: config.startBlock,
    maxBlockRange: config.maxBlockRange,
    finality: config.finality,
    pollIntervalMs: config.pollIntervalMs,
    ...(options.signal !== undefined
      ? { signal: options.signal }
      : {}),
  });
}