
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
  parseRelayerNetworkPreset,
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
  UsageError,
} from '../diagnostics/usage-error.js';

import {
  isDecimalInteger,
} from '../shared/decimal.js';

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
  syncNonce,
} from './sync-nonce.js';

// Maximum replacement-search blocks per retained attempt in one pass.
const IMPORT_REPLACEMENT_BLOCK_RANGE = 1_000n;

const MAX_UINT64 = (1n << 64n) - 1n;

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

interface ImportCommandArguments {
  command: 'import';
  source: NetworkSource;
  round: bigint;
}

interface ImportWhenAvailableCommandArguments {
  command: 'import-when-available';
  source: NetworkSource;
  round: bigint;
}

interface DaemonCommandArguments {
  command: 'daemon';
  source: NetworkSource;
}

interface DaemonHelpCommandArguments {
  command: 'daemon-help';
}

interface HelpCommandArguments {
  command: 'help';
}

interface SyncNonceCommandArguments {
  command: 'sync-nonce';
  source: NetworkSource;
  apply: boolean;
}

type CommandArguments =
  | ImportCommandArguments
  | ImportWhenAvailableCommandArguments
  | DaemonCommandArguments
  | SyncNonceCommandArguments
  | DaemonHelpCommandArguments
  | HelpCommandArguments;

export async function main(
  args: readonly string[],
  output: CliOutputHandler,
  options: CliOptions = {},
): Promise<CliOutcome> {
  const normalizedArgs = normalizeArguments(args);
  const command = parseCommandArguments(normalizedArgs);

  switch (command.command) {
    case 'import':
      assertServiceLockHeld();
      return runWithShutdownSignal(
        (signal) => runImportCommand(command, output, options, signal),
        'interrupted',
      );

    case 'import-when-available':
      assertServiceLockHeld();
      return runWithShutdownSignal((signal) =>
        runImportWhenAvailableCommand(
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

    case 'help':
      output({ type: 'help' });
      return 'success';
  }
}

async function runImportCommand(
  command: ImportCommandArguments,
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
    result = await importQuicknetRound({
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
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

async function runImportWhenAvailableCommand(
  command: ImportWhenAvailableCommandArguments,
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
    result = await importQuicknetRoundWhenAvailable({
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
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

export function parseCommandArguments(
  args: readonly string[],
): CommandArguments {
  const command = args[0];

  if (args.includes('--help') || args.includes('-h')) {
    if (command === 'daemon') {
      return { command: 'daemon-help' };
    }

    return { command: 'help' };
  }

  if (
    command === undefined ||
    command === 'help'
  ) {
    return { command: 'help' };
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case 'import':
      return parseImportArguments(commandArgs);

    case 'import-when-available':
      return parseImportWhenAvailableArguments(commandArgs);

    case 'daemon':
      return parseDaemonArguments(commandArgs);
      
    case 'sync-nonce':
      return parseSyncNonceArguments(commandArgs);

    default:
      throw new UsageError('UNKNOWN_COMMAND');
  }
}

function parseImportArguments(
  args: readonly string[],
): ImportCommandArguments {
  const parsed = parseRoundCommandOptions(args);

  return {
    command: 'import',
    source: parsed.source,
    round: parsed.round,
  };
}

function parseImportWhenAvailableArguments(
  args: readonly string[],
): ImportWhenAvailableCommandArguments {
  const parsed = parseRoundCommandOptions(args);

  return {
    command: 'import-when-available',
    source: parsed.source,
    round: parsed.round,
  };
}

function parseDaemonArguments(
  args: readonly string[],
):
  | DaemonCommandArguments
  | DaemonHelpCommandArguments {
  let source: NetworkSource | undefined;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new UsageError('EXPECTED_ARGUMENT');
    }

    if (argument === '--help' || argument === '-h') {
      return { command: 'daemon-help' };
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;
      
      continue;
    }

    throw new UsageError('UNKNOWN_ARGUMENT');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_NETWORK');
  }

  return {
    command: 'daemon',
    source,
  };
}

function parseSyncNonceArguments(
  args: readonly string[],
): SyncNonceCommandArguments {
  let source: NetworkSource | undefined;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new UsageError('EXPECTED_ARGUMENT');
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;
      continue;
    }

    if (argument === '--apply') {
      if (apply) {
        throw new UsageError('DUPLICATE_APPLY');
      }

      apply = true;
      continue;
    }

    throw new UsageError('UNKNOWN_ARGUMENT');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_NETWORK');
  }

  return {
    command: 'sync-nonce',
    source,
    apply,
  };
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

interface RoundCommandOptions {
  source: NetworkSource;
  round: bigint;
}

function parseRoundCommandOptions(
  args: readonly string[],
): RoundCommandOptions {
  let source: NetworkSource | undefined;
  let round: bigint | undefined;
  
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new UsageError('EXPECTED_ARGUMENT');
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;

      continue;
    }

    if (argument === '--round') {
      if (round !== undefined) {
        throw new UsageError('DUPLICATE_ROUND');
      }

      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError('MISSING_ROUND_VALUE');
      }

      round = parseRound(value);
      i += 1;

      continue;
    }

    throw new UsageError('UNKNOWN_ARGUMENT');
  }

  if (source === undefined) {
    throw new UsageError('MISSING_NETWORK');
  }

  if (round === undefined) {
    throw new UsageError('MISSING_ROUND');
  }

  return {
    source,
    round,
  };
}

interface ParsedNetworkSourceArgument {
  source: NetworkSource;
  nextIndex: number;
}

function parseNetworkSourceArgument(
  args: readonly string[],
  index: number,
  currentSource: NetworkSource | undefined,
): ParsedNetworkSourceArgument | undefined {
  const argument = args[index];
  if (argument !== '--network' && argument !== '--network-config') {
    return undefined;
  }

  if (currentSource !== undefined) {
    if (argument === '--network' && currentSource.type === 'preset') {
      throw new UsageError('DUPLICATE_NETWORK');
    }

    if (argument === '--network-config' && currentSource.type === 'custom') {
      throw new UsageError('DUPLICATE_NETWORK_CONFIG');
    }

    throw new UsageError('CONFLICTING_NETWORK');
  }

  const value = args[index + 1];
  if (value === undefined) {
    if (argument === '--network') {
      throw new UsageError('MISSING_NETWORK_VALUE');
    }

    throw new UsageError('MISSING_NETWORK_CONFIG_VALUE');
  }

  if (argument === '--network') {
    return {
      source: {
        type: 'preset',
        network: parseRelayerNetworkPreset(value)
      },
      nextIndex: index + 1,
    };
  }

  return {
    source: {
      type: 'custom',
      configFile: value,
    },
    nextIndex: index + 1,
  };
}

function parseRound(
  value: string,
): bigint {
  if (
    value.length === 0 ||
    !isDecimalInteger(value)
  ) {
    throw new UsageError('INVALID_ROUND');
  }

  const round = BigInt(value);
  if (round <= 0n) {
    throw new UsageError('ZERO_ROUND');
  }

  if (round > MAX_UINT64) {
    throw new UsageError('ROUND_OVERFLOW');
  }

  return round;
}

function normalizeArguments(
  args: readonly string[],
): readonly string[] {
  if (args[0] === '--') {
    return args.slice(1);
  }

  return args;
}