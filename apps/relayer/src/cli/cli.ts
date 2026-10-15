
import process from 'node:process';

import {
  createRelayerClients,
} from '../chain/clients.js';

import {
  getChainHeads,
} from '../chain/chain-heads.js';

import {
  type CliOutput,
} from './cli-output.js';

import {
  loadRelayerConfig,
  type NetworkSource,
} from '../config/config.js';

import {
  runDaemonCommand,
} from './daemon-command.js';

import type {
  SummarizeErrorOptions,
} from '../diagnostics/error-summary.js';

import type {
  RoundImportProgress,
} from '../diagnostics/operation-context.js';

import {
  createRelayerLog,
} from '../diagnostics/relayer-log.js';

import {
  assertServiceLockHeld,
} from '../state/service-lock.js';

import {
  importQuicknetRound,
  type ImportQuicknetRoundResult,
} from '../rounds/import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../rounds/import-round-when-available.js';

import {
  openBeaconSubmitter,
} from './open-beacon-submitter.js';

import {
  parseCommandArguments,
  type ImportCommandArguments,
  type ImportWhenAvailableCommandArguments,
  type SyncNonceCommandArguments,
} from './parse-command-arguments.js';

import {
  readRelayerStatus,
} from './read-relayer-status.js';

import {
  syncNonce,
} from './sync-nonce.js';

// Maximum replacement-search blocks per retained attempt in one pass.
const IMPORT_REPLACEMENT_BLOCK_RANGE = 1_000n;

type CliOutputHandler = (output: CliOutput) => void;

export interface CliOptions {
  onDiagnostics?: (
    policy: SummarizeErrorOptions | undefined,
  ) => void;
  onImportFailure?: (
    error: unknown,
    progress: RoundImportProgress,
  ) => void;
}

export type CliOutcome =
  | 'success'
  | 'failure'
  | 'pending'
  | 'deferred'
  | 'interrupted';

export async function main(
  args: readonly string[],
  output: CliOutputHandler,
  options: CliOptions = {},
): Promise<CliOutcome> {
  const normalizedArgs = normalizeArguments(args);
  const command = parseCommandArguments(normalizedArgs);

  switch (command.command) {
    case 'import':
    case 'import-when-available':
      assertServiceLockHeld();
      return runWithShutdownSignal(
        (signal) => runRoundImportCommand(
          command,
          output,
          options,
          signal,
        ),
        'interrupted',
      );
    
    case 'daemon':
      return runDaemonCli(command.source, output, options);  
      
    case 'daemon-help':
      output({ type: 'daemon-help' });
      return 'success';

    case 'sync-nonce':
      assertServiceLockHeld();
      return runWithShutdownSignal(
        (signal) => runSyncNonceCommand(
          command,
          output,
          options,
          signal,
        ),
        'interrupted',
      );

    case 'status':
      return runWithShutdownSignal(async (signal) => {
        const result = await readRelayerStatus({
          ...command.config,
          signal,
        });

        output({
          type: 'relayer-status',
          result,
        });

        return 'success';
      }, 'interrupted');

    case 'help':
      output({ type: 'help' });
      return 'success';
  }
}

async function runRoundImportCommand(
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

async function runWithShutdownSignal(
  run: (signal: AbortSignal) => Promise<CliOutcome>,
  interruptedOutcome: 'success' | 'interrupted',
): Promise<CliOutcome> {
  const controller = new AbortController();

  const handleShutdown = (): void => {
    controller.abort();
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (
      !controller.signal.aborted ||
      error !== controller.signal.reason
    ) {
      throw error;
    }

    return interruptedOutcome;
  } finally {
    process.removeListener('SIGINT', handleShutdown);
    process.removeListener('SIGTERM', handleShutdown);
  }
}

async function runDaemonCli(
  source: NetworkSource,
  output: CliOutputHandler,
  options: CliOptions,
): Promise<CliOutcome> {
  return runWithShutdownSignal(async (signal) => {
    await runDaemonCommand({
      source,
      signal,
      onStartup(summary) {
        output({
          type: 'daemon-startup',
          summary,
        });
      },
      onDiagnostics(policy) {
        options.onDiagnostics?.(policy);
      },
    });

    return 'success';
  }, 'success');
}

async function runSyncNonceCommand(
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

function normalizeArguments(
  args: readonly string[],
): readonly string[] {
  if (args[0] === '--') {
    return args.slice(1);
  }

  return args;
}