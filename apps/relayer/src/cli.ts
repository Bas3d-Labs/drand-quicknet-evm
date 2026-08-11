import process from 'node:process';

import { 
  loadRelayerConfig, 
  type RelayerNetwork 
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

const MAX_UINT64 = (1n << 64n) - 1n;

interface ImportCommandArguments {
  command: 'import';
  network: RelayerNetwork;
  round: bigint;
}

interface ImportWhenAvailableCommandArguments {
  command: 'import-when-available';
  network: RelayerNetwork;
  round: bigint;
}

interface DaemonCommandArguments {
  command: 'daemon';
  network: RelayerNetwork;
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
      await runDaemonCli(command.network);
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
    network: command.network,
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
    network: command.network,
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
  network: RelayerNetwork,
): Promise<void> {
  const controller = new AbortController();
  const handleShutdown = (): void => {
    controller.abort();
  };

  process.once(
    'SIGINT',
    handleShutdown
  );

  process.once(
    'SIGTERM',
    handleShutdown
  );

  try {
    await runDaemonCommand({
      network,
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
    network: parsed.network,
    round: parsed.round,
  };
}

function parseImportWhenAvailableArguments(
  args: readonly string[],
): ImportWhenAvailableCommandArguments {
  const parsed = parseRoundCommandOptions(args, 'import-when-available');

  return {
    command: 'import-when-available',
    network: parsed.network,
    round: parsed.round,
  };
}

function parseDaemonArguments(
  args: readonly string[],
):
  | DaemonCommandArguments
  | DaemonHelpCommandArguments {
  let network: RelayerNetwork | undefined;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new Error('Expected daemon argument.');
    }

    if (argument === '--help' || argument === '-h') {
      return { command: 'daemon-help' };
    }

    if (argument === '--network') {
      if (network !== undefined) {
        throw new Error('Duplicate argument: --network.');
      }

      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('Missing value for --network.');
      }

      network = parseNetwork(value);

      i += 1;
      continue;
    }

    throw new Error(`Unknown daemon argument: ${argument}.`);
  }

  if (network === undefined) {
    throw new Error('Missing required argument: --network.');
  }

  return {
    command: 'daemon',
    network,
  };
}

interface RoundCommandOptions {
  network: RelayerNetwork;
  round: bigint;
}

function parseRoundCommandOptions(
  args: readonly string[],
  command: string,
): RoundCommandOptions {
  let network: RelayerNetwork | undefined;
  let round: bigint | undefined;
  
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === undefined) {
      throw new Error(`Expected ${command} argument.`);
    }

    if (argument === '--network') {
      if (network !== undefined) {
        throw new Error('Duplicate argument: --network.');
      }

      const value = args[i + 1];
      if (value === undefined) {
        throw new Error('Missing value for --network.');
      }

      network = parseNetwork(value);

      i += 1;
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

  if (network === undefined) {
    throw new Error('Missing required argument: --network.');
  }

  if (round === undefined) {
    throw new Error('Missing required argument: --round.');
  }

  return {
    network,
    round,
  };
}

function parseNetwork(value: string): RelayerNetwork {
  if (value === 'robinhood-testnet') {
    return value;
  }

  throw new Error(`Unsupported network: ${value}.`);
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

function isDecimalInteger(
  value: string,
): boolean {
  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }

  return true;
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
      'Run relayer daemon --help for daemon-specific usage.',
    ].join('\n')
  );
}

function printDaemonHelp(): void {
  console.log(
    [
      'Usage:',
      '  relayer daemon --network <network>',
      '',
      'Options:',
      '  --network <network>  Network to service.',
      '',
      'Required environment variables:',
      '  QUICKNET_CONSUMERS',
      '  QUICKNET_START_BLOCK',
      '  QUICKNET_CHECKPOINT_FILE',
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