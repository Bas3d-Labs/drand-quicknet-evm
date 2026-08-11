import {
  verifyRegistryDeployment,
} from '@based-labs/drand-quicknet-registry';

import type {
  RelayerNetwork,
} from './config.js';

import {
  createRelayerClients,
} from './clients.js';

import {
  loadDaemonConfig,
} from './daemon-config.js';

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
  network: RelayerNetwork;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function runDaemonCommand(
  options: RunDaemonCommandOptions,
): Promise<void> {
  const config = await loadDaemonConfig({
    network: options.network,
    ...(options.env !== undefined
      ? { env: options.env }
      : {}),
  });

  const clients = createRelayerClients(config);

  await verifyRegistryDeployment(
    clients.publicClient,
    config.deployment
  );

  const consumers = await validateQuicknetConsumers({
    publicClient: clients.publicClient,
    deployment: config.deployment,
    consumers: config.consumers,
  });

  const checkpointStore = new FileCheckpointStore({
    filePath: config.checkpointFile,
    deployment: config.deployment
  });

  await runDaemon({
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    account: config.account,
    deployment: config.deployment,
    checkpointStore,
    consumers,
    startBlock: config.startBlock,
    maxBlockRange: config.maxBlockRange,
    pollIntervalMs: config.pollIntervalMs,
    ...(options.signal !== undefined
      ? { signal: options.signal }
      : {}),
  });
}