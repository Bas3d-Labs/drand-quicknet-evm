import process from 'node:process';

import {
  loadRelayerConfig,
  parseRelayerNetworkPreset,
  type NetworkSource,
} from './config.js';

import { createRelayerClients } from './clients.js';

import {
  runDaemonCommand,
} from './daemon-command.js';

import { 
  importQuicknetRound,
  type ImportQuicknetRoundResult,
} from './import-round.js';

import {
  importQuicknetRoundWhenAvailable,
} from './import-round-when-available.js';
import { isDecimalInteger } from './decimal.js';

const MAX_UINT64 = (1n << 64n) - 1n;

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
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const normalizedArgs = normalizeArguments(args);
  const command = parseCommandArguments(normalizedArgs);

  switch (command.command) {
    case 'import':
      await runImportCommand(command);
      return;

    case 'import-when-available':
      await runImportWhenAvailableCommand(command);
      return;
    
    case 'daemon':
      await runDaemonCli(command.source);
      return;    
      
    case 'daemon-help':
      printDaemonHelp();
      return;

    case 'help':
      printHelp();
      return;
  }
}

async function runImportCommand(
  command: ImportCommandArguments,
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

  printImportResult(command.round, result);
}

async function runImportWhenAvailableCommand(
  command: ImportWhenAvailableCommandArguments,
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

  printImportResult(command.round, result);
}

async function runDaemonCli(
  source: NetworkSource,
): Promise<void> {
  const controller = new AbortController();
  const handleShutdown = (): void => {
    controller.abort();
  };

  process.on(
    'SIGINT',
    handleShutdown
  );

  process.on(
    'SIGTERM',
    handleShutdown
  );

  try {
    await runDaemonCommand({
      source,
      signal: controller.signal,
    });
  } finally {
    process.removeListener(
      'SIGINT',
      handleShutdown
    );

    process.removeListener(
      'SIGTERM',
      handleShutdown
    );
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
      throw new Error(`Unknown command: ${command}.`);
  }
}

function parseImportArguments(
  args: readonly string[],
): ImportCommandArguments {
  const parsed = parseRoundCommandOptions(args, 'import');

  return {
    command: 'import',
    source: parsed.source,
    round: parsed.round,
  };
}

function parseImportWhenAvailableArguments(
  args: readonly string[],
): ImportWhenAvailableCommandArguments {
  const parsed = parseRoundCommandOptions(args, 'import-when-available');

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
      throw new Error('Expected daemon argument.');
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

    throw new Error(`Unknown daemon argument: ${argument}.`);
  }

  if (source === undefined) {
    throw new Error('Missing required argument: --network or --network-config.');
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
  command: string,
): RoundCommandOptions {
  let source: NetworkSource | undefined;
  let round: bigint | undefined;
  
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new Error(`Expected ${command} argument.`);
    }

    const networkArgument = parseNetworkSourceArgument(args, i, source);
    if (networkArgument !== undefined) {
      source = networkArgument.source;
      i = networkArgument.nextIndex;

      continue;
    }

    if (argument === '--round') {
      if (round !== undefined) {
        throw new Error('Duplicate argument: --round.');
      }

      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('Missing value for --round.');
      }

      round = parseRound(value);
      i += 1;

      continue;
    }

    throw new Error(`Unknown ${command} argument: ${argument}.`);
  }

  if (source === undefined) {
    throw new Error('Missing required argument: --network or --network-config.');
  }

  if (round === undefined) {
    throw new Error('Missing required argument: --round.');
  }

  return {
    source,
    round,
  };
}

interface ParsedNetworkSourceArgument {
  source: NetworkSource,
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
      throw new Error('Duplicate argument: --network.');
    }

    if (argument === '--network-config' && currentSource.type === 'custom') {
      throw new Error('Duplicate argument: --network-config.');
    }

    throw new Error('Arguments --network and --network-config are mutually exclusive.');
  }

  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${argument}.`);
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

function printImportResult(
  round: bigint,
  result: ImportQuicknetRoundResult,
): void {
  if (result.status === 'already-stored') {
    console.log(`Quicknet round ${round} is already stored.`);
    console.log(`Randomness: ${result.randomness}`);
    return;
  }

  console.log(`Imported Quicknet round ${round}.`);
  console.log(`Randomness: ${result.randomness}`);
  console.log(`Transaction: ${result.transactionHash}`);
}

function parseRound(
  value: string,
): bigint {
  if (
    value.length === 0 ||
    !isDecimalInteger(value)
  ) {
    throw new Error('Round must be a positive decimal integer.');
  }

  const round = BigInt(value);
  if (round <= 0n) {
    throw new Error('Round must be greater than zero.');
  }

  if (round > MAX_UINT64) {
    throw new Error('Round must fit in uint64.');
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

function formatError(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  relayer <command> [options]',
      '',
      'Commands:',
      '  import                 Import an exact Quicknet round immediately.',
      '  import-when-available  Wait for and import an exact Quicknet round.',
      '  daemon                 Watch configured consumers and relay requested rounds.',
      '',
      'Network selection:',
      '  --network <preset>       Use an official network preset.',
      '  --network-config <file>  Use a custom network configuration.',
      '',
      'Exactly one network selection option is required for import, import-when-available, and daemon.',
      '',
      'Run relayer daemon --help for daemon-specific usage.',
    ].join('\n')
  );
}

function printDaemonHelp(): void {
  console.log(
    [
      'Usage:',
      '  relayer daemon --network <preset>',
      '  relayer daemon --network-config <file>',
      '',
      'Network options:',
      '  --network <preset>       Use an official network preset.',
      '  --network-config <file>  Use a custom network configuration.',
      '',
      'Exactly one network option is required.',
      '',
      'Required daemon environment variables:',
      '  QUICKNET_CONSUMERS',
      '  QUICKNET_START_BLOCK',
      '  QUICKNET_CHECKPOINT_FILE',
      '',
      'Custom network environment:',
      '  QUICKNET_RPC_URL',
      '',
      'Optional environment variables:',
      '  QUICKNET_MAX_BLOCK_RANGE',
      '  QUICKNET_POLL_INTERVAL_MS',
    ].join('\n')
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`Error: ${formatError(error)}`);
    process.exitCode = 1;
  });
}