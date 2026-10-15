import process from 'node:process';

import {
  createRelayerClients,
} from '../chain/clients.js';

import {
  loadRelayerConfig,
} from '../config/config.js';

import {
  createRelayerLog,
} from '../diagnostics/relayer-log.js';

import type {
  CliOptions,
  CliOutcome,
} from './cli.js';

import type {
  CliOutputHandler,
} from './cli-output.js';

import type {
  SyncNonceCommandArguments,
} from './parse-command-arguments.js';

import {
  syncNonce,
} from './sync-nonce.js';

export async function runSyncNonceCommand(
  command: SyncNonceCommandArguments,
  output: CliOutputHandler,
  options: CliOptions,
  signal: AbortSignal,
): Promise<CliOutcome> {
  signal.throwIfAborted();

  const config = await loadRelayerConfig({
    source: command.source,
    ...(options.onDiagnostics !== undefined
      ? { onDiagnostics: options.onDiagnostics }
      : {}),
  });

  signal.throwIfAborted();

  const clients = createRelayerClients(config);

  const logger = createRelayerLog({
    chainId: config.chain.id,
    level: process.env.QUICKNET_LOG_LEVEL ?? 'info',
    errorSummary: config.errorSummary,
    destination: process.stderr,
  });

  const identity = {
    chainId: config.chain.id,
    signer: config.account.address,
  };

  const result = await syncNonce({
    publicClient: clients.publicClient,
    identity,
    finality: config.finality,
    apply: command.apply,
    signal,
  });

  if (result.status === 'applied') {
    const { repair } = result;

    logger.signerNonceSynced({
      signer: identity.signer,
      previousNextNonce: repair.previousNextNonce,
      nextNonce: repair.nextNonce,
      durableBlock: repair.observation.anchor.blockNumber,
      durableBlockHash: repair.observation.anchor.blockHash,
      durableNonce: repair.observation.nonce,
      repairAt: repair.at,
    });
  }

  output({
    type: 'nonce-sync-result',
    identity,
    mode: command.apply ? 'apply' : 'preview',
    result,
  });

  switch (result.status) {
    case 'repair-available':
    case 'already-synchronized':
    case 'applied':
      return 'success';

    case 'deferred':
      return 'deferred';

    case 'refused':
      return 'failure';
  }
}