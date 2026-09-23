
import process from 'node:process';

import {
  createRelayerClients,
} from '../chain/clients.js';

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

import {
  isDecimalInteger,
} from '../shared/decimal.js';

import {
  importQuicknetRound,
} from '../rounds/import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from '../rounds/import-round-when-available.js';

import {
  UsageError,
} from '../diagnostics/usage-error.js';

const MAX_UINT64 = (1n << 64n) - 1n;

type CliOutputHandler = (output: CliOutput) => void;

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

type CommandArguments =
  | ImportCommandArguments
  | ImportWhenAvailableCommandArguments
  | DaemonCommandArguments
  | DaemonHelpCommandArguments
  | HelpCommandArguments;

export async function main(
  args: readonly string[],
  output: CliOutputHandler,
): Promise<void> {
  const normalizedArgs = normalizeArguments(args);
  const command = parseCommandArguments(normalizedArgs);

  switch (command.command) {
    case 'import':
      await runImportCommand(command, output);
      return;

    case 'import-when-available':
      await runImportWhenAvailableCommand(command, output);
      return;
    
    case 'daemon':
      await runDaemonCli(command.source, output);
      return;    
      
    case 'daemon-help':
      output({ type: 'daemon-help' });
      return;

    case 'help':
      output({ type: 'help' });
      return;
  }
}

async function runImportCommand(
  command: ImportCommandArguments,
  output: CliOutputHandler,
): Promise<void> {
  const config = await loadRelayerConfig({
    source: command.source,
  });

  const clients = createRelayerClients(config);

  const result = await importQuicknetRound({
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    account: config.account,
    deployment: config.deployment,
    round: command.round,
  });

  output({
    type: 'import-result',
    round: command.round,
    result,
  });
}

async function runImportWhenAvailableCommand(
  command: ImportWhenAvailableCommandArguments,
  output: CliOutputHandler,
): Promise<void> {
  const config = await loadRelayerConfig({
    source: command.source,
  });

  const clients = createRelayerClients(config);

  const result = await importQuicknetRoundWhenAvailable({
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    account: config.account,
    deployment: config.deployment,
    round: command.round,
  });

  output({
    type: 'import-result',
    round: command.round,
    result,
  });
}

async function runDaemonCli(
  source: NetworkSource,
  output: CliOutputHandler,
): Promise<void> {
  const controller = new AbortController();

  const handleShutdown = (): void => {
    controller.abort();
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    await runDaemonCommand({
      source,
      signal: controller.signal,
      onStartup(summary) {
        output({
          type: 'daemon-startup',
          summary,
        });
      },
    });
  } finally {
    process.removeListener('SIGINT', handleShutdown);
    process.removeListener('SIGTERM', handleShutdown);
  }
}

export function parseCommandArguments(
  args: readonly string[],
): CommandArguments {
  const command = args[0];
  if (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
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