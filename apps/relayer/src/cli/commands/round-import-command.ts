import process from 'node:process';

import {
  createRelayerClients,
} from '../../chain/clients.js';

import {
  getChainHeads,
} from '../../chain/chain-heads.js';

import {
  loadRelayerConfig,
} from '../../config/config.js';

import type {
  RoundImportProgress,
} from '../../diagnostics/operation-context.js';

import {
  createRelayerLog,
} from '../../diagnostics/relayer-log.js';

import {
  importQuicknetRound,
  type ImportQuicknetRoundResult,
} from '../../rounds/import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../../rounds/import-round-when-available.js';

import type {
  CliOutputHandler,
} from '../output/cli-output.js';

import type {
  CliOptions,
  CliOutcome,
} from '../cli-types.js';

import {
  openBeaconSubmitter,
} from '../open-beacon-submitter.js';

import type {
  ImportCommandArguments,
  ImportWhenAvailableCommandArguments,
} from '../parse-command-arguments.js';

// Maximum replacement-search blocks per retained attempt in one pass.
const IMPORT_REPLACEMENT_BLOCK_RANGE = 1_000n;

export async function runRoundImportCommand(
  command: 
    | ImportCommandArguments
    | ImportWhenAvailableCommandArguments,
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

  const submitter = await openBeaconSubmitter({
    config,
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    log: logger,
    readChainHeads: () => getChainHeads({
      publicClient: clients.publicClient,
      finality: config.finality,
    }),
    maxBlockRange: IMPORT_REPLACEMENT_BLOCK_RANGE,
    signal,
  });

  signal.throwIfAborted();

  let progress: RoundImportProgress | undefined;
  let result: ImportQuicknetRoundResult;

  try {
    if (command.command === 'import') {
      result = await importQuicknetRound({
        publicClient: clients.publicClient,
        account: config.account,
        submitter,
        deployment: config.deployment,
        round: command.round,
        receiptTimeoutMs: config.receiptTimeoutMs,
        fetchTimeoutMs: config.fetchTimeoutMs,
        onProgress(current) {
          progress = current;
        },
        signal,
      });
    } else {
      result = await importQuicknetRoundWhenAvailable({
        publicClient: clients.publicClient,
        account: config.account,
        submitter,
        deployment: config.deployment,
        round: command.round,
        receiptTimeoutMs: config.receiptTimeoutMs,
        fetchTimeoutMs: config.fetchTimeoutMs,
        onProgress(current) {
          progress = current;
        },
        signal,
      });
    }
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      throw error;
    }

    reportImportFailure(options, error, progress);
    throw error;
  }

  output({
    type: 'import-result',
    round: command.round,
    result,
  });

  return importOutcome(result);
}

function importOutcome(
  result: ImportQuicknetRoundResult,
): CliOutcome {
  switch (result.status) {
    case 'imported':
    case 'already-stored':
      return 'success';

    case 'pending':
      return 'pending';

    case 'deferred':
      return 'deferred';
  }
}

function reportImportFailure(
  options: CliOptions,
  error: unknown,
  progress: RoundImportProgress | undefined,
): void {
  if (progress === undefined) {
    return;
  }

  try {
    options.onImportFailure?.(error, progress);
  } catch {
    // Diagnostic observers must not replace the original import failure.
  }
}